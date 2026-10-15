import { describe, expect, it, vi } from "vitest";
import { PausedBeforeSendError, WriteGate, type ReadbackTicket } from "./writeGate";
import { DOC_A, DOC_B, gateWith, ManualClock, settle } from "./writeGate.test-support";

const S = 1_000;
const statusRead = (id: string, ticket?: ReadbackTicket) => ({ method: "GET", path: `/commands/${id}?x=1`, readbackTicket: ticket });

describe("write gate: the single predicate (§2)", () => {
  it("is open on a page without the outage mark; every closing part shuts it on its own", async () => {
    const { gate, clock } = gateWith();
    expect(gate.mayWrite()).toBe(true);
    expect(gate.snapshot()).toMatchObject({ net: { kind: "open" }, holdUntil: null, identityLock: null, closedWindow: null, episode: null });
    gate.extendHold(3);
    expect(gate.mayWrite()).toBe(false);
    await clock.advanceTo(3 * S);
    expect(gate.mayWrite()).toBe(true);
    gate.resolvePending("A", "stale");
    expect(gate.mayWrite("A")).toBe(false);
    expect(gate.mayWrite("B")).toBe(true);
    gate.closeByFailure();
    expect(gate.mayWrite("B")).toBe(false);
  });

  it("starts closed(unknown) with the outage mark and its announced hold; the first probe comes after 5 s", async () => {
    const { gate, clock, calls } = gateWith([{ status: "ready" }], { outage: { retryAfterS: 40 } });
    expect(gate.snapshot()).toMatchObject({ net: { kind: "closed", cause: "unknown" }, holdUntil: 40 * S });
    await clock.advanceTo(5 * S);
    expect(calls).toEqual([5 * S]);
    expect(gate.snapshot().net).toEqual({ kind: "open" });
    expect(gate.mayWrite()).toBe(false);
    await clock.advanceTo(40 * S);
    expect(gate.mayWrite()).toBe(true);
  });
});

describe("write gate: the series of probes (§2, §4.4)", () => {
  it("AC-03: a pause of 90 s from a loss at 0 s probes at 5, 15, 35, 65, 95 s and no sooner", async () => {
    const { gate, clock, calls } = gateWith(Array.from({ length: 5 }, () => ({ status: "maintenance" as const, retryAfterS: null, anomaly: false })));
    gate.closeByFailure();
    await clock.advanceTo(100 * S);
    expect(calls).toEqual([5, 15, 35, 65, 95].map(t => t * S));
    expect(gate.mayWrite()).toBe(false);
  });

  it("AC-04: an unknown or refused availability keeps the gate closed", async () => {
    const { gate, clock } = gateWith([{ status: "unknown" }, { status: "unavailable", retryAfterS: null, anomaly: false }]);
    gate.closeByFailure();
    await clock.advanceTo(15 * S);
    expect(gate.snapshot().net).toEqual({ kind: "closed", cause: "unavailable" });
    expect(gate.mayWrite()).toBe(false);
  });

  it("AC-59/AC-64: a failure right after each ready is the same episode: 5, 15, 35, 65, 95, then every 30 s", async () => {
    const { gate, clock, calls } = gateWith(Array.from({ length: 8 }, () => ({ status: "ready" as const })));
    gate.subscribe(event => { if (event.type === "ready") gate.closeByFailure(); });
    gate.closeByFailure();
    const episode = gate.snapshot().episode?.id;
    await clock.advanceTo(200 * S);
    expect(calls).toEqual([5, 15, 35, 65, 95, 125, 155, 185].map(t => t * S));
    expect(gate.snapshot().episode?.id).toBe(episode);
  });

  it("AC-12: after the episode ends a new failure starts again at 5 s", async () => {
    const { gate, clock, calls } = gateWith([{ status: "ready" }, { status: "ready" }]);
    gate.subscribe(event => { if (event.type === "ready" && calls.length === 1) gate.closeByFailure(); });
    gate.closeByFailure();
    await clock.advanceTo(15 * S);
    expect(calls).toEqual([5 * S, 15 * S]);
    gate.finishEpisode();
    expect(gate.snapshot()).toMatchObject({ episode: null, probeScheduled: false });
    await clock.advanceTo(100 * S);
    gate.closeByFailure();
    await clock.advanceTo(106 * S);
    expect(calls).toEqual([5 * S, 15 * S, 105 * S]);
  });

  it("AC-67: the next interval counts from the end of a probe that ran into its timeout", async () => {
    const { gate, clock, calls } = gateWith([{ status: "slow", afterMs: 7 * S, then: { status: "unknown" } }, { status: "ready" }]);
    gate.closeByFailure();
    await clock.advanceTo(40 * S);
    expect(calls).toEqual([5 * S, (5 + 7 + 10) * S]);
  });

  it("AC-15: one probe of the page in flight, whoever asks", async () => {
    const { gate, clock, calls } = gateWith([{ status: "ready" }, { status: "slow", afterMs: 2 * S, then: { status: "ready" } }]);
    gate.closeByFailure();
    await clock.advanceTo(5 * S);
    await clock.advanceTo(30 * S);
    const first = gate.ensureFresh(), second = gate.ensureFresh();
    expect(gate.snapshot().probeInFlight).toBe(true);
    await clock.advanceBy(2 * S);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls).toEqual([5 * S, 30 * S]);
  });

  it("stops in the background and restarts at 5 s when shown again (Q35.3); a probe in flight is not cancelled", async () => {
    const { gate, clock, calls } = gateWith([{ status: "unknown" }, { status: "unknown" }, { status: "unknown" }]);
    gate.closeByFailure();
    await clock.advanceTo(5 * S);
    gate.setVisible(false);
    await clock.advanceTo(600 * S);
    expect(calls).toEqual([5 * S]);
    expect(clock.pending()).toBe(0);
    gate.setVisible(true);
    expect(gate.snapshot().seriesIndex).toBe(1);
    await clock.advanceTo(616 * S);
    expect(calls).toEqual([5 * S, 605 * S, 615 * S]);
  });

  it("does not probe while nothing waits: open net without an episode", async () => {
    const { gate, clock, calls } = gateWith();
    gate.setVisible(false); gate.setVisible(true);
    await clock.advanceTo(60 * S);
    expect(calls).toEqual([]);
  });
});

