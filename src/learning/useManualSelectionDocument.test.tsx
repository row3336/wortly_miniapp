import { StrictMode, Suspense, createElement, startTransition, useLayoutEffect, useState, type ReactNode } from "react";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningCurrentResponse, OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { ACCESS_BOUND_MARKER } from "./accessBoundLearningApi";
import { ManualPendingStore, type ManualPending } from "./manualPending";
import {
  useManualSelectionDocument, type ManualSelectionDocumentActions, type ManualSelectionDocumentOptions, type ManualSelectionDocumentState,
} from "./useManualSelectionDocument";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(41), B = id(42), PROFILE = id(3), CLIENT = id(1);
const pendingKey = "wortly.pending.manual";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const denial = (status: number) => response({ error: { code: status === 401 ? "UNAUTHORIZED" : "ACCESS_DENIED" } }, status);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); }
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

type Pair = "ru-de" | "uk-de" | "en-de";
type Route = (path: string, init: RequestInit) => Response | Promise<Response> | undefined | Promise<Response | undefined>;
/** Synthetic Learning server: exact command identity, idempotent replay, payload mismatch, BigInt versions. */
function server(start = 9007199254740993n) {
  const s = { state: start, selection: start, pair: "ru-de" as Pair, selected: new Set<string>(),
    commands: new Map<string, { body: string; cardId: string; kind: string }>(), routes: [] as Route[] };
  const current = (): LearningCurrentResponse => ({ pair: s.pair, state_version: String(s.state),
    manual_selection_version: String(s.selection), group: null,
    manual_selection: [...s.selected].map((card_id, i) => ({ card_id, position: i + 1, version: String(s.selection), eligible: true })),
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2, manual_eligible: s.selected.size, automatic_eligible: 2 } });
  const fact = (commandId: string, stored: { cardId: string; kind: string }, status: string) => ({ id: commandId, kind: stored.kind, status,
    applied_at: "2026-10-01T00:00:00Z", target_id: stored.cardId, action_id: null, result_id: null, context_id: null, object_version: String(s.selection) });
  const profile = () => ({ profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: s.pair.slice(0, 2), time_zone: "UTC",
    state_version: String(s.state), access: { status: "admitted", version: "1", reason: null } });
  const handle = (path: string, init: RequestInit): Response => {
    if (path === "/api/v1/learning/current" && init.method === "GET") return response(current());
    if (path === "/api/v1/commands" && init.method === "POST") {
      const body = JSON.parse(String(init.body)), { command_id, kind, payload, expected_selection_version } = body;
      const semantic = JSON.stringify({ kind, payload, expected_selection_version });
      const stored = s.commands.get(command_id);
      if (stored && stored.body !== semantic) return response({ command: { id: command_id, status: "rejected" },
        error: { code: "COMMAND_PAYLOAD_MISMATCH" }, current: current(), state_version: String(s.state) }, 409);
      if (stored) return response({ command: fact(command_id, stored, "already_applied"), current: current(), state_version: String(s.state) });
      if (expected_selection_version !== String(s.selection) || payload.expected_pair !== s.pair) {
        // As core: a pair or version conflict is 409 VERSION_CONFLICT, rolled back without a state bump.
        return response({ command: { id: command_id, status: "rejected" }, error: { code: "VERSION_CONFLICT" },
          current: current(), state_version: String(s.state) }, 409);
      }
      if (kind === "learning.select") s.selected.add(payload.card_id); else s.selected.delete(payload.card_id);
      s.selection++; s.state++;
      const saved = { body: semantic, cardId: payload.card_id, kind };
      s.commands.set(command_id, saved);
      return response({ command: fact(command_id, saved, "applied"), current: current(), state_version: String(s.state) });
    }
    const match = /^\/api\/v1\/commands\/([0-9a-f-]{36})$/.exec(path);
    if (match && init.method === "GET") {
      const stored = s.commands.get(match[1]);
      return stored ? response({ command: fact(match[1], stored, "already_applied"), current: current(), state_version: String(s.state) })
        : response({ command: { id: match[1], status: "not_found" }, current: profile(), state_version: String(s.state) });
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = String(url), route = s.routes.shift();
    return (route && await route(path, init!)) ?? handle(path, init!);
  });
  return Object.assign(s, { fetcher, handle, current });
}

