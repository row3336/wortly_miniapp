import { StrictMode, Suspense, createElement, startTransition, useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictionarySearchResponse, OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import {
  useDictionarySearchDocument,
  type DictionarySearchActions, type DictionarySearchDocumentOptions, type DictionarySearchSnapshot,
} from "./useDictionarySearchDocument";
import { testGate } from "../commands/testGate.test-support";

type Pair = "ru-de" | "uk-de" | "en-de";
type Language = "ru" | "uk" | "en";
type Sent = { query: string; mode: string; limit: string; cursor_token: string | null };
type Plan = { gate?: Promise<void>; reply?: (params: URLSearchParams) => Response; pair?: Pair; version?: string };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Test parameters only: S1 has no product value for either limit (REQ:222, G03 open).
const limits = { suggest: 3, page: 2 };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const denial = (status: number) => response({ error: { code: "ACCESS_DENIED" } }, status);
const unavailable = () => response({ error: { code: "UNAVAILABLE" } }, 503);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); }
const flush = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const lemmas = (state: DictionarySearchSnapshot) => state.items.map(item => item.lemma);
const range = (query: string, from: number, to: number, version = "1") =>
  Array.from({ length: to - from }, (_, k) => `${query}#${from + k}@${version}`);
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

function fixture(initial: { version?: string } = {}) {
  let serial = 0, issued = 0;
  const live = new Set<OpenedAccess>();
  const server = { version: initial.version ?? "1", pair: "ru-de" as Pair, total: 10 };
  const versions: string[] = [], plans: Plan[] = [];
  const cursors = new Map<string, { query: string; mode: string; limit: string; offset: number }>();
  const sent: Sent[] = [], tokens: string[] = [], issuedBy: Array<string | null> = [];
  const denied = vi.fn();
  const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(3), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "1",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  /** A new access closes the previous ones unless `keep` leaves them live (a not yet committed handover). */
  const access = (o: { language?: Language; version?: string; document?: number; status?: "admitted" | "pending"; keep?: boolean } = {}) => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({
      opened: { ...opened, document_id: o.document === undefined ? opened.document_id : id(o.document),
        profile: { ...opened.profile, dictionary_language: o.language ?? "ru", state_version: o.version ?? initial.version ?? "1",
          access: { status: o.status ?? "admitted", version: "1", reason: null } } },
      token: `synthetic-search-token-${++serial}`, proof: "synthetic-search-proof", generation: 1,
      isLive: () => live.has(bound), onDenied: error => { denied(error); live.delete(bound); },
    });
    if (!o.keep) live.clear();
    live.add(bound); return bound;
  };
  const item = (query: string, n: number, version: string, mode: string) => ({ card_id: id(1000 + n), revision: "1", lemma: `${query}#${n}@${version}`,
    type: mode === "phrases" ? "phrase" as const : "noun" as const, cefr: null, translation: { common: ["перевод"], personal: null }, match_kind: "exact" as const });
  // Model server: pages of the raw query; every cursor is bound to its query, filter, limit and offset.
  const page = (params: URLSearchParams, index: number, pair: Pair, version = server.version): Response => {
    const query = params.get("query")!, mode = params.get("mode")!, limit = params.get("limit")!;
    const cursor = params.get("cursor_token");
    let offset = 0;
    if (cursor !== null) {
      const bound = cursors.get(cursor);
      if (!bound || bound.query !== query || bound.mode !== mode || bound.limit !== limit) {
        return response({ error: { code: "SEARCH_CURSOR_STALE" } }, 409);
      }
      offset = bound.offset;
    }
    const end = Math.min(server.total, offset + Number(limit));
    let next: string | null = null;
    if (end < server.total) { next = `cursor_${++issued}`; cursors.set(next, { query, mode, limit, offset: end }); }
    issuedBy[index] = next;
    const body: DictionarySearchResponse = { state_version: versions.shift() ?? version, query, pair, mode: mode as "words" | "phrases",
      items: Array.from({ length: Math.max(0, end - offset) }, (_, k) => item(query, offset + k, version, mode)), next_cursor: next,
      similar: cursor === null ? [] : null };
    return response(body);
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url), "https://model.invalid");
    expect(target.pathname).toBe("/api/v1/dictionary/search");
    expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    const params = target.searchParams, index = sent.length;
    sent.push({ query: params.get("query")!, mode: params.get("mode")!, limit: params.get("limit")!,
      cursor_token: params.get("cursor_token") });
    tokens.push((init!.headers as Record<string, string>).Authorization);
    const plan = plans.shift();
    if (plan?.gate) await plan.gate;
    return plan?.reply ? plan.reply(params) : page(params, index, plan?.pair ?? server.pair, plan?.version);
  });
  /** Script the next GET: held until released and/or answered differently. Returns the release (`raw`: without act). */
  const next = (o: Omit<Plan, "gate"> & { hold?: boolean } = {}) => {
    const gate = deferred<void>();
    plans.push({ gate: o.hold ? gate.promise : undefined, reply: o.reply, pair: o.pair, version: o.version });
    return Object.assign(() => act(async () => { gate.resolve(); }), { raw: () => gate.resolve() });
  };
  const options: DictionarySearchDocumentOptions = { access: access(), transport: { fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() },
    enabled: true, limits };
  return { options, server, versions, fetcher, sent, tokens, issuedBy, denied, access, next };
}
type Fixture = ReturnType<typeof fixture>;
/** A new `entry` object asks the host to enter from another section in that commit. */
type Props = DictionarySearchDocumentOptions & { entry?: object };

