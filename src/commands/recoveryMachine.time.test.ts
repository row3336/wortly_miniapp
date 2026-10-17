// CP5b stage 4 (C556 В4, C571; D-CP5 10.3, 10.4.2–10.4.3; tests 5.3.28–5.3.30, 5.3.34): the pause of a resumed owner of an
// action by the server clock. An owner with the right to send (the page created the action: another document of that
// page) waits only the rest of the pause after the loss an earlier owner wrote into the record — by the server time, minus
// its accuracy; with an unknown server time, the whole pause from now. The device clock never shortens it. An owner
// without that right (2.3 А) only checks, whatever the time says. Exact fake time; the server clock is scripted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedMarks, storedMarks, TEST_OWNER, testBudget } from "./budget.test-support";
import { budgetBinding, type BudgetIntent } from "./intentBudget";
import { RecoveryMachine } from "./recoveryMachine";
import type { RecoveryClock } from "./recoveryClock";
import type { CheckResult, SendResult } from "./recoveryReplies";
import { MemorySendBudget, type SendBudgetRecord } from "./sendBudget";
import { createServerClock, SERVER_TIME_ACCURACY_MS, type ServerClock } from "./serverClock";

const X: BudgetIntent = { command_id: "11111111-1111-4111-8111-111111111111", kind: "answer.submit",
  session_id: "22222222-2222-4222-8222-222222222222", assignment_id: "33333333-3333-4333-8333-333333333333", payload: { text: "Tisch" } };
const ACCEPTED: SendResult = { kind: "settled", outcome: "accepted" };
const LOST: SendResult = { kind: "lost", cause: "network" };
const ABSENT: CheckResult = { kind: "not_recorded" };
/** The server time at the loss an earlier owner found (ms since the epoch, whole seconds as the Date header gives). */
const LOSS_AT = Date.UTC(2026, 9, 17, 12, 0, 0);

/**
 * server: the exact server time at t = 0 of this owner (null: no answer with a readable Date on this page yet), or a
 * real server clock of the page fed by answers (serverClock.ts) — its bounds are what the machine reads.
 */
function rig(options: { store: MemorySendBudget; server: number | null | ServerClock; maySend?: () => boolean; send?: () => SendResult }) {
  const t0 = performance.now(), server = options.server;
  const clock: RecoveryClock = {
    now: () => performance.now(),
    schedule: (callback, delayMs) => ({ id: setTimeout(callback, delayMs) }),
    cancel: timer => clearTimeout(timer.id as ReturnType<typeof setTimeout>),
    serverBounds: () => server === null ? null : typeof server === "number"
      ? { lower: server + (performance.now() - t0), upper: server + (performance.now() - t0) } : server.bounds(),
  };
  const posts: number[] = [], checks: number[] = [];
  const machine = new RecoveryMachine<BudgetIntent>({
    intent: X, budget: testBudget(X, { store: options.store }), clock, active: true,
    ports: {
      send: async (_copy, hooks) => {
        if (!(await hooks.prepare())) return { kind: "not_sent" };
        hooks.started(); posts.push(performance.now() - t0);
        return (options.send ?? (() => ACCEPTED))();
      },
      check: async () => { checks.push(performance.now() - t0); return ABSENT; },
      probe: async () => true, isLive: () => true, windowCheck: async () => true,
      ...(options.maySend ? { maySend: options.maySend } : {}),
    },
  });
  return { machine, posts, checks, state: () => machine.snapshot().state.name };
}
/** The record of X after three lost sends (the fourth waits 10 s), with the loss an earlier owner wrote. */
async function spentThree(loss: { server: number; next: number } | null): Promise<MemorySendBudget> {
  const store = new MemorySendBudget();
  const record = await seedMarks(store, X, { reserved: 3, transmitted: 3 });
  if (loss) store.seed(record.commandId, { ...record, loss: { ...loss, device: 1 } } satisfies SendBudgetRecord);
  return store;
}
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("the pause of a resumed owner by the server clock (D-CP5 10.3)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("5.3.28 the pause (10 s) passed by the server clock before the new owner opened (15 s): the check, then the send at once", async () => {
    const r = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: LOSS_AT + 15_000 });
    r.machine.resume(); await pass(0);
    expect(r.checks).toEqual([0]);
    expect(r.posts).toEqual([0]);
  });

  it("5.3.29 4 s of the 10 s passed (exact server time): the rest, 6 s", async () => {
    const r = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: LOSS_AT + 4_000 });
    r.machine.resume(); await pass(0);
    expect(r.posts).toEqual([]);
    await pass(10_000);
    expect(r.posts).toEqual([6_000]);
  });

  it("5.3.30 the device clock moved back after the loss and the server time is unknown: the whole pause from the open", async () => {
    vi.setSystemTime(Date.now() - 3_600_000);
    const r = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: null });
    r.machine.resume(); await pass(0);
    await pass(60_000);
    expect(r.posts).toEqual([10_000]);
  });

  it("5.3.34 the device clock moved ±1 h between the opens: the wait follows the server time, not shorter, no new full wait", async () => {
    for (const shift of [3_600_000, -3_600_000]) {
      vi.setSystemTime(Date.now() + shift);
      const late = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: LOSS_AT + 15_000 });
      late.machine.resume(); await pass(0);
      expect(late.posts).toEqual([0]);
      late.machine.dispose();
      const early = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: LOSS_AT + 4_000 });
      early.machine.resume(); await pass(0); await pass(10_000);
      expect(early.posts).toEqual([6_000]);
      early.machine.dispose();
    }
  });

  it("a server time behind the loss (a negative elapsed time) is the whole pause: never longer, never shorter", async () => {
    const r = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: LOSS_AT - 5_000 });
    r.machine.resume(); await pass(0); await pass(30_000);
    expect(r.posts).toEqual([10_000]);
  });

  it("a loss of another send (an older one) or none: the whole pause", async () => {
    const older = rig({ store: await spentThree({ server: LOSS_AT, next: 3 }), server: LOSS_AT + 60_000 });
    older.machine.resume(); await pass(0); await pass(30_000);
    expect(older.posts).toEqual([10_000]);
    older.machine.dispose();
    const none = rig({ store: await spentThree(null), server: LOSS_AT + 60_000 });
    none.machine.resume(); await pass(0); await pass(30_000);
    expect(none.posts).toEqual([10_000]);
  });

  it("2.3 А: an owner without the right to send only checks, however long ago the loss was", async () => {
    const r = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: LOSS_AT + 600_000, maySend: () => false });
    r.machine.resume(); await pass(0); await pass(10 * 60_000);
    expect(r.posts).toEqual([]);
    expect(r.state()).toBe("origin_elsewhere");
    expect(r.checks.length).toBeGreaterThan(1);
  });
});

