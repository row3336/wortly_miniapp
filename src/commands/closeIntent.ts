import { exactKeys, record, sameId, uuid } from "../api/wireValidation";

/**
 * The automatic closure C of D-CP4 (DS table 2.1): session.stop with reason save_failed and the ID of the study action
 * X whose six sends ran out. This client only reads such a record from the Stop slot and checks it by its ID (D-CP4
 * table 4.6.1): a client that cannot parse it would block the Stop lane after a return of the core (table 4.12.6).
 * Sending it belongs to CP4b together with the core that accepts it, so every send path refuses it.
 */
export type SaveFailedStopIntent = {
  command_id: string;
  session_id: string;
  kind: "session.stop";
  payload: { reason: "save_failed"; unsaved_command_id: string };
};

export function validSaveFailedStop(value: unknown): value is SaveFailedStopIntent {
  return record(value) && exactKeys(value, ["session_id", "command_id", "kind", "payload"]) && value.kind === "session.stop"
    && uuid(value.command_id) && uuid(value.session_id) && record(value.payload)
    && exactKeys(value.payload, ["reason", "unsaved_command_id"]) && value.payload.reason === "save_failed"
    // The core refuses a closure that names itself (DS 2.1.3): such a record was never sent by a correct client.
    && uuid(value.payload.unsaved_command_id) && !sameId(value.payload.unsaved_command_id, value.command_id);
}

/** Stable field order gives the shared slot an exact comparison across callers. */
export function copySaveFailedStop(value: SaveFailedStopIntent): SaveFailedStopIntent {
  if (!validSaveFailedStop(value)) throw new Error("invalid closure intent");
  return { command_id: value.command_id, session_id: value.session_id, kind: "session.stop",
    payload: { reason: "save_failed", unsaved_command_id: value.payload.unsaved_command_id } };
}

/** Whether this client may send the intent at all; a closure record is only read and checked (D-CP4 4.6.1). */
export function sendableIntent(intent: { kind: string; payload?: unknown }): boolean {
  return !(intent.kind === "session.stop" && record(intent.payload) && intent.payload.reason === "save_failed");
}
