// M-SLOT-CONFLICT-LC + D-FALSE-TEXTS B, one mechanism (dropUnsent → RecoveryMachine.discard): the joint checks of C135 п. 3.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingStoreError } from "./pendingSlot";
import { LaneRecovery, type RecoveryLaneState } from "./laneRecovery";
import { systemRecoveryClock } from "./recoveryClock";
import { LoggedBudget, seedMarks, storedMarks, testLaneBudgets } from "./budget.test-support";
import type { RequestHooks } from "./recoveryMachine";

const Y = "00000000-0000-4000-8000-0000000000aa", X = "00000000-0000-4000-8000-0000000000bb", Z = "00000000-0000-4000-8000-0000000000cc";
const SESSION = "00000000-0000-4000-8000-000000000003";
const intent = (command_id: string) => ({ command_id, kind: "answer.submit", session_id: SESSION });
const dropped: RecoveryLaneState = { pending: false, pendingIntent: null, outcome: null, resolved: null, problem: "pending_changed", canRetry: false };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });
async function settleWork() { for (let round = 0; round < 200; round++) await Promise.resolve(); }

function rig(options: { clearFails?: boolean; slowSave?: Promise<void> } = {}) {
  const inner = new LoggedBudget({ clearFails: options.clearFails, slowCreate: options.slowSave }), ops = inner.ops;
  const counter = testLaneBudgets(inner);
  const lane = { state: dropped as RecoveryLaneState, failure: new PendingStoreError("changed") as unknown };
  let sends = 0, checks = 0;
  const host = {
    automatic: () => true, primary: () => lane.state, failure: () => lane.failure,
    // A lane that holds the intent reaches its send: the pre-request step, then the start. A dropped one never gets there.
    send: async (_i: unknown, _first: boolean, hooks: RequestHooks) => { sends++; if (lane.state.pending && await hooks.prepare()) hooks.started(); },
    check: async () => { checks++; }, release: async () => {}, isLive: () => true, onUpdate: () => {},
  };
  const recovery = new LaneRecovery(host, counter, systemRecoveryClock);
  return { recovery, host, lane, inner, ops, counter, counts: () => ({ sends, checks }) };
}

