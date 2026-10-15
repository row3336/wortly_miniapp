import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, OralSessionProjection } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { oralIntentHash, type OralIntent, type OralCommand } from "./oralIntent";
import { OralSessionPendingStore, OralStopPendingStore } from "./oralPending";
import { OralDocumentController, type OralDocumentOptions } from "./oralDocumentController";
import { testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = (stop = false) => stop ? "wortly.pending.oral_stop" : "wortly.pending.oral_session";
type Step = "prefetched" | "presented" | "revealed" | "summary" | "closed";
function projection(step: Step = "prefetched", session = id(3), assignment = id(6)): OralSessionProjection {
  const active = !["summary", "closed"].includes(step), revealed = step === "revealed";
  return { session_id: session, status: active ? "active" : step as "summary" | "closed", mode: "oral", pair: "ru-de",
    direction: "de-l1", local_date: "2026-10-01", bucket: "phrases", close_reason: step === "closed" ? "stop" : null,
    progress: { completed: active ? 0 : 1, total: 1, correct: active ? 0 : 1, wrong: 0 },
    assignment: active ? { id: assignment, card_id: id(7), status: step === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: "Haus", language: "de", conjunction_hint: null },
      ...(revealed ? { status: "presented", revealed: true, translations: ["дом"] } : { revealed: false }) } : null,
    summary: active ? null : { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: step === "presented" ? assignment : null, grade_target: revealed ? assignment : null,
      stop: step !== "closed", summary_home: step === "summary" } };
}
const profile = (state_version = "1"): OpenedClient["profile"] => ({ profile_id: id(50), role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version, access: { status: "admitted", version: "1", reason: null } });
function fact(intent: OralIntent, status: "applied" | "already_applied" = "applied") {
  const grade = intent.kind === "oral.grade";
  return { id: intent.command_id, kind: intent.kind, status, applied_at: "2026-10-01T12:00:00Z",
    target_id: "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: grade ? id(10) : null, result_id: grade ? id(11) : null, context_id: null, object_version: grade ? "1" : null };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const intents: OralIntent[] = [
  { session_id: id(3), command_id: id(4), kind: "session.start", payload: { mode: "oral", bucket: "phrases" } },
  { session_id: id(3), command_id: id(4), kind: "assignment.present", assignment_id: id(6), payload: {} },
  { session_id: id(3), command_id: id(4), kind: "oral.reveal", assignment_id: id(6), payload: {} },
  { session_id: id(3), command_id: id(4), kind: "oral.grade", assignment_id: id(6), payload: { correct: true } },
  { session_id: id(3), command_id: id(5), kind: "session.stop", payload: { reason: "stop" } },
  { session_id: id(3), command_id: id(5), kind: "session.stop", payload: { reason: "summary_home" } },
];
/** FakeHTTP is a server model: hash fixtures prove client composition, not backend correctness. */
function fixture(config: { saved?: OralIntent[]; seed?: string | null; step?: Step; minimum?: () => string | null } = {}) {
  const values = new Map<string, string>();
  for (const intent of config.saved ?? []) values.set(key(intent.kind === "session.stop"), JSON.stringify({
    schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent }));
  const storage: AsyncStorage = { get: vi.fn(async k => values.get(k) ?? null), set: vi.fn(async (k, v) => { values.set(k, v); }),
    remove: vi.fn(async k => { values.delete(k); }) };
  const studyStore = new OralSessionPendingStore(storage), stopStore = new OralStopPendingStore(storage);
  let live = true, counter = 100, current = projection(config.step), stateVersion = "8";
  const denied = vi.fn(() => { live = false; });
  const access = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1",
    proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } },
    token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => live, onDenied: denied });
  const posted: OralCommand[] = [], gets: string[] = [], accepted = new Map<string, OralIntent>((config.saved ?? []).map(v => [v.command_id, v]));
  const handler: typeof fetch = async (url, options) => {
    const path = new URL(String(url), "https://model.invalid");
    if (options?.method === "POST") {
      const command = JSON.parse(String(options.body)) as OralCommand; posted.push(command);
      const { client_instance_id: _client, document_id: _doc, ...intent } = command;
      accepted.set(command.command_id, intent);
      stateVersion = String(BigInt(stateVersion) + 1n);
      current = command.kind === "session.stop" ? projection("closed", command.session_id)
        : command.kind === "session.start" ? projection("prefetched", command.session_id)
        : command.kind === "assignment.present" ? projection("presented", command.session_id, command.assignment_id)
        : command.kind === "oral.reveal" ? projection("revealed", command.session_id, command.assignment_id)
        : projection("summary", command.session_id);
      return response({ command: fact(intent), current, state_version: stateVersion });
    }
    gets.push(path.pathname + path.search);
    if (path.pathname.includes("/commands/")) {
      const intent = accepted.get(path.pathname.split("/").at(-1)!);
      if (!intent) return response({ command: { id: path.pathname.split("/").at(-1), status: "not_found" },
        current: profile(stateVersion), state_version: stateVersion });
      const hash = await oralIntentHash(intent);
      if (hash !== path.searchParams.get("expected_intent_hash")) return response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
      return response({ command: fact(intent, "already_applied"), verified_intent_hash: hash,
        current: intent.kind === "session.stop" ? projection("closed", intent.session_id) : { ...current, session_id: intent.session_id },
        state_version: stateVersion });
    }
    return response({ current: { ...current, session_id: path.pathname.split("/").at(-1) }, state_version: stateVersion });
  };
  const fetcher = vi.fn<typeof fetch>(handler), newId = vi.fn(() => id(counter++)), updates = vi.fn();
  const options: OralDocumentOptions = { access, transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() },
    studyStore, stopStore, newId, initialSessionId: config.seed === undefined ? id(3) : config.seed,
    minimumStateVersion: config.minimum, onUpdate: updates };
  const controller = new OralDocumentController(options);
  return { controller, options, values, storage, fetcher, handler, posted, gets, accepted, newId, updates, denied,
    set: (step: Step, version = stateVersion, session = id(3), assignment = id(6)) => { current = projection(step, session, assignment); stateVersion = version; },
    revoke: () => { live = false; } };
}

