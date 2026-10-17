import type { PresentCommand, SessionStartCommand, SessionStartPayload, SessionStopCommand } from "../api/generated";
import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";
import { copySaveFailedStop, copyStopPayload, stopHashPayload, validSaveFailedStop, validStopPayload,
  type SaveFailedStopIntent } from "../commands/closeIntent";
import { copyResultUndoIntent, validResultUndoIntent, type ResultUndoIntent } from "../commands/resultUndo";
// The answer and grade envelopes are shared with Learning; only the session payloads are written-specific.
import { copyLearningAnswerIntent, validLearningAnswerIntent, type LearningAnswerIntent } from "../learning/learningCommandIntent";
import { copyLearningRevisionIntent, validLearningRevisionIntent, type LearningRevisionIntent } from "../learning/learningRevisionIntent";

type WithoutOrigin<T> = T extends unknown ? Omit<T, "client_instance_id" | "document_id"> : never;
/** SaveFailedStopIntent is only read from the Stop slot and checked; validWrittenIntent never lets it be sent. */
type SendableSessionIntent = WithoutOrigin<
  (Omit<SessionStartCommand, "payload"> & { payload: SessionStartPayload }) | PresentCommand | SessionStopCommand>;
export type WrittenSessionIntent = SendableSessionIntent | SaveFailedStopIntent;
export type WrittenAnswerIntent = LearningAnswerIntent;
/** An explicit grade of a correct answer or the one-tap correction of an error; both address a server right. */
export type WrittenRevisionIntent = LearningRevisionIntent;
/** «Шаг назад»: the one undo of the answer on screen, addressed by the server's undo_target (CT 2.3). */
export type WrittenUndoIntent = ResultUndoIntent;
/** Every intent addressed to one saved result; its reply is the result view, its retry check reads that result. */
export type WrittenResultIntent = WrittenRevisionIntent | WrittenUndoIntent;
export type WrittenIntent = WrittenSessionIntent | WrittenAnswerIntent | WrittenResultIntent;
export type WrittenCommand = WrittenIntent & { client_instance_id: string; document_id: string };

export function validWrittenSessionIntent(value: unknown): value is SendableSessionIntent {
  if (!record(value) || !uuid(value.command_id) || !uuid(value.session_id) || !record(value.payload)) return false;
  const keys = ["session_id", "command_id", "kind", "payload"];
  let valid = false;
  switch (value.kind) {
    case "session.start": valid = exactKeys(value.payload, ["mode", "bucket"]) && value.payload.mode === "written"
      && oneOf(value.payload.bucket, ["words", "phrases"]); break;
    // T1 (project notices §4.1): `{reason}` as before, or with the unconfirmed action X (stop optional, save_failed required).
    case "session.stop": valid = validStopPayload(value.payload, value.command_id); break;
    case "assignment.present": keys.push("assignment_id"); valid = uuid(value.assignment_id) && exactKeys(value.payload, []); break;
  }
  return valid && exactKeys(value, keys);
}
/** An intent this client may create and send. */
export function validWrittenIntent(value: unknown): value is WrittenIntent {
  return validWrittenSessionIntent(value) || validLearningAnswerIntent(value) || validLearningRevisionIntent(value)
    || validResultUndoIntent(value);
}
/** An intent a durable record may hold and its status check may name: also the closure C, which is never sent. */
export function readableWrittenIntent(value: unknown): value is WrittenIntent {
  return validWrittenIntent(value) || validSaveFailedStop(value);
}
export function isAnswerKind(kind: WrittenIntent["kind"]): kind is "answer.submit" | WrittenResultIntent["kind"] {
  return kind === "answer.submit" || kind === "result.grade" || kind === "result.correct" || kind === "result.undo";
}
export function isRevisionIntent(value: WrittenIntent): value is WrittenRevisionIntent {
  return value.kind === "result.grade" || value.kind === "result.correct";
}
export function isResultIntent(value: WrittenIntent): value is WrittenResultIntent {
  return isRevisionIntent(value) || value.kind === "result.undo";
}

/** Stable field order gives the shared slot an exact comparison across callers. */
export function copyWrittenIntent(value: WrittenIntent): WrittenIntent {
  if (value.kind === "answer.submit") return copyLearningAnswerIntent(value);
  if (isRevisionIntent(value)) return copyLearningRevisionIntent(value);
  if (value.kind === "result.undo") return copyResultUndoIntent(value);
  if (validSaveFailedStop(value)) return copySaveFailedStop(value);
  if (!validWrittenSessionIntent(value)) throw new Error("invalid written intent");
  const address = { command_id: value.command_id, session_id: value.session_id };
  switch (value.kind) {
    case "session.start": return { ...address, kind: value.kind, payload: { mode: "written", bucket: value.payload.bucket } };
    case "session.stop": return { ...address, kind: value.kind, payload: copyStopPayload(value.payload as Parameters<typeof copyStopPayload>[0]) } as WrittenIntent;
    case "assignment.present": return { ...address, kind: value.kind, assignment_id: value.assignment_id, payload: {} };
  }
}

type Canonical = string | number | boolean | { [key: string]: Canonical };
function canonical(value: Canonical): string {
  if (typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/** The fingerprint the server stores: identity.intent_hash over its service payload, never access or command IDs. */
export async function writtenIntentHash(value: WrittenIntent): Promise<string> {
  const intent = copyWrittenIntent(value);
  const session = intent.session_id.toLowerCase();
  let payload: Record<string, Canonical>;
  switch (intent.kind) {
    case "session.start": payload = { session_id: session, mode: intent.payload.mode, bucket: intent.payload.bucket }; break;
    // DS 2.1.6: the closure C adds the ID of its unsaved action to the fingerprint.
    case "session.stop": payload = stopHashPayload(session, intent.payload as Parameters<typeof stopHashPayload>[1]); break;
    case "assignment.present": payload = { session_id: session, assignment_id: intent.assignment_id.toLowerCase() }; break;
    case "answer.submit": payload = { session_id: session, assignment_id: intent.assignment_id.toLowerCase(),
      payload: "text" in intent.payload ? { text: intent.payload.text } : { forgot: true } }; break;
    default: payload = { session_id: session, assignment_id: intent.assignment_id.toLowerCase(),
      result_id: intent.result_id.toLowerCase(), expected_result_version: intent.expected_result_version,
      // A correction and an undo have no payload of their own (core result_commands._revise, ResultUndoService.undo).
      payload: intent.kind === "result.grade" ? { grade: intent.payload.grade } : {} };
  }
  const text = canonical({ kind: intent.kind, payload });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