function mount(f: Fixture, strict = false) {
  const seen: DictionarySearchSnapshot[] = [];
  const ui = renderHook((props: Props) => {
    const search = useDictionarySearchDocument(props);
    // A host entering from another section, inside the layout window of the commit that delivers the access.
    useLayoutEffect(() => { if (props.entry) search.actions.enterFromSection(); }, [props.entry, search.actions]);
    seen.push(search.state);
    return search;
  }, { initialProps: f.options as Props,
    wrapper: strict ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) : undefined });
  const state = () => ui.result.current.state;
  const run = (action: (actions: DictionarySearchActions) => void) => act(() => action(ui.result.current.actions));
  const ready = () => waitFor(() => expect(state().phase).toBe("ready"));
  return { ui, seen, state, run, ready };
}
/** Suggest "Haus", then Find, then load more until `pages` full pages are shown. */
async function fullPages(f: Fixture, h: ReturnType<typeof mount>, pages: number) {
  h.run(a => a.setQuery("Haus")); await h.ready();
  h.run(a => a.submit()); await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", mode: "full", pagesLoaded: 1 }));
  for (let n = 2; n <= pages; n++) {
    h.run(a => a.loadMore()); await waitFor(() => expect(h.state().pagesLoaded).toBe(n));
  }
  expect(f.fetcher).toHaveBeenCalledTimes(1 + pages);
  expect(lemmas(h.state())).toEqual(range("Haus", 0, 2 * pages, f.server.version));
}

