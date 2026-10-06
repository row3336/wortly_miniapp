import { describe, expect, it, vi } from "vitest";
import type { ConjugationSessionProjection, OpenedClient } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { conjugationIntentHash, type ConjugationCommand, type ConjugationIntent } from "./conjugationIntent";
import { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "./conjugationPending";
import { ConjugationDocumentController, type ConjugationDocumentOptions, type ConjugationPresentationTicket,
  type ConjugationStepTicket } from "./conjugationDocumentController";

const id = (n: number) => `cccccccc-dddd-4000-8000-${String(n).padStart(12, "0")}`;
const S1 = id(3), S2 = id(4), B1 = id(21), B2 = id(22), B3 = id(23), R1 = id(31);
const HIGH = "9007199254740993"; // > 2^53, must stay a quoted decimal string end to end.
const studyKey = "wortly.pending.conjugation_session", stopKey = "wortly.pending.conjugation_stop";
type Result = { result_id: string; assignment_id: string; action_id: string; version: string; grade: 2 | 3 | 4 | 5 };
type Session = { id: string; status: "active" | "summary" | "closed"; assignment: string | null; presented: boolean; results: Result[] };

function projection(s: Session): ConjugationSessionProjection {
  const done = s.results.length, correct = s.results.filter(r => r.grade >= 3).length;
  const total = s.status === "active" ? done + 1 : done;
  const summary = s.status === "active" ? null : { completed_cycle_ids: [], partial: [{ cycle_id: id(9), answered_groups: ["ich"] }],
    results: s.results.map(r => ({ result_id: r.result_id, version: r.version })), completed: done, correct, wrong: done - correct,
    blocks: [{ cycle_id: id(9), base_verb_id: id(8), base_lemma: "kommen", tense: "present", answered_groups: ["ich"], effect: "incomplete", grade: null }] } as ConjugationSessionProjection["summary"];
  const assignment = s.status === "active" && s.assignment ? { id: s.assignment, card_id: id(8), status: s.presented ? "presented" : "prefetched",
    kind: "conjugation", cycle_id: id(9), slot_id: { cycle_id: id(9), pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18),
    tense: "present", pronoun_group: "du", prompt: { verb: "kommen", translation: "приходить", language: "ru", pronoun: "du", tense: "present" },
    answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } } as ConjugationSessionProjection["assignment"] : null;
  return { session_id: s.id, status: s.status, mode: "conjugation", direction: "conjugation", pair: "ru-de", local_date: "2026-10-01",
    close_reason: s.status === "closed" ? "stop" : null, progress: { total, completed: done, correct, wrong: done - correct }, assignment, summary,
    capabilities: { answer_target: assignment && s.presented ? s.assignment : null, correct_target: null, grades: null, undo_target: null,
      stop: s.status !== "closed", summary_home: s.status === "summary" } };
}
function resultEnvelope(s: Session, r: Result) {
  const step = projection(s), live = s.status !== "closed";
  const target = { session_id: s.id, assignment_id: r.assignment_id, result_id: r.result_id, expected_result_version: r.version };
  return { action: { action_id: r.action_id, kind: "answer.submit", version: r.version, status: "active" },
    result: { result_id: r.result_id, assignment_id: r.assignment_id, version: r.version, grade: r.grade, correct: r.grade >= 3,
      status: "active", accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: null },
    step, capabilities: { ...step.capabilities, grades: live && r.grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: live && r.grade === 2 ? target : null } };
}
const profile = (state_version = "9007199254740990"): OpenedClient["profile"] => ({ profile_id: id(50), role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version, access: { status: "admitted", version: "1", reason: null } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const pendingRecord = (intent: ConjugationIntent) => JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent });

/** Synthetic HTTP MODEL of the server (not PG captures, not end-to-end). The real createConjugationApi,
 * createOpenedAccess and pending stores validate every body, proof hash and stored record. */
