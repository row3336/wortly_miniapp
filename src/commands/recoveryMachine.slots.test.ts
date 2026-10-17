// CP5b stage 2 (C555, C556): the recovery machine over the durable slot budget — identity + slot + attempt P, the
// pre-request step before every request, the give-back of a reservation only before "sending", late handlers, the ban,
// what an outcome does to the record, and the manual attempt of a closure C (В1). Exact fake time, memory store model.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClosedAccessError } from "../app/openedAccess";
import { budgetBinding, recoveryBudget, type BudgetIntent } from "./intentBudget";
import { LoggedBudget, seedMarks, storedMarks, TEST_OWNER, testBudget } from "./budget.test-support";
import { systemRecoveryClock } from "./recoveryClock";
import { RecoveryMachine, type RecoverySnapshot, type RequestHooks } from "./recoveryMachine";
import type { CheckResult, SendResult } from "./recoveryReplies";
import { MemorySendBudget, type BudgetFamily, type SendBudgetRecord } from "./sendBudget";

const X: BudgetIntent = { command_id: "11111111-1111-4111-8111-111111111111", kind: "answer.submit",
  session_id: "22222222-2222-4222-8222-222222222222", assignment_id: "33333333-3333-4333-8333-333333333333", payload: { text: "Tisch" } };
const C: BudgetIntent = { command_id: "44444444-4444-4444-8444-444444444444", kind: "session.stop",
  session_id: X.session_id, payload: { reason: "save_failed", unsaved_command_id: X.command_id } };
