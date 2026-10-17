// The shared lane of one addressed command (M-REFAC-CMD): one command_id per intent through timeout, reload and retry.
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../api/generated";
import { ApiError } from "../api/http";
import type { AsyncStorage } from "../platform/storage";
import { CommandLane, copyLanePending, failureProblem, missingProblem, retryStep, validLanePending, type CommandProblem, type LaneOptions, type LanePending,
  type LaneResolved, type LaneSettled, type LaneSnapshot, type MissingStatus, type Pair, type WithoutId } from "./commandLane";
import { PendingSlot, PendingStoreError } from "./pendingSlot";
import { WriteGate } from "./writeGate";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Intent = { command_id: string; kind: "session.start" | "item.mark" | "session.stop"; session_id: string };
type Current = { session_id: string; status: "active" | "summary" | "closed"; pair: "ru-de" | "uk-de" | "en-de"; marked: boolean }
  | { session_id: string; status: "unavailable" | "not_found" };
type Reply = { state_version: string; current: Current } & ({ outcome: "accepted"; command: { result_id: string | null } }
  | { outcome: "rejected" | "mismatch"; error: { code: string } });
type Status = { outcome: "accepted"; state_version: string; current: Current; command: { result_id: string | null } } | MissingStatus;
type Resolved = LaneResolved<Intent["kind"]> & { resultId?: string };
type Snapshot = LaneSnapshot<Intent, Current, Resolved>;
type Spec = { intent: Intent; lane: "study" | "stop"; current: Current; resolved: Resolved; reply: Reply; status: Status;
  read: { state_version: string; current: Current }; snapshot: Snapshot };

const copy = (intent: Intent): Intent => ({ command_id: intent.command_id, kind: intent.kind, session_id: intent.session_id });
/** A minimal mode: a mark is retried only while its session is active and unmarked. */
class TestLane extends CommandLane<Spec> {
  constructor(options: LaneOptions<Spec>) { super(options, { label: "test", lanes: ["study", "stop"], copy }); }
  protected intent(action: WithoutId<Intent>): Intent | Error {
    if ((action.kind === "session.stop") !== (this.options.lane === "stop")) return new Error("invalid test action");
    return copy({ ...action, command_id: this.options.newId() });
  }
  protected accept(_intent: Intent, reply: LaneSettled<Spec> & { outcome: "accepted" }, resolved: Resolved): void {
    if (reply.command.result_id) resolved.resultId = reply.command.result_id;
  }
  protected settledCurrent(reply: LaneSettled<Spec>): object { return reply.current; }
  /** Projections a mode view (an answer, a result) was built on, as the written mode builds one on a visible step. */
  readonly views: object[] = [];
  /** Every call of settledView, whatever projection it got (M-LANE-PAIR-GUARD). */
  viewCalls = 0;
  protected settledView(): void { this.viewCalls++; if (this.current !== null) this.views.push(structuredClone(this.current)); }
  protected verify(pending: LanePending<Intent>): Promise<boolean> {
    return this.verifySession(pending, current => {
      const step = retryStep(current, pending.intent, pending.pair);
      if (typeof step === "string") return step;
      return pending.intent.kind === "item.mark" && step.status === "active" && !step.marked ? "not_found" : "step_changed";
    });
  }
}

const profile = (overrides: Partial<Profile> = {}): Profile => ({ profile_id: id(1), role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version: "5", access: { status: "admitted", version: "1", reason: null }, ...overrides });
const active = (marked = false): Current => ({ session_id: id(3), status: "active", pair: "ru-de", marked });
const accepted = (version = "6", resultId: string | null = id(9)): Reply => ({ outcome: "accepted", command: { result_id: resultId },
  state_version: version, current: active(true) });
const missing = (extra: Partial<MissingStatus> = {}): Status => ({ outcome: "not_found", state_version: "6", current: profile(), ...extra });
const mark: WithoutId<Intent> = { kind: "item.mark", session_id: id(3) };

type RecordFields = Partial<Pick<LanePending<Intent>, "profileId" | "clientInstanceId" | "pair">>;
function fixture(options: { lane?: "study" | "stop"; minimum?: () => string | null; saved?: Intent; mismatch?: boolean;
  pair?: Pair; record?: RecordFields; conflict?: () => void; gate?: WriteGate } = {}) {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const lane = options.lane ?? "study";
  const store = new PendingSlot<LanePending<Intent>>(storage, "test.pending", value => {
    const pending = value as LanePending<Intent>;
    if (typeof pending !== "object" || pending === null || pending.schemaVersion !== 1) throw new PendingStoreError("invalid");
    return { ...pending, intent: copy(pending.intent) };
  });
  if (options.saved) values.set("test.pending", JSON.stringify({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
    pair: "ru-de", ...options.record, intent: options.saved, ...(options.mismatch ? { mismatch: true } : {}) }));
  let next = 100;
  const send = vi.fn<(intent: Intent) => Promise<Reply>>(), check = vi.fn<(intent: Intent) => Promise<Status>>();
  const read = vi.fn<(sessionId: string) => Promise<{ state_version: string; current: Current }>>();
  const onUpdate = vi.fn<(snapshot: Snapshot) => void>(), newId = vi.fn(() => id(next++));
  const controller = new TestLane({ profileId: id(1), clientInstanceId: id(2), pair: options.pair ?? "ru-de", lane, pendingStore: store,
    isLive: () => true, newId, send, check, read, onUpdate, stateVersion: "5", minimumStateVersion: options.minimum, slotConflict: options.conflict,
    ...(options.gate ? { gate: options.gate } : {}) });
  return { controller, values, storage, send, check, read, newId, onUpdate };
}

