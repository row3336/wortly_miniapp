import type { OralGradeCommand, OralRevealCommand, OralStartPayload, PresentCommand,
  SessionStartCommand, SessionStopCommand } from "../api/generated";
import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";

type WithoutOrigin<T> = T extends unknown ? Omit<T, "client_instance_id" | "document_id"> : never;
export type OralIntent = WithoutOrigin<
  (Omit<SessionStartCommand, "payload"> & { payload: OralStartPayload })
  | PresentCommand | OralRevealCommand | OralGradeCommand | SessionStopCommand>;
export type OralCommand = OralIntent & { client_instance_id: string; document_id: string };

/** Durable intent contains the addressed command, never access or document credentials. */
export function validOralIntent(value: unknown): value is OralIntent {
  if (!record(value) || !uuid(value.command_id) || !uuid(value.session_id) || !record(value.payload)) return false;
  const keys = ["session_id", "command_id", "kind", "payload"];
  let valid = false;
  switch (value.kind) {
    case "session.start":
      valid = exactKeys(value.payload, ["mode", "bucket"]) && value.payload.mode === "oral"
        && oneOf(value.payload.bucket, ["words", "phrases"]); break;
    case "session.stop":
      valid = exactKeys(value.payload, ["reason"]) && oneOf(value.payload.reason, ["stop", "summary_home"]); break;
    case "assignment.present": case "oral.reveal":
      keys.push("assignment_id"); valid = uuid(value.assignment_id) && exactKeys(value.payload, []); break;
    case "oral.grade":
      keys.push("assignment_id"); valid = uuid(value.assignment_id)
        && exactKeys(value.payload, ["correct"]) && typeof value.payload.correct === "boolean"; break;
  }
  return valid && exactKeys(value, keys);
}

export function copyOralIntent(value: OralIntent): OralIntent {
  if (!validOralIntent(value)) throw new Error("invalid oral intent");
  const address = { command_id: value.command_id, session_id: value.session_id };
  switch (value.kind) {
    case "session.start": return { ...address, kind: value.kind, payload: { mode: "oral", bucket: value.payload.bucket } };
    case "session.stop": return { ...address, kind: value.kind, payload: { reason: value.payload.reason } };
    case "assignment.present": case "oral.reveal":
      return { ...address, kind: value.kind, assignment_id: value.assignment_id, payload: {} };
    case "oral.grade":
      return { ...address, kind: value.kind, assignment_id: value.assignment_id, payload: { correct: value.payload.correct } };
  }
}

/** Match identity.intent_hash over the service payload, which excludes access and command IDs. */
export async function oralIntentHash(value: OralIntent): Promise<string> {
  const intent = copyOralIntent(value);
  const payload: Record<string, string | boolean> = {
    ...intent.payload, session_id: intent.session_id.toLowerCase(),
    ...("assignment_id" in intent ? { assignment_id: intent.assignment_id.toLowerCase() } : {}),
  };
  const canonical = JSON.stringify({ kind: intent.kind,
    payload: Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key]])) });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