const LOST: SendResult = { kind: "lost", cause: "network" };
const ACCEPTED: SendResult = { kind: "settled", outcome: "accepted" };
const ABSENT: CheckResult = { kind: "not_recorded" };
const P = (n: number, owner = 0) => `9a00000${owner}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

type Script = {
  intent?: BudgetIntent;
  family?: BudgetFamily;
  store?: MemorySendBudget;
  send?: (n: number, hooks: RequestHooks) => SendResult | Error | "unprepared" | Promise<SendResult>;
  check?: (n: number) => CheckResult;
  maySend?: () => boolean;
  keepChecking?: boolean;
  /** A failing source of the store: the page has none (Q34: fail closed). */
  noStore?: boolean;
  /** Owners of one record draw their attempt IDs apart (each is a fresh UUID in the product). */
  owner?: number;
};

function rig(script: Script = {}) {
  const intent = script.intent ?? X, store = script.store ?? new LoggedBudget();
  let attempts = 0;
  const newAttempt = () => P(++attempts, script.owner ?? 0);
  const budget = script.noStore
    ? recoveryBudget({ store: () => Promise.reject(new Error("no IndexedDB")) }, () => budgetBinding(intent, TEST_OWNER, script.family ?? "primary"))
    : testBudget(intent, { store, family: script.family ?? "primary", newAttempt });
  const posts: number[] = [], states: string[] = [];
  const t0 = performance.now();
  let sends = 0, checks = 0;
  const machine = new RecoveryMachine<BudgetIntent>({
    intent, budget, clock: systemRecoveryClock, active: true, ...(script.keepChecking ? { keepChecking: true } : {}),
    onUpdate: (snapshot: RecoverySnapshot) => states.push(snapshot.state.name),
    ports: {
      send: async (_copy, hooks) => {
        const n = ++sends;
        const scripted = (script.send ?? (() => LOST))(n, hooks);
        if (scripted instanceof ClosedAccessError) throw scripted;
        if (scripted === "unprepared") { await hooks.prepare(); return { kind: "not_sent" }; }
        if (!(await hooks.prepare())) return { kind: "not_sent" };
        hooks.started();
        posts.push(performance.now() - t0);
        if (scripted instanceof Error) throw scripted;
        return scripted;
      },
      check: async () => (script.check ?? (() => ABSENT))(++checks),
      probe: async () => true,
      isLive: () => true,
      windowCheck: async () => true,
      ...(script.maySend ? { maySend: script.maySend } : {}),
    },
  });
  const record = () => store.peek(intent.command_id) as SendBudgetRecord | undefined;
  return { machine, store, posts, states, record, ops: () => (store instanceof LoggedBudget ? store.ops : []).map(op => op.split(":")[0]),
    state: () => machine.snapshot().state.name, marks: () => storedMarks(store, intent.command_id) };
}
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("the slot budget under the recovery machine (CP5b stage 2)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a new intent creates its record, a retry reserves the next slot; each request leaves only after its slot is sending", async () => {
    const seen: string[] = [];
    const r = rig({ send: n => {
      // Inside the send, before the pre-request step: the slot of this attempt is only reserved.
      seen.push(`${n}:${r.record()?.slots[n - 1]?.state}`);
      return n === 1 ? LOST : ACCEPTED;
    } });
    r.machine.begin();
    await pass(0);
    await pass(2_000);
    expect(r.posts).toEqual([0, 2_000]);
    expect(seen).toEqual(["1:reserved", "2:reserved"]);
    expect(r.ops()).toEqual(["create", "sending", "transmitted", "retryable", "reserve", "sending", "transmitted", "clear"]);
    expect(r.record()).toBeUndefined();
  });

  it("the started request of an attempt finds its slot already sending (the commit came first)", async () => {
    const at: string[] = [];
    const r = rig({ send: () => ACCEPTED });
    const original = r.store.markTransmitted.bind(r.store);
    vi.spyOn(r.store, "markTransmitted").mockImplementation(async (identity, claim) => {
      at.push(String((r.record()?.slots[claim.slot] as { state: string } | undefined)?.state));
      return original(identity, claim);
    });
    r.machine.begin();
    await pass(0);
    expect(at).toEqual(["sending"]);
  });

  it("a refusal before the pre-request step gives the slot back; the next attempt reserves it again under its own P", async () => {
    const r = rig({ send: n => n === 1 ? new ClosedAccessError() : ACCEPTED, check: () => ABSENT });
    r.machine.begin();
    await pass(0);
    expect(r.posts).toEqual([]);
    expect(r.record()?.slots[0]).toEqual({ state: "released" });
    expect(r.machine.snapshot()).toMatchObject({ sends: 0, transmitted: 0 });
    await pass(5_000);
    expect(r.posts).toEqual([5_000]);
    expect(r.ops()).toEqual(["create", "release", "reserve", "sending", "transmitted", "clear"]);
  });

  it("the document changed during the commit of sending: no request, the slot stays sending (never given back), only checks", async () => {
    let allowed = true;
    const store = new LoggedBudget();
    const begin = store.beginSending.bind(store);
    vi.spyOn(store, "beginSending").mockImplementation(async (identity, claim) => {
      const result = await begin(identity, claim);
      allowed = false; // 2.3 А or the gate changed while the slot was written
      return result;
    });
    const r = rig({ store, maySend: () => allowed });
    r.machine.begin();
    await pass(0);
    allowed = true;
    await pass(600_000);
    expect(r.posts).toEqual([]);
    expect(r.record()?.slots[0]).toEqual({ state: "sending", attempt: P(1) });
    expect(r.ops()).not.toContain("release");
    expect(r.ops().filter(op => op === "create" || op === "reserve")).toEqual(["create"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "counter_unknown", cause: "unconfirmed" }, sends: 1, transmitted: 0 });
  });

  it("a late pre-request step or start of an older attempt touches no slot of the newer one", async () => {
    let old: RequestHooks | null = null;
    let finish!: (result: SendResult) => void;
    const r = rig({ send: (n, hooks) => {
      if (n === 1) { old = hooks; return new ClosedAccessError(); }
      return new Promise<SendResult>(resolve => { finish = resolve; });
    } });
    r.machine.begin();
    await pass(5_000);
    expect(r.record()?.slots[0]).toEqual({ state: "transmitted", attempt: P(2) });
    const before = [...r.ops()];
    expect(await old!.prepare()).toBe(false);
    old!.started();
    await pass(0);
    expect(r.ops()).toEqual(before);
    expect(r.record()?.slots[0]).toEqual({ state: "transmitted", attempt: P(2) });
    finish(ACCEPTED);
    await pass(0);
    expect(r.state()).toBe("settled");
  });

  it("two owners of the same record never send more than six in all (C060: an unsettled slot blocks the other)", async () => {
    const store = new LoggedBudget();
    await seedMarks(store, X, { reserved: 1, transmitted: 1 });
    const a = rig({ store, owner: 1 }), b = rig({ store, owner: 2 });
    a.machine.resume(); b.machine.resume();
    await pass(3_600_000);
    expect(a.posts.length + b.posts.length).toBeLessThanOrEqual(5);
    expect(await storedMarks(store, X.command_id)).toMatchObject({ reserved: 6 });
    expect([a.state(), b.state()]).toContain("exhausted");
  });

  it("no store on this page (no IndexedDB, a failed open): not one POST, only checks (Q34, D-CP5 10.2)", async () => {
    const r = rig({ noStore: true });
    r.machine.begin();
    await pass(600_000);
    expect(r.posts).toEqual([]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "counter_unknown", cause: "unknown" }, sends: null });
  });

  it("outcomes and the record (D-CP5 9.2, 10.7.2.5): accepted and SESSION_CLOSED remove it, any other refusal keeps it banned", async () => {
    const accepted = rig({ send: () => ACCEPTED });
    accepted.machine.begin(); await pass(0);
    expect(await accepted.marks()).toBeNull();
    const closed = rig({ send: () => ({ kind: "settled", outcome: "rejected", code: "SESSION_CLOSED" }) });
    closed.machine.begin(); await pass(0);
    expect(await closed.marks()).toBeNull();
    for (const code of ["ASSIGNMENT_STALE", "VERSION_CONFLICT", null]) {
      const refused = rig({ send: () => ({ kind: "settled", outcome: "rejected", code }) });
      refused.machine.begin(); await pass(0);
      expect(refused.state()).toBe("settled");
      expect(await refused.marks()).toEqual({ reserved: 1, transmitted: 1, forbidden: true });
    }
    const definite = rig({ send: () => ({ kind: "refused", code: "VALIDATION_FAILED" }) });
    definite.machine.begin(); await pass(0);
    expect(definite.state()).toBe("refused");
    expect(await definite.marks()).toEqual({ reserved: 1, transmitted: 1, forbidden: true });
    const stale = rig({ check: () => ({ kind: "terminated", reason: "step_stale" }) });
    stale.machine.begin(); await pass(0);
    expect(stale.state()).toBe("terminated");
    // A changed step proves nothing for the budget: the record stays, without a ban, and its lost send stays counted.
    expect(await stale.marks()).toEqual({ reserved: 1, transmitted: 1 });
  });

  it("a found fact settles the same way: recorded accepted removes the record, a recorded refusal keeps it banned", async () => {
    const found = rig({ check: () => ({ kind: "recorded", outcome: "accepted" }) });
    found.machine.begin(); await pass(0);
    expect(await found.marks()).toBeNull();
    const refusal = rig({ check: () => ({ kind: "recorded", outcome: "rejected", code: "ASSIGNMENT_STALE" }) });
    refusal.machine.begin(); await pass(0);
    expect(await refusal.marks()).toEqual({ reserved: 1, transmitted: 1, forbidden: true });
  });
});

describe("the manual attempt of the closure C after its spent budget (C556 В1, Q30)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const spentC = async (script: Script = {}) => {
    const store = script.store ?? new LoggedBudget();
    await seedMarks(store, C, { reserved: 6, transmitted: 6 }, { family: "stop" });
    const r = rig({ ...script, intent: C, family: "stop", store });
    r.machine.resume();
    await pass(0);
    expect(r.state()).toBe("exhausted");
    return r;
  };

  it("a press checks, then sends once through the manual cell; a lost reply comes back to the spent state, never a 7th automatic", async () => {
    const r = await spentC();
    expect(r.machine.manual()).toBe(true);
    await pass(0);
    expect(r.posts).toEqual([0]);
    expect(r.ops().slice(-4)).toEqual(["manual", "sending", "transmitted", "retryable"]);
    expect(r.state()).toBe("exhausted");
    expect(r.machine.snapshot()).toMatchObject({ sends: 6, transmitted: 6 });
    await pass(3_600_000);
    expect(r.posts).toEqual([0]);
    expect(r.ops().filter(op => op === "reserve")).toEqual([]);
    // The second press: one more send, the six automatic slots still untouched.
    const slots = structuredClone(r.record()!.slots);
    expect(r.machine.manual()).toBe(true);
    await pass(0);
    expect(r.posts).toEqual([0, 3_600_000]);
    expect(r.record()!.slots).toEqual(slots);
    expect(r.record()!.manual).toEqual({ state: "retryable", attempt: P(2) });
  });

  it("a press whose check finds C written settles it; the record goes", async () => {
    const r = await spentC({ check: n => n === 1 ? ABSENT : { kind: "recorded", outcome: "accepted" } });
    expect(r.machine.manual()).toBe(true);
    await pass(0);
    expect(r.posts).toEqual([]);
    expect(r.state()).toBe("settled");
    expect(r.record()).toBeUndefined();
  });

  it("a press does nothing outside the spent state, in a keepChecking machine, or under the ban", async () => {
    const fresh = rig({ intent: C, family: "stop" });
    expect(fresh.machine.manual()).toBe(false);
    const banned = await spentC();
    const store = banned.store;
    expect(await testBudget(C, { store, family: "stop" }).forbidSends()).toBe(true);
    expect(banned.machine.manual()).toBe(true);
    await pass(0);
    expect(banned.posts).toEqual([]);
    expect(banned.state()).toBe("checks_only");
    const checking = rig({ intent: C, family: "stop", keepChecking: true });
    await seedMarks(checking.store, C, { reserved: 6, transmitted: 6 }, { family: "stop" });
    checking.machine.resume();
    await pass(0);
    expect(checking.machine.manual()).toBe(false);
    // QA stage 2 P3 (Q4): a window in the background presses nothing either; the return lets the press through again.
    const away = await spentC();
    away.machine.setActive(false);
    expect(away.machine.manual()).toBe(false);
    await pass(60_000);
    expect(away.posts).toEqual([]);
    away.machine.setActive(true);
    await pass(0);
    expect(away.state()).toBe("exhausted");
    expect(away.machine.manual()).toBe(true);
    await pass(0);
    expect(away.posts).toHaveLength(1);
  });

  it("a press whose outcome could not be written leaves the closure unknown: no further press, only checks", async () => {
    const store = new LoggedBudget();
    vi.spyOn(store, "markRetryable").mockRejectedValue(new Error("storage"));
    const r = await spentC({ store });
    expect(r.machine.manual()).toBe(true);
    await pass(0);
    expect(r.posts).toEqual([0]);
    expect(r.state()).toBe("counter_unknown");
    expect(r.machine.manual()).toBe(false);
    await pass(600_000);
    expect(r.posts).toEqual([0]);
  });

  it("a study action has no manual send: its spent budget refuses the manual cell even when asked", async () => {
    const store = new LoggedBudget();
    await seedMarks(store, X, { reserved: 6, transmitted: 6 });
    const r = rig({ store });
    r.machine.resume();
    await pass(0);
    expect(r.state()).toBe("exhausted");
    expect(r.machine.manual()).toBe(true);
    await pass(0);
    expect(r.posts).toEqual([]);
    expect(r.ops()).toContain("manual");
    expect(r.state()).toBe("counter_unknown");
  });
});
