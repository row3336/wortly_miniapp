import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { LearningPreviewAddress } from "../api/generated";
import type { HttpOptions } from "../api/http";
import { sameId } from "../api/wireValidation";
import type { Language } from "../i18n/language";
import { LearningPreviewCard } from "../learning/LearningPreviewCard";
import type { AsyncStorage } from "../platform/storage";
import { bindBackButton } from "../platform/telegram";
import { SettingsHost } from "../settings/SettingsHost";
import { useSettingsDocument, type SettingsObservation } from "../settings/useSettingsDocument";
import type { SettingsPendingStore } from "../settings/settingsPending";
import { renderLearningPreviewExamples } from "../study/LearningPreviewExamples";
import type { SessionResumeState } from "../study/sessionResumeController";
import { useSessionResumeDocument } from "../study/useSessionResumeDocument";
import { TodayScreen } from "../today/TodayScreen";
import { EntryScreen } from "./EntryScreen";
import { LearningHost } from "./LearningHost";
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

type ModeRead =
  | { kind: "pending" | "failed" | "other" }
  | { kind: "learning" | "oral"; id: string; version: string }
  | { kind: "closed"; id: string };
/** Only an active/summary Learning or oral projection proves the mode; OpenedAccess.session carries no mode. */
function classify(state: SessionResumeState): ModeRead {
  if (state.kind === "loading" || state.kind === "idle") return { kind: "pending" };
  if (state.kind !== "ready" || !("mode" in state.data.current)) return { kind: "failed" };
  const current = state.data.current;
  if (current.status === "closed") return { kind: "closed", id: current.session_id.toLowerCase() };
  return current.mode === "learning" || current.mode === "oral"
    ? { kind: current.mode, id: current.session_id, version: state.data.state_version } : { kind: "other" };
}

/** Keyed by the opened document, never by the identity of a foreground access handle. */
export function ApplicationDocument(props: Props) {
  const [route, setRoute] = useState<"today" | "settings" | "learning" | "oral">("today");
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [floor, setFloor] = useState<SettingsObservation | null>(null);
  const [gate, setGate] = useState<"ready" | "loading" | "failed">("ready");
  // The Learning owner is chosen once per document; later mode reads never reseed or remount it.
  // A resumed seed belongs to the dictionary pair it was read for.
  const [selected, setSelected] = useState<{ seed: string | null; pair: string; version?: string } | null>(null);
  // The oral owner is re-seeded only from a fresh mode read: its hook takes an active seed from props alone.
  const [oralSelected, setOralSelected] = useState<{ seed: string | null; pair: string; version?: string } | null>(null);
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
    if (route === "today" && !fits && floor && attemptedFloor.current !== floor.version) {
      attemptedFloor.current = floor.version;
      void synchronize();
    }
  }, [route, fits, floor, synchronize]);

  const session = props.access.session, pair = props.access.profile.dictionary_language;
  // The owner of a new pair never starts from the old pair's session; the current owner keeps its own seed.
  const seed = selected !== null && selected.pair === pair ? selected.seed : null;
  const oralSeed = oralSelected !== null && oralSelected.pair === pair ? oralSelected.seed : null;
  // A session reported after selection is read again only on Today or the oral route, and only when no Host adopted it.
  const readAfter = selected !== null && session !== null && (route === "today" || route === "oral")
    && !(seed !== null && !seedReleased.current && sameId(session.id, seed))
    && !(oralSeed !== null && sameId(session.id, oralSeed)) && !hostClaimed.current;
  const resume = useSessionResumeDocument({ access: props.access, transport: props.transport,
    minimumStateVersion: floor?.version, enabled: session !== null && (selected === null || readAfter) });
  const read = selected === null && session === null ? { kind: "pending" } as const : classify(resume.state);
  const readId = read.kind === "learning" || read.kind === "oral" || read.kind === "closed" ? read.id : null;
  useEffect(() => {
    // Leaving the seed's pair closes that session on the server: it is never a seed again, even after a return.
    if (selected !== null && selected.seed !== null && selected.pair !== pair) { setSelected({ ...selected, seed: null }); return; }
    if (oralSelected !== null && oralSelected.seed !== null && oralSelected.pair !== pair) {
      setOralSelected({ ...oralSelected, seed: null }); return;
    }
    if (selected === null && session === null) { setSelected({ seed: null, pair }); return; }
    if (selected === null && read.kind === "learning") {
      setSelected({ seed: read.id, pair, version: read.version }); setRoute("learning"); return;
    }
    // An active session of this client continues on its own route (tz_app:48); Learning keeps no seed.
    if ((selected === null || readAfter) && read.kind === "oral") {
      if (selected === null) setSelected({ seed: null, pair });
      setOralSelected({ seed: read.id, pair, version: read.version }); setRoute("oral"); return;
    }
    // A closed session is never resumed: one fresh open per closed id, then a manual retry.
    if ((selected === null || readAfter) && read.kind === "closed" && !synchronizedClosed.current.has(read.id)) {
      synchronizedClosed.current.add(read.id);
      void synchronize();
    }
  }, [selected, oralSelected, session, pair, read.kind, readId, readAfter, synchronize]);

  const today = () => {
    attemptedFloor.current = latest.current?.version ?? null;
    setRoute("today");
    void synchronize();
  };
  // Native Back on Settings is its «Сегодня» (SettingsScreen onToday); a gate-hidden Host is not Settings.
  const settingsBack = useRef(today);
  useLayoutEffect(() => { settingsBack.current = today; });
  const onSettings = route === "settings";
  useEffect(() => onSettings ? bindBackButton(window, () => settingsBack.current()) : undefined, [onSettings]);
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
  let hostRoute: "today" | "learning" | "settings" = route === "oral" ? "settings" : route;
  let screen: ReactNode = null, todayShown = false;
  if (selected === null) screen = readScreen();
  else if (route === "today") {
    if (!(fits && gate === "ready")) {
      hostRoute = "settings";
      screen = gate === "failed" ? failed : loading;
    } else if (readAfter && read.kind !== "pending") {
      hostRoute = "settings";
      screen = readScreen();
    } else todayShown = true;
  }
  // The oral owner lives for the whole document; it shows a screen only on its own route.
  const oral = useOralHost({ access: props.access, transport: props.transport, stores: props.oralStores, newId: props.newId,
    language: props.language, settings, minimumStateVersion: highest(floor?.version, oralSelected?.version),
    initialSessionId: oralSeed, seedPending: route === "oral" && readAfter && (read.kind === "pending" || read.kind === "oral"),
    route: route === "oral" ? "oral" : todayShown ? "today" : "hidden",
    onOral: () => setRoute("oral"), onToday: today });
  if (todayShown && oral.blocksToday) { hostRoute = "settings"; screen = loading; }
  return <>
    {selected !== null && <LearningHost access={props.access} transport={props.transport} storage={props.storage}
      newId={props.newId} language={props.language} settings={settings}
      minimumStateVersion={highest(floor?.version, selected.version)} initialSessionId={seed}
      route={hostRoute} submitOnEnter renderPreview={renderPreview}
      onLearning={() => { hostClaimed.current = true; setRoute("learning"); }}
      onToday={() => { hostClaimed.current = false; seedReleased.current = true; today(); }}
      onSettings={() => { setSettingsOpened(true); setRoute("settings"); }} />}
    {screen}
    {oral.screen}
    {settingsOpened && <div hidden={route !== "settings"}>
      <SettingsHost access={props.access} transport={props.transport} document={settings}
        language={props.language} active={route === "settings"} onToday={today} />
    </div>}
  </>;
}
