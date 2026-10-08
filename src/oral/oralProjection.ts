import type { OralSessionProjection, UnavailableSession } from "../api/generated";
import { count, date, exactKeys, oneOf, record, sameId, uuid, CLOSE_REASONS } from "../api/wireValidation";
import { validConjunctionHint } from "../study/questionContext";

const pairs = ["ru-de", "uk-de", "en-de"];

function validAssignment(value: unknown): boolean {
  if (!record(value) || typeof value.revealed !== "boolean"
    || !exactKeys(value, ["id", "card_id", "status", "kind", "prompt", "revealed", ...(value.revealed ? ["translations"] : [])])
    || !uuid(value.id) || !uuid(value.card_id) || !oneOf(value.kind, ["original", "drill"])
    || !oneOf(value.status, ["prefetched", "presented"]) || !record(value.prompt)) return false;
  return exactKeys(value.prompt, ["text", "language", "conjunction_hint"])
    && typeof value.prompt.text === "string" && value.prompt.language === "de"
    && validConjunctionHint(value.prompt.conjunction_hint)
    && (!value.revealed || value.status === "presented" && Array.isArray(value.translations)
      && value.translations.every(item => typeof item === "string"));
}

/** A current step is fresh public state, never a replay of a command's former assignment. */
export function validOralCurrent(value: unknown, sessionId: string): value is OralSessionProjection | UnavailableSession {
  if (!record(value) || !sameId(value.session_id, sessionId)) return false;
  if (oneOf(value.status, ["unavailable", "not_found"])) return exactKeys(value, ["session_id", "status"]);
  if (!exactKeys(value, ["session_id", "status", "mode", "pair", "direction", "local_date", "bucket", "close_reason",
    "progress", "assignment", "summary", "practice", "capabilities"])
    || value.mode !== "oral" || value.direction !== "de-l1" || !oneOf(value.pair, pairs)
    || !oneOf(value.status, ["active", "summary", "closed"]) || !date(value.local_date)
    || !(value.bucket === null || oneOf(value.bucket, ["words", "phrases"]))
    || !record(value.progress) || !record(value.practice) || !record(value.capabilities)) return false;
  const progress = value.progress, practice = value.practice, capabilities = value.capabilities;
  if (!exactKeys(progress, ["completed", "total", "correct", "wrong"])
    || !count(progress.completed) || !count(progress.total) || !count(progress.correct) || !count(progress.wrong)
    || progress.completed > progress.total || progress.correct + progress.wrong !== progress.completed
    || !exactKeys(practice, ["pair", "direction", "local_date", "time_zone", "count"])
    || !oneOf(practice.pair, pairs) || practice.direction !== "de-l1" || !date(practice.local_date)
    || typeof practice.time_zone !== "string" || !count(practice.count)
    || !exactKeys(capabilities, ["reveal_target", "grade_target", "stop", "summary_home"])
    || capabilities.stop !== (value.status !== "closed") || capabilities.summary_home !== (value.status === "summary")) return false;
  if (value.status === "active") {
    if (value.close_reason !== null || value.summary !== null || value.bucket === null || progress.total === 0
      || !validAssignment(value.assignment) || !record(value.assignment)) return false;
    const assignment = value.assignment;
    const reveal = assignment.status === "presented" && !assignment.revealed;
    const grade = assignment.status === "presented" && assignment.revealed;
    return (reveal ? sameId(capabilities.reveal_target, assignment.id as string) : capabilities.reveal_target === null)
      && (grade ? sameId(capabilities.grade_target, assignment.id as string) : capabilities.grade_target === null);
  }
  if (value.assignment !== null || capabilities.reveal_target !== null || capabilities.grade_target !== null
    || (value.status === "closed" ? !oneOf(value.close_reason, CLOSE_REASONS) : value.close_reason !== null)
    || !record(value.summary) || !exactKeys(value.summary, ["completed", "correct", "wrong", "ratio"])) return false;
  const summary = value.summary;
  if (summary.completed !== progress.completed || summary.correct !== progress.correct || summary.wrong !== progress.wrong) return false;
  return progress.completed === 0 ? summary.ratio === null
    : record(summary.ratio) && exactKeys(summary.ratio, ["numerator", "denominator"])
      && summary.ratio.numerator === progress.correct && summary.ratio.denominator === progress.completed;
}
