import { ApiError } from "../api/http";

/**
 * C163 шаг 5 (Q01; controller CL493): the narrow recovery candidate after an access refusal. A bare FORBIDDEN is NO strict
 * proof of a wrong installation proof (on the wire it is the same for a missing header and a profile without its
 * coordination row); it is only a candidate, and only when ALL of these hold:
 *  1. the refusal answers a request of the live handle (openedAccess.run calls onDenied only for it) whose origin fields
 *     are this document's own client_instance_id/document_id;
 *  2. an X-Origin-Proof header was really sent (a non-empty proof), as the transport saw the request;
 *  3. HTTP 403 with exactly {"error":{"code":"FORBIDDEN"}} — no command envelope, no other field;
 *  4. the route, method and actual kind are on the explicit list below. Anything else — an unknown, new or owner kind,
 *     another route — is not this branch (default deny).
 * GET /api/v1/dictionary/contexts/{id} and GET /commands/{id}?origin answer a wrong proof with 200 (core ea8e1d9:
 * dictionary_interval.py:425–430, command_status.py), /profile/delete, /access/reapply, /client/open, /client/events mix
 * other refusals: none of them is on the list.
 */

/**
 * The kinds this Mini App really sends to POST /commands (actual senders, step5/src; core dispatch api/app.py:483–734,
 * each through StudyCoordinator.execute — a business FORBIDDEN of apply comes back WITH the envelope):
 * settings/settingsApi.ts:338 setting.save, :353 settings.reset; written/writtenApi.ts:129, learning/learningSessionApi.ts:114,
 * oral/oralApi.ts:76, conjugation/conjugationApi.ts:157 session.start, assignment.present, session.stop and the answers;
 * learning/learningAnswerApi.ts:221 answer.submit, result.grade, result.correct, result.undo; learning/learningSessionApi.ts
 * learning.preview_next, learning.known; learning/learningApi.ts:157 learning.select, learning.unselect; oral/oralApi.ts
 * oral.reveal, oral.grade; conjugation/conjugationApi.ts conjugation.schedule; commands/startCancelApi.ts:79 session.cancel_start; dictionary/intervalApi.ts:395 context.open,
 * context.close, interval.increase, action.undo, action.undo_offer.open, action.undo_offer.close;
 * dictionary/editors/fieldEditorApi.ts:219 and dictionary/owner/commonFieldApi.ts:185 field.save, field.undo;
 * dictionary/actions/cardActionApi.ts:123 card.exclude, card.return, card.relearn; feedback/feedbackApi.ts:84 feedback.send.
 * Not here (5b, QA C163 шаг 5): session.stop_remote — its sender (study/remoteSessionApi.ts:66) is the entry's own
 * RemoteStopController with the busy/opened token, never a request of openedAccess.run; its 403 reaches the entry as the
 * controller's problem "forbidden" (entryController remote onUpdate), so it can never be this candidate.
 * Not here: access.decide, access.mode (owner kinds: bare business FORBIDDEN, api/app.py:731–737), onboarding.*,
 * settings.reset_cancel, settings.reset_barrier (not sent by this client). The final list is the controller's to accept.
 */
export const PROOF_REFUSAL_COMMAND_KINDS: ReadonlySet<string> = Object.freeze(new Set([
  "setting.save", "settings.reset",
  "session.start", "assignment.present", "session.stop", "session.cancel_start",
  "learning.preview_next", "learning.known", "learning.select", "learning.unselect",
  "answer.submit", "result.grade", "result.correct", "result.undo",
  "oral.reveal", "oral.grade", "conjugation.schedule",
  "context.open", "context.close", "interval.increase", "action.undo", "action.undo_offer.open", "action.undo_offer.close",
  "field.save", "field.undo", "card.exclude", "card.return", "card.relearn", "feedback.send",
]));

const SESSION_READ = /^\/sessions\/[0-9a-fA-F-]{36}$/;

/** The document of the live handle whose request was refused. */
export type RefusedDocument = Readonly<{ clientInstanceId: string; documentId: string }>;

/**
 * True only for the narrow candidate above. GET /sessions/{id} counts in two explicit forms: without assignment_id and
 * result_id (sessions.py:234–237, strict) and with BOTH (api/app.py:893–900, result_service.py:29–41); one of them alone
 * is the core's 422, never a recovery.
 */
export function proofRefusalCandidate(error: unknown, document: RefusedDocument): boolean {
  if (!(error instanceof ApiError) || error.kind !== "http" || error.status !== 403 || !error.sentRefusal) return false;
  const { sent, bareForbidden } = error.sentRefusal;
  if (!bareForbidden || !sent.proofSent) return false;
  if (sent.clientInstanceId !== document.clientInstanceId || sent.documentId !== document.documentId) return false;
  if (sent.method === "POST" && sent.route === "/commands") return sent.kind !== null && PROOF_REFUSAL_COMMAND_KINDS.has(sent.kind);
  if (sent.method === "GET" && SESSION_READ.test(sent.route)) {
    const assignment = sent.query.includes("assignment_id"), result = sent.query.includes("result_id");
    return assignment === result;
  }
  return false;
}
