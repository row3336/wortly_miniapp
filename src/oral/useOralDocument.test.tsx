import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, OralSessionProjection } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { oralIntentHash, type OralCommand, type OralIntent } from "./oralIntent";
import { OralSessionPendingStore, OralStopPendingStore } from "./oralPending";
import { useOralDocument, type OralDocumentHookOptions } from "./useOralDocument";
import { testGate } from "../commands/testGate.test-support";
import { pendingRaw, hasPending, seedRaw } from "../commands/pendingSeed.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const studyKey = "wortly.pending.oral_session";
function projection(step: "prefetched" | "presented" | "revealed" | "closed" = "prefetched"): OralSessionProjection {
  return { session_id: id(3), status: step === "closed" ? "closed" : "active", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-10-01", bucket: "words", close_reason: step === "closed" ? "stop" : null,
    progress: { completed: 0, total: 1, correct: 0, wrong: 0 },
    assignment: step === "closed" ? null : { id: id(6), card_id: id(7), status: step === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: "Haus", language: "de", conjunction_hint: null },
      ...(step === "revealed" ? { status: "presented", revealed: true, translations: ["дом"] } : { revealed: false }) },
    summary: step === "closed" ? { completed: 0, correct: 0, wrong: 0, ratio: null } : null,
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: step === "presented" ? id(6) : null, grade_target: step === "revealed" ? id(6) : null,
      stop: step !== "closed", summary_home: false } };
}
const response = (value: unknown) => new Response(JSON.stringify(value));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fact(command: OralIntent, status = "applied") {
  const grade = command.kind === "oral.grade";
  return { id: command.command_id, kind: command.kind, status, applied_at: "2026-10-01T12:00:00Z",
    target_id: "assignment_id" in command ? command.assignment_id : command.session_id,
    action_id: grade ? id(10) : null, result_id: grade ? id(11) : null, context_id: null, object_version: grade ? "1" : null };
}
/** This HTTP handler is an explicit client/server model, not an independently verified backend. */
function fixture() {
  let access!: OpenedAccess, live = true, counter = 100, current = projection(), stateVersion = "8";
  const values = new Map<string, string>(), accepted = new Map<string, OralIntent>();
  const storage: AsyncStorage = { get: vi.fn(async k => values.get(k) ?? null), set: vi.fn(async (k, v) => { values.set(k, v); }),
    remove: vi.fn(async k => { values.delete(k); }) };
  const studyStore = new OralSessionPendingStore(storage), stopStore = new OralStopPendingStore(storage);
  const denied = vi.fn(() => { live = false; });
  const base: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "1",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  const replace = (patch: Partial<OpenedClient> = {}, token = "synthetic-token") => {
    const handle: OpenedAccess = createOpenedAccess({ opened: { ...base, ...patch }, token, proof: "synthetic-proof", generation: 1,
      isLive: () => live && access === handle, onDenied: denied });
    access = handle; return access;
  };
  replace();
  const posts: OralCommand[] = [], tokens: string[] = [];
  const handler: typeof fetch = async (url, init) => {
    tokens.push((init?.headers as Record<string, string>).Authorization);
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as OralCommand; posts.push(command);
      const { client_instance_id: _client, document_id: _doc, ...intent } = command; accepted.set(command.command_id, intent);
      current = projection(command.kind === "assignment.present" ? "presented" : command.kind === "oral.reveal" ? "revealed"
        : command.kind === "session.stop" ? "closed" : "prefetched"); stateVersion = String(BigInt(stateVersion) + 1n);
      return response({ command: fact(intent), current, state_version: stateVersion });
    }
    const path = new URL(String(url), "https://model.invalid");
    if (path.pathname.includes("/commands/")) {
      const intent = accepted.get(path.pathname.split("/").at(-1)!)!;
      return response({ command: fact(intent, "already_applied"), verified_intent_hash: await oralIntentHash(intent), current,
        state_version: stateVersion });
    }
    return response({ current, state_version: stateVersion });
  };
  const fetcher = vi.fn<typeof fetch>(handler);
  const options: OralDocumentHookOptions = { access, studyStore, stopStore, initialSessionId: id(3),
    newId: vi.fn(() => id(counter++)), transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() } };
  return { options, values, storage, fetcher, handler, posts, tokens, replace, denied, access: () => access,
    revoke: () => { live = false; }, set: (step: Parameters<typeof projection>[0], version = stateVersion) => { current = projection(step); stateVersion = version; } };
}
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { configurable: true, value: state }); }
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

