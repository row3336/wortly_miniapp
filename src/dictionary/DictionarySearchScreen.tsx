import { useId, useLayoutEffect, useRef } from "react";
import type { CardTranslations, DictionaryReferenceCard } from "../api/generated";
import { BottomNav } from "../app/BottomNav";
import type { Tab } from "../app/navigation";
import type { Language } from "../i18n/language";
import type { DictionaryHistoryActions, DictionaryHistorySnapshot } from "./useDictionaryHistoryDocument";
import type { DictionarySearchActions, DictionarySearchSnapshot } from "./useDictionarySearchDocument";
import "../today/today.css";
import "./dictionarySearch.css";

export type DictionarySearchScreenProps = {
  state: DictionarySearchSnapshot;
  /** Entry from another section belongs to the host, together with its query policy. */
  actions: Omit<DictionarySearchActions, "enterFromSection">;
  /** K07-094: the account's last opened cards, shown while the query is blank. */
  history: DictionaryHistorySnapshot;
  historyActions: Pick<DictionaryHistoryActions, "retry">;
  language: Language;
  /** A result, a similar card or a history entry (K07-095) opens the card at once. */
  onOpenCard(cardId: string): void;
  onNavigate(destination: Exclude<Tab, "dictionary">): void;
  /** Document scroll to restore once the shown list is final; pass null between restorations. */
  restoreScroll: number | null;
};

// Working copy for G05. Literal ru from REQ: title (REQ:147), search/clear (REQ:132), phrases = mode name К07-093 (uk/en working copy),
// find (REQ:220), empty (REQ:326). retry repeats TodayScreen; types/level repeat CardDescription; the panel is BottomNav.
// History and similar texts are working names of the RA table 6.1.14 states (open question В7).
const copy = {
  ru: {
    title: "Словарь", search: "Поиск", clear: "Очистить", phrases: "Фразы", find: "Найти",
    results: "Результаты", searching: "Ищем…", empty: "Нет совпадений", failed: "Не удалось загрузить результаты",
    retry: "Повторить", more: "Ещё", level: "Уровень",
    similar: "Похожие", history: "История", historyLoading: "Загружаем историю…", historyEmpty: "История пуста",
    historyFailed: "Не удалось загрузить историю",
    types: { noun: "Существительное", verb: "Глагол", phrase: "Фраза", adjective: "Прилагательное", pronoun: "Местоимение",
      adverb: "Наречие", preposition: "Предлог", conjunction: "Союз", particle: "Частица" },
  },
  uk: {
    title: "Словник", search: "Пошук", clear: "Очистити", phrases: "Фрази", find: "Знайти",
    results: "Результати", searching: "Шукаємо…", empty: "Немає збігів", failed: "Не вдалося завантажити результати",
    retry: "Спробувати ще раз", more: "Ще", level: "Рівень",
    similar: "Схожі", history: "Історія", historyLoading: "Завантажуємо історію…", historyEmpty: "Історія порожня",
    historyFailed: "Не вдалося завантажити історію",
    types: { noun: "Іменник", verb: "Дієслово", phrase: "Фраза", adjective: "Прикметник", pronoun: "Займенник",
      adverb: "Прислівник", preposition: "Прийменник", conjunction: "Сполучник", particle: "Частка" },
  },
  en: {
    title: "Dictionary", search: "Search", clear: "Clear", phrases: "Phrases", find: "Find",
    results: "Results", searching: "Searching…", empty: "No matches", failed: "Could not load results",
    retry: "Try again", more: "More", level: "Level",
    similar: "Similar", history: "History", historyLoading: "Loading history…", historyEmpty: "History is empty",
    historyFailed: "Could not load history",
    types: { noun: "Noun", verb: "Verb", phrase: "Phrase", adjective: "Adjective", pronoun: "Pronoun",
      adverb: "Adverb", preposition: "Preposition", conjunction: "Conjunction", particle: "Particle" },
  },
} as const;