describe("oral document: recovery and explicit start", () => {
  it.each(intents)("recovers $kind without any automatic POST", async intent => {
    const f = fixture({ saved: [intent], step: intent.kind === "session.stop" ? "closed" : "prefetched" });
    await f.controller.refresh(); expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.gets.some(url => url.includes(`/commands/${intent.command_id}?`))).toBe(true);
    expect(f.controller.snapshot().commands[intent.kind === "session.stop" ? "stop" : "study"]).toMatchObject({ pending: false, outcome: "accepted" });
  });
  it("empty seed still checks receipts; different sessions never select a winner", async () => {
    const f = fixture({ seed: null, saved: [intents[3], { ...intents[4], session_id: id(90) }] });
    await f.controller.refresh(); await f.controller.start("phrases");
    expect(f.gets.filter(url => url.includes("/commands/"))).toHaveLength(2);
    expect(f.controller.snapshot()).toMatchObject({ phase: "unknown", sessionId: null, current: null, canStart: false });
    expect(f.posted).toEqual([]);
  });
  it("two unresolved sessions get separate addressed reads regardless of status completion order", async () => {
    const f = fixture({ seed: null, saved: [intents[3], { ...intents[4], session_id: id(90) }] }); f.accepted.clear();
    const original = f.handler, gate = deferred<Response>();
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes(`/commands/${id(4)}?`)) { const reply = await original(url, init); await gate.promise; return reply; }
      return original(url, init);
    });
    const refreshing = f.controller.refresh(); await vi.waitFor(() => expect(f.gets.some(url => url.includes(`/sessions/${id(90)}?`))).toBe(true));
    gate.resolve(response({})); await refreshing;
    expect(f.gets.some(url => url.includes(`/sessions/${id(3)}?`))).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ sessionId: null, current: null, canStart: false,
      commands: { study: { pending: true }, stop: { pending: true } } }); expect(f.posted).toEqual([]);
  });
  // Decision 26.1 А (owner, C171): a start stored before this owner (a reload, another window) is never sent again from here.
  // Its outcome is only checked; a single not_found is no final refusal (the record stays), and no new ID appears.
  it("a retained start left by a reload is only checked: no retry is offered or sent, no new IDs, the record stays (26.1 А)", async () => {
    const f = fixture({ seed: null, saved: [intents[0]] }); f.accepted.clear();
    const original = f.handler;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes(`/sessions/${id(3)}?`) && !f.posted.length
      ? response({ current: { session_id: id(3), status: "not_found" }, state_version: "8" }) : original(url, init));
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ sessionId: null, canStart: false, canRetry: { study: false } });
    expect(f.gets.some(url => url.includes(`/commands/${id(4)}`))).toBe(true);
    await f.controller.retry("study");
    expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ sessionId: null, canStart: false, commands: { study: { pending: true } } });
    await f.controller.recheck();
    expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: { study: false }, commands: { study: { pending: true } } });
  });
  it("a retained start left by a reload that the core created is confirmed by its check, never sent again (26.1 А, R04 А)", async () => {
    const f = fixture({ seed: null, saved: [intents[0]], step: "prefetched" });
    await f.controller.refresh();
    expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.gets.some(url => url.includes(`/commands/${id(4)}?`))).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ canRetry: { study: false },
      commands: { study: { pending: false, outcome: "accepted", resolved: { commandId: id(4), sessionId: id(3) } } } });
  });
  it("requires a bucket and an explicit tap after both durable lanes become ready", async () => {
    const f = fixture({ seed: null }); await f.controller.refresh(); expect(f.controller.snapshot().canStart).toBe(true);
    expect(f.posted).toEqual([]); await Promise.all([f.controller.start("words"), f.controller.start("phrases")]);
    expect(f.posted).toHaveLength(1); expect(f.posted[0]).toMatchObject({ kind: "session.start", payload: { mode: "oral", bucket: "words" } });
    expect(f.newId).toHaveBeenCalledTimes(2); expect(f.controller.snapshot().phase).toBe("prefetched");
  });
  it("disabled mode retains and recovers receipts while blocking study and start", async () => {
    const f = fixture({ saved: [intents[2]] }); f.controller.setActivity({ enabled: false, visible: true });
    await f.controller.refresh(); await f.controller.start("words"); await f.controller.reveal();
    expect(f.gets).not.toHaveLength(0); expect(f.posted).toEqual([]); expect(f.controller.snapshot().canStart).toBe(false);
    expect(f.controller.snapshot().canStop).toBe(true);
  });
});

describe("oral document: owner-bound exchanges before access denial", () => {
  it.each(["read", "status", "pending_read", "send"] as const)("late old %s refusal cannot deny a ready owner sharing globally live access", async route => {
    const saved = route === "status" ? [intents[2]] : route === "pending_read" ? [intents[3]] : [];
    const f = fixture({ saved, step: route === "send" ? "revealed" : "presented" }), old = deferred<Response>();
    let oldWork: Promise<void>;
    if (route === "send") {
      await f.controller.refresh();
      f.fetcher.mockImplementationOnce(async (_url, init) => {
        const command = JSON.parse(String(init!.body)) as OralCommand; f.posted.push(command);
        const { client_instance_id: _client, document_id: _doc, ...intent } = command;
        f.accepted.set(intent.command_id, intent); return old.promise;
      });
      oldWork = f.controller.grade(false); await vi.waitFor(() => expect(f.posted).toHaveLength(1));
      expect(f.values.has(key())).toBe(true);
    } else {
      if (route === "pending_read") {
        f.accepted.clear(); f.fetcher.mockImplementationOnce(f.handler).mockReturnValueOnce(old.promise);
      } else f.fetcher.mockReturnValueOnce(old.promise);
      oldWork = f.controller.refresh();
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(route === "pending_read" ? 2 : 1));
    }
    f.controller.dispose();
    const freshFetch = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/commands/") && route === "pending_read") return response({
        command: fact(intents[3], "already_applied"), verified_intent_hash: await oralIntentHash(intents[3]),
        current: { status: "unavailable" }, state_version: "12" });
      return f.handler(url, init);
    });
    f.set(route === "send" ? "prefetched" : route === "status" ? "revealed" : "presented", "13");
    const next = new OralDocumentController({ ...f.options, transport: { ...f.options.transport, fetcher: freshFetch } });
    await next.refresh();
    expect(next.snapshot().phase).toBe(route === "send" ? "prefetched" : route === "status" ? "revealed" : "question");
    expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
    old.resolve(new Response(JSON.stringify({ error: { code: "ACCESS_DENIED" } }), { status: route === "send" ? 403 : 401 }));
    await oldWork;
    expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
    expect(next.snapshot().phase).toBe(route === "send" ? "prefetched" : route === "status" ? "revealed" : "question");
    expect(f.posted).toHaveLength(route === "send" ? 1 : 0); next.dispose();
  });
  it.each([401, 403])("current owner %s denial remains genuine", async status => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "ACCESS_DENIED" } }), { status }));
    await f.controller.refresh(); expect(f.denied).toHaveBeenCalledOnce(); expect(f.options.access.isLive()).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", current: null, canReveal: false });
  });
  it("accepted in-flight grade settles after enabled=false without losing its durable fact", async () => {
    const f = fixture({ step: "revealed" }); await f.controller.refresh(); const gate = deferred<Response>();
    f.fetcher.mockImplementationOnce(async (...args) => { const reply = await f.handler(...args); await gate.promise; return reply; });
    const grading = f.controller.grade(true); await vi.waitFor(() => expect(f.posted).toHaveLength(1));
    f.controller.setActivity({ enabled: false, visible: true }); gate.resolve(response({})); await grading;
    expect(f.controller.snapshot()).toMatchObject({ phase: "summary", commands: { study: { pending: false, outcome: "accepted" } } });
    expect(f.values.has(key())).toBe(false); expect(f.denied).not.toHaveBeenCalled(); expect(f.posted).toHaveLength(1);
  });
});

