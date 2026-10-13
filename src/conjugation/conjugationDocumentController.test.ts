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
type Result = { result_id: string; assignment_id: string; action_id: string; version: string; grade: 2 | 3 | 4 | 5; undone?: true };
type Session = { id: string; status: "active" | "summary" | "closed"; assignment: string | null; presented: boolean; results: Result[] };

/** The form issued anew after an undo (core: new assignment_id of the same form, prefetched). */
const REISSUED = id(24);
function projection(s: Session): ConjugationSessionProjection {
  const live = s.results.filter(r => !r.undone);
  const done = live.length, correct = live.filter(r => r.grade >= 3).length;
  const total = s.status === "active" ? done + 1 : done;
  const summary = s.status === "active" ? null : { completed_cycle_ids: [], partial: [{ cycle_id: id(9), answered_groups: ["ich"] }],
    results: live.map(r => ({ result_id: r.result_id, version: r.version })), completed: done, correct, wrong: done - correct,
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
/** `grantUndo`: core grants the one undo only for the latest live answer of an open session, until the next answer. */
function resultEnvelope(s: Session, r: Result, grantUndo = true) {
  const step = projection(s), live = s.status !== "closed" && !r.undone;
  const target = { session_id: s.id, assignment_id: r.assignment_id, result_id: r.result_id, expected_result_version: r.version };
  const latest = s.results.filter(x => !x.undone).at(-1) === r;
  const status = r.undone ? "undone" : "active";
  return { action: { action_id: r.action_id, kind: "answer.submit", version: r.version, status },
    result: { result_id: r.result_id, assignment_id: r.assignment_id, version: r.version, grade: r.grade, correct: r.grade >= 3,
      status, accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: null },
    step, capabilities: { ...step.capabilities, grades: live && r.grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: live && r.grade === 2 ? target : null,
      undo_target: live && latest && grantUndo ? { ...target, action_id: r.action_id, kind: "answer.submit" } : null } };
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
    lostReply: false, failPost: false, rejectNext: null as string | null, replaceOnCorrect: null as string | null, noUndoRight: false, unavailableStatus: false,
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
    if (intent.kind === "answer.submit" || intent.kind === "result.grade" || intent.kind === "result.correct" || intent.kind === "result.undo") {
      const r = s.results.find(x => x.assignment_id === intent.assignment_id)!;
      return { body: resultEnvelope(s, r, !server.noUndoRight), r };
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
      // The first answer is R1; an answer after an undo is a new result (core never reuses a result ID).
      s.results.push({ result_id: id(31 + s.results.length), assignment_id: intent.assignment_id, action_id: id(41 + s.results.length), version: "1", grade });
      if (config.lastAnswer) { s.status = "summary"; s.assignment = null; } else { s.assignment = B2; }
      s.presented = false;
    }
    if (intent.kind === "result.grade" || intent.kind === "result.correct") {
      const r = s.results.find(x => x.result_id === intent.result_id)!;
      r.version = String(BigInt(r.version) + 1n); r.grade = intent.kind === "result.correct" ? 4 : intent.payload.grade as 3 | 4 | 5;
      if (intent.kind === "result.correct" && server.replaceOnCorrect && !s.presented) s.assignment = server.replaceOnCorrect;
    }
    if (intent.kind === "result.undo") {
      // core _undo_conjugation_form: the answer is retired at the next version, the session is open again with the form issued anew.
      const r = s.results.find(x => x.result_id === intent.result_id)!;
      r.undone = true; r.version = String(BigInt(r.version) + 1n);
      s.status = "active"; s.assignment = REISSUED; s.presented = false;
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
      // core sessions.py: summary_home outside the summary phase is a VALIDATION_FAILED refusal (V-1).
      if (intent.kind === "session.stop" && intent.payload.reason === "summary_home" && sessions.get(intent.session_id)?.status !== "summary"
        && !accepted.has(intent.command_id)) {
        return response({ ...envelopeFor(intent).body, command: { id: intent.command_id, status: "rejected" }, error: { code: "VALIDATION_FAILED" },
          state_version: stateVersion }, 422);
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
      // The acceptance fact stays readable but grants no document access (core command_status: unavailable).
      if (server.unavailableStatus) return response({ action: null, result: null, step: { status: "unavailable" }, command: fact(intent, "already_applied", r),
        capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false },
        verified_intent_hash: hash, state_version: stateVersion });
      return response({ ...body, command: fact(intent, "already_applied", r), verified_intent_hash: hash, state_version: stateVersion });
    }
    const sessionId = url.pathname.split("/").at(-1)!, s = sessions.get(sessionId) ?? { id: sessionId, status: "active", assignment: B1, presented: true, results: [] };
    const version = server.staleNext ?? stateVersion; server.staleNext = null;
    if (url.searchParams.has("result_id")) {
      if (server.failResultRead) return response({ error: { code: "UNAVAILABLE" } }, 503);
      const r = s.results.find(x => x.result_id === url.searchParams.get("result_id"))!;
      return response({ ...resultEnvelope(s as Session, r, !server.noUndoRight), state_version: version });
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
  return { controller, options, values, storage, sessions, server, posted, gets, newId, updates, denied, activity, hold, fetcher,
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

describe("9a. the selected session open in another pair (R1, C178)", () => {
  /** The server's replies, rewritten while `rewrite` names a change (the pair changed on another device, a lost read). */
  const wrap = (f: ReturnType<typeof fixture>, rewrite: () => ((raw: string) => string) | null) => {
    const base = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const reply = await base(url, init), change = rewrite();
      return change ? new Response(change(await reply.text()), { status: reply.status }) : reply;
    });
  };
  const otherPair = (raw: string) => raw.split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
  it("a step of the selected session in another pair is a kept fact, never the shown problem; it grants no Stop", async () => {
    const f = fixture(); let move = false; wrap(f, () => move ? otherPair : null);
    await f.controller.refresh(); move = true; await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "stale", problem: null, pairMismatch: S1, currentStep: null, canStop: false });
  });
  it("a failed read after it names its own problem; the fact stays", async () => {
    const f = fixture(); let mode: "own" | "moved" | "fail" = "own";
    wrap(f, () => mode === "moved" ? otherPair : mode === "fail" ? () => { throw new TypeError("network"); } : null);
    await f.controller.refresh(); mode = "moved"; await f.controller.refresh(); mode = "fail"; await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "stale", pairMismatch: S1, canStop: false });
    expect(s(f.controller).problem).not.toBeNull();
  });
  // QA-R1-V3 F2: a closed selected session is no session open in another pair; its fact is never published.
  it("after the closure of the selected session the fact is not published", async () => {
    const f = fixture(); let move = false; wrap(f, () => move ? otherPair : null);
    await f.controller.refresh(); move = true; await f.controller.refresh();
    expect(s(f.controller).pairMismatch).toBe(S1);
    f.sessions.get(S1)!.status = "closed"; f.sessions.get(S1)!.assignment = null; f.server.bump();
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "closed", pairMismatch: null, canStop: false });
  });
  it("a step below the floor proves nothing; a step of this pair ends the fact", async () => {
    const f = fixture(); let move = false; wrap(f, () => move ? otherPair : null);
    await f.controller.refresh();
    move = true; f.server.staleNext = "9007199254740900"; await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ problem: "stale_response", pairMismatch: null });
    await f.controller.refresh();
    expect(s(f.controller).pairMismatch).toBe(S1);
    move = false; f.server.bump(); await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "question", problem: null, pairMismatch: null });
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
  it("a suspended owner with a session is loading until its window's foreground answers, never stale (2.33)", async () => {
    const f = fixture();
    await f.controller.refresh();
    f.controller.setActivity({ enabled: true, visible: false });
    expect(s(f.controller)).toMatchObject({ phase: "loading", problem: null, currentStep: null });
    f.controller.setActivity({ enabled: true, visible: true });
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "loading", problem: null, canSubmit: false, canStop: false });
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

