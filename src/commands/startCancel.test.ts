// Phase Б of an exhausted session.start: the automatic session.cancel_start (D-CP2C-START 2.3–2.4, 2.8, tests 3.3;
// owner's answer А-5.1.2: six automatic sends, pauses 2/5/10/20/30 s from the detected loss). M-CP2C-START CP1.
// The server is scripted at the host boundary; one test runs the real HTTP adapter. Every time below is exact.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../api/generated";
import { ApiError } from "../api/http";
import { systemRecoveryClock } from "./recoveryClock";
import type { RecoverySnapshot } from "./recoveryMachine";
import { hashInPlace, tick } from "./recoveryTime.test-support";
import { MemorySendCounter, type SendCounter } from "./sendCounter";
import { cancelDue, noFurtherCancel, StartCancelRecovery, type StartCancelHost } from "./startCancel";
import { createStartCancelApi, type StartCancelIntent, type StartCancelReply, type StartCancelStatus } from "./startCancelApi";
import { startCancelKey, StartCancelPendingStore, type StartCancelPending } from "./startCancelPending";
import type { AsyncStorage } from "../platform/storage";
import { testGate } from "./testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = id(50), CLIENT = id(1), SESSION = id(3), START = id(4), CANCEL = id(5);
const KEY = startCancelKey("written");
const profile = (patch: Partial<Profile> = {}): Profile => ({ profile_id: PROFILE, role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version: "5", access: { status: "admitted", version: "1", reason: null }, ...patch });
const fact = (status: "applied" | "already_applied") => ({ id: CANCEL, kind: "session.cancel_start", status,
  applied_at: "2026-10-08T12:00:00Z", target_id: SESSION, action_id: null, result_id: null, context_id: null, object_version: null });
const applied = (outcome: "cancelled" | "session_exists"): StartCancelReply =>
  ({ outcome: "accepted", command: fact("applied"), current: { session_id: SESSION, outcome }, state_version: "6" });
const refusal = (code: string, outcome: "rejected" | "mismatch" = "rejected"): StartCancelReply => ({ outcome, command: { id: CANCEL, status: "rejected" },
  error: { code }, current: { session_id: SESSION, status: "unavailable" }, state_version: "5" });
const found = (outcome: "cancelled" | "session_exists"): StartCancelStatus =>
  ({ outcome: "accepted", command: fact("already_applied"), current: { session_id: SESSION, outcome }, state_version: "6" }) as StartCancelStatus;
const absent = (patch: Partial<Profile> = {}, version = "5"): StartCancelStatus =>
  ({ outcome: "not_found", command: { id: CANCEL, status: "not_found" }, current: profile(patch), state_version: version });
const CLOSED = { session_id: SESSION, status: "closed" as const, close_reason: "midnight" };
/** not_found of the cancel with the server's closure of exactly this number: the start created the session, it is closed now. */
const closedAbsent = (version = "5"): StartCancelStatus => ({ ...absent({}, version), closed_session: CLOSED } as StartCancelStatus);
const LOST = () => new ApiError("network");
const STORED: StartCancelPending = { schemaVersion: 1, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de",
  sessionId: SESSION, startCommandId: START, cancelCommandId: CANCEL };
/** The exact intent of the cancel: its own new ID, the start's session_id, an empty payload (2.3.1). */
const BODY = JSON.stringify({ command_id: CANCEL, session_id: SESSION, kind: "session.cancel_start", payload: {} });

type Reply<T> = T | Error | Promise<T>;
type Call = { at: number; op: "send" | "status"; body: string; stored: boolean; active: boolean };

function memory(): AsyncStorage & { values: Map<string, string>; failSet?: boolean } {
  const values = new Map<string, string>();
  const storage: AsyncStorage & { values: Map<string, string>; failSet?: boolean } = { values,
    get: async key => values.get(key) ?? null,
    set: async (key, value) => { if (storage.failSet) throw new Error("quota"); values.set(key, value); },
    remove: async key => { values.delete(key); } };
  return storage;
}

/** A reply that arrives after ms of fake time: a slow check, or a network timeout that ends in a lost reply. */
function later<T>(reply: T | Error, ms: number): Promise<T> {
  return new Promise((resolve, reject) => { setTimeout(() => reply instanceof Error ? reject(reply) : resolve(reply), ms); });
}