describe("oral React Adapter: source and gates", () => {
  it("confirmed fresh session remains usable after an unavailable historical foreign receipt is settled", async () => {
    const f = fixture(), historical: OralIntent = { kind: "oral.grade", command_id: id(4), session_id: id(90),
      assignment_id: id(6), payload: { correct: true } };
    seedRaw(f.values, studyKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent: historical }), id(50));
    f.set("prefetched", "13"); f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes(`/commands/${id(4)}?`)) return response({ command: fact(historical, "already_applied"),
        verified_intent_hash: await oralIntentHash(historical), current: { status: "unavailable" }, state_version: "12" });
      return f.handler(url, init);
    });
    const ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("prefetched"));
    expect(hasPending(f.values, studyKey)).toBe(false); expect(f.posts).toEqual([]);
    expect(ui.result.current.state).toMatchObject({ sessionId: id(3), commands: { study: { pending: false, outcome: "accepted" } } });
    await act(() => ui.result.current.actions.shown(ui.result.current.state!.presentationTicket!));
    expect(ui.result.current.state).toMatchObject({ phase: "question", canReveal: true, current: { session_id: id(3) } });
    await act(() => ui.result.current.actions.reveal()); expect(ui.result.current.state?.canGrade).toBe(true);
    expect(f.posts.map(command => [command.kind, command.session_id])).toEqual([["assignment.present", id(3)], ["oral.reveal", id(3)]]);
  });
  it("prefetch is never a visible commit; only forwarded shown sends present", async () => {
    const f = fixture(), ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("prefetched")); expect(f.posts).toEqual([]);
    const ticket = ui.result.current.state!.presentationTicket!;
    await act(() => ui.result.current.actions.shown(ticket)); expect(f.posts.map(v => v.kind)).toEqual(["assignment.present"]);
    expect(ui.result.current.state?.canReveal).toBe(true);
  });
  it("a confirmed oral seed arriving on the same access reads its session and keeps shared recovery", async () => {
    const f = fixture(), options: OralDocumentHookOptions = { ...f.options, initialSessionId: null, enabled: false };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("idle")); expect(f.fetcher).not.toHaveBeenCalled();
    ui.rerender({ ...options, initialSessionId: id(3), enabled: true });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("prefetched"));
    expect(ui.result.current.state?.sessionId).toBe(id(3)); expect(f.posts).toEqual([]);
  });
  it("disabled gate closes on render before effects, including a retained action invoked in layout effect", async () => {
    const f = fixture(); f.set("revealed"); const observed: boolean[] = [];
    const ui = renderHook((options: OralDocumentHookOptions) => {
      const doc = useOralDocument(options);
      observed.push(doc.state?.canGrade ?? false);
      useLayoutEffect(() => { if (options.enabled === false) void doc.actions.grade(true); }, [options.enabled, doc.actions]);
      return doc;
    }, { initialProps: { ...f.options, enabled: true } });
    await waitFor(() => expect(ui.result.current.state?.canGrade).toBe(true)); observed.length = 0;
    ui.rerender({ ...f.options, enabled: false });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("revealed"));
    expect(observed.every(value => !value)).toBe(true); expect(f.posts).toEqual([]); expect(ui.result.current.state?.canStop).toBe(true);
  });
  it("a raised floor hides an older projection during render and retains the floor after publisher removal", async () => {
    const f = fixture(); f.set("revealed", "9007199254740993"); const observed: (string | null)[] = [];
    const ui = renderHook((options: OralDocumentHookOptions) => {
      const doc = useOralDocument(options); observed.push(doc.state?.current?.assignment?.id ?? null); return doc;
    }, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.canGrade).toBe(true)); observed.length = 0;
    ui.rerender({ ...f.options, minimumStateVersion: "9007199254740994" });
    expect(observed.every(value => value === null)).toBe(true); await act(() => ui.result.current.actions.refresh());
    ui.rerender({ ...f.options });
    expect(ui.result.current.state).toMatchObject({ current: null, stateVersion: "9007199254740994", canStop: false });
  });
  it("same-identity new access binds fresh callbacks and retains the maximum floor", async () => {
    const f = fixture(); f.set("revealed", "20"); const ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.canGrade).toBe(true)); const retained = ui.result.current.actions;
    f.set("revealed", "19"); const access = f.replace({}, "fresh-synthetic-token"); ui.rerender({ ...f.options, access });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("stale"));
    expect(ui.result.current.state).toMatchObject({ current: null, stateVersion: "20" }); await act(() => retained.grade(true));
    expect(f.posts).toEqual([]); f.set("presented", "21"); await act(() => retained.refresh()); await act(() => retained.reveal());
    expect(f.posts).toHaveLength(1); expect(f.tokens.at(-1)).toBe("Bearer fresh-synthetic-token");
  });
  it("known closed session survives same-identity access replacement despite a later active projection", async () => {
    const f = fixture(); f.set("revealed"); const ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.canStop).toBe(true)); await act(() => ui.result.current.actions.stop("stop"));
    expect(ui.result.current.state?.phase).toBe("closed"); f.set("revealed", "99");
    ui.rerender({ ...f.options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("closed")); expect(ui.result.current.state?.current).toBeNull();
  });
  it("full identity change masks old state before effects and does not transfer a prior floor", async () => {
    const f = fixture(); f.set("revealed", "99"); const observations: (string | null)[] = [];
    const ui = renderHook((options: OralDocumentHookOptions) => { const doc = useOralDocument(options);
      observations.push(doc.state?.current?.assignment?.id ?? null); return doc;
    }, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.canGrade).toBe(true)); observations.length = 0;
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const access = f.replace({ document_id: id(90) }); ui.rerender({ ...f.options, access });
    expect(observations.every(value => value === null)).toBe(true);
    gate.resolve(response({ current: projection("presented"), state_version: "8" }));
    await waitFor(() => expect(ui.result.current.state?.canReveal).toBe(true)); expect(ui.result.current.state?.stateVersion).toBe("8");
  });
});

