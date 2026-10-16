import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createJsonTransport } from "../api/http";
import { createAvailabilityClient } from "../api/availability";
import { POST_ROUTES, PausedBeforeSendError, WriteGate } from "./writeGate";
import { DOC_A, ManualClock } from "./writeGate.test-support";

afterEach(() => { vi.useRealTimers(); });

function setup() {
  const gate = new WriteGate({ clock: new ManualClock() });
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}'));
  const request = createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate });
  return { gate, fetcher, request };
}

const LOCKED_ID = "locked-command";
/** The three exceptions of L2 п.2; everything else is under the gate. */
const EXCEPTIONS = new Set(["/auth/telegram", "/client/register", "/client/open#foreground"]);
type Post = [string, Record<string, unknown>];
const posts: Post[] = [
  ...Object.keys(POST_ROUTES).flatMap((route): Post[] => route === "/client/open"
    ? [["/client/open#foreground", { event: "foreground", document_id: "document-a" }], ["/client/open#open", { event: "open", document_id: "document-a" }]]
    : [[route, { command_id: LOCKED_ID, kind: "synthetic" }]]),
  // Any POST the table does not know is gated (default-deny), as are the future ones.
  ["/notices/notice-1/ack", { command_id: LOCKED_ID }],
  ["/brand-new-route", { command_id: LOCKED_ID }],
];

const states: [string, (gate: WriteGate) => void, "paused" | "closed_window"][] = [
  ["net closed", gate => gate.closeByFailure(), "paused"],
  ["send_hold", gate => gate.extendHold(30), "paused"],
  ["identity lock of the document", gate => { gate.noteOpened(DOC_A); gate.lockIdentity(DOC_A); }, "paused"],
  ["family lock of the ID", gate => gate.resolvePending(LOCKED_ID, "stale"), "paused"],
  ["closed window", gate => gate.closeWindow(DOC_A), "closed_window"],
];