describe("dictionary search document with real access, search API and controller", () => {
  it("SP1/SP6/SP3b: blank input reads nothing; typing reads one suggestion page in server order; suggestions never page", async () => {
    const f = fixture(), h = mount(f);
    await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(h.state()).toEqual({ phase: "idle", mode: "suggest", query: "", material: "words", pair: null, items: [], similar: [], nextCursor: null,
      loadingMore: false, pagesLoaded: 0, restoreReady: true, problem: null, focusRequest: 0 });
    h.run(a => a.setQuery("   ")); await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ phase: "idle", query: "   ", items: [] });
    h.run(a => a.setQuery("Haus")); await h.ready();
    expect(f.sent).toEqual([{ query: "Haus", mode: "words", limit: "3", cursor_token: null }]);
    expect(f.tokens).toEqual(["Bearer synthetic-search-token-1"]);
    expect(f.issuedBy[0]).not.toBeNull();
    expect(h.state()).toMatchObject({ phase: "ready", mode: "suggest", query: "Haus", pair: "ru-de", nextCursor: null, loadingMore: false,
      pagesLoaded: 1, restoreReady: true, problem: null });
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 3));
    h.run(a => a.loadMore()); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ pagesLoaded: 1, nextCursor: null, loadingMore: false });
  });

  it("limits are host parameters: another pair of values is sent as given", async () => {
    const f = fixture(), h = mount(f);
    h.ui.rerender({ ...f.options, limits: { suggest: 7, page: 5 } });
    h.run(a => a.setQuery("Haus")); await h.ready();
    h.run(a => a.submit()); await waitFor(() => expect(h.state().mode).toBe("full"));
    await h.ready();
    expect(f.sent.map(sent => sent.limit)).toEqual(["7", "5"]);
  });

  it("SP2/SP3: Find reads the full first page; load more sends the server cursor once and appends", async () => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setQuery("Haus")); await h.ready();
    h.run(a => a.submit()); await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", mode: "full" }));
    expect(f.sent[1]).toEqual({ query: "Haus", mode: "words", limit: "2", cursor_token: null });
    expect(h.state()).toMatchObject({ pagesLoaded: 1, nextCursor: f.issuedBy[1] });
    const release = f.next({ hold: true });
    h.run(a => a.loadMore());
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    expect(h.state()).toMatchObject({ phase: "ready", loadingMore: true, pagesLoaded: 1 });
    h.run(a => a.loadMore()); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    await release();
    await waitFor(() => expect(h.state().pagesLoaded).toBe(2));
    expect(f.sent[2]).toEqual({ query: "Haus", mode: "words", limit: "2", cursor_token: f.issuedBy[1] });
    expect(h.state()).toMatchObject({ phase: "ready", loadingMore: false, nextCursor: f.issuedBy[2], restoreReady: true });
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 4));
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("SP4: a new visible access rereads the suggestion page; input and filter are unchanged", async () => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setMaterial("phrases")); await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    h.run(a => a.setQuery("Haus")); await h.ready();
    const actions = h.ui.result.current.actions;
    h.ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2)); await h.ready(); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.sent[1]).toEqual({ query: "Haus", mode: "phrases", limit: "3", cursor_token: null });
    expect(f.tokens[1]).toBe("Bearer synthetic-search-token-2");
    expect(h.state()).toMatchObject({ query: "Haus", material: "phrases", mode: "suggest", pagesLoaded: 1, restoreReady: true });
    expect(h.ui.result.current.actions).toBe(actions);
  });

  it("SP4b/N-04: N pages are reread only after enabling again, with fresh cursors, and published at once", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 3);
    const old = lemmas(h.state());
    h.ui.rerender({ ...f.options, enabled: false }); await flush();
    f.server.version = "2";
    const access = f.access();
    h.ui.rerender({ ...f.options, access, enabled: false }); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(h.state()).toMatchObject({ query: "Haus", mode: "full", restoreReady: false });
    expect(lemmas(h.state())).toEqual(old);
    const releases = [f.next({ hold: true }), f.next({ hold: true }), f.next({ hold: true })];
    h.seen.length = 0;
    h.ui.rerender({ ...f.options, access, enabled: true });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(5));
    for (const [n, release] of releases.entries()) {
      expect(h.state()).toMatchObject({ phase: "loading", restoreReady: false, pagesLoaded: 3 });
      expect(lemmas(h.state())).toEqual(old);
      await release();
      if (n < 2) await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(6 + n));
    }
    await waitFor(() => expect(h.state().restoreReady).toBe(true)); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    expect(f.sent.slice(4)).toEqual([
      { query: "Haus", mode: "words", limit: "2", cursor_token: null },
      { query: "Haus", mode: "words", limit: "2", cursor_token: f.issuedBy[4] },
      { query: "Haus", mode: "words", limit: "2", cursor_token: f.issuedBy[5] },
    ]);
    expect(f.tokens.slice(4)).toEqual(Array(3).fill("Bearer synthetic-search-token-2"));
    expect(h.state()).toMatchObject({ phase: "ready", mode: "full", pagesLoaded: 3, restoreReady: true, nextCursor: f.issuedBy[6] });
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 6, "2"));
    expect(h.seen.every(state => state.items.length === 6)).toBe(true);
    expect(h.seen.filter(state => state.restoreReady).every(state => state.items[0].lemma.endsWith("@2"))).toBe(true);
  });

  it("SP4c: a reread stops when the server cursor ends and reports the real page count", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 3);
    f.server.total = 4; f.server.version = "2";
    h.ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", restoreReady: true, pagesLoaded: 2 })); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    expect(f.sent[5].cursor_token).toBe(f.issuedBy[4]);
    expect(h.state().nextCursor).toBeNull();
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 4, "2"));
  });

  it("SP4d: a failure on any reread page discards everything; retry rereads all N pages from the first", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 3);
    f.next(); f.next({ reply: unavailable });
    const access = f.access();
    h.ui.rerender({ ...f.options, access });
    await waitFor(() => expect(h.state().phase).toBe("failed")); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    expect(h.state()).toMatchObject({ phase: "failed", problem: "load", items: [], pagesLoaded: 0, restoreReady: false, nextCursor: null,
      query: "Haus", mode: "full" });
    h.ui.rerender({ ...f.options, access }); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    h.run(a => a.retry());
    await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", pagesLoaded: 3, restoreReady: true })); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(9);
    expect(f.sent.slice(6).map(sent => sent.cursor_token)).toEqual([null, f.issuedBy[6], f.issuedBy[7]]);
  });

  it("SP4e: enabling again without a new access reads nothing and the list is ready to restore", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 2);
    const before = h.state();
    h.ui.rerender({ ...f.options, enabled: false }); await flush();
    h.ui.rerender({ ...f.options, enabled: true }); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(h.state()).toEqual({ ...before, restoreReady: true });
  });

  it("SP4f/N-02: while a visible access change rereads three pages the old full list stays, never empty or partial", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 3);
    const old = lemmas(h.state());
    f.server.version = "2";
    const releases = [f.next({ hold: true }), f.next({ hold: true }), f.next({ hold: true })];
    h.seen.length = 0;
    h.ui.rerender({ ...f.options, access: f.access() });
    expect(h.seen[0]).toMatchObject({ restoreReady: false, pagesLoaded: 3 });
    for (const [n, release] of releases.entries()) {
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(5 + n));
      expect(h.state()).toMatchObject({ phase: "loading", restoreReady: false });
      expect(lemmas(h.state())).toEqual(old);
      await release();
    }
    await waitFor(() => expect(h.state().restoreReady).toBe(true));
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 6, "2"));
    for (const state of h.seen) expect([JSON.stringify(old), JSON.stringify(range("Haus", 0, 6, "2"))]).toContain(JSON.stringify(lemmas(state)));
    expect(h.seen.filter(state => !state.restoreReady).every(state => JSON.stringify(lemmas(state)) === JSON.stringify(old))).toBe(true);
  });

  it("SP4g/В06.5: a new access of another pair hides the old list in the same render; the old pair's late page is never shown", async () => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setQuery("Haus")); await h.ready();
    const release = f.next({ hold: true, pair: "ru-de" });
    h.ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 3));
    f.server.pair = "en-de";
    h.seen.length = 0;
    h.ui.rerender({ ...f.options, access: f.access({ language: "en" }) });
    expect(h.seen[0]).toMatchObject({ items: [], pair: null, pagesLoaded: 0, restoreReady: false, query: "Haus" });
    await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", pair: "en-de" }));
    await release(); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.tokens[2]).toBe("Bearer synthetic-search-token-3");
    expect(h.state()).toMatchObject({ phase: "ready", pair: "en-de", pagesLoaded: 1 });
    expect(h.seen.every(state => state.pair !== "ru-de" && (state.items.length === 0 || state.pair === "en-de"))).toBe(true);
    expect(f.denied).not.toHaveBeenCalled();
  });

  it.each(["suggest", "full"] as const)("SP5a (K07-100): entry in %s mode clears the query, selects words, asks for focus and reads nothing", async mode => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setMaterial("phrases"));
    h.run(a => a.setQuery("Haus")); await h.ready();
    if (mode === "full") { h.run(a => a.submit()); await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", mode })); }
    const calls = f.fetcher.mock.calls.length, focus = h.state().focusRequest;
    h.run(a => a.enterFromSection());
    await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(h.state()).toMatchObject({ phase: "idle", query: "", material: "words", mode: "suggest", focusRequest: focus + 1,
      items: [], pagesLoaded: 0 });
    // Ordinary input afterwards reads in the words mode.
    h.run(a => a.setQuery("Haus")); await h.ready(); await flush();
    expect(f.sent.at(-1)).toEqual({ query: "Haus", mode: "words", limit: "3", cursor_token: null });
  });

  it("SP5b: entry after a full phrases search returns to the idle words state", async () => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setMaterial("phrases"));
    h.run(a => a.setQuery("Haus")); await h.ready();
    h.run(a => a.submit()); await h.ready();
    h.run(a => a.enterFromSection()); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(h.state()).toEqual({ phase: "idle", mode: "suggest", query: "", material: "words", pair: "ru-de", items: [], similar: [], nextCursor: null,
      loadingMore: false, pagesLoaded: 0, restoreReady: true, problem: null, focusRequest: 1 });
  });

  it.each([
    ["a layout effect of the access commit"],
    ["the same event batch as the access change"],
  ] as const)("SP5c: entry from %s with a new access, the old one still live, clears and reads nothing", async timing => {
    const reads = 0;
    const f = fixture(), h = mount(f);
    h.run(a => a.setMaterial("phrases"));
    await fullPages(f, h, 2);
    const old = f.options.access, captured = h.ui.result.current.actions, calls = f.fetcher.mock.calls.length;
    // The old access stays live during the handover: a read sent at once through its binding would reach fetch.
    const access = f.access({ keep: true });
    let atEntry: number | null = null;
    if (timing.startsWith("a layout")) h.ui.rerender({ ...f.options, access, entry: {} });
    else {
      act(() => {
        captured.enterFromSection();
        atEntry = f.fetcher.mock.calls.length; // the action itself sends nothing
        h.ui.rerender({ ...f.options, access });
      });
      expect(atEntry).toBe(calls);
    }
    await waitFor(() => expect(h.state().phase).toBe("idle")); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(calls + reads);
    expect(f.sent.slice(calls)).toEqual(Array(reads).fill({ query: "Haus", mode: "words", limit: "2", cursor_token: null }));
    expect(f.tokens.slice(calls)).toEqual(Array(reads).fill("Bearer synthetic-search-token-2"));
    expect(old.isLive()).toBe(true); expect(f.denied).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ material: "words", focusRequest: 1, query: "",
      pagesLoaded: reads, restoreReady: true });
    expect(h.ui.result.current.actions).toBe(captured);
  });

  it("SP5d: the former keep/clear entry policy is a type error and a runtime error, with no state change", async () => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setMaterial("phrases"));
    h.run(a => a.setQuery("Haus")); await h.ready();
    const before = h.state(), actions = h.ui.result.current.actions;
    // @ts-expect-error K07-100: entry takes no policy.
    expect(() => actions.enterFromSection({ query: "keep" })).toThrow();
    // @ts-expect-error K07-100: entry takes no policy.
    expect(() => actions.enterFromSection({ query: "clear" })).toThrow();
    // @ts-expect-error K07-100: entry takes no policy.
    expect(() => actions.enterFromSection({})).toThrow();
    h.ui.rerender(f.options); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(h.state()).toEqual(before);
  });

  it.each(["ready", "401", "403", "503"])("SN1/SN2: a late %s for an obsolete query is never shown and never revokes", async outcome => {
    const f = fixture(), h = mount(f);
    const release = f.next({ hold: true, reply: outcome === "ready" ? undefined : () => outcome === "503" ? unavailable() : denial(Number(outcome)) });
    h.run(a => a.setQuery("Ha"));
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    h.run(a => a.setQuery("Haus")); await h.ready();
    h.seen.length = 0;
    await release(); await flush();
    h.ui.rerender(f.options); await flush();
    expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
    expect(h.state()).toMatchObject({ phase: "ready", query: "Haus", problem: null });
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 3));
    expect(JSON.stringify(h.seen)).not.toContain("\"Ha#");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    h.run(a => a.submit()); await h.ready();
    expect(f.tokens).toEqual(Array(3).fill("Bearer synthetic-search-token-1"));
  });

  it.each([401, 403])("SN3: a current %s revokes once; later actions and renders send nothing", async status => {
    const f = fixture(), h = mount(f);
    f.next({ reply: () => denial(status) });
    h.run(a => a.setQuery("Haus"));
    await waitFor(() => expect(f.denied).toHaveBeenCalledTimes(1));
    h.ui.rerender(f.options); await flush();
    expect(f.options.access.isLive()).toBe(false);
    expect(h.state()).toMatchObject({ phase: "disposed", items: [], query: "Haus", restoreReady: false });
    h.run(a => { a.retry(); a.setQuery("Hause"); a.submit(); a.setMaterial("phrases"); a.enterFromSection(); });
    h.ui.rerender({ ...f.options, enabled: false }); h.ui.rerender(f.options); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.denied).toHaveBeenCalledTimes(1);
    expect(h.state()).toMatchObject({ phase: "disposed", query: "", material: "words", items: [] });
  });

  it("SN4: a page of another pair is pair_changed and shows nothing", async () => {
    const f = fixture(), h = mount(f);
    f.server.pair = "en-de";
    h.run(a => a.setQuery("Haus"));
    await waitFor(() => expect(h.state().phase).toBe("failed")); await flush();
    expect(h.state()).toMatchObject({ phase: "failed", problem: "pair_changed", items: [], pair: "ru-de", restoreReady: false });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("SN5: a first page below the access floor is stale by BigInt comparison and is not retried", async () => {
    const f = fixture({ version: "9007199254740993" }), h = mount(f);
    f.server.version = "9007199254740992";
    h.run(a => a.setQuery("Haus"));
    await waitFor(() => expect(h.state().phase).toBe("failed")); await flush();
    expect(h.state()).toMatchObject({ problem: "stale_response", items: [] });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.server.version = "9007199254740993";
    h.run(a => a.retry()); await h.ready();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("SN5: the second reread page below the floor raised by the first is stale with no further GET", async () => {
    const f = fixture({ version: "9007199254740992" }), h = mount(f);
    await fullPages(f, h, 3);
    f.versions.push("9007199254740993", "9007199254740992");
    h.ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(h.state().phase).toBe("failed")); await flush();
    expect(h.state()).toMatchObject({ problem: "stale_response", items: [], pagesLoaded: 0, restoreReady: false });
    expect(f.fetcher).toHaveBeenCalledTimes(6);
  });

  it("the floor is kept for a same-identity access and starts again for a new document identity", async () => {
    const f = fixture(), h = mount(f);
    f.server.version = "9";
    h.run(a => a.setQuery("Haus")); await h.ready();
    f.server.version = "8";
    h.ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(h.state()).toMatchObject({ phase: "failed", problem: "stale_response" }));
    h.ui.rerender({ ...f.options, access: f.access({ document: 20 }) });
    await h.ready();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 3, "8"));
  });

  it("SN8: a failure waits; renders send nothing; retry runs one sequence", async () => {
    const f = fixture(), h = mount(f);
    f.next({ reply: unavailable });
    h.run(a => a.setQuery("Haus"));
    await waitFor(() => expect(h.state()).toMatchObject({ phase: "failed", problem: "load", query: "Haus" }));
    h.ui.rerender(f.options); h.ui.rerender(f.options); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    h.run(a => a.retry()); await h.ready(); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    h.run(a => a.retry()); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["network", "503", "invalid_response"] as const)(
    "RL1/RL3/RL2: an ordinary %s on load more keeps the shown pages; only retry sends the same GET once", async kind => {
      const f = fixture(), h = mount(f);
      await fullPages(f, h, 2);
      const shown = lemmas(h.state()), cursor = f.issuedBy[2];
      expect(h.state()).toMatchObject({ nextCursor: cursor, problem: null });
      f.next({ reply: kind === "503" ? unavailable : kind === "network" ? () => { throw new TypeError("offline"); } : () => response({ unexpected: true }) });
      h.run(a => a.loadMore());
      await waitFor(() => expect(h.state().problem).toBe("load"));
      h.ui.rerender(f.options); h.ui.rerender(f.options); await flush();
      expect(f.fetcher).toHaveBeenCalledTimes(4);
      expect(f.sent[3]).toEqual({ query: "Haus", mode: "words", limit: "2", cursor_token: cursor });
      expect(h.state()).toMatchObject({ phase: "ready", mode: "full", pagesLoaded: 2, problem: "load", nextCursor: null,
        loadingMore: false, restoreReady: true, query: "Haus" });
      expect(lemmas(h.state())).toEqual(shown);
      h.run(a => a.loadMore()); await flush();
      expect(f.fetcher).toHaveBeenCalledTimes(4);
      h.run(a => a.retry());
      await waitFor(() => expect(h.state().pagesLoaded).toBe(3)); await flush();
      expect(f.fetcher).toHaveBeenCalledTimes(5);
      expect(f.sent[4]).toEqual(f.sent[3]);
      expect(h.state()).toMatchObject({ phase: "ready", problem: null, nextCursor: f.issuedBy[4] });
      expect(lemmas(h.state())).toEqual(range("Haus", 0, 6));
    });

  it("RL4/RL3/RL5: 409 SEARCH_CURSOR_STALE keeps the shown pages under cursor_stale; retry rereads N+1 from the first page at once", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 2);
    const shown = lemmas(h.state()), cursor = f.issuedBy[2];
    f.next({ reply: () => response({ error: { code: "SEARCH_CURSOR_STALE" } }, 409) });
    h.run(a => a.loadMore());
    await waitFor(() => expect(h.state().problem).toBe("cursor_stale"));
    h.ui.rerender(f.options); h.ui.rerender(f.options); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    expect(h.state()).toMatchObject({ phase: "ready", pagesLoaded: 2, nextCursor: null, loadingMore: false });
    expect(lemmas(h.state())).toEqual(shown);
    h.run(a => a.loadMore()); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    f.server.version = "2";
    const releases = [f.next({ hold: true }), f.next({ hold: true }), f.next({ hold: true })];
    h.seen.length = 0;
    h.run(a => a.retry());
    for (const [n, release] of releases.entries()) {
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(5 + n));
      expect(h.state()).toMatchObject({ phase: "loading", restoreReady: false, problem: null });
      expect(lemmas(h.state())).toEqual(shown);
      await release();
    }
    await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", pagesLoaded: 3, restoreReady: true })); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    expect(f.sent.slice(4)).toEqual([
      { query: "Haus", mode: "words", limit: "2", cursor_token: null },
      { query: "Haus", mode: "words", limit: "2", cursor_token: f.issuedBy[4] },
      { query: "Haus", mode: "words", limit: "2", cursor_token: f.issuedBy[5] },
    ]);
    expect(f.sent.filter(sent => sent.cursor_token === cursor)).toHaveLength(1);
    const fresh = range("Haus", 0, 6, "2");
    expect(lemmas(h.state())).toEqual(fresh);
    for (const state of h.seen) expect([JSON.stringify(shown), JSON.stringify(fresh)]).toContain(JSON.stringify(lemmas(state)));
  });

  it("RL6: after an ordinary load more failure a new query starts from the first page without the old cursor", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 2);
    const cursor = f.issuedBy[2];
    f.next({ reply: unavailable });
    h.run(a => a.loadMore());
    await waitFor(() => expect(h.state().problem).toBe("load"));
    h.run(a => a.setQuery("Hand")); await h.ready(); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    expect(f.sent[4]).toEqual({ query: "Hand", mode: "words", limit: "3", cursor_token: null });
    expect(f.sent.filter(sent => sent.cursor_token === cursor)).toHaveLength(1);
    expect(h.state()).toMatchObject({ mode: "suggest", problem: null, nextCursor: null, pagesLoaded: 1 });
    expect(lemmas(h.state())).toEqual(range("Hand", 0, 3));
  });

  it.each(["another pair", "below the floor", "current 401"] as const)(
    "a load more page of %s stays fail-closed: nothing of the old list is shown", async kind => {
      const f = fixture({ version: "5" }), h = mount(f);
      await fullPages(f, h, 2);
      if (kind === "another pair") f.next({ pair: "en-de" });
      else if (kind === "below the floor") f.versions.push("4");
      else f.next({ reply: () => denial(401) });
      h.run(a => a.loadMore());
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(4));
      if (kind === "current 401") {
        await waitFor(() => expect(f.denied).toHaveBeenCalledTimes(1));
        h.ui.rerender(f.options); await flush();
        expect(h.state()).toMatchObject({ phase: "disposed", items: [], pagesLoaded: 0 });
      } else {
        await waitFor(() => expect(h.state().phase).toBe("failed")); await flush();
        expect(h.state()).toMatchObject({ problem: kind === "another pair" ? "pair_changed" : "stale_response", items: [],
          pagesLoaded: 0, nextCursor: null, restoreReady: false });
      }
      expect(f.fetcher).toHaveBeenCalledTimes(4);
    });

  it("SN9: a cursor never leaves with another query or filter; the old append is dropped", async () => {
    const f = fixture(), h = mount(f);
    await fullPages(f, h, 1);
    const cursor = f.issuedBy[1];
    const release = f.next({ hold: true });
    h.run(a => a.loadMore());
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    h.run(a => a.setQuery("Hau")); await h.ready();
    await release(); await flush();
    expect(lemmas(h.state())).toEqual(range("Hau", 0, 3));
    h.run(a => a.loadMore()); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(4);
    h.run(a => a.submit()); await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", mode: "full" }));
    h.run(a => a.setMaterial("phrases")); await waitFor(() => expect(h.state()).toMatchObject({ phase: "ready", material: "phrases" }));
    expect(f.fetcher).toHaveBeenCalledTimes(6);
    expect(f.sent.filter(sent => sent.cursor_token !== null)).toEqual([
      { query: "Haus", mode: "words", limit: "2", cursor_token: cursor },
    ]);
    expect(f.sent.slice(4)).toEqual([
      { query: "Hau", mode: "words", limit: "2", cursor_token: null },
      { query: "Hau", mode: "phrases", limit: "2", cursor_token: null },
    ]);
    expect(h.state()).toMatchObject({ mode: "full", pagesLoaded: 1 });
  });

  it.each(["visibilitychange", "pageshow"])("SN10: after %s an in-flight read is inert and nothing is read until a new access", async event => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setQuery("Haus")); await h.ready();
    const release = f.next({ hold: true });
    h.run(a => a.submit());
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    act(() => {
      if (event === "visibilitychange") { visible("hidden"); document.dispatchEvent(new Event(event)); }
      else window.dispatchEvent(new Event(event));
    });
    visible("visible");
    await release(); await flush();
    expect(h.state()).toMatchObject({ phase: "loading", mode: "full", items: [] });
    h.run(a => a.setQuery("Hause")); h.run(a => a.submit()); h.run(a => a.retry());
    h.ui.rerender({ ...f.options, enabled: false }); h.ui.rerender(f.options); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    h.ui.rerender({ ...f.options, access: f.access() });
    await h.ready(); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.sent[2]).toEqual({ query: "Hause", mode: "words", limit: "2", cursor_token: null });
    expect(f.tokens[2]).toBe("Bearer synthetic-search-token-2");
    expect(f.denied).not.toHaveBeenCalled();
  });

  it("SN10: hiding keeps the shown list for foreground; hidden before mount never reads", async () => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setQuery("Haus")); await h.ready();
    act(() => { visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 3));
    cleanup();
    const g = fixture(), hidden = mount(g);
    hidden.run(a => a.setQuery("Haus")); await flush();
    visible("visible"); act(() => document.dispatchEvent(new Event("visibilitychange")));
    hidden.ui.rerender(g.options); await flush();
    expect(g.fetcher).not.toHaveBeenCalled();
    hidden.ui.rerender({ ...g.options, access: g.access() }); await hidden.ready();
    expect(g.fetcher).toHaveBeenCalledTimes(1);
  });

  it("N-04: disabling makes an in-flight read inert; enabling with the same access sends it once", async () => {
    const f = fixture(), h = mount(f);
    const release = f.next({ hold: true, reply: () => denial(401) });
    h.run(a => a.setQuery("Haus"));
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    h.ui.rerender({ ...f.options, enabled: false });
    await release(); await flush();
    expect(f.denied).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ phase: "loading", query: "Haus", items: [] });
    h.ui.rerender(f.options); await h.ready(); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.tokens).toEqual(Array(2).fill("Bearer synthetic-search-token-1"));
  });

  it.each([401, 403])("a late %s through a replaced transport neither revokes nor publishes; the owed read is sent once", async status => {
    const f = fixture(), h = mount(f);
    const release = f.next({ hold: true, reply: () => denial(status) });
    h.run(a => a.setQuery("Haus"));
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    h.ui.rerender({ ...f.options, transport: { ...f.options.transport } });
    await h.ready();
    await release(); await flush();
    expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(h.state()).toMatchObject({ phase: "ready", query: "Haus" });
  });

  it("SN11: snapshots are detached and carry no credentials", async () => {
    const f = fixture(), h = mount(f);
    h.run(a => a.setQuery("Haus")); await h.ready();
    const shown = h.state();
    shown.items[0].lemma = "changed"; shown.items.length = 0; shown.query = "changed"; shown.pagesLoaded = 9;
    h.ui.rerender(f.options);
    expect(h.state()).toMatchObject({ query: "Haus", pagesLoaded: 1 });
    expect(lemmas(h.state())).toEqual(range("Haus", 0, 3));
    expect(JSON.stringify(h.seen)).not.toMatch(/synthetic-search|Bearer|proof|token/);
  });

  it("StrictMode: one read per action, every listener removed, captured actions after unmount send and publish nothing", async () => {
    const f = fixture();
    const add = vi.spyOn(document, "addEventListener"), remove = vi.spyOn(document, "removeEventListener");
    const addWindow = vi.spyOn(window, "addEventListener"), removeWindow = vi.spyOn(window, "removeEventListener");
    const h = mount(f, true);
    await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    h.run(a => a.setQuery("Haus")); await h.ready(); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const release = f.next({ hold: true });
    h.run(a => a.submit());
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    const captured = h.ui.result.current.actions;
    h.ui.unmount();
    for (const call of add.mock.calls.filter(value => value[0] === "visibilitychange")) expect(remove.mock.calls).toContainEqual(call);
    for (const call of addWindow.mock.calls.filter(value => value[0] === "pageshow")) expect(removeWindow.mock.calls).toContainEqual(call);
    const renders = h.seen.length;
    await release(); await flush();
    act(() => { captured.setQuery("Hause"); captured.submit(); captured.retry(); captured.enterFromSection(); });
    await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(h.seen).toHaveLength(renders);
    expect(h.seen.some(state => state.mode === "full" && state.phase === "ready")).toBe(false);
  });

  it.each([
    ["missing limits", undefined],
    ["missing page limit", { suggest: 3 }],
    ["zero", { suggest: 0, page: 2 }],
    ["fraction", { suggest: 1.5, page: 2 }],
    ["unsafe integer", { suggest: 3, page: Number.MAX_SAFE_INTEGER + 1 }],
    ["string", { suggest: "3", page: 2 }],
  ])("invalid limits (%s) throw during render and send nothing", async (_name, value) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture();
    expect(() => renderHook(useDictionarySearchDocument, { initialProps: { ...f.options, limits: value as never } })).toThrow();
    await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("an unknown dictionary language throws during render and sends nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture();
    expect(() => renderHook(useDictionarySearchDocument, { initialProps: { ...f.options, access: f.access({ language: "de" as Language }) } })).toThrow();
    await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("a not admitted access is disposed and never reads", async () => {
    const f = fixture(), h = mount(f);
    h.ui.rerender({ ...f.options, access: f.access({ status: "pending" }) });
    h.run(a => a.setQuery("Haus")); await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(h.state()).toMatchObject({ phase: "disposed", query: "Haus", items: [] });
  });
});

