import { exactKeys, oneOf, record, sameId, uuid } from "../api/wireValidation";

/**
 * The payload of session.stop (CON table 2.1 :82, refinement 16.10.2026 Codex C486; project notices ed.2.4 §4.1, T1):
 * - without X — byte for byte the former `{reason}` (`stop` or `summary_home`): old facts and repeats keep their fingerprint;
 * - `reason=stop` with `unsaved_command_id` X — the person's Stop while the current study action X of this session is
 *   unconfirmed; the server closes and, when X is free, writes the notice answer_loss;
 * - `reason=save_failed` with X — the automatic closure C after the sends of X ran out (CON §6.1 п.8); X is required.
 * X is never the closing command's own id; summary_home never names X (both VALIDATION_FAILED on the core).
 */
export type StopPayload =
  | { reason: "stop" | "summary_home" }
  | { reason: "stop" | "save_failed"; unsaved_command_id: string };

export function validStopPayload(payload: unknown, commandId: unknown): payload is StopPayload {
  if (!record(payload)) return false;
  if (exactKeys(payload, ["reason"])) return oneOf(payload.reason, ["stop", "summary_home"]);
  return exactKeys(payload, ["reason", "unsaved_command_id"]) && oneOf(payload.reason, ["stop", "save_failed"])
    && uuid(payload.unsaved_command_id) && !(typeof commandId === "string" && sameId(payload.unsaved_command_id, commandId));
}

/** Stable field order; X only when it is named, so a payload without X stays exactly `{reason}`. */
export function copyStopPayload(payload: StopPayload): StopPayload {
  return "unsaved_command_id" in payload
    ? { reason: payload.reason, unsaved_command_id: payload.unsaved_command_id }
    : { reason: payload.reason };
}

/** The service payload the core fingerprints (study/session_stop.stop_payload): X lower case and only when named. */
export function stopHashPayload(sessionId: string, payload: StopPayload): Record<string, string> {
  return { session_id: sessionId.toLowerCase(), reason: payload.reason,
    ...("unsaved_command_id" in payload ? { unsaved_command_id: payload.unsaved_command_id.toLowerCase() } : {}) };
}

/**
 * The automatic closure C of D-CP4 (DS table 2.1): session.stop with reason save_failed and the ID of the study action
 * X whose six sends ran out. Since core 35c3844 (N2, CP4b) it is sent by the automatic recovery (documentLanes) and
 * checked by its ID like every Stop.
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

/** Whether this client may send the intent: a closure C only in its exact form (X named, not its own id). */
export function sendableIntent(intent: { kind: string; payload?: unknown }): boolean {
  return !(intent.kind === "session.stop" && record(intent.payload) && intent.payload.reason === "save_failed")
    || validSaveFailedStop(intent);
}

type UnsavedLane = {
  pending: boolean; outcome: string | null;
  pendingIntent: { command_id: string; kind: string; session_id?: string } | null;
  /** Q27 (C458): the primary command known by its ID only (the answer's text is gone from this device). */
  lost?: { commandId?: string; kind?: string; sessionId?: string; sessionOpen?: boolean } | null;
} | null | undefined;
/**
 * The kinds whose loss the person's Stop reports (R2-05 «Последний ответ не сохранился»): the commands that pass the
 * result of a study step (CON §6.1 п.1) — an answer, an oral grade, the grade or correction of a result. A shown mark
 * (assignment.present), a reveal, a preview step or an undo is no answer: a Stop does not name it.
 * This is the checked CURRENT map of the client's kinds, a technical reading (Codex C549; decisions.md), not a closed
 * list for ever: a new kind that carries an answer revises it. The automatic closure C is never limited by it (any
 * spent action of the automatic area names X there, documentLanes.closeExhausted).
 */
export const ANSWER_KINDS: readonly string[] = ["answer.submit", "oral.grade", "result.grade", "result.correct"];
/**
 * X for a Stop of `sessionId` (T1): the current unconfirmed answer of THIS session — the study lane's own pending intent
 * whose outcome is not known yet, or its Q27 record known by its ID only. Never a start, a Stop, a non-answer step or
 * another session's action; null when there is none (the payload then stays `{reason}`).
 */
export function unsavedActionId(lane: UnsavedLane, sessionId: string | null): string | null {
  if (!lane || !sessionId || lane.outcome !== null) return null;
  const intent = lane.pendingIntent;
  if (lane.pending && intent && intent.session_id && sameId(intent.session_id, sessionId)
    && ANSWER_KINDS.includes(intent.kind) && uuid(intent.command_id)) {
    return intent.command_id;
  }
  const lost = lane.lost;
  // Q27: a lost envelope counts as an answer by the kind it was made for — the map is LOST_KINDS of commands/lostEnvelope.ts
  // (answer.submit, oral.grade, result.grade; all within ANSWER_KINDS) — never from a bare id without its envelope
  // (Codex C549, C550).
  if (lane.pending && !intent && lost?.commandId && lost.kind && ANSWER_KINDS.includes(lost.kind) && lost.sessionId
    && sameId(lost.sessionId, sessionId) && uuid(lost.commandId)) {
    return lost.commandId;
  }
  return null;
}

/** The closure C (reason save_failed): its sends follow the document's own closure budget, never the Stop's rules. */
export function isClosureIntent(intent: { kind: string; payload?: unknown } | null | undefined): boolean {
  return !!intent && intent.kind === "session.stop" && record(intent.payload) && intent.payload.reason === "save_failed";
}
