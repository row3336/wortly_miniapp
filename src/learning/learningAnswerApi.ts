import type { AnswerSubmitCommand, ResultCorrectCommand, ResultGradeCommand, ResultUndoCommand, ClosedSessionBoundary, LearningAnswerResponse, MissingCommandFact, Profile,
  RejectedCommandFact, SavedCommandFact, StoredCommandFact, WrittenAnswerDetail } from "../api/generated";
import { validProfile } from "../api/entryApi";
import { ApiError, createJsonTransport, errorCode, httpError, type HttpOptions } from "../api/http";
import { count, date, eventTime, exactKeys, oneOf, record, sameId, uuid, version, validClosedSessionBoundary } from "../api/wireValidation";
import { validResultFact } from "../commands/resultRevision";
import { copyResultUndoIntent, validResultUndoIntent, validUndoFact } from "../commands/resultUndo";
import { validLearningSessionCurrent } from "./learningSessionApi";
import { copyLearningAnswerIntent, validLearningAnswerIntent } from "./learningCommandIntent";
import { copyLearningRevisionIntent, validLearningRevisionIntent } from "./learningRevisionIntent";
import { validConjunctionHint } from "../study/questionContext";
import { validCardExamples } from "./learningPreviewContent";

export type LearningResultCommand = AnswerSubmitCommand | ResultCorrectCommand | ResultGradeCommand | ResultUndoCommand;
export type LearningResultAddress = Pick<ResultCorrectCommand,
  "session_id" | "assignment_id" | "result_id" | "client_instance_id" | "document_id">;

type Current = Pick<LearningAnswerResponse, "action" | "result" | "step" | "capabilities">;
export type LearningResultRead = Current & { state_version: string };
export type LearningAnswerReply = Current & { state_version: string } & (
  | { outcome: "accepted"; command: SavedCommandFact }
  | { outcome: "rejected" | "mismatch"; command: RejectedCommandFact; error: { code: string } }
);
export type LearningAnswerStatus = { state_version: string } & (
  | (Current & { outcome: "accepted"; command: StoredCommandFact })
  | { outcome: "not_found"; command: MissingCommandFact; current: Profile; closed_session?: ClosedSessionBoundary }
);
export interface LearningAnswerApi {
  send(token: string, proof: string, command: AnswerSubmitCommand): Promise<LearningAnswerReply>;
  status(token: string, proof: string, command: AnswerSubmitCommand): Promise<LearningAnswerStatus>;
}
export interface LearningResultApi {
  read(token: string, proof: string, address: LearningResultAddress): Promise<LearningResultRead>;
  send(token: string, proof: string, command: LearningResultCommand): Promise<LearningAnswerReply>;
  status(token: string, proof: string, command: LearningResultCommand): Promise<LearningAnswerStatus>;
}

