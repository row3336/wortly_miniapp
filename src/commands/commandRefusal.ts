/**
 * Codes of a command envelope that refuse this attempt (this window), not the intent itself.
 *
 * The core answers such a POST with the same rejected envelope as a business refusal (study/coordinator.py). Read as
 * `rejected`, it would erase the retained record although the same intent may still be applied from a live window
 * (C091 §1). Each study adapter therefore throws these as a plain HTTP refusal before it parses the envelope; the lanes
 * keep the record and recovery classifies the thrown error as it already does (recoveryReplies.ts).
 *
 * Closed list: a new pair needs its reason here and a test in commandRefusal.test.ts. Every other code keeps its
 * business meaning. Whether another document may send the kept record is the open question В-2 (Codex C093 п. 5):
 * nothing here adds such a send.
 */
const ATTEMPT_REFUSALS: ReadonlyArray<readonly [status: number, code: string]> = [
  // The document of this window was replaced by a newer open of the same installation; nothing was written and the
  // live window may still send the same command ID (recovery: window_stale → window check).
  [409, "DOCUMENT_STALE"],
  // 403 FORBIDDEN is not here: the same pair also refuses a missing right of the action itself, and the wire does not
  // tell the two apart yet (Codex C102, C103). Until it does, it keeps its business meaning.
];

/** True when a command reply refuses only this attempt and must reach the lane as a thrown HTTP refusal. */
export function attemptRefusal(status: number, code: string | undefined): boolean {
  return code !== undefined && ATTEMPT_REFUSALS.some(([refusedStatus, refusedCode]) => refusedStatus === status && refusedCode === code);
}