function rig(script: {
  send?: (n: number, t: number) => Reply<StartCancelReply>;
  status?: (n: number, t: number) => Reply<StartCancelStatus>;
  storage?: ReturnType<typeof memory>;
  counter?: SendCounter;
  live?: () => boolean;
  minimum?: () => string | null;
  newId?: () => string;
} = {}) {
  const start = performance.now();
  const storage = script.storage ?? memory();
  const store = new StartCancelPendingStore(storage, "written");
  const calls: Call[] = [], counts = { send: 0, status: 0 };
  const answer = async <T>(reply: Reply<T>): Promise<T> => { if (reply instanceof Error) throw reply; return reply; };
  const newId = vi.fn(script.newId ?? (() => CANCEL));
  let recovery: StartCancelRecovery;
  const note = (op: Call["op"], intent: StartCancelIntent) => calls.push({ at: performance.now() - start, op,
    body: JSON.stringify(intent), stored: storage.values.has(KEY), active: recovery.view()?.recovery.active ?? true });
  const host: StartCancelHost = {
    send: (intent, transmitted) => {
      note("send", intent); transmitted();
      return answer((script.send ?? (() => LOST()))(++counts.send, performance.now() - start));
    },
    status: (intent) => {
      note("status", intent);
      return answer((script.status ?? (() => absent()))(++counts.status, performance.now() - start));
    },
    isLive: script.live ?? (() => true),
    windowCheck: () => Promise.resolve((script.live ?? (() => true))()),
    ...(script.minimum ? { minimumStateVersion: script.minimum } : {}),
    onUpdate: () => undefined,
  };
  recovery = new StartCancelRecovery({ host, store, counter: script.counter ?? new MemorySendCounter(), clock: systemRecoveryClock,
    active: true, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", newId });
  return {
    recovery, storage, store, calls, newId,
    at: (op?: Call["op"]) => calls.filter(c => op === undefined || c.op === op).map(c => c.at),
    view: () => recovery.view()!,
    state: () => recovery.view()?.recovery.state.name,
  };
}
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const startOf = { sessionId: SESSION, startCommandId: START };

/** Every POST after the first follows a check that ended at the same moment (the check before each retry, 2.4.1а.7). */
function expectCheckBeforeEveryRetry(calls: Call[], checkMs = 0): void {
  calls.forEach((call, index) => {
    if (call.op !== "send" || index === calls.findIndex(c => c.op === "send")) return;
    expect(calls[index - 1]?.op).toBe("status");
    expect(calls[index - 1]!.at + checkMs).toBe(call.at);
  });
}

const snapshot = (state: RecoverySnapshot["state"], sends: number | null = 6, transmitted: number | null = 6): RecoverySnapshot =>
  ({ state, sends, transmitted, remaining: sends === null ? null : 6 - sends, active: true });

describe("when a start is cancelled (cancelDue, 2.3; points 5.1.1 and 5.1.8 stay open)", () => {
  const always = () => true;
  it("only a proven exhaustion of the start: six sends that provably went out and a confirmed absence", () => {
    expect(cancelDue({ recovery: snapshot({ name: "exhausted" }), rejectionCode: null })).toBe(true);
    // Mutation 3.4.3: a cancel at five transmitted sends.
    expect(cancelDue({ recovery: snapshot({ name: "exhausted" }, 6, 5), rejectionCode: null })).toBe(false);
    for (const state of [{ name: "retry_wait", attempt: 6, dueAt: 0 }, { name: "checking" }, { name: "maintenance", probe: 1, pauseSeconds: null, budgetSpent: true }] as const) {
      expect(cancelDue({ recovery: snapshot(state), rejectionCode: null }, always)).toBe(false);
    }
  });
  it("by default no cancel for an unknown count or a temporary refusal; a policy may widen it", () => {
    const unknown = { recovery: snapshot({ name: "counter_unknown", check: 1, cause: "unknown" }, null, null), rejectionCode: null };
    const busy = { recovery: snapshot({ name: "settled", outcome: "rejected" }, 2, 2), rejectionCode: "SESSION_BUSY" };
    expect(cancelDue(unknown)).toBe(false);
    expect(cancelDue(busy, noFurtherCancel)).toBe(false);
    expect(cancelDue(unknown, always)).toBe(true);
    expect(cancelDue(busy, always)).toBe(true);
  });
  it("never for SESSION_CLOSED or an accepted start, whatever the policy (3.3.24)", () => {
    expect(cancelDue({ recovery: snapshot({ name: "settled", outcome: "rejected" }, 2, 2), rejectionCode: "SESSION_CLOSED" }, always)).toBe(false);
    expect(cancelDue({ recovery: snapshot({ name: "settled", outcome: "accepted" }, 1, 1), rejectionCode: null }, always)).toBe(false);
  });
});

describe("the automatic cancel of an exhausted start", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("3.3.1/3.3.12 the record is stored before the first POST; the POST goes at once, new command_id, same session_id, empty payload", async () => {
    const r = rig({ send: () => applied("cancelled") });
    expect(await r.recovery.begin(startOf)).toBe("started");
    await pass(0);
    expect(r.calls).toEqual([{ at: 0, op: "send", body: BODY, stored: true, active: true }]);
    expect(JSON.parse(r.storage.values.get(KEY)!)).toEqual(STORED);
    expect(r.view().record.cancelCommandId).not.toBe(r.view().record.startCommandId);
  });

  it("3.3.2 cancelled: the confirmed outcome; the record goes only by clear(), after the outcome", async () => {
    const counter = new MemorySendCounter();
    const r = rig({ send: () => applied("cancelled"), counter });
    await r.recovery.begin(startOf);
    await pass(0);
    expect(r.view()).toMatchObject({ outcome: "cancelled", unresolved: null, recovery: { state: { name: "settled", outcome: "accepted" } } });
    expect(r.storage.values.has(KEY)).toBe(true);
    await r.recovery.clear();
    expect(r.storage.values.has(KEY)).toBe(false);
    expect(await counter.load(CANCEL)).toBeNull();
  });

  it("3.3.3 session_exists: the outcome names the session, nothing more is sent", async () => {
    const r = rig({ send: () => applied("session_exists") });
    await r.recovery.begin(startOf);
    await pass(600_000);
    expect(r.view()).toMatchObject({ outcome: "session_exists", unresolved: null });
    expect(r.calls.map(c => c.op)).toEqual(["send"]);
  });

  it("3.3.5 a lost reply, then not_found: a check at once, the same cancel after 2 s; not_found is never an outcome", async () => {
    const r = rig({ send: n => n === 1 ? LOST() : applied("cancelled") });
    await r.recovery.begin(startOf);
    await pass(0);
    expect(r.view()).toMatchObject({ outcome: null, recovery: { state: { name: "retry_wait" } } });
    expect(r.storage.values.has(KEY)).toBe(true);
    await expect(r.recovery.clear()).rejects.toThrow("no confirmed outcome");
    await pass(2_000);
    expect(r.calls.map(c => [c.at, c.op])).toEqual([[0, "send"], [0, "status"], [2_000, "status"], [2_000, "send"]]);
    expect(new Set(r.calls.filter(c => c.op === "send").map(c => c.body))).toEqual(new Set([BODY]));
    expect(r.view().outcome).toBe("cancelled");
  });

  it("3.3.17/3.3.0 six lost cancels with a 15 s timeout and 1 s checks: retries at L+pause+check, then only GET, never a 7th POST", async () => {
    const TIMEOUT = 15_000, CHECK = 1_000;
    const r = rig({ send: () => later<StartCancelReply>(LOST(), TIMEOUT), status: () => later(absent(), CHECK) });
    await r.recovery.begin(startOf);
    await pass(600_000);
    const posts = r.at("send");
    expect(posts).toHaveLength(6);
    // L(n) = POST(n) + timeout; POST(n+1) = max(L(n) + pause(n+1), C(n)) + the check right before it.
    const pauses = [2_000, 5_000, 10_000, 20_000, 30_000];
    pauses.forEach((pause, n) => {
      const loss = posts[n] + TIMEOUT, checked = loss + CHECK;
      expect(posts[n + 1]).toBe(Math.max(loss + pause, checked) + CHECK);
    });
    expect(posts).toEqual([0, 18_000, 39_000, 65_000, 101_000, 147_000]);
    expectCheckBeforeEveryRetry(r.calls, CHECK);
    expect(new Set(r.calls.filter(c => c.op === "send").map(c => c.body))).toEqual(new Set([BODY]));
    // After the sixth loss (162 s) and its check (163 s): GET only, on the series 5, 10, 20, 30 s.
    const later6 = r.at("status").filter(t => t > 147_000);
    expect(later6.slice(0, 5)).toEqual([162_000, 168_000, 179_000, 200_000, 231_000]);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: "exhausted", recovery: { sends: 6, transmitted: 6 } });
    expect(r.storage.values.has(KEY)).toBe(true);
    expect(r.newId).toHaveBeenCalledOnce();
  });

  it("3.3.19 a cancel that applied late is still found by its ID after the automatic sends ran out", async () => {
    const r = rig({ status: (_n, t) => t >= 400_000 ? found("cancelled") : absent() });
    await r.recovery.begin(startOf);
    await pass(300_000);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: "exhausted" });
    await pass(200_000);
    expect(r.at("send")).toHaveLength(6);
    expect(r.view()).toMatchObject({ outcome: "cancelled", unresolved: null });
  });

  it("3.3.0 п. 5 a pause that passed while the server was away is not waited again: the retry follows the check", async () => {
    const r = rig({ send: n => n === 1 ? LOST() : applied("cancelled"), status: (_n, t) => t < 30_000 ? LOST() : absent() });
    await r.recovery.begin(startOf);
    await pass(60_000);
    expect(r.calls.map(c => [c.at, c.op])).toEqual([[0, "send"], [0, "status"], [5_000, "status"], [15_000, "status"],
      [35_000, "status"], [35_000, "send"]]);
  });

  it("3.3.7 / C038 п. 3 422 VALIDATION_FAILED: no second POST, no outcome, the record stays; checks at 5, 15, 35 s may still find an earlier copy", async () => {
    const r = rig({ send: () => new ApiError("http", 422, "VALIDATION_FAILED"), status: (_n, t) => t >= 60_000 ? found("cancelled") : absent() });
    await r.recovery.begin(startOf);
    await pass(40_000);
    expect(r.calls.map(c => [c.at, c.op])).toEqual([[0, "send"], [5_000, "status"], [15_000, "status"], [35_000, "status"]]);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: "refused", rejectionCode: "VALIDATION_FAILED" });
    expect(r.storage.values.has(KEY)).toBe(true);
    await expect(r.recovery.clear()).rejects.toThrow();
    await pass(600_000);
    expect(r.at("send")).toEqual([0]);
    expect(r.view()).toMatchObject({ outcome: "cancelled", unresolved: null });
  });

  it("C038 п. 3 a business refusal of one send: its code, never an outcome; only checks follow, never a POST", async () => {
    const r = rig({ send: () => refusal("SESSION_BUSY") });
    await r.recovery.begin(startOf);
    await pass(600_000);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: "refused", rejectionCode: "SESSION_BUSY",
      recovery: { state: { name: "checks_only", cause: "refused" } } });
    expect(r.at("send")).toEqual([0]);
    expect(r.at("status").slice(0, 4)).toEqual([5_000, 15_000, 35_000, 65_000]);
  });

  it("another payload under the cancel's ID: never sent again; the check of the same ID confirms the conflict and ends", async () => {
    const r = rig({ send: () => refusal("COMMAND_PAYLOAD_MISMATCH", "mismatch"),
      status: () => new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH") });
    await r.recovery.begin(startOf);
    await pass(600_000);
    expect(r.calls.map(c => [c.at, c.op])).toEqual([[0, "send"], [5_000, "status"]]);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: "conflict", recovery: { state: { name: "conflict" } } });
    // Even when the check finds nothing under the ID, the conflicting POST is never repeated.
    const quiet = rig({ send: () => refusal("COMMAND_PAYLOAD_MISMATCH", "mismatch") });
    await quiet.recovery.begin(startOf);
    await pass(600_000);
    expect(quiet.at("send")).toEqual([0]);
    expect(quiet.view()).toMatchObject({ outcome: null, unresolved: "conflict", recovery: { state: { name: "checks_only", cause: "mismatch" } } });
  });

  it("DOCUMENT_STALE or a hidden view: a window check; a replaced window ends without an outcome", async () => {
    let live = true;
    const r = rig({ send: () => { live = false; return refusal("DOCUMENT_STALE"); }, live: () => live });
    await r.recovery.begin(startOf);
    await pass(10_000);
    expect(r.view()).toMatchObject({ outcome: null, recovery: { state: { name: "terminated", reason: "window_replaced" } } });
    const hidden = rig({ send: () => ({ ...applied("cancelled"), current: { session_id: SESSION, status: "unavailable" } }),
      status: () => found("cancelled") });
    await hidden.recovery.begin(startOf);
    await pass(0);
    // The live window keeps the work: the check by ID then shows the outcome.
    expect(hidden.calls.map(c => c.op)).toEqual(["send", "status"]);
    expect(hidden.view().outcome).toBe("cancelled");
  });

  it("FORBIDDEN on the cancel: the access is lost, sends stop", async () => {
    const r = rig({ send: () => refusal("FORBIDDEN") });
    await r.recovery.begin(startOf);
    await pass(60_000);
    expect(r.view()).toMatchObject({ outcome: null, recovery: { state: { name: "terminated", reason: "access_lost" } } });
  });

  it("not_found is a retry only with the right to go on: same profile, admitted; an older answer proves nothing", async () => {
    const cases: [Partial<Profile>, string][] = [[{ profile_id: id(51) }, "access_lost"],
      [{ access: { status: "rejected", version: "2", reason: null } }, "access_lost"]];
    for (const [patch, reason] of cases) {
      const r = rig({ status: () => absent(patch) });
      await r.recovery.begin(startOf);
      await pass(60_000);
      expect(r.at("send")).toEqual([0]);
      expect(r.view().recovery.state).toEqual({ name: "terminated", reason });
      r.recovery.dispose();
    }
    const stale = rig({ status: () => absent({}, "4"), minimum: () => "5" });
    await stale.recovery.begin(startOf);
    await pass(120_000);
    expect(stale.at("send")).toEqual([0]);
    expect(stale.at("status").length).toBeGreaterThan(1);
    stale.recovery.dispose();
  });

  it("C038 п. 2 a changed pair does not stop the cancel of the old number: the same cancel is retried", async () => {
    const r = rig({ send: n => n < 3 ? LOST() : applied("cancelled"), status: () => absent({ dictionary_language: "uk" }) });
    await r.recovery.begin(startOf);
    await pass(10_000);
    expect(r.at("send")).toEqual([0, 2_000, 7_000]);
    expect(new Set(r.calls.filter(c => c.op === "send").map(c => c.body))).toEqual(new Set([BODY]));
    expect(r.view().outcome).toBe("cancelled");
  });

  it("3.3.10 the background: no request at all; the return starts with a GET", async () => {
    const r = rig();
    await r.recovery.begin(startOf);
    await pass(1_000);
    r.recovery.setActive(false);
    const before = r.calls.length;
    await pass(300_000);
    expect(r.calls).toHaveLength(before);
    r.recovery.setActive(true);
    await pass(0);
    // The pause of retry №1 passed in the background: after the check the retry follows at once.
    expect(r.calls.slice(before, before + 2).map(c => [c.at, c.op])).toEqual([[301_000, "status"], [301_000, "send"]]);
  });
});