type Text = (typeof copy)[Language];
/**
 * What every row shows: German word, type and level. A search result and a similar card add their translation;
 * a history entry has none (P18: the full card shows it).
 */
type Row = Pick<DictionaryReferenceCard, "lemma" | "type" | "cefr"> & { card_id: string; translation?: CardTranslations };

/** Ordinary card display: the personal translation when present, otherwise the common ones. */
function translation(item: Row): string {
  if (item.translation === undefined) return "";
  const personal = item.translation.personal;
  return personal !== null ? personal.value : item.translation.common.join(", ");
}

function CardList(props: { items: Row[]; t: Text; lang: string | undefined; onOpenCard(cardId: string): void }) {
  const { t } = props;
  return <ul className="dictionary-search-list">
    {props.items.map(item => {
      const text = translation(item);
      return <li key={item.card_id}>
        <button type="button" className="dictionary-search-item" onClick={() => props.onOpenCard(item.card_id)}>
          <span className="dictionary-search-lemma" lang="de">{item.lemma}</span>
          <span className="dictionary-search-meta">
            <span>{t.types[item.type]}</span>
            {item.cefr !== null && <span title={t.level}>{item.cefr}</span>}
          </span>
          {text !== "" && <span className="dictionary-search-translation" lang={props.lang}>{text}</span>}
        </button>
      </li>;
    })}
  </ul>;
}

