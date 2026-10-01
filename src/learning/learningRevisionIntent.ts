import type { ResultCorrectCommand, ResultGradeCommand } from "../api/generated";
import { exactKeys, record, uuid, version } from "../api/wireValidation";

type WithoutOrigin<T> = T extends unknown ? Omit<T, "client_instance_id" | "document_id"> : never;
export type LearningRevisionIntent = WithoutOrigin<ResultCorrectCommand | ResultGradeCommand>;

export function validLearningRevisionIntent(value: unknown): value is LearningRevisionIntent {
  return record(value) && exactKeys(value, ["command_id", "session_id", "assignment_id", "result_id",
    "expected_result_version", "kind", "payload"])
    && uuid(value.command_id) && uuid(value.session_id) && uuid(value.assignment_id) && uuid(value.result_id)
    && version(value.expected_result_version) && record(value.payload)
    && (value.kind === "result.correct" && exactKeys(value.payload, [])
      || value.kind === "result.grade" && exactKeys(value.payload, ["grade"]) && [3, 4, 5].includes(value.payload.grade as number));
}

export function copyLearningRevisionIntent(value: LearningRevisionIntent): LearningRevisionIntent {
  if (!validLearningRevisionIntent(value)) throw new Error("invalid Learning revision intent");
  const target = { command_id: value.command_id, session_id: value.session_id, assignment_id: value.assignment_id,
    result_id: value.result_id, expected_result_version: value.expected_result_version };
  return value.kind === "result.correct" ? { ...target, kind: value.kind, payload: {} }
    : { ...target, kind: value.kind, payload: { grade: value.payload.grade } };
}
