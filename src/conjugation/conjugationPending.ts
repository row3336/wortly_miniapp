import type { ConjugationSessionProjection } from "../api/generated";
import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";
import { PendingSlot, PendingStoreError } from "../commands/pendingSlot";
import type { AsyncStorage } from "../platform/storage";
import { validConjugationIntent, type ConjugationIntent } from "./conjugationIntent";

export type ConjugationCommandLane = "catalog" | "study" | "stop";
export type ConjugationPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  pair: ConjugationSessionProjection["pair"];
  intent: ConjugationIntent;
  mismatch?: true;
};

export function conjugationLane(intent: ConjugationIntent): ConjugationCommandLane {
  return intent.kind === "conjugation.schedule" ? "catalog" : intent.kind === "session.stop" ? "stop" : "study";
}

function validUnicode(intent: ConjugationIntent): boolean {
  if (intent.kind !== "answer.submit" || !("text" in intent.payload)) return true;
  const text = intent.payload.text;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** Fixed field order makes exact-slot guards independent of JSON order and UUID case.
 * Text is deliberately copied verbatim, including empty and decomposed Unicode. */
export function canonicalConjugationIntent(value: ConjugationIntent): ConjugationIntent {
  // Python's ensure_ascii=False UTF-8 hash cannot represent lone surrogates.
  // Refuse locally; do not repair, trim or normalize the caller's text.
  if (!validConjugationIntent(value) || !validUnicode(value)) throw new PendingStoreError("invalid");
  const command_id = value.command_id.toLowerCase();
  if (value.kind === "conjugation.schedule") return { command_id, kind: value.kind,
    payload: { base_verb_id: value.payload.base_verb_id.toLowerCase(), tense: value.payload.tense } };
  const session_id = value.session_id.toLowerCase();
  switch (value.kind) {
    case "session.start": return { command_id, kind: value.kind, session_id, payload: { mode: "conjugation" } };
    // T1: X (lower case, as every id here) only when named; without it the payload stays `{reason}`.
    case "session.stop": return { command_id, kind: value.kind, session_id,
      payload: "unsaved_command_id" in value.payload && typeof value.payload.unsaved_command_id === "string"
        ? { reason: value.payload.reason, unsaved_command_id: value.payload.unsaved_command_id.toLowerCase() }
        : { reason: value.payload.reason } } as ConjugationIntent;
    case "assignment.present": return { command_id, kind: value.kind, session_id,
      assignment_id: value.assignment_id.toLowerCase(), payload: {} };
    case "answer.submit": return { command_id, kind: value.kind, session_id,
      assignment_id: value.assignment_id.toLowerCase(),
      payload: "text" in value.payload ? { text: value.payload.text } : { forgot: true } };
    case "result.grade": case "result.correct": case "result.undo": return { command_id, kind: value.kind, session_id,
      assignment_id: value.assignment_id.toLowerCase(), result_id: value.result_id.toLowerCase(),
      expected_result_version: value.expected_result_version,
      payload: value.kind === "result.grade" ? { grade: value.payload.grade } : {} } as ConjugationIntent;
  }
}

export function validConjugationPending(value: unknown): value is ConjugationPending {
  return record(value) && exactKeys(value, ["schemaVersion", "profileId", "clientInstanceId", "pair", "intent",
    ...(Object.hasOwn(value, "mismatch") ? ["mismatch"] : [])])
    && value.schemaVersion === 1 && uuid(value.profileId) && uuid(value.clientInstanceId)
    && oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    && (!Object.hasOwn(value, "mismatch") || value.mismatch === true) && validConjugationIntent(value.intent)
    && validUnicode(value.intent);
}

function copy(value: unknown, lane: ConjugationCommandLane): ConjugationPending {
  if (!validConjugationPending(value) || conjugationLane(value.intent) !== lane) throw new PendingStoreError("invalid");
  return { schemaVersion: 1, profileId: value.profileId.toLowerCase(), clientInstanceId: value.clientInstanceId.toLowerCase(),
    pair: value.pair, intent: canonicalConjugationIntent(value.intent), ...(value.mismatch ? { mismatch: true } : {}) };
}

/** Store instances outlive document controllers and must be shared per lane. */
class ConjugationPendingStore extends PendingSlot<ConjugationPending> {
  constructor(storage: AsyncStorage, key: string, lane: ConjugationCommandLane) {
    super(storage, key, value => copy(value, lane));
  }
  override load(profileId: string, signal: AbortSignal): Promise<ConjugationPending | null> {
    return super.load(typeof profileId === "string" ? profileId.toLowerCase() : profileId, signal);
  }
}
export class ConjugationCatalogPendingStore extends ConjugationPendingStore {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.conjugation_catalog", "catalog"); }
}
export class ConjugationSessionPendingStore extends ConjugationPendingStore {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.conjugation_session", "study"); }
}
export class ConjugationStopPendingStore extends ConjugationPendingStore {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.conjugation_stop", "stop"); }
}
