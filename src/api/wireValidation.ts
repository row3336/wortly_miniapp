import type { ClosedSessionBoundary } from "./generated";

/** Shared checks for untrusted wire values; no coercion of IDs, counts or versions. */
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function sameId(value: unknown, expected: string): boolean {
  return uuid(value) && value.toLowerCase() === expected.toLowerCase();
}
export function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function version(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value)
    && BigInt(value) <= 9223372036854775807n;
}
export function eventTime(value: unknown): boolean {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|\+00:00)$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}
export function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}
/** Every close_reason the client decodes. save_failed is accepted ahead of the core release that writes it (R2a); the shown text falls back to the generic closed text. */
export const CLOSE_REASONS: readonly string[] = ["midnight", "pair_changed", "timezone_date_changed", "stop", "remote_stop", "summary_home", "save_failed"];
export function validClosedSessionBoundary(value: unknown, sessionId: string): value is ClosedSessionBoundary {
  return record(value) && exactKeys(value, ["session_id", "status", "close_reason"])
    && sameId(value.session_id, sessionId) && value.status === "closed"
    && oneOf(value.close_reason, CLOSE_REASONS);
}
export function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function date(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}