function fixture(options: { start?: bigint; profileVersion?: string; seeded?: ManualPending } = {}) {
  const srv = server(options.start);
  const values = new Map<string, string>([["unrelated", "keep"]]);
  if (options.seeded) values.set(pendingKey, JSON.stringify(options.seeded));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  let active: OpenedAccess | null = null, serial = 0, next = 100;
  const denied = vi.fn();
  const base: OpenedClient = { status: "opened", client_instance_id: CLIENT, document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
      state_version: options.profileVersion ?? String(options.start ?? 9007199254740993n), access: { status: "admitted", version: "1", reason: null } },
    session: null, compatibility: { compatible: true, contract_version: "1" } };
  const access = (patch: Partial<OpenedClient> = {}) => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened: { ...base, ...patch }, token: `synthetic-manual-token-${++serial}`, proof: `synthetic-manual-proof-${serial}`,
      generation: 1, isLive: () => active === bound, onDenied: error => { denied(error); if (active === bound) active = null; } });
    active = bound; return bound;
  };
  /** A handle that does not replace the current one; it stays live until denied. */
  const sibling = (patch: Partial<OpenedClient> = {}) => {
    let live = true;
    return createOpenedAccess({ opened: { ...base, ...patch }, token: "synthetic-manual-token-sibling", proof: "synthetic-manual-proof-sibling",
      generation: 1, isLive: () => live, onDenied: error => { denied(error); live = false; } });
  };
  const transport = { fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 100000 };
  const pendingStore = new ManualPendingStore(storage);
  const newId = vi.fn(() => id(next++));
  const options0: ManualSelectionDocumentOptions = { access: access(), transport, pendingStore, enabled: true, newId };
  const calls = () => srv.fetcher.mock.calls.map(([url, init]) => `${init!.method} ${String(url)}`);
  const auth = (n = -1) => (srv.fetcher.mock.calls.at(n)![1]!.headers as Record<string, string>).Authorization;
  return { srv, values, storage, pendingStore, base, access, sibling, denied, newId, options: options0, calls, auth, revoke: () => { active = null; } };
}
type F = ReturnType<typeof fixture>;
const stored = (cardId = A, patch: Partial<ManualPending> = {}, version = "9007199254740993", pair: Pair = "ru-de"): ManualPending => ({
  schemaVersion: 1, profileId: PROFILE, clientInstanceId: CLIENT, ...patch,
  intent: { command_id: id(90), kind: "learning.select", expected_selection_version: version, payload: { card_id: cardId, expected_pair: pair } } });

type Hook = { state: ManualSelectionDocumentState; actions: ManualSelectionDocumentActions };
function mount(f: F, strict = false) {
  const seen: ManualSelectionDocumentState[] = [];
  const ui = renderHook((options: ManualSelectionDocumentOptions) => {
    const result = useManualSelectionDocument(options); seen.push(result.state); return result;
  }, { initialProps: f.options,
    wrapper: strict ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) : undefined });
  return { ui, seen };
}
const state = (ui: { result: { current: Hook } }) => ui.result.current.state;
const ready = (ui: { result: { current: Hook } }) => waitFor(() => expect(state(ui)).toMatchObject({ phase: "ready", canChange: true }));
const posts = (f: F) => f.calls().filter(call => call.startsWith("POST"));

