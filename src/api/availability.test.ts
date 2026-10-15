import { afterEach, describe, expect, it, vi } from "vitest";
import { availabilityOf, createAvailabilityClient } from "./availability";
import { CONTRACT_VERSION_HEADER } from "./http";
import { testGate } from "../commands/testGate.test-support";

afterEach(() => { vi.useRealTimers(); });

function client(response: () => Response | Promise<Response>, timeoutMs = 1_000) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
  return { fetcher, probe: createAvailabilityClient({ fetcher: fetcher as typeof fetch, timeoutMs, maxResponseBytes: 1_000, gate: testGate() }).probe };
}
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });

describe("GET /api/v1/availability (M-P03-1, P03 §3.1)", () => {
  it("is one uncached GET without token, proof, contract header or body", async () => {
    const { fetcher, probe } = client(json({ status: "ready", retry_after_s: null }));
    expect(await probe()).toEqual({ status: "ready" });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/availability");
    expect(init).toMatchObject({ method: "GET", cache: "no-store" });
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(Object.keys(headers)).not.toContain("Authorization");
    expect(Object.keys(headers)).not.toContain("X-Origin-Proof");
    expect(Object.keys(headers)).not.toContain(CONTRACT_VERSION_HEADER);
    expect(Object.keys(headers)).not.toContain("Content-Type");
  });

  it.each([
    [{ status: "maintenance", retry_after_s: 40 }, 503, { status: "maintenance", retryAfterS: 40, anomaly: false }],
    [{ status: "maintenance", retry_after_s: null }, 503, { status: "maintenance", retryAfterS: null, anomaly: false }],
    [{ status: "unavailable", retry_after_s: null }, 503, { status: "unavailable", retryAfterS: null, anomaly: false }],
    [{ status: "maintenance", retry_after_s: 0 }, 503, { status: "maintenance", retryAfterS: 0, anomaly: false }],
  ])("reads a refusal %j", async (body, status, expected) => {
    expect(await client(json(body, status)).probe()).toEqual(expected);
  });

  it.each([
    ["ready with a wait", { status: "ready", retry_after_s: 5 }, 200],
    ["ready on 503", { status: "ready", retry_after_s: null }, 503],
    ["maintenance on 200", { status: "maintenance", retry_after_s: null }, 200],
    ["an extra field", { status: "ready", retry_after_s: null, extra: 1 }, 200],
    ["a missing field", { status: "ready" }, 200],
    ["an unknown status", { status: "paused", retry_after_s: null }, 503],
    ["an error envelope", { error: { code: "MAINTENANCE", retry_after_s: 10 } }, 503],
    ["another code", { status: "ready", retry_after_s: null }, 201],
    ["404 of a proxy", { status: "ready", retry_after_s: null }, 404],
    ["an array", [], 200],
  ])("AC-04: %s is unknown", async (_name, body, status) => {
    expect(await client(json(body, status)).probe()).toEqual({ status: "unknown" });
  });

  it.each([
    ["HTML of a proxy", () => new Response("<html>bad gateway</html>", { status: 502 })],
    ["a refused connection", () => { throw new TypeError("Failed to fetch"); }],
    ["an empty 503", () => new Response(null, { status: 503 })],
  ])("AC-04: %s is unknown", async (_name, response) => {
    expect(await client(response).probe()).toEqual({ status: "unknown" });
  });

  it("a probe that runs into its timeout is unknown", async () => {
    vi.useFakeTimers();
    const { probe } = client(() => new Promise<Response>(() => {}), 50);
    const answer = probe();
    await vi.advanceTimersByTimeAsync(50);
    expect(await answer).toEqual({ status: "unknown" });
  });

  it.each([
    ["1000", { retry_after_s: 1000 }, {}, 900, true],
    ["−1", { retry_after_s: -1 }, {}, null, true],
    ["1.5", { retry_after_s: 1.5 }, {}, null, true],
    ["a string", { retry_after_s: "7" }, {}, null, true],
    ["null with Retry-After 30", { retry_after_s: null }, { "Retry-After": "30" }, 30, false],
    ["null with Retry-After 999999999", { retry_after_s: null }, { "Retry-After": "999999999" }, 900, true],
    ["null with a ten-digit Retry-After", { retry_after_s: null }, { "Retry-After": "1234567890" }, 900, true],
    ["null with a date Retry-After", { retry_after_s: null }, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, null, true],
    ["the body before Retry-After", { retry_after_s: 20 }, { "Retry-After": "300" }, 20, false],
  ])("AC-05a: retry_after_s %s is bounded by §3.5", async (_name, body, headers, seconds, anomaly) => {
    expect(await client(json({ status: "maintenance", ...body }, 503, headers)).probe())
      .toEqual({ status: "maintenance", retryAfterS: seconds, anomaly });
  });

  it("decides on the reply alone (availabilityOf)", () => {
    expect(availabilityOf({ status: 200, ok: true, value: { status: "ready", retry_after_s: null } })).toEqual({ status: "ready" });
    expect(availabilityOf({ status: 200, ok: true, value: undefined })).toEqual({ status: "unknown" });
  });
});
