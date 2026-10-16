// The N3/visibility criterion (Codex C365) for the automatic resends of K01 in the candidate M-P03-9/10: the recovery
// machine with the write gate on one manual clock. The window's visibility reaches the machine as setActive (studyView
// deactivate/resumeRecovery) and the gate as setVisible (App); the last active guard before fetch is the generation of
// the machine after the awaited reservation (send) and its active/writable check on every gate event (waitForGate).
import { describe, expect, it } from "vitest";
import { RecoveryMachine } from "./recoveryMachine";
import type { CheckResult, SendResult } from "./recoveryReplies";
import { MemorySendCounter, type SendMarks } from "./sendCounter";
import { WriteGate } from "./writeGate";
import { ManualClock, scriptedProbe, settle, type ProbeAnswer } from "./writeGate.test-support";

type Intent = { command_id: string; kind: string; session_id: string };
const INTENT: Intent = { command_id: "11111111-1111-4111-8111-111111111111", kind: "answer.submit",
  session_id: "22222222-2222-4222-8222-222222222222" };
const S = 1_000;

/** A counter whose save may be held: the window can go hidden between the reservation and the network. */
class HeldCounter extends MemorySendCounter {
  hold: { release: () => void } | null = null;
  holdNext = false;
  override async save(commandId: string, marks: SendMarks): Promise<void> {
    if (this.holdNext) {
      this.holdNext = false;
      await new Promise<void>(resolve => { this.hold = { release: resolve }; });
    }
    return super.save(commandId, marks);
  }
}

function rig(options: { send: (n: number, gate: WriteGate) => SendResult; check?: (n: number) => CheckResult; probes?: ProbeAnswer[] }) {
  const clock = new ManualClock();
  const availability = scriptedProbe(clock, options.probes ?? []);
  const gate = new WriteGate({ clock, probe: availability.probe });
  const counter = new HeldCounter();
  const posts: number[] = [], checks: number[] = [];
  let sends = 0, reads = 0;
  const machine = new RecoveryMachine<Intent>({
    intent: INTENT, counter, clock, active: true,
    ports: {
      send: async (_intent, transmitted) => {
        // L2 as the transport does it: a request the gate refuses never leaves.
        if (!gate.mayWrite(INTENT.command_id)) throw new Error("L2 would refuse");
        transmitted(); posts.push(clock.now());
        return options.send(++sends, gate);
      },
      // The check goes through the gate's readback (R6): a closed window refuses it.
      check: () => gate.runReadback(INTENT.command_id, async () => {
        checks.push(clock.now());
        return (options.check ?? (() => ({ kind: "not_recorded" }) as CheckResult))(++reads);
      }),
      probe: async () => true,
      isLive: () => true,
      windowCheck: async () => true,
      gate,
    },
  });
  /** What App and studyView do on a change of document.visibilityState. */
  const visible = async (value: boolean) => { gate.setVisible(value); machine.setActive(value); await settle(); };
  return { machine, gate, clock, counter, posts, checks, gateProbes: availability.calls, visible };
}

const maintenance = (gate: WriteGate, seconds: number): SendResult => {
  gate.closeByMaintenance(seconds);
  return { kind: "maintenance", waitSeconds: seconds } as unknown as SendResult;
};

