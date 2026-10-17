// CP5b stage 4 (D-CP5 10.3): the transport feeds the page's server clock with the Date of a successful answer only. A
// refusal, a lost reply or an answer without the header teaches nothing (an unknown source stays unknown).
import { describe, expect, it, vi } from "vitest";
import { createJsonTransport } from "./http";
import { testGate } from "../commands/testGate.test-support";
import { createServerClock } from "../commands/serverClock";
import { systemRecoveryClock } from "../commands/recoveryClock";

const DATE = "Sat, 17 Oct 2026 12:00:00 GMT", AT = Date.UTC(2026, 9, 17, 12, 0, 0);

describe("the Date of answers and the page's server clock", () => {
  it("a successful answer with Date sets the clock; a refusal, a failure and an answer without Date leave it as it was", async () => {
    const serverClock = createServerClock();
    const replies: Array<() => Response> = [
      () => new Response('{"ok":1}', { status: 503, headers: { date: "Sat, 17 Oct 2026 11:00:00 GMT" } }),
      () => { throw new TypeError("network"); },
      () => new Response('{"ok":1}'),
      () => new Response('{"ok":1}', { headers: { date: DATE } }),
      () => new Response('{"ok":1}', { status: 409, headers: { date: "Sat, 17 Oct 2026 13:00:00 GMT" } }),
    ];
    let n = 0;
    const fetcher = vi.fn(async () => replies[n++]());
    const request = createJsonTransport({ fetcher, timeoutMs: 100, maxResponseBytes: 1000, gate: testGate(), serverClock });
    await request("/today", { method: "GET" }).catch(() => undefined);
    expect(serverClock.bounds()).toBeNull();
    await request("/today", { method: "GET" }).catch(() => undefined);
    await request("/today", { method: "GET" });
    expect(serverClock.bounds()).toBeNull();
    await request("/today", { method: "GET" });
    const bounds = serverClock.bounds()!;
    // Sent and received within this synchronous test: the interval is the accuracy of Date wide (± the jsdom clock).
    expect(bounds.lower).toBeGreaterThanOrEqual(AT - 50);
    expect(bounds.upper - bounds.lower).toBeGreaterThanOrEqual(1_000);
    expect(bounds.upper - bounds.lower).toBeLessThan(1_100);
    await request("/today", { method: "GET" }).catch(() => undefined);
    expect(serverClock.bounds()!.lower - bounds.lower).toBeGreaterThanOrEqual(0);
  });

  it("by default the page's clock is fed, and the recovery clock of the page reads it", async () => {
    const date = new Date(Math.floor(Date.now() / 1000) * 1000 + 3_600_000).toUTCString();
    const fetcher = vi.fn(async () => new Response('{"ok":1}', { headers: { date } }));
    await createJsonTransport({ fetcher, timeoutMs: 100, maxResponseBytes: 1000, gate: testGate() })("/today", { method: "GET" });
    const bounds = systemRecoveryClock.serverBounds!();
    expect(bounds).not.toBeNull();
    expect(bounds!.lower).toBeLessThanOrEqual(Date.parse(date) + 1_000);
    expect(bounds!.upper).toBeGreaterThanOrEqual(Date.parse(date));
  });
});
