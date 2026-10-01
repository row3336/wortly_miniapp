import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { ApiError } from "../api/http";
import { LearningCommandController, type LearningTransition } from "./learningCommandController";
import type { LearningAnswerReply, LearningAnswerStatus, LearningResultRead } from "./learningAnswerApi";
import type { LearningRevisionIntent } from "./learningRevisionIntent";
import type { LearningCommandIntent } from "./learningCommandIntent";
import { LearningSessionPendingStore, LearningStopPendingStore, type LearningSessionPending } from "./learningSessionPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slot = "wortly.pending.learning_session", stopSlot = "wortly.pending.learning_stop";
function intent(kind: LearningRevisionIntent["kind"] = "result.correct"): LearningRevisionIntent {
  const target = { command_id: id(4), session_id: id(3), assignment_id: id(5), result_id: id(6), expected_result_version: "1" };
  return kind === "result.correct" ? { ...target, kind, payload: {} } : { ...target, kind, payload: { grade: 5 } };
}
function action(original = intent()): LearningTransition { const { command_id: _id, ...value } = structuredClone(original); return value; }
const saved = (original: LearningCommandIntent = intent()): LearningSessionPending => ({ schemaVersion: 1,
  profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent: structuredClone(original) });
function current(original = intent()): LearningResultRead {
  const target = { session_id: original.session_id, assignment_id: original.assignment_id, result_id: original.result_id,
    expected_result_version: original.expected_result_version };
  return { state_version: "8", action: { action_id: id(7), kind: "answer.submit", status: "active", version: "1" },
    result: { result_id: id(6), assignment_id: id(5), version: "1", grade: original.kind === "result.correct" ? 2 : 4,
      correct: original.kind !== "result.correct", status: "active", accepted_at: "2026-09-30T12:00:00Z", answer_date: "2026-09-30", detail: null },
    step: { session_id: id(3), status: "summary", mode: "learning", pair: "ru-de", local_date: "2026-09-30", close_reason: null,
      group: { id: id(9), status: "active", version: "1", preview_position: 1, total: 1 }, preview: null, assignment: null },
    capabilities: { answer_target: null, undo_target: null, stop: true, summary_home: true,
      grades: original.kind === "result.grade" ? { ...target, values: [3, 4, 5] } : null,
      correct_target: original.kind === "result.correct" ? target : null } };
}
function accepted(original = intent()): Extract<LearningAnswerReply, { outcome: "accepted" }> {
  const view = current(original);
  view.state_version = "9"; view.action!.version = view.result!.version = "2";
  view.result!.grade = original.kind === "result.grade" ? original.payload.grade as 3 | 4 | 5 : 4; view.result!.correct = true;
  view.capabilities.correct_target = null;
  view.capabilities.grades = { session_id: id(3), assignment_id: id(5), result_id: id(6), expected_result_version: "2", values: [3, 4, 5] };
  return { ...view, outcome: "accepted", command: { id: original.command_id, kind: original.kind, status: "applied",
    target_id: original.assignment_id, action_id: id(7), result_id: original.result_id, context_id: null,
    applied_at: "2026-09-30T12:00:05Z", object_version: "2" } };
}
const missing = (): Extract<LearningAnswerStatus, { outcome: "not_found" }> => ({ outcome: "not_found", state_version: "8",
  command: { id: id(4), status: "not_found" }, current: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
    time_zone: "UTC", state_version: "8", access: { status: "admitted", version: "1", reason: null } } });
type Options = ConstructorParameters<typeof LearningCommandController>[0];
function fixture(raw?: LearningSessionPending) {
  const values = new Map<string, string>(); if (raw) values.set(slot, JSON.stringify(raw));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const pendingStore = new LearningSessionPendingStore(storage), stopStore = new LearningStopPendingStore(storage);
  const send = vi.fn<Options["send"]>(async original => {
    if (original.kind !== "result.grade" && original.kind !== "result.correct") throw new Error("unexpected session command");
    return accepted(original);
  });
  const check = vi.fn<Options["check"]>(async () => missing());
  const read = vi.fn<Options["read"]>(async () => { throw new Error("revision needs addressed result"); });
  const readResult = vi.fn<Options["readResult"]>(async original => current(original));
  const newId = vi.fn(() => id(4)), isLive = vi.fn(() => true);
  const make = (changes: Partial<Options> = {}) => new LearningCommandController({ profileId: id(50), clientInstanceId: id(1), pair: "ru-de",
    pendingStore, send, check, read, readResult, newId, isLive, onUpdate: () => {}, ...changes });
  return { values, storage, pendingStore, stopStore, send, check, read, readResult, newId, isLive, make, controller: make() };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(finish => { resolve = finish; }); return { resolve, promise }; }

