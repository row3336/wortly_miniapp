import { StrictMode, Suspense, createElement, startTransition, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { DictionaryIntervalSnapshot } from "./dictionaryIntervalController";
import {
  useDictionaryIntervalContext, type DictionaryIntervalContextActions, type DictionaryIntervalContextOptions,
} from "./useDictionaryIntervalContext";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CARD = id(1), CLIENT = id(3), PROFILE = id(5), TODAY = "2026-09-29";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); }
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
};

type Route = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
/** Core-shaped dictionary context server: the A01 written direction (core C-INTV), accepted facts, idempotent replay, status with profile. */
function server() {
  const s = { state: 9007199254740993n, saved: false, contexts: new Map<string, "open" | "closed">(),
    commands: new Map<string, Record<string, unknown>>(), routes: [] as Route[], next: 500,
    right: null as null | { action: string; context: string } };
  const A01: Array<[number, number]> = [[2, 3], [3, 5], [4, 8]];
  const project = (contextId: string) => {
    const status = s.contexts.get(contextId);
    if (!status) return { status: "unavailable" };
    const context = { id: contextId, kind: "dictionary", card_id: CARD };
    if (status === "closed") return { status, context };
    const option = (option_id: number, days: number) => ({ option_id, interval_days: days, next_due_date: addDays(TODAY, days) });
    return { status, context,
      view: { status: "available",
        content: { pair: "ru-de", card: { id: CARD, revision: "3", lemma: "Haus", type: "noun", cefr: "A1" },
          translations: { common: ["дом"], personal: null }, grammar: null, reference_conjugations: [],
          examples: { common: [], personal: null }, association: null, field_versions: { translation: "1", example: "1", association: "1" } },
        study: { status: "available", card_id: CARD, card_revision: "3", pair: "ru-de", card_type: "noun", local_date: TODAY,
          facts: { common_translation_present: true, exclusion: { excluded: false, version: null }, manual: { selected: false, selection_version: "1" },
            learning: { ever_selected: true, finished_or_skipped: true, current: null }, non_learning_history: false },
          directions: [s.saved
            ? { direction: "l1-de", introduced: true, progress_present: true, progress_version: "1", schedule: { interval_days: 3, next_due_date: addDays(TODAY, 3) }, interval_preview: [] }
            : { direction: "l1-de", introduced: true, progress_present: false, progress_version: null, schedule: null, interval_preview: null },
            { direction: "de-l1", introduced: true, progress_present: false, progress_version: null, schedule: null, interval_preview: null }] },
        card_actions: { exclude: true, return: false, relearn: true } },
      interval: { local_date: TODAY, expected_pair: "ru-de", direction: "l1-de", applicable: true, ...(s.saved
        ? { current_schedule: { interval_days: 3, next_due_date: addDays(TODAY, 3), persisted: true }, expected_progress_version: "1", options: [],
          default_option_id: null }
        : { current_schedule: { interval_days: 1, next_due_date: TODAY, persisted: false }, expected_progress_version: null,
          options: A01.map(([o, d]) => option(o, d)), default_option_id: 4 }) },
      capabilities: { interval_increase: s.saved ? null : { direction: "l1-de" },
        // This fake server shows the offer already opened (core C-INTV-OFFER); open/close is M-INTV.
        undo_offer: s.right && s.right.context === contextId
          ? { action_id: s.right.action, context_id: contextId, status: "offered", version: "2" } : null,
        undo_target: s.right && s.right.context === contextId
          ? { action_id: s.right.action, kind: "interval.increase", version: "1", context_id: contextId } : null } };
  };
  const reply = (command: unknown, contextId: string | null, extra = {}) =>
    json({ command, current: contextId ? project(contextId) : { status: "unavailable" }, state_version: String(s.state), ...extra });
  const handle = (path: string, init: RequestInit): Response => {
    const url = new URL(path, "http://local");
    if (url.pathname === "/api/v1/commands" && init.method === "POST") {
      const body = JSON.parse(String(init.body));
      const known = s.commands.get(body.command_id);
      if (known) return reply({ ...known, status: "already_applied" }, known.context_id as string);
      let contextId: string = body.context_id, fields: Record<string, unknown> = {};
      if (body.kind === "context.open") { for (const key of s.contexts.keys()) s.contexts.set(key, "closed"); contextId = id(s.next++); s.contexts.set(contextId, "open"); s.right = null; }
      else if (body.kind === "context.close") { s.contexts.set(contextId, "closed"); s.right = null; }
      else if (body.kind === "interval.increase") {
        s.saved = body.payload.direction === "l1-de";
        const action = id(s.next++); fields = { action_id: action, object_version: "1" }; s.right = { action, context: contextId };
      }
      s.state++;
      const fact = { id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-09-29T12:00:00Z", target_id: CARD,
        action_id: null, result_id: null, context_id: contextId, object_version: null, ...fields };
      s.commands.set(body.command_id, fact);
      return reply(fact, contextId);
    }
    const context = /^\/api\/v1\/dictionary\/contexts\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (context) return json({ current: project(context[1]), state_version: String(s.state) });
    const status = /^\/api\/v1\/commands\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (status) {
      const known = s.commands.get(status[1]);
      return known ? reply({ ...known, status: "already_applied" }, known.context_id as string, { verified_intent_hash: url.searchParams.get("expected_intent_hash") })
        : json({ command: { id: status[1], status: "not_found" }, state_version: String(s.state), current: { profile_id: PROFILE,
          access: { status: "admitted", version: "1", reason: null }, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: String(s.state) } });
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const route = s.routes.shift(), path = String(input);
    return (route && await route(path, init!)) ?? handle(path, init!);
  });
  return Object.assign(s, { fetcher, handle });
}

