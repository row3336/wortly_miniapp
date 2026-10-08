// Automatic recovery of one study action on fake clocks (M-RECOV-AUTO CP1, DESIGN D-RECOV scheme 2.3 and table 8).
// The network, the activity flag and the counter are fakes; every time below is exact (±0 ms).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { ClosedAccessError } from "../app/openedAccess";
import { systemRecoveryClock } from "./recoveryClock";
import { RecoveryMachine, type RecoveryPolicy, type RecoverySnapshot } from "./recoveryMachine";
import type { CheckResult, SendResult } from "./recoveryReplies";
import { MemorySendCounter, type SendCounter } from "./sendCounter";

type Intent = { command_id: string; kind: string; session_id: string; answer: string };
/** wire: a send whose request really started (it reached the network); a client refusal before it is not one. */
type Call = { at: number; op: "send" | "check" | "probe" | "window"; active: boolean; body?: string; wire?: boolean };

const INTENT: Intent = { command_id: "11111111-1111-4111-8111-111111111111", kind: "answer.submit",
  session_id: "22222222-2222-4222-8222-222222222222", answer: "der Tisch" };
const LOST: SendResult = { kind: "lost", cause: "network" };
const ACCEPTED: SendResult = { kind: "settled", outcome: "accepted" };
const ABSENT: CheckResult = { kind: "not_recorded" };
const RECORDED: CheckResult = { kind: "recorded", outcome: "accepted" };
const DOWN: CheckResult = { kind: "unreachable" };

type Reply<T> = T | Error | Promise<T>;
type Rig = {
  machine: RecoveryMachine<Intent>;
  calls: Call[];
  updates: RecoverySnapshot[];
  at(op?: Call["op"]): number[];
  /** Times of the POST that went out (a send refused by the client before the network excluded). */
  posts(): number[];
  ops(): Call["op"][];
  state(): RecoverySnapshot["state"]["name"];
  counter: SendCounter;
};

/** One action against a scripted server. n counts the calls of each kind from 1; t is ms since the start. */
function rig(script: {
  send?: (n: number, t: number) => Reply<SendResult>;
  check?: (n: number, t: number) => Reply<CheckResult>;
  probe?: (n: number, t: number) => Reply<boolean>;
  live?: () => boolean;
  /** The window check after DOCUMENT_STALE; default: the answer of live(). */
  windowCheck?: () => Promise<boolean>;
  active?: boolean;
  policy?: Partial<RecoveryPolicy>;
  counter?: SendCounter;
  /** Whether send n reports its start; default true for every request that reaches the network. */
  transmit?: (n: number) => boolean;
} = {}): Rig {
  const start = performance.now();
  const calls: Call[] = [], updates: RecoverySnapshot[] = [];
  const counts = { send: 0, check: 0, probe: 0 };
  const answer = async <T>(reply: Reply<T>): Promise<T> => {
    if (reply instanceof Error) throw reply;
    return reply;
  };
  const counter = script.counter ?? new MemorySendCounter();
  const machine = new RecoveryMachine<Intent>({
    intent: INTENT, counter, clock: systemRecoveryClock, active: script.active ?? true, policy: script.policy,
    onUpdate: (snapshot) => updates.push(snapshot),
    ports: {
      send: (intent, transmitted) => {
        const t = performance.now() - start, n = ++counts.send;
        const reply = (script.send ?? (() => LOST))(n, t);
        const wire = !(reply instanceof ClosedAccessError) && !(typeof reply === "object" && "kind" in reply && reply.kind === "not_sent");
        if (wire && (script.transmit ?? (() => true))(n)) transmitted();
        calls.push({ at: t, op: "send", active: machine.snapshot().active, body: JSON.stringify(intent), wire });
        return answer(reply);
      },
      check: () => {
        const t = performance.now() - start;
        calls.push({ at: t, op: "check", active: machine.snapshot().active });
        return answer((script.check ?? (() => ABSENT))(++counts.check, t));
      },
      probe: () => {
        const t = performance.now() - start;
        calls.push({ at: t, op: "probe", active: machine.snapshot().active });
        return answer((script.probe ?? (() => true))(++counts.probe, t));
      },
      isLive: script.live ?? (() => true),
      windowCheck: () => {
        calls.push({ at: performance.now() - start, op: "window", active: machine.snapshot().active });
        return script.windowCheck ? script.windowCheck() : Promise.resolve((script.live ?? (() => true))());
      },
    },
  });
  return {
    machine, calls, updates, counter,
    at: (op) => calls.filter((call) => op === undefined || call.op === op).map((call) => call.at),
    posts: () => calls.filter((call) => call.op === "send" && call.wire).map((call) => call.at),
    ops: () => calls.map((call) => call.op),
    state: () => machine.snapshot().state.name,
  };
}

