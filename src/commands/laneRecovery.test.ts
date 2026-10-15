// What the lane adapter of automatic recovery reads from a lane (M-RECOV-AUTO CP2, D-RECOV table 2).
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/http";
import { ClosedAccessError } from "../app/openedAccess";
import { PendingStoreError } from "./pendingSlot";
import { laneCheckResult, laneSendResult, type RecoveryLaneState } from "./laneRecovery";
import { recoveryScreen } from "./RecoveryOverlay";
import type { RecoverySnapshot } from "./recoveryMachine";

const ID = "00000000-0000-4000-8000-000000000100";
const lane = (patch: Partial<RecoveryLaneState> = {}): RecoveryLaneState => ({ pending: true,
  pendingIntent: { command_id: ID, kind: "answer.submit", session_id: "00000000-0000-4000-8000-000000000003" },
  outcome: null, resolved: null, problem: null, canRetry: false, ...patch });
const settled = (outcome: string) => lane({ pending: false, pendingIntent: null, outcome, resolved: { commandId: ID } });

describe("a send of the adapter", () => {
  it("is nothing sent when its request never started, whatever followed", () => {
    expect(laneSendResult(lane(), new ClosedAccessError(), false, ID)).toEqual({ kind: "not_sent" });
    expect(laneSendResult(lane(), new PendingStoreError("unavailable"), false, ID)).toEqual({ kind: "not_sent" });
  });
  it("is the lane's own answer once it started", () => {
    expect(laneSendResult(settled("accepted"), null, true, ID)).toEqual({ kind: "settled", outcome: "accepted" });
    expect(laneSendResult(settled("rejected"), null, true, ID)).toEqual({ kind: "settled", outcome: "rejected" });
    expect(laneSendResult(lane({ problem: "mismatch" }), null, true, ID)).toEqual({ kind: "mismatch" });
    expect(laneSendResult(lane(), new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 30 }), true, ID))
      .toEqual({ kind: "maintenance", waitSeconds: 30 });
    expect(laneSendResult(lane(), new ApiError("network"), true, ID)).toEqual({ kind: "lost", cause: "network" });
    // A handle closed after the request began proves nothing: the machine turns it into a lost reply.
    expect(laneSendResult(lane(), new ClosedAccessError(), true, ID)).toEqual({ kind: "not_sent" });
    // Started without an error or an outcome (the owner died meanwhile): unknown.
    expect(laneSendResult(lane(), null, true, ID)).toEqual({ kind: "lost", cause: "network" });
  });
  it("never takes the outcome of another command for this one", () => {
    const other = lane({ pending: false, outcome: "accepted", resolved: { commandId: "00000000-0000-4000-8000-000000000999" } });
    expect(laneSendResult(other, null, true, ID)).toEqual({ kind: "lost", cause: "network" });
    expect(laneCheckResult(other, null, ID)).toEqual({ kind: "unreachable" });
  });
});

describe("a check of the adapter", () => {
  it.each([
    [settled("accepted"), null, { kind: "recorded", outcome: "accepted" }],
    [settled("not_applied"), null, { kind: "terminated", reason: "session_closed" }],
    [lane({ problem: "mismatch" }), null, { kind: "mismatch" }],
    [lane({ problem: "not_found", canRetry: true }), null, { kind: "not_recorded" }],
    [lane({ problem: "stale_response" }), null, { kind: "stale" }],
    // retryVerified, but not fresh against a newer confirmed version: no proof of absence yet.
    [lane({ problem: "not_found", canRetry: false }), null, { kind: "stale" }],
    [lane({ problem: "step_changed" }), null, { kind: "terminated", reason: "step_stale" }],
    [lane({ problem: "closed" }), null, { kind: "terminated", reason: "session_closed" }],
    [lane({ problem: "pair_changed" }), null, { kind: "terminated", reason: "session_closed" }],
    [lane({ problem: "profile_changed" }), null, { kind: "terminated", reason: "access_lost" }],
    [lane({ problem: "forbidden" }), null, { kind: "terminated", reason: "access_lost" }],
    [lane({ problem: "client_changed" }), null, { kind: "terminated", reason: "window_replaced" }],
    [lane({ problem: "network" }), new ApiError("network"), { kind: "unreachable" }],
    // P03 M-P03-7: an expired sign-in asks for a new one (reauth), it does not end the access.
    [lane({ problem: "expired" }), new ApiError("http", 401), { kind: "terminated", reason: "reauth" }],
    // The thrown form of a refused read; the lane names it window_stale (commandLane failureProblem, Р3).
    [lane({ problem: "window_stale" }), new ApiError("http", 409, "DOCUMENT_STALE"), { kind: "window_stale" }],
    [lane({ problem: "maintenance" }), new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 60 }), { kind: "unreachable", pauseSeconds: 60 }],
    [lane({ problem: "storage" }), new PendingStoreError("unavailable"), { kind: "unreachable" }],
  ] as const)("%# maps the lane state to its class", (state, failure, expected) => {
    expect(laneCheckResult(state, failure, ID)).toEqual(expected);
  });
  it("a refusal never proves absence, even while an older verification is remembered", () => {
    expect(laneCheckResult(lane({ canRetry: true }), new ApiError("network"), ID)).toEqual({ kind: "unreachable" });
  });
});