describe("oral document: actual shown, reveal, immediate next", () => {
  it("settled historical foreign receipt cannot block fresh confirmed study after shown", async () => {
    const historical: OralIntent = { ...intents[3], session_id: id(90) };
    const f = fixture({ saved: [historical] }); f.set("prefetched", "13");
    f.fetcher.mockImplementationOnce(async () => response({ command: fact(historical, "already_applied"),
      verified_intent_hash: await oralIntentHash(historical), current: { status: "unavailable" }, state_version: "12" }));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "prefetched", sessionId: id(3),
      commands: { study: { pending: false, outcome: "accepted", resolved: { sessionId: id(90) } } } });
    const ticket = f.controller.snapshot().presentationTicket!; expect(ticket).not.toBeNull();
    expect(f.gets).toHaveLength(1); expect(f.gets[0]).toContain(`/sessions/${id(3)}?`); expect(f.posted).toEqual([]);
    await f.controller.shown(ticket);
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", canReveal: true,
      current: { session_id: id(3), assignment: { status: "presented" } } });
    expect(f.posted[0]).toMatchObject({ kind: "assignment.present", session_id: id(3) });
    await f.controller.reveal(); expect(f.controller.snapshot()).toMatchObject({ phase: "revealed", canGrade: true });
    await f.controller.grade(true); expect(f.controller.snapshot().phase).toBe("summary");
  });
  it("settled historical receipt with unavailable current still cannot elect a session without a seed", async () => {
    const historical: OralIntent = { ...intents[3], session_id: id(90) };
    const f = fixture({ saved: [historical], seed: null });
    f.fetcher.mockImplementationOnce(async () => response({ command: fact(historical, "already_applied"),
      verified_intent_hash: await oralIntentHash(historical), current: { status: "unavailable" }, state_version: "12" }));
    await f.controller.refresh(); await f.controller.start("words");
    expect(f.controller.snapshot()).toMatchObject({ phase: "unknown", sessionId: null, current: null,
      presentationTicket: null, canStart: false, canReveal: false, canGrade: false,
      commands: { study: { pending: false, outcome: "accepted" } } }); expect(f.posted).toEqual([]);
  });
  it("historical acceptance with failed clear keeps confirmed study blocked until cleanup succeeds", async () => {
    const historical: OralIntent = { ...intents[3], session_id: id(90) };
    const f = fixture({ saved: [historical] }); f.set("prefetched", "13");
    f.fetcher.mockImplementationOnce(async () => response({ command: fact(historical, "already_applied"),
      verified_intent_hash: await oralIntentHash(historical), current: { status: "unavailable" }, state_version: "12" }));
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage")); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unknown", presentationTicket: null,
      canStart: false, canReveal: false, canGrade: false, commands: { study: { pending: true, outcome: "accepted" } } });
    expect(f.values.has(key())).toBe(true); await f.controller.reveal(); await f.controller.grade(true); expect(f.posted).toEqual([]);
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ phase: "prefetched", commands: { study: { pending: false } } });
    await f.controller.shown(f.controller.snapshot().presentationTicket!); expect(f.controller.snapshot().canReveal).toBe(true);
  });
  it("unresolved foreign intent retains its study gate despite a fresh confirmed projection", async () => {
    const f = fixture({ saved: [{ ...intents[3], session_id: id(90) }] }); f.accepted.clear(); f.set("prefetched", "13");
    await f.controller.refresh(); await f.controller.reveal(); await f.controller.grade(true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "unknown", sessionId: id(3), presentationTicket: null,
      canReveal: false, canGrade: false, commands: { study: { pending: true, outcome: null } } }); expect(f.posted).toEqual([]);
  });
  it("foreign mismatch still blocks study and retry after fresh confirmed read", async () => {
    const historical: OralIntent = { ...intents[3], session_id: id(90) };
    const f = fixture({ saved: [historical] }); f.accepted.set(historical.command_id, { ...historical, payload: { correct: false } } as OralIntent);
    f.set("prefetched", "13"); await f.controller.refresh(); await f.controller.retry("study");
    expect(f.controller.snapshot()).toMatchObject({ phase: "unknown", presentationTicket: null, canReveal: false, canGrade: false,
      commands: { study: { pending: true, outcome: null, problem: "mismatch", canRetry: false } } }); expect(f.posted).toEqual([]);
  });
  it("a stale confirmed read cannot grant study after historical acceptance advances the floor", async () => {
    const historical: OralIntent = { ...intents[3], session_id: id(90) };
    const f = fixture({ saved: [historical] }); f.set("prefetched", "11");
    f.fetcher.mockImplementationOnce(async () => response({ command: fact(historical, "already_applied"),
      verified_intent_hash: await oralIntentHash(historical), current: { status: "unavailable" }, state_version: "12" }));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", stateVersion: "12", current: null,
      presentationTicket: null, canReveal: false, canGrade: false }); expect(f.posted).toEqual([]);
    f.set("prefetched", "13"); await f.controller.refresh(); expect(f.controller.snapshot().phase).toBe("prefetched");
  });
  it("closed confirmed session plus historical unavailable foreign current does not permit a new Start", async () => {
    const historical: OralIntent = { ...intents[3], session_id: id(90) };
    const f = fixture({ saved: [historical] }); f.set("closed", "13");
    f.fetcher.mockImplementationOnce(async () => response({ command: fact(historical, "already_applied"),
      verified_intent_hash: await oralIntentHash(historical), current: { status: "unavailable" }, state_version: "12" }));
    await f.controller.refresh(); await f.controller.start("words");
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", canStart: false, terminalSessionIds: [id(3)] });
    expect(f.posted).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
  });
  it("never presents on refresh/prefetch; rejects duplicate and superseded tickets", async () => {
    const f = fixture(); await f.controller.refresh(); const old = f.controller.snapshot().presentationTicket!;
    await f.controller.refresh(); await f.controller.shown(old); expect(f.posted).toEqual([]);
    const ticket = f.controller.snapshot().presentationTicket!;
    const gate = deferred<Response>(); f.fetcher.mockImplementationOnce(async (...args) => { const reply = await f.handler(...args); await gate.promise; return reply; });
    const presenting = f.controller.shown(ticket); await vi.waitFor(() => expect(f.posted).toHaveLength(1));
    expect(f.controller.snapshot()).toMatchObject({ phase: "visible_unconfirmed", canReveal: false, canGrade: false });
    await f.controller.shown(ticket); await f.controller.reveal(); await f.controller.grade(true);
    expect(f.posted).toHaveLength(1); gate.resolve(response({})); await presenting;
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", canReveal: true });
  });
  it("lost present reply keeps its UUID; GET recovery gives reveal rights without a second POST", async () => {
    const f = fixture(); await f.controller.refresh(); f.fetcher.mockImplementationOnce(async (...args) => { await f.handler(...args); throw new Error("lost"); });
    await f.controller.shown(f.controller.snapshot().presentationTicket!);
    expect(f.controller.snapshot()).toMatchObject({ commands: { study: { pending: true, outcome: null } }, canReveal: false });
    const uuid = f.posted[0].command_id; await f.controller.refresh();
    expect(f.posted).toHaveLength(1); expect(f.gets.some(url => url.includes(uuid))).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", canReveal: true });
  });
  it("shows only server translations, then grades the exact boolean and immediately shows summary", async () => {
    const f = fixture({ step: "presented" }); await f.controller.refresh();
    const before = f.controller.snapshot().current!; expect(before.assignment!.revealed).toBe(false);
    await f.controller.reveal(); const revealed = f.controller.snapshot().current!;
    expect(revealed.assignment).toMatchObject({ revealed: true, translations: ["дом"] });
    expect(revealed.practice).toEqual(before.practice); expect(revealed.progress).toEqual(before.progress);
    await f.controller.grade(false);
    expect(f.posted.map(v => v.kind)).toEqual(["oral.reveal", "oral.grade"]); expect(f.posted[1].payload).toEqual({ correct: false });
    expect(f.controller.snapshot()).toMatchObject({ phase: "summary", current: { assignment: null }, canSummaryHome: true });
    await f.controller.stop("summary_home"); expect(f.controller.snapshot().phase).toBe("closed");
  });
  it("accepted grade replaces the assignment immediately and requires a new shown ticket", async () => {
    const f = fixture({ step: "revealed" }); await f.controller.refresh();
    f.fetcher.mockImplementationOnce(async (_url, options) => {
      const command = JSON.parse(String(options!.body)); f.posted.push(command); f.set("prefetched", "9", id(3), id(60));
      return response({ command: fact(command), current: projection("prefetched", id(3), id(60)), state_version: "9" });
    });
    await f.controller.grade(true); expect(f.controller.snapshot()).toMatchObject({ phase: "prefetched", canReveal: false,
      current: { assignment: { id: id(60) } } }); expect(f.controller.snapshot().presentationTicket).not.toBeNull();
    expect(f.posted).toHaveLength(1);
  });
  it("stale accepted grade preserves its fact but never restores the old question before GET", async () => {
    const f = fixture({ step: "revealed", minimum: () => "8" }); await f.controller.refresh();
    const gate = deferred<Response>();
    f.fetcher.mockImplementationOnce(async (_url, options) => response({ command: fact(JSON.parse(String(options!.body))),
      current: projection("revealed"), state_version: "7" })).mockReturnValueOnce(gate.promise);
    const grading = f.controller.grade(true); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    expect(f.controller.snapshot()).toMatchObject({ current: null, commands: { study: { outcome: "accepted" } } });
    gate.resolve(response({ current: projection("summary"), state_version: "9" })); await grading;
    expect(f.controller.snapshot().phase).toBe("summary");
  });
  it("accepted recovery with unavailable current reads the confirmed session without replay", async () => {
    const f = fixture({ saved: [intents[3]], step: "summary" });
    f.fetcher.mockImplementationOnce(async () => response({ command: fact(intents[3], "already_applied"),
      verified_intent_hash: await oralIntentHash(intents[3]), current: { status: "unavailable" }, state_version: "8" }));
    await f.controller.refresh(); expect(f.posted).toEqual([]); expect(f.controller.snapshot()).toMatchObject({ phase: "summary",
      commands: { study: { outcome: "accepted", pending: false } } }); expect(f.gets).toHaveLength(1);
  });
  it("a hidden callback cannot present and visible alone never restores rights", async () => {
    const f = fixture(); await f.controller.refresh(); const ticket = f.controller.snapshot().presentationTicket!;
    f.controller.setActivity({ enabled: true, visible: false }); f.controller.setActivity({ enabled: true, visible: true });
    await f.controller.shown(ticket); await f.controller.refresh(); expect(f.posted).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({ current: null, presentationTicket: null, canStop: false });
  });
});