describe("write gate: send_hold and the fresh probe (§3.5, §4.4, R-12)", () => {
  it("AC-05: retry_after_s=40, ready at 15 s: no write before 40 s; at 40 s a fresh probe first", async () => {
    const { gate, clock, calls } = gateWith([{ status: "unknown" }, { status: "ready" }, { status: "ready" }]);
    gate.closeByMaintenance(40);
    await clock.advanceTo(15 * S);
    expect(calls).toEqual([5 * S, 15 * S]);
    expect(gate.snapshot().net).toEqual({ kind: "open" });
    expect(gate.mayWrite()).toBe(false);
    expect(await gate.ensureFresh()).toBe(false);
    await clock.advanceTo(40 * S);
    expect(gate.mayWrite()).toBe(true);
    expect(await gate.ensureFresh()).toBe(true);
    expect(calls).toEqual([5 * S, 15 * S, 40 * S]);
  });

  it("AC-05b/T15a: a later shorter estimate and a later ready never shorten the hold", async () => {
    const { gate, clock } = gateWith([{ status: "ready" }]);
    gate.closeByMaintenance(600);
    gate.extendHold(60);
    await clock.advanceTo(5 * S);
    expect(gate.snapshot()).toMatchObject({ net: { kind: "open" }, holdUntil: 600 * S });
    await clock.advanceTo(599 * S);
    expect(gate.mayWrite()).toBe(false);
    await clock.advanceTo(600 * S);
    expect(gate.mayWrite()).toBe(true);
  });

  it("a fresh ready (≤10 s) needs no new probe; a gate that never closed needs none either", async () => {
    const { gate, clock, calls } = gateWith([{ status: "ready" }]);
    expect(await gate.ensureFresh()).toBe(true);
    gate.closeByFailure();
    await clock.advanceTo(5 * S);
    await clock.advanceTo(15 * S);
    expect(await gate.ensureFresh()).toBe(true);
    expect(calls).toEqual([5 * S]);
  });

  it("AC-109 (а): the fresh probe says maintenance 300: closed, hold to 340 s, next probe at 60 s (index i+1), then one more fresh probe at 340 s", async () => {
    const { gate, clock, calls } = gateWith([
      { status: "unknown" }, { status: "ready" },
      { status: "maintenance", retryAfterS: 300, anomaly: false }, { status: "ready" }, { status: "ready" },
    ]);
    gate.closeByMaintenance(40);
    await clock.advanceTo(40 * S);
    const episode = gate.snapshot().episode;
    expect(await gate.ensureFresh()).toBe(false);
    expect(gate.snapshot()).toMatchObject({ net: { kind: "closed", cause: "maintenance" }, holdUntil: 340 * S, episode });
    await clock.advanceTo(59_999);
    expect(calls).toEqual([5 * S, 15 * S, 40 * S]);
    await clock.advanceTo(60 * S);
    expect(calls).toEqual([5 * S, 15 * S, 40 * S, 60 * S]);
    expect(gate.snapshot().net).toEqual({ kind: "open" });
    expect(gate.mayWrite()).toBe(false);
    await clock.advanceTo(340 * S);
    expect(await gate.ensureFresh()).toBe(true);
    expect(calls).toEqual([5 * S, 15 * S, 40 * S, 60 * S, 340 * S]);
  });

  it.each([
    ["(б) a refused fetch", { status: "unknown" as const }, 0, "unknown"],
    ["(б) a timeout τ=7 s", { status: "slow" as const, afterMs: 7 * S, then: { status: "unknown" as const } }, 7 * S, "unknown"],
    ["(в) unavailable without estimate", { status: "unavailable" as const, retryAfterS: null, anomaly: false }, 0, "unavailable"],
  ])("AC-109 %s: closed, the hold unchanged, the next probe 20 s after the end of the fresh one", async (_name, fresh, tau, cause) => {
    const { gate, clock, calls } = gateWith([{ status: "unknown" }, { status: "ready" }, fresh, { status: "ready" }]);
    gate.closeByMaintenance(40);
    await clock.advanceTo(40 * S);
    const answer = gate.ensureFresh();
    await clock.advanceBy(tau);
    expect(await answer).toBe(false);
    expect(gate.snapshot()).toMatchObject({ net: { kind: "closed", cause }, holdUntil: 40 * S });
    await clock.advanceTo(40 * S + tau + 20 * S - 1);
    expect(calls).toHaveLength(3);
    await clock.advanceTo(40 * S + tau + 20 * S);
    expect(calls[3]).toBe(40 * S + tau + 20 * S);
    expect(gate.mayWrite()).toBe(true);
    expect(await gate.ensureFresh()).toBe(true);
    expect(calls).toHaveLength(4);
  });
});

