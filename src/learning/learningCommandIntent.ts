import type { AnswerSubmitCommand } from "../api/generated";
import { exactKeys, record, uuid } from "../api/wireValidation";
import { copyResultUndoIntent, validResultUndoIntent, type ResultUndoIntent } from "../commands/resultUndo";
import { copyLearningSessionIntent, validLearningSessionIntent, type LearningSessionIntent } from "./learningSessionIntent";
import { copyLearningRevisionIntent, validLearningRevisionIntent, type LearningRevisionIntent } from "./learningRevisionIntent";

export type LearningAnswerIntent = Omit<AnswerSubmitCommand, "client_instance_id" | "document_id">;
/** Every intent addressed to one saved Learning result: its revisions and its «Шаг назад» (CT 2.3). */
export type LearningResultIntent = LearningRevisionIntent | ResultUndoIntent;
export type LearningCommandIntent = LearningSessionIntent | LearningAnswerIntent | LearningResultIntent;

export function validLearningAnswerIntent(value: unknown): value is LearningAnswerIntent {
  return record(value) && exactKeys(value, ["command_id", "session_id", "assignment_id", "kind", "payload"])
    && value.kind === "answer.submit" && uuid(value.command_id) && uuid(value.session_id) && uuid(value.assignment_id)
    && record(value.payload) && (exactKeys(value.payload, ["text"]) && typeof value.payload.text === "string"
      || exactKeys(value.payload, ["forgot"]) && value.payload.forgot === true);
}
export function copyLearningAnswerIntent(value: LearningAnswerIntent): LearningAnswerIntent {
  if (!validLearningAnswerIntent(value)) throw new Error("invalid Learning answer intent");
  return { command_id: value.command_id, session_id: value.session_id, assignment_id: value.assignment_id,
    kind: "answer.submit", payload: "text" in value.payload ? { text: value.payload.text } : { forgot: true } };
}
export function validLearningCommandIntent(value: unknown): value is LearningCommandIntent {
  return validLearningSessionIntent(value) || validLearningAnswerIntent(value) || validLearningRevisionIntent(value)
    || validResultUndoIntent(value);
}
export function isLearningResultIntent(value: LearningCommandIntent): value is LearningResultIntent {
  return value.kind === "result.grade" || value.kind === "result.correct" || value.kind === "result.undo";
}
export function copyLearningResultIntent(value: LearningResultIntent): LearningResultIntent {
  return value.kind === "result.undo" ? copyResultUndoIntent(value) : copyLearningRevisionIntent(value);
}
export function copyLearningCommandIntent(value: LearningCommandIntent): LearningCommandIntent {
  if (value.kind === "answer.submit") return copyLearningAnswerIntent(value);
  if (isLearningResultIntent(value)) return copyLearningResultIntent(value);
  return copyLearningSessionIntent(value);
}
