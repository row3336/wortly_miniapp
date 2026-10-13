// What an earlier owner of the same document hands to the next one about the next send (M-RETRY-DUE v2, CT §6.1 п. 4):
// the rest of the pause after a loss, the announced end of a planned pause, and nothing from a replaced owner.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { PendingStoreError } from "./pendingSlot";
import { LaneRecovery, type LaneRecoveryHost, type RecoveryIntent, type RecoveryLaneState } from "./laneRecovery";
import { systemRecoveryClock } from "./recoveryClock";
import { RETRY_PAUSES_MS } from "./recoveryLimits";
import { MemorySendCounter, type SendCounter } from "./sendCounter";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SESSION = id(9);
const X: RecoveryIntent = { command_id: id(50), kind: "answer.submit", session_id: SESSION };
const Y: RecoveryIntent = { command_id: id(51), kind: "answer.submit", session_id: SESSION };
const DOCUMENT = "p1:c1:d1:1";

type Reply = "lost" | "accepted" | { maintenance: number };
/** refuseFirstSave: the first save of a new intent is refused locally over another record in the shared slot. */
type Server = { down: boolean; maintenance: number | null; replies: Reply[]; hold: Promise<void> | null; refuseFirstSave: boolean };
type Call = { at: number; op: "post" | "check"; commandId: string };

/** One page: a server, a clock origin and the calls every owner made, in order. */
function page() {
  const server: Server = { down: false, maintenance: null, replies: [], hold: null, refuseFirstSave: false };
  const calls: Call[] = [];
  const t0 = performance.now();
  const now = () => performance.now() - t0;
  let lostAt = -1;
  /** held: the lane already holds the intent (a stored record); a new action starts with an empty lane. */
  const owner = (counter: SendCounter, scope: string | undefined, intent: RecoveryIntent = X, held = true) => {
    const settled = (): RecoveryLaneState => ({ pending: false, pendingIntent: null, outcome: "accepted",
      resolved: { commandId: intent.command_id }, problem: null, canRetry: false });
    let state: RecoveryLaneState = held ? { pending: true, pendingIntent: { ...intent }, outcome: null, resolved: null, problem: null, canRetry: false }
      : { pending: false, pendingIntent: null, outcome: null, resolved: null, problem: null, canRetry: false };
    let failure: unknown = null;
    const host: LaneRecoveryHost = {
      automatic: () => true,
      primary: () => state,
      failure: () => failure,
      async send(sent, first, transmitted) {
        if (first && server.refuseFirstSave) {
          failure = new PendingStoreError("changed");
          state = { pending: false, pendingIntent: null, outcome: null, resolved: null, problem: "pending_changed", canRetry: false };
          return;
        }
        if (server.down) { transmitted(); failure = new ApiError("network"); return; }
        calls.push({ at: now(), op: "post", commandId: sent.command_id });
        transmitted();
        if (server.hold) await server.hold;
        const reply = server.replies.shift() ?? "accepted";
        if (reply === "accepted") { failure = null; state = settled(); return; }
        if (lostAt < 0) lostAt = now();
        if (reply === "lost") { failure = new ApiError("network"); server.down = true; return; }
        failure = new ApiError("http", 503, "MAINTENANCE", { waitSeconds: reply.maintenance });
      },
      async check() {
        calls.push({ at: now(), op: "check", commandId: intent.command_id });
        if (server.down) { failure = new ApiError("network"); state = { ...state, problem: "network", canRetry: false }; return; }
        if (server.maintenance !== null) {
          failure = new ApiError("http", 503, "MAINTENANCE", { waitSeconds: server.maintenance });
          state = { ...state, problem: "maintenance", canRetry: false }; return;
        }
        failure = null; state = { ...state, problem: "not_found", canRetry: true };
      },
      release: async () => undefined,
      isLive: () => true,
      onUpdate: () => undefined,
    };
    return Object.assign(new LaneRecovery(host, counter, systemRecoveryClock, scope), {
      holds: (next: RecoveryIntent) => { state = { ...state, pendingIntent: { ...next } }; },
    });
  };
  return {
    server, owner,
    lostAt: () => lostAt,
    /** Re-anchors the loss for a count seeded without a send of this page. */
    lostNow: () => { lostAt = now(); },
    /** POSTs after the loss, ms after it. */
    posts: (commandId = X.command_id) => calls.filter(call => call.op === "post" && call.commandId === commandId && call.at > lostAt)
      .map(call => Math.round(call.at - lostAt)),
    /** Every POST after the loss comes right after a check of the fact, in the same instant. */
    checkedFirst: () => calls.every((call, i) => call.op !== "post" || call.at <= lostAt
      || calls[i - 1]?.op === "check" && calls[i - 1]!.at === call.at),
    /** Move the fake clock to `ms` after the loss. */
    until: (ms: number) => vi.advanceTimersByTimeAsync(Math.max(0, lostAt + ms - now())),
  };
}
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** The first owner loses send r of X (r - 1 sends were spent before); the server stays down afterwards. */
async function loseSend(r: number, p: ReturnType<typeof page>, counter: SendCounter) {
  p.server.replies = ["lost"];
  const first = p.owner(counter, DOCUMENT);
  if (r === 1) void first.begin({ ...X });
  else { await counter.save(X.command_id, { reserved: r - 1, transmitted: r - 1 }); first.sync(); }
  for (let spent = 0; spent < 100_000 && p.lostAt() < 0; spent += 500) await pass(500);
  expect(p.lostAt()).toBeGreaterThanOrEqual(0);
  return first;
}

