import { useId, useLayoutEffect, useRef } from "react";
import type { DictionarySearchItem } from "../api/generated";
import type { Language } from "../i18n/language";
import type { DictionarySearchActions, DictionarySearchSnapshot } from "./useDictionarySearchDocument";
import "../today/today.css";
import "./dictionarySearch.css";

export type DictionarySearchScreenProps = {
  state: DictionarySearchSnapshot;
  /** Entry from another section belongs to the host, together with its query policy. */
  actions: Omit<DictionarySearchActions, "enterFromSection">;
  language: Language;
  onOpenCard(cardId: string): void;
  onNavigate(destination: "today" | "settings"): void;
  /** Document scroll to restore once the shown list is final; pass null between restorations. */
  restoreScroll: number | null;
};

// Working copy for G05. Literal ru from REQ: title/today/settings (REQ:147), search/clear (REQ:132), phrases = mode name К07-093 (uk/en working copy),
// find (REQ:220), empty (REQ:326). retry/nav repeat TodayScreen; types/level repeat CardDescription.
const copy = {
  ru: {
    title: "Словарь", search: "Поиск", clear: "Очистить", phrases: "Фразы", find: "Найти",
    results: "Результаты", searching: "Ищем…", empty: "Нет совпадений", failed: "Не удалось загрузить результаты",
    retry: "Повторить", more: "Ещё", level: "Уровень",
    today: "Сегодня", settings: "Настройки", nav: "Основная навигация",
    types: { noun: "Существительное", verb: "Глагол", phrase: "Фраза", adjective: "Прилагательное", pronoun: "Местоимение",
      adverb: "Наречие", preposition: "Предлог", conjunction: "Союз", particle: "Частица" },
  },
  uk: {
    title: "Словник", search: "Пошук", clear: "Очистити", phrases: "Фрази", find: "Знайти",
    results: "Результати", searching: "Шукаємо…", empty: "Немає збігів", failed: "Не вдалося завантажити результати",
    retry: "Спробувати ще раз", more: "Ще", level: "Рівень",
    today: "Сьогодні", settings: "Налаштування", nav: "Основна навігація",
    types: { noun: "Іменник", verb: "Дієслово", phrase: "Фраза", adjective: "Прикметник", pronoun: "Займенник",
      adverb: "Прислівник", preposition: "Прийменник", conjunction: "Сполучник", particle: "Частка" },
  },
  en: {
    title: "Dictionary", search: "Search", clear: "Clear", phrases: "Phrases", find: "Find",
    results: "Results", searching: "Searching…", empty: "No matches", failed: "Could not load results",
    retry: "Try again", more: "More", level: "Level",
    today: "Today", settings: "Settings", nav: "Main navigation",
    types: { noun: "Noun", verb: "Verb", phrase: "Phrase", adjective: "Adjective", pronoun: "Pronoun",
      adverb: "Adverb", preposition: "Preposition", conjunction: "Conjunction", particle: "Particle" },
  },
} as const;

/** Ordinary card display: the personal translation when present, otherwise the common ones. */
function translation(item: DictionarySearchItem): string {
  const personal = item.translation.personal;
  return personal !== null ? personal.value : item.translation.common.join(", ");
}

/** Shows one search document and reports intents; reads, retries and stored input belong to the hook. */
export function DictionarySearchScreen(props: DictionarySearchScreenProps) {
  const { state, actions } = props;
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
      {shown && <ul className="dictionary-search-list">
        {state.items.map(item => {
          const text = translation(item);
          return <li key={item.card_id}>
            <button type="button" className="dictionary-search-item" onClick={() => props.onOpenCard(item.card_id)}>
              <span className="dictionary-search-lemma" lang="de">{item.lemma}</span>
              <span className="dictionary-search-meta">
                <span>{t.types[item.type]}</span>
                {item.cefr !== null && <span title={t.level}>{item.cefr}</span>}
              </span>
              {text !== "" && <span className="dictionary-search-translation" lang={translationLanguage}>{text}</span>}
            </button>
          </li>;
        })}
      </ul>}
      {appendFailed && <div className="dictionary-search-problem" role="alert">
        <p>{t.failed}</p>
        <button type="button" className="dictionary-search-retry" onClick={() => actions.retry()}>{t.retry}</button>
      </div>}
      {canLoadMore && <button type="button" className="dictionary-search-more" disabled={state.loadingMore}
        aria-busy={state.loadingMore} onClick={() => actions.loadMore()}>{t.more}</button>}
    </section>
    <nav className="today-nav" aria-label={t.nav}>
      <button type="button" onClick={() => props.onNavigate("today")}>{t.today}</button>
      <button type="button" aria-current="page" disabled>{t.title}</button>
      <button type="button" onClick={() => props.onNavigate("settings")}>{t.settings}</button>
    </nav>
  </main>;
}