describe("oral React Adapter: visibility and lifetime", () => {
  it.each([
    { replacement: "transport", status: 401 }, { replacement: "transport", status: 403 },
    { replacement: "seed", status: 401 }, { replacement: "seed", status: 403 },
  ])("late old read $status after $replacement replacement cannot revoke unchanged live access", async ({ replacement, status }) => {
    const f = fixture(), old = deferred<Response>(); f.fetcher.mockReturnValueOnce(old.promise);
    const ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    const session = replacement === "seed" ? id(90) : id(3);
    const freshRead = async () => response({ current: { ...projection("presented"), session_id: session }, state_version: "13" });
    let next: OralDocumentHookOptions;
    if (replacement === "transport") next = { ...f.options, transport: { ...f.options.transport, fetcher: vi.fn<typeof fetch>(freshRead) } };
    else { f.fetcher.mockImplementation(freshRead); next = { ...f.options, initialSessionId: session }; }
    ui.rerender(next); await waitFor(() => expect(ui.result.current.state?.canReveal).toBe(true));
    expect(next.access).toBe(f.options.access); expect(next.access.isLive()).toBe(true);
    await act(async () => { old.resolve(new Response(JSON.stringify({ error: { code: "ACCESS_DENIED" } }), { status })); });
    ui.rerender(next);
    expect(f.denied).not.toHaveBeenCalled(); expect(next.access.isLive()).toBe(true);
    expect(ui.result.current.state).toMatchObject({ phase: "question", sessionId: session, canReveal: true, stateVersion: "13" });
    expect(f.posts).toEqual([]);
  });
  it.each(["visibilitychange", "pageshow"])("%s closes activity synchronously; foreground needs fresh access and a new ticket", async event => {
    const f = fixture(), ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("prefetched")); const old = ui.result.current.state!.presentationTicket!;
    const count = f.fetcher.mock.calls.length;
    act(() => { if (event === "visibilitychange") document.dispatchEvent(new Event(event)); else window.dispatchEvent(new Event(event)); });
    expect(ui.result.current.state).toMatchObject({ current: null, presentationTicket: null, canStart: false });
    expect(f.fetcher).toHaveBeenCalledTimes(count); await act(() => ui.result.current.actions.shown(old)); expect(f.posts).toEqual([]);
    ui.rerender({ ...f.options }); expect(ui.result.current.state?.presentationTicket).toBeNull();
    ui.rerender({ ...f.options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.presentationTicket).not.toBeNull());
    expect(ui.result.current.state?.presentationTicket).not.toBe(old); await act(() => ui.result.current.actions.shown(old)); expect(f.posts).toEqual([]);
  });
  it("a new access supplied while hidden still needs another fresh access after returning", async () => {
    const f = fixture(), ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("prefetched"));
    act(() => { visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    const hidden = f.replace(); ui.rerender({ ...f.options, access: hidden });
    await act(() => ui.result.current.actions.refresh());
    act(() => { visible("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    expect(ui.result.current.state?.presentationTicket).toBeNull();
    ui.rerender({ ...f.options, access: f.replace() }); await waitFor(() => expect(ui.result.current.state?.presentationTicket).not.toBeNull());
    expect(f.posts).toEqual([]);
  });
  it("visibility cancels an explicit start waiting for initial recovery", async () => {
    const f = fixture(), gate = deferred<string | null>(); vi.mocked(f.storage.get).mockReturnValueOnce(gate.promise);
    const ui = renderHook(useOralDocument, { initialProps: { ...f.options, initialSessionId: null } });
    let start!: Promise<void>; act(() => { start = ui.result.current.actions.start("phrases"); });
    act(() => { window.dispatchEvent(new Event("pageshow")); });
    await act(async () => { gate.resolve(null); await start; }); expect(f.posts).toEqual([]); expect(f.options.newId).not.toHaveBeenCalled();
  });
  it("unmount removes listeners and retained actions; late read cannot send or repaint", async () => {
    const f = fixture(), gate = deferred<Response>(), remove = vi.spyOn(document, "removeEventListener"), removeWindow = vi.spyOn(window, "removeEventListener");
    f.fetcher.mockReturnValueOnce(gate.promise); const renders = vi.fn();
    const ui = renderHook((options: OralDocumentHookOptions) => { renders(); return useOralDocument(options); }, { initialProps: f.options });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); const actions = ui.result.current.actions; ui.unmount(); const count = renders.mock.calls.length;
    await act(async () => { gate.resolve(response({ current: projection(), state_version: "8" })); await actions.start("words"); await actions.refresh(); await actions.stop("stop"); });
    expect(renders).toHaveBeenCalledTimes(count); expect(f.posts).toEqual([]);
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function), true);
    expect(removeWindow).toHaveBeenCalledWith("pageshow", expect.any(Function), true);
  });
  it("StrictMode recovers a shared receipt with no automatic command and one shown command", async () => {
    const f = fixture(); const intent: OralIntent = { kind: "oral.reveal", command_id: id(4), session_id: id(3), assignment_id: id(6), payload: {} };
    seedRaw(f.values, studyKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent }), id(50));
    f.set("revealed"); f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("/commands/")) return response({ command: fact(intent, "already_applied"),
        verified_intent_hash: await oralIntentHash(intent), current: projection("revealed"), state_version: "8" });
      return f.handler(url, init);
    });
    const ui = renderHook(useOralDocument, { initialProps: f.options, reactStrictMode: true });
    await waitFor(() => expect(ui.result.current.state?.canGrade).toBe(true)); expect(f.posts).toEqual([]); expect(hasPending(f.values, studyKey)).toBe(false);
    f.set("prefetched", "9"); await act(() => ui.result.current.actions.refresh());
    await act(() => ui.result.current.actions.shown(ui.result.current.state!.presentationTicket!)); expect(f.posts).toHaveLength(1);
  });
  it("denial masks old state and retained callbacks cannot POST", async () => {
    const f = fixture(); f.set("revealed"); const ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.canGrade).toBe(true)); f.revoke(); ui.rerender({ ...f.options });
    expect(ui.result.current.state).toMatchObject({ phase: "disposed", current: null, canGrade: false });
    await act(() => ui.result.current.actions.grade(true)); expect(f.posts).toEqual([]);
  });
  it("replacing the source while a durable save waits prevents the old POST and recovers its receipt", async () => {
    const f = fixture(), ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("prefetched")); const gate = deferred<void>();
    vi.mocked(f.storage.set).mockImplementationOnce(async (k, v) => { await gate.promise; f.values.set(k, v); });
    let shown!: Promise<void>; act(() => { shown = ui.result.current.actions.shown(ui.result.current.state!.presentationTicket!); });
    await waitFor(() => expect(f.storage.set).toHaveBeenCalledOnce());
    // Server model confirms that the retained intent was applied by the old source.
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("/commands/")) { const saved = JSON.parse(pendingRaw(f.values, studyKey)!).intent as OralIntent;
        return response({ command: fact(saved, "already_applied"), verified_intent_hash: await oralIntentHash(saved),
          current: projection("presented"), state_version: "9" }); }
      return f.handler(url, init);
    });
    f.set("presented", "9"); ui.rerender({ ...f.options, access: f.replace({}, "fresh-synthetic-token") });
    await act(async () => { gate.resolve(); await shown; });
    await waitFor(() => expect(ui.result.current.state?.canReveal).toBe(true)); expect(f.posts).toEqual([]); expect(hasPending(f.values, studyKey)).toBe(false);
  });
});