describe("manual selection document with real access, controller, store and Learning API", () => {
  it("StrictMode opens with one GET, no write, and a credential-free detached state", async () => {
    const f = fixture(), { ui, seen } = mount(f, true);
    expect(seen[0]).toEqual({ phase: "loading", problem: null, pending: null, outcome: null, canChange: false, canRetry: false });
    await ready(ui); await flush();
    expect(f.calls()).toEqual(["GET /api/v1/learning/current"]);
    expect(f.auth()).toBe("Bearer synthetic-manual-token-1");
    expect(state(ui)).toEqual({ phase: "ready", problem: null, pending: null, outcome: null, canChange: true, canRetry: false });
    expect(JSON.stringify(seen)).not.toMatch(/synthetic-manual|access-bound|token|proof/);
  });

  it("select stores the intent before one POST and reports the card and exact version for the card floor", async () => {
    const f = fixture(), { ui, seen } = mount(f);
    await ready(ui); const actions = ui.result.current.actions;
    const held = deferred<Response>();
    f.srv.routes.push((path, init) => {
      if (init.method !== "POST") return undefined;
      expect(JSON.parse(f.values.get(pendingKey)!)).toEqual({ ...stored(A), intent: { ...stored(A).intent, command_id: id(100) } });
      expect((init.headers as Record<string, string>)["X-Origin-Proof"]).toBe("synthetic-manual-proof-1");
      return held.promise.then(() => f.srv.handle(path, init));
    });
    let sending!: Promise<void>; act(() => { sending = actions.change(A, true); });
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    expect(state(ui)).toMatchObject({ phase: "sending", pending: { cardId: A, kind: "learning.select" }, canChange: false, canRetry: false });
    await act(async () => { held.resolve(new Response()); await sending; });
    expect(posts(f)).toHaveLength(1); expect(f.values.has(pendingKey)).toBe(false);
    expect(state(ui)).toEqual({ phase: "ready", problem: null, pending: null, canChange: true, canRetry: false,
      outcome: { commandId: id(100), cardId: A, status: "accepted", stateVersion: "9007199254740994" } });
    ui.rerender({ ...f.options }); expect(ui.result.current.actions).toBe(actions);
    await act(() => actions.change(A, false));
    expect(state(ui).outcome).toMatchObject({ commandId: id(101), cardId: A, status: "accepted", stateVersion: "9007199254740995" });
    // A later read is not this command's result.
    f.srv.state += 5n; await act(() => actions.refresh());
    expect(state(ui).outcome).toMatchObject({ commandId: id(101), stateVersion: "9007199254740995" });
    expect(JSON.stringify([seen, [...f.values.values()]])).not.toMatch(/synthetic-manual|access-bound/);
  });

  it("a rejected command is a result with its version and card, not a denial", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui); f.srv.selection += 5n; f.srv.state += 5n;
    await act(() => ui.result.current.actions.change(B, true));
    expect(state(ui)).toMatchObject({ phase: "ready", pending: null, canChange: true,
      outcome: { cardId: B, status: "rejected", code: "VERSION_CONFLICT", stateVersion: "9007199254740998" } });
    expect(f.denied).not.toHaveBeenCalled(); expect(f.values.has(pendingKey)).toBe(false);
  });

  it.each(([401, 403] as const).flatMap(status => (["get", "change", "status"] as const).map(path => ({ status, path }))))(
    "a current $status on $path revokes the document once, keeps the intent and allows no further IO", async ({ status, path }) => {
      const f = fixture(path === "status" ? { seeded: stored(A) } : {});
      if (path === "get") f.srv.routes.push(() => denial(status));
      if (path === "status") f.srv.routes.push(() => denial(status));
      const { ui } = mount(f);
      if (path === "change") {
        await ready(ui); f.srv.routes.push(() => denial(status));
        await act(() => ui.result.current.actions.change(A, true));
      } else await flush();
      await waitFor(() => expect(f.denied).toHaveBeenCalledTimes(1));
      ui.rerender(f.options);
      expect(f.options.access.isLive()).toBe(false);
      expect(state(ui)).toEqual({ phase: "blocked", problem: { reason: status === 401 ? "expired" : "forbidden",
        code: status === 401 ? "UNAUTHORIZED" : "ACCESS_DENIED" }, pending: null, outcome: null, canChange: false, canRetry: false });
      if (path !== "get") expect(JSON.parse(f.values.get(pendingKey)!).intent.payload.card_id).toBe(A);
      const count = f.srv.fetcher.mock.calls.length;
      await act(async () => { await ui.result.current.actions.refresh(); await ui.result.current.actions.retry(A); await ui.result.current.actions.change(B, true); });
      expect(f.srv.fetcher).toHaveBeenCalledTimes(count); expect(f.denied).toHaveBeenCalledTimes(1);
    });

  it.each([
    ...["ok", "401", "403"].map(late => ({ late, change: "access" })),
    ...["ok", "401", "403"].map(late => ({ late, change: "transport" })),
  ])("a late $late POST after a same-key $change replacement neither publishes nor revokes; recovery is status only", async ({ late, change }) => {
    const f = fixture(), { ui, seen } = mount(f);
    await ready(ui);
    const held = deferred<Response>(); f.srv.routes.push(() => held.promise);
    let sending!: Promise<void>; act(() => { sending = ui.result.current.actions.change(A, true); });
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    const nextFetcher = vi.fn<typeof fetch>((url, init) => f.srv.fetcher(url, init));
    const next = change === "access" ? { ...f.options, access: f.access() }
      : { ...f.options, transport: { ...f.options.transport, fetcher: nextFetcher } };
    if (change === "access") expect(next.access.key).toBe(f.options.access.key);
    seen.length = 0; ui.rerender(next);
    expect(seen[0]).toMatchObject({ phase: "loading", pending: null, canChange: false });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "unresolved", pending: { cardId: A }, canRetry: true,
      problem: { reason: "not_found" } }));
    const before = f.calls().length;
    await act(async () => {
      held.resolve(late === "ok" ? f.srv.handle("/api/v1/commands", f.srv.fetcher.mock.calls[1][1]!) : denial(Number(late)));
      await sending;
    });
    ui.rerender(next);
    expect(f.denied).not.toHaveBeenCalled(); expect(next.access.isLive()).toBe(true);
    expect(posts(f)).toHaveLength(1); expect(f.calls().length).toBe(before);
    expect(state(ui)).toMatchObject({ phase: "unresolved", pending: { cardId: A }, outcome: null });
    expect(f.calls()[2]).toBe(`GET /api/v1/commands/${id(100)}`);
    if (change === "access") expect(f.auth(2)).toBe("Bearer synthetic-manual-token-2");
    else expect(nextFetcher).toHaveBeenCalledTimes(f.calls().length - 2);
    // An explicit refresh now proves the earlier commit or repeats the same command by hand, never a new identity.
    await act(() => ui.result.current.actions.refresh());
    if (late === "ok") expect(state(ui)).toMatchObject({ phase: "ready", pending: null, outcome: { commandId: id(100), cardId: A, status: "accepted" } });
    else {
      await act(() => ui.result.current.actions.retry(A));
      expect(posts(f)).toHaveLength(2); expect(f.newId).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(f.srv.fetcher.mock.calls.at(-1)![1]!.body)).command_id).toBe(id(100));
      expect(state(ui).outcome).toMatchObject({ commandId: id(100), cardId: A, status: "accepted" });
    }
  });

  it("captured actions do no IO from a child's layout effect in the commit window and act on the current binding afterwards", async () => {
    const f = fixture({ seeded: stored(A) });
    let captured: ManualSelectionDocumentActions | null = null, latest: Hook | null = null, attempts = 0, inWindow = -1;
    function Child({ access }: { access: OpenedAccess }): ReactNode {
      // Runs after the commit, before the parent's layout and passive effects.
      useLayoutEffect(() => {
        if (!captured || access === f.options.access) return;
        attempts++; inWindow = f.srv.fetcher.mock.calls.length;
        void captured.refresh(); void captured.retry(A); void captured.change(B, true);
      }, [access]);
      return null;
    }
    function Host({ options }: { options: ManualSelectionDocumentOptions }): ReactNode {
      const doc = useManualSelectionDocument(options);
      useLayoutEffect(() => { latest = doc; });
      return createElement(Child, { access: options.access });
    }
    const view = render(createElement(Host, { options: f.options }));
    await waitFor(() => expect(latest!.state).toMatchObject({ phase: "unresolved", canRetry: true }));
    captured = latest!.actions;
    const count = f.srv.fetcher.mock.calls.length, target = f.access();
    view.rerender(createElement(Host, { options: { ...f.options, access: target } }));
    expect(attempts).toBe(1); expect(inWindow).toBe(count);
    await waitFor(() => expect(latest!.state).toMatchObject({ phase: "unresolved", canRetry: true }));
    expect(f.calls().slice(count)).toEqual([`GET /api/v1/commands/${id(90)}`, "GET /api/v1/learning/current"]);
    expect(f.auth()).toBe("Bearer synthetic-manual-token-2");
    expect(latest!.actions).toBe(captured);
    await act(() => captured!.retry(A));
    expect(posts(f)).toHaveLength(1); expect(f.auth()).toBe("Bearer synthetic-manual-token-2");
    expect(JSON.parse(String(f.srv.fetcher.mock.calls.at(-1)![1]!.body))).toMatchObject({ command_id: id(90), document_id: id(2) });
  });

  it("a stored intent survives remount into a new document: status only, zero automatic POST, same command by hand", async () => {
    const f = fixture(), first = mount(f);
    await ready(first.ui);
    f.srv.routes.push(() => { throw new TypeError("connection lost"); });
    await act(() => first.ui.result.current.actions.change(A, true));
    expect(state(first.ui)).toMatchObject({ phase: "unresolved", pending: { cardId: A, kind: "learning.select" }, canRetry: true,
      problem: { reason: "network" } });
    first.ui.unmount();
    const saved = f.values.get(pendingKey);
    const options = { ...f.options, access: f.access({ document_id: id(20), document_epoch: "2" }) };
    const ui = renderHook(useManualSelectionDocument, { initialProps: options });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "unresolved", pending: { cardId: A }, canRetry: true }));
    await flush();
    expect(posts(f)).toHaveLength(1); expect(f.values.get(pendingKey)).toBe(saved);
    await act(() => ui.result.current.actions.retry(B));
    expect(posts(f)).toHaveLength(1);
    await act(() => ui.result.current.actions.retry(A.toUpperCase()));
    expect(posts(f)).toHaveLength(2);
    const [firstPost, secondPost] = f.srv.fetcher.mock.calls.filter(([, init]) => init!.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
    expect(secondPost).toEqual({ ...firstPost, document_id: id(20) });
    expect(state(ui)).toMatchObject({ phase: "ready", pending: null, outcome: { commandId: id(100), cardId: A, status: "accepted" } });
    expect(f.newId).toHaveBeenCalledTimes(1);
  });

  it("an intent already committed is recovered by status after remount without a POST", async () => {
    const f = fixture(), first = mount(f);
    await ready(first.ui);
    f.srv.routes.push((path, init) => { f.srv.handle(path, init); throw new TypeError("reply lost"); });
    await act(() => first.ui.result.current.actions.change(A, true));
    first.ui.unmount();
    const ui = renderHook(useManualSelectionDocument, { initialProps: { ...f.options, access: f.access() } });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "ready", pending: null,
      outcome: { commandId: id(100), cardId: A, status: "accepted", stateVersion: "9007199254740994" } }));
    expect(posts(f)).toHaveLength(1); expect(f.values.has(pendingKey)).toBe(false);
  });

  it("a pending intent for one card blocks every card; only that card can retry it", async () => {
    const f = fixture({ seeded: stored(A) }), { ui } = mount(f);
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "unresolved", pending: { cardId: A }, canChange: false, canRetry: true }));
    await act(async () => { await ui.result.current.actions.change(B, true); await ui.result.current.actions.retry(B); });
    await act(async () => { await ui.result.current.actions.retry("not-a-card"); await ui.result.current.actions.change(A, false); });
    expect(posts(f)).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    await act(() => ui.result.current.actions.retry(A));
    expect(posts(f)).toHaveLength(1);
    expect(JSON.parse(String(f.srv.fetcher.mock.calls.at(-1)![1]!.body))).toMatchObject({ command_id: id(90), payload: { card_id: A } });
  });

  it.each([
    ["another pair", { pair: "en-de" as Pair }, "pair_changed"],
    ["another client", { client: id(77) }, "client_changed"],
  ] as const)("a stored intent from %s is checked, never re-sent, and keeps its expected pair", async (_name, change, reason) => {
    const seeded = stored(A, "client" in change ? { clientInstanceId: change.client } : {});
    const f = fixture({ seeded });
    if ("pair" in change) f.srv.pair = change.pair;
    const options = "pair" in change ? { ...f.options, access: f.access({ profile: { ...f.base.profile, dictionary_language: "en" } }) } : f.options;
    const ui = renderHook(useManualSelectionDocument, { initialProps: options });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "unresolved", canRetry: false, canChange: false, problem: { reason } }));
    await act(() => ui.result.current.actions.retry(A));
    expect(posts(f)).toEqual([]); expect(JSON.parse(f.values.get(pendingKey)!)).toEqual(seeded);
  });

  it("an intent of another profile is removed without status or POST", async () => {
    const f = fixture({ seeded: stored(A, { profileId: id(66) }) }), { ui } = mount(f);
    await ready(ui);
    expect(f.calls()).toEqual(["GET /api/v1/learning/current"]); expect(f.values.has(pendingKey)).toBe(false);
    expect(f.values.get("unrelated")).toBe("keep");
  });

  it("a payload mismatch stays unresolved across remount with no automatic confirmation or retry", async () => {
    const f = fixture({ seeded: stored(A) });
    f.srv.commands.set(id(90), { body: JSON.stringify({ kind: "learning.unselect", payload: { card_id: B, expected_pair: "ru-de" },
      expected_selection_version: "1" }), cardId: B, kind: "learning.unselect" });
    f.srv.routes.push(() => response({ command: { id: id(90), status: "not_found" }, current: { ...f.base.profile }, state_version: String(f.srv.state) }));
    const first = mount(f);
    await waitFor(() => expect(state(first.ui)).toMatchObject({ phase: "unresolved", canRetry: true }));
    await act(() => first.ui.result.current.actions.retry(A));
    expect(state(first.ui)).toMatchObject({ phase: "unresolved", canRetry: false, problem: { reason: "mismatch" }, pending: { cardId: A } });
    first.ui.unmount();
    const ui = renderHook(useManualSelectionDocument, { initialProps: { ...f.options, access: f.access() } });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "unresolved", problem: { reason: "mismatch" }, canRetry: false }));
    await act(() => ui.result.current.actions.retry(A));
    expect(posts(f)).toHaveLength(1); expect(JSON.parse(f.values.get(pendingKey)!).mismatch).toBe(true);
  });

  it.each(["visibilitychange", "pageshow"])("%s stops accepting the old handle's results and rights until a new access", async event => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    const held = deferred<Response>(); f.srv.routes.push(() => held.promise);
    let sending!: Promise<void>; act(() => { sending = ui.result.current.actions.change(A, true); });
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    act(() => { if (event === "visibilitychange") { visible("hidden"); document.dispatchEvent(new Event(event)); } else window.dispatchEvent(new Event(event)); });
    expect(state(ui)).toEqual({ phase: "loading", problem: null, pending: null, outcome: null, canChange: false, canRetry: false });
    visible("visible");
    await act(async () => { held.resolve(denial(401)); await sending; });
    await act(async () => { await ui.result.current.actions.refresh(); await ui.result.current.actions.retry(A); });
    ui.rerender(f.options); await flush();
    expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
    expect(f.calls()).toHaveLength(2); expect(state(ui).phase).toBe("loading");
    ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "unresolved", pending: { cardId: A }, problem: { reason: "not_found" } }));
    expect(f.calls().slice(2)).toEqual([`GET /api/v1/commands/${id(100)}`, "GET /api/v1/learning/current"]);
    expect(f.auth()).toBe("Bearer synthetic-manual-token-2"); expect(posts(f)).toHaveLength(1);
  });

  it("hidden before mount never reads; visibility alone does not restore rights", async () => {
    visible("hidden");
    const f = fixture(), { ui } = mount(f);
    await flush(); expect(f.srv.fetcher).not.toHaveBeenCalled();
    visible("visible"); act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(() => ui.result.current.actions.refresh()); ui.rerender(f.options); await flush();
    expect(f.srv.fetcher).not.toHaveBeenCalled(); expect(state(ui).phase).toBe("loading");
    ui.rerender({ ...f.options, access: f.access() }); await ready(ui);
    expect(f.calls()).toEqual(["GET /api/v1/learning/current"]);
  });

  it("an access closed by its owner is not a new refusal: no denial, no publication", async () => {
    const f = fixture(), held = deferred<Response>(); f.srv.routes.push(() => held.promise);
    const { ui, seen } = mount(f);
    await waitFor(() => expect(f.srv.fetcher).toHaveBeenCalledTimes(1));
    f.revoke(); ui.rerender(f.options);
    await act(async () => { held.resolve(denial(403)); await Promise.resolve(); }); await flush();
    expect(f.denied).not.toHaveBeenCalled();
    expect(state(ui)).toEqual({ phase: "disposed", problem: null, pending: null, outcome: null, canChange: false, canRetry: false });
    expect(seen.some(view => view.problem !== null)).toBe(false);
  });

  it("disabled reads nothing; enabling opens with a read", async () => {
    const f = fixture(), ui = renderHook(useManualSelectionDocument, { initialProps: { ...f.options, enabled: false } });
    await flush(); await act(() => ui.result.current.actions.refresh());
    expect(f.srv.fetcher).not.toHaveBeenCalled(); expect(state(ui).phase).toBe("idle");
    ui.rerender(f.options); await ready(ui);
    expect(f.calls()).toEqual(["GET /api/v1/learning/current"]);
  });

  it("versions above 2^53: an older read than the confirmed profile is stale, not permission; no automatic retry", async () => {
    const f = fixture({ start: 9007199254740993n, profileVersion: "9007199254740995" }), { ui } = mount(f);
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "blocked", problem: { reason: "stale" }, canChange: false }));
    await flush(); await act(() => ui.result.current.actions.change(A, true));
    expect(f.calls()).toEqual(["GET /api/v1/learning/current"]);
    f.srv.state = 9007199254740995n; await act(() => ui.result.current.actions.refresh());
    expect(state(ui)).toMatchObject({ phase: "ready", canChange: true, problem: null });
  });

  it("a raised host minimum re-reads once, and a rebind cannot roll back a known version", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    await act(() => ui.result.current.actions.change(A, true));
    expect(state(ui).outcome?.stateVersion).toBe("9007199254740994");
    ui.rerender({ ...f.options, minimumStateVersion: "9007199254740997" });
    expect(state(ui)).toMatchObject({ canChange: false, problem: { reason: "stale" } });
    await flush(); ui.rerender({ ...f.options, minimumStateVersion: "9007199254740997" }); await flush();
    expect(f.calls().filter(call => call === "GET /api/v1/learning/current")).toHaveLength(2);
    expect(state(ui)).toMatchObject({ phase: "blocked", problem: { reason: "stale" } });
    // A replica-like older reply after a same-key rebind is masked by the retained floor.
    f.srv.routes.push(() => response({ ...f.srv.current(), state_version: "9007199254740993" }));
    ui.rerender({ ...f.options, access: f.access(), minimumStateVersion: undefined });
    await waitFor(() => expect(f.calls().filter(call => call === "GET /api/v1/learning/current")).toHaveLength(3));
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "blocked", canChange: false, problem: { reason: "stale" } }));
    f.srv.state = 9007199254740997n; await act(() => ui.result.current.actions.refresh());
    expect(state(ui)).toMatchObject({ phase: "ready", canChange: true });
  });

  it("detached state: mutating a returned view does not change the next render or a replayed payload", async () => {
    const f = fixture({ seeded: stored(A) }), { ui } = mount(f);
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "unresolved", canRetry: true }));
    const view = state(ui); view.pending!.cardId = B; view.canChange = true;
    ui.rerender(f.options);
    expect(state(ui).pending?.cardId).toBe(A);
    await act(() => ui.result.current.actions.retry(B)); expect(posts(f)).toEqual([]);
    await act(() => ui.result.current.actions.retry(A));
    expect(JSON.parse(String(f.srv.fetcher.mock.calls.at(-1)![1]!.body)).payload.card_id).toBe(A);
    expect(JSON.stringify(f.srv.fetcher.mock.calls)).not.toContain(ACCESS_BOUND_MARKER);
  });

  it.each([
    ["an unknown dictionary language", (f: F) => ({ ...f.options, access: f.access({ profile: { ...f.base.profile, dictionary_language: "de" as "ru" } }) })],
    ["an invalid minimum version", (f: F) => ({ ...f.options, minimumStateVersion: "01" })],
  ])("%s throws during render and sends nothing", async (_name, make) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture(), options = make(f);
    expect(() => renderHook(useManualSelectionDocument, { initialProps: options })).toThrow();
    await flush(); expect(f.srv.fetcher).not.toHaveBeenCalled();
  });
});