describe("write gate: the identity lock, familyLocks and the registry (§4.11)", () => {
  function opened() {
    const setup = gateWith();
    setup.gate.noteOpened(DOC_A);
    return setup;
  }

  it("Z1/Z2/Z4: the lock shuts writes even with net open; the identity check and an empty round lift it", () => {
    const { gate } = opened();
    gate.lockIdentity(DOC_A);
    expect(gate.mayWrite()).toBe(false);
    gate.identityVerified(DOC_A);
    expect(gate.snapshot().identityLock).toBeNull();
    expect(gate.mayWrite()).toBe(true);
  });

  it("AC-53: Z4 with familyLocks={A}: B goes, A waits for its definite readback", () => {
    const { gate } = opened();
    gate.registerPending("settings", "A");
    gate.lockIdentity(DOC_A);
    gate.identityVerified(DOC_A);
    expect(gate.snapshot().identityLock).toMatchObject({ phase: "readback", round: ["A"] });
    gate.resolvePending("A", "stale");
    expect(gate.snapshot()).toMatchObject({ identityLock: null, familyLocks: ["A"] });
    expect(gate.mayWrite("B")).toBe(true);
    expect(gate.mayWrite("A")).toBe(false);
    gate.resolvePending("A", "recorded");
    expect(gate.mayWrite("A")).toBe(true);
  });

  it("AC-38: three owners (not_recorded, stale, recorded): the lock goes after all three, only the stale ID stays locked", () => {
    const { gate } = opened();
    for (const [family, id] of [["written", "W"], ["settings", "S"], ["field", "F"]]) gate.registerPending(family, id);
    gate.lockIdentity(DOC_A);
    gate.identityVerified(DOC_A);
    gate.resolvePending("W", "not_recorded");
    gate.resolvePending("S", "stale");
    expect(gate.snapshot().identityLock).not.toBeNull();
    gate.resolvePending("F", "recorded");
    expect(gate.snapshot()).toMatchObject({ identityLock: null, familyLocks: ["S"] });
    expect(gate.mayWrite("S2")).toBe(true);
    expect(gate.mayWrite("W")).toBe(true);
    expect(gate.mayWrite("S")).toBe(false);
  });

  it("AC-49/AC-56: an owner unmounted in the round: its ID is locked, its deferred readback cancelled, the lock goes after the rest", async () => {
    const { gate } = opened();
    gate.registerPending("settings", "A");
    gate.registerPending("field", "B");
    gate.lockIdentity(DOC_A);
    const read = vi.fn(async () => "read");
    const deferred = gate.runReadback("A", read);
    gate.unregisterPending("A");
    await expect(deferred).rejects.toMatchObject({ reason: "cancelled" });
    expect(read).not.toHaveBeenCalled();
    gate.identityVerified(DOC_A);
    expect(gate.snapshot().identityLock).toMatchObject({ round: ["B"] });
    gate.resolvePending("B", "recorded");
    expect(gate.snapshot()).toMatchObject({ identityLock: null, familyLocks: ["A"] });
    expect(gate.mayWrite("A")).toBe(false);
  });

  it("AC-50: a late registration joins the current round; after Z4 it is ordinary", () => {
    const { gate } = opened();
    gate.lockIdentity(DOC_A);
    gate.registerPending("card", "late");
    gate.identityVerified(DOC_A);
    expect(gate.snapshot().identityLock?.round).toEqual(["late"]);
    gate.resolvePending("late", "recorded");
    gate.registerPending("card", "after");
    expect(gate.snapshot().identityLock).toBeNull();
    expect(gate.mayWrite("after")).toBe(true);
  });

  it("AC-52: an impossible check locks the ID at once and does not hold the lock", () => {
    const { gate } = opened();
    gate.registerPending("settings", "A");
    gate.lockIdentity(DOC_A);
    gate.identityVerified(DOC_A);
    gate.resolvePending("A", "storage");
    expect(gate.snapshot()).toMatchObject({ identityLock: null, familyLocks: ["A"] });
  });

  it("Z3 transport: back to verifying with the round kept; new readbacks wait again", async () => {
    const { gate } = opened();
    gate.registerPending("written", "A");
    gate.lockIdentity(DOC_A);
    gate.identityVerified(DOC_A);
    gate.readbackInterrupted();
    expect(gate.snapshot().identityLock).toMatchObject({ phase: "verifying", round: ["A"] });
    const read = vi.fn(async () => "ok");
    const pending = gate.runReadback("A", read);
    await settle();
    expect(read).not.toHaveBeenCalled();
    gate.identityVerified(DOC_A);
    expect(await pending).toBe("ok");
  });

  it.each([
    ["Z5 resetInvalidSession", (gate: WriteGate) => gate.resetDocument()],
    ["Z5′ closed window", (gate: WriteGate) => gate.closeWindow(DOC_A)],
    ["dispose", (gate: WriteGate) => gate.dispose()],
    ["Z5 another opened document", (gate: WriteGate) => gate.noteOpened(DOC_B)],
  ])("AC-55/AC-63: %s cancels deferred readbacks and clears locks and registrations", async (_name, drop) => {
    const { gate } = opened();
    gate.registerPending("settings", "A");
    gate.resolvePending("X", "stale");
    gate.lockIdentity(DOC_A);
    const read = vi.fn(async () => "never");
    const deferred = gate.runReadback("A", read);
    drop(gate);
    await expect(deferred).rejects.toBeInstanceOf(PausedBeforeSendError);
    await expect(deferred).rejects.toMatchObject({ reason: "cancelled" });
    expect(read).not.toHaveBeenCalled();
    expect(gate.snapshot()).toMatchObject({ identityLock: null, familyLocks: [] });
    expect(gate.hasUnsettledPending()).toBe(false);
  });
});