describe("shared command lane", () => {
  it("a lost reply keeps the intent unknown under its ID; a reload checks that ID and never sends", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockRejectedValueOnce(new ApiError("network"));
    await f.controller.begin(mark);
    const sent = f.send.mock.calls[0][0];
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", pending: true, problem: "network", canRetry: false,
      pendingIntent: sent });
    expect(JSON.parse(f.values.get("test.pending")!).intent).toEqual(sent);
    f.check.mockResolvedValueOnce({ ...accepted(), outcome: "accepted" } as Status);
    await f.controller.refresh();
    expect(f.check).toHaveBeenCalledWith(sent); expect(f.send).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", pending: false,
      resolved: { commandId: sent.command_id, kind: "item.mark", sessionId: id(3), resultId: id(9) } });
    expect(f.values.has("test.pending")).toBe(false);
  });
  it("a manual retry checks the same ID again and then sends exactly the retained intent", async () => {
    const saved = { command_id: id(50), kind: "item.mark" as const, session_id: id(3) };
    const f = fixture({ saved });
    f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ state_version: "6", current: active() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "not_found", canRetry: true });
    f.send.mockResolvedValueOnce(accepted("7"));
    await f.controller.retry();
    expect(f.check).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls).toEqual([[saved]]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", resolved: { commandId: id(50) } });
  });
  it("a target that changed meanwhile is never offered for retry", async () => {
    const f = fixture({ saved: { command_id: id(50), kind: "item.mark", session_id: id(3) } });
    f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ state_version: "6", current: active(true) });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "step_changed", canRetry: false });
    await f.controller.retry(); expect(f.send).not.toHaveBeenCalled();
  });
  it("another payload under the same ID (HTTP 409) is marked and never retried", async () => {
    const f = fixture({ saved: { command_id: id(50), kind: "item.mark", session_id: id(3) } });
    f.check.mockRejectedValueOnce(new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", phase: "unresolved", canRetry: false });
    expect(JSON.parse(f.values.get("test.pending")!).mismatch).toBe(true);
    await f.controller.refresh(); expect(f.check).toHaveBeenCalledOnce();
  });
  it("only the final closure of exactly this session proves non-application", async () => {
    const f = fixture({ saved: { command_id: id(50), kind: "item.mark", session_id: id(3) } });
    const boundary = { session_id: id(3), status: "closed" as const, close_reason: "stop" as const };
    f.check.mockResolvedValueOnce(missing({ closed_session: { ...boundary, session_id: id(4) } }));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "step_changed", outcome: null, pending: true });
    f.check.mockResolvedValueOnce(missing({ closed_session: boundary }));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "not_applied", closedSession: boundary, pending: false,
      resolved: { commandId: id(50) } });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("a reply below the shared floor is stale, and the floor stays after its publisher is gone", async () => {
    let floor: string | null = "9";
    const f = fixture({ minimum: () => floor, saved: { command_id: id(50), kind: "item.mark", session_id: id(3) } });
    f.check.mockResolvedValue(missing()); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "stale_response", canRetry: false });
    floor = null;
    await f.controller.refresh();
    expect(f.controller.snapshot().problem).toBe("stale_response"); expect(f.read).not.toHaveBeenCalled();
  });
  it("an intent saved in the other lane is invalid there", async () => {
    const f = fixture({ lane: "stop", saved: { command_id: id(50), kind: "item.mark", session_id: id(3) } });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "invalid_pending", phase: "unresolved" });
    expect(f.check).not.toHaveBeenCalled();
  });
  it("an invalid action is rejected before anything is saved or sent", async () => {
    const f = fixture(); await f.controller.refresh();
    await expect(f.controller.begin({ kind: "session.stop", session_id: id(3) })).rejects.toThrow("invalid test action");
    expect(f.values.size).toBe(0); expect(f.send).not.toHaveBeenCalled();
    expect(() => new TestLane({ ...{ profileId: "x", clientInstanceId: id(2), pair: "ru-de", lane: "study" },
      pendingStore: {} as never, isLive: () => true, newId: () => id(1), send: vi.fn(), check: vi.fn(), read: vi.fn(),
      onUpdate: vi.fn() })).toThrow("invalid test context");
  });
  it("a refusal settles with its code and keeps no pending intent", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockResolvedValueOnce({ outcome: "rejected", error: { code: "SESSION_CLOSED" }, state_version: "6", current: active() });
    await f.controller.begin(mark);
    expect(f.controller.snapshot()).toMatchObject({ outcome: "rejected", rejectionCode: "SESSION_CLOSED", pending: false,
      current: active() });
  });
});