describe("oral document: independent Stop and immutable facts", () => {
  it("Stop does not await a hung grade; late grade and read cannot revive the closed session", async () => {
    const f = fixture({ step: "revealed" }); await f.controller.refresh(); const gate = deferred<Response>();
    f.fetcher.mockImplementationOnce(async (...args) => { const reply = await f.handler(...args); await gate.promise; return reply; });
    const grading = f.controller.grade(true); await vi.waitFor(() => expect(f.posted).toHaveLength(1));
    expect(f.controller.snapshot().canStop).toBe(true); await f.controller.stop("stop");
    expect(f.posted.map(v => v.kind)).toEqual(["oral.grade", "session.stop"]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", current: null, commands: { study: { pending: true } }, canStart: false });
    gate.resolve(response({})); await grading; expect(f.controller.snapshot().phase).toBe("closed");
    f.set("revealed", "100"); await f.controller.refresh(); expect(f.controller.snapshot().phase).toBe("closed");
  });
  it("later closed read does not prove not_applied, but an atomic absence+closed response does", async () => {
    const f = fixture({ saved: [intents[3]], step: "closed" }); f.accepted.clear(); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", canStart: false, commands: { study: { pending: true, outcome: null } } });
    f.fetcher.mockImplementationOnce(async () => response({ command: { id: id(4), status: "not_found" }, current: profile("8"), state_version: "8",
      closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } }));
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ phase: "closed", canStart: true,
      commands: { study: { pending: false, outcome: "not_applied" } } });
  });
  it("hash mismatch is unresolved even after a closed read, with no manual retry", async () => {
    const f = fixture({ saved: [intents[3]], step: "closed" }); f.accepted.set(id(4), { ...intents[3], payload: { correct: false } } as OralIntent);
    await f.controller.refresh(); await f.controller.retry("study");
    expect(f.controller.snapshot().commands.study).toMatchObject({ pending: true, problem: "mismatch", outcome: null, canRetry: false });
    expect(JSON.parse(f.values.get(key())!).mismatch).toBe(true); expect(f.posted).toEqual([]);
  });
  it("accepted fact with failed clear retries cleanup without a second POST", async () => {
    const f = fixture({ step: "presented" }); await f.controller.refresh(); vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage"));
    await f.controller.reveal(); expect(f.controller.snapshot().commands.study).toMatchObject({ pending: true, outcome: "accepted", canRetry: false });
    await f.controller.refresh(); expect(f.controller.snapshot().commands.study.pending).toBe(false); expect(f.posted).toHaveLength(1);
  });
  it("Stop refusal leaves a fresh active session with the actual error code", async () => {
    const f = fixture({ step: "revealed" }); await f.controller.refresh();
    f.fetcher.mockImplementationOnce(async (_url, options) => response({ command: { id: JSON.parse(String(options!.body)).command_id, status: "rejected" },
      error: { code: "STEP_CHANGED" }, current: projection("revealed"), state_version: "9" }, 409)); f.set("revealed", "9");
    await f.controller.stop("stop"); expect(f.controller.snapshot()).toMatchObject({ phase: "revealed", terminalSessionIds: [],
      commands: { stop: { outcome: "rejected", rejectionCode: "STEP_CHANGED" } } });
  });
});

