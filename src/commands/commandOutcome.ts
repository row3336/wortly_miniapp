import { ApiError } from "../api/http";

/**
 * After a command POST only an HTTP refusal below 500 proves that no fact exists; a lost reply, a 5xx, a foreign shape
 * or a closed handle leaves the outcome unknown, to be checked by status under the same command ID (CON:149).
 */
export function commandOutcomeUnknown(error: unknown): boolean {
  return !(error instanceof ApiError && error.kind === "http" && error.status !== undefined && error.status < 500);
}
