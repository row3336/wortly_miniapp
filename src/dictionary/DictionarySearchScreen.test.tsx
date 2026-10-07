import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionarySearchItem } from "../api/generated";
import type { Language } from "../i18n/language";
import { DictionarySearchScreen, type DictionarySearchScreenProps } from "./DictionarySearchScreen";
import type { DictionarySearchSnapshot } from "./useDictionarySearchDocument";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function item(n: number, rest: Partial<DictionarySearchItem> = {}): DictionarySearchItem {
  return { card_id: id(n), revision: "1", lemma: `Wort${n}`, type: "noun", cefr: "A1",
    translation: { common: [`слово${n}`], personal: null }, match_kind: "exact", ...rest };
}
function snapshot(rest: Partial<DictionarySearchSnapshot> = {}): DictionarySearchSnapshot {
  return { phase: "idle", mode: "suggest", query: "", material: "words", pair: null, items: [], similar: [], nextCursor: null,
    loadingMore: false, pagesLoaded: 0, restoreReady: true, problem: null, focusRequest: 0, ...rest };
}
const ready = (rest: Partial<DictionarySearchSnapshot> = {}) => snapshot({ phase: "ready", query: "Haus", pair: "ru-de",
  items: [item(1)], pagesLoaded: 1, ...rest });
const full = (rest: Partial<DictionarySearchSnapshot> = {}) => ready({ mode: "full", nextCursor: "c1", ...rest });

function fixture(state: DictionarySearchSnapshot, rest: Partial<DictionarySearchScreenProps> = {}) {
  const props: DictionarySearchScreenProps = {
    state, language: "ru", restoreScroll: null, onOpenCard: vi.fn(), onNavigate: vi.fn(),
    actions: { setQuery: vi.fn(), setMaterial: vi.fn(), submit: vi.fn(), loadMore: vi.fn(), retry: vi.fn() },
    ...noHistory(), ...rest,
  };
  const view = render(<DictionarySearchScreen {...props} />);
  const update = (next: Partial<DictionarySearchScreenProps>) => {
    Object.assign(props, next);
    view.rerender(<DictionarySearchScreen {...props} />);
  };
  return { props, view, update };
}
const noHistory = (): Pick<DictionarySearchScreenProps, "history" | "historyActions"> =>
  ({ history: { phase: "idle", items: [], pair: null, problem: null }, historyActions: { retry: vi.fn() } });