describe("oral document: floor, source and detached snapshots", () => {
  it("retains BigInt floor after its publisher disappears; old projections and Stop rights vanish", async () => {
    let floor: string | null = null; const f = fixture({ minimum: () => floor });
    f.set("revealed", "9007199254740993"); await f.controller.refresh(); expect(f.controller.snapshot().canGrade).toBe(true);
    floor = "9007199254740994"; expect(f.controller.snapshot()).toMatchObject({ current: null, canGrade: false, canStop: false });
    floor = null; expect(f.controller.snapshot().stateVersion).toBe("9007199254740994");
    await f.controller.refresh(); expect(f.controller.snapshot().current).toBeNull();
  });
  it("copies current and command facts; never exposes access credentials", async () => {
    const f = fixture({ saved: [intents[2]], step: "revealed" }); await f.controller.refresh(); const state = f.controller.snapshot();
    state.current!.assignment!.prompt.text = "mutated"; state.commands.study.resolved!.sessionId = id(90); state.terminalSessionIds.push(id(3));
    expect(f.controller.snapshot().current!.assignment!.prompt.text).toBe("Haus"); expect(f.controller.snapshot().commands.study.resolved!.sessionId).toBe(id(3));
    expect(JSON.stringify(f.controller.snapshot())).not.toMatch(/synthetic-token|synthetic-proof|expected_intent_hash/);
  });
  it("dispose in an update prevents queued POST and never calls a dead floor publisher", async () => {
    let dead = false; const f = fixture({ seed: null, minimum: () => { if (dead) throw new Error("dead publisher"); return null; } });
    await f.controller.refresh(); f.updates.mockImplementation(state => { if (state.commands.study.phase === "sending") { f.controller.dispose(); dead = true; } });
    await f.controller.start("words"); expect(f.posted).toEqual([]); expect(() => f.controller.snapshot()).not.toThrow();
    expect(f.controller.snapshot().phase).toBe("disposed");
  });
  it("suspending during durable save prevents a late POST and leaves the receipt", async () => {
    const f = fixture(); await f.controller.refresh(); const gate = deferred<void>();
    vi.mocked(f.storage.set).mockImplementationOnce(async (k, v) => { await gate.promise; f.values.set(k, v); });
    const work = f.controller.shown(f.controller.snapshot().presentationTicket!); await vi.waitFor(() => expect(f.storage.set).toHaveBeenCalled());
    f.controller.setActivity({ enabled: true, visible: false }); gate.resolve(); await work;
    expect(f.posted).toEqual([]); expect(f.values.has(key())).toBe(true);
  });
});

describe("oral document: explicit check during an in-flight refresh", () => {
  /** Holds the listed non-command GETs (1-based); a release may substitute the reply, e.g. a genuine 401/403. */
  function hold(f: ReturnType<typeof fixture>, ...held: number[]) {
    const gates = new Map(held.map(n => [n, deferred<Response | null>()] as const)); let reads = 0;
    f.fetcher.mockImplementation(async (url, init) => {
      const reply = f.handler(url, init);
      if (init?.method === "POST" || String(url).includes("/commands/")) return reply;
      const gate = gates.get(++reads), substitute = gate ? await gate.promise : null;
      return substitute ?? reply;
    });
    return { reads: () => reads, release: (n: number, reply: Response | null = null) => gates.get(n)!.resolve(reply) };
  }
  const checks = (f: ReturnType<typeof fixture>) => f.gets.filter(url => url.includes("/commands/")).length;
  const unknownStudy = () => { const f = fixture({ saved: [intents[2]], step: "presented" }); f.accepted.clear(); return f; };

  it("repeated checks queue one later status GET; lifecycle refresh still joins", async () => {
    const f = unknownStudy(), held = hold(f, 2);
    const lifecycle = f.controller.refresh(); await vi.waitFor(() => expect(held.reads()).toBe(2));
    // 23.1 А (owner, C165): oral.reveal stored before this owner (a reload, another window) is only checked, never retried here.
    expect(f.controller.snapshot().canRetry.study).toBe(false); expect(checks(f)).toBe(1);
    const first = f.controller.recheck(), second = f.controller.recheck();
    expect(second).toBe(first); expect(f.controller.refresh()).toBe(lifecycle); expect(checks(f)).toBe(1);
    held.release(2); await lifecycle; await first;
    expect(checks(f)).toBe(2); expect(f.posted).toEqual([]);
    // The lane still holds its verified intent; only the page that created it may offer it again.
    expect(f.controller.snapshot()).toMatchObject({ commands: { study: { pending: true, canRetry: true } }, canRetry: { study: false } });
  });

  it("a check during the queued follow-up read starts a second episode with its own later status GET", async () => {
    const f = unknownStudy(), held = hold(f, 2, 4);
    const lifecycle = f.controller.refresh(); await vi.waitFor(() => expect(held.reads()).toBe(2));
    const first = f.controller.recheck(); held.release(2); await lifecycle;
    await vi.waitFor(() => expect(held.reads()).toBe(4)); expect(checks(f)).toBe(2);
    const second = f.controller.recheck();
    expect(second).not.toBe(first); expect(f.controller.recheck()).toBe(second); expect(checks(f)).toBe(2);
    held.release(4); await first; await second;
    expect(checks(f)).toBe(3); expect(f.posted).toEqual([]);
  });

  it.each(["dispose", "revoke"] as const)("%s before the queued check sends nothing further", async end => {
    const f = unknownStudy(), held = hold(f, 2);
    const lifecycle = f.controller.refresh(); await vi.waitFor(() => expect(held.reads()).toBe(2));
    const queued = f.controller.recheck(), calls = f.fetcher.mock.calls.length;
    if (end === "dispose") f.controller.dispose(); else f.revoke();
    held.release(2); await lifecycle; await queued;
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(f.posted).toEqual([]); expect(f.denied).not.toHaveBeenCalled();
  });

  it.each([401, 403])("genuine %s on the held read denies once and the queued check sends nothing", async status => {
    const f = unknownStudy(), held = hold(f, 2);
    const lifecycle = f.controller.refresh(); await vi.waitFor(() => expect(held.reads()).toBe(2));
    const queued = f.controller.recheck(), calls = f.fetcher.mock.calls.length;
    held.release(2, response({ error: { code: "ACCESS_DENIED" } }, status)); await lifecycle; await queued;
    expect(f.denied).toHaveBeenCalledOnce(); expect(f.options.access.isLive()).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(checks(f)).toBe(1); expect(f.posted).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", current: null });
  });
});