describe("shared lane checks", () => {
  it("names only store failures and denials; anything else is a lost reply", () => {
    expect(failureProblem(new PendingStoreError("invalid"))).toBe("invalid_pending");
    expect(failureProblem(new PendingStoreError("changed"))).toBe("pending_changed");
    expect(failureProblem(new PendingStoreError("unavailable"))).toBe("storage");
    expect(failureProblem(new ApiError("http", 401))).toBe("expired");
    expect(failureProblem(new ApiError("http", 403))).toBe("forbidden");
    expect(failureProblem(new ApiError("http", 500))).toBe("network");
    expect(failureProblem(new Error("x"))).toBe("network");
  });
  it("checks the context of a missing fact in order: profile, access, closure, client, pair", () => {
    const pending: LanePending<Intent> = { schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), pair: "ru-de",
      intent: { command_id: id(50), kind: "item.mark", session_id: id(3) } };
    const own = { profileId: id(1), clientInstanceId: id(2), pair: "ru-de" as const };
    const check = (status: MissingStatus, from = pending): CommandProblem | "not_applied" | null => missingProblem(status, from, own);
    const base = missing() as MissingStatus;
    expect(check({ ...base, current: profile({ profile_id: id(7) }) })).toBe("profile_changed");
    expect(check({ ...base, current: profile({ access: { status: "pending", version: "2", reason: null } }) })).toBe("forbidden");
    expect(check({ ...base, closed_session: { session_id: id(3), status: "closed", close_reason: "midnight" } })).toBe("not_applied");
    expect(check(base, { ...pending, clientInstanceId: id(8) })).toBe("client_changed");
    expect(check({ ...base, current: profile({ dictionary_language: "uk" }) })).toBe("pair_changed");
    expect(check(base, { ...pending, pair: "uk-de" })).toBe("pair_changed");
    expect(check(base)).toBeNull();
  });
  it("lets a retry through only for the same open session of this pair", () => {
    const intent = { command_id: id(50), kind: "item.mark" as const, session_id: id(3) };
    expect(retryStep({ ...active(), session_id: id(4) }, intent, "ru-de")).toBe("step_changed");
    expect(retryStep({ ...active(), status: "closed" }, intent, "ru-de")).toBe("closed");
    expect(retryStep({ session_id: id(3), status: "unavailable" }, intent, "ru-de")).toBe("forbidden");
    expect(retryStep({ session_id: id(3), status: "not_found" }, intent, "ru-de")).toBe("step_changed");
    expect(retryStep({ session_id: id(3), status: "not_found" }, { ...intent, kind: "session.start" }, "ru-de")).toBe("not_found");
    expect(retryStep({ session_id: id(3), status: "active" }, intent, "ru-de")).toBe("forbidden");
    expect(retryStep(active(), intent, "uk-de")).toBe("pair_changed");
    expect(retryStep(active(), intent, "ru-de")).toEqual(active());
  });
});

describe("durable lane record", () => {
  const validIntent = (value: unknown): value is Intent => typeof value === "object" && value !== null
    && (value as Intent).kind === "item.mark";
  const record = { schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), pair: "ru-de", intent: { command_id: id(50), kind: "item.mark", session_id: id(3) } };
  it("accepts only the exact envelope of an accepted intent", () => {
    expect(validLanePending(record, validIntent)).toBe(true);
    expect(validLanePending({ ...record, mismatch: true }, validIntent)).toBe(true);
    expect(validLanePending({ ...record, mismatch: false }, validIntent)).toBe(false);
    expect(validLanePending({ ...record, extra: 1 }, validIntent)).toBe(false);
    expect(validLanePending({ ...record, schemaVersion: 2 }, validIntent)).toBe(false);
    expect(validLanePending({ ...record, profileId: "x" }, validIntent)).toBe(false);
    expect(validLanePending({ ...record, pair: "de-de" }, validIntent)).toBe(false);
    expect(validLanePending({ ...record, intent: { ...record.intent, kind: "other" } }, validIntent)).toBe(false);
  });
  it("copies canonically and keeps only a true mismatch marker", () => {
    const copied = copyLanePending({ ...record, mismatch: true, intent: { session_id: id(3), kind: "item.mark", command_id: id(50) } } as LanePending<Intent>, copy);
    expect(JSON.stringify(copied)).toBe(JSON.stringify({ ...record, mismatch: true }));
    expect(copyLanePending(record as LanePending<Intent>, copy)).not.toHaveProperty("mismatch");
  });
});

