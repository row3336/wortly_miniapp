import type { Availability } from "../api/availability";
import type { RecoveryClock, RecoveryTimer } from "./recoveryClock";
import { WriteGate, type GateDoc, type WriteGateOptions } from "./writeGate";

/** Lets promise chains settle without moving the clock. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 50; round++) await Promise.resolve();
}

/** A monotonic clock moved only by the test: timers fire in order, and promise chains settle after each one. */
export class ManualClock implements RecoveryClock {
  private time = 0;
  private sequence = 0;
  private timers: { id: number; at: number; callback: () => void }[] = [];

  now(): number { return this.time; }
  schedule(callback: () => void, delayMs: number): RecoveryTimer {
    const id = ++this.sequence;
    this.timers.push({ id, at: this.time + Math.max(0, delayMs), callback });
    return { id };
  }
  cancel(timer: RecoveryTimer): void { this.timers = this.timers.filter(entry => entry.id !== timer.id); }
  pending(): number { return this.timers.length; }

  /** Moves to `to` (ms since the start), firing every timer due on the way. */
  async advanceTo(to: number): Promise<void> {
    await settle();
    for (;;) {
      const due = this.timers.filter(entry => entry.at <= to).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter(entry => entry !== due);
      this.time = due.at;
      due.callback();
      await settle();
    }
    this.time = Math.max(this.time, to);
    await settle();
  }
  async advanceBy(ms: number): Promise<void> { await this.advanceTo(this.time + ms); }
}

export type ProbeAnswer = Availability | { status: "slow"; afterMs: number; then: Availability };

/**
 * A scripted availability probe: answers in order (then `unknown`), records the moment of every call. A `slow` answer
 * comes after afterMs on the manual clock (a probe that runs into its own timeout τ).
 */
export function scriptedProbe(clock: ManualClock, answers: ProbeAnswer[] = []) {
  const calls: number[] = [];
  const probe = () => {
    calls.push(clock.now());
    const answer = answers.shift() ?? { status: "unknown" as const };
    if (answer.status !== "slow") return Promise.resolve(answer);
    return new Promise<Availability>(resolve => { clock.schedule(() => resolve(answer.then), answer.afterMs); });
  };
  return { probe, calls, answers };
}

export const DOC_A: GateDoc = Object.freeze({ profileId: "profile-1", documentId: "document-a", epoch: "1" });
export const DOC_B: GateDoc = Object.freeze({ profileId: "profile-1", documentId: "document-b", epoch: "1" });

export function gateWith(answers: ProbeAnswer[] = [], options: Omit<WriteGateOptions, "clock" | "probe"> = {}) {
  const clock = new ManualClock();
  const script = scriptedProbe(clock, answers);
  const gate = new WriteGate({ ...options, clock, probe: script.probe });
  return { gate, clock, calls: script.calls, answers: script.answers };
}
