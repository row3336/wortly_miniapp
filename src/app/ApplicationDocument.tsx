import { useCallback, useEffect, useRef, useState } from "react";
import type { HttpOptions } from "../api/http";
import type { Language } from "../i18n/language";
import { SettingsHost } from "../settings/SettingsHost";
import { useSettingsDocument, type SettingsObservation } from "../settings/useSettingsDocument";
import type { SettingsPendingStore } from "../settings/settingsPending";
import { TodayScreen } from "../today/TodayScreen";
import { EntryScreen } from "./EntryScreen";
import type { OpenedAccess } from "./openedAccess";
import { TodayHost } from "./TodayHost";

type Props = {
  access: OpenedAccess; transport: HttpOptions; pendingStore: SettingsPendingStore; language: Language;
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

/** Keyed by the opened document, never by the identity of a foreground access handle. */
export function ApplicationDocument(props: Props) {
  const [route, setRoute] = useState<"today" | "settings">("today");
  const [settingsOpened, setSettingsOpened] = useState(false);
  const [floor, setFloor] = useState<SettingsObservation | null>(null);
  const [gate, setGate] = useState<"ready" | "loading" | "failed">("ready");
  const current = useRef(props);
  current.current = props;
  const latest = useRef(floor);
  const lifetime = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const attemptedFloor = useRef<string | null>(null);
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

  const today = () => {
    attemptedFloor.current = latest.current?.version ?? null;
    setRoute("today");
    void synchronize();
  };
  if (props.access.session !== null) return <EntryScreen state={{ kind: "opened" }} language={props.language} />;
  return <>
    {route === "today" && (fits && gate === "ready"
      ? <TodayHost access={props.access} transport={props.transport} language={props.language}
        onNavigate={destination => {
          if (destination === "settings") { setSettingsOpened(true); setRoute("settings"); }
        }} enabledDestinations={["settings"]} />
      : <TodayScreen state={gate === "failed" ? { kind: "failed", reason: "load" } : { kind: "loading" }}
        language={props.language} onRetry={() => { void synchronize(); }} />)}
    {settingsOpened && <div hidden={route !== "settings"}>
      <SettingsHost access={props.access} transport={props.transport} document={settings}
        language={props.language} active={route === "settings"} onToday={today} />
    </div>}
  </>;
}