describe("planned pause and outdated client (M-COMPAT-HDR)", () => {
  const paused = (waitSeconds: number | null = 40) => new ApiError("http", 503, "MAINTENANCE", { waitSeconds });

  it.each([
    [new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 1 }), "maintenance"],
    [new ApiError("http", 409, "CLIENT_INCOMPATIBLE"), "incompatible"],
    [new ApiError("http", 503, "WRITE_UNAVAILABLE"), "network"],
    [new ApiError("http", 503), "network"],
    // The thrown form every study adapter gives the core's DOCUMENT_STALE envelope (commandRefusal.ts, Р3).
    [new ApiError("http", 409, "DOCUMENT_STALE"), "window_stale"],
    [new ApiError("http", 409, "SESSION_CLOSED"), "network"],
    [new ApiError("http", 500, "MAINTENANCE"), "network"],
    [new ApiError("network"), "network"],
    [new ApiError("invalid_response"), "network"],
    [new ApiError("http", 401, "MAINTENANCE"), "expired"],
  ] as const)("names the refusal of a write %#: %s", (error, problem) => {
    expect(failureProblem(error)).toBe(problem);
  });

  it("a paused write keeps the intent unknown under its ID, with the wait, and is never repeated on its own", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockRejectedValueOnce(paused(40));
    await f.controller.begin(mark);
    await new Promise(resolve => setTimeout(resolve, 20));
    const sent = f.send.mock.calls[0][0];
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", pending: true, problem: "maintenance",
      pauseSeconds: 40, canRetry: false, pendingIntent: sent });
    expect(JSON.parse(f.values.get("test.pending")!).intent).toEqual(sent);
  });

  it("the check by the same ID works during the pause and settles what the first send did", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockRejectedValueOnce(paused());
    await f.controller.begin(mark);
    const sent = f.send.mock.calls[0][0];
    f.check.mockResolvedValueOnce({ ...accepted(), outcome: "accepted" } as Status);
    await f.controller.refresh();
    expect(f.check).toHaveBeenCalledWith(sent); expect(f.send).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", problem: null, pauseSeconds: null, pending: false });
  });

  it("a manual retry during a longer pause sends once per tap, the same intent, and shows the pause again", async () => {
    const saved = { command_id: id(50), kind: "item.mark" as const, session_id: id(3) };
    const f = fixture({ saved });
    f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ state_version: "6", current: active() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: true });
    f.send.mockRejectedValueOnce(paused(0));
    await f.controller.retry();
    expect(f.send.mock.calls).toEqual([[saved]]);
    expect(f.controller.snapshot()).toMatchObject({ problem: "maintenance", pauseSeconds: 0, pendingIntent: saved, phase: "unresolved" });
    expect(f.newId).not.toHaveBeenCalled();
  });

  it("an outdated client keeps the intent, says so and may still check it", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockRejectedValueOnce(new ApiError("http", 409, "CLIENT_INCOMPATIBLE"));
    await f.controller.begin(mark);
    const sent = f.send.mock.calls[0][0];
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", pending: true, problem: "incompatible",
      pauseSeconds: null, pendingIntent: sent });
    f.check.mockResolvedValueOnce(missing());
    f.read.mockResolvedValueOnce({ state_version: "6", current: active() });
    await f.controller.refresh();
    expect(f.check).toHaveBeenCalledWith(sent);
    expect(f.controller.snapshot()).toMatchObject({ pending: true, problem: "not_found" });
  });

  it("a lost reply and a refused write (503 WRITE_UNAVAILABLE) carry no pause data", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockRejectedValueOnce(new ApiError("http", 503, "WRITE_UNAVAILABLE"));
    await f.controller.begin(mark);
    expect(f.controller.snapshot()).toMatchObject({ problem: "network", pauseSeconds: null });
  });
});

