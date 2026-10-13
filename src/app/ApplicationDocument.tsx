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
import { navigationText } from "../i18n/messages";
import { dictionaryChoice, settingsExit } from "../settings/dictionaryChoice";
import { DictionaryChoiceScreen } from "../settings/DictionaryChoiceScreen";
import { SettingsHost } from "../settings/SettingsHost";
import { StatisticsHost } from "../statistics/StatisticsHost";
import { useSettingsDocument, type SettingsObservation } from "../settings/useSettingsDocument";
import type { SettingsPendingStore } from "../settings/settingsPending";
import { renderLearningPreviewExamples } from "../study/LearningPreviewExamples";
import type { SessionResumeState } from "../study/sessionResumeController";
import { useSessionResumeDocument } from "../study/useSessionResumeDocument";
import { TodayScreen, type OrdinaryQuiz } from "../today/TodayScreen";
import { useWrittenHost } from "../written/useWrittenHost";
import { EntryScreen } from "./EntryScreen";
import type { LaunchCard } from "./launchCard";
import { LearningHost } from "./LearningHost";
import { backDestination, initialRoute, navigationReducer, type Route, type Tab } from "./navigation";
import { useBackLayer } from "./navigationBack";
import { useScreenTransition } from "./navigationMotion";
import type { OpenedAccess } from "./openedAccess";
import type { LearningPageStarts } from "../learning/learningPageStarts";
import { useOralHost, type OralStores } from "./OralHost";
import { useConjugationHost, type ConjugationStores } from "./ConjugationHost";

