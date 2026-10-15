// The recovery machine with the write gate (P03 M-P03-5…7): the machine and the gate share one manual monotonic clock.
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/http";
import { RecoveryMachine, type RecoverySnapshot } from "./recoveryMachine";
import { checkFailure, sendFailure, type CheckResult, type SendResult } from "./recoveryReplies";
import { MemorySendCounter, type SendCounter } from "./sendCounter";
import { PausedBeforeSendError, WriteGate } from "./writeGate";
import { ManualClock, scriptedProbe, settle, type ProbeAnswer } from "./writeGate.test-support";

type Intent = { command_id: string; kind: string; session_id: string };
const INTENT: Intent = { command_id: "11111111-1111-4111-8111-111111111111", kind: "answer.submit",
  session_id: "22222222-2222-4222-8222-222222222222" };
const S = 1_000;

type Script = {
  send?: (n: number, gate: WriteGate) => SendResult | Error;
  check?: (n: number, gate: WriteGate) => CheckResult | Error;
  probes?: ProbeAnswer[];
  counter?: SendCounter;
};

function rig(script: Script = {}) {
  const clock = new ManualClock();
  const availability = scriptedProbe(clock, script.probes ?? []);
  const gate = new WriteGate({ clock, probe: availability.probe });
  const counter = script.counter ?? new MemorySendCounter();
  const posts: number[] = [], checks: number[] = [], ownProbes: number[] = [];
  let sends = 0, reads = 0;
  const machine = new RecoveryMachine<Intent>({
    intent: INTENT, counter, clock, active: true,
    ports: {
      send: async (_intent, transmitted) => {
        const reply = (script.send ?? (() => ({ kind: "settled", outcome: "accepted" }) as SendResult))(++sends, gate);
        // PAUSED_BEFORE_SEND is refused before transmitted (L1), like the lane does.
        if (reply instanceof PausedBeforeSendError) throw reply;
        transmitted();
        posts.push(clock.now());
        if (reply instanceof Error) throw reply;
        return reply;
      },
      check: async () => {
        checks.push(clock.now());
        const reply = (script.check ?? (() => ({ kind: "not_recorded" }) as CheckResult))(++reads, gate);
        if (reply instanceof Error) throw reply;
        return reply;
      },
      probe: async () => { ownProbes.push(clock.now()); return true; },
      isLive: () => true,
      windowCheck: async () => true,
      gate,
    },
  });
  const state = (): RecoverySnapshot["state"]["name"] => machine.snapshot().state.name;
  return { machine, gate, clock, posts, checks, ownProbes, gateProbes: availability.calls, counter, state };
}