describe("write gate: readback tickets (R2, R6)", () => {
  it("AC-48: without the lock a ticket is given at once, spent once, for that ID only", async () => {
    const { gate } = gateWith();
    const seen: ReadbackTicket[] = [];
    await gate.runReadback("A", async ticket => {
      seen.push(ticket);
      expect(gate.admit(statusRead("B", ticket))).toBe("no_ticket");
      expect(gate.admit(statusRead("A", ticket))).toBeNull();
      expect(gate.admit(statusRead("A", ticket))).toBe("no_ticket");
    });
    expect(gate.admit(statusRead("A"))).toBe("no_ticket");
    expect(gate.admit(statusRead("A", { readbackTicket: true }))).toBe("no_ticket");
    expect(seen).toHaveLength(1);
  });

  it("AC-48: a ticket dies with its readback", async () => {
    const { gate } = gateWith();
    let kept: ReadbackTicket | undefined;
    await gate.runReadback("A", async ticket => { kept = ticket; });
    expect(gate.admit(statusRead("A", kept))).toBe("no_ticket");
  });

  it("AC-48/T36: under the lock in verifying readbacks wait for ВР-6 and then start in the order asked", async () => {
    const { gate } = gateWith();
    gate.noteOpened(DOC_A);
    gate.lockIdentity(DOC_A);
    const order: string[] = [];
    const first = gate.runReadback("A", async ticket => { order.push("A"); return gate.admit(statusRead("A", ticket)); });
    const second = gate.runReadback("B", async ticket => { order.push("B"); return gate.admit(statusRead("B", ticket)); });
    await settle();
    expect(order).toEqual([]);
    gate.identityVerified(DOC_A);
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    expect(order).toEqual(["A", "B"]);
  });

  it("R2: no live opened (unavailable) gives no ticket until the next confirmed opened; tickets in hand are void", async () => {
    const { gate } = gateWith();
    gate.noteOpened(DOC_A);
    let inHand: ReadbackTicket | undefined;
    const held = gate.runReadback("A", async ticket => { inHand = ticket; await new Promise(resolve => setTimeout(resolve, 0)); });
    gate.noteAccessLost();
    expect(gate.admit(statusRead("A", inHand))).toBe("no_ticket");
    await held;
    const read = vi.fn(async () => "ok");
    const waiting = gate.runReadback("B", read);
    await settle();
    expect(read).not.toHaveBeenCalled();
    gate.noteOpened(DOC_A);
    expect(await waiting).toBe("ok");
  });
});