describe("a new owner of the same document after a lost send", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  for (const [index, pause] of RETRY_PAUSES_MS.entries()) {
    const r = index + 1;
    it(`sends at once after its check once the pause of send ${r + 1} has run out, not a full pause later`, async () => {
      const p = page(), counter = new MemorySendCounter();
      const first = await loseSend(r, p, counter);
      await pass(100); first.dispose(); p.server.down = false;
      await p.until(pause + 3_000);
      p.owner(counter, DOCUMENT).sync();
      await pass(120_000);
      expect(p.posts()).toEqual([pause + 3_000]);
      expect(p.checkedFirst()).toBe(true);
    });
    it(`waits only the rest of the pause of send ${r + 1} when it comes before its end`, async () => {
      const p = page(), counter = new MemorySendCounter();
      const first = await loseSend(r, p, counter);
      await pass(100); first.dispose(); p.server.down = false;
      await p.until(Math.round(pause / 2));
      p.owner(counter, DOCUMENT).sync();
      await pass(120_000);
      expect(p.posts()).toEqual([pause]);
      expect(p.checkedFirst()).toBe(true);
    });
  }

  it("gets nothing from another document of the same page and waits its own full pause", async () => {
    const p = page(), counter = new MemorySendCounter();
    const first = await loseSend(1, p, counter);
    await pass(100); first.dispose(); p.server.down = false;
    await p.until(1_000);
    p.owner(counter, "p1:c1:d2:1").sync();
    await pass(120_000);
    expect(p.posts()).toEqual([1_000 + RETRY_PAUSES_MS[0]!]);
  });
});

describe("the announced end of a planned pause", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("still holds a new owner when the send itself met MAINTENANCE", async () => {
    const p = page(), counter = new MemorySendCounter();
    p.server.replies = [{ maintenance: 20 }];
    const first = p.owner(counter, DOCUMENT);
    void first.begin({ ...X });
    await pass(0);
    expect(p.lostAt()).toBeGreaterThanOrEqual(0);
    await pass(100); first.dispose();
    await p.until(1_000);
    p.owner(counter, DOCUMENT).sync();
    await pass(200_000);
    expect(p.posts()).toEqual([20_000]);
    expect(p.checkedFirst()).toBe(true);
  });

  it("still holds a new owner when only a check met MAINTENANCE and no loss time was known", async () => {
    const p = page(), counter = new MemorySendCounter();
    await counter.save(X.command_id, { reserved: 1, transmitted: 1 });
    p.lostNow();
    p.server.maintenance = 60;
    const checker = p.owner(counter, DOCUMENT); checker.sync();
    await pass(1_000);
    checker.dispose(); p.server.maintenance = null;
    p.owner(counter, DOCUMENT).sync();
    await pass(200_000);
    const posts = p.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toBeGreaterThanOrEqual(60_000);
    expect(posts[0]).toBeLessThanOrEqual(60_500);
  });

  it("is never shortened by a later, shorter pause of another owner", async () => {
    const p = page(), counter = new MemorySendCounter();
    await counter.save(X.command_id, { reserved: 1, transmitted: 1 });
    p.lostNow();
    p.server.maintenance = 60;
    const long = p.owner(counter, DOCUMENT); long.sync();
    await pass(1_000); long.dispose();
    p.server.maintenance = 10;
    const short = p.owner(counter, DOCUMENT); short.sync();
    await pass(100); short.dispose(); p.server.maintenance = null;
    await p.until(2_000);
    p.owner(counter, DOCUMENT).sync();
    await pass(300_000);
    const posts = p.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toBeGreaterThanOrEqual(60_000);
  });
});