function fixture(config: { seed?: string | null; saved?: ConjugationIntent[]; sessions?: Session[]; minimum?: () => string | null;
  terminal?: string[]; lastAnswer?: boolean } = {}) {
  const values = new Map<string, string>();
  for (const intent of config.saved ?? []) values.set(intent.kind === "session.stop" ? stopKey : studyKey, pendingRecord(intent));
  const storage: AsyncStorage = { get: vi.fn(async k => values.get(k) ?? null), set: vi.fn(async (k, v) => { values.set(k, v); }),
    remove: vi.fn(async k => { values.delete(k); }) };
  const sessions = new Map<string, Session>((config.sessions ?? [{ id: S1, status: "active", assignment: B1, presented: true, results: [] }])
    .map(s => [s.id, structuredClone(s)]));
  const accepted = new Map<string, ConjugationIntent>();
  let stateVersion = "9007199254740991", live = true, counter = 100;
  const posted: ConjugationCommand[] = [], gets: string[] = [];
  const server = {
    lostReply: false, failPost: false, rejectNext: null as string | null, replaceOnCorrect: null as string | null,
    hold: null as null | { match: (url: URL, method: string) => boolean; gate: Promise<void>; entered: () => void },
    denyNext: null as null | number, staleNext: null as string | null, failResultRead: false,
    bump: () => { stateVersion = String(BigInt(stateVersion) + 1n); return stateVersion; },
    get version() { return stateVersion; }, set version(v: string) { stateVersion = v; },
  };
  const fact = (intent: ConjugationIntent, status: "applied" | "already_applied", r?: Result) => ({ id: intent.command_id, kind: intent.kind, status,
    applied_at: "2026-10-01T08:00:00Z", target_id: "assignment_id" in intent ? intent.assignment_id : (intent as { session_id: string }).session_id,
    action_id: r ? r.action_id : null, result_id: r ? r.result_id : null, context_id: null,
    object_version: r ? (intent.kind === "answer.submit" ? "1" : r.version) : null });
  const envelopeFor = (intent: ConjugationIntent) => {
    const s = sessions.get((intent as { session_id: string }).session_id)!;
    if (intent.kind === "answer.submit" || intent.kind === "result.grade" || intent.kind === "result.correct") {
      const r = s.results.find(x => x.assignment_id === intent.assignment_id)!;
      return { body: resultEnvelope(s, r), r };
    }
    return { body: { current: projection(s) }, r: undefined };
  };
  const apply = (intent: ConjugationIntent): Record<string, unknown> => {
    const sessionId = (intent as { session_id: string }).session_id;
    if (intent.kind === "session.start") sessions.set(sessionId, { id: sessionId, status: "active", assignment: B1, presented: false, results: [] });
    const s = sessions.get(sessionId)!;
    if (intent.kind === "assignment.present") s.presented = true;
    if (intent.kind === "answer.submit") {
      const grade = "text" in intent.payload && intent.payload.text === "kommst" ? 4 : 2;
      s.results.push({ result_id: R1, assignment_id: intent.assignment_id, action_id: id(41), version: "1", grade });
      if (config.lastAnswer) { s.status = "summary"; s.assignment = null; } else { s.assignment = B2; }
      s.presented = false;
    }
    if (intent.kind === "result.grade" || intent.kind === "result.correct") {
      const r = s.results.find(x => x.result_id === intent.result_id)!;
      r.version = String(BigInt(r.version) + 1n); r.grade = intent.kind === "result.correct" ? 4 : intent.payload.grade as 3 | 4 | 5;
      if (intent.kind === "result.correct" && server.replaceOnCorrect && !s.presented) s.assignment = server.replaceOnCorrect;
    }
    if (intent.kind === "session.stop") { s.status = "closed"; s.assignment = null; }
    server.bump();
    return {};
  };
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), "https://model.invalid"), method = init?.method ?? "GET";
    if (server.hold?.match(url, method)) { const hold = server.hold; server.hold = null; hold.entered(); await hold.gate; }
    if (server.denyNext) { const status = server.denyNext; server.denyNext = null; return response({ error: { code: "ACCESS_DENIED" } }, status); }
    if (method === "POST") {
      const command = JSON.parse(String(init!.body)) as ConjugationCommand; posted.push(command);
      if (server.failPost) throw new TypeError("synthetic network failure before server");
      const { client_instance_id: _c, document_id: _d, ...intent } = command;
      if (server.rejectNext) {
        const code = server.rejectNext; server.rejectNext = null;
        return response({ ...envelopeFor(intent).body, command: { id: intent.command_id, status: "rejected" }, error: { code }, state_version: stateVersion }, 409);
      }
      if (!accepted.has(intent.command_id)) { accepted.set(intent.command_id, intent); apply(intent); }
      const { body, r } = envelopeFor(intent);
      if (server.lostReply) throw new TypeError("synthetic lost reply after server commit");
      return response({ ...body, command: fact(intent, "applied", r), state_version: stateVersion });
    }
    gets.push(url.pathname + url.search);
    if (url.pathname.includes("/commands/")) {
      const commandId = url.pathname.split("/").at(-1)!, intent = accepted.get(commandId);
      if (!intent) return response({ command: { id: commandId, status: "not_found" }, current: profile(stateVersion), state_version: stateVersion });
      const hash = await conjugationIntentHash(intent);
      if (hash !== url.searchParams.get("expected_intent_hash")) return response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
      const { body, r } = envelopeFor(intent);
      return response({ ...body, command: fact(intent, "already_applied", r), verified_intent_hash: hash, state_version: stateVersion });
    }
    const sessionId = url.pathname.split("/").at(-1)!, s = sessions.get(sessionId) ?? { id: sessionId, status: "active", assignment: B1, presented: true, results: [] };
    const version = server.staleNext ?? stateVersion; server.staleNext = null;
    if (url.searchParams.has("result_id")) {
      if (server.failResultRead) return response({ error: { code: "UNAVAILABLE" } }, 503);
      const r = s.results.find(x => x.result_id === url.searchParams.get("result_id"))!;
      return response({ ...resultEnvelope(s as Session, r), state_version: version });
    }
    return response({ current: sessions.has(sessionId) ? projection(s as Session) : { session_id: sessionId, status: "not_found" }, state_version: version });
  };
  const fetcher = vi.fn<typeof fetch>(handler);
  const denied = vi.fn(() => { live = false; });
  const access = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1",
    proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } },
    token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => live, onDenied: denied });
  const activity = { enabled: true, visible: true };
  let ownerLive = true;
  const updates = vi.fn(), newId = vi.fn(() => id(counter++));
  const options: ConjugationDocumentOptions = { access, transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 200000 },
    studyStore: new ConjugationSessionPendingStore(storage), stopStore: new ConjugationStopPendingStore(storage),
    initialSessionId: config.seed === undefined ? S1 : config.seed, newId, minimumStateVersion: config.minimum ?? (() => null),
    terminalSessionIds: config.terminal ?? [], isLive: () => ownerLive, activity: () => activity, onUpdate: updates };
  const controller = new ConjugationDocumentController(options);
  const hold = (match: (url: URL, method: string) => boolean) => {
    const gate = deferred(), entered = deferred();
    server.hold = { match, gate: gate.promise, entered: () => entered.resolve() };
    return { release: () => gate.resolve(), entered: entered.promise };
  };
  return { controller, options, values, storage, sessions, server, posted, gets, newId, updates, denied, activity, hold,
    endOwner: () => { ownerLive = false; }, revoke: () => { live = false; } };
}
const s = (c: ConjugationDocumentController) => c.snapshot();
const summarySeed = (): Session => ({ id: S1, status: "summary", assignment: null, presented: false,
  results: [{ result_id: R1, assignment_id: B1, action_id: id(41), version: "1", grade: 4 }] });
const disable = (f: ReturnType<typeof fixture>) => { f.activity.enabled = false; f.controller.setActivity({ enabled: false, visible: true }); };
const enable = (f: ReturnType<typeof fixture>) => { f.activity.enabled = true; f.controller.setActivity({ enabled: true, visible: true }); };
const macrotasks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(done => setTimeout(done, 0)); };
function tracked(promise: Promise<void>) { const box = { done: false, promise }; void promise.then(() => { box.done = true; }); return box; }
async function answered(f: ReturnType<typeof fixture>, text = "kommst") {
  await f.controller.refresh();
  await f.controller.submit({ text }, B1);
  return s(f.controller);
}
async function shownB(f: ReturnType<typeof fixture>) {
  const after = await answered(f);
  f.controller.openStep(after.stepTicket!);
  const ticket = s(f.controller).presentationTicket!;
  await f.controller.shown(ticket);
  return ticket;
}

