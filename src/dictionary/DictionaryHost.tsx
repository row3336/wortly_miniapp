import { useLayoutEffect, useRef } from "react";
import type { HttpOptions } from "../api/http";
import type { Tab } from "../app/navigation";
import type { OpenedAccess } from "../app/openedAccess";
import type { Language } from "../i18n/language";
import { DictionarySearchScreen } from "./DictionarySearchScreen";
import { useDictionaryHistoryDocument } from "./useDictionaryHistoryDocument";
import { useDictionarySearchDocument, type SearchLimits } from "./useDictionarySearchDocument";

// root decision, pending owner: В3 — five suggestions (the top of К07-092's 3–5; the owner narrows it after the phone
// check) and twenty results per page of the full search. The single place of both values.
export const DICTIONARY_SEARCH_LIMITS: SearchLimits = Object.freeze({ suggest: 5, page: 20 });

/**
 * One showing of the dictionary. The host passes a new object for every navigation to the dictionary and
 * the same object while that route stays; null while another screen is shown.
 */
export type DictionaryVisit =
  /** From another section (К07-097, К07-100): clear the query, select words, focus the field. */
  | { kind: "entry" }
  /** Back from a card (К07-096): query, mode and results are kept; the scroll comes from the return context. */
  | { kind: "return"; scroll: number | null };
/** The return context a card keeps for its source, by address only. */
export type DictionaryReturn = { search: { query: string; mode: "words" | "phrases" }; scroll: number };

export type DictionaryHostProps = {
  access: OpenedAccess;
  transport: HttpOptions;
  language: Language;
  /** Tests only; the application uses DICTIONARY_SEARCH_LIMITS. */
  limits?: SearchLimits;
  visit: DictionaryVisit | null;
  onOpenCard(cardId: string, back: DictionaryReturn): void;
  onNavigate(destination: Exclude<Tab, "dictionary">): void;
};

/**
 * The dictionary section (М11). Keep it mounted for the whole document once opened: the search lives here,
 * so a return from a card finds it unchanged. Reads run only while it is shown.
 */
export function DictionaryHost(props: DictionaryHostProps) {
  const shown = props.visit !== null;
  const search = useDictionarySearchDocument({ access: props.access, transport: props.transport, enabled: shown,
    limits: props.limits ?? DICTIONARY_SEARCH_LIMITS });
  const history = useDictionaryHistoryDocument({ access: props.access, transport: props.transport, enabled: shown });
  const seen = useRef<DictionaryVisit | null>(null);
  // The card this section opened last: a return comes back from it.
  const opened = useRef<string | null>(null);
  const { enterFromSection } = search.actions, { refresh, forget } = history.actions;
  // A layout effect: the entry's clearing and both reads leave with the passive commit of the same render.
  useLayoutEffect(() => {
    const visit = props.visit;
    if (visit === null || visit === seen.current) return;
    seen.current = visit;
    if (visit.kind === "entry") {
      enterFromSection();
      // root decision, pending owner: В1/Н1 — an entry from another section rereads every card text: the cards may
      // have been edited elsewhere (e.g. from a quiz).
      forget();
    } else {
      // root decision, pending owner: В1/Н1 — a return rereads the text of the card it comes from (an own edit there);
      // without a known card the whole cache goes.
      forget(opened.current ?? undefined);
      // root decision, pending owner: В4 — a return never rereads the search: query, mode, results and scroll stay (SP4e).
    }
    opened.current = null;
    // K11-013: every showing rereads the history; opening a card is an own change of it (only /view records it).
    // root decision, pending owner: В6 — the history is the account's list, not filtered by mode or pair.
    refresh();
  }, [props.visit, enterFromSection, refresh, forget]);
  const restoreScroll = props.visit?.kind === "return" ? props.visit.scroll : null;
  return <div hidden={!shown}>
    <DictionarySearchScreen state={search.state} actions={search.actions} history={history.state}
      historyActions={history.actions} language={props.language} restoreScroll={restoreScroll}
      onNavigate={props.onNavigate}
      onOpenCard={cardId => {
        opened.current = cardId;
        props.onOpenCard(cardId, { search: { query: search.state.query, mode: search.state.material }, scroll: window.scrollY });
      }} />
  </div>;
}