describe("M-UNDO-CONJ: «Шаг назад» (result.undo) of the form on screen", () => {
  const undoBody = (version = "1") => ({ kind: "result.undo", session_id: S1, assignment_id: B1, result_id: R1, expected_result_version: version, payload: {} });

  it("is offered only with the server's undo_target of the A on screen and sends exactly its address", async () => {
    const f = fixture();
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canUndo: false });
    await answered(f);
    expect(s(f.controller)).toMatchObject({ phase: "result", canUndo: true, resultA: { capabilities: { undo_target: { result_id: R1, expected_result_version: "1" } } } });
    await f.controller.undo();
    const sent = f.posted.at(-1)!;
    expect(sent).toMatchObject(undoBody());
    // The action ID and kind of the right stay out of the command (C-UNDO-1: only the result address).
    expect(Object.keys(sent).sort()).toEqual(["assignment_id", "client_instance_id", "command_id", "document_id", "expected_result_version",
      "kind", "payload", "result_id", "session_id"]);
    expect(f.posted.filter(c => c.kind === "result.undo")).toHaveLength(1);
  });

  it("accepted: the answer is gone, the same form comes back as a new prefetched question that openStep selects", async () => {
    const f = fixture();
    await answered(f);
    const first = s(f.controller).acceptedAddress;
    expect(first).toMatchObject({ result_id: R1 });
    await f.controller.undo();
    const after = s(f.controller);
    expect(after).toMatchObject({ resultA: null, acceptedAddress: null, canUndo: false, canCorrect: false, allowedGrades: [],
      display: { kind: "none" }, phase: "prefetched", problem: null,
      commands: { study: { outcome: "accepted", resolved: { kind: "result.undo", resultId: R1, assignmentId: B1 } } },
      currentStep: { step: { status: "active", assignment: { id: REISSUED, status: "prefetched" } } } });
    expect(after.stepTicket).not.toBeNull();
    f.controller.openStep(after.stepTicket!);
    expect(s(f.controller)).toMatchObject({ display: { kind: "step", assignmentId: REISSUED }, phase: "prefetched" });
    expect(s(f.controller).presentationTicket).not.toBeNull();
    // Not a chain: no earlier answer takes its place and there is nothing to step back to.
    f.controller.openResult();
    expect(s(f.controller)).toMatchObject({ display: { kind: "step" }, resultA: null });
    await expect(f.controller.undo()).resolves.toBeUndefined();
    expect(f.posted.filter(c => c.kind === "result.undo")).toHaveLength(1);
  });

  it("from the live summary: the session is open again and the last form is a question, not the summary", async () => {
    const f = fixture({ lastAnswer: true });
    const snap = await answered(f);
    f.controller.openStep(snap.stepTicket!);
    expect(s(f.controller)).toMatchObject({ phase: "summary", display: { kind: "summary" }, canUndo: true, canSummaryHome: true });
    await f.controller.undo();
    expect(s(f.controller)).toMatchObject({ phase: "prefetched", display: { kind: "none" }, canSummaryHome: false, resultA: null,
      currentStep: { step: { status: "active", assignment: { id: REISSUED, status: "prefetched" } } } });
    expect(s(f.controller).stepTicket).not.toBeNull();
    expect(s(f.controller).terminalSessionIds).toEqual([]);
  });

  it("undoes a corrected answer at its current version and a version above 2^53 stays a decimal string", async () => {
    const f = fixture();
    await answered(f, "wrong");
    await f.controller.correct();
    expect(s(f.controller).resultA?.result).toMatchObject({ version: "2", grade: 4 });
    await f.controller.undo();
    expect(f.posted.at(-1)).toMatchObject(undoBody("2"));
    const g = fixture();
    await answered(g);
    g.sessions.get(S1)!.results[0].version = HIGH; g.server.bump();
    await g.controller.refresh();
    await g.controller.undo();
    expect(g.posted.at(-1)).toMatchObject(undoBody(HIGH));
    expect(s(g.controller).commands.study).toMatchObject({ outcome: "accepted", resolved: { objectVersion: "9007199254740994" } });
  });

  it("is closed while B is shown but not confirmed, while a revision is pending, when inactive, and when the server grants no right", async () => {
    const f = fixture();
    const snap = await answered(f);
    f.controller.openStep(snap.stepTicket!);
    const ticket = s(f.controller).presentationTicket!;
    const held = f.hold((_url, method) => method === "POST");
    const shown = f.controller.shown(ticket);
    expect(s(f.controller)).toMatchObject({ phase: "visible_unconfirmed", canUndo: false });
    await held.entered;
    f.controller.openResult();
    expect(s(f.controller)).toMatchObject({ canUndo: false });
    const joined = f.controller.undo();
    expect(joined).toBe(shown);
    held.release(); await Promise.all([shown, joined]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "assignment.present"]);
    // Confirmed B: returning to A keeps the right (a shown, unconfirmed B was the only thing that closed it).
    expect(s(f.controller)).toMatchObject({ phase: "result", canUndo: true });
    disable(f);
    expect(s(f.controller)).toMatchObject({ canUndo: false });
    await f.controller.undo();
    expect(f.posted.filter(c => c.kind === "result.undo")).toHaveLength(0);
    enable(f);
    const none = fixture();
    await answered(none);
    none.server.noUndoRight = true;
    await none.controller.refresh();
    expect(s(none.controller)).toMatchObject({ phase: "result", canUndo: false, resultA: { capabilities: { undo_target: null } } });
    await none.controller.undo();
    expect(none.posted.filter(c => c.kind === "result.undo")).toHaveLength(0);
  });

  it("a repeated call joins the running undo: one command ID, one POST", async () => {
    const f = fixture();
    await answered(f);
    const held = f.hold((_url, method) => method === "POST");
    const first = f.controller.undo();
    await held.entered;
    const again = f.controller.undo();
    expect(s(f.controller)).toMatchObject({ canUndo: false });
    held.release(); await Promise.all([first, again]);
    expect(f.posted.filter(c => c.kind === "result.undo")).toHaveLength(1);
  });

  it.each(["CAPABILITY_EXPIRED", "VERSION_CONFLICT", "FORBIDDEN", "ASSIGNMENT_STALE"])("refusal %s keeps the answer, re-reads session and result, offers no timer-driven step", async code => {
    const f = fixture();
    await answered(f);
    f.server.noUndoRight = true; // the server no longer grants it (e.g. the next answer already closed it in another window)
    f.server.rejectNext = code;
    const readsBefore = f.gets.length;
    await f.controller.undo();
    expect(s(f.controller)).toMatchObject({ phase: "result", canUndo: false, problem: code, display: { kind: "result" },
      commands: { study: { outcome: "rejected", rejectionCode: code } }, resultA: { capabilities: { undo_target: null } } });
    expect(f.gets.slice(readsBefore).some(g => g.includes(`/sessions/${S1}`) && g.includes(`result_id=${R1}`))).toBe(true);
    expect(f.gets.slice(readsBefore).some(g => g.includes(`/sessions/${S1}`) && !g.includes("result_id="))).toBe(true);
  });

  it("an answer that the server shows undone (undone in another window) is withdrawn when it is read again", async () => {
    const f = fixture();
    await answered(f);
    const r = f.sessions.get(S1)!.results[0];
    r.undone = true; r.version = "2"; const session = f.sessions.get(S1)!; session.assignment = REISSUED; session.presented = false; f.server.bump();
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ resultA: null, acceptedAddress: null, canUndo: false, display: { kind: "none" }, phase: "prefetched",
      currentStep: { step: { assignment: { id: REISSUED } } } });
  });

  it("a lost reply is unknown, blocks a second undo, and the same-ID check settles it as accepted", async () => {
    const f = fixture();
    await answered(f);
    f.server.lostReply = true;
    await f.controller.undo();
    const unknown = s(f.controller);
    expect(unknown).toMatchObject({ phase: "unknown", canUndo: false, resultA: null, problem: "network",
      commands: { study: { pending: true, kind: "result.undo", pendingIntent: { kind: "result.undo", expected_result_version: "1" } } } });
    f.server.lostReply = false;
    const commandId = f.posted.at(-1)!.command_id;
    await f.controller.refresh();
    expect(f.posted.filter(c => c.kind === "result.undo")).toHaveLength(1);
    expect(f.gets.some(g => g.includes(`/commands/${commandId}`) && g.includes("expected_intent_hash="))).toBe(true);
    expect(s(f.controller)).toMatchObject({ commands: { study: { outcome: "accepted", pending: false } }, resultA: null, acceptedAddress: null,
      display: { kind: "none" }, currentStep: { step: { assignment: { id: REISSUED, status: "prefetched" } } } });
    expect(f.values.has(studyKey)).toBe(false);
  });

  it("an acceptance that carries no view (unavailable) still retires the answer: its address never comes back as A", async () => {
    const f = fixture();
    await answered(f);
    f.server.lostReply = true;
    await f.controller.undo();
    f.server.lostReply = false; f.server.unavailableStatus = true;
    const readsBefore = f.gets.filter(g => g.includes(`result_id=${R1}`)).length;
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ commands: { study: { outcome: "accepted", resolved: { kind: "result.undo" } } },
      resultA: null, acceptedAddress: null, canUndo: false, canCorrect: false, allowedGrades: [], display: { kind: "none" } });
    // The retired answer has no address left to read: neither this refresh nor the next asks the server for it.
    await f.controller.refresh();
    expect(f.gets.filter(g => g.includes(`result_id=${R1}`)).length).toBe(readsBefore);
    expect(s(f.controller).resultA).toBeNull();
  });

  it("a lost undo is resent with the same ID and payload only while the right is still granted", async () => {
    const f = fixture();
    await answered(f);
    f.server.failPost = true;
    await f.controller.undo();
    f.server.failPost = false;
    const sentId = f.posted.at(-1)!.command_id;
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canRetry: { study: true } });
    await f.controller.retry("study");
    expect(f.posted.filter(c => c.kind === "result.undo").map(c => c.command_id)).toEqual([sentId, sentId]);
    expect(s(f.controller)).toMatchObject({ commands: { study: { outcome: "accepted" } }, resultA: null });
    // The right is gone: nothing is resent and the right is not created again.
    const g = fixture();
    await answered(g);
    g.server.failPost = true;
    await g.controller.undo();
    g.server.failPost = false; g.server.noUndoRight = true;
    await g.controller.refresh();
    expect(s(g.controller)).toMatchObject({ canRetry: { study: false }, canUndo: false });
    await g.controller.retry("study");
    expect(g.posted.filter(c => c.kind === "result.undo")).toHaveLength(1);
  });

  it("an undo pending in the durable slot survives a restart and stays an unsent unknown until the person checks", async () => {
    const f = fixture();
    await answered(f);
    f.server.failPost = true;
    await f.controller.undo();
    f.server.failPost = false;
    const stored = f.values.get(studyKey)!;
    expect(JSON.parse(stored).intent).toMatchObject({ kind: "result.undo", result_id: R1 });
    const g = fixture({ saved: [JSON.parse(stored).intent], sessions: [structuredClone(f.sessions.get(S1)!)] });
    await g.controller.refresh();
    expect(g.posted).toEqual([]);
    expect(s(g.controller)).toMatchObject({ phase: "unknown", canUndo: false, commands: { study: { pending: true, kind: "result.undo" } } });
  });
});