describe("1. confirmed seed, historical receipts and explicit Start", () => {
  it("an unresolved foreign S2 receipt blocks study on S1 and never elects itself", async () => {
    const present: ConjugationIntent = { command_id: id(60), kind: "assignment.present", session_id: S2, assignment_id: B3, payload: {} };
    const f = fixture({ saved: [present], sessions: [{ id: S1, status: "active", assignment: B1, presented: true, results: [] },
      { id: S2, status: "active", assignment: B3, presented: false, results: [] }] });
    await f.controller.refresh();
    expect(f.posted).toEqual([]);
    const snap = s(f.controller);
    expect(snap).toMatchObject({ sessionId: S1, phase: "unknown", canSubmit: false, canStart: false, problem: expect.any(String) });
    expect(snap.currentStep).toBeNull();
  });
  it("a settled historical S2 receipt does not block the confirmed S1", async () => {
    const present: ConjugationIntent = { command_id: id(60), kind: "assignment.present", session_id: S2, assignment_id: B3, payload: {} };
    const f = fixture({ sessions: [{ id: S1, status: "active", assignment: B1, presented: true, results: [] },
      { id: S2, status: "active", assignment: B3, presented: false, results: [] }] });
    // Commit S2's present on the model server, then persist it as if the reply had been lost.
    await f.options.transport.fetcher("/api/v1/commands", { method: "POST", body: JSON.stringify({ ...present, client_instance_id: id(1), document_id: id(2) }) });
    f.posted.length = 0;
    await f.storage.set(studyKey, pendingRecord(present));
    await f.controller.refresh();
    expect(f.posted).toEqual([]);
    expect(s(f.controller)).toMatchObject({ sessionId: S1, phase: "question", canSubmit: true, display: { kind: "step", assignmentId: B1 } });
    expect(s(f.controller).commands.study).toMatchObject({ outcome: "accepted", pending: false });
    expect(f.values.has(studyKey)).toBe(false);
  });
  it("without a seed an unresolved start is never auto-elected; only a manual exact retry selects its session", async () => {
    const start: ConjugationIntent = { command_id: id(61), kind: "session.start", session_id: S2, payload: { mode: "conjugation" } };
    const f = fixture({ seed: null, saved: [start], sessions: [] });
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ sessionId: null, phase: "unknown", canStart: false, canRetry: { study: true } });
    expect(f.posted).toEqual([]);
    await f.controller.retry("study");
    expect(f.posted.map(c => [c.command_id, c.kind, (c as { session_id: string }).session_id])).toEqual([[id(61), "session.start", S2]]);
    expect(f.newId).not.toHaveBeenCalled();
    expect(s(f.controller)).toMatchObject({ sessionId: S2, phase: "prefetched", display: { kind: "none" } });
  });
  it("explicit Start creates IDs once, joins concurrent calls and does not self-show the first step", async () => {
    const f = fixture({ seed: null, sessions: [] });
    expect(s(f.controller).canStart).toBe(false); // recovery first
    await f.controller.start(); expect(f.posted).toEqual([]);
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "idle", canStart: true });
    const first = f.controller.start(), second = f.controller.start();
    await Promise.all([first, second]);
    expect(f.posted).toHaveLength(1); expect(f.newId).toHaveBeenCalledTimes(2); // session + command, once
    const snap = s(f.controller);
    expect(snap).toMatchObject({ sessionId: id(100), phase: "prefetched", display: { kind: "none" }, presentationTicket: null });
    expect(snap.stepTicket).not.toBeNull();
  });
});

describe("2. A-result / B-step envelope and explicit openStep", () => {
  it("accepted answer displays exact A once; prefetched B is data only until openStep", async () => {
    const f = fixture();
    const snap = await answered(f);
    expect(snap).toMatchObject({ phase: "result", display: { kind: "result" }, presentationTicket: null,
      resultA: { address: { session_id: S1, assignment_id: B1, result_id: R1 }, result: { grade: 4 } } });
    expect(snap.currentStep?.step.assignment).toMatchObject({ id: B2, status: "prefetched" });
    expect(snap.allowedGrades).toEqual([3, 4, 5]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit"]);
    f.controller.openStep(snap.stepTicket!);
    expect(s(f.controller)).toMatchObject({ phase: "prefetched", display: { kind: "step", assignmentId: B2 } });
    expect(s(f.controller).presentationTicket).not.toBeNull();
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit"]); // openStep is local
  });
  it("a fresher session read of B does not extend A's capabilities; an addressed read restores them", async () => {
    const f = fixture();
    await shownB(f);
    f.server.failResultRead = true;
    f.sessions.get(S1)!.presented = true; f.server.bump();
    await f.controller.refresh();
    const stale = s(f.controller);
    expect(stale.currentStep?.stateVersion).toBe(f.server.version);
    expect(stale).toMatchObject({ resultA: null, allowedGrades: [], canCorrect: false, phase: "question" });
    f.server.failResultRead = false;
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ allowedGrades: [3, 4, 5], resultA: { stateVersion: f.server.version } });
    expect(f.gets.filter(g => g.includes(`result_id=${R1}`)).length).toBeGreaterThan(0);
  });
  it("summary after the last answer is reached only through openStep and is not closure", async () => {
    const f = fixture({ lastAnswer: true });
    const snap = await answered(f);
    expect(snap).toMatchObject({ phase: "result", canSummaryHome: true, terminalSessionIds: [] });
    f.controller.openStep(snap.stepTicket!);
    expect(s(f.controller)).toMatchObject({ phase: "summary", display: { kind: "summary" }, presentationTicket: null, terminalSessionIds: [] });
  });
});

describe("3. tickets and the presentation barrier", () => {
  it("forged, replayed, cross-source and activity-stale tickets are no-ops", async () => {
    const f = fixture(), other = fixture();
    const snap = await answered(f); await answered(other);
    f.controller.openStep(Object.freeze({}) as ConjugationStepTicket);
    f.controller.openStep(s(other.controller).stepTicket!);
    expect(s(f.controller).display).toEqual({ kind: "result" });
    const ticket = snap.stepTicket!;
    f.activity.enabled = false; f.controller.setActivity({ enabled: false, visible: true });
    f.activity.enabled = true; f.controller.setActivity({ enabled: true, visible: true });
    f.controller.openStep(ticket);
    expect(s(f.controller).display).toEqual({ kind: "result" });
    const renewed = s(f.controller).stepTicket!;
    expect(renewed).not.toBe(ticket);
    expect(s(f.controller).stepTicket).toBe(renewed); // stable reference between snapshots
    f.controller.openStep(renewed);
    const p = s(f.controller).presentationTicket!;
    await f.controller.shown(Object.freeze({}) as ConjugationPresentationTicket);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit"]);
    expect(p).toBe(s(f.controller).presentationTicket);
  });
  it("shown sets visible_unconfirmed synchronously, creates one present and blocks dependent mutations until ack", async () => {
    const f = fixture();
    const snap = await answered(f);
    f.controller.openStep(snap.stepTicket!);
    const ticket = s(f.controller).presentationTicket!;
    const held = f.hold((_url, method) => method === "POST");
    const first = f.controller.shown(ticket), again = f.controller.shown(ticket);
    expect(s(f.controller)).toMatchObject({ phase: "visible_unconfirmed", presentationTicket: null, canSubmit: false, allowedGrades: [], canCorrect: false });
    await held.entered;
    f.controller.openResult();
    expect(s(f.controller)).toMatchObject({ phase: "visible_unconfirmed", allowedGrades: [], canCorrect: false });
    // Gated calls on the busy lane join its running promise instead of queueing a new intent.
    const joined = [f.controller.grade(5), f.controller.submit({ text: "x" }, B2), f.controller.correct()];
    expect(joined[0]).toBe(first);
    held.release(); await Promise.all([first, again, ...joined]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "assignment.present"]);
    expect(s(f.controller)).toMatchObject({ phase: "result", allowedGrades: [3, 4, 5] });
    expect(f.newId).toHaveBeenCalledTimes(2);
  });
});