describe("oral document: own closed projection (L1)", () => {
  type Progress = OralSessionProjection["progress"];
  const partial: Progress = { completed: 2, total: 5, correct: 1, wrong: 1 };
  function closed(progress: Progress, reason: NonNullable<OralSessionProjection["close_reason"]> = "stop",
    session = id(3), pair: OralSessionProjection["pair"] = "ru-de"): OralSessionProjection {
    return { ...projection("closed", session), pair, close_reason: reason, progress,
      summary: { completed: progress.completed, correct: progress.correct, wrong: progress.wrong,
        ratio: progress.completed ? { numerator: progress.correct, denominator: progress.completed } : null } };
  }
  /** Chosen replies for matching requests; everything else is answered by the fixture model. */
  function route(f: ReturnType<typeof fixture>, pick: (url: string, init?: RequestInit) => Response | null | Promise<Response | null>) {
    f.fetcher.mockImplementation(async (url, init) => (await pick(String(url), init)) ?? f.handler(url, init));
  }
  const sessionGets = (f: ReturnType<typeof fixture>) => f.fetcher.mock.calls
    .filter(([url, init]) => init?.method !== "POST" && String(url).includes(`/sessions/${id(3)}?`)).length;
  const stopReply = (f: ReturnType<typeof fixture>, current: unknown) => (_url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return null;
    const command = JSON.parse(String(init.body)); f.posted.push(command);
    return response({ command: fact(command), current, state_version: "20" });
  };
  /** A replacement owner of the same seed whose terminal id was retained by the hook. */
  const retained = (f: ReturnType<typeof fixture>) => {
    f.controller.dispose(); return new OralDocumentController({ ...f.options, terminalSessionIds: [id(3)] });
  };

  it("L1-1 own Stop keeps the server's closed facts without an extra read", async () => {
    const f = fixture({ step: "presented" }); await f.controller.refresh(); await f.controller.reveal();
    const facts = closed(partial); route(f, stopReply(f, facts));
    const before = sessionGets(f); await f.controller.stop("stop");
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", current: null,
      closed: { sessionId: id(3), reason: "stop", summary: facts.summary, progress: partial, summaryRead: "known" } });
    expect(sessionGets(f)).toBe(before); expect(f.posted.map(v => v.kind)).toEqual(["oral.reveal", "session.stop"]);
  });
  it("L1-2 a closure boundary without a summary costs exactly one addressed read", async () => {
    const f = fixture({ saved: [intents[3]], step: "revealed" }), facts = closed(partial, "midnight");
    route(f, url => url.includes("/commands/") ? response({ command: { id: id(4), status: "not_found" }, current: profile("8"),
      state_version: "8", closed_session: { session_id: id(3), status: "closed", close_reason: "midnight" } })
      : url.includes(`/sessions/${id(3)}?`) ? response({ current: facts, state_version: "9" }) : null);
    await f.controller.refresh();
    expect(sessionGets(f)).toBe(1); expect(f.posted).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed",
      closed: { reason: "midnight", summary: facts.summary, progress: partial, summaryRead: "known" } });
  });
  it("L1-2b a failed read after a stop-lane boundary never builds facts from the active question", async () => {
    const f = fixture({ step: "revealed" }), question = { ...projection("revealed"), progress: partial };
    let closedNow = false;
    route(f, (url, init) => {
      if (init?.method === "POST") { f.posted.push(JSON.parse(String(init.body))); throw new TypeError("network"); }
      if (url.includes("/commands/")) return closedNow ? response({ command: { id: new URL(url, "https://model.invalid").pathname.split("/").at(-1),
        status: "not_found" }, current: profile("10"), state_version: "10",
        closed_session: { session_id: id(3), status: "closed", close_reason: "midnight" } }) : null;
      if (url.includes(`/sessions/${id(3)}?`)) return closedNow ? response({ error: { code: "INTERNAL_ERROR" } }, 500)
        : response({ current: question, state_version: "9" });
      return null;
    });
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ phase: "revealed", current: { progress: partial } });
    await f.controller.stop("stop"); expect(f.controller.snapshot().commands.stop).toMatchObject({ pending: true, outcome: null });
    closedNow = true; await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", current: null, problem: null,
      closed: { sessionId: id(3), reason: "midnight", summary: null, progress: null, summaryRead: "failed" } });
    expect(sessionGets(f)).toBe(2); expect(f.posted).toHaveLength(1);
  });
  it("L1-3 a late closed projection of the same session keeps the known facts and costs no read", async () => {
    const f = fixture({ step: "revealed" }); await f.controller.refresh();
    f.fetcher.mockImplementationOnce(async (...args) => { await f.handler(...args); throw new Error("lost"); });
    await f.controller.grade(true); expect(f.controller.snapshot().commands.study).toMatchObject({ pending: true, outcome: null });
    await f.controller.stop("stop");
    const known = f.controller.snapshot().closed; expect(known).toMatchObject({ reason: "stop", summaryRead: "known" });
    const before = sessionGets(f); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", current: null, canReveal: false, canGrade: false, closed: known,
      commands: { study: { pending: false, outcome: "accepted" } } });
    expect(sessionGets(f)).toBe(before); expect(f.posted.map(v => v.kind)).toEqual(["oral.grade", "session.stop"]);
  });
  it("L1-4a a foreign closed session never becomes the own facts", async () => {
    const f = fixture({ saved: [{ ...intents[4], session_id: id(90) }], step: "revealed" }); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "revealed", terminalSessionIds: [id(90)], closed: null });
    const facts = closed(partial); route(f, stopReply(f, facts)); await f.controller.stop("stop");
    expect(f.controller.snapshot().closed).toEqual({ sessionId: id(3), reason: "stop", summary: facts.summary, progress: partial,
      summaryRead: "known" });
  });
  // M-TEXT-DEFECTS-2 (D-TEXT-DEFECTS §2): the reason of an own closure is a server fact whatever pair its projection names;
  // only the numbers need this owner's pair. A closure is no failed refresh.
  it("L1-4b an own closed projection of another dictionary pair gives its reason, never its numbers, and no problem", async () => {
    const f = fixture(), other = closed(partial, "pair_changed", id(3), "en-de");
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? response({ current: other, state_version: "9" }) : null);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", problem: null,
      closed: { sessionId: id(3), reason: "pair_changed", summary: null, progress: null, summaryRead: "failed" } });
    expect(sessionGets(f)).toBe(2);
  });
  it("L1-4c a boundary's reason stays when a closed projection of another pair follows", async () => {
    const f = fixture({ step: "revealed" }), other = closed(partial, "pair_changed", id(3), "en-de");
    let closedNow = false;
    route(f, (url, init) => {
      if (init?.method === "POST") throw new TypeError("network");
      if (url.includes("/commands/")) return closedNow ? response({ command: { id: new URL(url, "https://model.invalid").pathname.split("/").at(-1),
        status: "not_found" }, current: profile("10"), state_version: "10",
        closed_session: { session_id: id(3), status: "closed", close_reason: "midnight" } }) : null;
      if (url.includes(`/sessions/${id(3)}?`)) return closedNow ? response({ current: other, state_version: "11" })
        : response({ current: projection("revealed"), state_version: "9" });
      return null;
    });
    await f.controller.refresh(); await f.controller.stop("stop"); closedNow = true; await f.controller.refresh(); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", current: null, problem: null,
      closed: { sessionId: id(3), reason: "midnight", summary: null, progress: null, summaryRead: "failed" } });
  });
  // C178: the pair change is kept as a fact about the own session, never as the shown problem; it grants no Stop.
  it("L1-4d an active projection of the own session on another pair is still a changed pair", async () => {
    const f = fixture({ step: "revealed" }), other = { ...projection("revealed"), pair: "en-de" as const };
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? response({ current: other, state_version: "9" }) : null);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", current: null, problem: null, pairMismatch: id(3), closed: null,
      canStop: false });
  });
  it("L1-4e a failed read after the proved pair change names its own problem; the fact stays", async () => {
    const f = fixture({ step: "revealed" }), other = { ...projection("revealed"), pair: "en-de" as const };
    let fail = false;
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? fail ? Promise.reject(new TypeError("network"))
      : response({ current: other, state_version: "9" }) : null);
    await f.controller.refresh(); fail = true; await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: "network", pairMismatch: id(3), canStop: false });
  });
  it("L1-4f a reply of another pair below the floor proves nothing: no fact, a stale reply", async () => {
    const f = fixture({ step: "revealed" }), other = { ...projection("revealed"), pair: "en-de" as const };
    let low = false;
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? low ? response({ current: other, state_version: "1" }) : null : null);
    await f.controller.refresh(); low = true; await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "stale_response", pairMismatch: null });
  });
  // QA-R1-V3 F2: a closed own session is no session open in another pair; its fact is never published (no R1 for it).
  it("L1-4h after the closure of the own session the fact is not published", async () => {
    const f = fixture({ step: "revealed" }), other = { ...projection("revealed"), pair: "en-de" as const };
    let closedNow = false;
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? closedNow ? response({ current: closed(partial, "pair_changed", id(3), "en-de"), state_version: "12" })
      : response({ current: other, state_version: "11" }) : null);
    await f.controller.refresh();
    expect(f.controller.snapshot().pairMismatch).toBe(id(3));
    closedNow = true; await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", pairMismatch: null, canStop: false });
  });
  it("L1-4g a projection of this pair of the same session ends the fact", async () => {
    const f = fixture({ step: "revealed" }), other = { ...projection("revealed"), pair: "en-de" as const };
    let own = false;
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? own ? response({ current: projection("revealed"), state_version: "12" })
      : response({ current: other, state_version: "11" }) : null);
    await f.controller.refresh();
    expect(f.controller.snapshot().pairMismatch).toBe(id(3));
    own = true; await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pairMismatch: null, problem: null, phase: "revealed" });
  });
  it("L1-5 a replaced owner of a retained terminal session reads its facts once and never raises stateVersion", async () => {
    const f = fixture(); f.set("closed", "77"); const next = retained(f);
    await next.refresh(); expect(sessionGets(f)).toBe(1);
    expect(next.snapshot()).toMatchObject({ phase: "closed", stateVersion: "1",
      closed: { sessionId: id(3), reason: "stop", summary: { completed: 1, correct: 1, wrong: 0 }, summaryRead: "known" } });
    await next.refresh(); expect(sessionGets(f)).toBe(1); next.dispose();
  });
  it("L1-6 a failing read is repeated only by later refreshes, never by itself", async () => {
    const f = fixture(), next = retained(f);
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? response({ error: { code: "INTERNAL_ERROR" } }, 500) : null);
    await next.refresh(); await next.refresh(); expect(sessionGets(f)).toBe(2);
    expect(next.snapshot()).toMatchObject({ phase: "closed", problem: null, closed: { summary: null, progress: null, summaryRead: "failed" } });
    const calls = f.fetcher.mock.calls.length; await new Promise(done => setTimeout(done, 20));
    expect(f.fetcher.mock.calls.length).toBe(calls); expect(f.posted).toEqual([]); next.dispose();
  });
  it("L1-7 a genuine 401 on the read denies once and exposes nothing", async () => {
    const f = fixture(), next = retained(f);
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? response({ error: { code: "ACCESS_DENIED" } }, 401) : null);
    await next.refresh();
    expect(f.denied).toHaveBeenCalledOnce(); expect(next.snapshot()).toMatchObject({ phase: "disposed", closed: null });
  });
  it("L1-8 Stop before any answer keeps the server's zero summary as given", async () => {
    const f = fixture(); await f.controller.refresh();
    const zero = closed({ completed: 0, total: 3, correct: 0, wrong: 0 }); route(f, stopReply(f, zero));
    await f.controller.stop("stop");
    expect(f.controller.snapshot().closed).toEqual({ sessionId: id(3), reason: "stop",
      summary: { completed: 0, correct: 0, wrong: 0, ratio: null }, progress: { completed: 0, total: 3, correct: 0, wrong: 0 },
      summaryRead: "known" });
  });
  it("L1-10 Start after a closed session with an unknown summary reads it once before the single POST", async () => {
    const f = fixture(), next = retained(f);
    route(f, url => url.includes(`/sessions/${id(3)}?`) ? response({ error: { code: "INTERNAL_ERROR" } }, 500) : null);
    await next.start("words");
    const order = f.fetcher.mock.calls.map(([url, init]) => init?.method === "POST" ? "POST"
      : String(url).includes(`/sessions/${id(3)}?`) ? "read" : "other").filter(kind => kind !== "other");
    expect(order).toEqual(["read", "POST"]);
    expect(f.posted).toHaveLength(1); expect(f.posted[0]).toMatchObject({ kind: "session.start", payload: { mode: "oral", bucket: "words" } });
    expect(next.snapshot()).toMatchObject({ sessionId: id(100), closed: null }); next.dispose();
  });
  it.each(["dispose", "revoke"] as const)("L1-11 %s during the in-flight read leaves no update, fetch or denial", async end => {
    const f = fixture(); f.set("closed", "9"); const next = retained(f), gate = deferred<void>();
    route(f, async (url, init) => {
      if (!url.includes(`/sessions/${id(3)}?`)) return null;
      const reply = await f.handler(url, init); await gate.promise; return reply;
    });
    const work = next.refresh(); await vi.waitFor(() => expect(sessionGets(f)).toBe(1));
    expect(next.snapshot().closed).toMatchObject({ summaryRead: "reading" });
    const calls = f.fetcher.mock.calls.length, updates = f.updates.mock.calls.length;
    if (end === "dispose") next.dispose(); else f.revoke();
    gate.resolve(); await work;
    expect(f.fetcher.mock.calls.length).toBe(calls); expect(f.updates.mock.calls.length).toBe(updates);
    expect(f.denied).not.toHaveBeenCalled(); expect(f.posted).toEqual([]);
  });
  it("L1-12 a closed read below the floor is not kept and changes neither problem nor stateVersion", async () => {
    const f = fixture({ minimum: () => "50" }); f.set("closed", "9"); const next = retained(f);
    await next.refresh(); expect(sessionGets(f)).toBe(1);
    expect(next.snapshot()).toMatchObject({ phase: "closed", problem: null, stateVersion: "50",
      closed: { summary: null, progress: null, summaryRead: "failed" } }); next.dispose();
  });
  it("L1-13 an accepted Stop without a usable projection waits for the next refresh, then reads once", async () => {
    const f = fixture({ step: "revealed" }); await f.controller.refresh();
    route(f, stopReply(f, { session_id: id(3), status: "unavailable" }));
    const before = sessionGets(f); await f.controller.stop("stop");
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", problem: "unavailable",
      closed: { sessionId: id(3), reason: null, summary: null, progress: null, summaryRead: "pending" } });
    expect(sessionGets(f)).toBe(before);
    f.set("closed", "21"); await f.controller.refresh(); expect(sessionGets(f)).toBe(before + 1);
    expect(f.controller.snapshot()).toMatchObject({ closed: { reason: "stop", summaryRead: "known", summary: { completed: 1 } } });
  });
});