/** Host whose render of B can stay uncommitted: a sibling suspends inside a transition under a real Suspense. */
function interruptible(f: Fixture, suspendB: boolean) {
  const journal: string[] = [], never = new Promise<never>(() => undefined);
  const access = { A: f.options.access, B: f.access({ keep: true }) };
  const ref = { setTarget: null as null | ((target: "A" | "B") => void), committed: null as null | ReturnType<typeof useDictionarySearchDocument> };
  function Host({ target }: { target: "A" | "B" }): ReactNode {
    journal.push(`render:${target}`); // instrumentation only: no product action in render
    const search = useDictionarySearchDocument({ ...f.options, access: access[target] });
    useLayoutEffect(() => { journal.push(`commit:${target}`); ref.committed = search; });
    return createElement("div", { "data-target": target });
  }
  function Gate({ target }: { target: "A" | "B" }): ReactNode {
    if (target === "B" && suspendB) throw never;
    return null;
  }
  function Root(): ReactNode {
    const [target, set] = useState<"A" | "B">("A");
    useLayoutEffect(() => { ref.setTarget = set; });
    return createElement(Suspense, { fallback: createElement("p", { "data-fallback": "" }) },
      createElement(Host, { target }), createElement(Gate, { target }));
  }
  const view = render(createElement(Root));
  const marker = () => view.container.querySelector("[data-target]")?.getAttribute("data-target") ?? null;
  const fallback = () => view.container.querySelector("[data-fallback]") !== null;
  /** Committed A holds a GET for "Haus"; then the transition to B starts. */
  const toB = async (reply?: () => Response) => {
    await flush();
    expect(journal).toContain("commit:A"); expect(marker()).toBe("A");
    const release = f.next({ hold: true, reply });
    act(() => ref.committed!.actions.setQuery("Haus"));
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    expect(f.tokens).toEqual(["Bearer synthetic-search-token-1"]);
    act(() => { startTransition(() => ref.setTarget!("B")); });
    await flush();
    return release;
  };
  return { journal, access, ref, marker, fallback, toB, state: () => ref.committed!.state };
}