describe("4. revision of A before / after shown B", () => {
  it("correction before shown B invalidates the prefetched ticket and never self-shows the replacement", async () => {
    const f = fixture();
    const snap = await answered(f, "kamst");
    expect(snap.canCorrect).toBe(true);
    f.controller.openStep(snap.stepTicket!);
    const ticket = s(f.controller).presentationTicket!;
    f.server.replaceOnCorrect = B3;
    f.controller.openResult();
    await f.controller.correct();
    const after = s(f.controller);
    expect(after.currentStep?.step.assignment).toMatchObject({ id: B3, status: "prefetched" });
    expect(after).toMatchObject({ presentationTicket: null, resultA: { result: { grade: 4, version: "2" } } });
    expect(after.display.kind).not.toBe("step");
    await f.controller.shown(ticket);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "result.correct"]);
  });
  it("correction after shown B keeps the shown assignment", async () => {
    const f = fixture();
    await f.controller.refresh(); await f.controller.submit({ text: "kamst" }, B1);
    f.controller.openStep(s(f.controller).stepTicket!);
    await f.controller.shown(s(f.controller).presentationTicket!);
    f.server.replaceOnCorrect = B3;
    expect(s(f.controller).canCorrect).toBe(true);
    await f.controller.correct();
    expect(s(f.controller)).toMatchObject({ phase: "question", display: { kind: "step", assignmentId: B2 }, canSubmit: true });
  });
});

describe("5. exact input and server-only results", () => {
  it("sends text verbatim and forgot exactly; invalid shapes are rejected without POST", async () => {
    const text = "  kommst́\n ", f = fixture();
    await f.controller.refresh();
    for (const bad of [{ text: 1 }, { text: "a", forgot: true }, { forgot: false }, null] as unknown[]) {
      await expect(f.controller.submit(bad as { text: string }, B1)).rejects.toThrow();
    }
    for (const bad of [undefined, null, 7, "not-a-uuid"] as unknown[]) {
      await expect(f.controller.submit({ text }, bad as string)).rejects.toThrow();
    }
    expect(f.posted).toEqual([]);
    await f.controller.submit({ text }, B1);
    expect(f.posted[0]).toMatchObject({ kind: "answer.submit", payload: { text } });
    expect(s(f.controller).resultA?.result).toMatchObject({ grade: 2, correct: false }); // server decided, not the client
    const g = fixture(); await g.controller.refresh(); await g.controller.submit({ forgot: true }, B1);
    expect(g.posted[0].payload).toEqual({ forgot: true });
  });
  it("Ф1: an answer typed for one form is refused without a request once the document shows another form", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canSubmit: true, display: { kind: "step", assignmentId: B1 } });
    // Another window answered B1; the server now presents B2 and this document reached it by two reads.
    const session = f.sessions.get(S1)!;
    session.results.push({ result_id: R1, assignment_id: B1, action_id: id(41), version: "1", grade: 2 });
    session.assignment = B2; f.server.bump();
    await f.controller.refresh(); await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canSubmit: true, display: { kind: "step", assignmentId: B2 } });
    const before = f.newId.mock.calls.length;
    await f.controller.submit({ text: "geh" }, B1);
    await f.controller.submit({ forgot: true }, B1);
    expect(f.posted).toEqual([]);
    expect(f.newId.mock.calls.length).toBe(before);
    expect(s(f.controller).commands.study.pending).toBe(false);
    // The current form accepts its own answer; the address check is case-insensitive.
    await f.controller.submit({ text: "kommst" }, B2.toUpperCase());
    expect(f.posted.map(c => [c.kind, (c as { assignment_id?: string }).assignment_id])).toEqual([["answer.submit", B2]]);
  });
  it("grades from current server targets with versions above 2^53; conflict stays a server fact", async () => {
    const f = fixture();
    await answered(f);
    f.sessions.get(S1)!.results[0].version = HIGH; f.server.bump();
    await f.controller.refresh();
    expect(s(f.controller).resultA?.capabilities.grades?.expected_result_version).toBe(HIGH);
    await expect(f.controller.grade(6 as 5)).rejects.toThrow();
    f.server.rejectNext = "RESULT_VERSION_CONFLICT";
    await f.controller.grade(5);
    expect(f.posted.at(-1)).toMatchObject({ kind: "result.grade", expected_result_version: HIGH, payload: { grade: 5 } });
    expect(s(f.controller).commands.study).toMatchObject({ outcome: "rejected", rejectionCode: "RESULT_VERSION_CONFLICT" });
    await f.controller.grade(3);
    expect(f.posted.at(-1)).toMatchObject({ kind: "result.grade", expected_result_version: HIGH, payload: { grade: 3 } });
    expect(s(f.controller).resultA?.result).toMatchObject({ version: "9007199254740994", grade: 3 });
  });
  it("Ф9: a refusal code reaches the snapshot problem until the lane's next command", async () => {
    const f = fixture();
    await answered(f);
    f.server.rejectNext = "ASSIGNMENT_STALE";
    await f.controller.grade(5);
    expect(s(f.controller)).toMatchObject({ phase: "result", problem: "ASSIGNMENT_STALE",
      commands: { study: { outcome: "rejected", rejectionCode: "ASSIGNMENT_STALE" } } });
    await f.controller.grade(3);
    expect(s(f.controller)).toMatchObject({ phase: "result", problem: null, resultA: { result: { grade: 3 } } });
  });
  it("Ф4: a reply that fails strict parsing is `invalid_response`, never `network` (session read and command lane)", async () => {
    const f = fixture();
    await f.controller.refresh();
    const fetcher = vi.mocked(f.options.transport.fetcher);
    fetcher.mockImplementationOnce(async () => response({ current: { session_id: S1, status: "active", hidden: true }, state_version: f.server.version }));
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "stale", problem: "invalid_response", currentStep: null });

    const g = fixture();
    await g.controller.refresh();
    vi.mocked(g.options.transport.fetcher).mockImplementationOnce(async () => response({ unexpected: true }));
    await g.controller.submit({ text: "kommst" }, B1);
    expect(s(g.controller)).toMatchObject({ phase: "unknown", problem: "invalid_response", canSubmit: false });
  });
});

describe("6. lost answer reply", () => {
  it("unknown answer reads only the session; the accepted proof later licenses the addressed read of A", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.server.lostReply = true;
    await f.controller.submit({ text: "kommst" }, B1);
    f.server.lostReply = false;
    expect(s(f.controller)).toMatchObject({ phase: "unknown", resultA: null, currentStep: null, canSubmit: false });
    await f.controller.refresh();
    // Refresh found the accepted proof via GET; it never POSTed again.
    expect(f.posted).toHaveLength(1);
    expect(s(f.controller)).toMatchObject({ phase: "result", resultA: { address: { result_id: R1, assignment_id: B1 } } });
  });
  it("an unresolved answer never invents a result ID", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.server.failPost = true;
    await f.controller.submit({ text: "kommst" }, B1);
    await f.controller.refresh();
    expect(f.gets.some(g => g.includes("result_id="))).toBe(false);
    expect(s(f.controller)).toMatchObject({ phase: "unknown", resultA: null });
  });
});

