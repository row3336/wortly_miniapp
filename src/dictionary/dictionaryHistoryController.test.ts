import { describe, expect, it, vi } from "vitest";
import type { DictionaryCardContent, DictionaryCardResponse, DictionaryHistoryResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { DictionaryHistoryController, type DictionaryHistoryIo } from "./dictionaryHistoryController";

type Pair = "ru-de" | "uk-de" | "en-de";
// Hex letters in every ID: a case-insensitive comparison is exercised, not just assumed (Р2-5).
const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (n: number) => `2026-10-06T10:${String(59 - n).padStart(2, "0")}:00Z`;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function content(n: number, pair: Pair = "ru-de"): DictionaryCardContent {
  return { pair, card: { id: id(n), revision: "1", lemma: `Wort${n}`, type: "noun", cefr: "A1" },
    translations: { common: [`слово${n}`], personal: null }, grammar: null, reference_conjugations: [],
    examples: { common: [], personal: null }, association: null };
}
const list = (cards: number[], version = "1"): DictionaryHistoryResponse =>
  ({ state_version: version, items: cards.map((n, index) => ({ card_id: id(n), opened_at: at(index) })) });

/** A model server: the history and the cards are answered at once unless a test holds them. */
function harness() {
  const server = { history: [1, 2, 3], version: "1", pair: "ru-de" as Pair, unavailable: new Set<number>(),
    /** Per-card state version and common translation, where a test sets them. */
    versions: new Map<number, string>(), texts: new Map<number, string>() };
  const held: Array<{ resolve(value?: DictionaryHistoryResponse): void; reject(error: unknown): void }> = [];
  let hold = false, alive = true;
  const historyReads = vi.fn<(current: () => boolean) => Promise<DictionaryHistoryResponse>>(async () => {
    const snapshot = list(server.history, server.version);
    if (!hold) return snapshot;
    const gate = deferred<DictionaryHistoryResponse | undefined>();
    held.push({ resolve: value => gate.resolve(value), reject: error => gate.reject(error) });
    return (await gate.promise) ?? snapshot;
  });
  const cardReads = vi.fn<(cardId: string, current: () => boolean) => Promise<DictionaryCardResponse>>(async cardId => {
    const n = Number(cardId.slice(-12));
    const text = content(n, server.pair);
    if (server.texts.has(n)) text.translations.common = [server.texts.get(n)!];
    return { state_version: server.versions.get(n) ?? server.version, current: server.unavailable.has(n) ? { status: "unavailable" } : text };
  });
  const makeIo = (): DictionaryHistoryIo => ({ live: () => alive, history: historyReads, card: cardReads });
  const controller = new DictionaryHistoryController();
  const listener = vi.fn();
  controller.attach(listener);
  const scope = {};
  let access = {}, io: DictionaryHistoryIo | null = makeIo(), pair: Pair = "ru-de", floor = "1";
  const commit = () => controller.commit({ access, pair, scope, floor, io });
  return {
    server, held, historyReads, cardReads, controller, listener, commit,
    view: () => controller.view({ access, pair, open: true }),
    lemmas: () => controller.view({ access, pair, open: true }).items.map(item => item.lemma),
    hold(on: boolean) { hold = on; },
    newAccess(next: { pair?: Pair; floor?: string } = {}) { access = {}; pair = next.pair ?? pair; floor = next.floor ?? floor; },
    disable() { io = null; },
    enable() { io = makeIo(); },
    kill() { alive = false; },
  };
}

describe("dictionary history controller", () => {
  it("K07-094/K07-095: the first commit reads the list and the text of every card, in server order", async () => {
    const h = harness();
    h.commit();
    expect(h.view()).toEqual({ phase: "loading", items: [], pair: null, problem: null });
    await flush();
    expect(h.historyReads).toHaveBeenCalledOnce();
    expect(h.cardReads.mock.calls.map(call => call[0])).toEqual([id(1), id(2), id(3)]);
    expect(h.view()).toEqual({ phase: "ready", pair: "ru-de", problem: null, items: [1, 2, 3].map((n, index) => ({
      card_id: id(n), opened_at: at(index), lemma: `Wort${n}`, type: "noun", cefr: "A1",
      translation: { common: [`слово${n}`], personal: null } })) });
    // Another render of the same access reads nothing.
    h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledOnce();
  });

  it("an empty history is ready and empty, not loading or failed", async () => {
    const h = harness(); h.server.history = [];
    h.commit(); await flush();
    expect(h.view()).toEqual({ phase: "ready", items: [], pair: "ru-de", problem: null });
    expect(h.cardReads).not.toHaveBeenCalled();
  });

  it("K07-094: the server's 20 entries are shown as sent; a 21st entry is a broken reply, not a longer list", async () => {
    const h = harness();
    h.server.history = Array.from({ length: 20 }, (_, n) => 20 - n);
    h.commit(); await flush();
    expect(h.lemmas()).toEqual(Array.from({ length: 20 }, (_, n) => `Wort${20 - n}`));
    h.server.history = Array.from({ length: 21 }, (_, n) => n + 1);
    h.controller.refresh(); h.commit(); await flush();
    expect(h.view()).toEqual({ phase: "failed", items: [], pair: null, problem: "load" });
  });

  it("TA §7: a late reply of an earlier read never replaces the current one", async () => {
    const h = harness();
    h.hold(true);
    h.commit(); await flush();
    h.server.history = [7, 1];
    h.controller.refresh(); h.commit(); await flush();
    expect(h.held).toHaveLength(2);
    h.held[1].resolve(); await flush();
    expect(h.lemmas()).toEqual(["Wort7", "Wort1"]);
    h.held[0].resolve(list([3, 2, 1])); await flush();
    expect(h.lemmas()).toEqual(["Wort7", "Wort1"]);
    expect(h.view().phase).toBe("ready");
  });

  it("a refresh keeps the shown list until the new one replaces it at once", async () => {
    const h = harness();
    h.commit(); await flush();
    h.hold(true); h.server.history = [3];
    h.controller.refresh();
    expect(h.view()).toMatchObject({ phase: "loading", items: [{ lemma: "Wort1" }, { lemma: "Wort2" }, { lemma: "Wort3" }] });
    h.commit(); await flush();
    expect(h.view().items).toHaveLength(3);
    h.held[0].resolve(); await flush();
    expect(h.lemmas()).toEqual(["Wort3"]);
  });

  it("K11-013: a new access (foreground) rereads; a refresh and an access change of one commit read once", async () => {
    const h = harness();
    h.commit(); await flush();
    h.server.history = [2, 1, 3];
    h.newAccess();
    expect(h.view().phase).toBe("loading");
    h.controller.refresh();
    h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledTimes(2);
    expect(h.lemmas()).toEqual(["Wort2", "Wort1", "Wort3"]);
  });

  it("while reads are not allowed the refresh waits and is sent once when they are", async () => {
    const h = harness();
    h.disable();
    h.commit(); h.controller.refresh(); h.commit(); await flush();
    expect(h.historyReads).not.toHaveBeenCalled();
    h.enable(); h.commit(); h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledOnce();
    expect(h.view().phase).toBe("ready");
  });

  it("disabling makes the read in flight inert; it is sent again once enabled", async () => {
    const h = harness();
    h.hold(true);
    h.commit(); await flush();
    h.disable(); h.commit();
    h.held[0].resolve(); await flush();
    expect(h.view().phase).toBe("loading");
    h.hold(false); h.enable(); h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledTimes(2);
    expect(h.view().phase).toBe("ready");
  });

  it("a failed card read fails the whole list; retry repeats it and only retry does", async () => {
    const h = harness();
    h.cardReads.mockRejectedValueOnce(new ApiError("network"));
    h.commit(); await flush();
    expect(h.view()).toEqual({ phase: "failed", items: [], pair: null, problem: "load" });
    h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledOnce();
    h.controller.retry(); h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledTimes(2);
    expect(h.lemmas()).toEqual(["Wort1", "Wort2", "Wort3"]);
    h.controller.retry(); h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledTimes(2);
  });

  it("В1 (root decision): card texts are cached per access; a refresh reads only new cards, a new access reads all again", async () => {
    const h = harness(); h.server.unavailable.add(2);
    h.commit(); await flush();
    expect(h.cardReads).toHaveBeenCalledTimes(3);
    h.server.history = [4, 3, 2, 1];
    h.controller.refresh(); h.commit(); await flush();
    expect(h.cardReads.mock.calls.slice(3).map(call => call[0])).toEqual([id(4)]);
    expect(h.lemmas()).toEqual(["Wort4", "Wort3", "Wort1"]);
    h.controller.refresh(); h.commit(); await flush();
    expect(h.cardReads).toHaveBeenCalledTimes(4);
    h.newAccess(); h.commit(); await flush();
    expect(h.cardReads.mock.calls.slice(4).map(call => call[0])).toEqual([id(4), id(3), id(2), id(1)]);
  });

  it("В1: texts of a failed read are not cached; the retry reads them again", async () => {
    const h = harness();
    h.cardReads.mockRejectedValueOnce(new ApiError("network"));
    h.commit(); await flush();
    expect(h.view().phase).toBe("failed");
    h.controller.retry(); h.commit(); await flush();
    expect(h.cardReads).toHaveBeenCalledTimes(6);
    expect(h.lemmas()).toEqual(["Wort1", "Wort2", "Wort3"]);
  });

  it("Н2: parallel card reads answered at different versions above the floor give a ready list; the floor becomes the highest", async () => {
    const h = harness();
    h.server.versions.set(1, "3"); h.server.versions.set(2, "2");
    h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "ready" });
    expect(h.lemmas()).toEqual(["Wort1", "Wort2", "Wort3"]);
    // The next read starts from version 3: a list answered at version 2 is stale.
    h.server.version = "2"; h.server.history = [4];
    h.controller.refresh(); h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "failed", problem: "stale_response" });
  });

  it("Н1 (root decision): forget(card) rereads only that card's text, forget() every text", async () => {
    const h = harness();
    h.commit(); await flush();
    h.server.texts.set(2, "новое"); h.server.texts.set(3, "тоже новое");
    h.controller.forget(id(2).toUpperCase()); h.controller.refresh(); h.commit(); await flush();
    expect(h.cardReads.mock.calls.slice(3).map(call => call[0])).toEqual([id(2)]);
    expect(h.view().items.map(item => item.translation.common[0])).toEqual(["слово1", "новое", "слово3"]);
    h.controller.forget(); h.controller.refresh(); h.commit(); await flush();
    expect(h.cardReads.mock.calls.slice(4).map(call => call[0])).toEqual([id(1), id(2), id(3)]);
    expect(h.view().items.map(item => item.translation.common[0])).toEqual(["слово1", "новое", "тоже новое"]);
  });

  it("Н1: texts of a read in flight never return to the cache after forget()", async () => {
    const h = harness();
    h.hold(true);
    h.commit(); await flush();
    h.controller.forget();
    h.held[0].resolve(); await flush();
    expect(h.view().phase).toBe("ready");
    h.hold(false);
    h.controller.refresh(); h.commit(); await flush();
    expect(h.cardReads).toHaveBeenCalledTimes(6);
  });

  it("В2: a card that is no longer available is left out of the shown list", async () => {
    const h = harness(); h.server.unavailable.add(2);
    h.commit(); await flush();
    expect(h.lemmas()).toEqual(["Wort1", "Wort3"]);
  });

  it("a list or card below the floor is stale; card texts of another pair are pair_changed", async () => {
    const h = harness();
    h.newAccess({ floor: "5" });
    h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "failed", problem: "stale_response", items: [] });
    h.server.version = "6"; h.server.pair = "uk-de";
    h.controller.retry(); h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "failed", problem: "pair_changed", items: [] });
  });

  it("a new access of another pair hides the old texts in the same render", async () => {
    const h = harness();
    h.commit(); await flush();
    h.newAccess({ pair: "uk-de" });
    expect(h.view()).toEqual({ phase: "loading", items: [], pair: null, problem: null });
    h.server.pair = "uk-de";
    h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "ready", pair: "uk-de" });
  });

  it("an io that is no longer live and a detached controller publish nothing", async () => {
    const h = harness();
    h.hold(true);
    h.commit(); await flush();
    h.kill();
    h.held[0].resolve(); await flush();
    expect(h.view().phase).toBe("loading");
    const calls = h.listener.mock.calls.length;
    h.controller.detach();
    h.controller.refresh();
    expect(h.listener).toHaveBeenCalledTimes(calls);
  });

  it("snapshots are detached copies and a disposed view shows nothing", async () => {
    const h = harness();
    h.commit(); await flush();
    const first = h.view();
    first.items[0].lemma = "changed";
    expect(h.view().items[0].lemma).toBe("Wort1");
    expect(h.controller.view({ access: {}, pair: "ru-de", open: false })).toEqual({ phase: "disposed", items: [], pair: null, problem: null });
  });

  it("an invalid binding throws before any read", () => {
    const h = harness();
    expect(() => h.controller.commit({ access: {}, pair: "de-de" as Pair, scope: {}, floor: "1", io: null })).toThrow();
    expect(() => h.controller.commit({ access: {}, pair: "ru-de", scope: {}, floor: "0", io: null })).toThrow();
    expect(h.historyReads).not.toHaveBeenCalled();
  });
});
