import type { OpenRequest } from "../api/generated";

// The rules of /client/open as core identity/clients.py applies them after C-REOPEN-2 (decision 2.3), shared by the
// synthetic servers of the entry tests. Each test keeps its own server state and reply shape; only these rules are the core's.

/** Every field this client sends to /client/open since the takeover needs neither a lock flag nor a confirmation. */
export const openRequestKeys = ["client_instance_id", "client_version", "contract_version", "document_id", "event", "time_zone"];
/** The fields of one open request, sorted for comparison with openRequestKeys. */
export const keysOf = (request: OpenRequest) => Object.keys(request).sort();

export type BoundDocument = { document: string | null; epoch: number };
/**
 * event "open" of another document always makes it the live one with the next epoch; "foreground" of a document that is
 * not the live one is refused as DOCUMENT_STALE and changes nothing. True when the binding changed.
 */
export function openDocument(bound: BoundDocument, request: OpenRequest): "stale" | boolean {
  if (bound.document === request.document_id) return false;
  if (request.event === "foreground" && bound.document !== null) return "stale";
  bound.document = request.document_id; bound.epoch += 1;
  return true;
}
/** Any write or document-bound read of a replaced document of the activated installation. */
export function staleDocument(bound: BoundDocument, documentId: string | null | undefined): boolean {
  return bound.document !== null && documentId !== bound.document;
}
/** The bare refusal (/client/open, session reads). */
export const staleRefusal = { error: { code: "DOCUMENT_STALE" } };
/** Kinds whose reply the core flattens to the answer step envelope (api/app.py lifts `current` to the top). */
export const answerKinds: readonly string[] = ["answer.submit", "result.grade", "result.correct", "result.undo"];
/** The capabilities of the unavailable answer step (written_projection, learning_answer_projection, conjugation_projection). */
export const unavailableAnswerCapabilities = { answer_target: null, correct_target: null, grades: null, undo_target: null,
  stop: false, summary_home: false };
/**
 * The command envelope of a refused study write: rejected fact, unavailable projection (study/coordinator.py). Session
 * kinds carry `current`; answer kinds the flattened unavailable step. The exact bodies are the core's own, as its HTTP
 * test asserts them (A-V1-OPEN-2 test_probe_v1open2_stale_http.py session_shape / answer_shape).
 */
export function staleCommand(commandId: string, sessionId: string | null, stateVersion: number, kind = "session.start",
  code = "DOCUMENT_STALE") {
  const head = { command: { id: commandId, status: "rejected" }, state_version: String(stateVersion), error: { code } };
  const unavailable = { session_id: sessionId, status: "unavailable" };
  return answerKinds.includes(kind)
    ? { ...head, action: null, result: null, step: unavailable, capabilities: { ...unavailableAnswerCapabilities } }
    : { command: head.command, current: unavailable, state_version: head.state_version, error: head.error };
}