describe("M-ORAL-STUCK-A: the receipt of an own session closed in another pair", () => {
  const saved: Intent = { command_id: id(50), kind: "item.mark", session_id: id(3) };
  const closed = (overrides: Partial<Extract<Current, { pair: string }>> = {}): Current =>
    ({ session_id: id(3), status: "closed", pair: "ru-de", marked: true, ...overrides });
  const receipt = (current: Current): Status => ({ outcome: "accepted", state_version: "6", current, command: { result_id: id(9) } });
  /** The record of ru-de and its owner reopened in uk-de: the pair changed while the reply was lost. */
  const reopened = (record: RecordFields = {}) => fixture({ saved, pair: "uk-de", record });

  it("a closed projection of the own session from the receipt stays its closed fact, without a mode view", async () => {
    const f = reopened();
    f.check.mockResolvedValueOnce(receipt(closed()));
    await f.controller.refresh();
    // The projection keeps its own pair and status: it is never this pair's open step.
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", pending: false, canRetry: false,
      current: closed(), resolved: { commandId: id(50), sessionId: id(3), resultId: id(9) } });
    expect(f.controller.snapshot().current).toMatchObject({ pair: "ru-de", status: "closed" });
    // Its numbers build no view of this pair.
    expect(f.controller.views).toEqual([]);
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("an open projection of another pair from the receipt is hidden", async () => {
    for (const status of ["active", "summary"] as const) {
      const f = reopened();
      f.check.mockResolvedValueOnce(receipt(closed({ status })));
      await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", current: null });
      expect(f.controller.views).toEqual([]);
    }
  });
  it("a closed projection of another session, or of a pair the record was not made for, is no fact", async () => {
    for (const current of [closed({ session_id: id(4) }), closed({ pair: "en-de" })]) {
      const f = reopened();
      f.check.mockResolvedValueOnce(receipt(current));
      await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", current: null });
      expect(f.controller.views).toEqual([]);
    }
  });
  it("a record of another installation or another profile proves no closure of this owner", async () => {
    const other = reopened({ clientInstanceId: id(8) });
    other.check.mockResolvedValueOnce(receipt(closed()));
    await other.controller.refresh();
    expect(other.controller.snapshot()).toMatchObject({ outcome: "accepted", current: null });
    expect(other.controller.views).toEqual([]);
    // The slot itself drops a record of another profile; a store that still hands one over proves nothing either.
    const record: LanePending<Intent> = { schemaVersion: 1, profileId: id(7), clientInstanceId: id(2), pair: "ru-de", intent: saved };
    const store = { load: vi.fn(async () => record), clear: vi.fn(async () => {}) } as unknown as PendingSlot<LanePending<Intent>>;
    const check = vi.fn(async () => receipt(closed()));
    const foreign = new TestLane({ profileId: id(1), clientInstanceId: id(2), pair: "uk-de", lane: "study", pendingStore: store,
      isLive: () => true, newId: () => id(100), send: vi.fn(), check, read: vi.fn(), onUpdate: vi.fn(), stateVersion: "5" });
    await foreign.refresh();
    expect(foreign.snapshot()).toMatchObject({ outcome: "accepted", current: null });
    expect(foreign.views).toEqual([]);
  });
  it("a read of the session, not the receipt, keeps hiding another pair's closure", async () => {
    const f = fixture({ saved });
    f.check.mockResolvedValueOnce(missing());
    f.read.mockResolvedValueOnce({ state_version: "6", current: closed({ pair: "uk-de" }) });
    await f.controller.refresh();
    expect(f.read).toHaveBeenCalledWith(id(3));
    expect(f.controller.snapshot()).toMatchObject({ outcome: null, pending: true, problem: "closed", current: null });
  });
  it("this pair is unchanged: its closed and open projections stay, with their view", async () => {
    const f = fixture({ saved });
    f.check.mockResolvedValueOnce(receipt(closed()));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", current: closed() });
    expect(f.controller.views).toHaveLength(1);
  });
});

describe("M-LANE-PAIR-GUARD 4.1: an accepted reply whose session is open in another pair", () => {
  const saved: Intent = { command_id: id(50), kind: "session.start", session_id: id(3) };
  const start: WithoutId<Intent> = { kind: "session.start", session_id: id(3) };
  const project = (overrides: Partial<Extract<Current, { pair: string }>> = {}): Current =>
    ({ session_id: id(3), status: "active", pair: "uk-de", marked: false, ...overrides });
  const reply = (current: Current, version = "6"): Reply => ({ outcome: "accepted", command: { result_id: null }, state_version: version, current });
  const receipt = (current: Current, version = "6"): Status => ({ outcome: "accepted", state_version: version, current, command: { result_id: null } });

  it("P1: a direct reply keeps the applied fact, cleans its record and names the pair; no view, no second send", async () => {
    for (const status of ["active", "summary"] as const) {
      const f = fixture(); await f.controller.refresh();
      f.send.mockResolvedValueOnce(reply(project({ status })));
      await f.controller.begin(start);
      expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", pending: false, canRetry: false,
        problem: "pair_changed", current: null, rejectionCode: null,
        resolved: { commandId: id(100), kind: "session.start", sessionId: id(3) } });
      expect(f.controller.views).toEqual([]); expect(f.controller.viewCalls).toBe(0);
      expect(f.values.has("test.pending")).toBe(false);
      expect(f.send).toHaveBeenCalledOnce(); expect(f.newId).toHaveBeenCalledOnce();
    }
  });
  it("P2: the check by ID (already applied) keeps that fact the same way; it never sends", async () => {
    const f = fixture({ saved });
    f.check.mockResolvedValueOnce(receipt(project()));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", pending: false, problem: "pair_changed",
      current: null, resolved: { commandId: id(50) } });
    expect(f.controller.views).toEqual([]); expect(f.controller.viewCalls).toBe(0);
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("P3: the own closure in another pair stays its closed fact, never this reason", async () => {
    const f = fixture({ saved, pair: "uk-de" });
    f.check.mockResolvedValueOnce(receipt(project({ status: "closed", pair: "ru-de" })));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", problem: null,
      current: { session_id: id(3), status: "closed", pair: "ru-de" } });
    expect(f.controller.views).toEqual([]); expect(f.controller.viewCalls).toBe(0);
  });
  it("P4: a closed projection of another pair that is no own closure is no fact and no reason, and builds no view", async () => {
    for (const current of [project({ status: "closed" }), project({ status: "closed", session_id: id(4) })]) {
      const f = fixture({ saved });
      f.check.mockResolvedValueOnce(receipt(current));
      await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", problem: null, current: null });
      expect(f.controller.views).toEqual([]); expect(f.controller.viewCalls).toBe(0);
    }
  });
  it("P5: a reply below the shared floor is a stale view, not another pair: the fact stays, no reason, no view", async () => {
    const f = fixture({ minimum: () => "9" }); await f.controller.refresh();
    f.send.mockResolvedValueOnce(reply(project(), "6"));
    await f.controller.begin(start);
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, problem: null, current: null, stateVersion: "5" });
    expect(f.controller.views).toEqual([]); expect(f.controller.viewCalls).toBe(0);
  });
  it("P6: a refused reply is unchanged: its code, no pair reason", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockResolvedValueOnce({ outcome: "rejected", error: { code: "SESSION_BUSY" }, state_version: "6", current: project() });
    await f.controller.begin(start);
    expect(f.controller.snapshot()).toMatchObject({ outcome: "rejected", rejectionCode: "SESSION_BUSY", problem: null, current: null });
  });
  it("P7: this pair is unchanged: no reason, its view is built", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockResolvedValueOnce(reply(project({ pair: "ru-de" })));
    await f.controller.begin(start);
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", problem: null, current: { pair: "ru-de", status: "active" } });
    expect(f.controller.views).toHaveLength(1); expect(f.controller.viewCalls).toBe(1);
  });
  it("P8: the reason belongs to that reply: the next check keeps the fact and clears it", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockResolvedValueOnce(reply(project()));
    await f.controller.begin(start);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", problem: null, current: null });
    expect(f.check).not.toHaveBeenCalled();
  });
  it("P9: a reply formed before the change and delivered after the owner died changes nothing (lifetime guard)", async () => {
    const f = fixture(); await f.controller.refresh();
    let deliver: (value: Reply) => void = () => {};
    f.send.mockImplementationOnce(() => new Promise<Reply>(done => { deliver = done; }));
    const sending = f.controller.begin(start);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.controller.dispose(); const updates = f.onUpdate.mock.calls.length;
    deliver(reply(project({ pair: "ru-de" }))); await sending;
    expect(f.onUpdate.mock.calls.length).toBe(updates);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", outcome: null, resolved: null, current: null, problem: null });
    // The record stays for the next owner, which checks it by its ID.
    expect(JSON.parse(f.values.get("test.pending")!).intent.command_id).toBe(id(100));
  });
});