describe("7. manual exact retry, storage and GET-only refresh", () => {
  it("retry re-proves by GET and resends the same UUID and payload once", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.server.failPost = true;
    await f.controller.submit({ text: " x " }, B1);
    f.server.failPost = false;
    await f.controller.refresh(); await f.controller.refresh();
    expect(f.posted).toHaveLength(1); // no autoresend
    const before = f.gets.length;
    expect(s(f.controller).canRetry.study).toBe(true);
    await f.controller.retry("study");
    expect(f.posted).toHaveLength(2);
    expect(f.posted[1]).toEqual(f.posted[0]);
    expect(f.gets.slice(before).some(g => g.includes(`/commands/${f.posted[0].command_id}`))).toBe(true);
  });
  it("storage failure prevents POST and keeps the screen gated", async () => {
    const f = fixture();
    await f.controller.refresh();
    vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("disk"));
    await f.controller.submit({ text: "kommst" }, B1);
    expect(f.posted).toEqual([]);
    expect(s(f.controller).commands.study.problem).toBe("storage");
  });
  it("payload mismatch is surfaced without replacing the stored intent", async () => {
    const answer: ConjugationIntent = { command_id: id(62), kind: "answer.submit", session_id: S1, assignment_id: B1, payload: { text: "a" } };
    const f = fixture();
    await f.options.transport.fetcher("/api/v1/commands", { method: "POST", body: JSON.stringify({ ...answer, payload: { text: "b" }, client_instance_id: id(1), document_id: id(2) }) });
    f.posted.length = 0;
    await f.storage.set(studyKey, pendingRecord(answer));
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ problem: "mismatch", canRetry: { study: false }, canSubmit: false });
    expect(JSON.parse(f.values.get(studyKey)!).intent).toMatchObject({ command_id: id(62), payload: { text: "a" } });
    expect(f.posted).toEqual([]);
  });
});

describe("8. independent Stop and terminal memory", () => {
  it("unknown study does not block Stop with a fresh server right; Stop invents no answer outcome", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.server.failPost = true;
    await f.controller.submit({ text: "kommst" }, B1);
    f.server.failPost = false;
    await f.controller.refresh();
    const snap = s(f.controller);
    expect(snap).toMatchObject({ phase: "unknown", canStop: true, canSubmit: false });
    // The unknown-study exception never bypasses the activity gate.
    f.activity.enabled = false; f.controller.setActivity({ enabled: false, visible: true });
    expect(s(f.controller)).toMatchObject({ canStop: false });
    await f.controller.stop("stop");
    expect(f.posted).toHaveLength(1);
    f.activity.enabled = true; f.controller.setActivity({ enabled: true, visible: true });
    expect(s(f.controller)).toMatchObject({ canStop: true });
    await f.controller.stop("stop");
    const closed = s(f.controller);
    expect(closed).toMatchObject({ phase: "closed", display: { kind: "closed" }, terminalSessionIds: [S1], canStop: false });
    expect(closed.commands.study).toMatchObject({ pending: true, outcome: null });
  });
  it("a closed address never revives, even with an equal-version active read", async () => {
    const f = fixture({ terminal: [S1] });
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "closed", currentStep: null, canStart: true, canSubmit: false });
  });
});

describe("9. BigInt floor and stale views", () => {
  it("an external floor hides older views; a vanished publisher never lowers it; stale reads are rejected", async () => {
    let external: string | null = null;
    const f = fixture({ minimum: () => external });
    await f.controller.refresh();
    expect(s(f.controller).phase).toBe("question");
    external = "9007199254741999";
    expect(s(f.controller)).toMatchObject({ phase: "stale", currentStep: null, canSubmit: false, stateVersion: external });
    external = null;
    expect(s(f.controller).stateVersion).toBe("9007199254741999");
    f.server.staleNext = "9007199254740992";
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "stale", problem: "stale_response", currentStep: null });
    f.server.version = "9007199254742000";
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "question", stateVersion: "9007199254742000" });
  });
});

describe("10. lifetime guards", () => {
  it("a disposed owner's late 401 inside access.run never revokes the live access; a live denial still does", async () => {
    const f = fixture();
    const held = f.hold((url, method) => method === "GET" && url.pathname.includes("/sessions/"));
    f.server.denyNext = null;
    const task = f.controller.refresh();
    await held.entered;
    f.server.denyNext = 401;
    f.controller.dispose();
    held.release(); await task;
    expect(f.denied).not.toHaveBeenCalled();
    expect(f.options.access.isLive()).toBe(true);
    expect(s(f.controller).phase).toBe("disposed");
    const g = fixture();
    g.server.denyNext = 403;
    await g.controller.refresh();
    expect(g.denied).toHaveBeenCalledTimes(1);
  });
  it("an adapter source guard that ends during a request also stops the denial", async () => {
    const f = fixture();
    const held = f.hold((url, method) => method === "GET" && url.pathname.includes("/sessions/"));
    const task = f.controller.refresh();
    await held.entered;
    f.server.denyNext = 403; f.endOwner();
    held.release(); await task;
    expect(f.denied).not.toHaveBeenCalled();
  });
  it("a POST that entered transport settles after UI disable; a not-yet-entered POST is refused", async () => {
    const f = fixture();
    await f.controller.refresh();
    const held = f.hold((_url, method) => method === "POST");
    const task = f.controller.submit({ text: "kommst" }, B1);
    await held.entered;
    f.activity.enabled = false; f.controller.setActivity({ enabled: false, visible: true });
    held.release(); await task;
    expect(s(f.controller).commands.study).toMatchObject({ outcome: "accepted", pending: false });
    const g = fixture();
    await g.controller.refresh();
    const save = deferred(); vi.mocked(g.storage.set).mockImplementationOnce(async (k, v) => { await save.promise; g.values.set(k, v); });
    const late = g.controller.submit({ text: "kommst" }, B1);
    g.activity.enabled = false; g.controller.setActivity({ enabled: false, visible: true });
    save.resolve(); await late;
    expect(g.posted).toEqual([]);
  });
  it("hidden closes foreground for this owner; visible=true or refresh does not reopen it", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(s(f.controller).canSubmit).toBe(true);
    f.controller.setActivity({ enabled: true, visible: false });
    f.controller.setActivity({ enabled: true, visible: true });
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canSubmit: false, canStop: false, currentStep: null });
    await f.controller.submit({ text: "kommst" }, B1);
    expect(f.posted).toEqual([]);
  });
  it("snapshots are detached and carry no credentials", async () => {
    const f = fixture();
    const snap = await answered(f);
    (snap.resultA!.capabilities.grades!.values as number[]).push(2);
    snap.currentStep!.step.progress.completed = 99;
    expect(s(f.controller).allowedGrades).toEqual([3, 4, 5]);
    expect(s(f.controller).currentStep?.step.progress.completed).toBe(1);
    expect(JSON.stringify(s(f.controller))).not.toMatch(/synthetic-token|synthetic-proof/);
    expect(f.updates).toHaveBeenCalled();
  });
});

