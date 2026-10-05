import { describe, expect, it, vi } from "vitest";
import type { DictionarySearchResponse } from "../api/generated";
import { ApiError } from "../api/http";
import {
  DictionarySearchController, searchLimits, type DictionarySearchCommit, type DictionarySearchIo, type DictionarySearchObserved,
} from "./dictionarySearchController";
import { createDictionarySearchApi, type SearchMaterial, type SearchRequest } from "./searchApi";

type Pair = "ru-de" | "uk-de" | "en-de";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Test parameters only: S1 has no product value for either limit.
const limits = { suggest: 3, page: 2 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const lemmas = (items: DictionarySearchResponse["items"]) => items.map(item => item.lemma);
const range = (query: string, from: number, to: number, version = "1") =>
  Array.from({ length: to - from }, (_, k) => `${query}#${from + k}@${version}`);

/** Real search API over a scripted fetch; the controller is never mocked. */
function harness() {
  const server = { version: "1", pair: "ru-de" as Pair, total: 10 };
  const gates: Array<Promise<void>> = [];
  let issued = 0;
  const body = (request: { query: string; mode: SearchMaterial; limit: number; offset: number; first: boolean }): DictionarySearchResponse => {
    const end = Math.min(server.total, request.offset + request.limit);
    return { state_version: server.version, query: request.query, pair: server.pair, mode: request.mode,
      items: Array.from({ length: Math.max(0, end - request.offset) }, (_, k) => ({ card_id: id(100 + request.offset + k), revision: "1",
        lemma: `${request.query}#${request.offset + k}@${server.version}`, type: request.mode === "phrases" ? "phrase" as const : "noun" as const, cefr: null,
        translation: { common: ["перевод"], personal: null }, match_kind: "exact" as const })),
      next_cursor: end < server.total ? `at_${end}_${++issued}` : null, similar: request.first ? [] : null };
  };
  const fetcher = vi.fn<typeof fetch>(async url => {
    const gate = gates.shift();
    if (gate) await gate;
    const params = new URL(String(url), "https://model.invalid").searchParams, cursor = params.get("cursor_token");
    return new Response(JSON.stringify(body({ query: params.get("query")!, mode: params.get("mode") as SearchMaterial, first: cursor === null,
      limit: Number(params.get("limit")), offset: cursor === null ? 0 : Number(cursor.split("_")[1]) })));
  });
  const api = createDictionarySearchApi({ fetcher, timeoutMs: 30000, maxResponseBytes: 100000 });
  const currents: Array<() => boolean> = [], reads: Array<Promise<unknown>> = [];
  const requests: SearchRequest[] = [], failures: unknown[] = [];
  let alive = true;
  const io = (): DictionarySearchIo => ({ live: () => alive,
    read(request, current) {
      currents.push(current);
      requests.push({ ...request });
      const failure = failures.shift();
      const reply = failure === undefined ? api.get("synthetic-token", request) : Promise.reject(failure);
      reads.push(reply.then(() => "page", () => "error"));
      return reply;
    } });
  /** Wait until read `n` has settled and the controller has handled its outcome. */
  const handled = async (n: number) => { await reads[n]; for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const controller = new DictionarySearchController(), updates = vi.fn();
  controller.attach(updates);
  const access = {}, scope = {}, first = io();
  const commit = (patch: Partial<DictionarySearchCommit> = {}) =>
    controller.commit({ access, pair: "ru-de", scope, floor: "1", limits, io: first, ...patch });
  const view = (patch: Partial<DictionarySearchObserved> = {}) => controller.view({ access, pair: "ru-de", open: true, ...patch });
  const hold = () => { const gate = deferred<void>(); gates.push(gate.promise); return gate.resolve; };
  const sent = () => fetcher.mock.calls.map(call => Object.fromEntries(new URL(String(call[0]), "https://model.invalid").searchParams));
  const settle = (phase: string) => vi.waitFor(() => expect(view().phase).toBe(phase));
  return { server, fetcher, controller, updates, currents, handled, io, commit, view, hold, sent, settle, access, first, requests,
    /** The next read fails with `error` before reaching the transport. */
    fail: (error: unknown) => { failures.push(error); },
    kill: () => { alive = false; } };
}
type Harness = ReturnType<typeof harness>;
async function full(h: Harness, pages: number) {
  h.controller.setQuery("Haus"); h.commit(); await h.settle("ready");
  h.controller.submit(); h.commit(); await h.settle("ready");
  for (let n = 2; n <= pages; n++) {
    h.controller.loadMore(); h.commit();
    await vi.waitFor(() => expect(h.view().pagesLoaded).toBe(n));
  }
  expect(h.fetcher).toHaveBeenCalledTimes(1 + pages);
}

describe("dictionary search controller", () => {
  it("actions only change state and owe a read; commit is the single place that sends", async () => {
    const h = harness();
    h.commit();
    expect(h.view()).toEqual({ phase: "idle", mode: "suggest", query: "", material: "words", pair: null, items: [], nextCursor: null,
      loadingMore: false, pagesLoaded: 0, restoreReady: true, problem: null, focusRequest: 0 });
    h.controller.setQuery("Haus");
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.view()).toMatchObject({ phase: "loading", query: "Haus", restoreReady: false });
    h.commit(); h.commit(); h.commit();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    await h.settle("ready");
    expect(h.sent()).toEqual([{ query: "Haus", mode: "words", limit: "3" }]);
    expect(lemmas(h.view().items)).toEqual(range("Haus", 0, 3));
    expect(h.updates).toHaveBeenCalled();
  });

  it("K07-100: an entry from another section clears the query, selects words and owes no read, even beside a new access", async () => {
    const h = harness();
    await full(h, 2);
    h.controller.setMaterial("phrases"); h.commit(); await h.settle("ready");
    // K07-093: the phrases mode is a separate read that returns phrases only.
    expect(h.sent().at(-1)).toMatchObject({ query: "Haus", mode: "phrases" });
    expect(h.view()).toMatchObject({ material: "phrases", pagesLoaded: 1 });
    expect(h.view().items.every(item => item.type === "phrase")).toBe(true);
    h.controller.loadMore(); h.commit(); await vi.waitFor(() => expect(h.view().pagesLoaded).toBe(2));
    expect(h.fetcher).toHaveBeenCalledTimes(5);
    h.controller.enterFromSection();
    h.commit({ access: {}, io: h.io() });
    expect(h.fetcher).toHaveBeenCalledTimes(5);
    expect(h.view()).toMatchObject({ phase: "idle", mode: "suggest", query: "", material: "words", items: [],
      nextCursor: null, pagesLoaded: 0, focusRequest: 1, problem: null });
    // Typing after the entry reads in the words mode again.
    h.controller.setQuery("Haus"); h.commit(); await h.settle("ready");
    expect(h.sent().at(-1)).toEqual({ query: "Haus", mode: "words", limit: "3" });
    // A reread started by a new access is discarded when the entry clears the query in a later commit.
    const access = {}, io = h.io();
    h.commit({ access, io });
    expect(h.fetcher).toHaveBeenCalledTimes(7);
    h.controller.enterFromSection(); h.commit({ access, io });
    // Let the abandoned read settle; its outcome must not be published.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(h.fetcher).toHaveBeenCalledTimes(7);
    expect(h.view()).toMatchObject({ phase: "idle", query: "", material: "words", items: [], focusRequest: 2 });
  });

  it("view hides another pair and withholds restore in the render before the commit; a revoked access is disposed", async () => {
    const h = harness();
    h.controller.setQuery("Haus"); h.commit(); await h.settle("ready");
    const next = {};
    expect(h.view({ access: next })).toMatchObject({ phase: "ready", restoreReady: false, pagesLoaded: 1 });
    expect(h.view({ access: next }).items).toHaveLength(3);
    expect(h.view({ access: next, pair: "en-de" })).toMatchObject({ phase: "loading", items: [], pair: null, pagesLoaded: 0, restoreReady: false });
    expect(h.view({ open: false })).toEqual({ phase: "disposed", mode: "suggest", query: "Haus", material: "words", pair: null, items: [],
      nextCursor: null, loadingMore: false, pagesLoaded: 0, restoreReady: false, problem: null, focusRequest: 0 });
    expect(h.view()).toMatchObject({ phase: "ready", restoreReady: true });
  });

  it("a disabled commit keeps the input and owes a reread of N pages, sent once reads are allowed and published at once", async () => {
    const h = harness();
    await full(h, 3);
    const old = lemmas(h.view().items);
    h.commit({ io: null });
    const next = {};
    h.server.version = "2";
    h.commit({ access: next, io: null }); h.commit({ access: next, io: null });
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    expect(h.view({ access: next })).toMatchObject({ phase: "loading", restoreReady: false, pagesLoaded: 3, query: "Haus", mode: "full" });
    const releases = [h.hold(), h.hold()];
    h.commit({ access: next, io: h.io() });
    for (const [n, release] of releases.entries()) {
      await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(5 + n));
      expect(lemmas(h.view({ access: next }).items)).toEqual(old);
      release();
    }
    await vi.waitFor(() => expect(h.view({ access: next }).restoreReady).toBe(true));
    expect(h.fetcher).toHaveBeenCalledTimes(7);
    expect(lemmas(h.view({ access: next }).items)).toEqual(range("Haus", 0, 6, "2"));
    expect(h.sent().slice(4).map(sent => sent.cursor_token ?? null)).toEqual([null, expect.any(String), expect.any(String)]);
  });

  it("a binding change or detach makes the read inert; the owed read is sent again exactly once", async () => {
    const h = harness();
    const release = h.hold();
    h.controller.setQuery("Haus"); h.commit();
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    const second = h.io();
    h.commit({ io: second });
    expect(h.currents[0]()).toBe(false);
    expect(h.fetcher).toHaveBeenCalledTimes(2);
    await h.settle("ready");
    h.server.version = "2"; release();
    await h.handled(0);
    expect(lemmas(h.view().items)).toEqual(range("Haus", 0, 3));
    const stuck = h.hold();
    h.controller.setQuery("Hause"); h.commit({ io: second });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    h.controller.detach();
    expect(h.currents[2]()).toBe(false);
    h.controller.submit(); h.commit({ io: second });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    h.controller.attach(h.updates); h.commit({ io: second });
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    await h.settle("ready");
    expect(h.sent()[3]).toEqual({ query: "Hause", mode: "words", limit: "2" });
    stuck(); await h.handled(2);
    expect(h.view()).toMatchObject({ phase: "ready", query: "Hause", mode: "full", pagesLoaded: 1 });
  });

  it("an io that is no longer live discards its page", async () => {
    const h = harness();
    const release = h.hold();
    h.controller.setQuery("Haus"); h.commit();
    h.kill(); release();
    await h.handled(0);
    expect(h.view()).toMatchObject({ phase: "loading", items: [] });
    expect(h.currents[0]()).toBe(false);
  });

  it("the floor compares as BigInt, rises with each page, is kept per scope and restarts for a new scope", async () => {
    const h = harness();
    h.commit({ floor: "9007199254740993" });
    h.server.version = "9007199254740992";
    h.controller.setQuery("Haus"); h.commit();
    await h.settle("failed");
    expect(h.view()).toMatchObject({ problem: "stale_response", items: [] });
    h.server.version = "9007199254740993";
    h.controller.retry(); h.commit();
    await h.settle("ready");
    h.server.version = "9007199254740992";
    h.commit({ access: {}, io: h.io(), floor: "1" });
    await h.settle("failed");
    expect(h.view()).toMatchObject({ problem: "stale_response" });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    h.commit({ access: {}, io: h.io(), scope: {}, floor: "1" });
    await h.settle("ready");
    expect(h.fetcher).toHaveBeenCalledTimes(4);
  });

  it("a page is revalidated as a detached copy against its own request", async () => {
    const controller = new DictionarySearchController();
    controller.attach(() => undefined);
    const forged: DictionarySearchIo = { live: () => true,
      read: async (request: SearchRequest) => ({ state_version: "1", query: `${request.query}!`, pair: "ru-de", mode: "words",
        items: [], next_cursor: null, similar: [] }) };
    controller.setQuery("Haus");
    controller.commit({ access: {}, pair: "ru-de", scope: {}, floor: "1", limits, io: forged });
    const observed = { access: {}, pair: "ru-de" as const, open: true };
    await vi.waitFor(() => expect(controller.view(observed)).toMatchObject({ phase: "failed", problem: "load", items: [] }));
  });

  it("invalid input throws before any state change or read", () => {
    const h = harness();
    h.commit();
    const before = h.view();
    expect(searchLimits({ suggest: 1, page: 9 })).toEqual({ suggest: 1, page: 9 });
    for (const value of [undefined, null, {}, { suggest: 1 }, { suggest: 1, page: 1, extra: 1 }, { suggest: 0, page: 1 }, { suggest: 1, page: 2.5 }]) {
      expect(() => searchLimits(value)).toThrow();
    }
    expect(() => h.controller.setQuery(1 as never)).toThrow();
    for (const value of ["yes", true, "word", "Phrases", undefined]) expect(() => h.controller.setMaterial(value as never)).toThrow();
    // The former keep/clear policy no longer exists: any argument is refused before a state change.
    for (const value of [{ query: "keep" }, { query: "clear" }, null, "keep"]) {
      expect(() => (h.controller.enterFromSection as (...args: unknown[]) => void).call(h.controller, value))
        .toThrow("entry from another section takes no options");
    }
    expect(() => h.commit({ floor: "0" })).toThrow();
    expect(() => h.commit({ limits: { suggest: 0, page: 1 } })).toThrow();
    expect(() => h.commit({ pair: "de-ru" as never })).toThrow();
    expect(h.view()).toEqual(before);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("a failed append keeps the shown pages: an ordinary error retries the same request, a stale cursor rereads N+1 at once", async () => {
    const h = harness();
    await full(h, 2);
    const shown = lemmas(h.view().items), cursor = h.view().nextCursor;
    h.fail(new ApiError("http", 503));
    h.controller.loadMore(); h.commit();
    await vi.waitFor(() => expect(h.view().problem).toBe("load"));
    expect(h.view()).toMatchObject({ phase: "ready", pagesLoaded: 2, nextCursor: null, loadingMore: false, restoreReady: true });
    expect(lemmas(h.view().items)).toEqual(shown);
    h.commit(); h.controller.loadMore(); h.commit();
    expect(h.requests).toHaveLength(4);
    h.controller.retry(); h.commit();
    await vi.waitFor(() => expect(h.view().pagesLoaded).toBe(3));
    expect(h.requests[3]).toEqual({ query: "Haus", mode: "words", limit: 2, cursor_token: cursor });
    expect(h.requests[4]).toEqual(h.requests[3]);
    const refused = h.view().nextCursor;
    h.fail(new ApiError("http", 409, "SEARCH_CURSOR_STALE"));
    h.controller.loadMore(); h.commit();
    await vi.waitFor(() => expect(h.view().problem).toBe("cursor_stale"));
    expect(h.view()).toMatchObject({ phase: "ready", pagesLoaded: 3, nextCursor: null });
    expect(h.view().items).toHaveLength(6);
    h.commit();
    expect(h.requests).toHaveLength(6);
    h.controller.retry();
    expect(h.view()).toMatchObject({ phase: "loading", restoreReady: false, problem: null });
    expect(h.view().items).toHaveLength(6);
    h.commit();
    await vi.waitFor(() => expect(h.view()).toMatchObject({ phase: "ready", problem: null, pagesLoaded: 4 }));
    expect(h.requests.slice(6).map(request => request.cursor_token))
      .toEqual([null, expect.any(String), expect.any(String), expect.any(String)]);
    expect(h.requests.slice(6).some(request => request.cursor_token === refused)).toBe(false);
    // Another 409 code is an ordinary failure of the same attempt.
    h.fail(new ApiError("http", 409, "VERSION_CONFLICT"));
    h.controller.loadMore(); h.commit();
    await vi.waitFor(() => expect(h.view().problem).toBe("load"));
    expect(h.view().pagesLoaded).toBe(4);
  });

  it("a refused access during an append is never kept beside shown pages", async () => {
    const h = harness();
    await full(h, 2);
    h.fail(new ApiError("http", 401));
    h.controller.loadMore(); h.commit();
    await vi.waitFor(() => expect(h.view().phase).toBe("failed"));
    expect(h.view()).toMatchObject({ problem: "load", items: [], pagesLoaded: 0, nextCursor: null });
  });

  it("snapshots are detached copies", async () => {
    const h = harness();
    h.controller.setQuery("Haus"); h.commit(); await h.settle("ready");
    const shown = h.view();
    shown.items[0].lemma = "changed"; shown.items.length = 0; shown.query = "changed";
    expect(h.view()).toMatchObject({ query: "Haus", pagesLoaded: 1 });
    expect(lemmas(h.view().items)).toEqual(range("Haus", 0, 3));
  });
});
