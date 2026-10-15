// The observer of the write gate in the transport (P03 §4.1 «Наблюдатель в транспорте», M-P03-4).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonTransport } from "../api/http";
import { WriteGate } from "./writeGate";
import { ManualClock } from "./writeGate.test-support";

afterEach(() => { vi.useRealTimers(); });

function setup(respond: () => Response | Promise<Response>, timeoutMs = 1_000) {
  const clock = new ManualClock();
  const gate = new WriteGate({ clock });
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => respond());
  const request = createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs, maxResponseBytes: 10_000, gate });
  return { gate, clock, fetcher, request };
}
const json = (value: unknown, status: number, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(value), { status, headers });

describe("observer: what closes net (M-P03-4)", () => {
  it("503 MAINTENANCE of the core closes net(maintenance) and starts send_hold from retry_after_s (§3.2, §3.5)", async () => {
    const { gate, request } = setup(json({ error: { code: "MAINTENANCE", retry_after_s: 40, wait_seconds: 1200 } }, 503, { "Retry-After": "40" }));
    await request("/commands", { method: "POST", body: { command_id: "a" } });
    expect(gate.snapshot()).toMatchObject({ net: { kind: "closed", cause: "maintenance" }, holdUntil: 40_000 });
    // Outside an episode a planned pause starts the series at 5 s, but no episode (§2 «Начало эпизода»).
    expect(gate.snapshot().episode).toBeNull();
  });

  it("a hold beyond 900 s is bounded (§3.5)", async () => {
    const { gate, request } = setup(json({ error: { code: "MAINTENANCE", retry_after_s: 1000 } }, 503));
    await request("/today", { method: "GET" });
    expect(gate.snapshot().holdUntil).toBe(900_000);
  });

  it.each([
    ["503 WRITE_UNAVAILABLE", json({ error: { code: "WRITE_UNAVAILABLE" } }, 503), "unavailable"],
    ["502 of a proxy", () => new Response("<html>bad gateway</html>", { status: 502 }), "unknown"],
    ["504", json({}, 504), "unknown"],
    ["500 INTERNAL_ERROR", json({ error: { code: "INTERNAL_ERROR" } }, 500), "unknown"],
    ["503 without a code", () => new Response("", { status: 503 }), "unknown"],
    ["a refused connection", () => { throw new TypeError("Failed to fetch"); }, "unknown"],
  ])("%s on a real request closes net and starts an episode (probe in 5 s)", async (_name, respond, cause) => {
    const { gate, request } = setup(respond as () => Response);
    await request("/commands", { method: "POST", body: { command_id: "a" } }).catch(() => undefined);
    expect(gate.snapshot()).toMatchObject({ net: { kind: "closed", cause }, episode: { index: 1 }, probeScheduled: true });
  });

  it.each([
    ["200", json({ ok: true }, 200)],
    ["422", json({ error: { code: "VALIDATION_FAILED" } }, 422)],
    ["409 DOCUMENT_STALE", json({ error: { code: "DOCUMENT_STALE" } }, 409)],
    ["401", json({ error: { code: "AUTH_EXPIRED" } }, 401)],
    ["404 of a proxy", () => new Response("<html>not found</html>", { status: 404 })],
    ["an unreadable 200", () => new Response("{", { status: 200 })],
  ])("%s leaves net open (an answer, or an ordinary loss)", async (_name, respond) => {
    const { gate, request } = setup(respond);
    await request("/commands", { method: "POST", body: { command_id: "a" } }).catch(() => undefined);
    expect(gate.snapshot()).toMatchObject({ net: { kind: "open" }, episode: null });
    expect(gate.mayWrite()).toBe(true);
  });

  it("RD-2 (AC-61 after M-P03-2): the client's own timeout of a mutation is an ordinary loss — net stays open", async () => {
    vi.useFakeTimers();
    const { gate, request } = setup(() => new Promise<Response>(() => {}), 50);
    const sent = request("/commands", { method: "POST", body: { command_id: "a" } }).catch(error => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await sent).toMatchObject({ kind: "timeout" });
    expect(gate.snapshot().net).toEqual({ kind: "open" });
  });

  it("…but a timeout of the entry's foreground open closes net (K-11 ВР-1 ahead of RD-2); the first open's does not", async () => {
    vi.useFakeTimers();
    const foreground = setup(() => new Promise<Response>(() => {}), 50);
    const a = foreground.request("/client/open", { method: "POST", body: { event: "foreground", document_id: "d" } }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(50); await a;
    expect(foreground.gate.snapshot().net).toEqual({ kind: "closed", cause: "unknown" });
    const first = setup(() => new Promise<Response>(() => {}), 50);
    const b = first.request("/client/open", { method: "POST", body: { event: "open", document_id: "d" } }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(50); await b;
    expect(first.gate.snapshot().net).toEqual({ kind: "open" });
  });

  it("the availability probe is not a real request: the transport's observer ignores it (the gate reads its answer)", async () => {
    const { gate, request } = setup(json({ status: "maintenance", retry_after_s: 100 }, 503));
    await request("/availability", { method: "GET" });
    expect(gate.snapshot()).toMatchObject({ net: { kind: "open" }, holdUntil: null, episode: null });
  });

  it("a second failure in the same episode moves the series on (§2 «Тот же эпизод»)", async () => {
    const { gate, clock, request } = setup(json({}, 502));
    await request("/today", { method: "GET" }).catch(() => undefined);
    await clock.advanceTo(2_000);
    await request("/today", { method: "GET" }).catch(() => undefined);
    expect(gate.snapshot().episode?.index).toBe(2);
  });
});