type Props = {
  access: OpenedAccess; transport: HttpOptions; pendingStore: SettingsPendingStore; language: Language;
  storage: AsyncStorage; newId(): string; oralStores: OralStores; conjugationStores: ConjugationStores;
  foreground(): Promise<OpenedAccess | null>;
  onCurrent(current: SettingsObservation): void;
  /** The card a bot button asked for at launch (answer Q20); taken by the first document only. */
  launchCard?: LaunchCard;
  /** The Learning starts of this page (35.1-А); the JS document's own unless a test models another page. */
  learningPage?: LearningPageStarts;
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
  | { kind: "pending" | "failed" }
  | { kind: "learning" | "oral" | "written" | "conjugation"; id: string; version: string }
  | { kind: "closed"; id: string };
/** Only an active/summary projection proves the mode; OpenedAccess.session carries no mode. The resume read accepts
 * exactly these four modes (sessionProjection.ts), so every open session continues on its own route. */
function classify(state: SessionResumeState): ModeRead {
  if (state.kind === "loading" || state.kind === "idle") return { kind: "pending" };
  if (state.kind !== "ready" || !("mode" in state.data.current)) return { kind: "failed" };
  const current = state.data.current;
  if (current.status === "closed") return { kind: "closed", id: current.session_id.toLowerCase() };
  return { kind: current.mode, id: current.session_id, version: state.data.state_version };
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
  // The conjugation owner, like the oral one, is re-seeded only from a fresh mode read.
  const [conjugationSelected, setConjugationSelected] = useState<ModeSeed>(null);
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
  // Answer 17.1-А (R1): the sessions this document refreshed its access for after its own accepted start landed in
  // another pair. One refresh per session: a failed one ends as any foreground does, with its manual retry.
  const refreshedFor = useRef(new Set<string>());
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

  // The same refresh as a return to the window (client/open): the server names the pair and the session to go into.
  const refreshForStart = useCallback((sessionId: string) => {
    const id = sessionId.toLowerCase();
    if (!current.current.access.isLive() || refreshedFor.current.has(id)) return;
    refreshedFor.current.add(id);
    void current.current.foreground();
  }, []);

  const observe = useCallback((observation: SettingsObservation) => {
    const { access, onCurrent } = current.current;
    if (!access.isLive() || observation.accessKey !== access.key || observation.profileId !== access.profile.profile_id) return;
    if (latest.current && BigInt(observation.version) <= BigInt(latest.current.version)) return;
    latest.current = observation;
    setFloor(observation);
    onCurrent(observation);
  }, []);

  // Every mode owner gates on confirmed settings at least as new as its seed read (useWrittenHost and the other hosts),
  // so Settings are read at least that new too: a profile write between the Settings read and a later seed read must
  // re-read Settings, not leave the owner closed until a manual refresh.
  const settings = useSettingsDocument({ access: props.access, transport: props.transport, pendingStore: props.pendingStore,
    minimumStateVersion: highest(floor?.version, selected?.version, oralSelected?.version, writtenSelected?.version,
      conjugationSelected?.version), onCurrent: observe });
  const fits = covers(props.access, floor);
  // The first choice of the dictionary language (19.2-А, 29.1-А) stands in front of Today, wherever Today is reached
  // from: the first open, or the return after an earlier session. Only a Settings read decides it, never the profile.
  const choice = dictionaryChoice(settings.state, settings.confirmed);
  // Set once the choice screen was shown in this document. If the language turns out chosen without this screen's own
  // accepted save (VERSION_CONFLICT, another window), the screen stays to name the current pair until it is left.
  const [choiceShown, setChoiceShown] = useState(false);
  const outcome = settings.state.outcome;
  const ownChoice = outcome?.key === "dictionary_language" && outcome.status === "accepted";
  const settledChoice = choiceShown && choice === "chosen" && !ownChoice;
  useEffect(() => { if (choiceShown && choice === "chosen" && ownChoice) setChoiceShown(false); }, [choiceShown, choice, ownChoice]);
  const leaveChoice = () => { setChoiceShown(false); settings.actions.acceptCurrent("dictionary_language"); };
  useEffect(() => {
    if (at === "today" && !fits && floor && attemptedFloor.current !== floor.version) {
      attemptedFloor.current = floor.version;
      void synchronize();
    }
  }, [at, fits, floor, synchronize]);

  const session = props.access.session, pair = props.access.profile.dictionary_language;
  const seed = seedFor(selected, pair), oralSeed = seedFor(oralSelected, pair), writtenSeed = seedFor(writtenSelected, pair);
  const conjugationSeed = seedFor(conjugationSelected, pair);
  // A session reported after selection is read again only on Today, the oral or the conjugation route, and only when no
  // Host adopted it.
  const readAfter = selected !== null && session !== null && (at === "today" || at === "oral" || at === "conjugation")
    && !(seed !== null && !seedReleased.current && sameId(session.id, seed))
    && !(oralSeed !== null && sameId(session.id, oralSeed)) && !(writtenSeed !== null && sameId(session.id, writtenSeed))
    && !(conjugationSeed !== null && sameId(session.id, conjugationSeed))
    && !hostClaimed.current;
  const resume = useSessionResumeDocument({ access: props.access, transport: props.transport,
    minimumStateVersion: floor?.version, enabled: session !== null && (selected === null || readAfter) });
  const read = selected === null && session === null ? { kind: "pending" } as const : classify(resume.state);
  const readId = "id" in read ? read.id : null;
  // The launch card opens once, when the start settles (the mode read chose the start screen), over that screen (answer
  // S01): over Today, or over a resumed session, which Back then returns to at the same place. It is pushed in the same
  // update as the start route, so the session is never shown (nor its question committed as shown) before the card.
  // It is a message entry: it takes no rights of the quiz under it (cardOrigin) and is not a dictionary opening (S02).
  const launchCard = useRef(props.launchCard);
  // An empty start leaves the launch card in place until the dictionary language is chosen and the document shows its
  // pair (29.1-А): no card host mounts, reads or writes under a pair that is not chosen yet. A resumed session keeps
  // its own route and takes the card at once, as before.
  const [launchWaiting, setLaunchWaiting] = useState(false);
  const start = useCallback((screen: "learning" | "oral" | "written" | "conjugation" | null) => {
    if (screen !== null) navigate({ type: "open", screen });
    const cardId = launchCard.current?.take() ?? null;
    if (cardId !== null) navigate({ type: "push", screen: "card", subject: cardId, entry: "message" });
  }, []);
  useEffect(() => {
    // Leaving the seed's pair closes that session on the server: it is never a seed again, even after a return.
    for (const [selection, select] of [[selected, setSelected], [oralSelected, setOralSelected], [writtenSelected, setWrittenSelected],
      [conjugationSelected, setConjugationSelected]] as const) {
      if (selection !== null && selection.seed !== null && selection.pair !== pair) { select({ ...selection, seed: null }); return; }
    }
    // The refreshed access names the new pair and the session this document's start made there (17.1-А): select anew, as
    // a fresh document does. Until the mode read answers only the loading screen shows, never Today of either pair; the
    // read then opens that session on its own route, whatever mode it is. Only a session this document refreshed for:
    // a window that got the new pair otherwise keeps its owners and what is typed in them (QA-REOPEN-FIX F1).
    if (selected !== null && selected.pair !== pair && session !== null && refreshedFor.current.has(session.id.toLowerCase())) {
      setSelected(null); navigate({ type: "home" }); return;
    }
    if (selected === null && session === null) { setSelected({ seed: null, pair }); setLaunchWaiting(true); return; }
    if (selected === null && read.kind === "learning") {
      setSelected({ seed: read.id, pair, version: read.version }); start("learning"); return;
    }
    // An active session of this client continues on its own route (tz_app:48); Learning keeps no seed.
    if ((selected === null || readAfter) && read.kind === "oral") {
      setOralSelected({ seed: read.id, pair, version: read.version });
      if (selected === null) { setSelected({ seed: null, pair }); start("oral"); } else navigate({ type: "open", screen: "oral" });
      return;
    }
    // Its server projection chooses the step; no undo or correction of an earlier document comes with it (TA:48).
    if ((selected === null || readAfter) && read.kind === "written") {
      setWrittenSelected({ seed: read.id, pair, version: read.version });
      if (selected === null) { setSelected({ seed: null, pair }); start("written"); } else navigate({ type: "open", screen: "written" });
      return;
    }
    // The conjugation test continues from the server's step (TA:48); the launch card opens over it (answer S01).
    if ((selected === null || readAfter) && read.kind === "conjugation") {
      setConjugationSelected({ seed: read.id, pair, version: read.version });
      if (selected === null) { setSelected({ seed: null, pair }); start("conjugation"); } else navigate({ type: "open", screen: "conjugation" });
      return;
    }
    // A closed session is never resumed: one fresh open per closed id, then a manual retry.
    if ((selected === null || readAfter) && read.kind === "closed" && !synchronizedClosed.current.has(read.id)) {
      synchronizedClosed.current.add(read.id);
      void synchronize();
    }
  }, [selected, oralSelected, writtenSelected, conjugationSelected, session, pair, read.kind, readId, readAfter, synchronize, start]);
  const launchReady = launchWaiting && at === "today" && choice === "chosen" && !settledChoice && fits && gate === "ready";
  useEffect(() => { if (launchReady) { setLaunchWaiting(false); start(null); } }, [launchReady, start]);
  // The launch card host that has shown its content: closing it after that forgets the card in the address (answer S03).
  const shownLaunch = useRef<string | null>(null);

  const today = () => {
    attemptedFloor.current = latest.current?.version ?? null;
    navigate({ type: "home" });
    void synchronize();
  };
  // Native Back of a non-study screen (TA:86): a return to Today is its «Сегодня» (SettingsScreen onToday) with the
  // same refresh; a session supplies its own exit from its owner. A gate-hidden Host is not Settings.
  const destination = backDestination(route);
  // On the card route native Back is the card's own exit (it closes the card context first), called through one slot.
  // The card is checked first: a card opened over Today (the launch card) must close its context too.
  const back = at === "card" ? () => { if (cardBack.current) cardBack.current(); else navigate({ type: "back" }); }
    : destination === "today" ? today : () => navigate({ type: "back" });
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
    if (read.kind === "learning") return <EntryScreen state={{ kind: "opened" }} language={props.language} />;
    if (read.kind === "failed" || read.kind === "closed" && synchronizedClosed.current.has(read.id) && gate !== "loading") return failed;
    return loading;
  };

  // hostRoute "settings" means hidden, not navigation: the Host renders nothing and keeps its owner mounted.
  let hostRoute: "today" | "learning" | "settings" = at === "today" || at === "learning" ? at : "settings";
  let screen: ReactNode = null, todayShown = false, choosing = false;
  // The launch card over an undecided start hides its screen until Back.
  if (selected === null) screen = at === "card" ? null : readScreen();
  else if (at === "today") {
    if (!(fits && gate === "ready")) {
      hostRoute = "settings";
      screen = gate === "failed" ? failed : loading;
    } else if (readAfter && read.kind !== "pending") {
      hostRoute = "settings";
      screen = readScreen();
    } else if (choice !== "chosen" || settledChoice) {
      // An unadopted session still being read is never taken for its absence: the read decides its route first.
      hostRoute = "settings";
      choosing = !readAfter && (choice === "required" || settledChoice);
      screen = readAfter || choice === "loading" ? loading
        : choice === "failed" ? <TodayScreen state={{ kind: "failed", reason: "load" }} language={props.language}
          onRetry={() => { void settings.actions.refresh(); }}
          notice={settingsExit(settings.state) && <button type="button" className="today-retry"
            onClick={openSettings}>{navigationText(props.language).settings}</button>} />
        : <DictionaryChoiceScreen document={settings} language={props.language} settled={settledChoice} onLeave={leaveChoice} />;
    } else if (launchReady && launchCard.current?.has()) {
      // The card is pushed by the effect right after this render; Today is not shown under it first.
      hostRoute = "settings";
      screen = loading;
    } else todayShown = true;
  } else if (at === "statistics") {
    // Every entry mounts a fresh host and so reads the server; a foreground access is read again by the host (TA:362).
    screen = <StatisticsHost access={props.access} transport={props.transport} language={props.language}
      minimumStateVersion={floor?.version} onBack={back} />;
  }
  // One host per opened card: Back returns to the source with its return context (TA:86, К07-096).
  // The oral owner lives for the whole document; it shows a screen only on its own route.
  const oral = useOralHost({ access: props.access, transport: props.transport, stores: props.oralStores, newId: props.newId,
    language: props.language, settings, minimumStateVersion: highest(floor?.version, oralSelected?.version),
    initialSessionId: oralSeed, seedPending: at === "oral" && readAfter && (read.kind === "pending" || read.kind === "oral"),
    route: at === "oral" ? "oral" : todayShown ? "today" : "hidden",
    onOral: () => navigate({ type: "open", screen: "oral" }), onToday: today, onForeignStart: refreshForStart,
    // «Уточнить поля» in М18 (M-ORAL-ENTRY): the card opens on top of the oral quiz; Back returns to the same question.
    onOpenCard: (cardId, details) => navigate({ type: "push", screen: "card", subject: cardId, details }) });
  // The written owner also lives for the whole document; L1→De rows of Today start it (tz_app М09).
  const written = useWrittenHost({ access: props.access, transport: props.transport, storage: props.storage, newId: props.newId,
    language: props.language, settings, minimumStateVersion: highest(floor?.version, writtenSelected?.version),
    initialSessionId: writtenSeed, route: at === "written" ? "written" : todayShown ? "today" : "hidden",
    onWritten: () => navigate({ type: "open", screen: "written" }), onToday: today, onForeignStart: refreshForStart,
    // «Уточнить поля» (M-ACTIONS): the answered card opens on top of the quiz and returns to it.
    onOpenCard: (cardId, details) => navigate({ type: "push", screen: "card", subject: cardId, details }) });
  // The conjugation owner lives for the whole document too; the Today button «Тест спряжений» starts it (М16).
  const conjugation = useConjugationHost({ access: props.access, transport: props.transport, stores: props.conjugationStores,
    newId: props.newId, language: props.language, settings,
    minimumStateVersion: highest(floor?.version, conjugationSelected?.version), initialSessionId: conjugationSeed,
    seedPending: at === "conjugation" && readAfter && (read.kind === "pending" || read.kind === "conjugation"),
    route: at === "conjugation" ? "conjugation" : todayShown ? "today" : "hidden",
    onConjugation: () => navigate({ type: "open", screen: "conjugation" }), onToday: today, onForeignStart: refreshForStart });
  useEffect(() => { if (choosing) setChoiceShown(true); }, [choosing]);
  if (todayShown && (oral.blocksToday || written.blocksToday || conjugation.blocksToday)) { hostRoute = "settings"; screen = loading; }
  // One host per opened card route (TA:86, К07-096): a fresh key per route object, so reopening a card while its
  // previous host still awaits a close starts a new host. The slot keeps one position, so leaving keeps the same host.
  let activeCard: CardSlot | null = null;
  if (at === "card" && route.subject !== null) {
    let key = cardKeys.current.get(route);
    if (key === undefined) { key = `${route.subject}:${++cardSerial.current}`; cardKeys.current.set(route, key); }
    activeCard = { key, cardId: route.subject, origin: cardOrigin(route.back?.source ?? null, route.entry) };
  }
  const cardSlot = activeCard ?? leavingCard;
  // L1→De rows start the written quiz, De→L1 rows the oral one (tz_app М09/М18; CP14 B-ENTRY lifted by M-ORAL-ENTRY).
  const quizzes = {
    onStartQuiz: (quiz: OrdinaryQuiz) => { if (quiz.direction === "l1-de") written.requestStart(quiz.material); else oral.requestStart(quiz); },
    canStartQuiz: (quiz: OrdinaryQuiz) => quiz.direction === "l1-de" ? written.canRequestStart : oral.canRequestStart,
    // Without the start right the button stays visible and disabled (TodayScreen gates it by the handler).
    onStartConjugation: conjugation.canRequestStart ? conjugation.requestStart : undefined,
  };
  return <div className="nav-screen" ref={frame}>
    {selected !== null && <LearningHost access={props.access} transport={props.transport} storage={props.storage}
      newId={props.newId} language={props.language} settings={settings}
      minimumStateVersion={highest(floor?.version, selected.version)} initialSessionId={seed}
      route={hostRoute} submitOnEnter renderPreview={renderPreview} quizzes={quizzes} page={props.learningPage}
      onLearning={() => { hostClaimed.current = true; navigate({ type: "open", screen: "learning" }); }}
      onToday={() => { hostClaimed.current = false; seedReleased.current = true; today(); }}
      onSettings={openSettings} onForeignStart={refreshForStart}
      onNavigate={destination => destination === "statistics" ? navigate({ type: "push", screen: "statistics" }) : openTab(destination)} />}
    {screen}
    {oral.screen}
    {written.screen}
    {conjugation.screen}
    {cardSlot && <CardHost key={cardSlot.key} access={props.access} transport={props.transport} language={props.language}
      pendingStore={manualPending} cardId={cardSlot.cardId} origin={cardSlot.origin} newId={props.newId}
      leaving={cardSlot !== activeCard} backSlot={cardBack}
      // Only a card opened from the written quiz moves it on (M-ACTIONS Р4); dictionary and oral cards report nothing.
      onStudyAction={movesWrittenQuiz(cardSlot.origin) ? written.cardActionApplied : undefined}
      onShown={cardSlot.origin.kind === "dictionary" && cardSlot.origin.via === "message"
        ? () => { shownLaunch.current = cardSlot.key; } : undefined}
      onRefused={cardSlot.origin.kind === "dictionary" && cardSlot.origin.via === "message" ? () => props.launchCard?.refused() : undefined}
      onBack={close => {
        if (shownLaunch.current === cardSlot.key) props.launchCard?.viewed();
        if (close === "after_open" && activeCard) setLeavingCard(activeCard);
        navigate({ type: "back" });
      }}
      onClosed={() => setLeavingCard(current => current?.key === cardSlot.key ? null : current)} />}
    {dictionaryOpened && <DictionaryHost access={props.access} transport={props.transport} language={props.language} visit={visit}
      onOpenCard={(cardId, back) => navigate({ type: "push", screen: "card", subject: cardId, details: back })}
      onNavigate={openTab} />}
    {/* 29.1-А: before a Settings read proves the dictionary language chosen, Settings (R2-01) are the only section, by whichever
        path they were opened (the failed frame of the choice, or an older session): the Dictionary stays unavailable. */}
    {settingsOpened && <div hidden={at !== "settings"}>
      <SettingsHost access={props.access} transport={props.transport} document={settings}
        language={props.language} active={at === "settings"} onToday={today}
        onDictionary={choice === "chosen" ? () => openTab("dictionary") : undefined} />
    </div>}
  </div>;
}
