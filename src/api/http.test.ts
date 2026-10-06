import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createJsonTransport, httpError } from "./http";

afterEach(() => vi.useRealTimers());

function transport(fetcher: typeof fetch, maxResponseBytes = 1000) {
  return createJsonTransport({ fetcher, timeoutMs: 100, maxResponseBytes });
}

describe("bounded JSON exchange", () => {
  it("keeps credentials in headers and performs exactly one noncached exchange", async () => {
    const fetcher = vi.fn(async () => new Response('{"saved":true}'));
    const request = createJsonTransport({ fetcher, baseUrl: "https://example.invalid///",
      timeoutMs: 100, maxResponseBytes: 100 });
    expect(await request("/commands", { method: "POST", token: "synthetic-token",
      proof: "synthetic-proof", body: { command_id: "same-intent" } }))
      .toMatchObject({ status: 200, value: { saved: true } });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("https://example.invalid/api/v1/commands", {
      method: "POST", headers: { Authorization: "Bearer synthetic-token",
        "X-Origin-Proof": "synthetic-proof", "Content-Type": "application/json" },
      body: '{"command_id":"same-intent"}', signal: expect.any(AbortSignal),
      credentials: "same-origin", cache: "no-store",
    });
  });

  it.each([0, -1, Infinity, NaN])("requires an explicit positive timeout (%s)", timeoutMs => {
    expect(() => createJsonTransport({ fetcher: fetch, timeoutMs, maxResponseBytes: 100 })).toThrow();
  });
  it.each([0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("requires a byte limit (%s)", maxResponseBytes => {
    expect(() => createJsonTransport({ fetcher: fetch, timeoutMs: 100, maxResponseBytes })).toThrow();
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
    const assertion = expect(pending).rejects.toMatchObject({ kind: "network" });
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
    const assertion = expect(pending).rejects.toMatchObject({ kind: "network" });
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
    const request = createJsonTransport({ fetcher: reply(envelope, 409), timeoutMs: 100, maxResponseBytes: 1000, onDocumentStale });
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
    const request = createJsonTransport({ fetcher: reply(value, status), timeoutMs: 100, maxResponseBytes: 1000, onDocumentStale });
    await request("/commands", { method: "POST", body: {} });
    expect(onDocumentStale).not.toHaveBeenCalled();
  });

  it("works without a listener, and an unreadable 409 tells nothing", async () => {
    const stale = { error: { code: "DOCUMENT_STALE" } };
    await expect(transport(reply(stale, 409))("/today", { method: "GET" })).resolves.toMatchObject({ status: 409 });
    const onDocumentStale = vi.fn();
    const broken = vi.fn(async () => new Response("{", { status: 409 }));
    const request = createJsonTransport({ fetcher: broken, timeoutMs: 100, maxResponseBytes: 1000, onDocumentStale });
    await expect(request("/today", { method: "GET" })).resolves.toMatchObject({ status: 409, value: undefined });
    expect(onDocumentStale).not.toHaveBeenCalled();
  });
});