function fixture() {
  const srv = server();
  let active: OpenedAccess | null = null, serial = 0, next = 100;
  const denied = vi.fn();
  const base: OpenedClient = { status: "opened", client_instance_id: CLIENT, document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
      state_version: "9007199254740993", access: { status: "admitted", version: "1", reason: null } },
    session: null, compatibility: { compatible: true, contract_version: "1" } };
  const access = (patch: Partial<OpenedClient> = {}) => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened: { ...base, ...patch }, token: `synthetic-interval-token-${++serial}`, proof: `synthetic-interval-proof-${serial}`,
      generation: 1, isLive: () => active === bound, onDenied: error => { denied(error); if (active === bound) active = null; } });
    active = bound; return bound;
  };
  /** A handle that does not replace the current one; it stays live until denied. */
  const sibling = (patch: Partial<OpenedClient> = {}) => {
    let live = true;
    return createOpenedAccess({ opened: { ...base, ...patch }, token: "synthetic-interval-token-sibling", proof: "synthetic-interval-proof-sibling",
      generation: 1, isLive: () => live, onDenied: error => { denied(error); live = false; } });
  };
  const transport = { fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 };
  const options: DictionaryIntervalContextOptions = { access: access(), transport, cardId: CARD, enabled: true, newId: () => id(next++) };
  const calls = () => srv.fetcher.mock.calls.map(([url, init]) => `${init!.method} ${new URL(String(url), "http://local").pathname}`);
  const auth = (n = -1) => (srv.fetcher.mock.calls.at(n)![1]!.headers as Record<string, string>).Authorization;
  const posts = () => srv.fetcher.mock.calls.filter(([, init]) => init!.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
  return { srv, base, access, sibling, denied, options, calls, auth, posts };
}
type F = ReturnType<typeof fixture>;
type Hook = { state: DictionaryIntervalSnapshot; actions: DictionaryIntervalContextActions };
function mount(f: F, strict = false) {
  const seen: DictionaryIntervalSnapshot[] = [];
  const ui = renderHook((options: DictionaryIntervalContextOptions) => {
    const result = useDictionaryIntervalContext(options); seen.push(result.state); return result;
  }, { initialProps: f.options, wrapper: strict ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) : undefined });
  return { ui, seen };
}
const state = (ui: { result: { current: Hook } }) => ui.result.current.state;
const ready = (ui: { result: { current: Hook } }) => waitFor(() => expect(state(ui)).toMatchObject({ phase: "ready", canIncrease: true }));