describe("Durable Learning correction and grade", () => {
  it.each(["result.correct", "result.grade"] as const)("saves exact %s before sending and ignores repeated clicks", async kind => {
    const original = intent(kind), f = fixture(); await f.controller.refresh(); const gate = deferred<LearningAnswerReply>();
    f.send.mockImplementationOnce(async value => {
      expect(JSON.parse(f.values.get(slot)!)).toEqual(saved(original)); expect(value).toEqual(original); return gate.promise;
    });
    const input = action(original), work = f.controller.begin(input);
    Object.assign(input, { result_id: id(99), expected_result_version: "2" }); Object.assign(input.payload, { grade: 3 });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.controller.begin(action())).toBe(work); expect(f.controller.retry()).toBe(work);
    gate.resolve(accepted(original)); await work;
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, answer: { result: { version: "2" } } });
    expect(f.newId).toHaveBeenCalledOnce(); expect(f.values.has(slot)).toBe(false);
  });
  it.each(["result.correct", "result.grade"] as const)("after reload missing %s checks the exact result, then only manual retry can POST", async kind => {
    const original = intent(kind), f = fixture(saved(original));
    await f.controller.refresh();
    expect(f.check).toHaveBeenCalledExactlyOnceWith(original); expect(f.readResult).toHaveBeenCalledExactlyOnceWith(original);
    expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ outcome: null, pending: true, problem: "not_found", canRetry: true });
    await f.controller.retry(); expect(f.send).toHaveBeenCalledExactlyOnceWith(original);
    expect(f.newId).not.toHaveBeenCalled(); expect(f.values.has(slot)).toBe(false);
  });
  it("recovers accepted original fact with a later current grade without a second read or POST", async () => {
    const f = fixture(saved()), reply = accepted(); reply.result!.version = reply.action!.version = "3"; reply.result!.grade = 3;
    reply.capabilities.grades!.expected_result_version = "3";
    f.check.mockResolvedValue({ ...reply, command: { ...reply.command, status: "already_applied" } });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, answer: { result: { grade: 3, version: "3" } } });
    expect(f.readResult).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  const damages: [string, (view: LearningResultRead) => void][] = [
    ["version", view => { view.result!.version = "2"; }],
    ["result", view => { view.result!.result_id = id(99); }],
    ["assignment", view => { view.result!.assignment_id = id(99); }],
    ["missing result", view => { view.result = view.action = null; }],
    ["undone", view => { view.result!.status = view.action!.status = "undone"; }],
    ["action version", view => { view.action!.version = "2"; }],
    ["right absent", view => { view.capabilities.correct_target = null; }],
    ["right result", view => { view.capabilities.correct_target!.result_id = id(99); }],
    ["right session", view => { view.capabilities.correct_target!.session_id = id(99); }],
    ["right assignment", view => { view.capabilities.correct_target!.assignment_id = id(99); }],
    ["right version", view => { view.capabilities.correct_target!.expected_result_version = "2"; }],
    ["closed", view => { Object.assign(view.step, { status: "closed", close_reason: "stop" }); }],
    ["foreign pair", view => { Object.assign(view.step, { pair: "en-de" }); }],
    ["unavailable", view => { view.step = { status: "unavailable" }; }],
  ];
  it.each(damages)("does not infer acceptance, clear or retry after changed %s", async (_name, damage) => {
    const f = fixture(saved()), view = current(); damage(view); f.readResult.mockResolvedValue(view);
    await f.controller.refresh(); await f.controller.retry(); await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ outcome: null, pending: true, canRetry: false });
    expect(f.values.has(slot)).toBe(true); expect(f.send).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
  });
  it("does not retry a grade absent from the fresh capability", async () => {
    const original = intent("result.grade"), view = current(original), f = fixture(saved(original));
    view.capabilities.grades!.values = [3, 4, 4]; f.readResult.mockResolvedValue(view);
    await f.controller.refresh(); expect(f.controller.snapshot().canRetry).toBe(false); await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("does not display or retry from an older result read", async () => {
    const f = fixture(saved()), controller = f.make({ stateVersion: "8" });
    f.readResult.mockResolvedValue({ ...current(), state_version: "7" }); await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ problem: "stale_response", canRetry: false, current: null, answer: null });
  });
  it.each(["client", "pair", "profile", "access"])("checks original context before any result read: %s", async changed => {
    const raw = saved(), reply = missing();
    if (changed === "client") raw.clientInstanceId = id(99);
    if (changed === "pair") raw.pair = "en-de";
    if (changed === "profile") reply.current.profile_id = id(99);
    if (changed === "access") reply.current.access.status = "rejected";
    const f = fixture(raw); f.check.mockResolvedValue(reply); await f.controller.refresh();
    expect(f.readResult).not.toHaveBeenCalled(); expect(f.controller.snapshot().canRetry).toBe(false);
  });
  it("unknown revision occupies the same slot as answer and present", async () => {
    const f = fixture(saved()); await f.controller.refresh();
    await f.controller.begin({ kind: "answer.submit", session_id: id(3), assignment_id: id(5), payload: { text: "Hallo" } });
    await f.controller.begin({ kind: "assignment.present", session_id: id(3), assignment_id: id(5), payload: {} });
    expect(f.send).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
  });
  it.each(["result_id", "expected_result_version", "assignment_id", "grade"])("does not overwrite a saved different %s", async changed => {
    const original = intent("result.grade"), f = fixture(saved(original)), different = structuredClone(original);
    if (changed === "grade") Object.assign(different.payload, { grade: 3 });
    else Object.assign(different, { [changed]: changed === "expected_result_version" ? "2" : id(99) });
    await expect(f.pendingStore.save(saved(different), new AbortController().signal)).rejects.toMatchObject({ kind: "changed" });
    expect(JSON.parse(f.values.get(slot)!)).toEqual(saved(original));
  });
  it("save failure never sends the revision", async () => {
    const f = fixture(); await f.controller.refresh(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("save failed"));
    await f.controller.begin(action()); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, outcome: null, problem: "storage", canRetry: false });
  });
  it("lost POST reloads the same intent instead of replaying it", async () => {
    const f = fixture(); await f.controller.refresh(); f.send.mockRejectedValueOnce(new ApiError("network"));
    await f.controller.begin(action()); f.controller.dispose();
    const recovered = f.make(); await recovered.refresh();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.check).toHaveBeenCalledExactlyOnceWith(intent());
    expect(recovered.snapshot()).toMatchObject({ pending: true, outcome: null, canRetry: true });
  });
  it.each(["network", "denied"])("failed current-result read keeps the intent unresolved: %s", async failure => {
    const f = fixture(saved()); f.readResult.mockRejectedValueOnce(new ApiError(failure === "network" ? "network" : "http", failure === "denied" ? 403 : undefined));
    await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ outcome: null, pending: true, canRetry: false, answer: null });
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["dispose", "revoked"])("late result read cannot restore rights after %s", async failure => {
    const f = fixture(saved()), gate = deferred<LearningResultRead>(); f.readResult.mockReturnValueOnce(gate.promise);
    const work = f.controller.refresh(); await vi.waitFor(() => expect(f.readResult).toHaveBeenCalledOnce());
    if (failure === "dispose") f.controller.dispose(); else f.isLive.mockReturnValue(false);
    gate.resolve(current()); await work;
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", outcome: null, pending: true, answer: null, canRetry: false });
    expect(f.values.has(slot)).toBe(true);
  });
  it("atomic missing plus closed session resolves a revision without reading or repeating it", async () => {
    const f = fixture(saved()); f.values.set(stopSlot, "independent");
    f.check.mockResolvedValue({ ...missing(), closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } });
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ pending: false, outcome: "not_applied" });
    expect(f.readResult).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.values.get(stopSlot)).toBe("independent");
  });
  it("mismatch remains durable and never reads current to infer a retry", async () => {
    const f = fixture(); await f.controller.refresh(); const reply = accepted();
    f.send.mockResolvedValue({ ...reply, outcome: "mismatch", command: { id: id(4), status: "rejected" }, error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await f.controller.begin(action()); const next = f.make(); await next.refresh(); await next.retry();
    expect(next.snapshot()).toMatchObject({ problem: "mismatch", canRetry: false, pending: true });
    expect(f.check).not.toHaveBeenCalled(); expect(f.readResult).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
  });
});

