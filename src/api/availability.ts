import { boundRetryAfter, createJsonTransport, headerRetryAfter, type HttpOptions, type JsonReply, type RetryAfter } from "./http";

/** The probe route of P03 §3.1 (core C-P03-1): no authentication, no body, never cached. */
export const AVAILABILITY_PATH = "/availability";

/**
 * What one probe says (P03 §3.1). `ready` only for 200 with a valid body whose status is "ready"; any other answer, a
 * failed exchange, a timeout or an unreadable body is `unknown` (AC-04). retryAfterS of a refusal is already bounded by
 * §3.5 (0…900, null when absent or ignored); anomaly marks a clamped or ignored value.
 */
export type Availability =
  | { status: "ready" }
  | { status: "maintenance" | "unavailable"; retryAfterS: number | null; anomaly: boolean }
  | { status: "unknown" };

export interface AvailabilityClient {
  probe(): Promise<Availability>;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** The client's rule of §3.1 on one answer; the order of the estimate is the body, then Retry-After (§3.5). */
export function availabilityOf(reply: JsonReply): Availability {
  const value = reply.value;
  if (!exactRecord(value, ["status", "retry_after_s"])) return { status: "unknown" };
  if (reply.status === 200) {
    return value.status === "ready" && value.retry_after_s === null ? { status: "ready" } : { status: "unknown" };
  }
  if (reply.status !== 503 || (value.status !== "maintenance" && value.status !== "unavailable")) return { status: "unknown" };
  const estimate: RetryAfter = boundRetryAfter(value.retry_after_s) ?? headerRetryAfter(reply) ?? { seconds: null, anomaly: false };
  return { status: value.status, retryAfterS: estimate.seconds, anomaly: estimate.anomaly };
}

/**
 * M-P03-1: GET /api/v1/availability through the shared transport (bounds, no-store, the gate's L2: a closed window
 * reads nothing). It sends no token, proof, contract header or body. The write gate is its only caller (RD-5): it keeps
 * one probe of the page in flight and owns the series.
 */
export function createAvailabilityClient(options: HttpOptions): AvailabilityClient {
  // A probe never speaks for the window: DOCUMENT_STALE has no meaning for this route.
  const { onDocumentStale: _window, ...own } = options;
  const request = createJsonTransport(own);
  return {
    async probe() {
      try { return availabilityOf(await request(AVAILABILITY_PATH, { method: "GET" })); }
      catch { return { status: "unknown" }; }
    },
  };
}
