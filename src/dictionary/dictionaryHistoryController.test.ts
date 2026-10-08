import { describe, expect, it, vi } from "vitest";
import type { DictionaryHistoryResponse } from "../api/generated";
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
const row = (n: number, index: number) => ({ card_id: id(n), opened_at: at(index), lemma: `Wort${n}`, type: "noun" as const, cefr: "A1" as const });
const list = (cards: number[], version = "1", pair: Pair = "ru-de"): DictionaryHistoryResponse =>
  ({ state_version: version, pair, items: cards.map(row) });

/** A model server: the history is answered at once unless a test holds it. */
function harness() {
  const server = { history: [1, 2, 3], version: "1", pair: "ru-de" as Pair };
  const held: Array<{ resolve(value?: DictionaryHistoryResponse): void; reject(error: unknown): void }> = [];
  let hold = false, alive = true;
  const historyReads = vi.fn<(current: () => boolean) => Promise<DictionaryHistoryResponse>>(async () => {
    const snapshot = list(server.history, server.version, server.pair);
    if (!hold) return snapshot;
    const gate = deferred<DictionaryHistoryResponse | undefined>();
    held.push({ resolve: value => gate.resolve(value), reject: error => gate.reject(error) });
    return (await gate.promise) ?? snapshot;
  });
  const makeIo = (): DictionaryHistoryIo => ({ live: () => alive, history: historyReads });
  const controller = new DictionaryHistoryController();
  const listener = vi.fn();
  controller.attach(listener);
  const scope = {};
  let access = {}, io: DictionaryHistoryIo | null = makeIo(), pair: Pair = "ru-de", floor = "1";
  const commit = () => controller.commit({ access, pair, scope, floor, io });
  return {
    server, held, historyReads, controller, listener, commit,
    view: () => controller.view({ access, pair, open: true }),
    lemmas: () => controller.view({ access, pair, open: true }).items.map(item => item.lemma),
    hold(on: boolean) { hold = on; },
    newAccess(next: { pair?: Pair; floor?: string } = {}) { access = {}; pair = next.pair ?? pair; floor = next.floor ?? floor; },
    /** The same access observes a higher state version (e.g. an own command elsewhere). */
    raiseFloor(next: string) { floor = next; },
    disable() { io = null; },
    enable() { io = makeIo(); },
    kill() { alive = false; },
  };
}

describe("dictionary history controller", () => {
  it("K07-094/P19: the first commit reads the list once and shows its rows in server order", async () => {
    const h = harness();
    h.commit();
    expect(h.view()).toEqual({ phase: "loading", items: [], pair: null, problem: null });
    await flush();
    expect(h.historyReads).toHaveBeenCalledOnce();
    expect(h.view()).toEqual({ phase: "ready", pair: "ru-de", problem: null, items: [1, 2, 3].map(row) });
    // Another render of the same access reads nothing.
    h.commit(); await flush();
    expect(h.historyReads).toHaveBeenCalledOnce();
  });

  it("an empty history is ready and empty, not loading or failed", async () => {
    const h = harness(); h.server.history = [];
    h.commit(); await flush();
    expect(h.view()).toEqual({ phase: "ready", items: [], pair: "ru-de", problem: null });
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

  it("a failed list read fails the whole list (an ordinary error); retry repeats it and only retry does", async () => {
    const h = harness();
    h.historyReads.mockRejectedValueOnce(new ApiError("network"));
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

  it("P20/Ya14: rows the server left out are just absent; the list is ready with no problem, and returns when sent again", async () => {
    const h = harness();
    h.server.history = [1, 3];
    h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "ready", problem: null });
    expect(h.lemmas()).toEqual(["Wort1", "Wort3"]);
    h.server.history = [1, 2, 3];
    h.controller.refresh(); h.commit(); await flush();
    expect(h.lemmas()).toEqual(["Wort1", "Wort2", "Wort3"]);
  });

  it("a list above the floor raises it; the next list below it is stale", async () => {
    const h = harness();
    h.server.version = "3";
    h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "ready" });
    h.server.version = "2"; h.server.history = [4];
    h.controller.refresh(); h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "failed", problem: "stale_response" });
  });

  it("a floor raised while the list is on its way stays: the late list is shown, the next one below the raised floor is stale", async () => {
    const h = harness();
    h.hold(true); h.server.version = "3";
    h.commit(); await flush();
    h.raiseFloor("5"); h.commit(); await flush();
    h.held[0].resolve(); await flush();
    // Accepted against the floor the read started from (1).
    expect(h.view()).toMatchObject({ phase: "ready" });
    h.hold(false); h.server.version = "4";
    h.controller.refresh(); h.commit(); await flush();
    expect(h.view()).toMatchObject({ phase: "failed", problem: "stale_response" });
  });

  it("a list below the floor is stale; a list filtered for another pair is pair_changed", async () => {
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
