// M-P03-10 at the level of the write gate: п.8б (openAttempts, retryAfter403Doc), the stamps of §2 п.3 (noteDefinite,
// resolvePending with a stamp, the anchor of an episode with pending), the recovery foreground mark, R10 (the narrow
// readback of the own stop_remote) and ВР-12 (a transport failure during the round).
import { describe, expect, it, vi } from "vitest";
import { createJsonTransport } from "../api/http";
import { PausedBeforeSendError, WriteGate, type RequestStamp } from "./writeGate";
import { DOC_A, DOC_B, ManualClock, gateWith } from "./writeGate.test-support";
import { gateWait } from "./gateWait";

function transport(gate: WriteGate) {
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}'));
  const request = createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate });
  return { fetcher, request };
}
const open = (documentId: string, event: "open" | "foreground" = "open") => ({ event, document_id: documentId });
async function reason(promise: Promise<unknown>): Promise<string | null> {
  try { await promise; return null; } catch (error) { return error instanceof PausedBeforeSendError ? error.reason : String(error); }
}

describe("п.8б: a repeated event=\"open\" (openAttempts) and the one repeat after 403 (retryAfter403Doc)", () => {
  it("AC-99/AC-101 (iii): the first open of a document goes; its repeat is k5_denied whatever the origin and mayWrite", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    await request("/client/open", { method: "POST", body: open("doc-1"), origin: "auto" });
    expect(fetcher).toHaveBeenCalledOnce();
    for (const origin of ["user", "auto"] as const) {
      expect(await reason(request("/client/open", { method: "POST", body: open("doc-1"), origin }))).toBe("k5_denied");
    }
    expect(fetcher).toHaveBeenCalledOnce();
    expect(gate.snapshot().openAttempts).toEqual(["doc-1"]);
  });

  it("a first open refused as paused is an attempt too: its repeat after ready is k5_denied (AC-11i, T28l)", async () => {
    const { gate, clock } = gateWith([{ status: "ready" }]); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    gate.closeByFailure();
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-1") }))).toBe("paused");
    expect(gate.openAttempted("doc-1")).toBe(true);
    await clock.advanceTo(5_000); // the probe of the series says ready: mayWrite again
    expect(gate.mayWrite()).toBe(true);
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-1") }))).toBe("k5_denied");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("AC-101 (ii): with a document of reference any event=open is refused, even of a new document_id; foreground goes", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    gate.noteOpened(DOC_A);
    expect(await reason(request("/client/open", { method: "POST", body: open("never-tried") }))).toBe("k5_denied");
    await request("/client/open", { method: "POST", body: open(DOC_A.documentId, "foreground") });
    expect(fetcher).toHaveBeenCalledOnce();
    gate.noteAccessLost(); // unavailable keeps lastWorkingDoc: still refused (gateDoc ≠ null)
    expect(await reason(request("/client/open", { method: "POST", body: open("other") }))).toBe("k5_denied");
  });

  it("AC-104: after resetDocument (Z5, 401/403) a new document_id opens once; each one repeated is refused", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    await request("/client/open", { method: "POST", body: open("doc-1") });
    gate.noteOpened({ ...DOC_A, documentId: "doc-1" });
    gate.resetDocument();
    await request("/client/open", { method: "POST", body: open("doc-2") });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-1") }))).toBe("k5_denied");
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-2") }))).toBe("k5_denied");
    expect(gate.snapshot().openAttempts).toEqual(["doc-1", "doc-2"]);
  });

  it("AC-107/AC-108 (а): a definite 403 FORBIDDEN of the stamped open allows exactly one repeat, no new attempt record", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    let stamp: RequestStamp | null = null;
    await request("/client/open", { method: "POST", body: open("doc-1"), stamped: issued => { stamp = issued; } });
    expect(stamp).toMatchObject({ documentId: "doc-1" });
    expect(gate.noteForbiddenBeforeChange(stamp!)).toBe(true);
    await request("/client/open", { method: "POST", body: open("doc-1") });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(gate.retryAfter403Pending()).toBeNull();
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-1") }))).toBe("k5_denied");
    expect(gate.snapshot().openAttempts).toEqual(["doc-1"]);
  });

  it("AC-108 (г): a stamp of another request or document sets no allowance", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { request } = transport(gate);
    let stamp: RequestStamp | null = null;
    await request("/client/open", { method: "POST", body: open("doc-1"), stamped: issued => { stamp = issued; } });
    expect(gate.noteForbiddenBeforeChange({ ...stamp!, documentId: "doc-2" })).toBe(false);
    expect(gate.noteForbiddenBeforeChange({ requestId: "forged", documentId: "doc-1", episode: null })).toBe(false);
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-1") }))).toBe("k5_denied");
  });

  it("AC-108 (д): the allowance is spent by a repeat refused as paused; the next repeat is k5_denied", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    let stamp: RequestStamp | null = null;
    await request("/client/open", { method: "POST", body: open("doc-1"), stamped: issued => { stamp = issued; } });
    gate.noteForbiddenBeforeChange(stamp!);
    gate.extendHold(30);
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-1") }))).toBe("paused");
    expect(gate.retryAfter403Pending()).toBeNull();
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-1") }))).toBe("k5_denied");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("AC-108 (е): the allowance is dropped when the late registration fails; the repeat is k5_denied", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    let stamp: RequestStamp | null = null;
    await request("/client/open", { method: "POST", body: open("doc-9"), stamped: issued => { stamp = issued; } });
    gate.noteForbiddenBeforeChange(stamp!);
    gate.dropRetryAfter403();
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-9") }))).toBe("k5_denied");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("closed_window comes first: any open is closed_window, never k5_denied (§4.12)", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { request } = transport(gate);
    gate.closeWindow(DOC_A);
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-x") }))).toBe("closed_window");
    expect(await reason(request("/client/open", { method: "POST", body: open("doc-x", "foreground") }))).toBe("closed_window");
  });
});

