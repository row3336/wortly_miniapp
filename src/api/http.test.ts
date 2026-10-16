import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, clientContractVersion, createJsonTransport, httpError, readRetryAfter } from "./http";
import { testGate } from "../commands/testGate.test-support";
import { WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function transport(fetcher: typeof fetch, maxResponseBytes = 1000) {
  return createJsonTransport({ fetcher, timeoutMs: 100, maxResponseBytes, gate: testGate() });
}

describe("bounded JSON exchange", () => {
  it("keeps credentials in headers and performs exactly one noncached exchange", async () => {
    const fetcher = vi.fn(async () => new Response('{"saved":true}'));
    const request = createJsonTransport({ fetcher, baseUrl: "https://example.invalid///",
      timeoutMs: 100, maxResponseBytes: 100, gate: testGate() });
    expect(await request("/commands", { method: "POST", token: "synthetic-token",
      proof: "synthetic-proof", body: { command_id: "same-intent" } }))
      .toMatchObject({ status: 200, value: { saved: true } });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://example.invalid/api/v1/commands", {
      method: "POST", headers: { Authorization: "Bearer synthetic-token",
        "X-Origin-Proof": "synthetic-proof", "Content-Type": "application/json",
        "X-Wortly-Contract-Version": clientContractVersion(), "X-Wortly-Trace-Id": expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) },
      body: '{"command_id":"same-intent"}', signal: expect.any(AbortSignal),
      credentials: "same-origin", cache: "no-store",
    });
  });

  it("tells started once, after the request is built and right before fetch; a body that cannot be built tells nothing", async () => {
    const order: string[] = [];
    const fetcher = vi.fn(async () => { order.push("fetch"); return new Response('{"saved":true}'); });
    const request = createJsonTransport({ fetcher, timeoutMs: 100, maxResponseBytes: 100, gate: testGate() });
    await request("/commands", { method: "POST", token: "t", proof: "p", body: { command_id: "x" }, started: () => order.push("started") });
    expect(order).toEqual(["started", "fetch"]);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const started = vi.fn();
    await expect(request("/commands", { method: "POST", token: "t", proof: "p", body: cyclic, started })).rejects.toBeTruthy();
    expect(started).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([0, -1, Infinity, NaN])("requires an explicit positive timeout (%s)", timeoutMs => {
    expect(() => createJsonTransport({ fetcher: fetch, timeoutMs, maxResponseBytes: 100, gate: testGate() })).toThrow();
  });
  it.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("requires a byte limit (%s)", maxResponseBytes => {
    expect(() => createJsonTransport({ fetcher: fetch, timeoutMs: 100, maxResponseBytes, gate: testGate() })).toThrow();
  });

  it("counts bytes and supports a Unicode code point split across chunks", async () => {
    const bytes = new TextEncoder().encode('"я"');
    const response = () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(bytes.slice(0, 2));
      controller.enqueue(bytes.slice(2));
      controller.close();
    } }));
    expect((await transport(vi.fn(async () => response()), bytes.byteLength)("/today", { method: "GET" })).value).toBe("я");
    await expect(transport(vi.fn(async () => response()), bytes.byteLength - 1)("/today", { method: "GET" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("cancels an oversized stream without awaiting an unresponsive cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(20)); }, cancel,
    }));
    await expect(transport(vi.fn(async () => response), 10)("/today", { method: "GET" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("checks the advertised length before reading", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Length": "1001" } });
    await expect(transport(vi.fn(async () => response))("/today", { method: "GET" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([{ bytes: [34, 255, 34] }, { bytes: [34, 208] }, { bytes: [123] }])("rejects malformed UTF-8 or JSON %#", async ({ bytes }) => {
    const response = new Response(new Uint8Array(bytes));
    await expect(transport(vi.fn(async () => response))("/today", { method: "GET" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("bounds the deadline even if fetch ignores abort; late body is cancelled", async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      return new Promise<Response>(resolve => { finish = resolve; });
    });
    const pending = transport(fetcher)("/today", { method: "GET" });
    const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the deadline active while reading a stalled response body", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); }, cancel,
    })));
    const pending = transport(fetcher)("/commands", { method: "POST", body: {} });
    const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("clears the deadline after success", async () => {
    vi.useFakeTimers();
    await transport(vi.fn(async () => new Response("{}")))("/today", { method: "GET" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 409, 422, 503])("preserves known HTTP %s when body and cancellation stall", async status => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"private":"synthetic')); }, cancel,
    }), { status }));
    const pending = transport(fetcher)("/commands", { method: "POST", body: {} });
    const assertion = expect(pending).rejects.toMatchObject({ kind: "http", status, code: undefined });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(JSON.stringify(await pending.catch(error => error))).not.toContain("synthetic");
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a refusal during the bodyless text fallback deadline", async () => {
    vi.useFakeTimers();
    const response = new Response(null, { status: 403 });
    vi.spyOn(response, "text").mockReturnValue(new Promise<string>(() => {}));
    const pending = transport(vi.fn(async () => response))("/today", { method: "GET" });
    const assertion = expect(pending).rejects.toMatchObject({ kind: "http", status: 403 });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a truncated stream as an unknown network outcome", async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("synthetic-stream-failure")); },
    })));
    await expect(transport(fetcher)("/commands", { method: "POST", body: {} }))
      .rejects.toMatchObject({ kind: "network" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not expose a thrown fetch error or retry", async () => {
    const fetcher = vi.fn(async () => { throw new Error("synthetic-private-request"); });
    const error = await transport(fetcher)("/commands", { method: "POST", body: {} }).catch(error => error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("network");
    expect(JSON.stringify(error)).not.toContain("synthetic-private-request");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 409, 422, 503])("retains HTTP %s with an unreadable body", async status => {
    const reply = await transport(vi.fn(async () => new Response("unreadable", { status })))("/commands", { method: "POST" });
    expect(reply.value).toBeUndefined();
    expect(httpError(reply)).toMatchObject({ kind: "http", status, code: undefined });
  });

  it("returns a stable code but never the error body in an exception", async () => {
    const reply = await transport(vi.fn(async () => new Response(JSON.stringify({
      error: { code: "WRITE_UNAVAILABLE", private: "do-not-expose" },
    }), { status: 503 })))("/commands", { method: "POST" });
    expect(httpError(reply)).toMatchObject({ status: 503, code: "WRITE_UNAVAILABLE" });
    expect(JSON.stringify(httpError(reply))).not.toContain("do-not-expose");
  });
});

describe("the one DOCUMENT_STALE point", () => {
  const reply = (value: unknown, status: number) => vi.fn(async () => new Response(JSON.stringify(value), { status }));

  it("tells the window before the caller reads the refusal, and still hands the reply over unchanged", async () => {
    const order: string[] = [];
    const onDocumentStale = vi.fn(() => { order.push("window"); });
    const envelope = { command: { id: "c", status: "rejected" }, current: { status: "unavailable" }, state_version: "3",
      error: { code: "DOCUMENT_STALE" } };
    const request = createJsonTransport({ fetcher: reply(envelope, 409), timeoutMs: 100, maxResponseBytes: 1000, gate: testGate(), onDocumentStale });
    const answer = await request("/commands", { method: "POST", body: {} }).then(value => { order.push("caller"); return value; });
    expect(answer).toEqual({ status: 409, ok: false, value: envelope });
    expect(order).toEqual(["window", "caller"]);
  });

  it.each([
    [409, { error: { code: "SESSION_BUSY" } }],
    [409, { error: { code: "VERSION_CONFLICT" } }],
    [403, { error: { code: "DOCUMENT_STALE" } }],
    [200, { error: { code: "DOCUMENT_STALE" } }],
    [409, { error: "DOCUMENT_STALE" }],
  ])("says nothing for HTTP %s %j", async (status, value) => {
    const onDocumentStale = vi.fn();
    const request = createJsonTransport({ fetcher: reply(value, status), timeoutMs: 100, maxResponseBytes: 1000, gate: testGate(), onDocumentStale });
    await request("/commands", { method: "POST", body: {} });
    expect(onDocumentStale).not.toHaveBeenCalled();
  });

  it("works without a listener, and an unreadable 409 tells nothing", async () => {
    const stale = { error: { code: "DOCUMENT_STALE" } };
    await expect(transport(reply(stale, 409))("/today", { method: "GET" })).resolves.toMatchObject({ status: 409 });
    const onDocumentStale = vi.fn();
    const broken = vi.fn(async () => new Response("{", { status: 409 }));
    const request = createJsonTransport({ fetcher: broken, timeoutMs: 100, maxResponseBytes: 1000, gate: testGate(), onDocumentStale });
    await expect(request("/today", { method: "GET" })).resolves.toMatchObject({ status: 409, value: undefined });
    expect(onDocumentStale).not.toHaveBeenCalled();
  });
});

describe("contract version on writes (M-COMPAT-HDR)", () => {
  const ok = () => vi.fn(async (_url: string, _init: RequestInit) => new Response("{}"));
  const sent = (fetcher: ReturnType<typeof ok>) => new Headers(fetcher.mock.calls[0][1].headers);

  it("names the contract on every POST, with or without credentials and body", async () => {
    for (const request of [
      { method: "POST" as const },
      { method: "POST" as const, token: "t", body: { command_id: "c" } },
      { method: "POST" as const, token: "t", proof: "p", body: {} },
    ]) {
      const fetcher = ok();
      await createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 100, maxResponseBytes: 100, gate: testGate(), contractVersion: "7" })("/commands", request);
      expect(sent(fetcher).get("X-Wortly-Contract-Version")).toBe("7");
    }
  });

  it("does not send it on a read: the core checks writes only, and an outdated client may still read", async () => {
    const fetcher = ok();
    await createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 100, maxResponseBytes: 100, gate: testGate(), contractVersion: "7" })("/today", { method: "GET", token: "t" });
    expect(sent(fetcher).has("X-Wortly-Contract-Version")).toBe(false);
  });

  it.each(["", undefined])("an empty configured version falls back to \"1\", so the header is never empty (%s)", async configured => {
    vi.stubEnv("VITE_WORTLY_CONTRACT_VERSION", configured as string);
    expect(clientContractVersion()).toBe("1");
    for (const contractVersion of [undefined, ""]) {
      const fetcher = ok();
      await createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 100, maxResponseBytes: 100, gate: testGate(), contractVersion })("/commands", { method: "POST" });
      expect(sent(fetcher).get("X-Wortly-Contract-Version")).toBe("1");
    }
    vi.unstubAllEnvs();
  });

  it("takes the version from the client's own configuration unless the caller overrides it", async () => {
    const fetcher = ok();
    await createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 100, maxResponseBytes: 100, gate: testGate() })("/commands", { method: "POST" });
    expect(sent(fetcher).get("X-Wortly-Contract-Version")).toBe(clientContractVersion());
    expect(clientContractVersion()).toMatch(/^[1-9][0-9]*$/);
  });
});