describe("F2: an outcome carries the top-level state_version of its own reply, not current data", () => {
  // The dictionary language is changed in another window; this document still holds the ru-de handle.
  const elsewhere = (f: F) => { f.srv.pair = "uk-de"; f.srv.state += 3n; };

  it("409 VERSION_CONFLICT with another pair: the reply version, which also floors a later binding", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui); elsewhere(f);
    await act(() => ui.result.current.actions.change(A, true));
    expect(state(ui)).toMatchObject({ canChange: false, problem: { reason: "pair_changed" }, outcome: { commandId: id(100), cardId: A,
      status: "rejected", code: "VERSION_CONFLICT", stateVersion: "9007199254740996" } });
    f.srv.routes.push(() => response({ ...f.srv.current(), state_version: "9007199254740995" }));
    ui.rerender({ ...f.options, access: f.access({ profile: { ...f.base.profile, dictionary_language: "uk" } }) });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "blocked", canChange: false, problem: { reason: "stale" } }));
  });

  it.each(["retry", "refresh"] as const)("a committed POST with a lost reply, then a language change: %s gives accepted with the reply version", async path => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    f.srv.routes.push((route, init) => { f.srv.handle(route, init); throw new TypeError("reply lost"); });
    await act(() => ui.result.current.actions.change(A, true));
    expect(state(ui)).toMatchObject({ phase: "unresolved", canRetry: true });
    elsewhere(f);
    await act(() => path === "retry" ? ui.result.current.actions.retry(A) : ui.result.current.actions.refresh());
    expect(posts(f)).toHaveLength(path === "retry" ? 2 : 1);
    expect(state(ui)).toMatchObject({ pending: null, problem: { reason: "pair_changed" },
      outcome: { commandId: id(100), cardId: A, status: "accepted", stateVersion: "9007199254740997" } });
  });

  it("status accepted with current unavailable: the top-level reply version, no denial and no POST", async () => {
    const f = fixture({ seeded: stored(A) });
    f.srv.routes.push(() => response({ command: { id: id(90), kind: "learning.select", status: "already_applied",
      applied_at: "2026-10-01T00:00:00Z", target_id: A, action_id: null, result_id: null, context_id: null, object_version: "9007199254740994" },
      current: { status: "unavailable" }, state_version: "9007199254740999" }));
    const { ui } = mount(f);
    await waitFor(() => expect(state(ui).outcome).not.toBeNull());
    expect(state(ui)).toEqual({ phase: "blocked", problem: { reason: "forbidden" }, pending: null, canChange: false, canRetry: false,
      outcome: { commandId: id(90), cardId: A, status: "accepted", stateVersion: "9007199254740999" } });
    expect(f.denied).not.toHaveBeenCalled(); expect(f.values.has(pendingKey)).toBe(false); expect(posts(f)).toEqual([]);
  });
});