it("Stop remains independent while a revision is in flight; an old reply cannot reopen the screen", async () => {
  const f = fixture(), gate = deferred<LearningAnswerReply>(), step = current().step;
  if (!("pair" in step)) throw new Error("invalid fixture");
  const closed = { ...step, status: "closed" as const, close_reason: "stop" as const };
  const stop = f.make({ pendingStore: f.stopStore, newId: () => id(90), send: async value => {
    expect(JSON.parse(f.values.get(slot)!)).toEqual(saved());
    expect(JSON.parse(f.values.get(stopSlot)!).intent).toEqual(value);
    return { outcome: "accepted", state_version: "10", current: closed,
      command: { id: id(90), kind: "session.stop", status: "applied", applied_at: "2026-09-30T12:00:06Z",
        target_id: id(3), action_id: null, result_id: null, context_id: null, object_version: null } };
  } });
  await f.controller.refresh(); await stop.refresh(); f.send.mockReturnValueOnce(gate.promise);
  const inFlight = f.controller.begin(action()); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  await stop.begin({ kind: "session.stop", session_id: id(3), payload: { reason: "stop" } });
  expect(stop.snapshot()).toMatchObject({ outcome: "accepted", pending: false, current: { status: "closed" } });
  expect(f.values.has(slot)).toBe(true); expect(f.values.has(stopSlot)).toBe(false);
  f.controller.dispose(); gate.resolve(accepted()); await inFlight;
  expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", answer: null, current: null });
  const prior = accepted(); f.check.mockResolvedValue({ ...prior, state_version: "10", step: closed,
    capabilities: { answer_target: null, grades: null, correct_target: null, undo_target: null, stop: false, summary_home: false },
    command: { ...prior.command, status: "already_applied" } });
  const recovered = f.make({ stateVersion: "10" }); await recovered.refresh();
  expect(recovered.snapshot()).toMatchObject({ outcome: "accepted", pending: false, current: { status: "closed" } });
  expect(f.readResult).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
});