describe("§2 п.3: stamps, noteDefinite and the anchor of an episode", () => {
  it("AC-95: a definite answer of the current request ends an episode without pending; a late older one does not", async () => {
    const { gate, clock } = gateWith(); gate.trackAccess();
    const { request } = transport(gate);
    let old: RequestStamp | null = null;
    await request("/today", { method: "GET", stamped: issued => { old = issued; } });
    gate.closeByFailure();
    const episode = gate.snapshot().episode!.id;
    expect(old!.episode).toBeNull();
    expect(gate.noteDefinite(old!)).toBe(false); // stamped outside this episode
    let current: RequestStamp | null = null;
    await request("/today", { method: "GET", stamped: issued => { current = issued; } });
    expect(current!.episode).toBe(episode);
    expect(gate.noteDefinite(current!)).toBe(true);
    expect(gate.snapshot().episode).toBeNull();
    await clock.advanceBy(1);
  });

  it("AC-77-like: begun with pending, only the definite readback of the anchor ends the episode", () => {
    const gate = new WriteGate({ clock: new ManualClock() });
    gate.registerPending("lane", "A"); gate.registerPending("settings", "B");
    gate.closeByFailure();
    const stamp = gate.stamp("/today");
    expect(gate.noteDefinite(stamp)).toBe(false); // not a readback: the anchor A is open
    gate.resolvePending("B", "recorded");
    expect(gate.snapshot().episode).not.toBeNull();
    gate.resolvePending("A", "stale"); // A locked: the anchor moves to … none unlocked; A stays the anchor
    expect(gate.snapshot().familyLocks).toEqual(["A"]);
    expect(gate.snapshot().episode).not.toBeNull();
    gate.resolvePending("A", "not_recorded");
    expect(gate.snapshot().episode).toBeNull();
  });

  it("AC-89: resolvePending with the stamp of an older episode changes nothing", () => {
    const gate = new WriteGate({ clock: new ManualClock() });
    gate.registerPending("lane", "A");
    const before = gate.stamp("/commands/A");
    gate.closeByFailure();
    gate.resolvePending("A", "stale", before);
    expect(gate.snapshot().familyLocks).toEqual([]);
    gate.resolvePending("A", "stale", gate.stamp("/commands/A"));
    expect(gate.snapshot().familyLocks).toEqual(["A"]);
  });
});

describe("the recovery foreground of the entry: one in flight, the anti-flapping mark, the check button", () => {
  it("a sent recovery foreground keeps checkButtonActive off and a show suppressed until 5 s from the mark", async () => {
    const clock = new ManualClock();
    const gate = new WriteGate({ clock });
    expect(gate.showForegroundAllowed()).toBe(true);
    gate.recoveryForegroundSent();
    expect(gate.checkButtonActive()).toBe(false);
    expect(gate.showForegroundAllowed()).toBe(false);
    gate.recoveryForegroundSettled();
    expect(gate.checkButtonActive()).toBe(true);
    await clock.advanceTo(4_999);
    expect(gate.showForegroundAllowed()).toBe(false);
    await clock.advanceTo(5_000);
    expect(gate.showForegroundAllowed()).toBe(true);
    expect(gate.snapshot().lastRecoveryForegroundSentAt).toBe(0);
  });

  it("an ended episode drops the mark (the next show is the first of a new episode)", () => {
    const gate = new WriteGate({ clock: new ManualClock() });
    gate.closeByFailure(); gate.recoveryForegroundSent(); gate.recoveryForegroundSettled();
    gate.finishEpisode();
    expect(gate.snapshot().lastRecoveryForegroundSentAt).toBeNull();
    expect(gate.showForegroundAllowed()).toBe(true);
  });
});

