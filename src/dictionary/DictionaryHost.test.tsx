import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictionarySearchResponse, DictionarySimilarItem, OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { DICTIONARY_SEARCH_LIMITS, DictionaryHost, type DictionaryHostProps, type DictionaryVisit } from "./DictionaryHost";
import { testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Test parameters only: the product values are an open question (В3, К07-092).
const limits = { suggest: 3, page: 4 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); }
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
const card = (n: number) => ({ card_id: id(n), revision: "1", lemma: `Wort${n}`, type: "noun" as const, cefr: null,
  translation: { common: [`слово${n}`], personal: null } });

beforeEach(() => { visible("visible"); vi.spyOn(window, "scrollTo").mockImplementation(() => {}); });
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

/** Model server for search and history; a held path answers only when released. No card is read to show the history. */
function fixture() {
  const server = {
    history: [5, 6] as number[],
    /** Lemma of a card where a test changed it on the server. */
    lemmas: new Map<number, string>(),
    /** Ordinary results and similar cards per raw query; an unknown query has neither. */
    results: new Map<string, number[]>([["Haus", [1, 2]], ["Ha", [3]]]),
    similar: new Map<string, number[]>([["Haus", [11]], ["Ha", [13]], ["Hause", [12]]]),
  };
  const held = new Map<string, Array<() => void>>();
  const holds = new Set<string>();
  const sent: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBe("GET");
    const target = new URL(String(url), "https://model.invalid");
    const route = target.pathname.replace("/api/v1/dictionary/", "");
    sent.push(route === "search" ? `search:${target.searchParams.get("query")}:${target.searchParams.get("mode")}` : route);
    const key = route === "search" ? `search:${target.searchParams.get("query")}` : route;
    if (holds.has(key)) {
      holds.delete(key);
      const gate = deferred();
      held.set(key, [...held.get(key) ?? [], gate.resolve]);
      await gate.promise;
    }
    if (route === "history") {
      return json({ state_version: "1", pair: "ru-de", items: server.history.map((n, k) => ({ card_id: id(n),
        opened_at: `2026-10-06T10:0${k}:00Z`, lemma: server.lemmas.get(n) ?? `Karte${n}`, type: "noun", cefr: "A2" })) });
    }
    if (route !== "search") throw new Error(`unexpected read ${route}`);
    const query = target.searchParams.get("query")!, mode = target.searchParams.get("mode") as "words" | "phrases";
    const type = mode === "phrases" ? "phrase" as const : "noun" as const;
    const similar: DictionarySimilarItem[] = (server.similar.get(query) ?? []).map(n => ({ ...card(n), type }));
    const body: DictionarySearchResponse = { state_version: "1", query, pair: "ru-de", mode, next_cursor: null, similar,
      items: (server.results.get(query) ?? []).map(n => ({ ...card(n), type, match_kind: "prefix" as const })) };
    return json(body);
  });
  const live = new Set<OpenedAccess>();
  const opened: OpenedClient = { status: "opened", client_instance_id: id(901), document_id: id(902), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(903), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "1",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  /** The same document again, as the application foreground hands it over: a new object with the same key. */
  const access = () => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened, token: "synthetic-dictionary-token", proof: "synthetic-proof", generation: 1,
      isLive: () => live.has(bound), onDenied: () => live.delete(bound) });
    live.clear(); live.add(bound);
    return bound;
  };
  const props: DictionaryHostProps = { access: access(), transport: { fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() },
    language: "ru", limits, visit: { kind: "entry" }, onOpenCard: vi.fn(), onNavigate: vi.fn() };
  const release = (key: string) => act(async () => { held.get(key)?.shift()?.(); });
  return { server, sent, fetcher, access, props, hold: (key: string) => holds.add(key), release };
}

