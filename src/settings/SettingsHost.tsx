import { useEffect, useRef, useState } from "react";
import type { HttpOptions } from "../api/http";
import type { OpenedAccess } from "../app/openedAccess";
import type { Language } from "../i18n/language";
import type { CatalogState } from "./MaterialEditor";
import { SettingsScreen } from "./SettingsScreen";
import { createTopicCatalogApi } from "./topicCatalogApi";
import type { SettingsDocument } from "./useSettingsDocument";

type Props = {
  access: OpenedAccess; transport: HttpOptions; language: Language; active: boolean;
  document: SettingsDocument;
  onToday(): void;
};

/** The editor retains its catalog/search UI; the application owns settings commands. */
export function SettingsHost(props: Props) {
  const latest = useRef(props); latest.current = props;
  const [catalog, setCatalog] = useState<CatalogState>({ phase: "loading", topics: null });
  const load = useRef<(() => Promise<void>) | null>(null);
  const lastRead = useRef<{ access: OpenedAccess; active: boolean; current: boolean } | null>(null);

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

  return <SettingsScreen snapshot={props.document.state} catalog={catalog} language={props.language} onToday={props.onToday}
    onReloadTopics={() => { void load.current?.(); }} actions={{ ...props.document.actions,
      refresh: async () => { await Promise.all([props.document.actions.refresh(), load.current?.()]); },
    }} />;
}