function prepare(token: string, proof: string, value: LearningResultCommand): LearningResultCommand {
  if (!token || !proof || !record(value) || !uuid(value.client_instance_id) || !uuid(value.document_id)) {
    throw new Error("invalid Learning answer");
  }
  const { client_instance_id, document_id, ...intent } = value;
  const copy = validLearningAnswerIntent(intent) ? copyLearningAnswerIntent(intent)
    : validLearningRevisionIntent(intent) ? copyLearningRevisionIntent(intent)
    : validResultUndoIntent(intent) ? copyResultUndoIntent(intent) : null;
  if (copy === null) throw new Error("invalid Learning result command");
  return { ...copy, client_instance_id, document_id };
}
function textArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function validErrorSpans(value: unknown, length: number, mustBeEmpty: boolean): boolean {
  if (!Array.isArray(value) || mustBeEmpty && value.length > 0) return false;
  let previousEnd = 0;
  return value.every(span => {
    if (!record(span) || !exactKeys(span, ["start", "end"]) || !count(span.start) || !count(span.end)
      || span.start < previousEnd || span.start >= span.end || span.end > length) return false;
    previousEnd = span.end; return true;
  });
}
export function validWrittenAnswerDetail(value: unknown): value is WrittenAnswerDetail {
  if (!record(value) || !exactKeys(value, ["input", "initial_check", "variants", "conjunction_hint", "examples"])
    || !validConjunctionHint(value.conjunction_hint)
    || !(value.examples === null || validCardExamples(value.examples))
    || !record(value.input) || !record(value.initial_check) || !Array.isArray(value.variants) || !value.variants.length) return false;
  const input = value.input, check = value.initial_check;
  let length: number;
  if (input.kind === "text" && exactKeys(input, ["kind", "text"]) && typeof input.text === "string") {
    length = Array.from(input.text).length;
  } else if (input.kind === "forgot" && exactKeys(input, ["kind"])) length = 0;
  else return false;
  const baseKeys = ["correct", "variant_index", "correct_answer", "other_answers", "matched_spans", "span_unit", "span_bounds"];
  const hasDiagnostics = Object.hasOwn(check, "input_errors") || Object.hasOwn(check, "answer_errors");
  if (!exactKeys(check, hasDiagnostics ? [...baseKeys, "input_errors", "answer_errors"] : baseKeys)
    || typeof check.correct !== "boolean" || typeof check.correct_answer !== "string" || !textArray(check.other_answers)
    || check.span_unit !== "unicode_code_point" || check.span_bounds !== "start_inclusive_end_exclusive"
    || !Array.isArray(check.matched_spans)
    || !check.matched_spans.every(span => record(span) && exactKeys(span, ["start", "end"])
      && count(span.start) && count(span.end) && span.start < span.end && span.end <= length)
    || !value.variants.every(variant => record(variant) && exactKeys(variant, ["parts"])
      && textArray(variant.parts) && variant.parts.length > 0 && variant.parts.every(part => part.length > 0))) return false;
  if (hasDiagnostics && !(check.input_errors === null && check.answer_errors === null)) {
    const mustBeEmpty = check.correct || input.kind === "forgot";
    if (!validErrorSpans(check.input_errors, length, mustBeEmpty)
      || !validErrorSpans(check.answer_errors, Array.from(check.correct_answer).length, mustBeEmpty)) return false;
  }
  const index = check.variant_index;
  return (index === null || count(index) && index < value.variants.length)
    && check.correct === (index !== null) && (input.kind !== "forgot" || !check.correct && !check.matched_spans.length);
}

type ResultAddress = { session_id: string; assignment_id: string; result_id?: string };
/** The saved answer of one assignment (written quiz and Learning): its action and result agree; a closed session keeps no receipt. */
export function validSavedAnswer(action: Record<string, unknown>, result: Record<string, unknown>, address: ResultAddress,
  closed: boolean): boolean {
  return exactKeys(action, ["action_id", "kind", "version", "status"]) && uuid(action.action_id)
    && action.kind === "answer.submit" && version(action.version) && oneOf(action.status, ["active", "undone"])
    && exactKeys(result, ["result_id", "assignment_id", "version", "grade", "correct", "status",
      "accepted_at", "answer_date", "detail"])
    && uuid(result.result_id) && sameId(result.assignment_id, address.assignment_id) && version(result.version)
    && !(address.result_id !== undefined && !sameId(result.result_id, address.result_id))
    && [2, 3, 4, 5].includes(result.grade as number) && result.correct === ((result.grade as number) >= 3)
    && result.status === action.status && result.version === action.version
    && eventTime(result.accepted_at) && date(result.answer_date)
    && !(result.detail !== null && !validWrittenAnswerDetail(result.detail))
    && !(closed && result.detail !== null);
}
/**
 * The rights over that answer. A revision right addresses exactly this live result of this open session. The undo right
 * has the same shape in the written and the Learning contract; a caller whose contract has no undo right passes
 * `allowUndoTarget=false`.
 */