describe("the cancel after a reload or in another owner (2.8.2, 2.7.4)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("3.3.8/3.3.20 a stored cancel with an unknown count: only GET by its ID, never a POST, never a second cancel_id", async () => {
    const storage = memory();
    storage.values.set(KEY, JSON.stringify(STORED));
    const r = rig({ storage, newId: () => id(77) });
    expect(await r.recovery.resume()).toEqual(STORED);
    await pass(600_000);
    expect(r.at("send")).toEqual([]);
    expect(r.at("status").length).toBeGreaterThan(5);
    expect(new Set(r.calls.map(c => c.body))).toEqual(new Set([BODY]));
    expect(r.newId).not.toHaveBeenCalled();
    expect(r.view()).toMatchObject({ outcome: null, unresolved: "counter_unknown" });
  });

  it("3.3.19 after a reload a late cancel is found and settles", async () => {
    const storage = memory();
    storage.values.set(KEY, JSON.stringify(STORED));
    const r = rig({ storage, status: n => n >= 3 ? found("cancelled") : absent() });
    await r.recovery.resume();
    await pass(60_000);
    expect(r.view()).toMatchObject({ outcome: "cancelled", unresolved: null });
    expect(r.at("send")).toEqual([]);
  });

  it("another owner in the same page continues the shared count: 3 + 3 automatic sends, not 3 + 6", async () => {
    const storage = memory(), counter = new MemorySendCounter();
    const a = rig({ storage, counter });
    await a.recovery.begin(startOf);
    await pass(7_000);
    expect(a.at("send")).toEqual([0, 2_000, 7_000]);
    a.recovery.dispose();
    const b = rig({ storage, counter });
    expect(await b.recovery.begin(startOf)).toBe("resumed");
    await pass(600_000);
    expect(b.at("send")).toHaveLength(3);
    expect(b.view()).toMatchObject({ unresolved: "exhausted", recovery: { sends: 6, transmitted: 6 } });
    expect(b.newId).not.toHaveBeenCalled();
  });

  it("Д1 (QA D-c3) after a refused POST another owner in the same page sends no POST (C038 п. 3)", async () => {
    for (const failure of [() => refusal("SESSION_BUSY"), () => new ApiError("http", 422, "VALIDATION_FAILED")]) {
      const storage = memory(), counter = new MemorySendCounter();
      const a = rig({ storage, counter, send: failure });
      await a.recovery.begin(startOf);
      await pass(10_000);
      expect(a.view().unresolved).toBe("refused");
      a.recovery.dispose();
      const b = rig({ storage, counter, send: failure, status: (_n, t) => t >= 3_000_000 ? found("cancelled") : absent() });
      expect(await b.recovery.begin(startOf)).toBe("resumed");
      await pass(3_600_000);
      expect(b.at("send")).toEqual([]);
      // Only checks by the same ID; a cancel that applied from an earlier copy is still found.
      expect(b.at("status").length).toBeGreaterThan(10);
      expect(b.view()).toMatchObject({ outcome: "cancelled" });
    }
  });

  it("C053 (б) after a refusal a reload with a trustworthy count (the same count store, a new owner by resume) sends no POST", async () => {
    const storage = memory(), counter = new MemorySendCounter();
    const a = rig({ storage, counter, send: () => refusal("SESSION_BUSY") });
    await a.recovery.begin(startOf);
    await pass(1_000);
    a.recovery.dispose();
    expect(await counter.load(CANCEL)).toEqual({ reserved: 1, transmitted: 1, forbidden: true });
    const b = rig({ storage, counter, send: () => applied("cancelled") });
    expect(await b.recovery.resume()).toEqual(STORED);
    await pass(600_000);
    expect(b.at("send")).toEqual([]);
    expect(b.view()).toMatchObject({ outcome: null, unresolved: "forbidden", recovery: { state: { name: "checks_only", cause: "forbidden" } } });
  });

  it("C053 (в) after a refusal the closure cannot be stored: the next owner still sends no POST", async () => {
    const storage = memory(), inner = new MemorySendCounter();
    const counter: SendCounter = { load: id => inner.load(id), clear: id => inner.clear(id), save: (id, marks) => inner.save(id, marks),
      forbidSends: async () => { throw new Error("storage"); } };
    const a = rig({ storage, counter, send: () => refusal("SESSION_BUSY") });
    await a.recovery.begin(startOf);
    await pass(1_000);
    a.recovery.dispose();
    const b = rig({ storage, counter, send: () => applied("cancelled") });
    expect(await b.recovery.begin(startOf)).toBe("resumed");
    await pass(600_000);
    expect(b.at("send")).toEqual([]);
    expect(b.view()).toMatchObject({ outcome: null, unresolved: "counter_unknown" });
  });

  it("C053 п. 3 / Д2 a late answer after dispose changes nothing of the replaced owner: no outcome, no closure", async () => {
    for (const late of [closedAbsent(), found("cancelled")]) {
      const r = rig({ send: () => LOST(), status: () => later(late, 1_000) });
      await r.recovery.begin(startOf);
      await pass(500);
      r.recovery.dispose();
      await pass(10_000);
      expect(r.view()).toMatchObject({ outcome: null, closedSession: null, unresolved: null, recovery: { state: { name: "disposed" } } });
      expect(r.at("send")).toEqual([0]);
    }
  });

  it("2.4.1а.1 begin on a stored cancel of the same start resumes it; of another start it is busy and sends nothing", async () => {
    const storage = memory();
    storage.values.set(KEY, JSON.stringify(STORED));
    const same = rig({ storage, newId: () => id(77) });
    expect(await same.recovery.begin({ sessionId: SESSION.toUpperCase(), startCommandId: START })).toBe("resumed");
    await pass(0);
    expect(same.newId).not.toHaveBeenCalled();
    expect(same.view().record.cancelCommandId).toBe(CANCEL);
    same.recovery.dispose();
    const other = rig({ storage, newId: () => id(77) });
    expect(await other.recovery.begin({ sessionId: id(30), startCommandId: id(40) })).toBe("busy");
    await pass(60_000);
    expect(other.calls).toEqual([]);
    expect(other.recovery.view()).toBeNull();
    expect(JSON.parse(storage.values.get(KEY)!)).toEqual(STORED);
  });

  it("a failed record write sends nothing; a later begin may try again", async () => {
    const storage = memory();
    storage.failSet = true;
    const r = rig({ storage });
    await expect(r.recovery.begin(startOf)).rejects.toMatchObject({ kind: "unavailable" });
    await pass(60_000);
    expect(r.calls).toEqual([]);
    storage.failSet = false;
    expect(await r.recovery.begin(startOf)).toBe("started");
    await pass(0);
    expect(r.calls.map(c => [c.op, c.stored])).toEqual([["send", true], ["status", true]]);
  });
});

