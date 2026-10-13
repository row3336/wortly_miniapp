import { expect } from "vitest";
import { TRACE_HEADER } from "./http";

/** Every request carries a fresh X-Wortly-Trace-Id (events TZ §2.1): exact header expectations add it as a UUIDv4. */
export const ANY_TRACE = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export function withTrace<T extends Record<string, unknown>>(headers: T): T & { [TRACE_HEADER]: unknown } {
  return { ...headers, [TRACE_HEADER]: ANY_TRACE };
}