describe("V-1 (C083): «На Сегодня» waits for a ready study lane and a fresh natural summary; Stop does not", () => {
  const stops = (f: ReturnType<typeof fixture>) => f.posted.filter(c => c.kind === "session.stop").map(c => c.payload);
  async function atSummary(f: ReturnType<typeof fixture>) {
    const snap = await answered(f);
    f.controller.openStep(snap.stepTicket!);
    expect(s(f.controller)).toMatchObject({ phase: "summary", display: { kind: "summary" }, canUndo: true, canSummaryHome: true, canStop: true });
  }
  /** After an accepted undo: open, show and answer the reissued form, then open the new summary. */
  async function answerAgain(f: ReturnType<typeof fixture>) {
    f.controller.openStep(s(f.controller).stepTicket!);
    await f.controller.shown(s(f.controller).presentationTicket!);
    await f.controller.submit({ text: "kommst" }, REISSUED);
    f.controller.openStep(s(f.controller).stepTicket!);
  }

  it("U→C: while the undo is in flight the button is closed and a held click sends nothing; Stop stays open", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    const before = s(f.controller); // the snapshot an old click handler was rendered from
    expect(before.canSummaryHome).toBe(true);
    const held = f.hold((_url, method) => method === "POST");
    const undo = f.controller.undo();
    // Synchronously, before any update reaches the screen: the controller re-reads its own state.
    await f.controller.stop("summary_home");
    await held.entered;
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, canStop: true, canUndo: false });
    await f.controller.stop("summary_home");
    held.release(); await undo;
    // Every published snapshot while the undo was pending kept the button closed.
    const published = f.updates.mock.calls.map(([snap]) => snap as ReturnType<typeof s>);
    expect(published.filter(snap => snap.commands.study.kind === "result.undo" && snap.commands.study.pending).some(snap => snap.canSummaryHome)).toBe(false);
    expect(s(f.controller)).toMatchObject({ phase: "prefetched", canSummaryHome: false, terminalSessionIds: [] });
    expect(stops(f)).toEqual([]);
    // The person answers the reissued form: the new natural summary allows «На Сегодня» again, exactly once.
    await answerAgain(f);
    expect(s(f.controller)).toMatchObject({ phase: "summary", canSummaryHome: true });
    await f.controller.stop("summary_home");
    expect(stops(f)).toEqual([{ reason: "summary_home" }]);
    expect(s(f.controller)).toMatchObject({ phase: "closed", terminalSessionIds: [S1] });
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "result.undo", "assignment.present", "answer.submit", "session.stop"]);
  });

  it("C→U: a started summary_home closes undo and new study until its outcome is known", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    const held = f.hold((_url, method) => method === "POST");
    const home = f.controller.stop("summary_home");
    expect(s(f.controller)).toMatchObject({ canUndo: false, canSummaryHome: false });
    await f.controller.undo();
    await held.entered;
    expect(s(f.controller)).toMatchObject({ phase: "stopping", canUndo: false, canSubmit: false, canStart: false });
    await f.controller.undo();
    held.release(); await home;
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "session.stop"]);
    expect(s(f.controller)).toMatchObject({ phase: "closed", canUndo: false });
  });

  it("C→U: a definite refusal of summary_home is an outcome; only then the undo is offered again", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    f.server.rejectNext = "VALIDATION_FAILED";
    await f.controller.stop("summary_home");
    expect(s(f.controller)).toMatchObject({ commands: { stop: { outcome: "rejected", pending: false } }, canUndo: true, canSummaryHome: true });
    await f.controller.undo();
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "session.stop", "result.undo"]);
  });

  it("lost undo reply: summary_home stays closed while the undo is unknown; Stop is a positive control", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    f.server.lostReply = true;
    await f.controller.undo();
    f.server.lostReply = false;
    expect(s(f.controller)).toMatchObject({ phase: "unknown", canSummaryHome: false, canStop: true });
    await f.controller.stop("summary_home");
    expect(stops(f)).toEqual([]);
    await f.controller.stop("stop");
    expect(stops(f)).toEqual([{ reason: "stop" }]);
    expect(s(f.controller)).toMatchObject({ phase: "closed" });
  });

  it("lost summary_home reply: no undo or answer until the same-ID check settles it", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    f.server.lostReply = true;
    await f.controller.stop("summary_home");
    f.server.lostReply = false;
    expect(s(f.controller)).toMatchObject({ phase: "unknown", canUndo: false, canSummaryHome: false,
      commands: { stop: { pending: true, kind: "session.stop" } } });
    await f.controller.undo();
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "session.stop"]);
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "closed", commands: { stop: { outcome: "accepted" } } });
    expect(f.posted.filter(c => c.kind === "result.undo")).toEqual([]);
  });

  it("a fresh projection during the undo does not reopen the button", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    // The undo is unknown and its retry is held at the POST: a fresh session read still says «summary».
    f.server.failPost = true;
    await f.controller.undo();
    f.server.failPost = false;
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canRetry: { study: true }, canSummaryHome: false,
      currentStep: null, commands: { study: { pending: true, kind: "result.undo" } } });
    const held = f.hold((_url, method) => method === "POST");
    const retry = f.controller.retry("study");
    await held.entered;
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, canStop: true });
    await f.controller.stop("summary_home");
    held.release(); await retry;
    expect(stops(f)).toEqual([]);
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, currentStep: { step: { status: "active" } } });
  });

  it("return from the background while the undo is in flight: the new document keeps summary_home closed, Stop open", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    const held = f.hold((_url, method) => method === "POST");
    const undo = f.controller.undo();
    await held.entered;
    f.controller.setActivity({ enabled: true, visible: false });
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, canStop: false });
    const second = new ConjugationDocumentController({ ...f.options, initialResultAddress: { session_id: S1, assignment_id: B1, result_id: R1 } });
    await second.refresh();
    // The durable undo is not yet applied: the server still shows the summary and grants summary_home.
    expect(s(second)).toMatchObject({ phase: "unknown", canSummaryHome: false, canStop: true,
      commands: { study: { pending: true, kind: "result.undo" } } });
    await second.stop("summary_home");
    held.release(); await undo;
    await second.refresh();
    expect(s(second)).toMatchObject({ canSummaryHome: false, commands: { study: { outcome: "accepted" } } });
    expect(stops(f)).toEqual([]);
  });

  // C090 §3: a summary_home retained from an earlier document is resent only by the manual retry, which re-proves the
  // server's natural summary by GET (conjugationCommandController retryProblem); an applied one is restored as a fact.
  const savedHome: ConjugationIntent = { command_id: id(70), kind: "session.stop", session_id: S1, payload: { reason: "summary_home" } };
  const reopened = (): Session => ({ id: S1, status: "active", assignment: REISSUED, presented: false,
    results: [{ result_id: R1, assignment_id: B1, action_id: id(41), version: "2", grade: 4, undone: true }] });

  it("a retained summary_home is never sent while the session is active again", async () => {
    const f = fixture({ saved: [savedHome], sessions: [reopened()] });
    await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, commands: { stop: { pending: true, kind: "session.stop" } } });
    await f.controller.retry("stop");
    await f.controller.stop("summary_home");
    expect(stops(f)).toEqual([]);
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, commands: { stop: { problem: "step_changed" } } });
    expect(f.sessions.get(S1)).toMatchObject({ status: "active" });
  });

  it("the same retained summary_home at a valid natural summary is sent exactly once with its own ID", async () => {
    const f = fixture({ saved: [savedHome], sessions: [summarySeed()] });
    await f.controller.refresh();
    expect(f.posted).toEqual([]); // recovery alone never resends
    expect(s(f.controller).canRetry.stop).toBe(true);
    await Promise.all([f.controller.retry("stop"), f.controller.retry("stop")]);
    await f.controller.retry("stop");
    expect(f.posted.map(c => [c.command_id, c.kind, c.payload])).toEqual([[id(70), "session.stop", { reason: "summary_home" }]]);
    expect(f.newId).not.toHaveBeenCalled();
    expect(s(f.controller)).toMatchObject({ phase: "closed", terminalSessionIds: [S1], commands: { stop: { outcome: "accepted", pending: false } } });
  });

  it("the session reopens between the check and the retry click: the retry re-proves by GET and sends nothing", async () => {
    const f = fixture({ saved: [savedHome], sessions: [summarySeed()] });
    await f.controller.refresh();
    expect(s(f.controller).canRetry.stop).toBe(true);
    // Another window undoes the answer after this document's check; the click still holds the old offer.
    f.sessions.set(S1, reopened()); f.server.bump();
    const before = f.gets.length;
    await f.controller.retry("stop");
    expect(stops(f)).toEqual([]);
    expect(f.gets.slice(before).some(g => g.includes(`/commands/${id(70)}`))).toBe(true);
    expect(f.sessions.get(S1)).toMatchObject({ status: "active" });
  });

  it.each([
    ["the summary", null],
    ["the earlier result A", { session_id: S1, assignment_id: B1, result_id: R1 }],
  ])("an already applied summary_home is restored as a closed fact while the screen shows %s", async (_screen, address) => {
    const f = fixture({ sessions: [summarySeed()] });
    // Commit the summary_home on the model server, then persist it as if its reply had been lost.
    await f.options.transport.fetcher("/api/v1/commands", { method: "POST", body: JSON.stringify({ ...savedHome, client_instance_id: id(1), document_id: id(2) }) });
    f.posted.length = 0;
    await f.storage.set(stopKey, pendingRecord(savedHome));
    const controller = new ConjugationDocumentController({ ...f.options, initialResultAddress: address });
    await controller.refresh();
    expect(f.posted).toEqual([]);
    expect(s(controller)).toMatchObject({ phase: "closed", display: { kind: "closed" }, terminalSessionIds: [S1], canSummaryHome: false,
      canUndo: false, canSubmit: false, commands: { stop: { outcome: "accepted", pending: false } } });
    expect(f.values.has(stopKey)).toBe(false);
  });

  it("a definite refusal of the undo: summary_home returns after the re-read and is sent exactly once", async () => {
    const f = fixture({ lastAnswer: true });
    await atSummary(f);
    f.server.rejectNext = "VERSION_CONFLICT";
    const held = f.hold((_url, method) => method === "POST");
    const undo = f.controller.undo();
    await held.entered;
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, canStop: true });
    await f.controller.stop("summary_home");
    held.release(); await undo;
    expect(s(f.controller)).toMatchObject({ phase: "summary", canSummaryHome: true, commands: { study: { outcome: "rejected" } } });
    await f.controller.stop("summary_home");
    await f.controller.stop("summary_home");
    expect(stops(f)).toEqual([{ reason: "summary_home" }]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "result.undo", "session.stop"]);
  });

  it("a pending result.correct keeps summary_home closed; Stop stays open", async () => {
    const f = fixture({ lastAnswer: true });
    await f.controller.refresh();
    await f.controller.submit({ text: "wrong" }, B1);
    f.controller.openStep(s(f.controller).stepTicket!);
    expect(s(f.controller)).toMatchObject({ phase: "summary", canSummaryHome: true, canCorrect: true });
    const held = f.hold((_url, method) => method === "POST");
    const grade = f.controller.correct();
    await held.entered;
    expect(s(f.controller)).toMatchObject({ canSummaryHome: false, canStop: true });
    await f.controller.stop("summary_home");
    held.release(); await grade;
    expect(stops(f)).toEqual([]);
    expect(f.posted.map(c => c.kind)).toEqual(["answer.submit", "result.correct"]);
  });
});

