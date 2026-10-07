import { vi } from "vitest";
import type { CardExamples, OpenedClient, Profile, PublicAssignment, SessionProjection, WrittenStep } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { writtenIntentHash, type WrittenIntent } from "./writtenIntent";
import { writtenPrimaryKey, writtenStopKey } from "./writtenPending";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const profile = (version = "1"): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: version, access: { status: "admitted", version: "1", reason: null } });
export const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const pending = (intent: WrittenIntent) => ({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent });

/** A drill of card n is assignment 900+n of the same card; each new issue of an undone answer adds 10000 (a new ID). */
export function assignment(n: number, status: "prefetched" | "presented", kind: "original" | "drill" = "original",
  attempt = 0): PublicAssignment {
  return { id: id((kind === "drill" ? 900 + n : n) + 10000 * attempt), card_id: id(100 + n), status, kind,
    prompt: { text: `слово ${n}`, language: "ru", translations: [`слово ${n}`], personal_translation_version: null,
      conjunction_hint: null },
    answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } };
}

type Item = { n: number; kind: "original" | "drill"; attempt?: number };
type Stored = { resultId: string; assignmentId: string; actionId: string; version: number; grade: 2 | 3 | 4 | 5; text: string | null;
  item: Item; status: "active" | "undone"; epoch: number };
type Receipt = { intent: WrittenIntent; fact: Record<string, unknown> };
export type ServerOptions = {
  /** Original assignment numbers of the session queue. */
  cards?: number[];
  /** Grade of an initial answer. */
  grade?(text: string | null): 2 | 4;
  /** A start refusal code. */
  refuseStart?: string;
  /** A session already active and presented at mount. */
  active?: boolean;
  /** An original error issues one drill of its card right after it (retry_gap 0, retry_count 1). */
  drills?: boolean;
  /** Frozen example candidates of every answered card (result detail). */
  examples?: CardExamples;
  /** The server grants the undo of the latest answer of this document, as core does since C-UNDO-1. */
  undo?: boolean;
  /** Every result.undo is refused with this code; the refusal leaves no undo right (the reason it was refused). */
  refuseUndo?: { code: string; status?: number };
};

/**
 * A synthetic written server over the real HTTP transport and wire shapes: commands commit before replying,
 * duplicates replay their original fact, and status verifies the intent fingerprint like core command_status.
 * Rights follow core (C-WCORR): grades for the latest correct result, correct_target for the latest error, both
 * only while the session is open; a correction withdraws the unshown drill of its card and keeps a shown one.
 * With `undo` the latest live answer of the current document also carries undo_target (C-UNDO-1): an undo retires it,
 * withdraws the next question and issues the same card again under a new ID; a new document ends the right.
 */