describe("the waiting screen", () => {
  const view = (state: RecoverySnapshot["state"], afterLoss = true) => ({ recovery: { state, sends: 1, transmitted: 1, remaining: 5,
    active: true, commandId: ID, afterLoss }, primary: lane() });
  it("keeps the ordinary indicator for the first send and covers everything after a loss", () => {
    expect(recoveryScreen(view({ name: "sending", attempt: 1 }, false))).toBeNull();
    expect(recoveryScreen(view({ name: "sending", attempt: 1 }))).toMatchObject({ status: "resending" });
    expect(recoveryScreen(view({ name: "sending", attempt: 2 }))).toMatchObject({ status: "resending" });
    expect(recoveryScreen(view({ name: "retry_wait", attempt: 2, dueAt: 0 }))).toMatchObject({ status: "resending" });
    for (const state of [{ name: "checking" }, { name: "pre_send_check", attempt: 2 }, { name: "window_check" },
      { name: "suspended" }] as const) {
      expect(recoveryScreen(view(state))).toEqual({ kind: "waiting", status: "checking", pauseSeconds: null });
    }
    // An unreliable number of sends, whether the count is missing or the proven sends are fewer than the six busy slots
    // (C093 §6): 9.2.9 with the voluntary Stop, never an exhaustion.
    for (const cause of ["unknown", "unconfirmed"] as const) {
      expect(recoveryScreen(view({ name: "counter_unknown", check: 1, cause })))
        .toEqual({ kind: "waiting", status: "unconfirmed", pauseSeconds: null });
    }
    expect(recoveryScreen(view({ name: "unreachable", probe: 1, pauseSeconds: null }))).toMatchObject({ status: "offline" });
    expect(recoveryScreen(view({ name: "maintenance", probe: 1, pauseSeconds: 90, budgetSpent: false })))
      .toEqual({ kind: "waiting", status: "maintenance", pauseSeconds: 90 });
    expect(recoveryScreen(view({ name: "exhausted" }))).toEqual({ kind: "unsaved" });
  });
  it("shows nothing of its own for a final answer or another pending action", () => {
    for (const state of [{ name: "settled", outcome: "accepted" }, { name: "conflict" }, { name: "refused", code: "VALIDATION_FAILED" },
      { name: "terminated", reason: "step_stale" }, { name: "idle" }] as const) expect(recoveryScreen(view(state))).toBeNull();
    const other = { ...view({ name: "checking" }), primary: lane({ pendingIntent: { command_id: "00000000-0000-4000-8000-000000000999",
      kind: "answer.submit", session_id: "00000000-0000-4000-8000-000000000003" } }) };
    expect(recoveryScreen(other)).toBeNull();
    expect(recoveryScreen({ ...view({ name: "checking" }), primary: settled("accepted") })).toBeNull();
  });
});

// Н2 after the confirmed closure (D-CP4 3.1.1; QA CP4a-1 Д2): forget drops only the machine of the cleared intent.
describe("forget", () => {
  it("leaves a machine of another intent alone and drops its own", async () => {
    const { LaneRecovery } = await import("./laneRecovery");
    const { MemorySendCounter } = await import("./sendCounter");
    const { systemRecoveryClock } = await import("./recoveryClock");
    const intent = { command_id: ID, kind: "answer.submit", session_id: "00000000-0000-4000-8000-000000000003" };
    let updates = 0;
    const recovery = new LaneRecovery({
      automatic: () => true, primary: () => lane(), failure: () => null,
      // The first send never answers: the machine keeps driving this intent.
      send: () => new Promise<void>(() => {}), check: async () => {}, release: async () => {},
      isLive: () => true, onUpdate: () => { updates++; },
    }, new MemorySendCounter(), systemRecoveryClock);
    void recovery.begin(intent);
    await Promise.resolve();
    expect(recovery.drives(ID)).toBe(true);
    const before = updates;
    recovery.forget("00000000-0000-4000-8000-000000000999");
    expect({ drives: recovery.drives(ID), commandId: recovery.view()?.commandId, updates: updates - before })
      .toEqual({ drives: true, commandId: ID, updates: 0 });
    recovery.forget(ID.toUpperCase());
    expect({ drives: recovery.drives(ID), view: recovery.view(), busy: recovery.busy() }).toEqual({ drives: false, view: null, busy: false });
    recovery.dispose();
  });
});