describe("D-STALE-WINDOW 3.1.12: a record kept after DOCUMENT_STALE and a change of profile", () => {
  it("profile A keeps X after the refusal; profile B's own load never touches A's record (pending profile addresses)", async () => {
    const f = fixture(); await f.controller.refresh();
    // The thrown form every study adapter gives the core's envelope (commandRefusal.ts).
    f.send.mockRejectedValueOnce(new ApiError("http", 409, "DOCUMENT_STALE"));
    await f.controller.begin(mark);
    const sent = f.send.mock.calls[0][0];
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", pending: true, outcome: null, problem: "window_stale" });
    expect(f.controller.lastFailure()).toMatchObject({ kind: "http", status: 409, code: "DOCUMENT_STALE" });
    expect(JSON.parse(f.values.get("test.pending")!)).toMatchObject({ profileId: id(1), intent: sent });
    const storage: AsyncStorage = { get: async key => f.values.get(key) ?? null, set: async (key, value) => { f.values.set(key, value); },
      remove: async key => { f.values.delete(key); } };
    // B's records live under its own profile address: A's record is not read, not removed.
    const store = new PendingSlot<LanePending<Intent>>(storage, "wortly.pending.test_lane", value => value as LanePending<Intent>);
    const other = new TestLane({ profileId: id(99), clientInstanceId: id(2), pair: "ru-de", lane: "study", pendingStore: store,
      isLive: () => true, newId: () => id(200), send: vi.fn(), check: vi.fn(), read: vi.fn(), onUpdate: vi.fn(), stateVersion: "5" });
    await other.refresh();
    expect(JSON.parse(f.values.get("test.pending")!)).toMatchObject({ profileId: id(1), intent: sent });
    expect(other.snapshot()).toMatchObject({ phase: "idle", pending: false });
  });
});