describe("F1 probe: an uncommitted render never retargets reads (real Suspense + startTransition, commit observer)", () => {
  it.each([401, 403])("uncommitted B: committed A's current %s revokes A exactly once", async status => {
    const f = fixture(), s = interruptible(f, true);
    const release = await s.toB(() => denial(status));
    expect(s.journal).toContain("render:B"); expect(s.journal).not.toContain("commit:B");
    expect(s.marker()).toBe("A"); expect(s.fallback()).toBe(false);
    await release(); await flush();
    expect(f.denied).toHaveBeenCalledTimes(1);
    expect(s.access.A.isLive()).toBe(false); expect(s.access.B.isLive()).toBe(true);
    expect(s.journal).not.toContain("commit:B"); expect(s.marker()).toBe("A");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("uncommitted B: committed A's page is published to A, not lost", async () => {
    const f = fixture(), s = interruptible(f, true);
    const release = await s.toB();
    expect(s.journal).not.toContain("commit:B");
    await release();
    await waitFor(() => expect(s.state()).toMatchObject({ phase: "ready", query: "Haus", pagesLoaded: 1 }));
    expect(lemmas(s.state())).toEqual(range("Haus", 0, 3));
    expect(s.journal).not.toContain("commit:B"); expect(s.marker()).toBe("A");
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.denied).not.toHaveBeenCalled();
  });

  it.each([401, 403])("completed B: old A's late %s is inert, B is not revoked and reads once", async status => {
    const f = fixture(), s = interruptible(f, false);
    const release = await s.toB(() => denial(status));
    expect(s.journal).toContain("commit:B"); expect(s.marker()).toBe("B");
    await waitFor(() => expect(s.state()).toMatchObject({ phase: "ready", query: "Haus" }));
    await release(); await flush();
    expect(f.denied).not.toHaveBeenCalled();
    expect(s.access.A.isLive()).toBe(true); expect(s.access.B.isLive()).toBe(true);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.tokens).toEqual(["Bearer synthetic-search-token-1", "Bearer synthetic-search-token-2"]);
    expect(s.state()).toMatchObject({ phase: "ready", query: "Haus", pagesLoaded: 1 });
  });
});

