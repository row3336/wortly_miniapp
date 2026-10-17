// D-FALSE-TEXTS part B: the trace of a first send refused locally over another record in the shared slot. The lane dropped
// the intent (never stored, never sent), so the adapter must drop its machine AND leave no count of that ID behind: the
// machine's own give-back of the reservation runs after the adapter's forget and must not write the ID again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingStoreError } from "./pendingSlot";
import { LaneRecovery, type RecoveryLaneState } from "./laneRecovery";
import { systemRecoveryClock } from "./recoveryClock";
import { LoggedBudget, seedMarks, storedMarks, testLaneBudgets } from "./budget.test-support";

const Y = "00000000-0000-4000-8000-0000000000aa";
const X = "00000000-0000-4000-8000-0000000000bb";
const SESSION = "00000000-0000-4000-8000-000000000003";
const intent = { command_id: Y, kind: "answer.submit", session_id: SESSION };
const idle: RecoveryLaneState = { pending: false, pendingIntent: null, outcome: null, resolved: null, problem: "pending_changed", canRetry: false };
const held: RecoveryLaneState = { ...idle, pending: true, pendingIntent: intent };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function recorded() {
  const inner = new LoggedBudget();
  return { counter: testLaneBudgets(inner), ops: inner.ops, inner };
}
async function settleWork() { for (let round = 0; round < 200; round++) await Promise.resolve(); }

function setup(options: { lane?: RecoveryLaneState; failure?: unknown; transmit?: boolean }) {
  const { counter, ops, inner } = recorded();
  let sends = 0, checks = 0, updates = 0;
  const recovery = new LaneRecovery({
    automatic: () => true, primary: () => options.lane ?? idle,
    failure: () => options.failure === undefined ? new PendingStoreError("changed") : options.failure,
    send: async (_intent, _first, hooks) => { sends++; if (options.transmit && await hooks.prepare()) hooks.started(); },
    check: async () => { checks++; }, release: async () => {}, isLive: () => true, onUpdate: () => { updates++; },
  }, counter, systemRecoveryClock);
  return { recovery, ops, inner, counts: () => ({ sends, checks, updates }) };
}

describe("a first send refused over another record of the slot", () => {
  it("drops the machine and every count of the ID: nothing is written after the clear, no check or send follows", async () => {
    const rig = setup({});
    await seedMarks(rig.inner, { ...intent, command_id: X }, { reserved: 2, transmitted: 1 });
    const begun = rig.recovery.begin(intent);
    await begun; await settleWork();
    expect(rig.recovery.view()).toBeNull();
    expect(rig.recovery.busy()).toBe(false);
    // Order: the reservation is written, then the ID is cleared; the give-back of the reservation never follows the clear.
    const own = rig.ops.filter(op => op.endsWith(Y));
    expect(own[own.length - 1]).toBe(`clear:${Y}`);
    expect(own.lastIndexOf(`clear:${Y}`)).toBeGreaterThan(own.lastIndexOf(`create:${Y}`));
    expect(await storedMarks(rig.inner, Y)).toBeNull();
    // The record of the other window and its count were never addressed.
    expect(rig.ops.filter(op => op.endsWith(X))).toEqual([]);
    expect(await storedMarks(rig.inner, X)).toEqual({ reserved: 2, transmitted: 1 });
    // No later timer, probe, check or send of the dropped ID.
    const before = rig.counts();
    await vi.advanceTimersByTimeAsync(300_000); await settleWork();
    expect(rig.counts()).toEqual(before);
    expect(rig.counts().sends).toBe(1);
    expect(rig.counts().checks).toBe(0);
    expect(await storedMarks(rig.inner, Y)).toBeNull();
  });

  it("a send whose request began is never dropped, whatever failure the lane keeps", async () => {
    const rig = setup({ transmit: true });
    void rig.recovery.begin(intent); await settleWork();
    expect(rig.recovery.view()).not.toBeNull();
    expect((await storedMarks(rig.inner, Y))?.transmitted).toBe(1);
  });

  it.each([
    ["the lane still holds the intent", { lane: held }],
    ["the refusal is another kind of store failure", { failure: new PendingStoreError("unavailable") }],
    ["the last failure is not a store failure", { failure: new TypeError("network") }],
    ["there is no failure", { failure: null }],
  ] as const)("is not dropped when %s", async (_name, options) => {
    const rig = setup(options);
    void rig.recovery.begin(intent); await settleWork();
    expect(rig.recovery.view()).not.toBeNull();
  });
});