describe("a replaced owner", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("never records its late loss for the next owner of the same command", async () => {
    const p = page(), counter = new MemorySendCounter();
    let answer!: () => void;
    p.server.hold = new Promise<void>(resolve => { answer = resolve; });
    p.server.replies = ["lost"];
    const lane = p.owner(counter, DOCUMENT);
    void lane.begin({ ...X });
    await pass(1_000);
    // The lane moves on to Y: the machine of X is replaced while its POST is still in flight.
    lane.holds(Y); lane.sync();
    await pass(4_000);
    answer(); p.server.hold = null; // X's reply is lost only now, 5 s after its POST
    await pass(3_000);
    expect(p.lostAt()).toBeGreaterThanOrEqual(0);
    p.server.down = false;
    // Had the late loss been recorded, the next owner of X would send at its due time (7 s after the POST, i.e. now).
    p.owner(counter, DOCUMENT).sync();
    await pass(120_000);
    expect(p.posts()).toEqual([3_000 + RETRY_PAUSES_MS[0]!]);
    expect(p.checkedFirst()).toBe(true);
  });
});

const Z: RecoveryIntent = { command_id: id(52), kind: "answer.submit", session_id: SESSION };
const W = id(53);

describe("a new action whose first save is refused over another record (C164)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("leaves the counts and the loss times of the older actions X and Z, and an unknown count stays unknown", async () => {
    const p = page(), counter = new MemorySendCounter();
    // X and Z each lost a send on this page; their owners are gone, their records may still be resumed.
    const x = await loseSend(1, p, counter);
    await pass(100); x.dispose();
    p.server.down = false; p.server.replies = ["lost"];
    const z = p.owner(counter, DOCUMENT, Z);
    void z.begin({ ...Z });
    await pass(100); z.dispose();
    const [zLost] = p.posts(Z.command_id);
    const marks = { x: await counter.load(X.command_id), z: await counter.load(Z.command_id) };
    expect(marks.x).toEqual({ reserved: 1, transmitted: 1 });
    expect(marks.z).toEqual({ reserved: 1, transmitted: 1 });
    // Y: a new action of this page; its very first save meets another window's record and is refused before any request.
    p.server.down = false; p.server.refuseFirstSave = true;
    const y = p.owner(counter, DOCUMENT, Y, false);
    await y.begin({ ...Y });
    await pass(0);
    expect(y.view()).toBeNull();
    expect(p.posts(Y.command_id)).toEqual([]);
    p.server.refuseFirstSave = false;
    expect(await counter.load(Y.command_id)).toBeNull();
    expect(await counter.load(X.command_id)).toEqual(marks.x);
    expect(await counter.load(Z.command_id)).toEqual(marks.z);
    expect(await counter.load(W)).toBeNull();
    // The loss times of X and Z still shorten their next owners' wait: both send at the end of their own pause.
    await p.until(1_000);
    p.owner(counter, DOCUMENT, X).sync();
    p.owner(counter, DOCUMENT, Z).sync();
    await pass(120_000);
    const pause = RETRY_PAUSES_MS[0]!;
    expect(p.posts(X.command_id)).toEqual([pause]);
    expect(p.posts(Z.command_id)).toEqual([zLost, zLost! + pause]);
  });
});