describe("write gate: the closed window is terminal (AC-47, §4.12)", () => {
  it("refuses every request of any method, stops the probes and ignores ready, the series, showing and late answers", async () => {
    const { gate, clock, calls } = gateWith([{ status: "slow", afterMs: 3 * S, then: { status: "ready" } }]);
    gate.noteOpened(DOC_A);
    gate.closeByFailure();
    await clock.advanceTo(5 * S);
    expect(gate.snapshot().probeInFlight).toBe(true);
    gate.closeWindow(DOC_A);
    for (const request of [
      { method: "POST", path: "/auth/telegram", body: {} },
      { method: "POST", path: "/client/register", body: {} },
      { method: "POST", path: "/client/open", body: { event: "foreground", document_id: "document-a" } },
      { method: "POST", path: "/client/open", body: { event: "open", document_id: "document-a" } },
      { method: "POST", path: "/client/window-return", body: {} },
      { method: "POST", path: "/commands", body: { kind: "session.stop_remote", command_id: "S" } },
      { method: "POST", path: "/access/reapply", body: {} },
      { method: "GET", path: "/today" },
      { method: "GET", path: "/availability" },
      statusRead("A"),
    ]) expect(gate.admit(request)).toBe("closed_window");
    await expect(gate.runReadback("A", async () => "x")).rejects.toMatchObject({ reason: "closed_window" });
    await clock.advanceTo(60 * S);
    gate.setVisible(false); gate.setVisible(true);
    gate.closeByFailure(); gate.closeByMaintenance(5); gate.noteOpened(DOC_A);
    await clock.advanceTo(600 * S);
    expect(calls).toEqual([5 * S]);
    expect(gate.snapshot()).toMatchObject({ closedWindow: { doc: DOC_A }, net: { kind: "closed" }, probeScheduled: false });
    expect(await gate.ensureFresh()).toBe(false);
    expect(new WriteGate({ clock: new ManualClock() }).snapshot().closedWindow).toBeNull();
  });
});

describe("write gate: subscriptions", () => {
  it("tells ready once per opening and survives a throwing subscriber", async () => {
    const { gate, clock } = gateWith([{ status: "ready" }]);
    const events: string[] = [];
    gate.subscribe(() => { throw new Error("subscriber"); });
    const off = gate.subscribe(event => events.push(event.type));
    gate.closeByFailure();
    await clock.advanceTo(5 * S);
    expect(events.filter(type => type === "ready")).toHaveLength(1);
    off();
    gate.closeByFailure();
    expect(events.filter(type => type === "ready")).toHaveLength(1);
  });
});

