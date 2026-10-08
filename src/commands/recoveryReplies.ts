import { ApiError } from "../api/http";
import { ClosedAccessError } from "../app/openedAccess";

/** Why automatic recovery stops sending for good (CT §6.1 п. 7); the screen then shows the actual server state. */
export type TerminationReason =
  /** 401/403, a changed profile or a lost admission. */
  | "access_lost"
  /** The session of the action was closed (stop, midnight, pair change, remote end) and the action was not applied. */
  | "session_closed"
  /** The step the action belongs to is no longer the open step of this session. */
  | "step_stale"
  /** A window check confirmed that another window took the work, or the document is no longer live. */
  | "window_replaced"
  /** 409 CLIENT_INCOMPATIBLE: this client version may not write any more. */
  | "client_incompatible";

/** The answer to one send (POST) of the retained intent, classified by DESIGN D-RECOV table 2. */
export type SendResult =
  /** 2.1 / 2.2: written, or refused with a known business code. */
  | { kind: "settled"; outcome: "accepted" | "rejected" }
  /** 2.3: the same command_id carries another payload on the server (Я17). */
  | { kind: "mismatch" }
  /** 2.4. */
  | { kind: "terminated"; reason: Exclude<TerminationReason, "client_incompatible"> }
  /**
   * 2.5: 409 DOCUMENT_STALE. A live window gets it too (a closed card context), so it only asks for a window check
   * (D-RECOV RESULTS_VP table 9.2); the send stays counted.
   */
  | { kind: "window_stale" }
  /** 2.6 / 2.7: the reply was lost; the write may or may not have happened. */
  | { kind: "lost"; cause: "network" | "write_unavailable" }
  /** 2.8: a planned pause refused the write before the application (waitSeconds: the server estimate). */
  | { kind: "maintenance"; waitSeconds: number | null }
  /** 2.9. */
  | { kind: "incompatible" }
  /**
   * A definite refusal over HTTP that is not a lost reply: 422 VALIDATION_FAILED, 409 VERSION_CONFLICT. The write was
   * not applied and a retry of the same payload cannot change that (root decision, pending owner).
   */
  | { kind: "refused"; code: string }
  /** The client refused before the network (e.g. ClosedAccessError): provably nothing went out. */
  | { kind: "not_sent" };

/**
 * The answer to one fact check: the status of the same command_id with its fingerprint plus, for a missing status,
 * the targeted read that proves the right to continue (same admission, same open session, same step, same document).
 */
export type CheckResult =
  /** 2.1: the command is on the server (its own outcome); the result is restored from the fact, nothing is sent. */
  | { kind: "recorded"; outcome: "accepted" | "rejected" }
  /** 2.3. */
  | { kind: "mismatch" }
  /** 2.4 / 2.10 / 2.11. */
  | { kind: "terminated"; reason: Exclude<TerminationReason, "client_incompatible"> }
  /** 2.5: 409 DOCUMENT_STALE; a window check decides (see SendResult). */
  | { kind: "window_stale" }
  /** 2.12: confirmed absent while the same step is still open — the only answer that allows a retry. */
  | { kind: "not_recorded" }
  /** 2.6 / 2.7: no usable answer. pauseSeconds when a planned pause answered. */
  | { kind: "unreachable"; pauseSeconds?: number | null }
  /** 2.13: an answer older than the known state; the outcome stays unknown. */
  | { kind: "stale" };

function httpCode(error: unknown, status: number, code: string): boolean {
  return error instanceof ApiError && error.kind === "http" && error.status === status && error.code === code;
}
function accessLost(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

/** HTTP refusals that the server answers before any write and that a retry of the same payload repeats. */
const DEFINITE_REFUSALS: readonly (readonly [number, string])[] = [[422, "VALIDATION_FAILED"], [409, "VERSION_CONFLICT"]];

/** The class of a failed POST. Anything not named below is a lost reply: the write may have happened. */
export function sendFailure(error: unknown): SendResult {
  if (error instanceof ClosedAccessError) return { kind: "not_sent" };
  if (accessLost(error)) return { kind: "terminated", reason: "access_lost" };
  if (httpCode(error, 409, "COMMAND_PAYLOAD_MISMATCH")) return { kind: "mismatch" };
  if (httpCode(error, 409, "DOCUMENT_STALE")) return { kind: "window_stale" };
  if (httpCode(error, 409, "CLIENT_INCOMPATIBLE")) return { kind: "incompatible" };
  if (httpCode(error, 503, "MAINTENANCE")) return { kind: "maintenance", waitSeconds: (error as ApiError).pause?.waitSeconds ?? null };
  for (const [status, code] of DEFINITE_REFUSALS) if (httpCode(error, status, code)) return { kind: "refused", code };
  // A failed database commit may still have been written (app.py WRITE_UNAVAILABLE): unknown, like a timeout.
  if (httpCode(error, 503, "WRITE_UNAVAILABLE")) return { kind: "lost", cause: "write_unavailable" };
  return { kind: "lost", cause: "network" };
}

/** The class of a failed fact check. A check never proves absence by failing: anything unnamed is unreachable. */
export function checkFailure(error: unknown): CheckResult {
  if (accessLost(error)) return { kind: "terminated", reason: "access_lost" };
  if (httpCode(error, 409, "COMMAND_PAYLOAD_MISMATCH")) return { kind: "mismatch" };
  if (httpCode(error, 409, "DOCUMENT_STALE")) return { kind: "window_stale" };
  if (httpCode(error, 503, "MAINTENANCE")) return { kind: "unreachable", pauseSeconds: (error as ApiError).pause?.waitSeconds ?? null };
  return { kind: "unreachable" };
}
