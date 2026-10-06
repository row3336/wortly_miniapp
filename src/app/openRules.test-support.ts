import type { OpenRequest } from "../api/generated";

// The rules of /client/open as core identity/clients.py applies them after C-REOPEN, shared by the synthetic servers of
// the entry tests. Each test keeps its own server state and reply shape; only these rules are the core's.

/** A confirmation always names its epoch, and an epoch is only a confirmation's (otherwise HTTP 422 VALIDATION_FAILED). */
export function invalidOpen(request: OpenRequest): boolean {
  return (request.confirm_document_replacement === true) !== (request.expected_document_epoch != null);
}
/** Another document replaces the bound one only with the held lock or a confirmation of the current epoch. */
export function documentConflict(bound: string | null, epoch: number, request: OpenRequest): boolean {
  const replacing = bound !== null && bound !== request.document_id;
  const confirmed = request.confirm_document_replacement === true && request.expected_document_epoch === String(epoch);
  return replacing && !(request.holds_document_lock === true || confirmed);
}
/** The busy session of a document conflict: no remote stop target, and the epoch the user is asked to confirm. */
export function conflictSession(epoch: number) {
  return { status: "busy" as const, stop_remote_target: null, document_conflict: true, document_epoch: String(epoch) };
}
/** An opened document binds the installation; a new document takes the next epoch. True when the binding changed. */
export function bindDocument(bound: { document: string | null; epoch: number }, request: OpenRequest): boolean {
  if (bound.document === request.document_id) return false;
  bound.document = request.document_id; bound.epoch += 1;
  return true;
}
