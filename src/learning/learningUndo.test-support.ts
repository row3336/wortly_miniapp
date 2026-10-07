import type { LearningSessionProjection } from "../api/generated";
import type { LearningCommandIntent } from "./learningCommandIntent";
import { current, fact, fixture, id, profile, response } from "./learningFixtures.test-support";

type Item = { n: number; attempt: number };
type Saved = { resultId: string; actionId: string; assignmentId: string; version: number; grade: 2 | 3 | 4 | 5;
  status: "active" | "undone"; item: Item; epoch: number };
export type LearningUndoOptions = {
  cards?: number[];
  undo?: boolean;
  /** Every result.undo is refused with this code and status; core's WRITE_UNAVAILABLE carries no projection. */
  refuseUndo?: { code: string; status?: number };
  /** A correction of an error finishes the phase: its summary replaces the shown next card (К05-151). */
  correctionEndsPhase?: boolean;
  /** The summary is the completed group (the last stage of its last card, IL Л03), not only a finished round. */
  completesGroup?: boolean;
};

/** The second issue of card n after an undo has a new assignment ID (+10000). */
export const issued = (item: Item) => id(item.n + 10000 * item.attempt);

/** A synthetic Learning server with core's C-UNDO-L undo (C-UNDO-L/REPORT.md «Для M-UNDO»). */
export function learningUndoServer(options: LearningUndoOptions = {}) {
  const f = fixture();
  const cards = options.cards ?? [6, 7];
  const state = { queue: cards.map((n): Item => ({ n, attempt: 0 })), index: 0, status: "active" as "active" | "summary" | "closed",
    assignment: "prefetched" as "prefetched" | "presented" | null, version: 1, latest: null as string | null, epoch: 1 };
  const results = new Map<string, Saved>(), receipts = new Map<string, { intent: LearningCommandIntent; fact: Record<string, unknown> }>();
  function step(): LearningSessionProjection {
    const item = state.queue[state.index], base = current();
    return { ...base, status: state.status, close_reason: state.status === "closed" ? "stop" : null,
      group: options.completesGroup && state.status === "summary" ? { ...base.group, status: "completed" } : base.group,
      assignment: state.status === "active" && state.assignment && item
        ? { ...base.assignment!, id: issued(item), card_id: id(100 + item.n), status: state.assignment } : null };
  }
  function project(resultId: string) {
    const saved = results.get(resultId)!, open = state.status !== "closed";
    const live = open && saved.status === "active" && state.latest === resultId;
    const target = { session_id: id(3), assignment_id: saved.assignmentId, result_id: resultId, expected_result_version: String(saved.version) };
    const shown = step().assignment;
    return { state_version: String(state.version), step: step(),
      action: { action_id: saved.actionId, kind: "answer.submit", version: String(saved.version), status: saved.status },
      result: { result_id: resultId, assignment_id: saved.assignmentId, version: String(saved.version), status: saved.status,
        grade: saved.grade, correct: saved.grade >= 3, accepted_at: "2026-09-30T12:00:00Z", answer_date: "2026-09-30", detail: null },
      capabilities: { answer_target: open && shown?.status === "presented" ? shown.id : null,
        grades: live && saved.grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
        correct_target: live && saved.grade === 2 ? target : null,
        undo_target: options.undo !== false && live && saved.epoch === state.epoch ? { ...target, action_id: saved.actionId, kind: "answer.submit" } : null,
        stop: open, summary_home: state.status === "summary" } };
  }
  const refuse = (intent: LearningCommandIntent, code: string, status = 409) => response({
    ...("result_id" in intent && results.has(intent.result_id) ? project(intent.result_id) : { current: step(), state_version: String(state.version) }),
    command: { id: intent.command_id, status: "rejected" }, error: { code } }, status);
  const saved = (intent: LearningCommandIntent, value: Saved) => {
    const done = { ...fact(intent, true), result_id: value.resultId, action_id: value.actionId, object_version: String(value.version) };
    receipts.set(intent.command_id, { intent, fact: done });
    return response({ ...project(value.resultId), command: done });
  };
  function undo(intent: Extract<LearningCommandIntent, { kind: "result.undo" }>) {
    const value = results.get(intent.result_id);
    if (state.status === "closed") return refuse(intent, "SESSION_CLOSED");
    if (options.refuseUndo) {
      if (options.refuseUndo.status === 503) return response({ error: { code: options.refuseUndo.code } }, 503);
      if (value) state.latest = null;
      return refuse(intent, options.refuseUndo.code, options.refuseUndo.status);
    }
    if (!value || value.assignmentId !== intent.assignment_id) return refuse(intent, "ASSIGNMENT_STALE");
    if (String(value.version) !== intent.expected_result_version) return refuse(intent, "VERSION_CONFLICT");
    if (project(value.resultId).capabilities.undo_target === null) return refuse(intent, "CAPABILITY_EXPIRED");
    value.status = "undone"; value.version++; state.latest = null; state.version++;
    const at = state.queue.findIndex(item => issued(item) === value.assignmentId);
    // The next card B is withdrawn (a later issue is a new ID); A is issued again; a phase summary becomes active.
    const next = state.queue[at + 1];
    if (next && state.index === at + 1) next.attempt++;
    state.queue[at] = { ...value.item, attempt: value.item.attempt + 1 };
    state.index = at; state.status = "active"; state.assignment = "prefetched";
    return saved(intent, value);
  }
  f.fetcher.mockImplementation(async (url, init) => {
    const parsed = new URL(String(url), "http://localhost");
    if (init?.method === "GET") {
      if (parsed.pathname.includes("/commands/")) {
        const receipt = receipts.get(parsed.pathname.split("/").at(-1)!);
        if (!receipt) return response({ state_version: String(state.version), current: profile(String(state.version)),
          command: { id: parsed.pathname.split("/").at(-1), status: "not_found" } });
        const command = { ...receipt.fact, status: "already_applied" };
        return response(typeof receipt.fact.result_id === "string" ? { ...project(receipt.fact.result_id), command }
          : { current: step(), state_version: String(state.version), command });
      }
      const resultId = parsed.searchParams.get("result_id");
      return response(resultId ? project(resultId) : { current: step(), state_version: String(state.version) });
    }
    const { client_instance_id: _client, document_id: _document, ...intent } = JSON.parse(String(init?.body)) as LearningCommandIntent
      & Record<string, string>;
    const prior = receipts.get(intent.command_id);
    if (prior) return response({ ...(typeof prior.fact.result_id === "string" ? project(prior.fact.result_id) : { current: step(),
      state_version: String(state.version) }), command: { ...prior.fact, status: "already_applied" } });
    const item = state.queue[state.index];
    if (intent.kind === "assignment.present") {
      if (state.status !== "active" || state.assignment !== "prefetched" || !item || issued(item) !== intent.assignment_id) {
        return refuse(intent, "ASSIGNMENT_STALE");
      }
      state.assignment = "presented"; state.version++;
      const done = fact(intent); receipts.set(intent.command_id, { intent, fact: done });
      return response({ current: step(), state_version: String(state.version), command: done });
    }
    if (intent.kind === "answer.submit") {
      if (state.status !== "active" || state.assignment !== "presented" || !item || issued(item) !== intent.assignment_id) {
        return refuse(intent, "ASSIGNMENT_STALE");
      }
      const n = item.n + 10000 * item.attempt, text = "text" in intent.payload ? intent.payload.text : null;
      const value: Saved = { resultId: id(700 + n), actionId: id(800 + n), assignmentId: intent.assignment_id, version: 1,
        grade: text === "Haus" ? 4 : 2, status: "active", item: { ...item }, epoch: state.epoch };
      results.set(value.resultId, value); state.latest = value.resultId; state.index++; state.version++;
      if (state.index < state.queue.length) state.assignment = "prefetched"; else { state.assignment = null; state.status = "summary"; }
      return saved(intent, value);
    }
    if (intent.kind === "result.undo") return undo(intent);
    if (intent.kind === "result.correct" || intent.kind === "result.grade") {
      const value = results.get(intent.result_id)!;
      value.grade = intent.kind === "result.correct" ? 4 : intent.payload.grade as 3 | 4 | 5; value.version++; state.version++;
      if (intent.kind === "result.correct" && options.correctionEndsPhase) { state.status = "summary"; state.assignment = null; }
      return saved(intent, value);
    }
    if (intent.kind === "session.stop") {
      state.status = "closed"; state.assignment = null; state.version++;
      const done = fact(intent); receipts.set(intent.command_id, { intent, fact: done });
      return response({ current: step(), state_version: String(state.version), command: done });
    }
    throw new Error(`unexpected ${intent.kind}`);
  });
  const posts = () => f.fetcher.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1]?.body)));
  return { ...f, state, results, posts, newDocument: () => { state.epoch++; state.version++; } };
}
