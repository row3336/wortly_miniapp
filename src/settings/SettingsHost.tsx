import { useEffect, useRef, useState } from "react";
import type { HttpOptions } from "../api/http";
import { useBackLayer } from "../app/navigationBack";
import type { OpenedAccess } from "../app/openedAccess";
import { closeMiniApp } from "../platform/telegram";
import type { Language } from "../i18n/language";
import type { CatalogState } from "./MaterialEditor";
import { SettingsScreen, type SettingsView } from "./SettingsScreen";
import { createTopicCatalogApi } from "./topicCatalogApi";
import type { SettingsDocument } from "./useSettingsDocument";

type Props = {
  access: OpenedAccess; transport: HttpOptions; language: Language; active: boolean;
  document: SettingsDocument;
  onToday(): void;
  onDictionary?(): void;
};

/** The editor retains its catalog/search UI; the application owns settings commands. */
export function SettingsHost(props: Props) {
  const latest = useRef(props); latest.current = props;
  const [catalog, setCatalog] = useState<CatalogState>({ phase: "loading", topics: null });
  const load = useRef<(() => Promise<void>) | null>(null);
  const lastRead = useRef<{ access: OpenedAccess; active: boolean; current: boolean } | null>(null);
  // project_notifications §8.1: the submenu «Уведомления» is an inner view of Settings on the same controller, document and
  // pending slot. Back (the button and Telegram's BackButton) returns to the settings while Settings are shown.
  const [view, setView] = useState<SettingsView>("main");
  useBackLayer("screen", props.active && view === "notifications" ? () => setView("main") : null);

  useEffect(() => {
    let live = true, request = 0;
    const api = createTopicCatalogApi(props.transport);
    const topics = async () => {
      const sequence = ++request, opened = latest.current.access;
      setCatalog(previous => ({ phase: "loading", topics: previous.topics }));
      try {
        const result = await opened.run(({ token }) => api.get(token));
        if (live && sequence === request && opened === latest.current.access && opened.isLive()) {
          setCatalog({ phase: "ready", topics: result.topics });
        }
      } catch {
        if (live && sequence === request && opened === latest.current.access && opened.isLive()) {
          setCatalog(previous => ({ phase: "failed", topics: previous.topics }));
        }
      }
    };
    load.current = topics;
    lastRead.current = { access: props.access, active: props.active, current: props.document.state.dataCurrent };
    if (props.active) void topics();
    return () => { live = false; request++; load.current = null; };
  }, [props.access.key, props.transport]);

  useEffect(() => {
    const previous = lastRead.current;
    if (previous && props.active && (!previous.active || previous.access !== props.access
      || previous.current && !props.document.state.dataCurrent)) void load.current?.();
    lastRead.current = { access: props.access, active: props.active, current: props.document.state.dataCurrent };
  }, [props.access, props.active, props.document.state.dataCurrent]);

  return <SettingsScreen active={props.active} snapshot={props.document.state} catalog={catalog} language={props.language} onToday={props.onToday} onDictionary={props.onDictionary} feedback={props.document.feedback}
    view={view} onView={setView}
    // «Открыть бота» (R12-15, working text): closing the Mini App returns to the bot's chat it was opened from. Technical
    // choice of the worker, pending owner (a direct link would need the bot's name in the build).
    onOpenBot={() => closeMiniApp(window)}
    onReloadTopics={() => { void load.current?.(); }} actions={{ ...props.document.actions,
      refresh: async () => { await Promise.all([props.document.actions.refresh(), load.current?.()]); },
    }} />;
}
