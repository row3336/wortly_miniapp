import type { ClosedSessionBoundary, Profile } from "../api/generated";
import { oneOf, record, sameId, uuid } from "../api/wireValidation";
import { PendingStoreError, type LostEnvelope } from "./pendingSlot";

/**
 * Q27 (CON §6.1 п.5, project_pending_profile_slots.md ред.1.1 §3.1–§3.2, C458/C466/C467): a study command of a lane whose
 * pointer is stored while its content payload is gone (Е02). It is known by its ID only: the lane reads the status of
 * exactly this command_id — never a resend, never a new command_id or budget, never a body guessed from memory. In a study
 * lane the content of three kinds is kept apart (pendingSlot CONTENT): the answer (answer.submit: text or «Забыл»), the
 * self-assessment (oral.grade: correct) and the chosen grade (result.grade: grade) — only these can be lost so. Only service
 * IDs are taken from the record; none of its payload fields is relied on.
 */
export type LostKind = "answer.submit" | "oral.grade" | "result.grade";
export const LOST_KINDS: readonly LostKind[] = ["answer.submit", "oral.grade", "result.grade"];

export type LostCommand = Readonly<{
  profileId: string;
  clientInstanceId: string;
  pair: "ru-de" | "uk-de" | "en-de";
  commandId: string;
  kind: LostKind;
  sessionId: string;
  assignmentId: string;
  /** result.grade only: the saved result it grades and the version it expected (service IDs, not content). */
  resultId: string | null;
  expectedResultVersion: string | null;
  /** The record carried the conflict mark of Я17: no fact of it is ever taken as this lane's (it is cleared after closure). */
  mismatch: boolean;
  /** What the slot gave: clearLost removes exactly this pointer after a proven outcome. */
  envelope: LostEnvelope;
}>;

/** The status of a lost command by its ID (the mode's decoder, without the fingerprint of a body that is gone). */
export type LostMissing = { outcome: "not_found"; state_version: string; current: Profile; closed_session?: ClosedSessionBoundary };

/** The service data of a lost command of this profile, or PendingStoreError("invalid") for anything else. */
export function lostCommand(error: PendingStoreError, profileId: string): LostCommand {
  const lost = error.lost, value = lost?.record, intent = record(value) ? value.intent : undefined;
  if (!lost || !record(value) || !record(intent) || !uuid(value.profileId) || !sameId(value.profileId, profileId)
    || !sameId(lost.profileId, profileId) || !uuid(value.clientInstanceId) || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    || !oneOf(intent.kind, [...LOST_KINDS]) || lost.kind !== intent.kind || !uuid(intent.command_id)
    || !sameId(intent.command_id, lost.commandId) || !uuid(intent.session_id) || !uuid(intent.assignment_id)
    || (Object.hasOwn(value, "mismatch") && value.mismatch !== true)) throw new PendingStoreError("invalid");
  const grade = intent.kind === "result.grade";
  if (grade && (!uuid(intent.result_id) || typeof intent.expected_result_version !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(intent.expected_result_version))) throw new PendingStoreError("invalid");
  return Object.freeze({ profileId: value.profileId, clientInstanceId: value.clientInstanceId, pair: value.pair as LostCommand["pair"],
    commandId: intent.command_id, kind: intent.kind as LostKind, sessionId: intent.session_id, assignmentId: intent.assignment_id,
    resultId: grade ? intent.result_id as string : null,
    expectedResultVersion: grade ? intent.expected_result_version as string : null,
    mismatch: value.mismatch === true, envelope: lost });
}

/** The status-by-ID address of a lost command under the open handle's origin: service IDs only, never sendable. */
export type LostAddress = { command_id: string; kind: LostKind; session_id: string; assignment_id: string;
  result_id?: string; expected_result_version?: string; client_instance_id: string; document_id: string };
export function lostAddress(lost: LostCommand, origin: { client_instance_id: string; document_id: string }): LostAddress {
  return { command_id: lost.commandId, kind: lost.kind, session_id: lost.sessionId, assignment_id: lost.assignmentId,
    ...(lost.kind === "result.grade" ? { result_id: lost.resultId!, expected_result_version: lost.expectedResultVersion! } : {}),
    client_instance_id: origin.client_instance_id, document_id: origin.document_id };
}

/** True for the slot's refusal that names a lost envelope. */
export function lostEnvelopeError(error: unknown): error is PendingStoreError {
  return error instanceof PendingStoreError && error.kind === "lost_envelope";
}

/**
 * The context checks of a not_found status of a lost command (as missingProblem of commandLane for a pending): another
 * profile or a lost admission first; the final closure of exactly its session proves it will never apply ("not_applied");
 * a record of another installation or pair is not this owner's to resolve. null: the command is absent and its session
 * must be read before anything else (Stop only after an open session is confirmed).
 */
export function lostMissingProblem(reply: LostMissing, lost: LostCommand,
  own: { profileId: string; clientInstanceId: string; pair: string }):
  "profile_changed" | "forbidden" | "not_applied" | "step_changed" | "client_changed" | "pair_changed" | null {
  if (!sameId(reply.current.profile_id, own.profileId)) return "profile_changed";
  if (reply.current.access.status !== "admitted") return "forbidden";
  if (reply.closed_session !== undefined) return sameId(reply.closed_session.session_id, lost.sessionId) ? "not_applied" : "step_changed";
  if (!sameId(lost.clientInstanceId, own.clientInstanceId)) return "client_changed";
  if (lost.pair !== own.pair || `${reply.current.dictionary_language}-de` !== lost.pair) return "pair_changed";
  return null;
}

/** The lane snapshot's view of a lost command: what the document needs for Stop and the screens for their status. */
export type LostView = { commandId: string; kind: string; sessionId: string; sessionOpen: boolean };