describe("F1 regression: enabled/visible gate every new mutation, Stop included", () => {
  it("disabled closes stop and summary_home; re-enable permits exactly one lawful POST", async () => {
    const f = fixture({ sessions: [summarySeed()] });
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canStop: true, canSummaryHome: true });
    disable(f);
    expect(s(f.controller)).toMatchObject({ canStop: false, canSummaryHome: false, canRetry: { stop: false, study: false } });
    await f.controller.stop("summary_home"); await f.controller.stop("stop");
    expect(f.posted).toEqual([]);
    expect(s(f.controller)).toMatchObject({ phase: "summary", terminalSessionIds: [] });
    enable(f);
    expect(s(f.controller).canSummaryHome).toBe(true);
    await f.controller.stop("summary_home");
    expect(f.posted.map(c => [c.kind, c.payload])).toEqual([["session.stop", { reason: "summary_home" }]]);
    expect(s(f.controller)).toMatchObject({ phase: "closed", terminalSessionIds: [S1] });
  });
  it("disabled closes retry(stop); re-enable resends the exact original once", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.server.failPost = true;
    await f.controller.stop("stop");
    f.server.failPost = false;
    await f.controller.refresh();
    expect(s(f.controller).canRetry.stop).toBe(true);
    disable(f);
    expect(s(f.controller).canRetry.stop).toBe(false);
    await f.controller.retry("stop");
    expect(f.posted).toHaveLength(1);
    enable(f);
    expect(s(f.controller).canRetry.stop).toBe(true);
    await f.controller.retry("stop");
    expect(f.posted).toHaveLength(2);
    expect(f.posted[1]).toEqual(f.posted[0]);
    expect(s(f.controller)).toMatchObject({ phase: "closed" });
  });
  it("disable while the durable save is pending keeps the intent unsent; re-enable + proof resends it once", async () => {
    const f = fixture();
    await f.controller.refresh();
    const save = deferred();
    vi.mocked(f.storage.set).mockImplementationOnce(async (k, v) => { await save.promise; f.values.set(k, v); });
    const task = f.controller.stop("stop");
    await macrotasks();
    disable(f);
    save.resolve(); await task;
    expect(f.posted).toEqual([]);
    const stored = JSON.parse(f.values.get(stopKey)!).intent;
    expect(stored).toMatchObject({ kind: "session.stop", session_id: S1, payload: { reason: "stop" } });
    expect(s(f.controller)).toMatchObject({ canRetry: { stop: false }, canStop: false });
    enable(f);
    await f.controller.refresh(); // GET proof only
    expect(f.posted).toEqual([]);
    await f.controller.retry("stop");
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toMatchObject({ command_id: stored.command_id, kind: "session.stop", payload: { reason: "stop" } });
  });
  it("a Stop POST that already entered transport settles after disable", async () => {
    const f = fixture();
    await f.controller.refresh();
    const held = f.hold((_url, method) => method === "POST");
    const task = f.controller.stop("stop");
    await held.entered;
    disable(f);
    held.release(); await task;
    expect(f.posted).toHaveLength(1);
    expect(s(f.controller)).toMatchObject({ phase: "closed", terminalSessionIds: [S1] });
  });
});

describe("F2 regression: repeats join the pending operation they started", () => {
  it("a repeated start awaits the held start POST; one UUID pair, one POST", async () => {
    const f = fixture({ seed: null, sessions: [] });
    await f.controller.refresh();
    const held = f.hold((_url, method) => method === "POST");
    const first = tracked(f.controller.start());
    await held.entered;
    const second = tracked(f.controller.start());
    await macrotasks();
    expect([first.done, second.done]).toEqual([false, false]);
    held.release();
    await Promise.all([first.promise, second.promise]);
    expect(f.posted.map(c => c.kind)).toEqual(["session.start"]);
    expect(f.newId).toHaveBeenCalledTimes(2);
    expect(s(f.controller)).toMatchObject({ phase: "prefetched", sessionId: id(100) });
  });
  it("the same genuine ticket joins its held present; stale and forged tickets stay immediate no-ops", async () => {
    const f = fixture();
    const after = await answered(f);
    f.controller.openStep(after.stepTicket!);
    const stale = s(f.controller).presentationTicket!;
    disable(f); enable(f); // activity change invalidates the first ticket
    const ticket = s(f.controller).presentationTicket!;
    expect(ticket).not.toBe(stale);
    const held = f.hold((_url, method) => method === "POST");
    const first = tracked(f.controller.shown(ticket));
    await held.entered;
    const replay = tracked(f.controller.shown(ticket));
    const old = tracked(f.controller.shown(stale));
    const forged = tracked(f.controller.shown(Object.freeze({}) as ConjugationPresentationTicket));
    const cloned = tracked(f.controller.shown({ ...ticket }));
    await macrotasks();
    expect({ first: first.done, replay: replay.done, old: old.done, forged: forged.done, cloned: cloned.done })
      .toEqual({ first: false, replay: false, old: true, forged: true, cloned: true });
    expect(s(f.controller).phase).toBe("visible_unconfirmed");
    held.release();
    await Promise.all([first.promise, replay.promise]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "assignment.present"]);
    expect(f.newId).toHaveBeenCalledTimes(2);
    expect(s(f.controller)).toMatchObject({ phase: "question", display: { kind: "step", assignmentId: B2 }, canSubmit: true });
    // After settlement the consumed ticket grants nothing and joins nothing.
    await f.controller.shown(ticket); await f.controller.shown(stale);
    expect(f.posted).toHaveLength(2);
  });
  it("a synchronous onUpdate re-entry with the same ticket joins instead of creating a second present", async () => {
    const f = fixture();
    const after = await answered(f);
    f.controller.openStep(after.stepTicket!);
    const ticket = s(f.controller).presentationTicket!;
    let reentry: ReturnType<typeof tracked> | null = null;
    f.updates.mockImplementation((snapshot: { phase: string }) => {
      if (!reentry && snapshot.phase === "visible_unconfirmed") reentry = tracked(f.controller.shown(ticket));
    });
    const held = f.hold((_url, method) => method === "POST");
    const first = tracked(f.controller.shown(ticket));
    await held.entered; await macrotasks();
    expect(reentry).not.toBeNull();
    expect([first.done, reentry!.done]).toEqual([false, false]);
    held.release();
    await Promise.all([first.promise, reentry!.promise]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
});

describe("F3 regression: summary selection belongs to the caller's openStep", () => {
  it("a resumed server summary stays data with a valid stepTicket until openStep", async () => {
    const f = fixture({ sessions: [summarySeed()] });
    await f.controller.refresh();
    const snap = s(f.controller);
    expect(snap).toMatchObject({ phase: "summary", display: { kind: "none" }, canSummaryHome: true, terminalSessionIds: [] });
    expect(snap.currentStep?.step.status).toBe("summary");
    expect(snap.stepTicket).not.toBeNull();
    f.controller.openStep(snap.stepTicket!);
    expect(s(f.controller)).toMatchObject({ phase: "summary", display: { kind: "summary" }, stepTicket: null });
    expect(f.posted).toEqual([]);
  });
  it("an already presented B still resumes as the question without a new present", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "question", display: { kind: "step", assignmentId: B1 }, presentationTicket: null, canSubmit: true });
    expect(f.posted).toEqual([]);
  });
});

