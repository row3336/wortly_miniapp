import { sameId } from "../api/wireValidation";
import type { CommandProblem } from "./commandLane";

/** The address of one server revision right: exactly this result at exactly this version. */
export type RevisionTarget = { session_id: string; assignment_id: string; result_id: string; expected_result_version: string };
export type RevisionIntent = RevisionTarget & (
  | { kind: "result.correct"; payload: object }
  | { kind: "result.grade"; payload: { grade: number } });
type Step = { status: string } | { status: string; session_id: string } | { status: string; session_id: string; pair: string };
/** A result read of the answer mode (written quiz or Learning): the step, the result, its action and its rights. */
export type RevisionRead = {
  step: Step;
  result: { result_id: string; assignment_id: string; version: string; status: string } | null;
  action: { version: string; status: string } | null;
  capabilities: { correct_target: RevisionTarget | null; grades: (RevisionTarget & { values: readonly number[] }) | null };
};

/**
 * A missing acceptance fact of a grade or a correction authorizes no effect: the same ID may be retried only while the
 * server still grants this exact revision right. sameActionVersion keeps Learning's original extra comparison of the
 * action and result versions; the written check never had it (both decoders already require the two to agree).
 */
export function revisionRetryProblem(intent: RevisionIntent, read: RevisionRead, pair: string,
  sameActionVersion: boolean): CommandProblem {
  const step = read.step;
  if (step.status === "unavailable") return "forbidden";
  if (!("session_id" in step) || !sameId(step.session_id, intent.session_id)) return "step_changed";
  if (step.status === "closed") return "closed";
  if (step.status === "not_found") return "step_changed";
  if (!("pair" in step)) return "forbidden";
  if (step.pair !== pair) return "pair_changed";
  const { result, action, capabilities } = read;
  if (result === null || action === null || result.status !== "active" || action.status !== "active"
    || !sameId(result.result_id, intent.result_id) || !sameId(result.assignment_id, intent.assignment_id)
    || result.version !== intent.expected_result_version || sameActionVersion && action.version !== result.version) return "step_changed";
  const target = intent.kind === "result.correct" ? capabilities.correct_target : capabilities.grades;
  if (target === null || !sameId(target.session_id, intent.session_id) || !sameId(target.assignment_id, intent.assignment_id)
    || !sameId(target.result_id, intent.result_id) || target.expected_result_version !== intent.expected_result_version) return "step_changed";
  if (intent.kind === "result.grade" && !capabilities.grades?.values.includes(intent.payload.grade)) return "step_changed";
  return "not_found";
}
