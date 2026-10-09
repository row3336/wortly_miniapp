// The shared lane of one addressed command (M-REFAC-CMD): one command_id per intent through timeout, reload and retry.
import { describe, expect, it, vi } from "vitest";
import type { Profile } from "../api/generated";
import { ApiError } from "../api/http";
import type { AsyncStorage } from "../platform/storage";
import { CommandLane, copyLanePending, failureProblem, missingProblem, retryStep, validLanePending, type CommandProblem, type LaneOptions, type LanePending,
  type LaneResolved, type LaneSettled, type LaneSnapshot, type MissingStatus, type Pair, type WithoutId } from "./commandLane";
import { PendingSlot, PendingStoreError } from "./pendingSlot";

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
  protected settledView(): void { if (this.current !== null) this.views.push(structuredClone(this.current)); }
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
  pair?: Pair; record?: RecordFields } = {}) {
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
    isLive: () => true, newId, send, check, read, onUpdate, stateVersion: "5", minimumStateVersion: options.minimum });
  return { controller, values, send, check, read, newId, onUpdate };
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
    [new ApiError("http", 409, "DOCUMENT_STALE"), "network"],
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