export function validAnswerCapabilities(caps: Record<string, unknown>, step: { status: string; assignment?: { id: string; status: string } | null },
  action: unknown, result: unknown, address: ResultAddress, allowUndoTarget = false): boolean {
  const open = ["active", "summary"].includes(step.status);
  // The address of this live result of this open session; each right adds its own keys and conditions.
  const liveAddress = (value: unknown, extraKeys: string[]): value is Record<string, unknown> =>
    record(value) && record(result) && record(action) && action.status === "active" && result.status === "active" && open
    && exactKeys(value, ["session_id", "assignment_id", "result_id", "expected_result_version", ...extraKeys])
    && sameId(value.session_id, address.session_id) && sameId(value.assignment_id, address.assignment_id)
    && sameId(value.result_id, result.result_id as string) && value.expected_result_version === result.version;
  const validTarget = (value: unknown, grades: boolean): boolean => {
    if (!liveAddress(value, grades ? ["values"] : [])) return false;
    const values = value.values, grade = (result as Record<string, unknown>).grade as number;
    return grades ? grade >= 3 && Array.isArray(values) && values.length === 3
      && [3, 4, 5].every(item => values.includes(item)) : grade === 2;
  };
  // «Шаг назад» of this live answer (M-UNDO builds the command from it). Any live grade can be undone: no grade condition.
  const validUndoTarget = (value: unknown): boolean => allowUndoTarget && liveAddress(value, ["action_id", "kind"])
    && sameId(value.action_id, (action as Record<string, unknown>).action_id as string)
    && value.kind === "answer.submit";
  if (!exactKeys(caps, ["answer_target", "grades", "correct_target", "undo_target", "stop", "summary_home"])
    || caps.grades !== null && !validTarget(caps.grades, true)
    || caps.correct_target !== null && !validTarget(caps.correct_target, false)
    || caps.undo_target !== null && !validUndoTarget(caps.undo_target)
    || typeof caps.stop !== "boolean" || typeof caps.summary_home !== "boolean") return false;
  if (caps.answer_target !== null && !(step.status === "active" && "assignment" in step
    && step.assignment?.status === "presented" && sameId(caps.answer_target, step.assignment.id))) return false;
  return !(caps.stop && !open || caps.summary_home && step.status !== "summary");
}

function current(value: Record<string, unknown>, command: { session_id: string; assignment_id: string; result_id?: string }): Current | null {
  const candidate = value.step, action = value.action, result = value.result, caps = value.capabilities;
  if (!(validLearningSessionCurrent(candidate, command.session_id)
    || record(candidate) && exactKeys(candidate, ["status"]) && candidate.status === "unavailable") || !record(caps)) return null;
  const step = candidate as Current["step"];
  const unavailable = step.status === "unavailable" || step.status === "not_found";
  if ((action === null) !== (result === null)) return null;
  if (action !== null && result !== null) {
    if (unavailable || !record(action) || !record(result) || !validSavedAnswer(action, result, command, step.status === "closed")) return null;
  }
  if (!validAnswerCapabilities(caps, step, action, result, command, true)) return null;
  return { action, result, step, capabilities: caps } as Current;
}

type AnswerView = { action: { action_id: string; status: string } | null; step: { status: string };
  result: { result_id: string; version: string; grade: number; status: string; detail: WrittenAnswerDetail | null } | null };
/** An accepted fact of an answer, of its revision or of its undo matches the command and the saved result it produced. */
export function validAnswerFact(value: unknown, command: LearningResultCommand, view: AnswerView): value is SavedCommandFact {
  if (command.kind === "result.undo") return validUndoFact(value, command, view);
  if (!validResultFact(value, command)) return false;
  if (command.kind === "answer.submit" && value.object_version !== "1") return false;
  if (command.kind !== "answer.submit") {
    if (!sameId(value.result_id, command.result_id)) return false;
    const expected = BigInt(command.expected_result_version), applied = BigInt(value.object_version);
    // Re-selecting the saved grade is accepted without a new revision (К10-077); a correction always revises 2 to 4.
    if (applied !== expected + 1n && !(command.kind === "result.grade" && applied === expected)) return false;
    // A later revision can change the grade, but not the outcome of this one.
    if (view.result?.version === value.object_version
      && view.result.grade !== (command.kind === "result.correct" ? 4 : command.payload.grade)) return false;
  }
  if (view.result === null || view.action === null) return ["unavailable", "not_found"].includes(view.step.status);
  if (!sameId(value.action_id, view.action.action_id) || !sameId(value.result_id, view.result.result_id)
    || BigInt(value.object_version) > BigInt(view.result.version)) return false;
  // Revision changes the grade, never the initially submitted text or forgot flag.
  if (command.kind !== "answer.submit") return true;
  const detail = view.result.detail;
  return detail === null || ("text" in command.payload ? detail.input.kind === "text" && detail.input.text === command.payload.text
    : detail.input.kind === "forgot");
}
function envelope(value: unknown): value is Record<string, unknown> & { state_version: string } {
  return record(value) && version(value.state_version)
    && exactKeys(value, ["command", "action", "result", "step", "capabilities", "state_version",
      ...(Object.hasOwn(value, "error") ? ["error"] : [])]);
}