/** Shows one search document and reports intents; reads, retries and stored input belong to the hook. */
export function DictionarySearchScreen(props: DictionarySearchScreenProps) {
  const { state, actions, history } = props;
  const t = copy[props.language];
  const queryId = useId();
  const input = useRef<HTMLInputElement>(null);
  const region = useRef<HTMLElement>(null);
  const focused = useRef(0);
  const restore = useRef<{ seen: number | null; pending: { top: number; search: string } | null }>({ seen: null, pending: null });

  const blank = state.query.trim() === "";
  const shown = state.items.length > 0;
  const loading = state.phase === "loading";
  const appendFailed = state.phase === "ready" && state.problem !== null;
  const canLoadMore = state.mode === "full" && state.phase === "ready" && state.problem === null && state.nextCursor !== null;
  const search = JSON.stringify([state.query, state.material, state.mode]);
  const translationLanguage = state.pair?.slice(0, 2);
  const historyId = useId(), similarId = useId();

  useLayoutEffect(() => {
    if (state.focusRequest === focused.current) return;
    focused.current = state.focusRequest;
    input.current?.focus();
  }, [state.focusRequest]);

  // Every commit: the restore belongs to one return. It waits for the final visible result of the same search
  // and is spent there once; an empty final result spends it without scrolling.
  useLayoutEffect(() => {
    const r = restore.current;
    if (props.restoreScroll !== r.seen) {
      r.seen = props.restoreScroll;
      r.pending = props.restoreScroll === null ? null : { top: props.restoreScroll, search };
    }
    if (!r.pending) return;
    if (r.pending.search !== search) { r.pending = null; return; }
    if (!state.restoreReady || !region.current || region.current.closest("[hidden]")) return;
    const top = r.pending.top;
    r.pending = null;
    if (shown) window.scrollTo(0, top);
  });

  return <main className="dictionary-search-screen">
    <header className="dictionary-search-header"><h1>{t.title}</h1></header>
    <form className="dictionary-search-form" role="search" aria-label={t.search}
      onSubmit={event => { event.preventDefault(); if (!blank) actions.submit(); }}>
      <label className="dictionary-search-label" htmlFor={queryId}>{t.search}</label>
      <div className="dictionary-search-row">
        <input id={queryId} ref={input} className="dictionary-search-input" type="text" value={state.query}
          autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="search"
          onChange={event => actions.setQuery(event.currentTarget.value)} />
        <button type="button" className="dictionary-search-clear" disabled={state.query === ""}
          onClick={() => { actions.setQuery(""); input.current?.focus(); }}>{t.clear}</button>
      </div>
      <div className="dictionary-search-row">
        <label className="dictionary-search-phrases">
          {/* K07-093: on = phrases mode only, off = words mode; never both types. */}
          <input type="checkbox" role="switch" checked={state.material === "phrases"}
            onChange={event => actions.setMaterial(event.currentTarget.checked ? "phrases" : "words")} />
          <span>{t.phrases}</span>
        </label>
        <button type="submit" className="dictionary-search-find" disabled={blank}>{t.find}</button>
      </div>
    </form>
    <section ref={region} className="dictionary-search-results" aria-label={t.results} aria-busy={loading}>
      {loading && <p className="dictionary-search-status" role="status">{t.searching}</p>}
      {state.phase === "failed" && <div className="dictionary-search-problem" role="alert">
        <p>{t.failed}</p>
        <button type="button" className="dictionary-search-retry" onClick={() => actions.retry()}>{t.retry}</button>
      </div>}
      {state.phase === "ready" && !shown && state.problem === null && <p className="dictionary-search-status" role="status">{t.empty}</p>}
      {shown && <CardList items={state.items} t={t} lang={translationLanguage} onOpenCard={props.onOpenCard} />}
      {appendFailed && <div className="dictionary-search-problem" role="alert">
        <p>{t.failed}</p>
        <button type="button" className="dictionary-search-retry" onClick={() => actions.retry()}>{t.retry}</button>
      </div>}
      {canLoadMore && <button type="button" className="dictionary-search-more" disabled={state.loadingMore}
        aria-busy={state.loadingMore} onClick={() => actions.loadMore()}>{t.more}</button>}
    </section>
    {/* K07-091: similar cards stay apart from the results; the query is never replaced by one of them. */}
    {!blank && state.similar.length > 0 && <section className="dictionary-search-results" aria-labelledby={similarId}>
      <h2 id={similarId} className="dictionary-search-heading">{t.similar}</h2>
      <CardList items={state.similar} t={t} lang={translationLanguage} onOpenCard={props.onOpenCard} />
    </section>}
    {blank && <HistorySection id={historyId} history={history} t={t} onRetry={() => props.historyActions.retry()}
      onOpenCard={props.onOpenCard} />}
    <BottomNav current="dictionary" language={props.language} enabled={["today", "settings"]}
      onNavigate={tab => { if (tab !== "dictionary") props.onNavigate(tab); }} />
  </main>;
}

/**
 * RA table 6.1.14: an empty history, its loading and its failure are told apart. Rows the server left out (hidden in
 * this pair, or not built this time) are just absent: there is no partial-failure message (P20). The list is read
 * again on every showing; a whole-list failure offers the retry.
 */
function HistorySection(props: { id: string; history: DictionaryHistorySnapshot; t: Text; onRetry(): void; onOpenCard(cardId: string): void }) {
  const { history, t } = props;
  if (history.phase === "idle" || history.phase === "disposed") return null;
  const shown = history.items.length > 0;
  return <section className="dictionary-search-results" aria-labelledby={props.id} aria-busy={history.phase === "loading"}>
    <h2 id={props.id} className="dictionary-search-heading">{t.history}</h2>
    {history.phase === "loading" && !shown && <p className="dictionary-search-status" role="status">{t.historyLoading}</p>}
    {history.phase === "ready" && !shown && <p className="dictionary-search-status" role="status">{t.historyEmpty}</p>}
    {history.phase === "failed" && <div className="dictionary-search-problem" role="alert">
      <p>{t.historyFailed}</p>
      <button type="button" className="dictionary-search-retry" onClick={props.onRetry}>{t.retry}</button>
    </div>}
    {shown && <CardList items={history.items} t={t} lang={undefined} onOpenCard={props.onOpenCard} />}
  </section>;
}