describe("write gate: gaps found by QA (M3-FIX r2)", () => {
  it("AC-109 with an open episode: the negative fresh probe neither ends nor restarts the episode; the next probe is i+1", async () => {
    // A transport failure opens the episode at index 1; a 503 MAINTENANCE inside the same episode moves the series on to
    // index 2 (§2 «Тот же эпизод») and announces a hold of 45 s; the probe at 10 s says unknown, the one at 30 s ready (i=3).
    const { gate, clock, calls } = gateWith([
      { status: "unknown" }, { status: "ready" },
      { status: "maintenance", retryAfterS: 300, anomaly: false }, { status: "ready" },
    ]);
    gate.closeByFailure();
    const episode = gate.snapshot().episode!;
    expect(episode.index).toBe(1);
    gate.closeByMaintenance(45);
    expect(gate.snapshot().episode).toEqual({ id: episode.id, index: 2 });
    await clock.advanceTo(45 * S);
    expect(calls).toEqual([10 * S, 30 * S]);
    const before = gate.snapshot().episode!;
    expect(before).toEqual({ id: episode.id, index: 3 });
    expect(await gate.ensureFresh()).toBe(false);
    // The same episode, the next index (i+1 = 4): 30 s from the end of the fresh probe at 45 s.
    expect(gate.snapshot()).toMatchObject({ net: { kind: "closed", cause: "maintenance" }, holdUntil: 345 * S,
      episode: { id: episode.id, index: 4 } });
    await clock.advanceTo(74_999);
    expect(calls).toEqual([10 * S, 30 * S, 45 * S]);
    await clock.advanceTo(75 * S);
    expect(calls).toEqual([10 * S, 30 * S, 45 * S, 75 * S]);
    expect(gate.snapshot().episode?.id).toBe(episode.id);
  });

  it("Q12: a 503 MAINTENANCE inside an episode continues it with the next index from that moment", async () => {
    const { gate, clock, calls } = gateWith([{ status: "unknown" }, { status: "unknown" }]);
    gate.closeByFailure();
    await clock.advanceTo(2 * S);
    gate.closeByMaintenance(null);
    expect(gate.snapshot().episode?.index).toBe(2);
    await clock.advanceTo(13 * S);
    expect(calls).toEqual([12 * S]);
  });

  it("Q10: an identity lock of another document than gateDoc does not shut writes", () => {
    const { gate } = gateWith();
    gate.noteOpened(DOC_A);
    gate.lockIdentity(DOC_B);
    expect(gate.snapshot().identityLock?.doc).toEqual(DOC_B);
    expect(gate.mayWrite("any")).toBe(true);
    gate.lockIdentity(DOC_A);
    expect(gate.mayWrite("any")).toBe(false);
  });

  it("AC-50/Q15: a registration in the readback phase joins the current round and holds the lock until its answer", () => {
    const { gate } = gateWith();
    gate.noteOpened(DOC_A);
    gate.registerPending("settings", "A");
    gate.lockIdentity(DOC_A);
    gate.identityVerified(DOC_A);
    gate.registerPending("card", "late");
    expect(gate.snapshot().identityLock).toMatchObject({ phase: "readback", round: ["A", "late"] });
    gate.resolvePending("A", "recorded");
    expect(gate.snapshot().identityLock).toMatchObject({ round: ["late"] });
    expect(gate.mayWrite("other")).toBe(false);
    gate.resolvePending("late", "not_recorded");
    expect(gate.snapshot().identityLock).toBeNull();
  });

  it.each(["%E0%A4%A", "%", "a%zz"])("Q21: a status path with a broken escape (%s) is no_ticket", async id => {
    const { gate } = gateWith();
    await gate.runReadback("A", async ticket => {
      expect(gate.admit({ method: "GET", path: `/commands/${id}`, readbackTicket: ticket })).toBe("no_ticket");
    });
  });

  it("Q23: the gate itself bounds an announced hold to 900 s (an outage mark, a caller that skipped §3.5)", async () => {
    const outage = gateWith([], { outage: { retryAfterS: 5_000 } });
    expect(outage.gate.snapshot().holdUntil).toBe(900 * S);
    const { gate } = gateWith();
    gate.extendHold(100_000);
    expect(gate.snapshot().holdUntil).toBe(900 * S);
    gate.closeByMaintenance(3_600);
    expect(gate.snapshot().holdUntil).toBe(900 * S);
  });

  it("P3-5: a disposed gate lets nothing through (its page is gone, Z5)", async () => {
    const { gate } = gateWith();
    gate.dispose();
    for (const request of [
      { method: "POST", path: "/auth/telegram", body: {} },
      { method: "POST", path: "/client/open", body: { event: "foreground", document_id: "d" } },
      { method: "POST", path: "/commands", body: { command_id: "x" } },
      { method: "GET", path: "/today" },
      { method: "GET", path: "/availability" },
    ]) expect(gate.admit(request)).toBe("cancelled");
    await expect(gate.runReadback("A", async () => "x")).rejects.toMatchObject({ reason: "cancelled" });
  });
});