describe("the loss written into the record (D-CP5 10.3 п.2)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a known server time: the loss is written with the send it waits for; the next owner of the page waits only the rest", async () => {
    const store = new MemorySendBudget();
    const a = rig({ store, server: LOSS_AT, send: () => LOST });
    a.machine.begin(); await pass(0);
    const record = store.peek(X.command_id) as SendBudgetRecord;
    expect(record.loss).toMatchObject({ server: LOSS_AT, next: 2 });
    a.machine.dispose();
    // Another owner 1.5 s later (by the exact server time): the pause before #2 is 2 s — 0.5 s left.
    const b = rig({ store, server: LOSS_AT + 1_500 });
    b.machine.resume(); await pass(0); await pass(5_000);
    expect(b.posts).toEqual([500]);
    expect(await storedMarks(store, X.command_id)).toBeNull();
  });

  it("an unknown server time writes no loss: unknown is not «the loss was long ago»", async () => {
    const store = new MemorySendBudget();
    const a = rig({ store, server: null, send: () => LOST });
    a.machine.begin(); await pass(0);
    expect((store.peek(X.command_id) as SendBudgetRecord).loss).toBeUndefined();
    const binding = await budgetBinding(X, TEST_OWNER, "primary");
    expect(binding.commandId).toBe(X.command_id);
  });
});