describe("C038 п. 1 the session was created and is closed by now", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("known count: not_found with the closure of this number is a confirmed result of its own; nothing is sent any more", async () => {
    const r = rig({ status: n => n === 1 ? absent() : closedAbsent() });
    await r.recovery.begin(startOf);
    await pass(600_000);
    // The check right before retry №1 finds the closure: the retry never goes out.
    expect(r.calls.map(c => [c.at, c.op])).toEqual([[0, "send"], [0, "status"], [2_000, "status"]]);
    expect(r.view()).toMatchObject({ outcome: "session_closed", closedSession: CLOSED, unresolved: null,
      recovery: { state: { name: "terminated", reason: "session_closed" } } });
    await r.recovery.clear();
    expect(r.storage.values.has(KEY)).toBe(false);
  });

  it("Д2 a closure answer the machine drops (it arrived in the background) never becomes the result, even on an outside terminate", async () => {
    const r = rig({ status: () => later(closedAbsent(), 1_000) });
    await r.recovery.begin(startOf);
    await pass(500);
    // The first check (at 0) is still on its way when the window leaves: its answer belongs to an older generation.
    r.recovery.setActive(false);
    await pass(10_000);
    expect(r.view()).toMatchObject({ outcome: null, closedSession: null, recovery: { state: { name: "suspended" } } });
    r.recovery.terminate("session_closed");
    expect(r.view()).toMatchObject({ outcome: null, closedSession: null, recovery: { state: { name: "terminated", reason: "session_closed" } } });
    await expect(r.recovery.clear()).rejects.toThrow();
  });

  it("an outside terminate with session_closed is not the server's closure", async () => {
    const r = rig();
    await r.recovery.begin(startOf);
    await pass(0);
    r.recovery.terminate("session_closed");
    expect(r.view()).toMatchObject({ outcome: null, closedSession: null });
  });

  it("unknown count after a reload: the same result from the first check, without a POST", async () => {
    const storage = memory();
    storage.values.set(KEY, JSON.stringify(STORED));
    const r = rig({ storage, status: () => closedAbsent() });
    await r.recovery.resume();
    await pass(60_000);
    expect(r.calls.map(c => c.op)).toEqual(["status"]);
    expect(r.view()).toMatchObject({ outcome: "session_closed", closedSession: CLOSED });
  });

  it("an older answer, a lost access or no closure never give this result", async () => {
    const stale = rig({ status: n => n === 1 ? absent({}, "7") : closedAbsent("6") });
    await stale.recovery.begin(startOf);
    await pass(30_000);
    expect(stale.view()).toMatchObject({ outcome: null, closedSession: null });
    expect(stale.at("send")).toEqual([0]);
    stale.recovery.dispose();
    const minimum = rig({ status: () => closedAbsent("4"), minimum: () => "5" });
    await minimum.recovery.begin(startOf);
    await pass(30_000);
    expect(minimum.view()).toMatchObject({ outcome: null, closedSession: null });
    minimum.recovery.dispose();
    const foreign = rig({ status: () => ({ ...closedAbsent(), current: profile({ profile_id: id(51) }) } as StartCancelStatus) });
    await foreign.recovery.begin(startOf);
    await pass(30_000);
    expect(foreign.view()).toMatchObject({ outcome: null, recovery: { state: { name: "terminated", reason: "access_lost" } } });
    foreign.recovery.dispose();
    const plain = rig();
    await plain.recovery.begin(startOf);
    await pass(30_000);
    expect(plain.view()).toMatchObject({ outcome: null, closedSession: null });
    expect(plain.at("send")).toEqual([0, 2_000, 7_000, 17_000]);
  });

  it("the closure of another number never reaches the recovery: the decoder refuses it, the outcome stays unknown", async () => {
    // startCancelApi.test.ts: a closed_session of another session_id is invalid_response; here, what that does.
    const r = rig({ status: () => new ApiError("invalid_response") });
    await r.recovery.begin(startOf);
    await pass(600_000);
    expect(r.view()).toMatchObject({ outcome: null, closedSession: null });
    expect(r.at("send")).toEqual([0]);
  });
});