describe("L2 in the transport (RD-7, AC-43)", () => {
  describe.each(states)("%s", (stateName, close, reason) => {
    it.each(posts)("POST %s", async (name, body) => {
      const { gate, fetcher, request } = setup();
      close(gate);
      const route = name.split("#")[0];
      const started = vi.fn();
      const sent = request(route, { method: "POST", token: "t", proof: "p", body, started });
      // familyLocks bind a command_id; a request without one (the first open) is not concerned by them (N11).
      const unconcerned = stateName === "family lock of the ID" && !("command_id" in body);
      if ((EXCEPTIONS.has(name) || unconcerned) && reason !== "closed_window") {
        await expect(sent).resolves.toMatchObject({ status: 200 });
        expect(fetcher).toHaveBeenCalledOnce();
        return;
      }
      const error = await sent.catch(caught => caught);
      expect(error).toBeInstanceOf(PausedBeforeSendError);
      expect(error).not.toBeInstanceOf(ApiError);
      // п.8б (M-P03-10): with a document of reference (gateDoc) any `event="open"` is refused as k5_denied, before mayWrite.
      expect(error.reason).toBe(name === "/client/open#open" && stateName === "identity lock of the document" ? "k5_denied" : reason);
      expect(fetcher).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
    });

    it("GET of a projection passes unless the window is closed; a status read without a ticket never does", async () => {
      const { gate, fetcher, request } = setup();
      close(gate);
      if (reason === "closed_window") await expect(request("/today", { method: "GET", token: "t" })).rejects.toMatchObject({ reason });
      else await expect(request("/today", { method: "GET", token: "t" })).resolves.toMatchObject({ status: 200 });
      await expect(request("/commands/A?x=1", { method: "GET", token: "t" }))
        .rejects.toMatchObject({ reason: reason === "closed_window" ? "closed_window" : "no_ticket" });
      expect(fetcher).toHaveBeenCalledTimes(reason === "closed_window" ? 0 : 1);
    });
  });

  it("all POST routes pass an open gate (only K-5 stays blocked until Я19)", async () => {
    for (const [name, body] of posts) {
      const { fetcher, request } = setup();
      await expect(request(name.split("#")[0], { method: "POST", body })).resolves.toMatchObject({ status: 200 });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ["/client/open", { event: "foreground", document_id: "d", return_marker: "m" }],
    ["/client/open", { event: "open", document_id: "d", return_marker: "m" }],
    ["/client/window-return", { action_id: "a" }],
  ])("K-5 %s is refused as k5_denied even with an open gate (ya19ContractApproved=false)", async (path, body) => {
    const { fetcher, request } = setup();
    await expect(request(path, { method: "POST", body })).rejects.toMatchObject({ reason: "k5_denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("AC-43: /client/open with event=open is refused under the lock; the foreground exception still goes", async () => {
    const { gate, fetcher, request } = setup();
    gate.noteOpened(DOC_A);
    gate.lockIdentity(DOC_A);
    // п.8б (M-P03-10): the working document is gateDoc, so its `event="open"` is k5_denied whatever the lock.
    await expect(request("/client/open", { method: "POST", body: { event: "open", document_id: "document-a" } })).rejects.toMatchObject({ reason: "k5_denied" });
    await expect(request("/client/open", { method: "POST", body: { event: "foreground", document_id: "document-a" } })).resolves.toMatchObject({ status: 200 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("a refused request leaves no timer and nothing for the journal; the caller may try again later", async () => {
    vi.useFakeTimers();
    const { gate, fetcher, request } = setup();
    gate.closeByFailure();
    await expect(request("/commands", { method: "POST", body: { command_id: "x" } })).rejects.toMatchObject({ reason: "paused" });
    expect(vi.getTimerCount()).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("atomicity of L2 and fetch (AC-44)", () => {
  it("decides and calls fetch in one synchronous stretch: a gate closed in a microtask cannot stop a request already made", async () => {
    const { gate, fetcher, request } = setup();
    queueMicrotask(() => gate.closeByFailure());
    const sent = request("/commands", { method: "POST", body: { command_id: "x" } });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(sent).resolves.toMatchObject({ status: 200 });
    expect(gate.mayWrite()).toBe(false);
    await expect(request("/commands", { method: "POST", body: { command_id: "y" } })).rejects.toMatchObject({ reason: "paused" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("a request already in fetch when the gate closes is not cancelled (I2)", async () => {
    const { gate, request } = setup();
    let finish!: (response: Response) => void;
    const slow = createJsonTransport({ fetcher: (() => new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch,
      timeoutMs: 1_000, maxResponseBytes: 1_000, gate });
    const sent = slow("/commands", { method: "POST", body: { command_id: "x" } });
    gate.closeByFailure();
    finish(new Response('{"done":true}'));
    await expect(sent).resolves.toMatchObject({ value: { done: true } });
    await expect(request("/commands", { method: "POST", body: { command_id: "x" } })).rejects.toMatchObject({ reason: "paused" });
  });
});

describe("R6 in the transport (AC-48)", () => {
  it("a status read goes only through readback: the ticket never reaches the wire", async () => {
    const { gate, fetcher, request } = setup();
    await expect(gate.runReadback("A", ticket => request("/commands/A?expected_intent_hash=h", { method: "GET", token: "t", readbackTicket: ticket }))).resolves.toMatchObject({ status: 200 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/commands/A?expected_intent_hash=h");
    expect(JSON.stringify(init?.headers)).not.toContain("readback");
    expect(init?.body).toBeUndefined();
  });

  it("a readback of another ID than its path is refused", async () => {
    const { gate, fetcher, request } = setup();
    await expect(gate.runReadback("A", ticket => request("/commands/B", { method: "GET", token: "t", readbackTicket: ticket }))).rejects.toMatchObject({ reason: "no_ticket" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("under the identity lock the read waits for ВР-6, then goes at once", async () => {
    const { gate, fetcher, request } = setup();
    gate.noteOpened(DOC_A);
    gate.lockIdentity(DOC_A);
    const read = gate.runReadback("A", ticket => request("/commands/A", { method: "GET", token: "t", readbackTicket: ticket }));
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    gate.identityVerified(DOC_A);
    await expect(read).resolves.toMatchObject({ status: 200 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("AC-62: a production-built read without a ticket is PAUSED_BEFORE_SEND(no_ticket), not a network failure", async () => {
    const { request } = setup();
    const error = await request("/commands/A", { method: "GET", token: "t" }).catch(caught => caught);
    expect(error).toBeInstanceOf(PausedBeforeSendError);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(error.reason).toBe("no_ticket");
  });
});

describe("the availability probe goes through the same gate", () => {
  it("is read in a closed window by nobody: unknown, fetch not called", async () => {
    const { gate, fetcher } = setup();
    const client = createAvailabilityClient({ fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate });
    gate.closeWindow(DOC_A);
    expect(await client.probe()).toEqual({ status: "unknown" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("passes a closed net and opens it on ready (the probe is a GET, the only opener)", async () => {
    const clock = new ManualClock();
    const fetcher = vi.fn(async () => new Response('{"status":"ready","retry_after_s":null}'));
    const gate = new WriteGate({ clock });
    gate.attachProbe(createAvailabilityClient({ fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate }).probe);
    gate.closeByFailure();
    await clock.advanceTo(5_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(gate.snapshot().net).toEqual({ kind: "open" });
  });
});