it.each([{ expected_result_version: "0" }, { expected_result_version: 1 }, { result_id: "" }, { payload: { text: "wrong" } }])(
  "invalid durable revision is blocked and retained: %j", async changes => {
    const f = fixture(); f.values.set(slot, JSON.stringify({ ...saved(), intent: { ...intent(), ...changes } }));
    await f.controller.refresh(); await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending" });
    expect(f.values.has(slot)).toBe(true); expect(f.check).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

it("a newer Stop observation hides an old accepted revision without losing its command outcome", async () => {
  const f = fixture(), gate = deferred<LearningAnswerReply>(), step = current().step;
  if (!("pair" in step)) throw new Error("invalid fixture");
  let sharedVersion = "8";
  const primary = f.make({ stateVersion: sharedVersion, minimumStateVersion: () => sharedVersion });
  await primary.refresh(); f.send.mockReturnValueOnce(gate.promise);
  const sending = primary.begin(action()); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
  const stop = f.make({ pendingStore: f.stopStore, newId: () => id(90), stateVersion: sharedVersion,
    minimumStateVersion: () => sharedVersion, onUpdate: view => {
      if (view.stateVersion && BigInt(view.stateVersion) > BigInt(sharedVersion)) sharedVersion = view.stateVersion;
    }, send: async () => ({ outcome: "accepted", state_version: "10", current: {
      ...step, status: "closed", close_reason: "stop",
    }, command: { id: id(90), kind: "session.stop", status: "applied", applied_at: "2026-09-30T12:00:06Z",
      target_id: id(3), action_id: null, result_id: null, context_id: null, object_version: null } }) });
  await stop.refresh(); await stop.begin({ kind: "session.stop", session_id: id(3), payload: { reason: "stop" } });
  expect(sharedVersion).toBe("10"); gate.resolve(accepted()); await sending;
  expect(primary.snapshot()).toMatchObject({ outcome: "accepted", pending: false, current: null, answer: null, canRetry: false });
  expect(stop.snapshot()).toMatchObject({ current: { status: "closed" }, stateVersion: "10" });
  expect(f.values.has(slot)).toBe(false);
});

it("a previously allowed retry is invalidated immediately by a newer shared observation", async () => {
  const f = fixture(saved()); let sharedVersion = "8";
  const controller = f.make({ stateVersion: sharedVersion, minimumStateVersion: () => sharedVersion });
  await controller.refresh(); expect(controller.snapshot().canRetry).toBe(true);
  sharedVersion = "9"; await controller.retry();
  expect(controller.snapshot()).toMatchObject({ outcome: null, pending: true, canRetry: false, current: null, answer: null });
  expect(f.send).not.toHaveBeenCalled();
  f.check.mockResolvedValue({ ...missing(), state_version: "9" });
  f.readResult.mockResolvedValue({ ...current(), state_version: "9" });
  await controller.refresh(); expect(controller.snapshot().canRetry).toBe(true);
  await controller.retry(); expect(f.send).toHaveBeenCalledOnce();
});

it("a late addressed read cannot authorize retry below the shared Stop version", async () => {
  const f = fixture(saved()), gate = deferred<LearningResultRead>(); let sharedVersion = "8";
  const controller = f.make({ stateVersion: sharedVersion, minimumStateVersion: () => sharedVersion });
  f.readResult.mockReturnValueOnce(gate.promise);
  const reading = controller.refresh(); await vi.waitFor(() => expect(f.readResult).toHaveBeenCalledOnce());
  sharedVersion = "10"; gate.resolve(current()); await reading; await controller.retry();
  expect(controller.snapshot()).toMatchObject({ problem: "stale_response", pending: true, canRetry: false, current: null, answer: null });
  expect(f.values.has(slot)).toBe(true); expect(f.send).not.toHaveBeenCalled();
});