describe("N3/visibility: the automatic resend of K01 (RecoveryMachine + write gate)", () => {
  it("hidden before the end of the pause: no probe, no check, no send; shown — the check first, then the rest, once", async () => {
    const r = rig({ send: (n, gate) => n === 1 ? maintenance(gate, 40) : { kind: "settled", outcome: "accepted" },
      probes: [{ status: "ready" }, { status: "ready" }] });
    r.machine.begin(); await settle();
    expect(r.posts).toEqual([0]);
    await r.clock.advanceTo(3 * S);
    await r.visible(false);
    const checksHidden = r.checks.length;
    await r.clock.advanceTo(120 * S);
    expect(r.posts).toEqual([0]); expect(r.checks).toHaveLength(checksHidden); expect(r.gateProbes).toEqual([]);
    await r.visible(true);
    await r.clock.advanceTo(140 * S);
    expect(r.posts).toHaveLength(2);
    const resend = r.posts[1];
    expect(resend).toBeGreaterThanOrEqual(120 * S);
    // The check by ID comes before the resend of the same command, and no second resend follows.
    expect(r.checks.some(at => at >= 120 * S && at <= resend)).toBe(true);
    await r.clock.advanceTo(400 * S);
    expect(r.posts).toHaveLength(2);
    expect(r.machine.snapshot().state.name).toBe("settled");
  });

  it("hidden on the await between the reservation and fetch: nothing leaves; shown — check, then one send (no extra count)", async () => {
    const r = rig({ send: n => n === 1 ? { kind: "lost", cause: "network" } as SendResult : { kind: "settled", outcome: "accepted" },
      check: () => ({ kind: "not_recorded" }) });
    r.machine.begin(); await settle();
    expect(r.posts).toEqual([0]);
    r.counter.holdNext = true;
    await r.clock.advanceTo(10 * S); // the pause of send №2 (RD-2: the timeout left the gate open)
    expect(r.counter.hold).not.toBeNull();
    await r.visible(false);
    r.counter.hold!.release(); await settle();
    await r.clock.advanceTo(60 * S);
    expect(r.posts).toEqual([0]);
    await r.visible(true);
    await r.clock.advanceTo(90 * S);
    expect(r.posts).toHaveLength(2);
    expect(r.checks.at(-1)!).toBeLessThanOrEqual(r.posts[1]);
    await r.clock.advanceTo(200 * S);
    expect(r.posts).toHaveLength(2);
  });

  it("ready while hidden (a probe in flight at the hide) resumes nothing; the show brings the check and one send", async () => {
    const r = rig({ send: (n, gate) => { if (n === 1) { gate.closeByFailure(); return { kind: "lost", cause: "network" } as SendResult; }
      return { kind: "settled", outcome: "accepted" }; },
    check: n => n === 1 ? { kind: "unreachable" } as CheckResult : { kind: "not_recorded" },
    probes: [{ status: "slow", afterMs: 2 * S, then: { status: "ready" } }, { status: "ready" }] });
    r.machine.begin(); await settle();
    await r.clock.advanceTo(5 * S); // the probe starts and answers at 7 s
    await r.visible(false);
    await r.clock.advanceTo(60 * S);
    expect(r.gate.snapshot().net.kind).toBe("open");
    expect(r.posts).toEqual([0]);
    await r.visible(true);
    await r.clock.advanceTo(80 * S);
    expect(r.posts).toHaveLength(2);
    await r.clock.advanceTo(300 * S);
    expect(r.posts).toHaveLength(2);
  });

  it("a closed window (Z5′) resumes nothing: no check, no send, whatever the shows and the ready", async () => {
    const r = rig({ send: (n, gate) => { if (n === 1) { gate.closeByFailure(); return { kind: "lost", cause: "network" } as SendResult; }
      return { kind: "settled", outcome: "accepted" }; },
    probes: [{ status: "ready" }, { status: "ready" }] });
    r.machine.begin(); await settle();
    r.gate.closeWindow(null);
    const checks = r.checks.length;
    await r.visible(false); await r.visible(true);
    await r.clock.advanceTo(300 * S);
    expect(r.posts).toEqual([0]); expect(r.checks).toHaveLength(checks);
  });
});

describe("fix1 (X21): the 9.2.4 estimate of the automatic K01 is what is left of the gate's announced hold", () => {
  it("the gate's hold (40 s) wins over the reply's own estimate (100 s), and follows the hold as it runs down", async () => {
    const r = rig({ send: (n, gate) => {
      if (n === 1) { gate.closeByMaintenance(40); return { kind: "maintenance", waitSeconds: 100 } as unknown as SendResult; }
      return { kind: "settled", outcome: "accepted" };
    }, probes: [{ status: "maintenance", retryAfterS: null, anomaly: false }, { status: "ready" }, { status: "ready" }] });
    r.machine.begin(); await settle();
    const state = () => r.machine.snapshot().state as { name: string; pauseSeconds?: number | null };
    expect(state()).toMatchObject({ name: "maintenance", pauseSeconds: 40 });
    await r.clock.advanceTo(5 * S); // the probe of the series answers maintenance: a gate event
    expect(state()).toMatchObject({ name: "maintenance", pauseSeconds: 35 });
  });
});