// M-SLOT-INVALID: a NEW intent whose save the slot refuses over an unreadable record was neither stored nor sent. It is no unknown
// outcome: no check, no retry, no pending intent. The unreadable record itself is neither cleared nor overwritten here.
describe("an unreadable record in the shared slot meets a new intent", () => {
  const readable: Intent = { command_id: id(50), kind: "item.mark", session_id: id(3) };
  it.each([["not JSON", "{not json"], ["JSON of another shape", "{\"a\":1}"], ["a number", "7"]])(
    "begin over %s: the intent is dropped, nothing is sent or checked, the record stays byte for byte", async (_name, raw) => {
      const f = fixture(); await f.controller.refresh();
      f.values.set("test.pending", raw);
      await f.controller.begin(mark);
      expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending", pending: false, pendingIntent: null,
        kind: null, canRetry: false });
      expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
      expect(f.values.get("test.pending")).toBe(raw);
      expect(f.controller.lastFailure()).toMatchObject({ kind: "invalid" });
      // A later check has nothing of the dropped intent to ask for.
      await f.controller.refresh();
      expect(f.check).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
      expect(f.controller.snapshot()).toMatchObject({ phase: "idle", pending: false });
      expect(f.values.get("test.pending")).toBe(raw);
    });
  it("an unreadable record names no other action, so the seam that checks the record of another window is not called", async () => {
    const conflict = vi.fn(), f = fixture({ conflict }); await f.controller.refresh();
    f.values.set("test.pending", "{not json");
    await f.controller.begin(mark);
    expect(f.controller.snapshot()).toMatchObject({ pending: false, problem: "invalid_pending" });
    expect(conflict).not.toHaveBeenCalled();
    // A readable record of another window does call it (the case the seam is for).
    const g = fixture({ conflict }); await g.controller.refresh();
    g.values.set("test.pending", JSON.stringify({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), pair: "ru-de",
      intent: { command_id: id(60), kind: "item.mark", session_id: id(3) } }));
    await g.controller.begin(mark);
    expect(conflict).toHaveBeenCalledOnce();
  });
  it("the automatic path (prepare, start) is dropped the same way and never calls the transport hook", async () => {
    const f = fixture(); await f.controller.refresh();
    f.values.set("test.pending", "{not json");
    const intent = f.controller.prepare(mark) as Intent, hooks = { prepare: vi.fn(async () => true), started: vi.fn() }, transmitted = hooks.started;
    await f.controller.start(intent, hooks);
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending", pending: false });
    expect(transmitted).not.toHaveBeenCalled(); expect(hooks.prepare).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
    // Nothing waits for it: a resend has no intent to send.
    await f.controller.resend(hooks);
    expect(f.send).not.toHaveBeenCalled();
  });
  it("once the record is gone, a new action is sent exactly once under a new ID", async () => {
    const f = fixture(); await f.controller.refresh();
    f.values.set("test.pending", "{not json");
    await f.controller.begin(mark);
    const dropped = f.newId.mock.results[0].value as string;
    f.values.delete("test.pending");
    await f.controller.refresh();
    f.send.mockResolvedValueOnce(accepted("7"));
    await f.controller.begin(mark);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0][0].command_id).not.toBe(dropped);
    expect(f.check).not.toHaveBeenCalled();
  });
  it("a retained intent keeps its record and stays pending when the slot turns unreadable under its retry", async () => {
    const f = fixture({ saved: readable });
    f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ state_version: "6", current: active() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: true, pending: true });
    f.values.set("test.pending", "{not json");
    await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, problem: "invalid_pending", pendingIntent: readable, canRetry: false });
    expect(f.values.get("test.pending")).toBe("{not json");
  });
  it("a record that was unreadable already when the owner loaded it is the load failure, not a dropped intent", async () => {
    const f = fixture(); f.values.set("test.pending", "{not json");
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending", pending: false });
    await f.controller.begin(mark);
    expect(f.newId).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.values.get("test.pending")).toBe("{not json");
  });
  it("another kind of store failure keeps the intent as before (unknown whether the write happened)", async () => {
    const f = fixture(); await f.controller.refresh();
    const original = f.values.get.bind(f.values);
    vi.spyOn(f.values, "get").mockImplementation(key => { if (key === "test.pending") throw new Error("disk"); return original(key); });
    await f.controller.begin(mark);
    expect(f.controller.snapshot()).toMatchObject({ pending: true, problem: "storage", phase: "unresolved" });
  });
});

// Decisions 20.1-А/22.1-А: an outcome is an old one (restored) only while no request of the inherited intent has started
// in this owner. Adopted from QA-RESTORE-TIMER (Q2a–Q2g).
describe("restored outcome of an inherited intent", () => {
  const saved = { command_id: id(50), kind: "item.mark" as const, session_id: id(3) };
  async function restoredOwner(options: { minimum?: () => string | null } = {}) {
    const f = fixture({ saved, ...options });
    f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ state_version: "6", current: active() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "not_found", canRetry: true });
    return f;
  }
  const appliedLater = { outcome: "accepted", state_version: "7", current: active(true), command: { result_id: id(9) } } as Status;
  /** The transport tells the start of the request (sendStarted), as the document wiring does. */
  const startedThen = (f: ReturnType<typeof fixture>, reply: () => Promise<Reply>) =>
    f.send.mockImplementationOnce(async () => { f.controller.sendStarted(); return reply(); });

  it("a first check of a new owner that finds the inherited intent applied: restored", async () => {
    const f = fixture({ saved }); f.check.mockResolvedValue(appliedLater);
    await f.controller.refresh();
    expect(f.controller.snapshot().resolved).toEqual({ commandId: id(50), kind: "item.mark", sessionId: id(3), resultId: id(9), restored: true });
  });
  it("a resend that died in the save (no request), then a check finds it applied: still restored", async () => {
    const f = await restoredOwner();
    f.storage.get = vi.fn(async () => { throw new Error("storage unavailable"); });
    f.storage.set = vi.fn(async () => { throw new Error("quota"); });
    await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, outcome: null });
    f.check.mockResolvedValue(appliedLater);
    await f.controller.refresh();
    expect(f.controller.snapshot().resolved).toMatchObject({ commandId: id(50), kind: "item.mark", restored: true });
  });
  it("a resend stopped by a stale floor before its save, then a check finds it applied: still restored", async () => {
    let floor: string | null = null;
    const f = await restoredOwner({ minimum: () => floor });
    // The shared floor rises inside retry's own check, right before it would send.
    f.check.mockImplementationOnce(async () => { floor = "9"; return missing(); });
    await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled();
    floor = null; f.check.mockResolvedValue(appliedLater);
    await f.controller.refresh();
    expect(f.controller.snapshot().resolved?.restored).toBe(true);
  });
  it("a resend whose request started and whose reply was lost, then found applied: live", async () => {
    const f = await restoredOwner();
    startedThen(f, async () => { throw new ApiError("network"); });
    await f.controller.retry();
    expect(f.send).toHaveBeenCalledOnce();
    f.check.mockResolvedValue(appliedLater);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted" });
    expect(f.controller.snapshot().resolved?.restored).toBeUndefined();
  });
  it("a resend that got its reply: live", async () => {
    const f = await restoredOwner();
    startedThen(f, async () => accepted("7"));
    await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted" });
    expect(f.controller.snapshot().resolved?.restored).toBeUndefined();
  });
  it("an owner that began with an empty slot, sent X, lost the reply and found it applied: live", async () => {
    const f = fixture(); await f.controller.refresh();
    startedThen(f, async () => { throw new ApiError("network"); });
    await f.controller.begin(mark);
    f.check.mockResolvedValue(appliedLater);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted" });
    expect(f.controller.snapshot().resolved?.restored).toBeUndefined();
  });
});

