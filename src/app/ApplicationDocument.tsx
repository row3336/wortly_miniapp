import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type { LearningPreviewAddress } from "../api/generated";
import type { HttpOptions } from "../api/http";
import { sameId } from "../api/wireValidation";
import { CardHost } from "../dictionary/card/CardHost";
import { cardOrigin, movesWrittenQuiz, type CardOrigin } from "../dictionary/card/cardOrigin";
import { DictionaryHost, type DictionaryVisit } from "../dictionary/DictionaryHost";
import type { Language } from "../i18n/language";
import { LearningPreviewCard } from "../learning/LearningPreviewCard";
import { ManualPendingStore } from "../learning/manualPending";
import type { AsyncStorage } from "../platform/storage";
import { SettingsHost } from "../settings/SettingsHost";
import { useSettingsDocument, type SettingsObservation } from "../settings/useSettingsDocument";
import type { SettingsPendingStore } from "../settings/settingsPending";
import { renderLearningPreviewExamples } from "../study/LearningPreviewExamples";
import type { SessionResumeState } from "../study/sessionResumeController";
import { useSessionResumeDocument } from "../study/useSessionResumeDocument";
import { TodayScreen, type OrdinaryQuiz } from "../today/TodayScreen";
import { useWrittenHost } from "../written/useWrittenHost";
import { EntryScreen } from "./EntryScreen";
import { LearningHost } from "./LearningHost";
import { backDestination, initialRoute, navigationReducer, type Route, type Tab } from "./navigation";
import { useBackLayer } from "./navigationBack";
import { useScreenTransition } from "./navigationMotion";
import { StatisticsPlaceholder } from "./navigationStubs";
import type { OpenedAccess } from "./openedAccess";
import { useOralHost, type OralStores } from "./OralHost";

type Props = {
  access: OpenedAccess; transport: HttpOptions; pendingStore: SettingsPendingStore; language: Language;
  storage: AsyncStorage; newId(): string; oralStores: OralStores;
  foreground(): Promise<OpenedAccess | null>;
  onCurrent(current: SettingsObservation): void;
};
function covers(opened: OpenedAccess, floor: SettingsObservation | null): boolean {
  if (!floor) return true;
  const profile = opened.profile;
  return BigInt(profile.state_version) > BigInt(floor.version)
    || (profile.state_version === floor.version && profile.ui_language === floor.uiLanguage
      && profile.dictionary_language === floor.dictionaryLanguage);
}
function highest(...versions: (string | undefined)[]): string | undefined {
  return versions.reduce<string | undefined>((top, value) =>
    value !== undefined && (top === undefined || BigInt(value) > BigInt(top)) ? value : top, undefined);
}

/** The card host shown on the card route, or the one still finishing its close after Back. */
type CardSlot = { key: string; cardId: string; origin: CardOrigin };

/** A mode owner's resume seed: it belongs to the dictionary pair it was read for. */
type ModeSeed = { seed: string | null; pair: string; version?: string } | null;
/** The owner of a new pair never starts from the old pair's session; the current owner keeps its own seed. */
const seedFor = (selection: ModeSeed, pair: string) => selection !== null && selection.pair === pair ? selection.seed : null;

type ModeRead =
  | { kind: "pending" | "failed" | "other" }
  | { kind: "learning" | "oral" | "written"; id: string; version: string }
  | { kind: "closed"; id: string };
/** Only an active/summary Learning, oral or written projection proves the mode; OpenedAccess.session carries no mode. */
function classify(state: SessionResumeState): ModeRead {
  if (state.kind === "loading" || state.kind === "idle") return { kind: "pending" };
  if (state.kind !== "ready" || !("mode" in state.data.current)) return { kind: "failed" };
  const current = state.data.current;
  if (current.status === "closed") return { kind: "closed", id: current.session_id.toLowerCase() };
  return current.mode === "learning" || current.mode === "oral" || current.mode === "written"
    ? { kind: current.mode, id: current.session_id, version: state.data.state_version } : { kind: "other" };
}