describe("oral React Adapter: own closed address across same-identity access replacement (L2)", () => {
  type Doc = ReturnType<typeof useOralDocument>;
  const stopKey = "wortly.pending.oral_stop";
  /** Test-only server model: the shared fixture always serves session id(3), so every POST, addressed GET and status
   * reply is answered for the session it names. An optional local route answers first. */
  function addressed(f: ReturnType<typeof fixture>, route?: (url: string) => Promise<Response | null>) {
    f.fetcher.mockImplementation(async (url, init) => {
      const local = route ? await route(String(url)) : null;
      if (local) return local;
      const target = new URL(String(url), "https://model.invalid");
      const session = init?.method === "POST" ? (JSON.parse(String(init.body)) as OralCommand).session_id
        : target.pathname.includes("/commands/") ? target.searchParams.get("session_id") : target.pathname.split("/").at(-1);
      const body = await (await f.handler(url, init)).json() as Record<string, unknown>;
      const current = body.current;
      return response(session && typeof current === "object" && current !== null && "session_id" in current
        ? { ...body, current: { ...current, session_id: session } } : body);
    });
  }
  const reads = (f: ReturnType<typeof fixture>, session: string) => f.fetcher.mock.calls
    .filter(([url, init]) => init?.method !== "POST" && String(url).includes(`/sessions/${session}?`)).length;
  async function closeOwn(doc: () => Doc, session: string) {
    await act(() => doc().actions.start("words"));
    await waitFor(() => expect(doc().state).toMatchObject({ sessionId: session, canStop: true }));
    await act(() => doc().actions.stop("stop"));
    await waitFor(() => expect(doc().state).toMatchObject({ phase: "closed", sessionId: session }));
  }

  it("L2-1 a seed-null own closed session keeps its address after same-identity replacement; facts are read once", async () => {
    const f = fixture(); addressed(f); const options = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await closeOwn(() => ui.result.current, id(100));
    const posts = f.posts.length, before = reads(f, id(100));
    ui.rerender({ ...options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.sessionId).toBe(id(100)));
    await waitFor(() => expect(ui.result.current.state?.closed?.summaryRead).toBe("known"));
    expect(ui.result.current.state).toMatchObject({ phase: "closed", canStart: true, closed: { sessionId: id(100), reason: "stop" } });
    expect(reads(f, id(100))).toBe(before + 1); expect(f.posts).toHaveLength(posts);
  });
  it("L2-2 a later own active session clears the retained closed address", async () => {
    const f = fixture(); addressed(f); const options = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await closeOwn(() => ui.result.current, id(100));
    await act(() => ui.result.current.actions.start("words"));
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ sessionId: id(103), phase: "prefetched" }));
    const before = [reads(f, id(100)), reads(f, id(103))];
    ui.rerender({ ...options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("idle"));
    expect(ui.result.current.state?.sessionId).toBeNull(); expect([reads(f, id(100)), reads(f, id(103))]).toEqual(before);
  });
  it("L2-3 an own active session is never carried by the adapter", async () => {
    const f = fixture(); addressed(f); const options = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await act(() => ui.result.current.actions.start("words"));
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ sessionId: id(100), phase: "prefetched" }));
    const posts = f.posts.length, before = reads(f, id(100));
    ui.rerender({ ...options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("idle"));
    expect(ui.result.current.state?.sessionId).toBeNull(); expect(reads(f, id(100))).toBe(before); expect(f.posts).toHaveLength(posts);
  });
  it.each<[string, Partial<OpenedClient>]>([
    ["document", { document_id: id(90) }],
    ["dictionary pair", { profile: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "en", time_zone: "UTC",
      state_version: "1", access: { status: "admitted", version: "1", reason: null } } }],
  ])("L2-4 an identity change (%s) drops the retained closed address", async (_label, patch) => {
    const f = fixture(); addressed(f); const options = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await closeOwn(() => ui.result.current, id(100));
    const before = reads(f, id(100));
    ui.rerender({ ...options, access: f.replace(patch, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("idle"));
    expect(ui.result.current.state?.sessionId).toBeNull(); expect(reads(f, id(100))).toBe(before);
  });
  it("L2-5 a confirmed non-terminal props seed wins over the retained closed address", async () => {
    const f = fixture(); addressed(f); const options: OralDocumentHookOptions = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await closeOwn(() => ui.result.current, id(100));
    f.set("prefetched"); const before = reads(f, id(100));
    ui.rerender({ ...options, initialSessionId: id(3), access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ sessionId: id(3), phase: "prefetched" }));
    expect(reads(f, id(100))).toBe(before);
  });
  it("L2-6 a newer own closed session beats a stale terminal props seed", async () => {
    const f = fixture(); addressed(f); const ui = renderHook(useOralDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state?.canStop).toBe(true));
    await act(() => ui.result.current.actions.stop("stop"));
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "closed", sessionId: id(3) }));
    await closeOwn(() => ui.result.current, id(101));
    const before = reads(f, id(3));
    ui.rerender({ ...f.options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.sessionId).toBe(id(101)));
    await waitFor(() => expect(ui.result.current.state?.closed?.summaryRead).toBe("known"));
    expect(reads(f, id(3))).toBe(before);
  });
  it("L2-7 (uncounted guard) a revoked access exposes no closed address", async () => {
    const f = fixture(); addressed(f); const options = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await closeOwn(() => ui.result.current, id(100));
    const calls = f.fetcher.mock.calls.length; f.revoke(); ui.rerender({ ...options });
    expect(ui.result.current.state).toMatchObject({ phase: "disposed", closed: null }); expect(f.fetcher.mock.calls.length).toBe(calls);
  });
  it("L2-8 (uncounted guard) a remount starts without a retained address", async () => {
    const f = fixture(); addressed(f); const options = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await closeOwn(() => ui.result.current, id(100)); ui.unmount();
    const next = renderHook(useOralDocument, { initialProps: { ...options, access: f.replace({}, "fresh-synthetic-token") } });
    await waitFor(() => expect(next.result.current.state?.phase).toBe("idle")); expect(next.result.current.state?.sessionId).toBeNull();
  });
  it("L2-9 a foreign closed receipt is never adopted as the own address", async () => {
    const f = fixture(), foreign: OralIntent = { kind: "session.stop", command_id: id(5), session_id: id(90), payload: { reason: "stop" } };
    seedRaw(f.values, stopKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent: foreign }), id(50));
    addressed(f, async url => url.includes(`/commands/${id(5)}?`) ? response({ command: fact(foreign, "already_applied"),
      verified_intent_hash: await oralIntentHash(foreign), current: { status: "unavailable" }, state_version: "8" }) : null);
    const options = { ...f.options, initialSessionId: null };
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "idle", terminalSessionIds: [id(90)] }));
    ui.rerender({ ...options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("idle"));
    expect(ui.result.current.state?.sessionId).toBeNull(); expect(reads(f, id(90))).toBe(0);
  });
});