/** Rewrites selected model replies; everything else goes to the fixture's synthetic server unchanged. */
function intercept(f: ReturnType<typeof fixture>, rewrite: (url: URL, method: string, forward: () => Promise<Response>) => Promise<Response> | null) {
  const fetcher = vi.mocked(f.options.transport.fetcher), original = fetcher.getMockImplementation()!;
  fetcher.mockImplementation((input, init) => {
    const forward = () => original(input, init);
    return rewrite(new URL(String(input), "https://model.invalid"), init?.method ?? "GET", forward) ?? forward();
  });
}
const closedS1 = (): Session => ({ id: S1, status: "closed", assignment: null, presented: false, results: [] });
const sessionGets = (f: ReturnType<typeof fixture>, session: string) =>
  f.gets.filter(g => g.split("?")[0].endsWith(`/sessions/${session}`) && !g.includes("result_id=")).length;
async function presentingB(f: ReturnType<typeof fixture>) {
  const after = await answered(f);
  f.controller.openStep(after.stepTicket!);
  const ticket = s(f.controller).presentationTicket!;
  const held = f.hold((_url, method) => method === "POST");
  const present = tracked(f.controller.shown(ticket));
  await held.entered;
  return { held, present };
}

describe("C1: return to the already shown B while its present is pending", () => {
  it("A → B reuses the visible B: one present, one UUID, no rights before settle; clones are no-ops", async () => {
    const f = fixture();
    const { held, present } = await presentingB(f);
    f.controller.openResult();
    const back = s(f.controller);
    expect(back).toMatchObject({ phase: "visible_unconfirmed", display: { kind: "result" }, presentationTicket: null,
      canSubmit: false, allowedGrades: [], canCorrect: false });
    expect(back.stepTicket).not.toBeNull();
    expect(s(f.controller).stepTicket).toBe(back.stepTicket); // stable reference
    f.controller.openStep({ ...back.stepTicket! });
    f.controller.openStep(Object.freeze({}) as ConjugationStepTicket);
    expect(s(f.controller).display).toEqual({ kind: "result" });
    f.controller.openStep(back.stepTicket!);
    const onB = s(f.controller);
    expect(onB).toMatchObject({ phase: "visible_unconfirmed", display: { kind: "step", assignmentId: B2 }, presentationTicket: null,
      stepTicket: null, canSubmit: false, allowedGrades: [], canCorrect: false });
    // Dependent mutations stay behind the barrier: they join the running present, never queue a POST.
    const gated = [tracked(f.controller.submit({ text: "kommst" }, B2)), tracked(f.controller.grade(5)), tracked(f.controller.correct())];
    f.controller.openStep(back.stepTicket!); // consumed
    expect(s(f.controller).display).toEqual({ kind: "step", assignmentId: B2 });
    await macrotasks();
    expect([present.done, ...gated.map(g => g.done)]).toEqual([false, false, false, false]);
    held.release();
    await Promise.all([present.promise, ...gated.map(g => g.promise)]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "assignment.present"]);
    expect(f.newId).toHaveBeenCalledTimes(2);
    expect(s(f.controller)).toMatchObject({ phase: "question", display: { kind: "step", assignmentId: B2 }, canSubmit: true });
    // After settle the return ticket is dead; back on A the caller gets an ordinary ticket again.
    f.controller.openResult();
    const settled = s(f.controller);
    expect(settled.stepTicket).not.toBeNull();
    expect(settled.stepTicket).not.toBe(back.stepTicket);
    f.controller.openStep(back.stepTicket!);
    expect(s(f.controller).display).toEqual({ kind: "result" });
  });
  it("activity change invalidates the return ticket; disabled issues none (F1)", async () => {
    const f = fixture();
    const { held, present } = await presentingB(f);
    f.controller.openResult();
    const first = s(f.controller).stepTicket!;
    expect(first).not.toBeNull();
    disable(f);
    expect(s(f.controller)).toMatchObject({ stepTicket: null, canSubmit: false, canStop: false });
    f.controller.openStep(first);
    expect(s(f.controller).display).toEqual({ kind: "result" });
    enable(f);
    const renewed = s(f.controller).stepTicket!;
    expect(renewed).not.toBeNull();
    expect(renewed).not.toBe(first);
    f.controller.openStep(first);
    expect(s(f.controller).display).toEqual({ kind: "result" });
    held.release(); await present.promise;
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("a B that was never shown gets no return ticket and is never presented by itself", async () => {
    // Resumed durable present for B1 not yet known to the server: no A is displayed, so nothing may lead to B.
    const present: ConjugationIntent = { command_id: id(63), kind: "assignment.present", session_id: S1, assignment_id: B1, payload: {} };
    const f = fixture({ saved: [present], sessions: [{ id: S1, status: "active", assignment: B1, presented: false, results: [] }] });
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "visible_unconfirmed", display: { kind: "none" }, stepTicket: null, presentationTicket: null, canSubmit: false });
    // A prefetched B behind A without any present: only the ordinary ticket, and openStep never POSTs.
    const g = fixture();
    const after = await answered(g);
    g.controller.openStep(after.stepTicket!);
    expect(s(g.controller)).toMatchObject({ phase: "prefetched", display: { kind: "step", assignmentId: B2 } });
    await macrotasks();
    expect([f.posted, g.posted.map(c => c.kind)]).toEqual([[], ["answer.submit"]]);
  });
});