describe("commit→passive window of a new access, without act (real React scheduler)", () => {
  // Inside act() React runs passive effects before any microtask of the test, which would hide this window.
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  let previous: boolean | undefined;
  beforeEach(() => { previous = env.IS_REACT_ACT_ENVIRONMENT; env.IS_REACT_ACT_ENVIRONMENT = false; });
  afterEach(() => { env.IS_REACT_ACT_ENVIRONMENT = previous; });
  /** Polls a condition with macrotask ticks; ordering is proven by the journal, never by the delay. */
  async function until(check: () => boolean, label: string) {
    for (let i = 0; i < 1500; i++) { if (check()) return; await new Promise<void>(done => setTimeout(done, 2)); }
    throw new Error(`UNTIL-TIMEOUT ${label}`);
  }
  /** Runs `done` after `count` chained microtasks: React's passive flush is a macrotask and cannot run before it. */
  function microtasks(count: number, done: () => void) {
    let n = 0;
    const step = () => { if (++n < count) void Promise.resolve().then(step); else done(); };
    step();
  }
  /** The same access, journaling when its `run` settles and how. */
  function journaled(handle: OpenedAccess, name: string, journal: string[]): OpenedAccess {
    return Object.freeze({
      key: handle.key,
      get profile() { return handle.profile; },
      get session() { return handle.session; },
      document: handle.document,
      isLive: () => handle.isLive(),
      run<T>(operation: (credentials: Parameters<Parameters<OpenedAccess["run"]>[0]>[0]) => Promise<T>): Promise<T> {
        const result = handle.run(operation);
        result.then(() => journal.push(`run:${name}:ok`),
          (error: unknown) => journal.push(`run:${name}:${error instanceof Error ? error.message : String(error)}`));
        return result;
      },
    });
  }

  it.each(["401", "reread"] as const)("an old access's held %s answering after B's commit and before B's passive effect is inert; B reads its own", async variant => {
    const f = fixture(), journal: string[] = [], seen: DictionarySearchSnapshot[] = [];
    const A = f.options.access, A2 = f.access({ keep: true }), B = f.access({ keep: true });
    const handles = { A: journaled(A, "A", journal), A2: journaled(A2, "A2", journal), B: journaled(B, "B", journal) };
    const old = variant === "401" ? A : A2, oldName = variant === "401" ? "A" : "A2";
    const oldToken = variant === "401" ? "Bearer synthetic-search-token-1" : "Bearer synthetic-search-token-2";
    const box = { result: null as ReturnType<typeof useDictionarySearchDocument> | null, release: () => undefined as unknown, mark: -1 };
    function P({ options, name }: { options: DictionarySearchDocumentOptions; name: string }): ReactNode {
      const search = useDictionarySearchDocument(options);
      seen.push(search.state);
      useLayoutEffect(() => { box.result = search; });
      useLayoutEffect(() => {
        journal.push(`layout:${name}`);
        if (name !== "B") return;
        box.mark = f.fetcher.mock.calls.length;
        box.release(); // the old access's held GET answers inside B's commit→passive window
        microtasks(400, () => journal.push(`micro:${JSON.stringify({ oldIO: f.tokens.slice(box.mark).filter(token => token === oldToken).length,
          denied: f.denied.mock.calls.length, oldLive: old.isLive() })}`));
      }, [name]);
      useEffect(() => { journal.push(`passive:${name}`); }, [name]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const show = (name: "A" | "A2" | "B") => root.render(createElement(P, { options: { ...f.options, access: handles[name] }, name }));
    const state = () => box.result!.state;
    try {
      show("A");
      await until(() => journal.includes("passive:A"), "A mounted");
      if (variant === "401") {
        box.release = f.next({ hold: true, reply: () => denial(401) }).raw;
        box.result!.actions.setQuery("Haus");
        await until(() => f.fetcher.mock.calls.length === 1, "A GET held");
      } else {
        box.result!.actions.setQuery("Haus"); await until(() => state().phase === "ready", "suggest");
        box.result!.actions.submit(); await until(() => state().phase === "ready" && state().mode === "full", "full");
        box.result!.actions.loadMore(); await until(() => state().pagesLoaded === 2, "page 2");
        box.release = f.next({ hold: true, version: "2" }).raw;
        show("A2");
        await until(() => f.fetcher.mock.calls.length === 4, "A2 reread page 1 held");
      }
      seen.length = 0;
      show("B");
      await until(() => journal.includes("passive:B") && journal.some(entry => entry.startsWith("micro:")), "B passive");
      await until(() => state().phase === "ready" && state().restoreReady, "B ready");
      // Phase proof: the old outcome settled after B's commit, before the microtask marker, and that before B's passive effect.
      const layout = journal.indexOf("layout:B"), settled = journal.findIndex(entry => entry.startsWith(`run:${oldName}:`));
      const micro = journal.findIndex(entry => entry.startsWith("micro:")), passive = journal.indexOf("passive:B");
      expect(layout, "window not reproduced: layout").toBeGreaterThan(-1);
      expect(settled, "window not reproduced: old outcome after layout").toBeGreaterThan(layout);
      expect(settled, "window not reproduced: old outcome before the marker").toBeLessThan(micro);
      expect(micro, "window not reproduced: marker before passive").toBeLessThan(passive);
      // Inside the window: obsolete inside access.run, no revocation, no further IO with the old token.
      expect(journal[settled]).toBe(`run:${oldName}:closed_access`);
      expect(JSON.parse(journal[micro].slice("micro:".length))).toEqual({ oldIO: 0, denied: 0, oldLive: true });
      // After B's passive effect: B reads what it owes with its own token; nothing of the old access is shown.
      expect(f.denied).not.toHaveBeenCalled(); expect(old.isLive()).toBe(true);
      expect(f.tokens.slice(box.mark)).toEqual(Array(variant === "401" ? 1 : 2).fill("Bearer synthetic-search-token-3"));
      if (variant === "401") {
        expect(f.sent.slice(box.mark)).toEqual([{ query: "Haus", mode: "words", limit: "3", cursor_token: null }]);
        expect(state()).toMatchObject({ mode: "suggest", pagesLoaded: 1 });
      } else {
        expect(f.sent.slice(box.mark)).toEqual([
          { query: "Haus", mode: "words", limit: "2", cursor_token: null },
          { query: "Haus", mode: "words", limit: "2", cursor_token: f.issuedBy[box.mark] },
        ]);
        expect(state()).toMatchObject({ mode: "full", pagesLoaded: 2 });
        expect(seen.every(shown => shown.items.every(item => !item.lemma.endsWith("@2")))).toBe(true);
      }
      expect(lemmas(state())).toEqual(range("Haus", 0, variant === "401" ? 3 : 4));
    } finally { root.unmount(); }
  });
});