describe("known refusals of a write (M-COMPAT-HDR)", () => {
  const refusal = (value: unknown, status: number, headers: Record<string, string> = {}) =>
    transport(vi.fn(async () => new Response(JSON.stringify(value), { status, headers })))("/commands", { method: "POST" });

  it("reads the planned pause estimate from the body", async () => {
    const reply = await refusal({ error: { code: "MAINTENANCE", estimated_end_at: "2026-10-07T12:00:00Z", wait_seconds: 42 } }, 503,
      { "Retry-After": "42" });
    expect(httpError(reply)).toMatchObject({ kind: "http", status: 503, code: "MAINTENANCE",
      pause: { waitSeconds: 42 } });
  });

  it("keeps wait_seconds=0 (the estimate has passed) distinct from no estimate", async () => {
    expect(httpError(await refusal({ error: { code: "MAINTENANCE", estimated_end_at: "2026-10-07T12:00:00Z", wait_seconds: 0 } }, 503)).pause)
      .toEqual({ waitSeconds: 0 });
    expect(httpError(await refusal({ error: { code: "MAINTENANCE" } }, 503)).pause)
      .toEqual({ waitSeconds: null });
  });

  it("falls back to Retry-After when the body has no wait, and prefers the body when it has one", async () => {
    expect(httpError(await refusal({ error: { code: "MAINTENANCE" } }, 503, { "Retry-After": "30" })).pause)
      .toMatchObject({ waitSeconds: 30 });
    expect(httpError(await refusal({ error: { code: "MAINTENANCE", wait_seconds: 5 } }, 503, { "Retry-After": "30" })).pause)
      .toMatchObject({ waitSeconds: 5 });
  });

  it.each([-1, 1.5, "7", null])("drops a malformed wait_seconds %s", async wait => {
    expect(httpError(await refusal({ error: { code: "MAINTENANCE", wait_seconds: wait } }, 503)).pause)
      .toEqual({ waitSeconds: null });
  });

  // M-P03-9: the shown wait is bounded as send_hold is (§3.5): an integer above 900 shows 900, not nothing.
  it("clamps a huge wait_seconds to 900 (§3.5)", async () => {
    expect(httpError(await refusal({ error: { code: "MAINTENANCE", wait_seconds: 2 ** 60 } }, 503)).pause)
      .toEqual({ waitSeconds: 900 });
  });

  it("M-P03-9: retry_after_s comes before wait_seconds and Retry-After in the shown wait (§3.2, §3.5)", async () => {
    expect(httpError(await refusal({ error: { code: "MAINTENANCE", retry_after_s: 30, wait_seconds: 40 } }, 503, { "Retry-After": "50" })).pause)
      .toEqual({ waitSeconds: 30 });
    expect(httpError(await refusal({ error: { code: "MAINTENANCE", wait_seconds: 40 } }, 503, { "Retry-After": "50" })).pause)
      .toEqual({ waitSeconds: 40 });
    expect(httpError(await refusal({ error: { code: "MAINTENANCE" } }, 503, { "Retry-After": "50" })).pause)
      .toEqual({ waitSeconds: 50 });
    expect(httpError(await refusal({ error: { code: "MAINTENANCE", retry_after_s: 1000 } }, 503)).pause)
      .toEqual({ waitSeconds: 900 });
  });

  it("ignores a Retry-After that is a date or negative", async () => {
    expect(httpError(await refusal({ error: { code: "MAINTENANCE" } }, 503, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" })).pause)
      .toEqual({ waitSeconds: null });
  });

  it("tells MAINTENANCE from WRITE_UNAVAILABLE, which has no pause data", async () => {
    const error = httpError(await refusal({ error: { code: "WRITE_UNAVAILABLE", wait_seconds: 9 } }, 503, { "Retry-After": "9" }));
    expect(error).toMatchObject({ status: 503, code: "WRITE_UNAVAILABLE" });
    expect(error.pause).toBeUndefined();
  });

  it("recognises CLIENT_INCOMPATIBLE as a known code and never leaks the body", async () => {
    const error = httpError(await refusal({ error: { code: "CLIENT_INCOMPATIBLE", secret: "do-not-expose" } }, 409));
    expect(error).toMatchObject({ kind: "http", status: 409, code: "CLIENT_INCOMPATIBLE" });
    expect(error.pause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("do-not-expose");
  });
});

describe("the estimate of a pause and the own deadline (M-P03-2, P03 §3.2, §3.5)", () => {
  const reply = (value: unknown, headers: Record<string, string> = {}) =>
    transport(vi.fn(async () => new Response(JSON.stringify(value), { status: 503, headers })))("/commands", { method: "POST" });

  it.each([
    ["retry_after_s first", { retry_after_s: 40, wait_seconds: 41 }, { "Retry-After": "42" }, 40, false],
    ["then wait_seconds", { wait_seconds: 41 }, { "Retry-After": "42" }, 41, false],
    ["then Retry-After", { retry_after_s: null, wait_seconds: null }, { "Retry-After": "42" }, 42, false],
    ["then none", {}, {}, null, false],
    ["AC-05a 1000 → 900", { retry_after_s: 1000 }, {}, 900, true],
    ["AC-05a −1 → ignored", { retry_after_s: -1 }, {}, null, true],
    ["AC-05a 1.5 → ignored", { retry_after_s: 1.5 }, {}, null, true],
    ["AC-05a Retry-After 999999999 → 900", {}, { "Retry-After": "999999999" }, 900, true],
    ["a ten-digit Retry-After → 900", {}, { "Retry-After": "12345678901" }, 900, true],
    ["a date Retry-After → ignored", {}, { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }, null, true],
    ["a negative Retry-After → ignored", {}, { "Retry-After": "-5" }, null, true],
    ["a malformed value is not replaced by a later source", { retry_after_s: "soon", wait_seconds: 30 }, {}, null, true],
    ["a wait_seconds beyond 900 → 900", { wait_seconds: 1200 }, {}, 900, true],
  ])("%s", async (_name, error, headers, seconds, anomaly) => {
    expect(readRetryAfter(await reply({ error: { code: "MAINTENANCE", ...error } }, headers))).toEqual({ seconds, anomaly });
  });

  it("keeps the raw Retry-After only when it is not 1–9 digits", async () => {
    expect(await reply({}, { "Retry-After": "30" })).not.toHaveProperty("retryAfterRaw");
    expect(await reply({}, { "Retry-After": "x".repeat(100) })).toMatchObject({ retryAfterRaw: "x".repeat(64) });
  });

  it("tells the own deadline (timeout) from a refused connection (network)", async () => {
    await expect(transport(vi.fn(async () => { throw new TypeError("Failed to fetch"); }))("/today", { method: "GET" }))
      .rejects.toMatchObject({ kind: "network" });
    vi.useFakeTimers();
    const pending = transport(vi.fn(() => new Promise<Response>(() => {})))("/today", { method: "GET" });
    const assertion = expect(pending).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(await pending.catch(error => error)).toBeInstanceOf(ApiError);
  });
});

// QA a2f6d85b J2 (C444) as a regression: a stamped callback changes request.proof after the header was set — the actual-
// send snapshot follows the X-Origin-Proof header really sent, both ways (real transport + real gate).
describe("the actual-send snapshot follows the proof header really sent (C163 C401, J2)", () => {
  for (const way of ["sent, then cleared", "absent, then set"] as const) it(`stamped changes request.proof: ${way}`, async () => {
    let header: string | null | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      header = new Headers(init?.headers).get("X-Origin-Proof");
      return new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), { status: 403, headers: { "content-type": "application/json" } });
    });
    const gate = new WriteGate({ clock: new ManualClock() });
    const transport = createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 5_000, maxResponseBytes: 100_000, gate });
    const request: { method: "GET"; token: string; proof?: string; stamped: () => void } = { method: "GET", token: "t",
      ...(way === "sent, then cleared" ? { proof: "real-proof" } : {}),
      stamped: () => { request.proof = way === "sent, then cleared" ? "" : "late-proof"; } };
    const reply = await transport("/sessions/00000000-0000-4000-8000-000000000001?client_instance_id=c&document_id=d", request);
    const error = httpError(reply);
    expect(header).toBe(way === "sent, then cleared" ? "real-proof" : null);
    expect(error.sentRefusal?.sent.proofSent).toBe(way === "sent, then cleared");
  });
});