describe("C045 the status read: temporary failures and a confirmed impossibility", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const http = (status: number, code?: string) => new ApiError("http", status, code);

  it.each([
    ["a lost reply", () => LOST()],
    ["a 408 timeout of a proxy", () => http(408)],
    ["a 429 of a proxy", () => http(429)],
    ["a 404 without the core's code", () => http(404)],
    ["a 500 INTERNAL_ERROR", () => http(500, "INTERNAL_ERROR")],
    ["a 503 WRITE_UNAVAILABLE", () => http(503, "WRITE_UNAVAILABLE")],
    ["an unreadable answer", () => new ApiError("invalid_response")],
  ])("%s is temporary: the ordinary series 5, 10, 20, 30 s goes on without end in the active window, no POST", async (_name, failure) => {
    const r = rig({ status: failure });
    await r.recovery.begin(startOf);
    await pass(600_000);
    const checks = r.at("status");
    expect(checks.slice(0, 6)).toEqual([0, 5_000, 15_000, 35_000, 65_000, 95_000]);
    expect(checks.at(-1)).toBeGreaterThanOrEqual(575_000);
    expect(r.at("send")).toEqual([0]);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: null });
  });

  it("C045 п. 2 404 → lost → 404 → lost → 404 never ends the read; a later answer still settles the cancel", async () => {
    const r = rig({ status: (n, t) => t >= 200_000 ? found("cancelled") : n % 2 === 1 ? http(404) : LOST() });
    await r.recovery.begin(startOf);
    await pass(100_000);
    expect(r.at("status").length).toBeGreaterThanOrEqual(5);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: null });
    await pass(200_000);
    expect(r.view()).toMatchObject({ outcome: "cancelled" });
    expect(r.at("send")).toEqual([0]);
  });

  it("the core's 422 VALIDATION_FAILED: the request form is refused for good — no further read, no POST, the outcome stays unknown", async () => {
    const r = rig({ status: () => http(422, "VALIDATION_FAILED") });
    await r.recovery.begin(startOf);
    await pass(600_000);
    expect(r.calls.map(c => [c.at, c.op])).toEqual([[0, "send"], [0, "status"]]);
    expect(r.view()).toMatchObject({ outcome: null, unresolved: "status_unreadable", recovery: { state: { name: "disposed" } } });
    expect(r.storage.values.has(KEY)).toBe(true);
    await expect(r.recovery.clear()).rejects.toThrow();
  });

  it("a 422 with another code or without one is not that proof", async () => {
    for (const failure of [http(422), http(422, "SESSION_BUSY")]) {
      const r = rig({ status: () => failure });
      await r.recovery.begin(startOf);
      await pass(60_000);
      expect(r.view().unresolved).toBeNull();
      expect(r.at("status").length).toBeGreaterThan(2);
      r.recovery.dispose();
    }
  });
});

