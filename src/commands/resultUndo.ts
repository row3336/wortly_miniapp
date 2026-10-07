import type { ResultUndoCommand, SavedCommandFact, WrittenUndoTarget } from "../api/generated";
import { exactKeys, record, sameId, uuid, version } from "../api/wireValidation";
import { validResultFact } from "./resultRevision";

/** One undo of one saved answer (CT 2.3); the written quiz and Learning send the same command. */
export type ResultUndoIntent = Omit<ResultUndoCommand, "client_instance_id" | "document_id">;
/** The server right to undo the answer on screen: its result address plus the action it undoes. */
export type UndoTarget = WrittenUndoTarget;

const intentKeys = ["command_id", "session_id", "assignment_id", "result_id", "expected_result_version", "kind", "payload"];

export function validResultUndoIntent(value: unknown): value is ResultUndoIntent {
  return record(value) && exactKeys(value, intentKeys) && value.kind === "result.undo"
    && uuid(value.command_id) && uuid(value.session_id) && uuid(value.assignment_id) && uuid(value.result_id)
    && version(value.expected_result_version) && record(value.payload) && exactKeys(value.payload, []);
}
export function copyResultUndoIntent(value: ResultUndoIntent): ResultUndoIntent {
  if (!validResultUndoIntent(value)) throw new Error("invalid result undo intent");
  return { command_id: value.command_id, session_id: value.session_id, assignment_id: value.assignment_id,
    result_id: value.result_id, expected_result_version: value.expected_result_version, kind: "result.undo", payload: {} };
}
/** The action of the current right: the command carries only the result address, never the action ID (C-UNDO-1). */
export function undoAction(target: UndoTarget): Omit<ResultUndoIntent, "command_id"> {
  return { kind: "result.undo", session_id: target.session_id, assignment_id: target.assignment_id,
    result_id: target.result_id, expected_result_version: target.expected_result_version, payload: {} };
}

type UndoView = { step: { status: string }; action: { action_id: string; status: string } | null;
  result: { result_id: string; version: string; status: string; detail: unknown } | null };
/**
 * An accepted undo retired exactly the addressed result at its next version (core undo_records.mark_answer_undone:
 * target is the answered assignment). Undone is final, so the attached result is that very version.
 */
export function validUndoFact(value: unknown, command: ResultUndoIntent, view: UndoView): value is SavedCommandFact {
  if (command.kind !== "result.undo" || !validResultFact(value, command) || !sameId(value.result_id, command.result_id)
    || BigInt(value.object_version) !== BigInt(command.expected_result_version) + 1n) return false;
  if (view.result === null || view.action === null) return ["unavailable", "not_found"].includes(view.step.status);
  return sameId(value.action_id, view.action.action_id) && sameId(value.result_id, view.result.result_id)
    && view.result.status === "undone" && view.action.status === "undone" && view.result.version === value.object_version
    // An undone answer keeps no parsed input (core always sends detail=null).
    && view.result.detail === null;
}
