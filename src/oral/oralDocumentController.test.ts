import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, OralSessionProjection } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { oralIntentHash, type OralIntent, type OralCommand } from "./oralIntent";
import { OralSessionPendingStore, OralStopPendingStore } from "./oralPending";
import { OralDocumentController, type OralDocumentOptions } from "./oralDocumentController";

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
  const options: OralDocumentOptions = { access, transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000 },
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
  it("manual retry of a retained unposted start confirms its exact session without creating IDs", async () => {
    const f = fixture({ seed: null, saved: [intents[0]] }); f.accepted.clear();
    const original = f.handler;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes(`/sessions/${id(3)}?`) && !f.posted.length
      ? response({ current: { session_id: id(3), status: "not_found" }, state_version: "8" }) : original(url, init));
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ sessionId: null, canStart: false, canRetry: { study: true } });
    await f.controller.retry("study");
    expect(f.posted).toHaveLength(1); expect(f.posted[0]).toMatchObject(intents[0]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ sessionId: id(3), phase: "prefetched" });
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