describe("automatic recovery waits for the write gate (M-P03-6)", () => {
  it("AC-08: a refused connection at 0 s, the gate's probe at 5 s says ready: the check, then send №2 right after — no probe of its own", async () => {
    const r = rig({
      send: (n, gate) => { if (n === 1) { gate.closeByFailure(); return { kind: "lost", cause: "network" }; } return { kind: "settled", outcome: "accepted" }; },
      check: n => n === 1 ? { kind: "unreachable" } : { kind: "not_recorded" },
      probes: [{ status: "ready" }],
    });
    r.machine.begin();
    await settle();
    expect(r.state()).toBe("unreachable");
    await r.clock.advanceTo(4_999);
    expect(r.posts).toEqual([0]);
    await r.clock.advanceTo(5 * S);
    expect(r.gateProbes).toEqual([5 * S]);
    expect(r.checks).toEqual([0, 5 * S]);
    expect(r.posts).toEqual([0, 5 * S]);
    expect(r.state()).toBe("settled");
    expect(r.ownProbes).toEqual([]);
  });

  it("RD-2: a lost reply that leaves the gate open (a timeout) paces its checks on 5 s, still with no probe of its own", async () => {
    const r = rig({
      send: n => n === 1 ? { kind: "lost", cause: "network" } : { kind: "settled", outcome: "accepted" },
      check: n => n === 1 ? { kind: "unreachable" } : { kind: "not_recorded" },
    });
    r.machine.begin();
    await settle();
    expect(r.gate.mayWrite()).toBe(true);
    await r.clock.advanceTo(4_999);
    expect(r.checks).toEqual([0]);
    await r.clock.advanceTo(5 * S);
    expect(r.checks).toEqual([0, 5 * S]);
    expect(r.posts).toEqual([0, 5 * S]);
    expect(r.ownProbes).toEqual([]);
    expect(r.gateProbes).toEqual([]);
  });

  it("AC-05 (automaton): 503 MAINTENANCE with retry_after 30: no POST before the end of the hold, then a fresh probe, the check, one send", async () => {
    const r = rig({
      send: (n, gate) => { if (n === 1) { gate.closeByMaintenance(30); return { kind: "maintenance", waitSeconds: 30 }; } return { kind: "settled", outcome: "accepted" }; },
      probes: [{ status: "ready" }, { status: "ready" }],
    });
    r.machine.begin();
    await settle();
    expect(r.state()).toBe("maintenance");
    await r.clock.advanceTo(29_999);
    expect(r.gateProbes).toEqual([5 * S]);
    expect(r.posts).toEqual([0]);
    expect(r.state()).toBe("maintenance");
    await r.clock.advanceTo(30 * S);
    // The ready of 5 s is older than 10 s at the end of the hold: one fresh probe first (R-12).
    expect(r.gateProbes).toEqual([5 * S, 30 * S]);
    expect(r.posts).toEqual([0, 30 * S]);
    expect(r.ownProbes).toEqual([]);
  });

  it("AC-21: the gate closes between the decision and the send: not_sent, the reservation goes back, transmitted unchanged", async () => {
    const r = rig({
      send: (n, gate) => {
        if (n === 1) { gate.closeByFailure(); return new PausedBeforeSendError("paused"); }
        return { kind: "settled", outcome: "accepted" };
      },
      probes: [{ status: "ready" }],
    });
    r.machine.begin();
    await settle();
    expect(r.posts).toEqual([]);
    expect(r.machine.snapshot()).toMatchObject({ sends: 0, transmitted: 0 });
    expect(r.state()).toBe("unreachable");
    await r.clock.advanceTo(5 * S);
    expect(r.posts).toEqual([5 * S]);
    expect(r.machine.snapshot()).toMatchObject({ sends: 1, transmitted: 1, state: { name: "settled" } });
  });

  it("a gate closed before the first send reserves nothing and waits for it (no POST, no probe of its own)", async () => {
    const r = rig({ probes: [{ status: "ready" }] });
    r.gate.closeByFailure();
    r.machine.begin();
    await settle();
    expect(r.machine.snapshot()).toMatchObject({ sends: 0, transmitted: 0, state: { name: "unreachable" } });
    await r.clock.advanceTo(5 * S);
    expect(r.checks).toEqual([5 * S]);
    expect(r.posts).toEqual([5 * S]);
  });

  it("T10/I5: absence read while the gate is closed sends nothing; the ID is read again after ready", async () => {
    const r = rig({
      send: (n, gate) => { if (n === 1) { gate.closeByFailure(); return { kind: "lost", cause: "network" }; } return { kind: "settled", outcome: "accepted" }; },
      probes: [{ status: "unknown" }, { status: "ready" }],
    });
    r.machine.begin();
    await settle();
    // The immediate check (N2) says not_recorded, but the gate is closed: no decision, no send.
    expect(r.checks).toEqual([0]);
    expect(r.posts).toEqual([0]);
    await r.clock.advanceTo(15 * S);
    expect(r.checks).toEqual([0, 15 * S]);
    expect(r.posts).toEqual([0, 15 * S]);
  });

  it("AC-09/T18: six provable sends, the last met MAINTENANCE: after the gate proves the end of the pause — exhaustion, not an endless pause", async () => {
    const counter = new MemorySendCounter();
    await counter.save(INTENT.command_id, { reserved: 6, transmitted: 6, lastMaintenance: true });
    const r = rig({ counter });
    r.machine.resume();
    await settle();
    expect(r.state()).toBe("exhausted");
    expect(r.posts).toEqual([]);
  });

  it("a readback the gate cancelled decides nothing; a closed window ends the work", async () => {
    const cancelled = rig({ check: () => new PausedBeforeSendError("cancelled") });
    cancelled.machine.resume();
    await settle();
    expect(cancelled.state()).toBe("checking");
    expect(cancelled.posts).toEqual([]);
    const closed = rig({ check: () => new PausedBeforeSendError("closed_window") });
    closed.machine.resume();
    await settle();
    expect(closed.machine.snapshot().state).toEqual({ name: "terminated", reason: "window_replaced" });
  });
});

describe("401 asks for a new sign-in (M-P03-7)", () => {
  it("a 401 of a send or a check is reauth; a 403 stays access_lost; PAUSED_BEFORE_SEND is not_sent and never a lost reply", () => {
    expect(sendFailure(new ApiError("http", 401, "AUTH_EXPIRED"))).toEqual({ kind: "terminated", reason: "reauth" });
    expect(checkFailure(new ApiError("http", 401, "AUTH_EXPIRED"))).toEqual({ kind: "terminated", reason: "reauth" });
    expect(sendFailure(new ApiError("http", 403, "ACCESS_REJECTED"))).toEqual({ kind: "terminated", reason: "access_lost" });
    expect(checkFailure(new ApiError("http", 403, "FORBIDDEN"))).toEqual({ kind: "terminated", reason: "access_lost" });
    expect(sendFailure(new PausedBeforeSendError("paused"))).toEqual({ kind: "not_sent" });
    expect(checkFailure(new PausedBeforeSendError("no_ticket"))).toEqual({ kind: "gate_refused", reason: "no_ticket" });
  });

  it("reauth keeps the count and sends nothing more", async () => {
    const r = rig({ send: () => new ApiError("http", 401, "AUTH_EXPIRED") });
    r.machine.begin();
    await settle();
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "terminated", reason: "reauth" }, sends: 1, transmitted: 1 });
    expect(await r.counter.load(INTENT.command_id)).toMatchObject({ reserved: 1, transmitted: 1 });
    await r.clock.advanceTo(120 * S);
    expect(r.posts).toEqual([0]);
  });
});