// M-SLOT-CONFLICT-LC: a new intent Y meets another window's record X in the shared slot (written between the new owner's
// load and its save). Y is neither stored nor sent: no unknown outcome of it is shown, checked, read or retried (C116).
describe("a new conjugation intent meets another window's record in the shared slot", () => {
  const other = pendingRecord({ command_id: id(777), kind: "answer.submit", session_id: S1, assignment_id: B1, payload: { text: "alt" } });
  /** The owner's own load sees the slot empty; X lands right before its save reads the slot again. */
  const race = (f: ReturnType<typeof fixture>) => {
    let reads = 0;
    const base = vi.mocked(f.storage.get).getMockImplementation()!;
    vi.mocked(f.storage.get).mockImplementation(async key => {
      if (key === studyKey && ++reads === 2) f.values.set(studyKey, other);
      return base(key);
    });
  };
  it("an answer sends nothing, reads nothing of Y and leaves X exactly as it was", async () => {
    const f = fixture(); await f.controller.refresh();
    const gets = f.gets.length; race(f);
    await f.controller.submit({ text: "kommst" }, B1);
    expect(f.posted).toEqual([]); expect(f.gets.slice(gets)).toEqual([]);
    expect(s(f.controller).commands.study).toMatchObject({ pending: false, outcome: null, problem: "pending_changed", canRetry: false });
    await f.controller.refresh();
    expect(f.posted).toEqual([]); expect(f.gets.slice(gets).some(url => url.includes("/commands/"))).toBe(false);
    expect(f.values.get(studyKey)).toBe(other);
  });
  it("a start leaves the document as it was: no session of Y's ID is selected, read or checked", async () => {
    const f = fixture({ seed: null, sessions: [] }); await f.controller.refresh();
    expect(s(f.controller)).toMatchObject({ phase: "idle", sessionId: null });
    const gets = f.gets.length; race(f);
    await f.controller.start();
    expect(f.posted).toEqual([]);
    expect(s(f.controller)).toMatchObject({ phase: "idle", sessionId: null, commands: { study: { pending: false, problem: "pending_changed" } } });
    await f.controller.refresh();
    expect(f.posted).toEqual([]); expect(f.gets.slice(gets)).toEqual([]);
    expect(f.values.get(studyKey)).toBe(other);
  });
});