describe("fix5 (QA r7 Y12): only a direct SESSION_BUSY refusal of a session.start signals the П01 episode", () => {
  it.each([
    ["SESSION_BUSY", "session.start", 1],
    ["SESSION_NOT_ACTIVE", "session.start", 0],
    ["PAIR_MISMATCH", "session.start", 0],
    ["SESSION_BUSY", "item.mark", 0],
  ] as const)("%s refusing %s → %i signal", async (code, kind, signals) => {
    const gate = new WriteGate();
    const noted = vi.spyOn(gate, "noteStartBusy");
    const f = fixture({ gate }); await f.controller.refresh();
    f.send.mockResolvedValueOnce({ outcome: "rejected", error: { code }, state_version: "6", current: { session_id: id(3), status: "not_found" } });
    await f.controller.begin({ kind, session_id: id(3) });
    expect(f.send).toHaveBeenCalledOnce();
    expect(noted.mock.calls.map(([commandId]) => commandId)).toEqual(signals ? [f.send.mock.calls[0][0].command_id] : []);
  });
});

// C561: an automatic first send (with the recovery hooks) dropped over a readable record of another window keeps that block
// across a refresh while any record is in the slot — a local read only: no check of the record, no send, no new ID. Once the
// slot is free, the lane is idle again and a new action may begin. A manual action keeps its single drop (as before).
describe("the block of a dropped automatic intent while the slot is held (C561)", () => {
  const otherWindow = (): string => JSON.stringify({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(9), pair: "ru-de",
    intent: { command_id: id(60), kind: "item.mark", session_id: id(3) } });
  const hooks = () => ({ automatic: true as const, prepare: vi.fn(async () => true), started: vi.fn() });
  it("refresh keeps it blocked while the record is there; reads only the slot; free slot — idle, and one new action goes", async () => {
    const f = fixture(); await f.controller.refresh();
    f.values.set("test.pending", otherWindow());
    const intent = f.controller.prepare(mark) as Intent, h = hooks();
    await f.controller.start(intent, h);
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "pending_changed", pending: false });
    expect(h.prepare).not.toHaveBeenCalled();
    const reads = vi.mocked(f.storage.get).mock.calls.length;
    for (let round = 0; round < 3; round++) {
      await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "pending_changed", pending: false, pendingIntent: null });
    }
    expect(vi.mocked(f.storage.get).mock.calls.length).toBeGreaterThan(reads);
    expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(vi.mocked(f.storage.set)).not.toHaveBeenCalled();
    expect(f.values.get("test.pending")).toBe(otherWindow());
    f.values.delete("test.pending");
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "idle", problem: null, pending: false });
    f.send.mockResolvedValueOnce({ outcome: "accepted", state_version: "6" } as unknown as Reply);
    const ids = f.newId.mock.calls.length;
    await f.controller.begin(mark);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.newId.mock.calls.length).toBe(ids + 1);
  });
  it("a counted manual send (a start: hooks without the automatic mark) keeps its single drop too (CP5b stage 3)", async () => {
    const f = fixture(); await f.controller.refresh();
    f.values.set("test.pending", otherWindow());
    const intent = f.controller.prepare(mark) as Intent;
    await f.controller.start(intent, { prepare: vi.fn(async () => true), started: vi.fn() });
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "pending_changed" });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "idle", pending: false });
  });
  it("a manual action dropped over the same record keeps its single drop: the next refresh is idle (accepted before)", async () => {
    const f = fixture(); await f.controller.refresh();
    f.values.set("test.pending", otherWindow());
    await f.controller.begin(mark);
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "pending_changed" });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "idle", pending: false });
  });
});