describe("C2: closed facts come only from the server", () => {
  it("accepted Stop carries reason and summary from the server reply", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(s(f.controller).closed).toBeNull();
    await f.controller.stop("stop");
    const snap = s(f.controller);
    expect(snap).toMatchObject({ phase: "closed", closed: { sessionId: S1, reason: "stop" } });
    expect(snap.closed!.summary).toEqual(projection({ ...closedS1(), id: S1 }).summary);
  });
  it("an accepted Stop whose reply view was dropped knows no reason; refresh asks the server once", async () => {
    const f = fixture();
    await f.controller.refresh();
    intercept(f, (_url, method, forward) => method !== "POST" ? null : forward().then(async reply => {
      const body = await reply.json() as Record<string, unknown>;
      return response({ ...body, state_version: "9007199254740000" }); // older than every floor: the view is not observed
    }));
    await f.controller.stop("stop");
    expect(s(f.controller)).toMatchObject({ phase: "closed", closed: { sessionId: S1, reason: null, summary: null } });
    const before = sessionGets(f, S1);
    await f.controller.refresh();
    expect(sessionGets(f, S1) - before).toBe(1);
    expect(s(f.controller)).toMatchObject({ closed: { sessionId: S1, reason: "stop", summary: { completed: 0 } } });
    await f.controller.refresh();
    expect(sessionGets(f, S1) - before).toBe(1); // summary known: no further addressed GET
  });
  it("a closed boundary gives summary null; the same refresh reads the closed session once", async () => {
    const stop: ConjugationIntent = { command_id: id(64), kind: "session.stop", session_id: S1, payload: { reason: "stop" } };
    const f = fixture({ saved: [stop], sessions: [closedS1()] });
    intercept(f, (url, _method) => !url.pathname.includes("/commands/") ? null : Promise.resolve(response({
      command: { id: stop.command_id, status: "not_found" }, current: profile(f.server.version), state_version: f.server.version,
      closed_session: { session_id: S1, status: "closed", close_reason: "stop" } })));
    const held = f.hold((url, method) => method === "GET" && url.pathname.endsWith(`/sessions/${S1}`));
    const task = f.controller.refresh();
    await held.entered;
    expect(s(f.controller)).toMatchObject({ closed: { sessionId: S1, reason: "stop", summary: null } });
    held.release(); await task;
    expect(sessionGets(f, S1)).toBe(1);
    expect(s(f.controller)).toMatchObject({ phase: "closed", closed: { sessionId: S1, reason: "stop", summary: { completed: 0, blocks: expect.any(Array) } } });
    expect(f.posted).toEqual([]);
  });
  it("a terminal ID is final: an active read is ignored and grants nothing; a foreign terminal never fills closed", async () => {
    const f = fixture({ terminal: [S1] });
    expect(s(f.controller).closed).toEqual({ sessionId: S1, reason: null, summary: null });
    await f.controller.refresh();
    expect(sessionGets(f, S1)).toBe(1);
    expect(s(f.controller)).toMatchObject({ phase: "closed", closed: { sessionId: S1, reason: null, summary: null }, currentStep: null,
      canSubmit: false, canStop: false });
    const g = fixture({ terminal: [S2] });
    await g.controller.refresh();
    expect(s(g.controller)).toMatchObject({ phase: "question", closed: null });
    expect(sessionGets(g, S2)).toBe(0);
  });
  it("a stale closed read supplies immutable facts only to an already terminal session, never rights or terminality", async () => {
    const f = fixture({ terminal: [S1], sessions: [closedS1()] });
    f.server.staleNext = "9007199254740000";
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "closed", closed: { sessionId: S1, reason: "stop", summary: { completed: 0 } },
      canStop: false, canSummaryHome: false, canSubmit: false, allowedGrades: [] });
    const g = fixture({ sessions: [closedS1()] });
    g.server.staleNext = "9007199254740000";
    await g.controller.refresh();
    expect(s(g.controller)).toMatchObject({ phase: "stale", closed: null, terminalSessionIds: [] });
    expect(g.posted).toEqual([]);
  });
});

describe("C3: a retained A address is identity only, never authority", () => {
  const answeredS1 = (grade: 2 | 4 = 4): Session => ({ id: S1, status: "active", assignment: B2, presented: false,
    results: [{ result_id: R1, assignment_id: B1, action_id: id(41), version: "1", grade }] });
  const addressA = () => ({ session_id: S1, assignment_id: B1, result_id: R1 });
  const resultGets = (f: ReturnType<typeof fixture>) => f.gets.filter(g => g.includes(`result_id=${R1}`));
  it("a same-session address licenses only the addressed GET; rights come from that fresh read", async () => {
    const f = fixture({ sessions: [answeredS1()] }), address = addressA();
    const c = new ConjugationDocumentController({ ...f.options, initialResultAddress: address });
    address.result_id = id(99); // the caller's object is copied, not referenced
    expect(s(c)).toMatchObject({ acceptedAddress: { session_id: S1, assignment_id: B1, result_id: R1 }, resultA: null, allowedGrades: [], canCorrect: false });
    await c.refresh();
    expect(resultGets(f)).toHaveLength(1);
    expect(resultGets(f)[0]).toContain(`assignment_id=${B1}`);
    expect(s(c)).toMatchObject({ display: { kind: "none" }, allowedGrades: [3, 4, 5], resultA: { address: { session_id: S1, assignment_id: B1, result_id: R1 } } });
    c.openResult();
    expect(s(c)).toMatchObject({ phase: "result", display: { kind: "result" } });
    expect(f.posted).toEqual([]);
  });
  it("when the server grants nothing, the address grants nothing", async () => {
    const f = fixture({ sessions: [answeredS1(2)] });
    const c = new ConjugationDocumentController({ ...f.options, initialResultAddress: addressA() });
    await c.refresh();
    expect(s(c)).toMatchObject({ allowedGrades: [], resultA: { result: { grade: 2 } } });
    const g = fixture({ sessions: [answeredS1()] });
    g.server.failResultRead = true;
    const d = new ConjugationDocumentController({ ...g.options, initialResultAddress: addressA() });
    await d.refresh();
    expect(s(d)).toMatchObject({ resultA: null, allowedGrades: [], canCorrect: false, acceptedAddress: { result_id: R1 } });
    expect([f.posted, g.posted]).toEqual([[], []]);
  });
  it("a foreign, seedless or terminal address is ignored without any GET; a malformed one is a context error", async () => {
    const cases: [Partial<ConjugationDocumentOptions>, Parameters<typeof fixture>[0]][] = [
      [{ initialResultAddress: { ...addressA(), session_id: S2 } }, {}],
      [{ initialResultAddress: addressA(), initialSessionId: null }, { seed: null }],
      [{ initialResultAddress: addressA(), terminalSessionIds: [S1] }, { terminal: [S1] }],
    ];
    for (const [extra, config] of cases) {
      const f = fixture({ ...config, sessions: [answeredS1()] });
      const c = new ConjugationDocumentController({ ...f.options, ...extra });
      expect(s(c).acceptedAddress).toBeNull();
      await c.refresh();
      expect(resultGets(f)).toEqual([]);
      expect(s(c)).toMatchObject({ resultA: null, allowedGrades: [], acceptedAddress: null });
    }
    const f = fixture();
    for (const bad of [{ session_id: S1, assignment_id: B1 }, { ...addressA(), result_id: "x" }, { ...addressA(), extra: 1 }, "a"]) {
      expect(() => new ConjugationDocumentController({ ...f.options, initialResultAddress: bad as never })).toThrow();
    }
  });
  it("the published address survives a raised floor and is detached; Start, terminal and disposal withdraw it", async () => {
    let external: string | null = null;
    const f = fixture({ minimum: () => external });
    const after = await answered(f);
    expect(after.acceptedAddress).toEqual({ session_id: S1, assignment_id: B1, result_id: R1 });
    (after.acceptedAddress as { result_id: string }).result_id = id(98); // a detached copy: mutation must not reach the controller
    external = "9007199254741999";
    expect(s(f.controller)).toMatchObject({ phase: "stale", resultA: null, acceptedAddress: { session_id: S1, assignment_id: B1, result_id: R1 } });
    f.controller.dispose();
    expect(s(f.controller).acceptedAddress).toBeNull();
    const g = fixture();
    await answered(g);
    await g.controller.stop("stop");
    expect(s(g.controller)).toMatchObject({ phase: "closed", acceptedAddress: null });
    await g.controller.start();
    expect(s(g.controller).sessionId).not.toBe(S1);
    expect(s(g.controller).acceptedAddress).toBeNull();
  });
});