// 2.33 tail (QO-B1): the owner rebuilt on return from the background must not turn a busy session into a generic failure.
describe("oral React Adapter: SESSION_BUSY across a return from the background", () => {
  const busy = (init: { method?: string; body?: unknown } | undefined) => {
    const command = init?.method === "POST" ? JSON.parse(String(init.body)) as OralCommand : null;
    return new Response(JSON.stringify(command
      ? { command: { id: command.command_id, status: "rejected" }, error: { code: "SESSION_BUSY" },
        current: { session_id: command.session_id, status: "not_found" }, state_version: "9" }
      : { error: { code: "SESSION_BUSY" } }), { status: 409 });
  };
  const background = (ui: { rerender(props: OralDocumentHookOptions): void }, f: ReturnType<typeof fixture>, options: OralDocumentHookOptions) => {
    act(() => { visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { visible("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    ui.rerender({ ...options, access: f.replace({}, "fresh-synthetic-token") });
  };

  it("a start refused as SESSION_BUSY: while suspended only loading, after the fresh owner no generic failure", async () => {
    const f = fixture(), options: OralDocumentHookOptions = { ...f.options, initialSessionId: null };
    f.fetcher.mockImplementation(async (url, init) => init?.method === "POST" ? busy(init) : f.handler(url, init));
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state?.canStart).toBe(true));
    await act(() => ui.result.current.actions.start("words"));
    expect(ui.result.current.state).toMatchObject({ problem: "SESSION_BUSY" });
    act(() => { visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    expect(ui.result.current.state).toMatchObject({ phase: "loading", suspended: true });
    act(() => { visible("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    ui.rerender({ ...options, access: f.replace({}, "fresh-synthetic-token") });
    await waitFor(() => expect(ui.result.current.state?.phase).toBe("idle"));
    // Nothing of the refused start survives the rebuild, and nothing claims a failed refresh either.
    expect(ui.result.current.state).toMatchObject({ phase: "idle", sessionId: null, problem: null, canStart: true });
  });

  it("a read refused by the core as SESSION_BUSY is asked again by the fresh owner and says busy again", async () => {
    const f = fixture(), options: OralDocumentHookOptions = { ...f.options };
    f.fetcher.mockImplementation(async (_url, init) => busy(init));
    const ui = renderHook(useOralDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "stale", problem: "SESSION_BUSY" }));
    const reads = f.fetcher.mock.calls.length;
    background(ui, f, options);
    await waitFor(() => expect(f.fetcher.mock.calls.length).toBeGreaterThan(reads));
    expect((f.fetcher.mock.calls.at(-1)![1]!.headers as Record<string, string>).Authorization).toBe("Bearer fresh-synthetic-token");
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "stale", problem: "SESSION_BUSY" }));
  });
});