describe("the bounds of the server time from Date and the delivery (C572)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const at = (ms: number) => new Date(LOSS_AT + ms).toUTCString();

  it("C572: an old Date that took 8 s to arrive, a loss at 10 s, a fresh Date of 10 s: the whole pause (10 s), not 3 s", async () => {
    let mono = 0;
    const clock = createServerClock(() => mono);
    // The answer left at 0 s and arrived at 8 s with the server's Date of 0 s (it waited in the network).
    clock.observe(at(0), 0, 8_000);
    // The loss is found at 10 s: written by the upper bound of the server time then.
    mono = 10_000;
    const loss = clock.bounds()!.upper;
    expect(loss).toBe(LOSS_AT + 10_000 + SERVER_TIME_ACCURACY_MS);
    // A fresh answer of the server at 10 s, sent and received at 10 s.
    clock.observe(at(10_000), 10_000, 10_000);
    const r = rig({ store: await spentThree({ server: loss, next: 4 }), server: clock });
    r.machine.resume(); await pass(0); await pass(30_000);
    // Nothing of the pause is proven to have passed: the whole 10 s from the open.
    expect(r.posts).toEqual([10_000]);
  });

  it("P3: a stale pair of Date (a slow answer) never shortens the pause; a later prompt answer narrows the bounds", async () => {
    let mono = 0;
    const clock = createServerClock(() => mono);
    clock.observe(at(0), 0, 6_000);
    mono = 6_000;
    // Only the slow answer: the server time now lies in [0 s, 7 s] — 7 s wide.
    expect(clock.bounds()).toEqual({ lower: LOSS_AT, upper: LOSS_AT + 7_000 });
    // A prompt answer: the lower bound rises to 6 s; the upper stays the tighter one of both answers (7 s).
    clock.observe(at(6_000), 5_900, 6_000);
    expect(clock.bounds()).toEqual({ lower: LOSS_AT + 6_000, upper: LOSS_AT + 6_000 + SERVER_TIME_ACCURACY_MS });
    // The loss by the upper bound at 6 s (7 s), the reopen at 15 s by the lower bound (15 s): 8 s counted of the 10 s.
    const loss = clock.bounds()!.upper;
    mono = 15_000;
    clock.observe(at(15_000), 15_000, 15_000);
    const r = rig({ store: await spentThree({ server: loss, next: 4 }), server: clock });
    r.machine.resume(); await pass(0); await pass(30_000);
    expect(r.posts).toEqual([10_000 - (15_000 - 6_000 - SERVER_TIME_ACCURACY_MS)]);
  });

  it("C572 end to end: the machine writes the loss by the upper bound; the next owner counts by the lower one", async () => {
    let mono = 0;
    const clock = createServerClock(() => mono);
    // Only a slow answer (sent at 0 s, arrived at 8 s, Date 0 s); the loss is found at 10 s: the server time is in [2 s, 11 s].
    clock.observe(at(0), 0, 8_000);
    mono = 10_000;
    const store = new MemorySendBudget();
    const a = rig({ store, server: clock, send: () => LOST });
    a.machine.begin(); await pass(0);
    expect((store.peek(X.command_id) as SendBudgetRecord).loss).toMatchObject({ server: LOSS_AT + 11_000, next: 2 });
    a.machine.dispose();
    // A prompt answer at 12 s: the server time is in [12 s, 13 s]. Proven to have passed: 1 s of the 2 s pause.
    mono = 12_000;
    clock.observe(at(12_000), 12_000, 12_000);
    const b = rig({ store, server: clock });
    b.machine.resume(); await pass(0); await pass(5_000);
    expect(b.posts).toEqual([1_000]);
  });

  it("bounds that contradict each other (the server clock jumped back) are an unknown time: the whole pause", async () => {
    let mono = 0;
    const clock = createServerClock(() => mono);
    clock.observe(at(60_000), 0, 0);
    clock.observe(at(0), 1_000, 1_000);
    expect(clock.bounds()).toBeNull();
    const r = rig({ store: await spentThree({ server: LOSS_AT, next: 4 }), server: clock });
    r.machine.resume(); await pass(0); await pass(30_000);
    expect(r.posts).toEqual([10_000]);
  });
});

describe("the page's server clock (serverClock.ts)", () => {
  it("reads the Date of an answer, keeps its bounds over a missing or malformed header", () => {
    let mono = 1_000;
    const clock = createServerClock(() => mono);
    expect(clock.bounds()).toBeNull();
    clock.observe(null, 0, 0); clock.observe("not a date", 0, 0); clock.observe("", 0, 0);
    expect(clock.bounds()).toBeNull();
    clock.observe("Sat, 17 Oct 2026 12:00:00 GMT", 1_000, 1_000);
    expect(clock.bounds()).toEqual({ lower: LOSS_AT, upper: LOSS_AT + SERVER_TIME_ACCURACY_MS });
    mono += 2_500;
    expect(clock.bounds()).toEqual({ lower: LOSS_AT + 2_500, upper: LOSS_AT + 2_500 + SERVER_TIME_ACCURACY_MS });
    clock.observe(null, mono, mono); clock.observe("garbage", mono, mono);
    expect(clock.bounds()).toEqual({ lower: LOSS_AT + 2_500, upper: LOSS_AT + 2_500 + SERVER_TIME_ACCURACY_MS });
  });
});