describe("F1: an interrupted render never becomes the current binding", () => {
  function scene(f: F) {
    const never = new Promise<never>(() => undefined);
    const ref = { set: null as null | ((options: ManualSelectionDocumentOptions) => void), committed: null as Hook | null,
      journal: [] as string[], suspend: null as ManualSelectionDocumentOptions | null };
    function Host({ options }: { options: ManualSelectionDocumentOptions }): ReactNode {
      const doc = useManualSelectionDocument(options), name = options === f.options ? "A" : "B";
      ref.journal.push(`render:${name}`);
      useLayoutEffect(() => { ref.journal.push(`commit:${name}`); ref.committed = doc; });
      return null;
    }
    function Gate({ options }: { options: ManualSelectionDocumentOptions }): ReactNode {
      if (options === ref.suspend) throw never;
      return null;
    }
    function Root(): ReactNode {
      const [options, set] = useState(f.options);
      useLayoutEffect(() => { ref.set = set; });
      return createElement(Suspense, { fallback: createElement("p", { "data-fallback": "" }) },
        createElement(Host, { options }), createElement(Gate, { options }));
    }
    return { ref, view: render(createElement(Root)) };
  }

  it.each([
    ["another document of the profile with a maximal minimum", (f: F) => ({ ...f.options, access: f.sibling({ document_id: id(20) }),
      minimumStateVersion: "9223372036854775807" })],
    ["another profile with a maximal version", (f: F) => ({ ...f.options, access: f.sibling({
      profile: { ...f.base.profile, profile_id: id(66), state_version: "9223372036854775807" } }) })],
  ])("suspended render of %s: committed A keeps its rights and floor; A's current 401 revokes A", async (_name, make) => {
    const f = fixture(), { ref, view } = scene(f);
    await waitFor(() => expect(ref.committed?.state).toMatchObject({ phase: "ready", canChange: true }));
    const other = make(f); ref.suspend = other;
    act(() => { startTransition(() => ref.set!(other)); });
    await flush();
    expect(ref.journal).toContain("render:B"); expect(ref.journal).not.toContain("commit:B");
    expect(view.container.querySelector("[data-fallback]")).toBeNull();
    const held = deferred<Response>(); f.srv.routes.push(() => held.promise);
    let sending!: Promise<void>; act(() => { sending = ref.committed!.actions.change(A, true); });
    await waitFor(() => expect(posts(f)).toHaveLength(1));
    expect(f.auth()).toBe("Bearer synthetic-manual-token-1");
    await act(async () => { held.resolve(denial(401)); await sending; });
    expect(f.denied).toHaveBeenCalledTimes(1);
    expect(f.options.access.isLive()).toBe(false); expect(other.access.isLive()).toBe(true);
    expect(ref.journal).not.toContain("commit:B");
    expect(f.srv.fetcher.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).Authorization))
      .not.toContain("Bearer synthetic-manual-token-sibling");
  });

  it("switching to another profile and back does not roll back the first profile's known version", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    await act(() => ui.result.current.actions.change(A, true));
    expect(state(ui).outcome?.stateVersion).toBe("9007199254740994");
    ui.rerender({ ...f.options, access: f.access({ profile: { ...f.base.profile, profile_id: id(66), state_version: "1" } }) });
    await ready(ui);
    f.srv.routes.push(() => response({ ...f.srv.current(), state_version: "9007199254740993" }));
    ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "blocked", canChange: false, problem: { reason: "stale" } }));
  });
});