describe("the cancel over the real HTTP adapter (3.3.13)", () => {
  beforeEach(() => { vi.useFakeTimers(); hashInPlace(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("a lost POST, a GET with the core's fingerprint, the same POST again; the body never carries payload.session_id", async () => {
    const CORE_HASH = "3c338cee431a8267bc58946646040d0648eb7d7de68a1e6bbe786619dc82e8f8";
    const requests: { method: string; url: string; body: unknown }[] = [];
    let posts = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input), method = init?.method ?? "GET";
      requests.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (method === "POST" && ++posts === 1) throw new TypeError("network down");
      const value = method === "POST" ? { command: fact("applied"), current: { session_id: SESSION, outcome: "cancelled" }, state_version: "6" }
        : { command: { id: CANCEL, status: "not_found" }, current: profile(), state_version: "5" };
      return new Response(JSON.stringify(value), { status: 200 });
    });
    const api = createStartCancelApi({ fetcher, timeoutMs: 15_000, maxResponseBytes: 10_000, gate: testGate() });
    const origin = { client_instance_id: CLIENT, document_id: id(2) };
    const host: StartCancelHost = {
      send: (intent, transmitted) => { transmitted(); return api.send("t", "p", { ...intent, ...origin }); },
      status: intent => api.status("t", "p", { ...intent, ...origin }),
      isLive: () => true, windowCheck: () => Promise.resolve(true), onUpdate: () => undefined,
    };
    const recovery = new StartCancelRecovery({ host, store: new StartCancelPendingStore(memory(), "written"), counter: new MemorySendCounter(),
      clock: systemRecoveryClock, active: true, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", newId: () => CANCEL });
    await recovery.begin(startOf);
    await tick(0);
    await tick(2_000);
    const body = { command_id: CANCEL, client_instance_id: CLIENT, document_id: id(2), session_id: SESSION, kind: "session.cancel_start", payload: {} };
    expect(requests.map(r => r.method)).toEqual(["POST", "GET", "GET", "POST"]);
    expect(requests.filter(r => r.method === "POST").map(r => r.body)).toEqual([body, body]);
    for (const get of requests.filter(r => r.method === "GET")) {
      const url = new URL(get.url, "https://wortly.test");
      expect(url.pathname).toBe(`/api/v1/commands/${CANCEL}`);
      expect(url.searchParams.get("expected_intent_hash")).toBe(CORE_HASH);
      expect(url.searchParams.get("session_id")).toBe(SESSION);
    }
    expect(recovery.view()?.outcome).toBe("cancelled");
  });
});