const results = () => screen.getByRole("region", { name: "Результаты" });
const query = () => screen.getByRole("textbox", { name: "Поиск" }) as HTMLInputElement;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("DictionarySearchScreen", () => {
  it.each([
    ["ru", { title: "Словарь", search: "Поиск", clear: "Очистить", phrases: "Фразы", find: "Найти", results: "Результаты",
      empty: "Нет совпадений", failed: "Не удалось загрузить результаты", retry: "Повторить", more: "Ещё",
      today: "Сегодня", settings: "Настройки", nav: "Основная навигация", type: "Глагол" }],
    ["uk", { title: "Словник", search: "Пошук", clear: "Очистити", phrases: "Фрази", find: "Знайти", results: "Результати",
      empty: "Немає збігів", failed: "Не вдалося завантажити результати", retry: "Спробувати ще раз", more: "Ще",
      today: "Сьогодні", settings: "Налаштування", nav: "Основна навігація", type: "Дієслово" }],
    ["en", { title: "Dictionary", search: "Search", clear: "Clear", phrases: "Phrases", find: "Find", results: "Results",
      empty: "No matches", failed: "Could not load results", retry: "Try again", more: "More",
      today: "Today", settings: "Settings", nav: "Main navigation", type: "Verb" }],
  ] as const)("speaks %s without technical codes in every state", (language: Language, t) => {
    const { update } = fixture(full({ items: [item(1, { type: "verb" })] }), { language });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(t.title);
    expect(screen.getByRole("textbox", { name: t.search })).toBeTruthy();
    expect(screen.getByRole("switch", { name: t.phrases })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.clear })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.find })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.more })).toBeTruthy();
    expect(screen.getByRole("region", { name: t.results }).textContent).toContain(t.type);
    const nav = screen.getByRole("navigation", { name: t.nav });
    expect(within(nav).getAllByRole("button").map(button => button.textContent)).toEqual([t.today, t.title, t.settings]);
    update({ state: ready({ items: [] }) });
    expect(screen.getByRole("status").textContent).toBe(t.empty);
    for (const problem of ["load", "pair_changed", "stale_response"] as const) {
      update({ state: snapshot({ phase: "failed", query: "Haus", problem }) });
      expect(screen.getByRole("alert").textContent).toBe(`${t.failed}${t.retry}`);
    }
    update({ state: full({ problem: "cursor_stale", nextCursor: null }) });
    const text = document.body.textContent!;
    for (const code of ["cursor_stale", "pair_changed", "stale_response", "c1", id(1), "noun", "ru-de", "exact"]) {
      expect(text).not.toContain(code);
    }
  });

  it.each([
    ["ru", { history: "История", loading: "Загружаем историю…", empty: "История пуста", failed: "Не удалось загрузить историю",
      retry: "Повторить", similar: "Похожие", results: "Результаты" }],
    ["uk", { history: "Історія", loading: "Завантажуємо історію…", empty: "Історія порожня", failed: "Не вдалося завантажити історію",
      retry: "Спробувати ще раз", similar: "Схожі", results: "Результати" }],
    ["en", { history: "History", loading: "Loading history…", empty: "History is empty", failed: "Could not load history",
      retry: "Try again", similar: "Similar", results: "Results" }],
  ] as const)("RA 6.1.14: tells history loading, emptiness and failure apart and keeps similar cards apart, in %s", (language: Language, t) => {
    const history = (rest: Partial<DictionarySearchScreenProps["history"]>) =>
      ({ phase: "ready" as const, items: [], pair: "ru-de" as const, problem: null, ...rest });
    const { props, update } = fixture(snapshot(), { language, history: history({ phase: "loading" }) });
    const region = () => screen.getByRole("region", { name: t.history });
    expect(within(region()).getByRole("status").textContent).toBe(t.loading);
    expect(region().getAttribute("aria-busy")).toBe("true");
    update({ history: history({}) });
    expect(within(region()).getByRole("status").textContent).toBe(t.empty);
    update({ history: history({ phase: "failed", pair: null, problem: "stale_response" }) });
    expect(within(region()).getByRole("alert").textContent).toBe(`${t.failed}${t.retry}`);
    fireEvent.click(within(region()).getByRole("button", { name: t.retry }));
    expect(props.historyActions.retry).toHaveBeenCalledTimes(1);
    expect(props.actions.retry).not.toHaveBeenCalled();
    // A refresh keeps the shown entries without a waiting text.
    update({ history: history({ phase: "loading", items: [{ ...item(4), opened_at: "2026-10-06T10:00:00Z" }] }) });
    expect(within(region()).queryByRole("status")).toBeNull();
    expect(within(region()).getByRole("button").querySelector("[lang='de']")!.textContent).toBe("Wort4");
    expect(within(region()).getByRole("button").querySelector("[lang='ru']")!.textContent).toBe("слово4");
    fireEvent.click(within(region()).getByRole("button"));
    expect(props.onOpenCard).toHaveBeenCalledExactlyOnceWith(id(4));
    // A typed query hides the history; similar cards get their own region after the results.
    update({ state: ready({ similar: [item(7)] }) });
    expect(screen.queryByRole("region", { name: t.history })).toBeNull();
    const similar = screen.getByRole("region", { name: t.similar });
    expect(within(similar).getByRole("button").querySelector("[lang='de']")!.textContent).toBe("Wort7");
    const shown = screen.getByRole("region", { name: t.results });
    expect(shown.compareDocumentPosition(similar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(shown).queryByText("Wort7")).toBeNull();
    update({ state: ready({ similar: [] }) });
    expect(screen.queryByRole("region", { name: t.similar })).toBeNull();
  });

  it("sends typing, clearing, the phrase switch and the full search to the search document", () => {
    const { props, update } = fixture(snapshot());
    expect((screen.getByRole("button", { name: "Очистить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(query(), { target: { value: "Haus" } });
    expect(props.actions.setQuery).toHaveBeenCalledExactlyOnceWith("Haus");
    // The field shows only the document's query.
    expect(query().value).toBe("");
    update({ state: snapshot({ phase: "loading", query: "Haus" }) });
    expect(query().value).toBe("Haus");

    fireEvent.click(screen.getByRole("button", { name: "Найти" }));
    expect(props.actions.submit).toHaveBeenCalledTimes(1);
    fireEvent.submit(screen.getByRole("search"));
    expect(props.actions.submit).toHaveBeenCalledTimes(2);

    const phrases = screen.getByRole("switch", { name: "Фразы" }) as HTMLInputElement;
    expect(phrases.checked).toBe(false);
    fireEvent.click(phrases);
    expect(props.actions.setMaterial).toHaveBeenLastCalledWith("phrases");
    update({ state: snapshot({ phase: "loading", query: "Haus", material: "phrases" }) });
    expect(phrases.checked).toBe(true);
    fireEvent.click(phrases);
    expect(props.actions.setMaterial).toHaveBeenLastCalledWith("words");

    fireEvent.click(screen.getByRole("button", { name: "Очистить" }));
    expect(props.actions.setQuery).toHaveBeenLastCalledWith("");
    expect(document.activeElement).toBe(query());
    expect(props.actions.loadMore).not.toHaveBeenCalled();
    expect(props.actions.retry).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("offers no full search for the query %j", value => {
    const { props } = fixture(snapshot({ query: value }));
    expect((screen.getByRole("button", { name: "Найти" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByRole("search"));
    expect(props.actions.submit).not.toHaveBeenCalled();
  });

  it("lists results in server order and opens the exact card", () => {
    const items = [
      item(9, { lemma: "Zug", type: "noun", cefr: "B1", match_kind: "exact",
        translation: { common: ["поезд", "тяга"], personal: { value: "мой поезд", version: "3" } } }),
      item(2, { lemma: "Abzug", type: "verb", cefr: null, match_kind: "prefix", translation: { common: ["вычет", "отвод"], personal: null } }),
      item(5, { lemma: "<img src=x onerror=alert(1)>", type: "phrase", match_kind: "substring", translation: { common: [], personal: null } }),
    ];
    const { props } = fixture(ready({ items }));
    const rows = within(results()).getAllByRole("button");
    expect(rows.map(row => row.querySelector("[lang='de']")!.textContent)).toEqual(["Zug", "Abzug", "<img src=x onerror=alert(1)>"]);
    expect(rows[0].textContent).toBe("ZugСуществительноеB1мой поезд");
    expect(rows[1].textContent).toBe("AbzugГлаголвычет, отвод");
    expect(rows[2].textContent).toBe("<img src=x onerror=alert(1)>ФразаA1");
    expect(rows[0].querySelector("[lang='ru']")!.textContent).toBe("мой поезд");
    expect(document.querySelector("img")).toBeNull();
    fireEvent.click(rows[1]);
    expect(props.onOpenCard).toHaveBeenCalledExactlyOnceWith(id(2));
  });

  it("navigates to Today and Settings and marks the dictionary as the current section", () => {
    const { props } = fixture(snapshot());
    const nav = screen.getByRole("navigation", { name: "Основная навигация" });
    // M-NAV: the shared main panel, not a copy of its own.
    expect(nav.className).toBe("today-nav bottom-nav");
    const current = within(nav).getByRole("button", { name: "Словарь" }) as HTMLButtonElement;
    expect(current.getAttribute("aria-current")).toBe("page");
    expect(current.disabled).toBe(true);
    fireEvent.click(within(nav).getByRole("button", { name: "Сегодня" }));
    fireEvent.click(within(nav).getByRole("button", { name: "Настройки" }));
    expect(props.onNavigate).toHaveBeenNthCalledWith(1, "today");
    expect(props.onNavigate).toHaveBeenNthCalledWith(2, "settings");
    expect(props.onNavigate).toHaveBeenCalledTimes(2);
  });

  it("offers more results only for a full search with a cursor", () => {
    const { props, update } = fixture(ready({ mode: "suggest", nextCursor: "c1" }));
    expect(screen.queryByRole("button", { name: "Ещё" })).toBeNull();
    update({ state: full({ nextCursor: null }) });
    expect(screen.queryByRole("button", { name: "Ещё" })).toBeNull();
    update({ state: full() });
    fireEvent.click(screen.getByRole("button", { name: "Ещё" }));
    expect(props.actions.loadMore).toHaveBeenCalledTimes(1);
    expect(props.actions.retry).not.toHaveBeenCalled();
  });

  it("keeps the shown list while more results load, fail and are retried", () => {
    const { props, update } = fixture(full({ items: [item(1), item(2)] }));
    const list = within(results()).getByRole("list");
    update({ state: full({ items: [item(1), item(2)], loadingMore: true }) });
    const more = screen.getByRole("button", { name: "Ещё" }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    expect(more.getAttribute("aria-busy")).toBe("true");
    expect(within(results()).getByRole("list")).toBe(list);

    // An ordinary append failure: the same list, retry instead of more, nothing automatic.
    update({ state: full({ items: [item(1), item(2)], nextCursor: null, problem: "load" }) });
    expect(within(results()).getByRole("list")).toBe(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Ещё" })).toBeNull();
    expect(screen.queryByText("Нет совпадений")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Не удалось загрузить результаты");
    expect(props.actions.retry).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Повторить" }));
    expect(props.actions.retry).toHaveBeenCalledTimes(1);
    expect(props.actions.loadMore).not.toHaveBeenCalled();

    // A refused continuation: retry rereads while the shown pages stay.
    update({ state: full({ items: [item(1), item(2)], nextCursor: null, problem: "cursor_stale" }) });
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.actions.retry).toHaveBeenCalledTimes(2);
    update({ state: full({ phase: "loading", items: [item(1), item(2)], nextCursor: null, restoreReady: false }) });
    expect(within(results()).getByRole("list")).toBe(list);
    expect(results().getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Ищем…");
    expect(screen.queryByRole("alert")).toBeNull();
    update({ state: full({ items: [item(1), item(2), item(3)], pagesLoaded: 3 }) });
    expect(within(results()).getByRole("list")).toBe(list);
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(props.actions.retry).toHaveBeenCalledTimes(2);
  });

  it("tells idle, waiting, no matches, failure and closed access apart", () => {
    const { props, update } = fixture(snapshot());
    expect(results().textContent).toBe("");
    expect(results().getAttribute("aria-busy")).toBe("false");

    update({ state: snapshot({ phase: "loading", query: "Haus" }) });
    expect(screen.getByRole("status").textContent).toBe("Ищем…");
    expect(results().getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Нет совпадений")).toBeNull();

    update({ state: ready({ items: [] }) });
    expect(screen.getByRole("status").textContent).toBe("Нет совпадений");
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    update({ state: snapshot({ phase: "failed", query: "Haus", problem: "load" }) });
    expect(screen.queryByText("Нет совпадений")).toBeNull();
    expect(query().value).toBe("Haus");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(props.actions.retry).toHaveBeenCalledTimes(1);

    update({ state: snapshot({ phase: "disposed", query: "Haus", restoreReady: false }) });
    expect(results().textContent).toBe("");
    expect(query().value).toBe("Haus");
    expect(query().disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
    expect(props.actions.retry).toHaveBeenCalledTimes(1);
    expect(props.actions.submit).not.toHaveBeenCalled();
  });

  it("focuses the field once for every focus request", () => {
    const { update } = fixture(snapshot());
    expect(document.activeElement).not.toBe(query());
    update({ state: snapshot({ focusRequest: 1 }) });
    expect(document.activeElement).toBe(query());
    screen.getByRole("button", { name: "Сегодня" }).focus();
    update({ state: snapshot({ focusRequest: 1, query: "Haus", phase: "loading" }) });
    expect(document.activeElement).not.toBe(query());
    update({ state: snapshot({ focusRequest: 2, query: "Haus", phase: "loading" }) });
    expect(document.activeElement).toBe(query());
    cleanup();
    fixture(snapshot({ focusRequest: 3 }));
    expect(document.activeElement).toBe(query());
  });

  it("restores the scroll once, after the reread list is final", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const pages = [item(1), item(2)];
    const { update } = fixture(full({ phase: "loading", items: pages, nextCursor: null, restoreReady: false, pagesLoaded: 2 }),
      { restoreScroll: 240 });
    expect(scroll).not.toHaveBeenCalled();
    update({ state: full({ items: pages, pagesLoaded: 2 }) });
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 240);
    update({ state: full({ items: pages, pagesLoaded: 2, loadingMore: true }) });
    update({ state: full({ items: [...pages, item(3)], pagesLoaded: 3 }) });
    update({ state: full({ phase: "loading", items: [...pages, item(3)], nextCursor: null, restoreReady: false, pagesLoaded: 3 }) });
    update({ state: full({ items: [...pages, item(3)], pagesLoaded: 3 }) });
    expect(scroll).toHaveBeenCalledTimes(1);
    // The next return from a card is a new restoration, even to the same place.
    update({ restoreScroll: null });
    update({ restoreScroll: 240 });
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll).toHaveBeenLastCalledWith(0, 240);
  });

  it("waits for a visible list and drops the restore when the search changes first", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const props: DictionarySearchScreenProps = { state: full(), language: "ru", restoreScroll: 120, onOpenCard: vi.fn(), onNavigate: vi.fn(),
      actions: { setQuery: vi.fn(), setMaterial: vi.fn(), submit: vi.fn(), loadMore: vi.fn(), retry: vi.fn() }, ...noHistory() };
    const view = render(<div hidden><DictionarySearchScreen {...props} /></div>);
    expect(scroll).not.toHaveBeenCalled();
    view.rerender(<div><DictionarySearchScreen {...props} /></div>);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 120);
    cleanup();

    const failed = fixture(snapshot({ phase: "failed", query: "Haus", mode: "full", problem: "load", restoreReady: false }), { restoreScroll: 300 });
    failed.update({ state: full({ phase: "loading", nextCursor: null, restoreReady: false, items: [] }) });
    failed.update({ state: full() });
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(scroll).toHaveBeenLastCalledWith(0, 300);
    cleanup();

    const changed = fixture(full({ phase: "loading", nextCursor: null, restoreReady: false }), { restoreScroll: 500 });
    changed.update({ state: snapshot({ phase: "loading", query: "Hand", restoreReady: false }) });
    changed.update({ state: ready({ query: "Hand" }) });
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it("Q2: an empty final result spends the return's restore, so a later list never jumps to it", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { update } = fixture(full({ phase: "loading", items: [], nextCursor: null, restoreReady: false }), { restoreScroll: 700 });
    update({ state: full({ items: [], nextCursor: null }) });
    expect(screen.getByRole("status").textContent).toBe("Нет совпадений");
    // A later foreground rereads the same search and finds rows: the old return is over.
    update({ state: full({ phase: "loading", items: [], nextCursor: null, restoreReady: false }) });
    update({ state: full({ items: [item(1), item(2)], pagesLoaded: 1 }) });
    expect(within(results()).getAllByRole("listitem")).toHaveLength(2);
    expect(scroll).not.toHaveBeenCalled();
    // A new return re-arms the restore, even to the same place.
    update({ restoreScroll: null });
    update({ restoreScroll: 700 });
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 700);
  });

  it("Q2: a failed reread does not spend the restore", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const { update } = fixture(snapshot({ phase: "failed", query: "Haus", mode: "full", problem: "load", restoreReady: false }),
      { restoreScroll: 700 });
    update({ state: snapshot({ phase: "disposed", query: "Haus", mode: "full", restoreReady: false }) });
    update({ state: full({ phase: "loading", items: [], nextCursor: null, restoreReady: false }) });
    expect(scroll).not.toHaveBeenCalled();
    update({ state: full({ items: [item(1), item(2)] }) });
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 700);
  });

  it("Q2: nothing is spent while the screen is hidden; the visible final result decides", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const props: DictionarySearchScreenProps = { state: full({ items: [], nextCursor: null }), language: "ru", restoreScroll: 700,
      onOpenCard: vi.fn(), onNavigate: vi.fn(),
      actions: { setQuery: vi.fn(), setMaterial: vi.fn(), submit: vi.fn(), loadMore: vi.fn(), retry: vi.fn() }, ...noHistory() };
    const view = render(<div hidden><DictionarySearchScreen {...props} /></div>);
    view.rerender(<div hidden><DictionarySearchScreen {...props} state={full({ phase: "loading", items: [], nextCursor: null, restoreReady: false })} /></div>);
    expect(scroll).not.toHaveBeenCalled();
    view.rerender(<div><DictionarySearchScreen {...props} state={full({ items: [item(1), item(2)] })} /></div>);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 700);
    cleanup();

    // Hidden empty, then a visible empty final: spent there, a later list does not scroll.
    const hidden = render(<div hidden><DictionarySearchScreen {...props} /></div>);
    hidden.rerender(<div><DictionarySearchScreen {...props} /></div>);
    hidden.rerender(<div><DictionarySearchScreen {...props} state={full({ items: [item(1), item(2)] })} /></div>);
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("Q2: StrictMode keeps one scroll for a list and none after an empty final result", () => {
    const scroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const props: DictionarySearchScreenProps = { state: full(), language: "ru", restoreScroll: 300, onOpenCard: vi.fn(), onNavigate: vi.fn(),
      actions: { setQuery: vi.fn(), setMaterial: vi.fn(), submit: vi.fn(), loadMore: vi.fn(), retry: vi.fn() }, ...noHistory() };
    const view = render(<StrictMode><DictionarySearchScreen {...props} /></StrictMode>);
    view.rerender(<StrictMode><DictionarySearchScreen {...props} state={full({ loadingMore: true })} /></StrictMode>);
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 300);
    cleanup();

    const empty = render(<StrictMode><DictionarySearchScreen {...props} state={full({ items: [], nextCursor: null })} /></StrictMode>);
    empty.rerender(<StrictMode><DictionarySearchScreen {...props} state={full({ items: [item(1), item(2)] })} /></StrictMode>);
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