function mount(f: ReturnType<typeof fixture>, rest: Partial<DictionaryHostProps> = {}) {
  Object.assign(f.props, rest);
  const view = render(<DictionaryHost {...f.props} />);
  const update = async (next: Partial<DictionaryHostProps>) => {
    Object.assign(f.props, next);
    view.rerender(<DictionaryHost {...f.props} />);
    await flush();
  };
  return { view, update };
}
const field = () => screen.getByRole("textbox", { name: "Поиск" }) as HTMLInputElement;
const phrases = () => screen.getByRole("switch", { name: "Фразы" }) as HTMLInputElement;
const region = (name: string) => screen.getByRole("region", { name });
const lemmas = (name: string) => within(region(name)).queryAllByRole("button").map(row => row.querySelector("[lang='de']")!.textContent);
const type = (text: string) => act(() => { fireEvent.change(field(), { target: { value: text } }); });

describe("DictionaryHost (М11) with real access, APIs, controllers and hooks", () => {
  it("K07-097/K07-100/K07-094: an entry focuses the empty words search and shows the account history in server order", async () => {
    const f = fixture();
    mount(f); await flush();
    expect(field().value).toBe("");
    expect(document.activeElement).toBe(field());
    expect(phrases().checked).toBe(false);
    // P19: one request gives every row.
    expect(f.sent).toEqual(["history"]);
    expect(lemmas("История")).toEqual(["Karte5", "Karte6"]);
    // P18: German word, type and level; no translation.
    expect(within(region("История")).getAllByRole("button").map(row => row.textContent))
      .toEqual(["Karte5СуществительноеA2", "Karte6СуществительноеA2"]);
    expect(region("История").querySelector(".dictionary-search-translation")).toBeNull();
  });

  it("K07-095: a history entry opens its card at once with the return address", async () => {
    const f = fixture();
    mount(f); await flush();
    fireEvent.click(within(region("История")).getAllByRole("button")[1]);
    expect(f.props.onOpenCard).toHaveBeenCalledExactlyOnceWith(id(6), { search: { query: "", mode: "words" }, scroll: 0 });
  });

  it("RA 6.1.14: an empty history and a failed history are told apart; retry rereads it", async () => {
    const f = fixture(); f.server.history = [];
    const ui = mount(f); await flush();
    expect(within(region("История")).getByRole("status").textContent).toBe("История пуста");
    f.fetcher.mockResolvedValueOnce(json({ error: { code: "UNAVAILABLE" } }, 503));
    f.server.history = [5];
    await ui.update({ visit: null });
    await ui.update({ visit: { kind: "entry" } });
    expect(within(region("История")).getByRole("alert").textContent).toBe("Не удалось загрузить историюПовторить");
    fireEvent.click(within(region("История")).getByRole("button", { name: "Повторить" }));
    await flush();
    expect(lemmas("История")).toEqual(["Karte5"]);
  });

  it("K07-091: similar cards are shown apart from the results, and the query is not replaced", async () => {
    const f = fixture();
    mount(f); await flush();
    await type("Haus"); await flush();
    expect(lemmas("Результаты")).toEqual(["Wort1", "Wort2"]);
    expect(lemmas("Похожие")).toEqual(["Wort11"]);
    expect(field().value).toBe("Haus");
    expect(screen.queryByRole("region", { name: "История" })).toBeNull();
    fireEvent.click(within(region("Похожие")).getByRole("button"));
    expect(f.props.onOpenCard).toHaveBeenCalledExactlyOnceWith(id(11), { search: { query: "Haus", mode: "words" }, scroll: 0 });
  });

  it("K07-091/RA 6.1.14: no ordinary match still shows the similar cards beside «Нет совпадений»", async () => {
    const f = fixture();
    mount(f); await flush();
    await type("Hause"); await flush();
    expect(within(region("Результаты")).getByRole("status").textContent).toBe("Нет совпадений");
    expect(lemmas("Похожие")).toEqual(["Wort12"]);
  });

  it("TA §7: a late reply of another query replaces neither the results nor the similar cards", async () => {
    const f = fixture();
    mount(f); await flush();
    f.hold("search:Ha");
    await type("Ha"); await flush();
    await type("Haus"); await flush();
    expect(lemmas("Результаты")).toEqual(["Wort1", "Wort2"]);
    await f.release("search:Ha"); await flush();
    expect(lemmas("Результаты")).toEqual(["Wort1", "Wort2"]);
    expect(lemmas("Похожие")).toEqual(["Wort11"]);
    expect(f.sent.filter(sent => sent.startsWith("search:"))).toEqual(["search:Ha:words", "search:Haus:words"]);
  });

  it("TA §7: a late reply of the other mode does not replace the current one", async () => {
    const f = fixture();
    mount(f); await flush();
    await type("Haus"); await flush();
    f.hold("search:Haus");
    act(() => { fireEvent.click(phrases()); }); await flush();
    act(() => { fireEvent.click(phrases()); }); await flush();
    expect(lemmas("Результаты")).toEqual(["Wort1", "Wort2"]);
    await f.release("search:Haus"); await flush();
    expect(phrases().checked).toBe(false);
    // The held phrases page would carry «Фраза» rows; the words page stays.
    expect(within(region("Результаты")).getAllByRole("button").map(row => row.textContent))
      .toEqual(["Wort1Существительноеслово1", "Wort2Существительноеслово2"]);
    expect(f.sent.filter(sent => sent.startsWith("search:"))).toEqual(["search:Haus:words", "search:Haus:phrases", "search:Haus:words"]);
  });

  it("K07-096: a return from a card keeps query, mode and results, restores the scroll and rereads only the history", async () => {
    const f = fixture();
    const ui = mount(f); await flush();
    await type("Haus"); await flush();
    act(() => { fireEvent.click(phrases()); }); await flush();
    fireEvent.click(within(region("Результаты")).getAllByRole("button")[0]);
    const before = f.sent.length;
    await ui.update({ visit: null });
    expect(f.sent.length).toBe(before);
    f.server.history = [9, 5, 6];
    await ui.update({ visit: { kind: "return", scroll: 240 } });
    expect(field().value).toBe("Haus");
    expect(phrases().checked).toBe(true);
    expect(lemmas("Результаты")).toEqual(["Wort1", "Wort2"]);
    expect(f.sent.slice(before)).toEqual(["history"]);
    await ui.update({ visit: null });
    await ui.update({ visit: { kind: "return", scroll: 240 } });
    expect(lemmas("Результаты")).toEqual(["Wort1", "Wort2"]);
    expect(window.scrollTo).toHaveBeenCalledTimes(2);
    expect(window.scrollTo).toHaveBeenLastCalledWith(0, 240);
  });

  it("P19: a return and an entry each reread the list once; a row changed on the server shows at once", async () => {
    const f = fixture();
    const ui = mount(f); await flush();
    fireEvent.click(within(region("История")).getAllByRole("button")[1]);
    await ui.update({ visit: null });
    f.server.lemmas.set(6, "Karte6 neu"); f.server.history = [6, 5];
    const before = f.sent.length;
    await ui.update({ visit: { kind: "return", scroll: null } });
    expect(f.sent.slice(before)).toEqual(["history"]);
    expect(lemmas("История")).toEqual(["Karte6 neu", "Karte5"]);
    await ui.update({ visit: null });
    f.server.lemmas.set(5, "Karte5 neu");
    await ui.update({ visit: { kind: "entry" } });
    expect(f.sent.slice(before + 1)).toEqual(["history"]);
    expect(lemmas("История")).toEqual(["Karte6 neu", "Karte5 neu"]);
  });

  it("P20: rows the server left out are absent without a message; the next showing brings them back", async () => {
    const f = fixture(); f.server.history = [5];
    const ui = mount(f); await flush();
    expect(lemmas("История")).toEqual(["Karte5"]);
    expect(within(region("История")).queryByRole("alert")).toBeNull();
    expect(within(region("История")).queryByRole("status")).toBeNull();
    f.server.history = [5, 6];
    await ui.update({ visit: null });
    await ui.update({ visit: { kind: "return", scroll: null } });
    expect(lemmas("История")).toEqual(["Karte5", "Karte6"]);
  });

  it("K07-100/Т33: a new entry from another section clears the query and the phrase mode", async () => {
    const f = fixture();
    const ui = mount(f); await flush();
    await type("Haus"); await flush();
    act(() => { fireEvent.click(phrases()); }); await flush();
    await ui.update({ visit: null });
    await ui.update({ visit: { kind: "entry" } });
    expect(field().value).toBe("");
    expect(phrases().checked).toBe(false);
    expect(document.activeElement).toBe(field());
    expect(screen.queryByRole("region", { name: "Похожие" })).toBeNull();
    expect(lemmas("История")).toEqual(["Karte5", "Karte6"]);
  });

  it("the same visit object again is not a new entry: the query stays and nothing is reread", async () => {
    const f = fixture();
    const visit: DictionaryVisit = { kind: "entry" };
    const ui = mount(f, { visit }); await flush();
    await type("Haus"); await flush();
    const before = f.sent.length;
    await ui.update({ visit });
    expect(field().value).toBe("Haus");
    expect(f.sent.length).toBe(before);
  });

  it("K11-013/K11-015: the application foreground rereads search and history without touching the typed query", async () => {
    const f = fixture();
    const ui = mount(f); await flush();
    await type("Haus"); await flush();
    const before = f.sent.length;
    act(() => { visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { visible("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(f.sent.length).toBe(before);
    f.server.results.set("Haus", [2]);
    await ui.update({ access: f.access() });
    expect(field().value).toBe("Haus");
    expect(f.sent.slice(before).sort()).toEqual(["history", "search:Haus:words"].sort());
    expect(lemmas("Результаты")).toEqual(["Wort2"]);
  });

  it("Р2-1: a hidden dictionary with a typed query rereads nothing for a new access; showing it again does", async () => {
    const f = fixture();
    const ui = mount(f); await flush();
    await type("Haus"); await flush();
    await ui.update({ visit: null });
    const before = f.sent.length;
    await ui.update({ access: f.access() });
    expect(f.sent.length).toBe(before);
    expect((screen.getByRole("textbox", { name: "Поиск", hidden: true }) as HTMLInputElement).value).toBe("Haus");
    await ui.update({ visit: { kind: "return", scroll: null } });
    expect(f.sent.slice(before)).toContain("search:Haus:words");
    expect(f.sent.slice(before)).toContain("history");
  });

  it("Р2-2: a card opened in phrases mode hands over the phrases mode with the query", async () => {
    const f = fixture();
    mount(f); await flush();
    act(() => { fireEvent.click(phrases()); }); await flush();
    await type("Haus"); await flush();
    fireEvent.click(within(region("Результаты")).getAllByRole("button")[1]);
    expect(f.props.onOpenCard).toHaveBeenCalledExactlyOnceWith(id(2), { search: { query: "Haus", mode: "phrases" }, scroll: 0 });
  });

  it("a hidden host sends nothing, and the panel opens the other sections", async () => {
    const f = fixture();
    mount(f, { visit: null }); await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    const nav = screen.getByRole("navigation", { hidden: true });
    fireEvent.click(within(nav).getByRole("button", { name: "Настройки", hidden: true }));
    expect(f.props.onNavigate).toHaveBeenCalledExactlyOnceWith("settings");
  });

  it("В3 (root decision): the application limits are five suggestions and twenty results per page", async () => {
    expect(DICTIONARY_SEARCH_LIMITS).toEqual({ suggest: 5, page: 20 });
    const f = fixture();
    mount(f, { limits: undefined }); await flush();
    await type("Haus"); await flush();
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Найти" })); }); await flush();
    const limitsSent = f.fetcher.mock.calls.map(call => new URL(String(call[0]), "https://model.invalid"))
      .filter(url => url.pathname.endsWith("/search")).map(url => url.searchParams.get("limit"));
    expect(limitsSent).toEqual(["5", "20"]);
  });

  it("suggestions use the host's limit", async () => {
    const f = fixture();
    mount(f); await flush();
    await type("Haus"); await flush();
    const search = f.fetcher.mock.calls.map(call => new URL(String(call[0]), "https://model.invalid"))
      .find(url => url.pathname.endsWith("/search"))!;
    expect(search.searchParams.get("limit")).toBe(String(limits.suggest));
  });
});