/** Keyed by the opened document, never by the identity of a foreground access handle. */
export function ApplicationDocument(props: Props) {
  // The route keeps the screen and its return context only; study progress stays with its owner (TA §1).
  const [route, navigate] = useReducer(navigationReducer, initialRoute);
  const at = route.screen;
  const frame = useRef<HTMLDivElement>(null);
  useScreenTransition(frame, route);
  const [settingsOpened, setSettingsOpened] = useState(false);
  // The one durable slot of the manual Learning choice in this document (М12 «Добавить в обучение»).
  const [manualPending] = useState(() => new ManualPendingStore(props.storage));
  // A card left by Back before its context.open was confirmed stays mounted, hidden, until that close follows (M-CARD В6).
  const [leavingCard, setLeavingCard] = useState<CardSlot | null>(null);
  const cardKeys = useRef(new WeakMap<Route, string>()), cardSerial = useRef(0);
  const cardBack = useRef<(() => void) | null>(null);
  // The dictionary owner stays mounted once opened, so a return from a card finds its search unchanged (К07-096).
  const [dictionaryOpened, setDictionaryOpened] = useState(false);
  // One visit per route object: Back from a nested screen of the dictionary is a return, any other route there is an entry.
  const visit = useMemo<DictionaryVisit | null>(() => route.screen !== "dictionary" ? null
    : route.restored?.source === "dictionary" ? { kind: "return", scroll: route.restored.scroll ?? null } : { kind: "entry" }, [route]);
  const [floor, setFloor] = useState<SettingsObservation | null>(null);
  const [gate, setGate] = useState<"ready" | "loading" | "failed">("ready");
  // The Learning owner is chosen once per document; later mode reads never reseed or remount it.
  // A resumed seed belongs to the dictionary pair it was read for.
  const [selected, setSelected] = useState<ModeSeed>(null);
  // The oral owner is re-seeded only from a fresh mode read: its hook takes an active seed from props alone.
  const [oralSelected, setOralSelected] = useState<ModeSeed>(null);
  // The written owner is re-seeded only from a fresh mode read, never on its own route: there a reseed would replace
  // the owner and the result view that waits for «Далее» after background (К05-152).
  const [writtenSelected, setWrittenSelected] = useState<ModeSeed>(null);
  const current = useRef(props);
  current.current = props;
  const latest = useRef(floor);
  const lifetime = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const attemptedFloor = useRef<string | null>(null);
  // Set only when the Host itself routes to its own Start or recovered session; cleared on its Today,
  // which also releases the initial seed after its confirmed closure.
  const hostClaimed = useRef(false);
  const seedReleased = useRef(false);
  const synchronizedClosed = useRef(new Set<string>());
  useEffect(() => { lifetime.current++; return () => { lifetime.current++; running.current = null; }; }, []);

  const synchronize = useCallback(() => {
    if (running.current) return running.current;
    const generation = lifetime.current, key = current.current.access.key;
    const live = () => generation === lifetime.current && current.current.access.key === key;
    setGate("loading");
    const task = (async () => {
      // The first open may join a request started before a setting was committed.
      for (let attempt = 0; attempt < 2; attempt++) {
        const opened = await current.current.foreground();
        if (!live()) return;
        if (!opened?.isLive() || opened.key !== key) break;
        if (covers(opened, latest.current)) { setGate("ready"); return; }
      }
      if (live()) setGate("failed");
    })().catch(() => { if (live()) setGate("failed"); }).finally(() => {
      if (running.current === task) running.current = null;
    });
    running.current = task;
    return task;
  }, []);

  const observe = useCallback((observation: SettingsObservation) => {
    const { access, onCurrent } = current.current;
    if (!access.isLive() || observation.accessKey !== access.key || observation.profileId !== access.profile.profile_id) return;
    if (latest.current && BigInt(observation.version) <= BigInt(latest.current.version)) return;
    latest.current = observation;
    setFloor(observation);
    onCurrent(observation);
  }, []);

  const settings = useSettingsDocument({ access: props.access, transport: props.transport, pendingStore: props.pendingStore,
    minimumStateVersion: floor?.version, onCurrent: observe });
  const fits = covers(props.access, floor);
  useEffect(() => {
    if (at === "today" && !fits && floor && attemptedFloor.current !== floor.version) {
      attemptedFloor.current = floor.version;
      void synchronize();
    }
  }, [at, fits, floor, synchronize]);

  const session = props.access.session, pair = props.access.profile.dictionary_language;
  const seed = seedFor(selected, pair), oralSeed = seedFor(oralSelected, pair), writtenSeed = seedFor(writtenSelected, pair);
  // A session reported after selection is read again only on Today or the oral route, and only when no Host adopted it.
  const readAfter = selected !== null && session !== null && (at === "today" || at === "oral")
    && !(seed !== null && !seedReleased.current && sameId(session.id, seed))
    && !(oralSeed !== null && sameId(session.id, oralSeed)) && !(writtenSeed !== null && sameId(session.id, writtenSeed))
    && !hostClaimed.current;
  const resume = useSessionResumeDocument({ access: props.access, transport: props.transport,
    minimumStateVersion: floor?.version, enabled: session !== null && (selected === null || readAfter) });
  const read = selected === null && session === null ? { kind: "pending" } as const : classify(resume.state);
  const readId = read.kind === "learning" || read.kind === "oral" || read.kind === "written" || read.kind === "closed" ? read.id : null;
  useEffect(() => {
    // Leaving the seed's pair closes that session on the server: it is never a seed again, even after a return.
    for (const [selection, select] of [[selected, setSelected], [oralSelected, setOralSelected], [writtenSelected, setWrittenSelected]] as const) {
      if (selection !== null && selection.seed !== null && selection.pair !== pair) { select({ ...selection, seed: null }); return; }
    }
    if (selected === null && session === null) { setSelected({ seed: null, pair }); return; }
    if (selected === null && read.kind === "learning") {
      setSelected({ seed: read.id, pair, version: read.version }); navigate({ type: "open", screen: "learning" }); return;
    }
    // An active session of this client continues on its own route (tz_app:48); Learning keeps no seed.
    if ((selected === null || readAfter) && read.kind === "oral") {
      if (selected === null) setSelected({ seed: null, pair });
      setOralSelected({ seed: read.id, pair, version: read.version }); navigate({ type: "open", screen: "oral" }); return;
    }
    // Its server projection chooses the step; no undo or correction of an earlier document comes with it (TA:48).
    if ((selected === null || readAfter) && read.kind === "written") {
      if (selected === null) setSelected({ seed: null, pair });
      setWrittenSelected({ seed: read.id, pair, version: read.version }); navigate({ type: "open", screen: "written" }); return;
    }
    // A closed session is never resumed: one fresh open per closed id, then a manual retry.
    if ((selected === null || readAfter) && read.kind === "closed" && !synchronizedClosed.current.has(read.id)) {
      synchronizedClosed.current.add(read.id);
      void synchronize();
    }
  }, [selected, oralSelected, writtenSelected, session, pair, read.kind, readId, readAfter, synchronize]);

  const today = () => {
    attemptedFloor.current = latest.current?.version ?? null;
    navigate({ type: "home" });
    void synchronize();
  };
  // Native Back of a non-study screen (TA:86): a return to Today is its «Сегодня» (SettingsScreen onToday) with the
  // same refresh; a session supplies its own exit from its owner. A gate-hidden Host is not Settings.
  const destination = backDestination(route);
  // On the card route native Back is the card's own exit (it closes the card context first), called through one slot.
  const back = destination === "today" ? today : at === "card"
    ? () => { if (cardBack.current) cardBack.current(); else navigate({ type: "back" }); } : () => navigate({ type: "back" });
  useBackLayer("screen", destination === null ? null : back);
  const openSettings = () => { setSettingsOpened(true); navigate({ type: "open", screen: "settings" }); };
  // The panel only navigates: each section owns its screen (M-DICT, M-SET); Today keeps its refresh on return.
  const openDictionary = () => { setDictionaryOpened(true); navigate({ type: "open", screen: "dictionary" }); };
  const openTab = (tab: Tab) => tab === "today" ? today() : tab === "settings" ? openSettings() : openDictionary();
  const renderPreview = useCallback((preview: LearningPreviewAddress) => <LearningPreviewCard content={preview.content}
    language={props.language} renderExamples={renderLearningPreviewExamples} />, [props.language]);
  const retry = () => { void synchronize(); };
  const loading = <TodayScreen state={{ kind: "loading" }} language={props.language} onRetry={retry} />;
  const failed = <TodayScreen state={{ kind: "failed", reason: "load" }} language={props.language} onRetry={retry} />;
  // No mode, no closure and no permission to Start is inferred from an unresolved read.
  const readScreen = (): ReactNode => {
    if (read.kind === "other" || read.kind === "learning") return <EntryScreen state={{ kind: "opened" }} language={props.language} />;
    if (read.kind === "failed" || read.kind === "closed" && synchronizedClosed.current.has(read.id) && gate !== "loading") return failed;
    return loading;
  };

  // hostRoute "settings" means hidden, not navigation: the Host renders nothing and keeps its owner mounted.
  let hostRoute: "today" | "learning" | "settings" = at === "today" || at === "learning" ? at : "settings";
  let screen: ReactNode = null, todayShown = false;
  if (selected === null) screen = readScreen();
  else if (at === "today") {
    if (!(fits && gate === "ready")) {
      hostRoute = "settings";
      screen = gate === "failed" ? failed : loading;
    } else if (readAfter && read.kind !== "pending") {
      hostRoute = "settings";
      screen = readScreen();
    } else todayShown = true;
  } else if (at === "statistics") screen = <StatisticsPlaceholder language={props.language} onBack={back} />;
  // One host per opened card: Back returns to the source with its return context (TA:86, К07-096).
  // The oral owner lives for the whole document; it shows a screen only on its own route.
  const oral = useOralHost({ access: props.access, transport: props.transport, stores: props.oralStores, newId: props.newId,
    language: props.language, settings, minimumStateVersion: highest(floor?.version, oralSelected?.version),
    initialSessionId: oralSeed, seedPending: at === "oral" && readAfter && (read.kind === "pending" || read.kind === "oral"),
    route: at === "oral" ? "oral" : todayShown ? "today" : "hidden",
    onOral: () => navigate({ type: "open", screen: "oral" }), onToday: today });
  // The written owner also lives for the whole document; L1→De rows of Today start it (tz_app М09).
  const written = useWrittenHost({ access: props.access, transport: props.transport, storage: props.storage, newId: props.newId,
    language: props.language, settings, minimumStateVersion: highest(floor?.version, writtenSelected?.version),
    initialSessionId: writtenSeed, route: at === "written" ? "written" : todayShown ? "today" : "hidden",
    onWritten: () => navigate({ type: "open", screen: "written" }), onToday: today,
    // «Уточнить поля» (M-ACTIONS): the answered card opens on top of the quiz and returns to it.
    onOpenCard: (cardId, details) => navigate({ type: "push", screen: "card", subject: cardId, details }) });
  if (todayShown && (oral.blocksToday || written.blocksToday)) { hostRoute = "settings"; screen = loading; }
  // One host per opened card route (TA:86, К07-096): a fresh key per route object, so reopening a card while its
  // previous host still awaits a close starts a new host. The slot keeps one position, so leaving keeps the same host.
  let activeCard: CardSlot | null = null;
  if (at === "card" && route.subject !== null) {
    let key = cardKeys.current.get(route);
    if (key === undefined) { key = `${route.subject}:${++cardSerial.current}`; cardKeys.current.set(route, key); }
    activeCard = { key, cardId: route.subject, origin: cardOrigin(route.back?.source ?? null) };
  }
  const cardSlot = activeCard ?? leavingCard;
  const quizzes = {
    onStartQuiz: (quiz: OrdinaryQuiz) => { if (quiz.direction === "l1-de") written.requestStart(quiz.material); },
    canStartQuiz: (quiz: OrdinaryQuiz) => quiz.direction === "l1-de" && written.canRequestStart,
  };
  return <div className="nav-screen" ref={frame}>
    {selected !== null && <LearningHost access={props.access} transport={props.transport} storage={props.storage}
      newId={props.newId} language={props.language} settings={settings}
      minimumStateVersion={highest(floor?.version, selected.version)} initialSessionId={seed}
      route={hostRoute} submitOnEnter renderPreview={renderPreview} quizzes={quizzes}
      onLearning={() => { hostClaimed.current = true; navigate({ type: "open", screen: "learning" }); }}
      onToday={() => { hostClaimed.current = false; seedReleased.current = true; today(); }}
      onSettings={openSettings}
      onNavigate={destination => destination === "statistics" ? navigate({ type: "push", screen: "statistics" }) : openTab(destination)} />}
    {screen}
    {oral.screen}
    {written.screen}
    {cardSlot && <CardHost key={cardSlot.key} access={props.access} transport={props.transport} language={props.language}
      pendingStore={manualPending} cardId={cardSlot.cardId} origin={cardSlot.origin} newId={props.newId}
      leaving={cardSlot !== activeCard} backSlot={cardBack}
      // Only a card opened from the written quiz moves it on (M-ACTIONS Р4); dictionary and oral cards report nothing.
      onStudyAction={movesWrittenQuiz(cardSlot.origin) ? written.cardActionApplied : undefined}
      onBack={close => { if (close === "after_open" && activeCard) setLeavingCard(activeCard); navigate({ type: "back" }); }}
      onClosed={() => setLeavingCard(current => current?.key === cardSlot.key ? null : current)} />}
    {dictionaryOpened && <DictionaryHost access={props.access} transport={props.transport} language={props.language} visit={visit}
      onOpenCard={(cardId, back) => navigate({ type: "push", screen: "card", subject: cardId, details: back })}
      onNavigate={openTab} />}
    {settingsOpened && <div hidden={at !== "settings"}>
      <SettingsHost access={props.access} transport={props.transport} document={settings}
        language={props.language} active={at === "settings"} onToday={today}
        onDictionary={() => openTab("dictionary")} />
    </div>}
  </div>;
}