describe("dictionary interval context hook with real access, controller and API", () => {
  it("StrictMode opens one context with one POST and publishes no credentials", async () => {
    const f = fixture(), { ui, seen } = mount(f, true);
    await ready(ui); await flush();
    expect(f.calls()).toEqual(["POST /api/v1/commands"]);
    expect(f.posts()[0]).toMatchObject({ kind: "context.open", payload: { card_id: CARD }, client_instance_id: CLIENT, document_id: id(2) });
    expect(f.auth()).toBe("Bearer synthetic-interval-token-1");
    expect(JSON.stringify(seen)).not.toMatch(/synthetic-interval|token|proof/);
  });

  it("enabled=false does no IO; unmount disposes without a close request", async () => {
    const f = fixture();
    const idle = renderHook(useDictionaryIntervalContext, { initialProps: { ...f.options, enabled: false } });
    await flush();
    expect(idle.result.current.state.phase).toBe("idle"); expect(f.srv.fetcher).not.toHaveBeenCalled();
    idle.unmount();
    const { ui } = mount(f);
    await ready(ui);
    ui.unmount(); await flush();
    expect(f.calls()).toEqual(["POST /api/v1/commands"]);
  });

  it("close hides the offer at once and sends context.close; a second close repeats nothing", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    let closing!: Promise<void>;
    act(() => { closing = ui.result.current.actions.close(); });
    expect(state(ui)).toMatchObject({ phase: "closed", canIncrease: false, canUndo: false });
    await act(async () => { held.resolve(); await closing; });
    await act(() => ui.result.current.actions.close());
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "context.close"]);
  });

  it("a new handle of the same document (foreground) reads the same context; its pending command is checked by status, not re-sent", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    f.srv.routes.push((path, init) => { f.srv.handle(path, init); throw new TypeError("reply lost"); }, () => { throw new TypeError("offline"); });
    await act(() => ui.result.current.actions.increase({ option_id: 2 }));
    expect(state(ui)).toMatchObject({ pending: { kind: "interval.increase", status: "unknown" }, canRetry: true });
    visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); visible("visible");
    await flush();
    expect(state(ui)).toMatchObject({ phase: "opening", canIncrease: false, canRetry: false });
    const count = f.calls().length;
    ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "ready", pending: null }));
    expect(f.calls().slice(count)).toEqual([`GET /api/v1/commands/${id(101)}`, `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.auth()).toBe("Bearer synthetic-interval-token-2");
    expect(f.posts()).toHaveLength(2);
    expect(state(ui).interval!).toMatchObject({ expected_progress_version: "1" });
  });

  it("another document opens its own context", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    ui.rerender({ ...f.options, access: f.access({ document_id: id(20), document_epoch: "2" }) });
    await waitFor(() => expect(f.posts()).toHaveLength(2));
    await ready(ui);
    expect(f.posts()[1]).toMatchObject({ kind: "context.open", document_id: id(20) });
  });

  it("a late 401 of the replaced handle revokes neither handle", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    const held = deferred<Response>();
    f.srv.routes.push(() => held.promise);
    let reading!: Promise<void>;
    act(() => { reading = ui.result.current.actions.refresh(); });
    const old = f.options.access, next = f.access();
    ui.rerender({ ...f.options, access: next });
    await ready(ui);
    await act(async () => { held.resolve(json({ error: { code: "AUTH_INVALID" } }, 401)); await reading; });
    expect(f.denied).not.toHaveBeenCalled();
    expect(next.isLive()).toBe(true); expect(old.isLive()).toBe(false);
  });
});

describe("F1: an interrupted render never becomes the current binding", () => {
  it("suspended render of another document: committed A sends with its token and its current 401 revokes A", async () => {
    const f = fixture();
    const never = new Promise<never>(() => undefined);
    const ref = { set: null as null | ((options: DictionaryIntervalContextOptions) => void), committed: null as Hook | null,
      journal: [] as string[], suspend: null as DictionaryIntervalContextOptions | null };
    function Host({ options }: { options: DictionaryIntervalContextOptions }): ReactNode {
      const doc = useDictionaryIntervalContext(options), name = options === f.options ? "A" : "B";
      ref.journal.push(`render:${name}`);
      useLayoutEffect(() => { ref.journal.push(`commit:${name}`); ref.committed = doc; });
      return null;
    }
    function Gate({ options }: { options: DictionaryIntervalContextOptions }): ReactNode {
      if (options === ref.suspend) throw never;
      return null;
    }
    function Root(): ReactNode {
      const [options, set] = useState(f.options);
      useLayoutEffect(() => { ref.set = set; });
      return createElement(Suspense, { fallback: createElement("p", { "data-fallback": "" }) },
        createElement(Host, { options }), createElement(Gate, { options }));
    }
    const view = render(createElement(Root));
    await waitFor(() => expect(ref.committed?.state).toMatchObject({ phase: "ready", canIncrease: true }));
    const other = { ...f.options, access: f.sibling({ document_id: id(20) }), minimumStateVersion: "9223372036854775807" };
    ref.suspend = other;
    act(() => { startTransition(() => ref.set!(other)); });
    await flush();
    expect(ref.journal).toContain("render:B"); expect(ref.journal).not.toContain("commit:B");
    expect(view.container.querySelector("[data-fallback]")).toBeNull();
    const held = deferred<Response>(); f.srv.routes.push(() => held.promise);
    let sending!: Promise<void>;
    act(() => { sending = ref.committed!.actions.increase({ option_id: 2 }); });
    await waitFor(() => expect(f.posts()).toHaveLength(2));
    expect(f.auth()).toBe("Bearer synthetic-interval-token-1");
    await act(async () => { held.resolve(json({ error: { code: "AUTH_INVALID" } }, 401)); await sending; });
    expect(f.denied).toHaveBeenCalledTimes(1);
    expect(f.options.access.isLive()).toBe(false); expect(other.access.isLive()).toBe(true);
    expect(f.srv.fetcher.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).Authorization))
      .not.toContain("Bearer synthetic-interval-token-sibling");
  });
});

describe("commit→passive window without act (real React scheduler)", () => {
  it("captured actions do no IO with the old token between layout and passive; afterwards they use the new binding", async () => {
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT;
    env.IS_REACT_ACT_ENVIRONMENT = false;
    const until = async (condition: () => boolean, label: string) => {
      for (let i = 0; i < 400; i++) { if (condition()) return; await new Promise<void>(done => setTimeout(done, 0)); }
      throw new Error(`condition not reached: ${label}`);
    };
    const root = createRoot(document.createElement("div"));
    try {
      const f = fixture(), a1 = f.options, a2 = { ...a1, access: f.sibling() };
      expect(a2.access.key).toBe(a1.access.key);
      const journal: string[] = [], seen = { ready: false, actions: null as DictionaryIntervalContextActions | null, mark: -1 };
      const windowCalls: Promise<void>[] = [];
      function P({ options }: { options: DictionaryIntervalContextOptions }): ReactNode {
        const { actions, state: current } = useDictionaryIntervalContext(options);
        const first = useRef(actions), name = options === a1 ? "A1" : "A2";
        useLayoutEffect(() => { seen.ready = current.canIncrease; seen.actions = first.current; });
        useLayoutEffect(() => {
          journal.push(`layout:${name}`);
          if (name !== "A2") return;
          seen.mark = f.srv.fetcher.mock.calls.length;
          windowCalls.push(first.current.increase({ option_id: 2 }), first.current.undo(),
            first.current.retry(), first.current.refresh());
          // close() in this window is a managed exit (no resume, new context): see the CP5 F-H1 regression.
          let n = 0;
          const tick = () => { if (++n < 200) void Promise.resolve().then(tick); else journal.push(`micro200:io=${f.srv.fetcher.mock.calls.length - seen.mark}`); };
          tick();
        }, [options]);
        useEffect(() => { journal.push(`passive:${name}`); }, [options]);
        return null;
      }
      root.render(createElement(P, { options: a1 }));
      await until(() => journal.includes("passive:A1") && seen.ready, "A1 ready");
      const before = f.srv.fetcher.mock.calls.length;
      root.render(createElement(P, { options: a2 }));
      await until(() => journal.includes("passive:A2") && journal.some(e => e.startsWith("micro200")), "A2 passive");
      await Promise.all(windowCalls);
      const window = journal.indexOf("layout:A2"), micro = journal.findIndex(e => e.startsWith("micro200")), passive = journal.indexOf("passive:A2");
      expect(micro).toBeGreaterThan(window); expect(micro).toBeLessThan(passive);
      expect(journal[micro]).toBe("micro200:io=0");
      await until(() => seen.ready, "A2 ready");
      const after = f.srv.fetcher.mock.calls.slice(before).map(([url, init]) =>
        `${init!.method} ${new URL(String(url), "http://local").pathname} ${(init!.headers as Record<string, string>).Authorization}`);
      expect(after).toEqual([`GET /api/v1/dictionary/contexts/${id(500)} Bearer synthetic-interval-token-sibling`]);
      expect(a1.access.isLive()).toBe(true);
      await seen.actions!.increase({ option_id: 2 });
      expect(f.auth()).toBe("Bearer synthetic-interval-token-sibling");
      expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase"]);
    } finally {
      root.unmount();
      env.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  });
});

describe("CP5 F-H1: a managed close without a live binding ends the old undo for good (CON:147)", () => {
  it("close while the handle is suspended sends nothing through it; the next binding of the same document opens a new context", async () => {
    const f = fixture(), { ui } = mount(f);
    await ready(ui);
    await act(() => ui.result.current.actions.increase({ option_id: 2 }));
    expect(state(ui)).toMatchObject({ canUndo: true, context: { id: id(500) } });
    visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); visible("visible");
    await flush();
    const count = f.calls().length;
    await act(() => ui.result.current.actions.close());
    ui.rerender({ ...f.options, enabled: false });
    await flush();
    expect(f.calls()).toHaveLength(count);
    ui.rerender({ ...f.options, access: f.access(), enabled: true });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "ready", context: { id: id(502) } }));
    await flush();
    expect(f.calls().slice(count)).toEqual(["POST /api/v1/commands"]);
    expect(f.posts().at(-1)).toMatchObject({ kind: "context.open", payload: { card_id: CARD } });
    expect(f.auth()).toBe("Bearer synthetic-interval-token-2");
    expect(state(ui)).toMatchObject({ canUndo: false, capabilities: { undo_target: null } });
  });

  it("close from a child's layout effect in the commit→passive window is not revived by the old binding's cleanup", async () => {
    const f = fixture();
    let captured: DictionaryIntervalContextActions | null = null, latest: Hook | null = null, sentInWindow = -1;
    function Child({ access }: { access: OpenedAccess }): ReactNode {
      // Runs after the commit of a new same-document handle, before the parent's passive effects.
      useLayoutEffect(() => {
        if (!captured || access === f.options.access) return;
        const before = f.srv.fetcher.mock.calls.length;
        void captured.close();
        sentInWindow = f.srv.fetcher.mock.calls.length - before;
      }, [access]);
      return null;
    }
    function Host({ options }: { options: DictionaryIntervalContextOptions }): ReactNode {
      const doc = useDictionaryIntervalContext(options);
      useLayoutEffect(() => { latest = doc; });
      return createElement(Child, { access: options.access });
    }
    const view = render(createElement(Host, { options: f.options }));
    await waitFor(() => expect(latest!.state).toMatchObject({ phase: "ready", canIncrease: true }));
    await act(() => latest!.actions.increase({ option_id: 2 }));
    expect(latest!.state.canUndo).toBe(true);
    captured = latest!.actions;
    const count = f.calls().length;
    view.rerender(createElement(Host, { options: { ...f.options, access: f.access() } }));
    expect(sentInWindow).toBe(0);
    await waitFor(() => expect(latest!.state).toMatchObject({ phase: "ready", context: { id: id(502) } }));
    expect(f.calls().slice(count)).toEqual(["POST /api/v1/commands"]);
    expect(f.posts().at(-1)).toMatchObject({ kind: "context.open" });
    expect(latest!.state).toMatchObject({ canUndo: false, capabilities: { undo_target: null } });
  });
});

describe("CP6 Q1: a pending initial open across a rebind (CON:147, CON:149, B3)", () => {
  it("same document, applied open: the new handle asks status of the original ID; no second open, late reply ignored", async () => {
    const f = fixture(), held = deferred<void>();
    f.srv.routes.push(async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const { ui } = mount(f);
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(state(ui)).toMatchObject({ phase: "opening", pending: { kind: "context.open", commandId: id(100), status: "sending" } });
    const count = f.calls().length;
    ui.rerender({ ...f.options, access: f.access() });
    await ready(ui);
    expect(f.calls().slice(count)).toEqual([`GET /api/v1/commands/${id(100)}`, `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.auth()).toBe("Bearer synthetic-interval-token-2");
    await act(async () => { held.resolve(); });
    await flush();
    expect(f.posts().map(body => body.command_id)).toEqual([id(100)]);
    expect(state(ui)).toMatchObject({ phase: "ready", context: { id: id(500) }, pending: null });
    expect(f.denied).not.toHaveBeenCalled();
  });

  it("same document, open never applied: not_found offers retry; retry repeats the same ID and payload with the new handle", async () => {
    const f = fixture(), held = deferred<void>();
    f.srv.routes.push(async () => { await held.promise; throw new TypeError("connection reset"); });
    const { ui } = mount(f);
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(state(ui)).toMatchObject({ phase: "opening", canRetry: true,
      pending: { kind: "context.open", commandId: id(100), status: "unknown" }, problem: { reason: "not_found" } }));
    await act(async () => { held.resolve(); });
    await flush();
    expect(f.posts()).toHaveLength(1);
    await act(() => ui.result.current.actions.retry());
    expect(f.posts()).toHaveLength(2);
    expect(f.posts()[1]).toEqual(f.posts()[0]);
    expect(f.auth()).toBe("Bearer synthetic-interval-token-2");
    expect(state(ui)).toMatchObject({ phase: "ready", context: { id: id(500) }, pending: null, canRetry: false });
  });

  it("another document opens its own context even while the first open is pending; the late first reply changes nothing", async () => {
    const f = fixture(), held = deferred<void>();
    f.srv.routes.push(async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const { ui } = mount(f);
    await waitFor(() => expect(f.posts()).toHaveLength(1));
    ui.rerender({ ...f.options, access: f.access({ document_id: id(20), document_epoch: "2" }) });
    await ready(ui);
    expect(f.posts().map(body => [body.kind, body.command_id, body.document_id]))
      .toEqual([["context.open", id(100), id(2)], ["context.open", id(101), id(20)]]);
    expect(f.calls().filter(call => call.startsWith("GET /api/v1/commands/"))).toEqual([]);
    await act(async () => { held.resolve(); });
    await flush();
    expect(state(ui)).toMatchObject({ phase: "ready", context: { id: id(501) }, canIncrease: true });
    expect(f.posts()).toHaveLength(2);
  });
});