describe("ВР-12: a transport failure while the round of readbacks runs sends the lock back to verifying (Z3)", () => {
  it("the round is kept, and the next identity check starts it again", () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    gate.noteOpened(DOC_A); gate.registerPending("lane", "A");
    gate.lockIdentity(DOC_A); gate.identityVerified(DOC_A);
    expect(gate.snapshot().identityLock).toMatchObject({ phase: "readback", round: ["A"] });
    gate.closeByFailure("unknown"); // a projection (no command): the round goes on (fix1, QA-V1)
    expect(gate.snapshot().identityLock).toMatchObject({ phase: "readback", round: ["A"] });
    gate.closeByMaintenance(null, "other"); // a command outside the round: the same
    expect(gate.snapshot().identityLock).toMatchObject({ phase: "readback" });
    gate.closeByFailure("unknown", "A"); // the readback of a task of the round broke: Z3 transport
    expect(gate.snapshot().identityLock).toMatchObject({ phase: "verifying", round: ["A"] });
    expect(gate.mayWrite("B")).toBe(false);
  });
});

describe("§4.8 by cause (gateWait): the wait a screen names", () => {
  it("maintenance with the remaining hold, 0 once it passed; offline; checking under a lock with pending", async () => {
    const clock = new ManualClock();
    const gate = new WriteGate({ clock });
    gate.closeByMaintenance(40);
    expect(gateWait(gate)).toEqual({ cause: "maintenance", waitSeconds: 40 });
    await clock.advanceTo(15_500);
    expect(gateWait(gate)).toEqual({ cause: "maintenance", waitSeconds: 25 });
    await clock.advanceTo(41_000);
    expect(gateWait(gate)).toEqual({ cause: "maintenance", waitSeconds: 0 });
    const other = new WriteGate({ clock: new ManualClock() });
    other.closeByFailure();
    expect(gateWait(other)).toEqual({ cause: "offline" });
    const locked = new WriteGate({ clock: new ManualClock() }); locked.trackAccess();
    locked.noteOpened(DOC_A); locked.lockIdentity(DOC_A);
    expect(gateWait(locked)).toEqual({ cause: "offline" });
    expect(gateWait(locked, { pending: true })).toEqual({ cause: "checking" });
    expect(gateWait(new WriteGate({ clock: new ManualClock() }))).toBeNull();
  });
});

