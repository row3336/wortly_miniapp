import type { PresentCommand, SessionStartCommand, SessionStartPayload, SessionStopCommand } from "../api/generated";
import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";
// The answer and grade envelopes are shared with Learning; only the session payloads are written-specific.
import { copyLearningAnswerIntent, validLearningAnswerIntent, type LearningAnswerIntent } from "../learning/learningCommandIntent";
import { copyLearningRevisionIntent, validLearningRevisionIntent, type LearningRevisionIntent } from "../learning/learningRevisionIntent";

type WithoutOrigin<T> = T extends unknown ? Omit<T, "client_instance_id" | "document_id"> : never;
export type WrittenSessionIntent = WithoutOrigin<
  (Omit<SessionStartCommand, "payload"> & { payload: SessionStartPayload }) | PresentCommand | SessionStopCommand>;
export type WrittenAnswerIntent = LearningAnswerIntent;
/** An explicit grade of a correct answer or the one-tap correction of an error; both address a server right. */
export type WrittenRevisionIntent = LearningRevisionIntent;
export type WrittenIntent = WrittenSessionIntent | WrittenAnswerIntent | WrittenRevisionIntent;
export type WrittenCommand = WrittenIntent & { client_instance_id: string; document_id: string };

export function validWrittenSessionIntent(value: unknown): value is WrittenSessionIntent {
  if (!record(value) || !uuid(value.command_id) || !uuid(value.session_id) || !record(value.payload)) return false;
  const keys = ["session_id", "command_id", "kind", "payload"];
  let valid = false;
  switch (value.kind) {
    case "session.start": valid = exactKeys(value.payload, ["mode", "bucket"]) && value.payload.mode === "written"
      && oneOf(value.payload.bucket, ["words", "phrases"]); break;
    case "session.stop": valid = exactKeys(value.payload, ["reason"]) && oneOf(value.payload.reason, ["stop", "summary_home"]); break;
    case "assignment.present": keys.push("assignment_id"); valid = uuid(value.assignment_id) && exactKeys(value.payload, []); break;
  }
  return valid && exactKeys(value, keys);
}
export function validWrittenIntent(value: unknown): value is WrittenIntent {
  return validWrittenSessionIntent(value) || validLearningAnswerIntent(value) || validLearningRevisionIntent(value);
}
export function isAnswerKind(kind: WrittenIntent["kind"]): kind is "answer.submit" | WrittenRevisionIntent["kind"] {
  return kind === "answer.submit" || kind === "result.grade" || kind === "result.correct";
}
export function isRevisionIntent(value: WrittenIntent): value is WrittenRevisionIntent {
  return value.kind === "result.grade" || value.kind === "result.correct";
}

/** Stable field order gives the shared slot an exact comparison across callers. */
export function copyWrittenIntent(value: WrittenIntent): WrittenIntent {
  if (value.kind === "answer.submit") return copyLearningAnswerIntent(value);
  if (isRevisionIntent(value)) return copyLearningRevisionIntent(value);
  if (!validWrittenSessionIntent(value)) throw new Error("invalid written intent");
  const address = { command_id: value.command_id, session_id: value.session_id };
  switch (value.kind) {
    case "session.start": return { ...address, kind: value.kind, payload: { mode: "written", bucket: value.payload.bucket } };
    case "session.stop": return { ...address, kind: value.kind, payload: { reason: value.payload.reason } };
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
    case "session.stop": payload = { session_id: session, reason: intent.payload.reason }; break;
    case "assignment.present": payload = { session_id: session, assignment_id: intent.assignment_id.toLowerCase() }; break;
    case "answer.submit": payload = { session_id: session, assignment_id: intent.assignment_id.toLowerCase(),
      payload: "text" in intent.payload ? { text: intent.payload.text } : { forgot: true } }; break;
    default: payload = { session_id: session, assignment_id: intent.assignment_id.toLowerCase(),
      result_id: intent.result_id.toLowerCase(), expected_result_version: intent.expected_result_version,
      // A correction has no payload of its own (core study/result_commands.py, _revise).
      payload: intent.kind === "result.correct" ? {} : { grade: intent.payload.grade } };
  }
  const text = canonical({ kind: intent.kind, payload });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
