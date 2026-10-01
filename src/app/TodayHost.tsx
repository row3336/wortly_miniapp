import { useEffect, useState } from "react";
import type { HttpOptions } from "../api/http";
import type { Language } from "../i18n/language";
import { createTodayApi } from "../today/todayApi";
import { TodayController, type TodaySource, type TodayState } from "../today/todayController";
import { TodayScreen, type TodayScreenProps } from "../today/TodayScreen";
import { EntryScreen } from "./EntryScreen";
import type { OpenedAccess } from "./openedAccess";
import type { BusyAccess } from "./busyAccess";
import { RemoteStopNotice } from "../study/RemoteStopScreen";

type Props = { access: OpenedAccess; transport: HttpOptions; language: Language }
  & Pick<TodayScreenProps, "onNavigate" | "enabledDestinations" | "onOpenLearning">;

type DocumentProps = Omit<Props, "access"> & { access: OpenedAccess | BusyAccess;
  notice?: TodayScreenProps["notice"]; onRefresh?: () => void };

function TodayDocument({ access, transport, language, onNavigate, enabledDestinations, onOpenLearning, notice, onRefresh }: DocumentProps) {
  const [state, setState] = useState<TodayState>({ kind: "loading" });
  const [retry, setRetry] = useState<(() => void) | undefined>();
  useEffect(() => {
    let active = true;
    const api = createTodayApi(transport);
    const controller = new TodayController(api, next => { if (active && access.isLive()) setState(next); });
    const source: TodaySource = { identity: access, get: () => "readToday" in access
      ? access.readToday() : access.run(credentials => api.get(credentials.token)) };
    const pair = `${access.profile.dictionary_language}-de` as const;
    const load = () => { if (active && access.isLive()) void controller.loadFrom(source, pair); };
    setRetry(() => load);
    load();
    return () => {
      active = false;
      controller.dispose();
    };
  }, [access, transport]);

  return <TodayScreen state={state} language={language} onRetry={() => onRefresh ? onRefresh() : retry?.()} notice={notice}
    onNavigate={onNavigate} enabledDestinations={enabledDestinations} onOpenLearning={onOpenLearning} />;
}

export function BusyTodayHost(props: { access: BusyAccess; transport: HttpOptions; language: Language;
  onRequest(): void; onRefresh(): void }) {
  return <TodayDocument key={props.access.key} access={props.access} transport={props.transport}
    language={props.language} onRefresh={props.onRefresh}
    notice={<RemoteStopNotice language={props.language} onRequest={props.onRequest} onRefresh={props.onRefresh} />} />;
}

export function TodayHost(props: Props) {
  // Preserve the server's resume route; never replace an active session with a fresh home screen.
  // The session screen is connected in the subsequent study UI work.
  if (props.access.session !== null) return <EntryScreen state={{ kind: "opened" }} language={props.language} />;
  return <TodayDocument key={props.access.key} {...props} />;
}