describe("one drop of a never stored, never sent intent", () => {
  it("a failing clear of Y's count: no rejection escapes, no further write of Y, X untouched", async () => {
    const r = rig({ clearFails: true });
    await seedMarks(r.inner, intent(X), { reserved: 2, transmitted: 1 });
    await r.recovery.begin(intent(Y)); await settleWork();
    expect(r.recovery.view()).toBeNull();
    const ownAfterClear = r.ops.slice(r.ops.lastIndexOf(`clear:${Y}`) + 1).filter(op => op.includes(Y));
    expect(ownAfterClear).toEqual([]);
    await vi.advanceTimersByTimeAsync(300_000); await settleWork();
    expect(r.counts()).toEqual({ sends: 1, checks: 0 });
    expect(r.ops.filter(op => op.includes(X))).toEqual([]);
    expect(await storedMarks(r.inner, X)).toEqual({ reserved: 2, transmitted: 1 });
  });
  it("a slow reservation write: the clear still comes after it, and nothing of Y follows the clear", async () => {
    let open!: () => void; const slowSave = new Promise<void>(done => { open = done; });
    const r = rig({ slowSave });
    const begun = r.recovery.begin(intent(Y)); await settleWork();
    expect(r.counts().sends).toBe(0);
    open(); await begun; await settleWork();
    const own = r.ops.filter(op => op.includes(Y));
    expect(own.at(-1)).toBe(`clear:${Y}`);
    expect(await storedMarks(r.inner, Y)).toBeNull();
  });
  it("a new owner on the same page counter never meets Y and resumes X with its own count", async () => {
    const r = rig();
    await seedMarks(r.inner, intent(X), { reserved: 2, transmitted: 1 });
    await r.recovery.begin(intent(Y)); await settleWork();
    const next = new LaneRecovery({ ...r.host, primary: () => ({ ...dropped, problem: null, pending: true, pendingIntent: intent(X) }), failure: () => null },
      r.counter, systemRecoveryClock);
    next.sync(); await settleWork();
    expect(next.view()?.commandId).toBe(X);
    expect((await storedMarks(r.inner, X))?.transmitted).toBe(1);
    expect(r.ops.filter(op => op.includes(Y) && !op.startsWith("create:") && !op.startsWith("release:") && !op.startsWith("clear:"))).toEqual([]);
    next.dispose();
  });
  it("a later action Z gets its own machine and count; the drop of Y does not touch it", async () => {
    const r = rig();
    await r.recovery.begin(intent(Y)); await settleWork();
    r.lane.state = { ...dropped, problem: null, pending: true, pendingIntent: intent(Z) }; r.lane.failure = null;
    void r.recovery.begin(intent(Z)); await settleWork();
    expect(r.recovery.view()?.commandId).toBe(Z);
    expect(await storedMarks(r.inner, Z)).toMatchObject({ reserved: 1, transmitted: 1 });
    expect(await storedMarks(r.inner, Y)).toBeNull();
    r.recovery.dispose();
  });
  it("a resend of a retained intent is never dropped, even when the lane reports the slot refusal without its record", async () => {
    const r = rig();
    r.lane.state = { ...dropped, problem: null, pending: true, pendingIntent: intent(X), canRetry: true }; r.lane.failure = null;
    await seedMarks(r.inner, intent(X), { reserved: 1, transmitted: 1 });
    // The resend (first = false) meets the refusal; the lane then holds no intent. Only a first send may be dropped.
    r.host.send = async () => { r.lane.state = dropped; r.lane.failure = new PendingStoreError("changed"); };
    r.recovery.sync(); await settleWork();
    // Right after the refused resend the machine still drives X (no discard): its reservation was given back, X's count
    // stays, and only the machine's own rules decide what follows (a check by X's ID).
    expect(r.recovery.view()).toMatchObject({ commandId: X, state: { name: "retry_wait" } });
    await vi.advanceTimersByTimeAsync(2_000); await settleWork();
    expect(r.recovery.view()?.commandId).toBe(X);
    // The refused resend reserved slot 2 and gave it back before its pre-request step: X's count is as it was.
    expect(r.ops).toEqual([`reserve:${X}`, `release:${X}`]);
    expect(await storedMarks(r.inner, X)).toEqual({ reserved: 1, transmitted: 1 });
    r.recovery.dispose();
  });
});

// C147: the unreadable record (M-SLOT-INVALID) takes the same single drop; a storage failure without that proof never does.
describe.each(["changed", "invalid"] as const)("the same drop for a refusal %s", kind => {
  it("queued counters, a late give-back and a failing clear end with no count of Y and X untouched", async () => {
    let open!: () => void; const slowSave = new Promise<void>(done => { open = done; });
    const r = rig({ slowSave, clearFails: kind === "invalid" });
    r.lane.failure = new PendingStoreError(kind);
    await seedMarks(r.inner, intent(X), { reserved: 2, transmitted: 1 });
    const begun = r.recovery.begin(intent(Y)); await settleWork();
    open(); await begun; await settleWork();
    await vi.advanceTimersByTimeAsync(300_000); await settleWork();
    const own = r.ops.filter(op => op.includes(Y));
    expect(own.at(-1)).toBe(`clear:${Y}`);
    expect(r.recovery.view()).toBeNull();
    expect(r.counts()).toEqual({ sends: 1, checks: 0 });
    expect(await storedMarks(r.inner, X)).toEqual({ reserved: 2, transmitted: 1 });
  });
});
describe.each(["unavailable", "cancelled"] as const)("a store failure %s", kind => {
  it("is no proof that nothing was written: the machine keeps Y and its rules decide", async () => {
    const r = rig(); r.lane.failure = new PendingStoreError(kind);
    void r.recovery.begin(intent(Y)); await settleWork();
    expect(r.recovery.view()?.commandId).toBe(Y);
    expect(r.ops).not.toContain(`clear:${Y}`);
    r.recovery.dispose();
  });
});