// C135 п. 4: the document after a start dropped over another window's record is what it itself showed before the tap,
// never the rights of an old copy, and only while nothing newer replaced the start.
describe("the conjugation document after a dropped start", () => {
  const other = pendingRecord({ command_id: id(777), kind: "answer.submit", session_id: S1, assignment_id: B1, payload: { text: "alt" } });
  /** X lands right before the save reads the slot; the read is held until release. */
  const held = (f: ReturnType<typeof fixture>) => {
    let reads = -1;
    let open!: () => void; const gate = new Promise<void>(done => { open = done; });
    const base = vi.mocked(f.storage.get).getMockImplementation()!;
    vi.mocked(f.storage.get).mockImplementation(async key => {
      if (key === studyKey && reads >= 0 && ++reads === 2) { f.values.set(studyKey, other); await gate; }
      return base(key);
    });
    return { arm: () => { reads = 0; }, release: () => open() };
  };
  it("after a closed session: closed again with its own facts; its step, result A and Stop right are not revived", async () => {
    const f = fixture(); await f.controller.refresh();
    await f.controller.submit({ text: "kommst" }, B1); await f.controller.stop("stop"); await macrotasks();
    const closed = s(f.controller);
    expect(closed).toMatchObject({ phase: "closed", sessionId: S1, canStart: true });
    const gets = f.gets.length, h = held(f); h.arm();
    const starting = f.controller.start(); await macrotasks();
    const y = s(f.controller).sessionId; expect(y).not.toBe(S1);
    h.release(); await starting; await macrotasks();
    expect(s(f.controller).commands.study).toMatchObject({ pending: false, problem: "pending_changed" });
    expect(s(f.controller)).toMatchObject({ phase: "closed", sessionId: S1, closed: closed.closed, canStop: false, canSummaryHome: false,
      acceptedAddress: null, resultA: null, currentStep: null, canSubmit: false, canUndo: false, canCorrect: false });
    await f.controller.refresh();
    expect(f.gets.slice(gets).some(url => y !== null && url.includes(y))).toBe(false);
    expect(f.posted.filter(post => post.kind === "session.start")).toEqual([]);
  });
  it("a version floor raised during the await changes nothing it restores: idle, no session, no read of Y", async () => {
    let floor: string | null = null;
    const f = fixture({ seed: null, sessions: [], minimum: () => floor }); await f.controller.refresh();
    const gets = f.gets.length, h = held(f); h.arm();
    const starting = f.controller.start(); await macrotasks();
    const y = s(f.controller).sessionId; floor = "9007199254740999";
    h.release(); await starting; await macrotasks();
    expect(s(f.controller)).toMatchObject({ phase: "idle", sessionId: null, currentStep: null });
    await f.controller.refresh();
    expect(f.gets.slice(gets).some(url => y !== null && url.includes(y))).toBe(false);
    expect(f.posted).toEqual([]);
  });
  it("an owner that ended during the await (a repeated mount) gets no late update", async () => {
    const f = fixture({ seed: null, sessions: [] }); await f.controller.refresh();
    const h = held(f); h.arm();
    const starting = f.controller.start(); await macrotasks();
    const y = s(f.controller).sessionId;
    f.controller.dispose(); const updates = f.updates.mock.calls.length;
    h.release(); await starting; await macrotasks();
    expect(f.updates.mock.calls.length).toBe(updates);
    expect(f.posted).toEqual([]); expect(f.values.get(studyKey)).toBe(other); expect(y).not.toBeNull();
  });
  it("an unreadable record in the slot: the start sends nothing, the document is idle again and reads no session of Y", async () => {
    const f = fixture({ seed: null, sessions: [] }); await f.controller.refresh();
    f.values.set(studyKey, "{not json"); const gets = f.gets.length;
    await f.controller.start(); await macrotasks();
    expect(s(f.controller)).toMatchObject({ phase: "idle", sessionId: null, commands: { study: { pending: false, problem: "invalid_pending" } } });
    await f.controller.refresh();
    expect(f.posted).toEqual([]); expect(f.gets.slice(gets)).toEqual([]); expect(f.values.get(studyKey)).toBe("{not json");
  });
});