// D-FALSE-TEXTS part A: the owner vouches for the source of the current cause. A lane's «not_found» hides the refresh-failure
// line only when it is the one current cause; a foreign unresolved receipt keeps it even if every lane holds a not_found.
describe("oral document: checkedAbsent", () => {
  const ownStop: OralIntent = { session_id: id(3), command_id: id(9), kind: "session.stop", payload: { reason: "stop" } };
  const foreignStop: OralIntent = { session_id: id(90), command_id: id(9), kind: "session.stop", payload: { reason: "stop" } };
  /** Both saved records are absent on the server (the status answers not_found) while the open step still allows them. */
  async function checked(saved: OralIntent[]) {
    const f = fixture({ saved, step: "presented" }); f.accepted.clear(); f.set("presented", "13");
    await f.controller.refresh();
    return f.controller.snapshot();
  }
  it("a single honest not_found (own reveal absent on the open step) is vouched for", async () => {
    const snapshot = await checked([intents[2]]);
    expect(snapshot).toMatchObject({ phase: "unknown", problem: "not_found", checkedAbsent: true });
    expect(snapshot.commands.study).toMatchObject({ problem: "not_found", canRetry: true });
  });
  it("two own lanes that both found their record absent are vouched for", async () => {
    expect(await checked([intents[2], ownStop])).toMatchObject({ problem: "not_found", checkedAbsent: true });
  });
  it("a foreign unresolved receipt of another session beside an own not_found is not vouched for", async () => {
    const snapshot = await checked([intents[2], foreignStop]);
    expect(snapshot.commands.study.problem).toBe("not_found");
    expect(snapshot.commands.stop.problem).toBe("not_found");
    expect(snapshot.checkedAbsent).toBeUndefined();
  });
  it("a failed read of the session beside an own not_found is not vouched for", async () => {
    const f = fixture({ saved: [intents[2]], step: "presented" }); f.accepted.clear(); f.set("presented", "13");
    const base = f.handler;
    // The lane's own verification read (the first session GET) passes; the owner's follow-up read of the current step fails.
    let reads = 0;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes("/sessions/") && init?.method !== "POST" && reads++ >= 1
      ? response({ error: { code: "UNEXPECTED" } }, 500) : base(url, init));
    await f.controller.refresh();
    const snapshot = f.controller.snapshot();
    expect(snapshot.commands.study.problem).toBe("not_found");
    expect(snapshot.checkedAbsent).toBeUndefined();
  });
});
