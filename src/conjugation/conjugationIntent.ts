import type { AnswerSubmitCommand, ConjugationScheduleCommand, ConjugationStartPayload,
  PresentCommand, ResultCorrectCommand, ResultGradeCommand, SessionStartCommand, SessionStopCommand } from "../api/generated";
import { exactKeys, oneOf, record, uuid, version } from "../api/wireValidation";

type WithoutOrigin<T> = T extends unknown ? Omit<T, "client_instance_id" | "document_id"> : never;
export type ConjugationScheduleIntent = WithoutOrigin<ConjugationScheduleCommand>;
export type ConjugationSessionIntent = WithoutOrigin<
  (Omit<SessionStartCommand, "payload"> & { payload: ConjugationStartPayload }) | PresentCommand | SessionStopCommand>;
export type ConjugationResultIntent = WithoutOrigin<AnswerSubmitCommand | ResultCorrectCommand | ResultGradeCommand>;
export type ConjugationIntent = ConjugationScheduleIntent | ConjugationSessionIntent | ConjugationResultIntent;
type WithOrigin<T> = T extends unknown ? T & { client_instance_id: string; document_id: string } : never;
export type ConjugationScheduleTransportCommand = WithOrigin<ConjugationScheduleIntent>;
export type ConjugationSessionCommand = WithOrigin<ConjugationSessionIntent>;
export type ConjugationResultCommand = WithOrigin<ConjugationResultIntent>;
export type ConjugationCommand = WithOrigin<ConjugationIntent>;

/** Validate an exact addressed intent, without origin credentials or inferred IDs. */
export function validConjugationIntent(value: unknown): value is ConjugationIntent {
  if (!record(value) || !uuid(value.command_id) || !record(value.payload)) return false;
  const keys = ["command_id", "kind", "payload"];
  if (value.kind === "conjugation.schedule") {
    return exactKeys(value, keys) && exactKeys(value.payload, ["base_verb_id", "tense"])
      && uuid(value.payload.base_verb_id) && oneOf(value.payload.tense, ["present", "preterite"]);
  }
  keys.push("session_id");
  if (!uuid(value.session_id)) return false;
  switch (value.kind) {
    case "session.start":
      return exactKeys(value, keys) && exactKeys(value.payload, ["mode"]) && value.payload.mode === "conjugation";
    case "session.stop":
      return exactKeys(value, keys) && exactKeys(value.payload, ["reason"])
        && oneOf(value.payload.reason, ["stop", "summary_home"]);
    case "assignment.present": case "answer.submit":
      keys.push("assignment_id");
      if (!uuid(value.assignment_id) || !exactKeys(value, keys)) return false;
      return value.kind === "assignment.present" ? exactKeys(value.payload, [])
        : exactKeys(value.payload, ["text"]) && typeof value.payload.text === "string"
          || exactKeys(value.payload, ["forgot"]) && value.payload.forgot === true;
    case "result.grade": case "result.correct":
      keys.push("assignment_id", "result_id", "expected_result_version");
      return exactKeys(value, keys) && uuid(value.assignment_id) && uuid(value.result_id)
        && version(value.expected_result_version)
        && (value.kind === "result.correct" ? exactKeys(value.payload, [])
          : exactKeys(value.payload, ["grade"]) && [3, 4, 5].includes(value.payload.grade as number));
    default: return false;
  }
}

export function copyConjugationIntent(value: ConjugationIntent): ConjugationIntent {
  if (!validConjugationIntent(value)) throw new Error("invalid conjugation intent");
  // Every permitted payload is flat and scalar. Copy before any asynchronous exchange.
  return { ...value, payload: { ...value.payload } } as ConjugationIntent;
}

/** Match the server's immutable service payload, excluding delivery/access IDs. */
export async function conjugationIntentHash(value: ConjugationIntent): Promise<string> {
  const intent = copyConjugationIntent(value);
  let payload: Record<string, unknown>;
  if (intent.kind === "conjugation.schedule") {
    payload = { base_verb_id: intent.payload.base_verb_id.toLowerCase(), tense: intent.payload.tense };
  } else {
    payload = { session_id: intent.session_id.toLowerCase() };
    switch (intent.kind) {
      case "session.start": case "session.stop": Object.assign(payload, intent.payload); break;
      case "assignment.present": payload.assignment_id = intent.assignment_id.toLowerCase(); break;
      case "answer.submit":
        Object.assign(payload, { assignment_id: intent.assignment_id.toLowerCase(), payload: intent.payload }); break;
      case "result.grade": case "result.correct":
        Object.assign(payload, { assignment_id: intent.assignment_id.toLowerCase(), result_id: intent.result_id.toLowerCase(),
          expected_result_version: intent.expected_result_version, payload: intent.payload }); break;
    }
  }
  // Nested answer/grade payloads contain at most one key. Versions remain exact strings.
  const canonical = JSON.stringify({ kind: intent.kind,
    payload: Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key]])) });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