/** Let the fake time pass; every reply of the fakes is a resolved promise, so the chains settle in between. */
async function pass(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** Every send after the first is immediately preceded by a check that confirmed absence (Я15.6, CT §6.1 п. 5). */
function expectCheckBeforeEveryRetry(r: Rig): void {
  r.calls.forEach((call, index) => {
    if (call.op !== "send" || index === r.calls.findIndex((c) => c.op === "send")) return;
    expect(r.calls[index - 1]?.op).toBe("check");
    expect(r.calls[index - 1]?.at).toBe(call.at);
  });
}

describe("automatic recovery of one action", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("8.1 a lost reply of a written action: one check at once, no second send, the result settles", async () => {
    const r = rig({ send: () => LOST, check: () => RECORDED });
    r.machine.begin();
    await pass(0);
    expect(r.calls).toEqual([{ at: 0, op: "send", active: true, body: JSON.stringify(INTENT), wire: true },
      { at: 0, op: "check", active: true }]);
    expect(r.machine.snapshot().state).toEqual({ name: "settled", outcome: "accepted" });
    await pass(600_000);
    expect(r.calls).toHaveLength(2);
    expect(await r.counter.load(INTENT.command_id)).toBeNull(); // the count goes with the settled action
  });

  it("8.2 confirmed absence: 2 s pause, a check right before the retry, the same command_id and the same body", async () => {
    const r = rig({ send: (n) => n === 1 ? LOST : ACCEPTED });
    r.machine.begin();
    await pass(0);
    expect(r.machine.snapshot().state).toEqual({ name: "retry_wait", attempt: 2, dueAt: expect.any(Number) });
    await pass(1_999);
    expect(r.ops()).toEqual(["send", "check"]);
    await pass(1);
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [0, "check"], [2_000, "check"], [2_000, "send"]]);
    const bodies = r.calls.filter((call) => call.op === "send").map((call) => call.body);
    expect(bodies[1]).toBe(bodies[0]);
    expect(JSON.parse(bodies[1]!)).toEqual(INTENT);
    expect(r.updates.map((u) => u.state.name)).toContain("pre_send_check");
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "settled" }, sends: 2, remaining: 4 });
    expectCheckBeforeEveryRetry(r);
  });

  it("8.3 six lost sends, absence confirmed every time: exactly 6 POST at 0, 2, 7, 17, 37, 67 s, then the exhaustion signal", async () => {
    const r = rig();
    r.machine.begin();
    await pass(600_000);
    expect(r.at("send")).toEqual([0, 2_000, 7_000, 17_000, 37_000, 67_000]);
    expectCheckBeforeEveryRetry(r);
    expect(r.machine.snapshot()).toEqual({ state: { name: "exhausted" }, sends: 6, transmitted: 6, remaining: 0, active: true });
    // The exhaustion follows the check after the sixth loss; nothing runs afterwards (the stop itself is CP4).
    expect(r.calls.at(-1)).toEqual({ at: 67_000, op: "check", active: true });
    expect(r.at("probe")).toEqual([]);
  });

  it("8.4 three minutes without a server: probes at 5, 15, 35, 65, 95… s, no POST and no spent budget; then a check and the retry", async () => {
    const outage = 180_000;
    const r = rig({
      check: (_n, t) => t < outage ? DOWN : ABSENT,
      probe: (_n, t) => t >= outage,
    });
    r.machine.begin();
    await pass(outage - 1);
    expect(r.at("probe")).toEqual([5_000, 15_000, 35_000, 65_000, 95_000, 125_000, 155_000]);
    expect(r.at("send")).toEqual([0]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "unreachable", probe: 8 }, sends: 1, remaining: 5 });
    await pass(5_001);
    // The 2 s pause ran from the loss at 0 (question 11.2): the retry follows the confirming check at once.
    // (The last check follows the loss of that retry.)
    expect(r.calls.filter((call) => call.at === 185_000).map((call) => call.op)).toEqual(["probe", "check", "send", "check"]);
    await pass(600_000);
    // Probes and checks never spent the budget: all five retries were still there.
    expect(r.at("send")).toEqual([0, 185_000, 190_000, 200_000, 220_000, 250_000]);
    expect(r.state()).toBe("exhausted");
  });

  it("8.5 background during RETRY_WAIT: nothing is requested; the return checks first and keeps the used budget", async () => {
    const r = rig({ send: (n) => n <= 2 ? LOST : ACCEPTED });
    r.machine.begin();
    await pass(2_000); // second send at 2 s, lost; next pause 5 s
    expect(r.at("send")).toEqual([0, 2_000]);
    await pass(1_000);
    r.machine.setActive(false);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "suspended" }, sends: 2, active: false });
    const before = r.calls.length;
    await pass(600_000);
    expect(r.calls).toHaveLength(before);
    r.machine.setActive(true);
    await pass(0);
    // Back after the 5 s pause has passed: a check, then the third send at once.
    expect(r.calls.slice(before).map(({ at, op }) => [at, op])).toEqual([[603_000, "check"], [603_000, "send"]]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "settled" }, sends: 3 });
  });

  it("8.5 background during UNREACHABLE: no probes; the return is a fact check, not a probe", async () => {
    let up = false;
    const r = rig({ send: (n) => n === 1 ? LOST : ACCEPTED, check: () => up ? ABSENT : DOWN, probe: () => up });
    r.machine.begin();
    await pass(6_000); // probe at 5 s failed
    expect(r.at("probe")).toEqual([5_000]);
    r.machine.setActive(false);
    await pass(300_000);
    expect(r.at("probe")).toEqual([5_000]);
    up = true;
    r.machine.setActive(true);
    await pass(0);
    expect(r.calls.slice(-2).map(({ at, op }) => [at, op])).toEqual([[306_000, "check"], [306_000, "send"]]);
    expect(r.machine.snapshot().sends).toBe(2);
  });

  it("8.5 a reply that arrives in the background is ignored; the return establishes the fact by a check", async () => {
    let release!: (reply: SendResult) => void;
    const r = rig({ send: () => new Promise<SendResult>((resolve) => { release = resolve; }), check: () => RECORDED });
    r.machine.begin();
    await pass(0);
    r.machine.setActive(false);
    release(LOST);
    await pass(60_000);
    expect(r.ops()).toEqual(["send"]);
    r.machine.setActive(true);
    await pass(0);
    expect(r.ops()).toEqual(["send", "check"]);
    expect(r.state()).toBe("settled");
  });

  it("8.6 a reload after 3 sends (stage 1): the new document only checks — no POST, no exhaustion", async () => {
    const first = rig();
    first.machine.begin();
    await pass(7_000);
    expect(first.at("send")).toEqual([0, 2_000, 7_000]);
    first.machine.dispose();
    const silent = first.calls.length;
    // A new document has a new, empty memory counter: the count is unknown.
    const reloaded = rig();
    reloaded.machine.resume();
    await pass(0);
    expect(reloaded.machine.snapshot()).toEqual({ state: { name: "counter_unknown", check: 1, cause: "unknown" }, sends: null, transmitted: null,
      remaining: null, active: true });
    await pass(600_000);
    expect(reloaded.at("send")).toEqual([]);
    expect(reloaded.at("check").slice(0, 6)).toEqual([0, 5_000, 15_000, 35_000, 65_000, 95_000]);
    expect(reloaded.updates.map((u) => u.state.name)).not.toContain("exhausted");
    expect(first.calls).toHaveLength(silent); // the disposed document stayed silent
  });

  it("8.6 after a reload the recorded result is still restored without a count", async () => {
    const r = rig({ check: () => RECORDED });
    r.machine.resume();
    await pass(0);
    expect(r.ops()).toEqual(["check"]);
    expect(r.state()).toBe("settled");
  });

  it("8.7 (stage 1 form) a machine re-created inside the same document continues the count: 3 + 3 sends", async () => {
    const counter = new MemorySendCounter();
    const first = rig({ counter });
    first.machine.begin();
    await pass(7_000);
    first.machine.dispose();
    const again = rig({ counter });
    again.machine.resume();
    await pass(600_000);
    // No loss time is known after re-creation: each pause is a full pause from the confirming check.
    expect(again.at("send")).toEqual([10_000, 30_000, 60_000]);
    expect(again.machine.snapshot()).toMatchObject({ state: { name: "exhausted" }, sends: 6 });
  });

  it("8.9 COMMAND_PAYLOAD_MISMATCH on POST: the conflict, nothing is sent or checked afterwards", async () => {
    const r = rig({ send: () => new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH") });
    r.machine.begin();
    await pass(600_000);
    expect(r.ops()).toEqual(["send"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "conflict" }, sends: 1 });
  });

  it("8.9 COMMAND_PAYLOAD_MISMATCH on the check before a retry: the conflict, no retry", async () => {
    const r = rig({ check: (n) => n === 1 ? ABSENT : { kind: "mismatch" } });
    r.machine.begin();
    await pass(600_000);
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [0, "check"], [2_000, "check"]]);
    expect(r.state()).toBe("conflict");
  });

  it("8.10 a planned pause of 2 min (MAINTENANCE): the send stays spent, no POST before the announced end even if the probe answers", async () => {
    const pause = 120_000;
    const r = rig({
      send: (_n, t) => t < pause ? new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 120 }) : ACCEPTED,
      probe: () => true, // the probe route need not know about the pause
    });
    r.machine.begin();
    await pass(0);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "maintenance", probe: 1, pauseSeconds: 120, budgetSpent: false },
      sends: 1, transmitted: 1 });
    await pass(600_000);
    expect(r.posts()).toEqual([0, 120_000]);
    expect(r.calls.filter((call) => call.at < pause).map((call) => call.op)).toEqual(["send"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "settled" }, sends: 2 });
  });

  it("8.10 / D2 an endless planned pause without an estimate and a probe that answers: ≤ 6 POST, the quiz is not closed", async () => {
    const r = rig({ send: () => new ApiError("http", 503, "MAINTENANCE"), probe: () => true });
    r.machine.begin();
    await pass(3_600_000);
    // Pauses in a row keep the probe schedule growing; each POST still waits for an answering probe and a check.
    expect(r.posts()).toEqual([0, 5_000, 15_000, 35_000, 65_000, 95_000]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "maintenance", budgetSpent: true }, sends: 6, transmitted: 6 });
    expect(r.updates.map((update) => update.state.name)).not.toContain("exhausted");
    expect(await r.counter.load(INTENT.command_id)).toEqual({ reserved: 6, transmitted: 6, lastMaintenance: true });
  });

  it("Н10 / D17 a machine re-created on the shared count {6, 6, last in a pause}: the pause again, not an exhaustion", async () => {
    const counter = new MemorySendCounter();
    const first = rig({ counter, send: (n) => n < 6 ? LOST : new ApiError("http", 503, "MAINTENANCE") });
    first.machine.begin();
    await pass(600_000);
    expect(first.machine.snapshot().state).toMatchObject({ name: "maintenance", budgetSpent: true });
    first.machine.dispose();
    const again = rig({ counter });
    again.machine.resume();
    await pass(600_000);
    expect(again.posts()).toEqual([]);
    expect(again.machine.snapshot()).toMatchObject({ state: { name: "maintenance", budgetSpent: true }, sends: 6, transmitted: 6 });
    expect(again.updates.map((update) => update.state.name)).not.toContain("exhausted");
    // An older record without the flag is {6, 6} with lastMaintenance false: the exhaustion stays as before.
    const old = new MemorySendCounter();
    await old.save(INTENT.command_id, { reserved: 6, transmitted: 6 });
    const plain = rig({ counter: old });
    plain.machine.resume();
    await pass(0);
    expect(plain.state()).toBe("exhausted");
  });

  it("Н10 the flag is cleared when a later send meets no pause", async () => {
    const r = rig({ send: (n) => n === 1 ? new ApiError("http", 503, "MAINTENANCE") : LOST, check: (n) => n <= 2 ? ABSENT : DOWN,
      probe: (n) => n === 1 });
    r.machine.begin();
    await pass(0);
    expect(await r.counter.load(INTENT.command_id)).toEqual({ reserved: 1, transmitted: 1, lastMaintenance: true });
    await pass(5_000);
    expect(await r.counter.load(INTENT.command_id)).toEqual({ reserved: 2, transmitted: 2 });
  });

  it("8.10 / D4 an overrun pause (wait 0) whose readiness probe refuses, with returns from the background: one POST, no close", async () => {
    const r = rig({ send: () => new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 0 }), probe: () => false });
    r.machine.begin();
    for (let trip = 0; trip < 8; trip++) {
      await pass(60_000);
      r.machine.setActive(false);
      await pass(1_000);
      r.machine.setActive(true);
    }
    await pass(1_000);
    expect(r.posts()).toEqual([0]);
    expect(r.at("check")).toEqual([]); // a return in a pause starts with a probe, never a fact check or a POST
    expect(r.at("probe").filter((at) => at % 61_000 === 0).length).toBe(8);
    expect(r.machine.snapshot().state).toMatchObject({ name: "maintenance", budgetSpent: false });
  });

  it("8.10 / D3 a pause with an estimate through background trips: no probe and no POST before its announced end", async () => {
    const r = rig({ send: (_n, t) => t < 120_000 ? new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 120 }) : ACCEPTED,
      probe: () => true });
    r.machine.begin();
    for (let trip = 0; trip < 8; trip++) {
      await pass(7_000);
      r.machine.setActive(false);
      await pass(3_000);
      r.machine.setActive(true);
    }
    await pass(600_000);
    expect(r.calls.filter((call) => call.at > 0 && call.at < 120_000)).toEqual([]);
    expect(r.posts()).toEqual([0, 120_000]);
    expect(r.state()).toBe("settled");
  });

  it("8.10 the fact check meets the planned pause: the same pause, probes first, then a check and the retry", async () => {
    const r = rig({ send: (n) => n === 1 ? LOST : ACCEPTED,
      check: (n) => n === 1 ? new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 30 }) : ABSENT, probe: () => true });
    r.machine.begin();
    await pass(0);
    expect(r.machine.snapshot().state).toEqual({ name: "maintenance", probe: 1, pauseSeconds: 30, budgetSpent: false });
    await pass(600_000);
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [0, "check"], [30_000, "probe"], [30_000, "check"], [30_000, "send"]]);
    expect(r.state()).toBe("settled");
  });

  it("8.10 an answering probe ends the pause: a later outage is an ordinary one and a return checks the fact first", async () => {
    const r = rig({ send: (n) => n === 1 ? new ApiError("http", 503, "MAINTENANCE") : ACCEPTED, probe: () => true,
      check: (n) => n === 1 ? DOWN : ABSENT });
    r.machine.begin();
    await pass(5_000);
    // The check after the answering probe failed: an ordinary unreachable state, the same episode (Н7).
    expect(r.machine.snapshot().state).toEqual({ name: "unreachable", probe: 2, pauseSeconds: null });
    r.machine.setActive(false);
    await pass(2_000);
    r.machine.setActive(true);
    await pass(0);
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [5_000, "probe"], [5_000, "check"], [7_000, "check"], [7_000, "send"]]);
    expect(r.state()).toBe("settled");
  });

  it("8.10 six sends with the last one in a pause: the pause ends by a probe and a check that finds the action written", async () => {
    let up = false;
    const r = rig({ send: (n) => n < 6 ? LOST : new ApiError("http", 503, "MAINTENANCE"), check: () => up ? RECORDED : ABSENT,
      probe: () => up });
    r.machine.begin();
    await pass(600_000);
    expect(r.posts()).toHaveLength(6);
    expect(r.machine.snapshot().state).toMatchObject({ name: "maintenance", budgetSpent: true });
    up = true;
    await pass(60_000);
    expect(r.posts()).toHaveLength(6);
    expect(r.state()).toBe("settled");
  });

  it("8.11 WRITE_UNAVAILABLE is an ordinary loss: counted, checked at once, retried after the pause", async () => {
    const r = rig({ send: (n) => n === 1 ? new ApiError("http", 503, "WRITE_UNAVAILABLE") : ACCEPTED });
    r.machine.begin();
    await pass(0);
    expect(r.ops()).toEqual(["send", "check"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "retry_wait" }, sends: 1, transmitted: 1 });
    expect(await r.counter.load(INTENT.command_id)).toEqual({ reserved: 1, transmitted: 1 });
    await pass(600_000);
    expect(r.posts()).toEqual([0, 2_000]);
  });

  it("8.12 the session closed or the step moved on while waiting: terminated, no further sends", async () => {
    const closed = rig({ check: (n) => n === 1 ? ABSENT : { kind: "terminated", reason: "session_closed" } });
    closed.machine.begin();
    await pass(600_000);
    expect(closed.ops()).toEqual(["send", "check", "check"]);
    expect(closed.machine.snapshot().state).toEqual({ name: "terminated", reason: "session_closed" });
    const moved = rig({ check: (_n, t) => t < 30_000 ? DOWN : { kind: "terminated", reason: "step_stale" } });
    moved.machine.begin();
    await pass(600_000);
    expect(moved.at("send")).toEqual([0]);
    expect(moved.machine.snapshot().state).toEqual({ name: "terminated", reason: "step_stale" });
  });

  it("8.13 401/403 while waiting: terminated, sends stop", async () => {
    const r = rig({ check: (n) => n === 1 ? ABSENT : new ApiError("http", 403, "FORBIDDEN") });
    r.machine.begin();
    await pass(600_000);
    expect(r.ops()).toEqual(["send", "check", "check"]);
    expect(r.machine.snapshot().state).toEqual({ name: "terminated", reason: "access_lost" });
    const post = rig({ send: () => new ApiError("http", 401) });
    post.machine.begin();
    await pass(600_000);
    expect(post.machine.snapshot().state).toEqual({ name: "terminated", reason: "access_lost" });
    expect(post.ops()).toEqual(["send"]);
  });

  it("8.14 DOCUMENT_STALE on a retry, the window check confirms a replacement: terminated, nothing more is sent", async () => {
    let live = true;
    let decide!: (live: boolean) => void;
    const r = rig({ send: (n) => n === 1 ? LOST : new ApiError("http", 409, "DOCUMENT_STALE"), live: () => live,
      windowCheck: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    r.machine.begin();
    await pass(2_000);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "window_check" }, sends: 2, transmitted: 2 });
    await pass(600_000); // the check is slow: no POST, no check, no probe meanwhile
    expect(r.ops()).toEqual(["send", "check", "check", "send", "window"]);
    live = false;
    decide(false);
    await pass(600_000);
    expect(r.ops()).toEqual(["send", "check", "check", "send", "window"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "terminated", reason: "window_replaced" }, sends: 2 });
  });

  it("8.14 the window check answers 'replaced' before isLive() turns false: its answer alone terminates", async () => {
    const r = rig({ send: () => new ApiError("http", 409, "DOCUMENT_STALE"), windowCheck: async () => false });
    r.machine.begin();
    await pass(600_000);
    expect(r.ops()).toEqual(["send", "window"]);
    expect(r.machine.snapshot().state).toEqual({ name: "terminated", reason: "window_replaced" });
  });

  it("8.14 DOCUMENT_STALE to a live window (a closed card context): the window check keeps it, recovery goes on with a check", async () => {
    let decide!: (live: boolean) => void;
    const r = rig({ send: (n) => n === 1 ? LOST : n === 2 ? new ApiError("http", 409, "DOCUMENT_STALE") : ACCEPTED,
      windowCheck: () => new Promise<boolean>((resolve) => { decide = resolve; }) });
    r.machine.begin();
    await pass(2_000);
    await pass(30_000);
    expect(r.at("send")).toEqual([0, 2_000]);
    decide(true);
    await pass(0);
    // The same remaining budget: the stale send stays counted, the next one is №3 after its pause from the stale answer.
    expect(r.calls.slice(-2).map(({ at, op }) => [at, op])).toEqual([[32_000, "check"], [32_000, "send"]]);
    await pass(600_000);
    expect(r.ops()).toEqual(["send", "check", "check", "send", "window", "check", "send"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "settled" }, sends: 3, transmitted: 3 });
  });

  it("8.14 DOCUMENT_STALE on the fact check: the same window check; a document that is no longer live ends without a send", async () => {
    const r = rig({ check: (n) => n === 1 ? new ApiError("http", 409, "DOCUMENT_STALE") : RECORDED });
    r.machine.begin();
    await pass(600_000);
    // The live window waits for the probe schedule (5 s) before the next check.
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [0, "check"], [0, "window"], [5_000, "probe"], [5_000, "check"]]);
    expect(r.state()).toBe("settled");
    let live = true;
    const replaced = rig({ live: () => live });
    replaced.machine.begin();
    await pass(1_000);
    live = false;
    await pass(600_000);
    expect(replaced.at("send")).toEqual([0]);
    expect(replaced.ops()).toEqual(["send", "check"]);
    expect(replaced.machine.snapshot().state).toEqual({ name: "terminated", reason: "window_replaced" });
  });

  it("Н11 / W4 every check meets DOCUMENT_STALE and the window stays live: checks on the probe schedule, never a tight loop", async () => {
    const r = rig({ send: () => LOST, check: () => new ApiError("http", 409, "DOCUMENT_STALE"), windowCheck: async () => true });
    r.machine.begin();
    await pass(0);
    expect(r.at("check")).toEqual([0]);
    await pass(200_000);
    expect(r.at("check")).toEqual([0, 5_000, 15_000, 35_000, 65_000, 95_000, 125_000, 155_000, 185_000]);
    expect(r.at("window")).toHaveLength(r.at("check").length);
    expect(r.posts()).toEqual([0]);
  });

  it("8.20 a failed counter write: the POST does not go out, the count is unknown, only checks follow", async () => {
    const failing: SendCounter = {
      load: async () => null,
      save: async () => { throw new Error("quota"); },
      clear: async () => undefined,
    };
    const r = rig({ counter: failing });
    r.machine.begin();
    await pass(600_000);
    expect(r.at("send")).toEqual([]);
    expect(r.at("check").slice(0, 3)).toEqual([5_000, 15_000, 35_000]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "counter_unknown" }, sends: null });
  });

  it("a failed counter write before a retry stops the retries; the recorded fact still settles", async () => {
    let fail = false;
    const counter = new MemorySendCounter();
    const flaky: SendCounter = {
      load: (id) => counter.load(id),
      save: (id, marks) => fail ? Promise.reject(new Error("quota")) : counter.save(id, marks),
      clear: (id) => counter.clear(id),
    };
    const r = rig({ counter: flaky, check: (_n, t) => t < 100_000 ? ABSENT : RECORDED });
    r.machine.begin();
    await pass(0);
    fail = true;
    await pass(99_000);
    expect(r.at("send")).toEqual([0]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "counter_unknown" }, sends: null });
    await pass(200_000);
    expect(r.state()).toBe("settled");
  });

  it("2.13 a stale answer of the check proves nothing: wait for the server and check again, never send", async () => {
    const r = rig({ check: (n) => n === 1 ? { kind: "stale" } : RECORDED });
    r.machine.begin();
    await pass(600_000);
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [0, "check"], [5_000, "probe"], [5_000, "check"]]);
    expect(r.state()).toBe("settled");
  });

  it("2.9 CLIENT_INCOMPATIBLE stops the automatic sends for good; the send stays spent", async () => {
    const r = rig({ send: () => new ApiError("http", 409, "CLIENT_INCOMPATIBLE") });
    r.machine.begin();
    await pass(600_000);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "terminated", reason: "client_incompatible" }, sends: 1, transmitted: 1 });
    expect(r.ops()).toEqual(["send"]);
  });

  it("a known refusal of the POST settles it; a recorded rejection found by the check settles it too", async () => {
    const refused = rig({ send: () => ({ kind: "settled", outcome: "rejected" }) });
    refused.machine.begin();
    await pass(0);
    expect(refused.machine.snapshot().state).toEqual({ name: "settled", outcome: "rejected" });
    const found = rig({ check: () => ({ kind: "recorded", outcome: "rejected" }) });
    found.machine.begin();
    await pass(0);
    expect(found.machine.snapshot().state).toEqual({ name: "settled", outcome: "rejected" });
  });

  it("11.2 the other answer: the retry pause runs from the confirming check", async () => {
    const outage = 60_000;
    const r = rig({ check: (_n, t) => t < outage ? DOWN : ABSENT, probe: (_n, t) => t >= outage,
      send: (n) => n === 1 ? LOST : ACCEPTED, policy: { retryPauseFrom: "confirmation" } });
    r.machine.begin();
    await pass(600_000);
    // Probes 5, 15, 35, 65 s; the check at 65 s confirms, the retry waits the full 2 s after it.
    expect(r.calls.slice(-4).map(({ at, op }) => [at, op])).toEqual([[65_000, "probe"], [65_000, "check"], [67_000, "check"], [67_000, "send"]]);
  });

  it("11.1 the other answer: the first check waits for the pause of the next retry", async () => {
    const r = rig({ send: (n) => n === 1 ? LOST : ACCEPTED, policy: { checkAfterLoss: "after_pause" } });
    r.machine.begin();
    await pass(600_000);
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [2_000, "check"], [2_000, "send"]]);
  });

  it("11.3 every unreachable episode starts probing at 5 s again; the other answer continues the schedule", async () => {
    const script = (probeSchedule: RecoveryPolicy["probeSchedule"]) => rig({
      // Down; the third probe answers and the check confirms absence; the retry is lost and the server is down again.
      check: (n) => n === 2 ? ABSENT : DOWN,
      probe: (n) => n === 3,
      policy: { probeSchedule },
    });
    const fresh = script("per_episode");
    fresh.machine.begin();
    await pass(200_000);
    expect(fresh.posts()).toEqual([0, 35_000]);
    expect(fresh.at("probe").slice(0, 5)).toEqual([5_000, 15_000, 35_000, 40_000, 50_000]);
    const continued = script("continue");
    continued.machine.begin();
    await pass(200_000);
    expect(continued.at("probe").slice(0, 5)).toEqual([5_000, 15_000, 35_000, 65_000, 95_000]);
  });

  it("Н7 the probe answers but the fact check keeps failing: the same episode, pauses still grow 5, 10, 20, 30 s", async () => {
    const r = rig({ check: () => DOWN, probe: () => true });
    r.machine.begin();
    await pass(200_000);
    expect(r.at("probe")).toEqual([5_000, 15_000, 35_000, 65_000, 95_000, 125_000, 155_000, 185_000]);
    expect(r.at("check")).toEqual([0, 5_000, 15_000, 35_000, 65_000, 95_000, 125_000, 155_000, 185_000]);
  });

  it("a monotonic clock: a wall-clock jump back neither stretches nor restarts a passed retry pause", async () => {
    const r = rig({ send: (n) => n === 1 ? LOST : ACCEPTED, check: (n) => n === 1 ? DOWN : ABSENT });
    r.machine.begin();
    await pass(1_000);
    vi.setSystemTime(Date.now() - 3_600_000);
    await pass(4_000);
    // Probe at 5 s, the check confirms absence; the 2 s pause since the loss has passed on the monotonic clock.
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [0, "check"], [5_000, "probe"], [5_000, "check"], [5_000, "send"]]);
  });

  it("begun in the background: nothing is sent until the window is active; then a check and the first send", async () => {
    const r = rig({ active: false, send: () => ACCEPTED });
    r.machine.begin();
    await pass(60_000);
    expect(r.calls).toEqual([]);
    expect(r.state()).toBe("suspended");
    r.machine.setActive(true);
    await pass(0);
    expect(r.ops()).toEqual(["check", "send"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "settled" }, sends: 1 });
  });

  it("a resumed action loads its count before the check even if the window returns meanwhile", async () => {
    const counter = new MemorySendCounter();
    await counter.save(INTENT.command_id, { reserved: 5, transmitted: 5 });
    const r = rig({ counter, active: false });
    r.machine.resume();
    r.machine.setActive(true);
    await pass(600_000);
    expect(r.at("send")).toEqual([30_000]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "exhausted" }, sends: 6 });
  });

  it("begin and resume act once; terminate and dispose silence everything that is still scheduled", async () => {
    const r = rig();
    r.machine.begin(); r.machine.begin(); r.machine.resume();
    await pass(0);
    expect(r.at("send")).toEqual([0]);
    r.machine.terminate("window_replaced");
    await pass(600_000);
    expect(r.ops()).toEqual(["send", "check"]);
    expect(r.machine.snapshot().state).toEqual({ name: "terminated", reason: "window_replaced" });
    r.machine.terminate("access_lost");
    expect(r.machine.snapshot().state).toEqual({ name: "terminated", reason: "window_replaced" });

    const d = rig();
    d.machine.begin();
    await pass(0);
    const updates = d.updates.length;
    d.machine.dispose();
    await pass(600_000);
    expect(d.ops()).toEqual(["send", "check"]);
    expect(d.updates).toHaveLength(updates);
    expect(d.state()).toBe("disposed");
  });

  it("a final state ignores activity changes", async () => {
    const r = rig({ send: () => ACCEPTED });
    r.machine.begin();
    await pass(0);
    r.machine.setActive(false); r.machine.setActive(true);
    await pass(600_000);
    expect(r.ops()).toEqual(["send"]);
    expect(r.state()).toBe("settled");
  });

  it("Q21/Q23 the hard limit: no policy and no mix of answers ever gets more than 6 POST; no request in the background", async () => {
    let seed = 20261008;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = <T>(items: readonly (readonly [number, () => T])[]): T => {
      let x = random() * items.reduce((sum, [weight]) => sum + weight, 0);
      for (const [weight, make] of items) { x -= weight; if (x < 0) return make(); }
      return items[items.length - 1][1]();
    };
    const policies: Partial<RecoveryPolicy>[] = [];
    for (const checkAfterLoss of ["immediate", "after_pause"] as const)
      for (const retryPauseFrom of ["loss", "confirmation"] as const)
        for (const probeSchedule of ["per_episode", "continue"] as const) policies.push({ checkAfterLoss, retryPauseFrom, probeSchedule });
    let exhausted = 0;
    for (const policy of policies) {
      for (let run = 0; run < 25; run++) {
        const r = rig({
          policy,
          transmit: () => random() < 0.9,
          send: () => pick<Reply<SendResult>>([
            [40, () => LOST], [15, () => new ApiError("http", 503, "WRITE_UNAVAILABLE")],
            [15, () => new ApiError("http", 503, "MAINTENANCE", { waitSeconds: random() < 0.5 ? null : Math.floor(random() * 200) })],
            [10, () => new ClosedAccessError()], [2, () => new ApiError("http", 409, "CLIENT_INCOMPATIBLE")], [3, () => ACCEPTED],
          ]),
          check: () => pick<Reply<CheckResult>>([
            [55, () => ABSENT], [20, () => DOWN], [10, () => ({ kind: "stale" })],
            [10, () => new ApiError("http", 503, "MAINTENANCE", { waitSeconds: Math.floor(random() * 100) })], [5, () => RECORDED],
          ]),
          probe: () => random() < 0.7,
        });
        r.machine.begin();
        for (let step = 0; step < 300; step++) {
          if (random() < 0.05) r.machine.setActive(!r.machine.snapshot().active);
          await pass(Math.floor(random() * 15_000));
        }
        const snapshot = r.machine.snapshot();
        expect(r.posts().length).toBeLessThanOrEqual(6);
        expect(r.calls.every((call) => call.active)).toBe(true);
        if (snapshot.sends !== null) expect(r.posts().length).toBeLessThanOrEqual(snapshot.sends);
        if (snapshot.state.name === "exhausted") { exhausted++; expect(snapshot.transmitted).toBe(6); }
        r.machine.dispose();
      }
    }
    expect(exhausted).toBeGreaterThan(0); // the mix does reach the limit, so the bound is exercised
  }, 30_000); // hundreds of fake-clock runs: the default 5 s is too tight under a loaded machine

  it("Q22 checkAfterLoss=after_pause with retryPauseFrom=confirmation: one pause, not two; after an outage the full pause", async () => {
    const plain = rig({ send: (n) => n === 1 ? LOST : ACCEPTED, policy: { checkAfterLoss: "after_pause", retryPauseFrom: "confirmation" } });
    plain.machine.begin();
    await pass(600_000);
    expect(plain.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [2_000, "check"], [2_000, "send"]]);
    const outage = rig({ send: (n) => n === 1 ? LOST : ACCEPTED, check: (n) => n === 1 ? DOWN : ABSENT,
      policy: { checkAfterLoss: "after_pause", retryPauseFrom: "confirmation" } });
    outage.machine.begin();
    await pass(600_000);
    // Check at 2 s fails, probe at 7 s answers and the check confirms; the retry then waits the full 2 s.
    expect(outage.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [2_000, "check"], [7_000, "probe"], [7_000, "check"],
      [9_000, "check"], [9_000, "send"]]);
  });

  it("Q24 422 VALIDATION_FAILED and 409 VERSION_CONFLICT: a definite refusal, one POST, no checks, no retries", async () => {
    for (const [status, code] of [[422, "VALIDATION_FAILED"], [409, "VERSION_CONFLICT"]] as const) {
      const r = rig({ send: () => new ApiError("http", status, code) });
      r.machine.begin();
      await pass(600_000);
      expect(r.ops()).toEqual(["send"]);
      expect(r.machine.snapshot()).toMatchObject({ state: { name: "refused", code }, sends: 1, transmitted: 1 });
    }
  });

  it("Q25 a corrupt loaded count is not trusted: only checks, no POST, no exhaustion", async () => {
    const corrupt: unknown[] = [7, -1, 2.5, Number.NaN, "3", { reserved: 7, transmitted: 7 }, { reserved: -1, transmitted: 0 },
      { reserved: 2.5, transmitted: 1 }, { reserved: 3, transmitted: 4 }, { reserved: 3 }, { reserved: 6, transmitted: 6, lastMaintenance: "yes" }, null];
    for (const value of corrupt) {
      const counter: SendCounter = { load: async () => value as never, save: async () => undefined, clear: async () => undefined };
      const r = rig({ counter });
      r.machine.resume();
      await pass(600_000);
      expect(r.posts()).toEqual([]);
      expect(r.at("check").slice(0, 4)).toEqual([0, 5_000, 15_000, 35_000]);
      expect(r.machine.snapshot()).toMatchObject({ state: { name: "counter_unknown", cause: "unknown" }, sends: null });
      r.machine.dispose();
    }
  });

  it("Н6 a snapshot is never repeated unchanged; a final state does not report activity changes", async () => {
    const r = rig();
    r.machine.begin();
    await pass(600_000);
    expect(r.state()).toBe("exhausted");
    const count = r.updates.length;
    r.machine.setActive(false); r.machine.setActive(true); r.machine.setActive(false);
    await pass(60_000);
    expect(r.updates).toHaveLength(count);
    const keys = r.updates.map((update) => JSON.stringify(update));
    keys.forEach((key, index) => { if (index > 0) expect(key).not.toBe(keys[index - 1]); });
  });

  it("two marks: reserved before the network, transmitted once the request starts", async () => {
    const counter = new MemorySendCounter();
    const seen: unknown[] = [];
    const r = rig({ counter, transmit: () => false, send: async () => { seen.push(await counter.load(INTENT.command_id)); return LOST; } });
    r.machine.begin();
    await pass(0);
    expect(seen).toEqual([{ reserved: 1, transmitted: 0 }]); // reserved before the POST, nothing proven sent yet
    const marked = rig({ counter: new MemorySendCounter(), send: () => ACCEPTED });
    marked.machine.begin();
    await pass(0);
    expect(marked.machine.snapshot()).toMatchObject({ sends: 1, transmitted: 1 });
  });

  it("two marks: a reservation stopped before the network (background) is given back; the return sends #1, not #2", async () => {
    let unblock!: () => void;
    const memory = new MemorySendCounter();
    let first = true;
    const slow: SendCounter = {
      load: (id) => memory.load(id),
      save: (id, marks) => {
        if (!first) return memory.save(id, marks);
        first = false;
        return new Promise<void>((resolve) => { unblock = () => { void memory.save(id, marks).then(resolve); }; });
      },
      clear: (id) => memory.clear(id),
    };
    const r = rig({ counter: slow, send: () => ACCEPTED });
    r.machine.begin();
    await pass(0);
    r.machine.setActive(false);
    unblock();
    await pass(10_000);
    expect(r.calls).toEqual([]);
    expect(r.machine.snapshot()).toMatchObject({ sends: 0, transmitted: 0 });
    expect(await memory.load(INTENT.command_id)).toEqual({ reserved: 0, transmitted: 0 });
    r.machine.setActive(true);
    await pass(0);
    expect(r.ops()).toEqual(["check", "send"]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "settled" }, sends: 1, transmitted: 1 });
  });

  it("two marks: a client refusal before the network (ClosedAccessError) is not a send and does not loop", async () => {
    const r = rig({ send: (n) => n === 1 ? new ClosedAccessError() : ACCEPTED });
    r.machine.begin();
    await pass(600_000);
    expect(r.calls.map(({ at, op }) => [at, op])).toEqual([[0, "send"], [5_000, "probe"], [5_000, "check"], [5_000, "send"]]);
    expect(r.posts()).toEqual([5_000]);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "settled" }, sends: 1, transmitted: 1 });
  });

  it("two marks: six reservations but one never proven sent — no exhaustion, only checks (root decision, pending owner)", async () => {
    const r = rig({ transmit: (n) => n !== 3 });
    r.machine.begin();
    await pass(600_000);
    expect(r.posts()).toHaveLength(6);
    expect(r.machine.snapshot()).toMatchObject({ state: { name: "counter_unknown", cause: "unconfirmed" }, sends: 6, transmitted: 5 });
    expect(r.updates.map((update) => update.state.name)).not.toContain("exhausted");
    const checks = r.at("check").length;
    await pass(600_000);
    expect(r.posts()).toHaveLength(6);
    expect(r.at("check").length).toBeGreaterThan(checks);
  });

  it("two marks after a reload (durable form): 6 reserved and 5 transmitted only checks; 6 and 6 exhausts after the check", async () => {
    const unconfirmed = new MemorySendCounter();
    await unconfirmed.save(INTENT.command_id, { reserved: 6, transmitted: 5 });
    const a = rig({ counter: unconfirmed });
    a.machine.resume();
    await pass(600_000);
    expect(a.posts()).toEqual([]);
    expect(a.state()).toBe("counter_unknown");
    const spent = new MemorySendCounter();
    await spent.save(INTENT.command_id, { reserved: 6, transmitted: 6 });
    const b = rig({ counter: spent });
    b.machine.resume();
    await pass(0);
    expect(b.ops()).toEqual(["check"]);
    expect(b.state()).toBe("exhausted");
  });

  it("Н9 the adapter did not report the start, but the server answered: the answer counts as a transmission", async () => {
    for (const reply of [ACCEPTED, { kind: "settled", outcome: "rejected" } as const, { kind: "mismatch" } as const,
      new ApiError("http", 503, "MAINTENANCE"), new ApiError("http", 409, "CLIENT_INCOMPATIBLE"),
      new ApiError("http", 422, "VALIDATION_FAILED"), new ApiError("http", 403)]) {
      const r = rig({ transmit: () => false, send: () => reply });
      r.machine.begin();
      await pass(0);
      expect(r.machine.snapshot()).toMatchObject({ sends: 1, transmitted: 1 });
      r.machine.dispose();
    }
    // A lost reply without the report proves nothing: the send stays only reserved.
    const lost = rig({ transmit: () => false, send: () => LOST, check: () => DOWN, probe: () => false });
    lost.machine.begin();
    await pass(0);
    expect(lost.machine.snapshot()).toMatchObject({ sends: 1, transmitted: 0 });
  });
});