describe("R10: the readback of the own stop_remote in busy/remote without opened", () => {
  const STOP = "stop-1";
  const path = `/commands/${STOP}?client_instance_id=c&document_id=d`;
  function busy() {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    gate.registerPending("stop_remote", STOP);
    const context = gate.openRemoteReadContext()!;
    return { gate, fetcher, request, context };
  }

  it("AC-111: the narrow ticket reads the own stop without opened; the ordinary readback still waits for opened", async () => {
    const { gate, fetcher, request, context } = busy();
    expect(context).not.toBeNull();
    await gate.runRemoteReadback(context, STOP, ticket => request(path, { method: "GET", readbackTicket: ticket }));
    expect(fetcher).toHaveBeenCalledOnce();
    let ordinary = false;
    void gate.runReadback(STOP, async () => { ordinary = true; });
    await Promise.resolve();
    expect(ordinary).toBe(false); // R2: no live opened
  });

  it("AC-113: another family, an unregistered or a settled ID get no ticket — zero transfers", async () => {
    const { gate, fetcher, request, context } = busy();
    gate.registerPending("settings", "other");
    for (const id of ["other", "unknown"]) {
      expect(await reason(gate.runRemoteReadback(context, id, ticket => request(`/commands/${id}`, { method: "GET", readbackTicket: ticket }))))
        .toBe("no_ticket");
    }
    gate.resolvePending(STOP, "not_recorded");
    expect(await reason(gate.runRemoteReadback(context, STOP, ticket => request(path, { method: "GET", readbackTicket: ticket }))))
      .toBe("no_ticket");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("AC-114: the ticket is single-use and opens no POST", async () => {
    const { gate, fetcher, request, context } = busy();
    let kept: Parameters<Parameters<WriteGate["runRemoteReadback"]>[2]>[0] | null = null;
    await gate.runRemoteReadback(context, STOP, async ticket => {
      kept = ticket;
      await request(path, { method: "GET", readbackTicket: ticket });
      expect(await reason(request(path, { method: "GET", readbackTicket: ticket }))).toBe("no_ticket");
    });
    expect(await reason(request(path, { method: "GET", readbackTicket: kept! }))).toBe("no_ticket");
    gate.closeByFailure();
    expect(await reason(request("/commands", { method: "POST", readbackTicket: kept!, body: { command_id: STOP } }))).toBe("paused");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("AC-115: no context with a working document, an identity lock or a closed window", () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    gate.noteOpened(DOC_A); gate.noteAccessLost();
    expect(gate.openRemoteReadContext()).toBeNull();
    const locked = new WriteGate({ clock: new ManualClock() }); locked.trackAccess();
    locked.lockIdentity(DOC_B);
    expect(locked.openRemoteReadContext()).toBeNull();
    const closed = new WriteGate({ clock: new ManualClock() }); closed.closeWindow(null);
    expect(closed.openRemoteReadContext()).toBeNull();
  });

  it.each([
    ["unavailable (noteAccessLost)", (gate: WriteGate) => gate.noteAccessLost()],
    ["a changed identity (resetDocument)", (gate: WriteGate) => gate.resetDocument()],
    ["the owner going away (unregisterPending)", (gate: WriteGate) => gate.unregisterPending(STOP)],
    ["a new context", (gate: WriteGate) => { gate.openRemoteReadContext(); }],
  ])("AC-116: %s voids the context: a waiting GET is cancelled, the pending stays", async (_name, change) => {
    const { gate, fetcher, request, context } = busy();
    gate.setVisible(false);
    const waiting = gate.runRemoteReadback(context, STOP, ticket => request(path, { method: "GET", readbackTicket: ticket }));
    change(gate);
    gate.setVisible(true);
    expect(await reason(waiting)).toBe("cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("AC-112: the UI step busy → remote_confirm → remote keeps the context (keepRemote)", async () => {
    const { gate, fetcher, request, context } = busy();
    gate.noteAccessLost({ keepRemote: true });
    await gate.runRemoteReadback(context, STOP, ticket => request(path, { method: "GET", readbackTicket: ticket }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(gate.remoteReadContextLive(context)).toBe(true);
  });

  it("AC-119: a hidden window starts no GET of the stop; shown, it goes", async () => {
    const { gate, fetcher, request, context } = busy();
    gate.setVisible(false);
    const read = gate.runRemoteReadback(context, STOP, ticket => request(path, { method: "GET", readbackTicket: ticket }));
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    gate.setVisible(true);
    await read;
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("AC-117: a closed window refuses everything; ready does not lift it", async () => {
    const { gate, fetcher, request, context } = busy();
    gate.closeWindow(null);
    expect(await reason(gate.runRemoteReadback(context, STOP, ticket => request(path, { method: "GET", readbackTicket: ticket }))))
      .toBe("closed_window");
    expect(gate.remoteReadContextLive(context)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("fix1: the anchor of an episode is the command whose request failed (§2 п.1; QA-G1/G2/G4)", () => {
  it.each([["A", "B"], ["B", "A"]])("registered %s first, the request of %s failed: only its definite readback ends the episode", (first, failed) => {
    const gate = new WriteGate({ clock: new ManualClock() });
    gate.registerPending("lane", first); gate.registerPending("settings", first === "A" ? "B" : "A");
    gate.closeByFailure("unknown", failed);
    const episode = gate.snapshot().episode!.id;
    const other = failed === "A" ? "B" : "A";
    gate.resolvePending(other, "recorded");
    expect(gate.snapshot().episode?.id).toBe(episode);
    gate.resolvePending(failed, "not_recorded");
    expect(gate.snapshot().episode).toBeNull();
  });

  it("the same episode goes on with the next index after the other command's answer (not back to 5 s)", async () => {
    const { gate, clock } = gateWith();
    gate.registerPending("lane", "A"); gate.registerPending("settings", "B");
    gate.closeByFailure("unknown", "B");
    await clock.advanceTo(5_000); await clock.advanceTo(15_000);
    const index = gate.snapshot().episode!.index;
    gate.resolvePending("A", "recorded");
    gate.closeByFailure("unknown", "B");
    expect(gate.snapshot().episode!.index).toBe(index + 1);
  });

  it("a failed projection or foreground anchors the first registered command; a family-locked anchor hands over (AC-77)", () => {
    const gate = new WriteGate({ clock: new ManualClock() });
    gate.registerPending("lane", "A"); gate.registerPending("settings", "B");
    gate.closeByFailure("unknown"); // GET /today broke: no command of its own
    gate.resolvePending("A", "stale"); // A family-locked: the anchor becomes B
    expect(gate.snapshot().familyLocks).toEqual(["A"]);
    expect(gate.snapshot().episode).not.toBeNull();
    gate.resolvePending("B", "recorded");
    expect(gate.snapshot().episode).toBeNull();
    expect(gate.snapshot().familyLocks).toEqual(["A"]);
  });

  it("the transport names the failed command: POST /commands and GET /commands/{id} anchor the episode", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess(); gate.noteOpened(DOC_A);
    const fetcher = vi.fn(async () => { throw new TypeError("network"); });
    const request = createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate });
    gate.registerPending("lane", "A"); gate.registerPending("settings", "B");
    await request("/commands", { method: "POST", body: { command_id: "B", kind: "x" } }).catch(() => undefined);
    gate.resolvePending("A", "recorded");
    expect(gate.snapshot().episode).not.toBeNull();
    gate.resolvePending("B", "recorded");
    expect(gate.snapshot().episode).toBeNull();
    gate.registerPending("lane", "C"); gate.registerPending("lane", "D");
    await gate.runReadback("D", ticket => request("/commands/D", { method: "GET", readbackTicket: ticket })).catch(() => undefined);
    gate.resolvePending("C", "recorded");
    expect(gate.snapshot().episode).not.toBeNull();
  });
});

describe("fix1: the observer, the hidden round, the allowance and the hold timer", () => {
  it("QA-E1: an unreadable 2xx on the entry's foreground closes net (K-11 transport class); on another request it does not (RD-2)", async () => {
    for (const [body, closes] of [[{ event: "foreground", document_id: "d" }, true], [{ event: "open", document_id: "d2" }, false]] as const) {
      const gate = new WriteGate({ clock: new ManualClock() });
      const fetcher = vi.fn(async () => new Response("<html>proxy</html>", { status: 200 }));
      const request = createJsonTransport({ fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate });
      await request("/client/open", { method: "POST", body }).catch(() => undefined);
      expect(gate.snapshot().net.kind).toBe(closes ? "closed" : "open");
    }
  });

  it("AC-11b (QA-N3a): the round after ВР-6 is not read in a hidden window; the show starts it", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess(); gate.noteOpened(DOC_A);
    gate.registerPending("lane", "A"); gate.lockIdentity(DOC_A);
    const read = vi.fn(async () => "read");
    const job = gate.runReadback("A", read);
    gate.setVisible(false);
    gate.identityVerified(DOC_A);
    await Promise.resolve();
    expect(read).not.toHaveBeenCalled();
    gate.setVisible(true);
    await expect(job).resolves.toBe("read");
  });

  it("X04: resetDocument (Z5) drops the allowance of the 403 repeat", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { request } = transport(gate);
    let stamp: RequestStamp | null = null;
    await request("/client/open", { method: "POST", body: open("doc-1"), stamped: issued => { stamp = issued; } });
    gate.noteForbiddenBeforeChange(stamp!);
    gate.resetDocument();
    expect(gate.retryAfter403Pending()).toBeNull();
  });

  it("X05 (AC-113 «изменённый pending»): a stop re-registered while its GET waits loses the ticket — zero transfers", async () => {
    const gate = new WriteGate({ clock: new ManualClock() }); gate.trackAccess();
    const { fetcher, request } = transport(gate);
    gate.registerPending("stop_remote", "S");
    const context = gate.openRemoteReadContext()!;
    const result = await gate.runRemoteReadback(context, "S", async ticket => {
      gate.registerPending("stop_remote", "S"); // the owner held its record again (a new registration)
      return reason(request("/commands/S", { method: "GET", readbackTicket: ticket }));
    });
    expect(result).toBe("no_ticket");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("X09: a hold timer that fires a moment early waits for the rest; the subscribers are told once it really ended", async () => {
    const manual = new ManualClock();
    const early = { now: () => manual.now(), cancel: manual.cancel.bind(manual),
      schedule: (callback: () => void, delay: number) => manual.schedule(callback, delay > 1 ? delay - 1 : delay) };
    const gate = new WriteGate({ clock: early });
    const seen: boolean[] = [];
    gate.extendHold(30);
    gate.subscribe(() => seen.push(gate.mayWrite()));
    await manual.advanceTo(31_000);
    expect(seen.at(-1)).toBe(true);
  });
});