/** Exact answer outcome and fresh current result are separate; no automatic retry. */
export function createLearningResultApi(options: HttpOptions): LearningResultApi {
  const request = createJsonTransport(options);
  return {
    async read(token, proof, original) {
      const keys = ["session_id", "assignment_id", "result_id", "client_instance_id", "document_id"];
      if (!token || !proof || !record(original) || !exactKeys(original, keys)
        || !keys.every(key => uuid(original[key as keyof LearningResultAddress]))) {
        throw new Error("invalid Learning result address");
      }
      const { session_id, assignment_id, result_id, client_instance_id, document_id } = original;
      const address = { session_id, assignment_id, result_id };
      const parameters = new URLSearchParams({ assignment_id, result_id, client_instance_id, document_id });
      const reply = await request(`/sessions/${session_id}?${parameters}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      const value = reply.value;
      if (record(value) && version(value.state_version)
        && exactKeys(value, ["action", "result", "step", "capabilities", "state_version"])) {
        const view = current(value, address);
        if (view) return { ...view, state_version: value.state_version };
      }
      throw new ApiError("invalid_response");
    },
    async send(token, proof, original) {
      const command = prepare(token, proof, original);
      const reply = await request("/commands", { method: "POST", token, proof, body: command });
      const value = reply.value;
      if (envelope(value)) {
        const view = current(value, command);
        if (view) {
          if (reply.status === 200 && value.error == null && validAnswerFact(value.command, command, view)) {
            return { ...view, outcome: "accepted", command: value.command, state_version: value.state_version };
          }
          const code = errorCode(value);
          if ([403, 409, 422].includes(reply.status) && code && record(value.command)
            && exactKeys(value.command, ["id", "status"]) && sameId(value.command.id, command.command_id)
            && value.command.status === "rejected") {
            return { ...view, outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected",
              command: { id: command.command_id, status: "rejected" }, error: { code }, state_version: value.state_version };
          }
        }
      }
      if (!reply.ok) throw httpError(reply);
      throw new ApiError("invalid_response");
    },
    async status(token, proof, original) {
      const command = prepare(token, proof, original);
      const query = new URLSearchParams({ client_instance_id: command.client_instance_id,
        document_id: command.document_id, session_id: command.session_id });
      const reply = await request(`/commands/${command.command_id}?${query}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
      if (reply.status !== 200) throw new ApiError("invalid_response");
      const value = reply.value;
      if (record(value) && exactKeys(value, ["command", "current", "state_version",
        ...(Object.hasOwn(value, "closed_session") ? ["closed_session"] : [])])
        && version(value.state_version) && record(value.command) && exactKeys(value.command, ["id", "status"])
        && sameId(value.command.id, command.command_id) && value.command.status === "not_found"
        && validProfile(value.current) && uuid(value.current.profile_id)) {
        if (Object.hasOwn(value, "closed_session") && !validClosedSessionBoundary(value.closed_session, command.session_id)) {
          throw new ApiError("invalid_response");
        }
        return { outcome: "not_found", command: { id: command.command_id, status: "not_found" },
          current: value.current, state_version: value.state_version,
          ...(value.closed_session === undefined ? {} : { closed_session: value.closed_session as ClosedSessionBoundary }) };
      }
      if (envelope(value) && value.error == null) {
        const view = current(value, command);
        if (view && validAnswerFact(value.command, command, view) && value.command.status === "already_applied") {
          return { ...view, outcome: "accepted", command: value.command as StoredCommandFact, state_version: value.state_version };
        }
      }
      throw new ApiError("invalid_response");
    },
  };
}

/** Preserve the submit-only interface for existing answer callers. */
export function createLearningAnswerApi(options: HttpOptions): LearningAnswerApi {
  const api = createLearningResultApi(options);
  return {
    async send(token, proof, command) {
      if (!record(command) || command.kind !== "answer.submit") throw new Error("invalid Learning answer");
      return api.send(token, proof, command);
    },
    async status(token, proof, command) {
      if (!record(command) || command.kind !== "answer.submit") throw new Error("invalid Learning answer");
      return api.status(token, proof, command);
    },
  };
}