export function writtenServer(options: ServerOptions = {}) {
  const cards = options.cards ?? [6, 7];
  const state = {
    sessionId: options.active ? id(3) : null as string | null, status: "active" as "active" | "summary" | "closed",
    closeReason: null as SessionProjection["close_reason"], version: 1, index: 0,
    queue: cards.map((n): Item => ({ n, kind: "original" })),
    assignment: options.active ? "presented" as "prefetched" | "presented" | null : null as "prefetched" | "presented" | null,
    latest: null as string | null, epoch: 1,
  };
  const results = new Map<string, Stored>(), receipts = new Map<string, Receipt>();
  /** Results whose revision rights another context ended (e.g. a manual interval, К05-057). */
  const revoked = new Set<string>();
  const grade = options.grade ?? ((text: string | null) => text === "Haus" ? 4 : 2);
  const values = () => [...results.values()].filter(item => item.item.kind === "original" && item.status === "active");
  const progress = () => {
    const done = values(), correct = done.filter(item => item.grade >= 3).length;
    return { completed: done.length, total: cards.length, correct, wrong: done.length - correct };
  };
  const current = () => {
    const item = state.queue[state.index];
    return state.status === "active" && state.assignment && item ? assignment(item.n, state.assignment, item.kind, item.attempt) : null;
  };
  const assignmentId = (item: Item) => assignment(item.n, "prefetched", item.kind, item.attempt).id;
  /** The queue moves on: the next item is issued unshown, or the session reaches its summary. */
  const advance = () => {
    if (state.index < state.queue.length) state.assignment = "prefetched";
    else { state.assignment = null; state.status = "summary"; }
  };
  function projection(): SessionProjection {
    const counts = progress();
    return { session_id: state.sessionId!, status: state.status, mode: "written", pair: "ru-de", direction: "l1-de",
      local_date: "2026-10-05", bucket: "words", close_reason: state.closeReason, progress: counts, assignment: current(),
      summary: state.status === "active" ? null : { completed: counts.completed, correct: counts.correct, wrong: counts.wrong,
        ratio: counts.completed ? { numerator: counts.correct, denominator: counts.completed } : null } };
  }
  function step(): WrittenStep {
    return { ...projection(), practice: { pair: "ru-de", direction: "l1-de", local_date: "2026-10-05", time_zone: "UTC",
      count: progress().completed }, review_progress: null };
  }
  function view(resultId: string) {
    const item = results.get(resultId)!, open = state.status !== "closed";
    const latest = open && resultId === state.latest && !revoked.has(resultId) && item.status === "active";
    const target = { session_id: state.sessionId!, assignment_id: item.assignmentId, result_id: resultId, expected_result_version: String(item.version) };
    const shown = current();
    const correct = item.grade >= 3, initial = grade(item.text) >= 3;
    const undo = options.undo && latest && item.epoch === state.epoch ? { ...target, action_id: item.actionId, kind: "answer.submit" } : null;
    return { action: { action_id: item.actionId, kind: "answer.submit", version: String(item.version), status: item.status },
      result: { result_id: resultId, assignment_id: item.assignmentId, version: String(item.version), grade: item.grade, correct,
        status: item.status, accepted_at: "2026-10-05T12:00:00Z", answer_date: "2026-10-05",
        detail: open && item.status === "active" ? { input: item.text === null ? { kind: "forgot" } : { kind: "text", text: item.text },
          initial_check: { correct: initial, variant_index: initial ? 0 : null, correct_answer: "das Haus", other_answers: ["Haus"],
            matched_spans: [], span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" },
          variants: [{ parts: ["das Haus"] }, { parts: ["Haus"] }], conjunction_hint: null, examples: options.examples ?? null } : null },
      step: step(),
      capabilities: { answer_target: shown?.status === "presented" ? shown.id : null,
        grades: latest && correct ? { ...target, values: [3, 4, 5] } : null,
        // Without `undo` the right stays null, as before C-UNDO-1: those tests are about the other rights.
        correct_target: latest && !correct ? target : null, undo_target: undo,
        stop: open, summary_home: state.status === "summary" } };
  }
  const fact = (intent: WrittenIntent, extra: Partial<Record<"action_id" | "result_id" | "object_version", string>> = {}) => ({
    id: intent.command_id, kind: intent.kind, status: "applied", applied_at: "2026-10-05T12:00:00Z",
    target_id: "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: extra.action_id ?? null, result_id: extra.result_id ?? null, context_id: null, object_version: extra.object_version ?? null });
  const refuse = (intent: WrittenIntent, code: string, status = 409) => ({ status, body: {
    // An undo refusal shows the result it addressed, like core's projection by the requested address.
    ...(intent.kind === "result.undo" && results.has(intent.result_id) ? view(intent.result_id)
      : "result_id" in intent || intent.kind === "answer.submit" ? { ...(state.latest ? view(state.latest) : {
      action: null, result: null, step: step(), capabilities: { answer_target: null, grades: null, correct_target: null,
        undo_target: null, stop: true, summary_home: false } }) } : { current: projection() }),
    command: { id: intent.command_id, status: "rejected" }, state_version: String(state.version), error: { code } } });
  function apply(intent: WrittenIntent): { status: number; body: Record<string, unknown> } {
    if (intent.kind === "session.start") {
      if (options.refuseStart) return { status: 409, body: { current: { session_id: intent.session_id, status: "not_found" },
        command: { id: intent.command_id, status: "rejected" }, state_version: String(state.version), error: { code: options.refuseStart } } };
      state.sessionId = intent.session_id; state.status = "active"; state.index = 0; state.assignment = "prefetched"; state.version++;
      return { status: 200, body: { command: fact(intent), current: projection(), state_version: String(state.version) } };
    }
    const issued = state.queue[state.index];
    if (intent.kind === "assignment.present") {
      if (state.status !== "active" || state.assignment !== "prefetched" || !issued || assignmentId(issued) !== intent.assignment_id) {
        return refuse(intent, "ASSIGNMENT_STALE");
      }
      state.assignment = "presented"; state.version++;
      return { status: 200, body: { command: fact(intent), current: projection(), state_version: String(state.version) } };
    }
    if (intent.kind === "session.stop") {
      if (state.status === "closed") return refuse(intent, "SESSION_CLOSED");
      state.status = "closed"; state.closeReason = intent.payload.reason; state.assignment = null; state.version++;
      return { status: 200, body: { command: fact(intent), current: projection(), state_version: String(state.version) } };
    }
    if (intent.kind === "answer.submit") {
      if (state.status !== "active" || state.assignment !== "presented" || !issued || assignmentId(issued) !== intent.assignment_id) {
        return refuse(intent, "ASSIGNMENT_STALE");
      }
      const n = (issued.kind === "drill" ? 900 + issued.n : issued.n) + 10000 * (issued.attempt ?? 0);
      const resultId = id(700 + n), actionId = id(800 + n);
      const text = "text" in intent.payload ? intent.payload.text : null, value = grade(text);
      results.set(resultId, { resultId, assignmentId: intent.assignment_id, actionId, version: 1, grade: value, text, item: issued,
        status: "active", epoch: state.epoch });
      state.latest = resultId; state.index++; state.version++;
      if (options.drills && issued.kind === "original" && value === 2) state.queue.splice(state.index, 0, { n: issued.n, kind: "drill" });
      advance();
      return { status: 200, body: { ...view(resultId), command: fact(intent, { action_id: actionId, result_id: resultId, object_version: "1" }),
        state_version: String(state.version) } };
    }
    if (intent.kind === "result.undo") return undo(intent);
    const item = results.get(intent.result_id);
    if (!item || state.status === "closed") return refuse(intent, "SESSION_CLOSED");
    if (String(item.version) !== intent.expected_result_version) return refuse(intent, "VERSION_CONFLICT");
    const rights = view(item.resultId).capabilities;
    if (intent.kind === "result.correct" ? rights.correct_target === null : rights.grades === null) return refuse(intent, "FORBIDDEN", 403);
    const next = intent.kind === "result.correct" ? 4 : intent.payload.grade as 3 | 4 | 5;
    if (item.grade !== next) { item.grade = next; item.version++; state.version++; }
    if (intent.kind === "result.correct" && item.item.kind === "original") {
      // Only the unshown drill of this card is withdrawn; a shown one keeps its ID and input (CT:111, К05-116).
      const drill = state.queue.findIndex((queued, at) => queued.kind === "drill" && queued.n === item.item.n
        && (at > state.index || at === state.index && state.assignment === "prefetched"));
      if (drill >= 0) { state.queue.splice(drill, 1); if (drill === state.index) advance(); }
    }
    return { status: 200, body: { ...view(item.resultId), command: fact(intent, { action_id: item.actionId, result_id: item.resultId,
      object_version: String(item.version) }), state_version: String(state.version) } };
  }
  /** Core order (study/result_undo.py): closed session, address, version, then the right itself. */
  function undo(intent: Extract<WrittenIntent, { kind: "result.undo" }>): { status: number; body: Record<string, unknown> } {
    const item = results.get(intent.result_id);
    if (state.status === "closed") return refuse(intent, "SESSION_CLOSED");
    if (options.refuseUndo) {
      if (item) revoked.add(item.resultId);
      return refuse(intent, options.refuseUndo.code, options.refuseUndo.status);
    }
    if (!item || item.assignmentId !== intent.assignment_id) return refuse(intent, "ASSIGNMENT_STALE");
    if (String(item.version) !== intent.expected_result_version) return refuse(intent, "VERSION_CONFLICT");
    if (view(item.resultId).capabilities.undo_target === null) return refuse(intent, "CAPABILITY_EXPIRED");
    item.status = "undone"; item.version++; state.latest = null; state.version++;
    const at = state.queue.findIndex(queued => assignmentId(queued) === item.assignmentId);
    // The next question is withdrawn (its later issue is a new ID); the drill this error scheduled is dropped.
    const next = state.queue[at + 1];
    if (next && state.index === at + 1 && state.assignment) next.attempt = (next.attempt ?? 0) + 1;
    const drill = state.queue.findIndex((queued, position) => position > at && queued.kind === "drill" && queued.n === item.item.n);
    if (item.item.kind === "original" && drill >= 0) state.queue.splice(drill, 1);
    state.queue[at] = { ...item.item, attempt: (item.item.attempt ?? 0) + 1 };
    state.index = at; state.status = "active"; state.assignment = "prefetched";
    return { status: 200, body: { ...view(item.resultId), command: fact(intent, { action_id: item.actionId, result_id: item.resultId,
      object_version: String(item.version) }), state_version: String(state.version) } };
  }
  async function handle(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const parsed = new URL(String(url), "http://localhost");
    if (init?.method === "GET" && parsed.pathname.startsWith("/api/v1/commands/")) {
      const receipt = receipts.get(parsed.pathname.split("/").at(-1)!);
      if (!receipt) return response({ command: { id: parsed.pathname.split("/").at(-1), status: "not_found" }, current: profile(String(state.version)),
        state_version: String(state.version), ...(state.status === "closed" && state.sessionId === parsed.searchParams.get("session_id")
          ? { closed_session: { session_id: state.sessionId, status: "closed", close_reason: state.closeReason } } : {}) });
      const expected = parsed.searchParams.get("expected_intent_hash");
      if (expected !== await writtenIntentHash(receipt.intent)) return response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
      const command = { ...receipt.fact, status: "already_applied" };
      return response(typeof receipt.fact.result_id === "string"
        ? { ...view(receipt.fact.result_id), command, state_version: String(state.version), verified_intent_hash: expected }
        : { command, current: projection(), state_version: String(state.version), verified_intent_hash: expected });
    }
    if (init?.method === "GET" && parsed.pathname.startsWith("/api/v1/sessions/")) {
      const resultId = parsed.searchParams.get("result_id");
      return response(resultId ? { ...view(resultId), state_version: String(state.version) }
        : { current: state.sessionId ? projection() : { session_id: parsed.pathname.split("/").at(-1), status: "not_found" },
          state_version: String(state.version) });
    }
    if (init?.method !== "POST") throw new Error(`unexpected ${init?.method} ${parsed.pathname}`);
    const { client_instance_id: _client, document_id: _document, ...intent } = JSON.parse(String(init.body)) as WrittenIntent & Record<string, string>;
    const prior = receipts.get(intent.command_id);
    if (prior) {
      if (JSON.stringify(prior.intent) !== JSON.stringify(intent)) {
        const refused = refuse(intent, "COMMAND_PAYLOAD_MISMATCH");
        return response(refused.body, refused.status);
      }
      const command = { ...prior.fact, status: "already_applied" };
      return response(typeof prior.fact.result_id === "string"
        ? { ...view(prior.fact.result_id), command, state_version: String(state.version) }
        : { command, current: projection(), state_version: String(state.version) });
    }
    const outcome = apply(intent);
    if (outcome.status === 200) receipts.set(intent.command_id, { intent, fact: outcome.body.command as Record<string, unknown> });
    return response(outcome.body, outcome.status);
  }
  /** Another context ends the revision rights of a result (e.g. a manual interval increase, К05-057). */
  const revokeRights = (resultId: string) => { revoked.add(resultId); state.version++; };
  /** A new document of the same installation (a restart): the undo right of earlier answers ends (К05-074). */
  const newDocument = () => { state.epoch++; state.version++; };
  return { state, results, receipts, handle, step, projection, view, revokeRights, newDocument };
}

/** Real access, storage and transport around one synthetic server. */
export function writtenFixture(options: ServerOptions & { saved?: Partial<Record<"primary" | "stop", WrittenIntent>> } = {}) {
  const values = new Map<string, string>([["unrelated", "keep"]]);
  if (options.saved?.primary) values.set(writtenPrimaryKey, JSON.stringify(pending(options.saved.primary)));
  if (options.saved?.stop) values.set(writtenStopKey, JSON.stringify(pending(options.saved.stop)));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  let access: OpenedAccess, live = true, next = 1000;
  const onDenied = vi.fn(() => { live = false; });
  const replace = (patch: Partial<OpenedClient> = {}) => {
    const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
      profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" }, ...patch };
    const handle: OpenedAccess = createOpenedAccess({ opened, token: "synthetic-token", proof: "synthetic-proof", generation: 1,
      isLive: () => live && access === handle, onDenied });
    access = handle;
  };
  replace();
  const server = writtenServer(options);
  const fetcher = vi.fn<typeof fetch>(server.handle);
  const newId = vi.fn(() => id(next++));
  const posts = () => fetcher.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1]?.body)));
  const gets = (part: string) => fetcher.mock.calls.filter(call => call[1]?.method === "GET" && String(call[0]).includes(part)).map(call => String(call[0]));
  /** Hold the next request: it reaches the server only when released, so a test controls commit order. */
  const hold = () => {
    const gate = deferred<void>();
    fetcher.mockImplementationOnce(async (...call) => { await gate.promise; return server.handle(...call); });
    return gate;
  };
  /** The server commits the next request, but its reply is lost (a timeout after commit). */
  const loseReply = () => fetcher.mockImplementationOnce(async (...call) => { await server.handle(...call); throw new TypeError("network"); });
  /** The next request never reaches the server (a timeout before commit). */
  const dropRequest = () => fetcher.mockImplementationOnce(async () => { throw new TypeError("network"); });
  const transport = { fetcher, timeoutMs: 30000, maxResponseBytes: 200000 };
  return { values, storage, access: () => access, replace, server, fetcher, newId, posts, gets, hold, loseReply, dropRequest,
    transport, revoke: () => { live = false; } };
}
