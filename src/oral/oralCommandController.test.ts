import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { OralSessionProjection } from "../api/generated";
import type { AsyncStorage } from "../platform/storage";
import type { OralRead, OralReply, OralStatus } from "./oralApi";
import type { OralIntent } from "./oralIntent";
import { OralCommandController, type OralCommandSnapshot, type OralTransition } from "./oralCommandController";
import { OralSessionPendingStore, OralStopPendingStore, type OralPending } from "./oralPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const studyKey = "wortly.pending.oral_session", stopKey = "wortly.pending.oral_stop";
const address = { command_id: id(4), session_id: id(3) };
const intents: OralIntent[] = [
  { ...address, kind: "session.start", payload: { mode: "oral", bucket: "phrases" } },
  { ...address, kind: "assignment.present", assignment_id: id(6), payload: {} },
  { ...address, kind: "oral.reveal", assignment_id: id(6), payload: {} },
  { ...address, kind: "oral.grade", assignment_id: id(6), payload: { correct: true } },
  { ...address, kind: "session.stop", payload: { reason: "stop" } },
  { ...address, kind: "session.stop", payload: { reason: "summary_home" } },
];
const action = (intent = intents[3]): OralTransition => {
  const { command_id: _id, ...value } = structuredClone(intent); return value;
};
const pending = (intent = intents[3]): OralPending => ({ schemaVersion: 1, profileId: id(50),
  clientInstanceId: id(1), pair: "ru-de", intent: structuredClone(intent) });
function current(status: "prefetched" | "presented" | "revealed" | "summary" | "closed" = "revealed"): OralSessionProjection {
  const active = !["summary", "closed"].includes(status), revealed = status === "revealed";
  return { session_id: id(3), status: active ? "active" : status as "summary" | "closed", mode: "oral", pair: "ru-de",
    direction: "de-l1", local_date: "2026-10-01", bucket: "phrases", close_reason: status === "closed" ? "stop" : null,
    progress: { completed: active ? 0 : 1, total: 1, correct: active ? 0 : 1, wrong: 0 },
    assignment: active ? { id: id(6), card_id: id(7), status: status === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: "Haus", language: "de", conjunction_hint: null },
      ...(revealed ? { status: "presented", revealed: true, translations: ["дом"] } : { revealed: false }) } : null,
    summary: active ? null : { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: status === "presented" ? id(6) : null, grade_target: revealed ? id(6) : null,
      stop: status !== "closed", summary_home: status === "summary" } };
}
function accepted(intent = intents[3]): Extract<OralReply, { outcome: "accepted" }> {
  const grade = intent.kind === "oral.grade";
  return { outcome: "accepted", state_version: "8", current: current("prefetched"),
    command: { id: intent.command_id, kind: intent.kind, status: "applied", applied_at: "2026-10-01T12:00:00Z",
      target_id: "assignment_id" in intent ? intent.assignment_id : intent.session_id,
      action_id: grade ? id(10) : null, result_id: grade ? id(11) : null, context_id: null, object_version: grade ? "1" : null } };
}
function recovered(intent = intents[3]): Extract<OralStatus, { outcome: "accepted" }> {
  const reply = accepted(intent); return { ...reply, command: { ...reply.command, status: "already_applied" } };
}
const missing = (): Extract<OralStatus, { outcome: "not_found" }> => ({ outcome: "not_found", state_version: "8",
  command: { id: id(4), status: "not_found" }, current: { profile_id: id(50), role: "user", ui_language: "ru",
    dictionary_language: "ru", time_zone: "UTC", state_version: "8", access: { status: "admitted", version: "1", reason: null } } });
const closedProof = (): Extract<OralStatus, { outcome: "not_found" }> => ({ ...missing(),
  closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve };
}
type Options = ConstructorParameters<typeof OralCommandController>[0];
function fixture(raw?: OralPending) {
  const values = new Map<string, string>();
  if (raw) values.set(raw.intent.kind === "session.stop" ? stopKey : studyKey, JSON.stringify(raw));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const study = new OralSessionPendingStore(storage), stop = new OralStopPendingStore(storage);
  const send = vi.fn(async (intent: OralIntent): Promise<OralReply> => accepted(intent));
  const check = vi.fn(async (intent: OralIntent): Promise<OralStatus> => recovered(intent));
  const read = vi.fn(async (_sessionId: string): Promise<OralRead> => ({ current: current(), state_version: "8" }));
  const newId = vi.fn(() => id(4)), isLive = vi.fn(() => true), updates: OralCommandSnapshot[] = [];
  const options: Options = { profileId: id(50), clientInstanceId: id(1), pair: "ru-de", lane: "study", pendingStore: study,
    send, check, read, newId, isLive, onUpdate: snapshot => { updates.push(snapshot); } };
  const make = (changes: Partial<Options> = {}) => new OralCommandController({ ...options, ...changes });
  const owner = (intent: OralIntent) => make(intent.kind === "session.stop" ? { lane: "stop", pendingStore: stop } : {});
  return { controller: make(), make, owner, options, values, storage, study, stop, send, check, read, newId, isLive, updates };
}
const targets: OralRead["current"][] = [{ session_id: id(3), status: "not_found" }, current("prefetched"),
  current("presented"), current("revealed"), current("revealed"), current("summary")];

describe("oral command owner: durability and manual recovery", () => {
  it("requires refresh before begin, then saves before one POST despite double click and mutated input", async () => {
    const f = fixture(); await f.controller.begin(action()); await f.controller.retry(); expect(f.newId).not.toHaveBeenCalled();
    await f.controller.refresh(); expect(f.controller.snapshot().phase).toBe("idle");
    const gate = deferred<void>(), input = action();
    vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => { await gate.promise; f.values.set(key, value); });
    const work = f.controller.begin(input);
    expect(f.controller.begin(action())).toBe(work); expect(f.controller.retry()).toBe(work);
    Object.assign(input.payload, { correct: false, proof: "synthetic" }); input.session_id = id(99);
    await vi.waitFor(() => expect(f.storage.set).toHaveBeenCalledOnce()); expect(f.send).not.toHaveBeenCalled();
    f.send.mockImplementationOnce(async intent => {
      expect(JSON.parse(f.values.get(studyKey)!).intent).toEqual(intents[3]); return accepted(intent);
    });
    gate.resolve(); await work;
    expect(f.send).toHaveBeenCalledExactlyOnceWith(intents[3]); expect(f.newId).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ pending: false, outcome: "accepted",
      resolved: { assignmentId: id(6), actionId: id(10), resultId: id(11) } });
  });
  it.each(intents)("checks original UUID of $kind after lost reply and reload, with no automatic POST", async intent => {
    const f = fixture(), first = f.owner(intent); await first.refresh(); f.send.mockRejectedValueOnce(new Error("lost reply"));
    await first.begin(action(intent)); expect(first.snapshot()).toMatchObject({ outcome: null, pending: true, problem: "network" });
    first.dispose(); const next = f.owner(intent); await next.refresh();
    expect(f.check).toHaveBeenCalledExactlyOnceWith(intent); expect(f.send).toHaveBeenCalledOnce();
    expect(next.snapshot()).toMatchObject({ outcome: "accepted", pending: false, phase: "settled" });
  });
  it.each(intents)("retries $kind only explicitly after new proof, preserving UUID and payload", async intent => {
    const f = fixture(pending(intent)), controller = f.owner(intent), index = intents.indexOf(intent);
    f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ current: targets[index], state_version: "8" });
    await controller.refresh(); expect(controller.snapshot()).toMatchObject({ pending: true, canRetry: true, outcome: null });
    expect(f.send).not.toHaveBeenCalled();
    await controller.retry(); expect(f.check).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(intent); expect(f.newId).not.toHaveBeenCalled();
  });
  it("fresh retry proof can discover acceptance or final closure without POST", async () => {
    for (const final of [recovered(), closedProof()]) {
      const f = fixture(pending()); f.check.mockResolvedValueOnce(missing()).mockResolvedValueOnce(final);
      await f.controller.refresh(); await f.controller.retry();
      expect(f.controller.snapshot()).toMatchObject({ pending: false, canRetry: false,
        outcome: final.outcome === "accepted" ? "accepted" : "not_applied" });
      expect(f.send).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce();
    }
  });
  it("rechecks a target that changed after refresh rather than replaying on old proof", async () => {
    const f = fixture(pending()); f.check.mockResolvedValue(missing());
    await f.controller.refresh(); f.read.mockResolvedValue({ current: current("prefetched"), state_version: "9" });
    await f.controller.retry(); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, canRetry: false, problem: "step_changed" });
  });
  it.each(["client", "pair"])("accepted original UUID clears pending even after %s changes", async change => {
    const raw = pending(); if (change === "client") raw.clientInstanceId = id(99); else raw.pair = "en-de";
    const f = fixture(raw); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false }); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["profile", "access", "language", "client", "pair"])("missing proof with changed %s cannot authorize retry", async change => {
    const raw = pending(), reply = missing();
    if (change === "profile") reply.current.profile_id = id(99);
    if (change === "access") reply.current.access.status = "rejected";
    if (change === "language") reply.current.dictionary_language = "en";
    if (change === "client") raw.clientInstanceId = id(99);
    if (change === "pair") raw.pair = "en-de";
    const f = fixture(raw); f.check.mockResolvedValue(reply); await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, canRetry: false, current: null, outcome: null });
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
  it("inherits account cleanup, refuses wrong lanes and preserves malformed pending", async () => {
    const f = fixture({ ...pending(), profileId: id(99) }); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pending: false, phase: "idle" });
    await expect(f.controller.begin(action(intents[4]))).rejects.toThrow("invalid oral action");
    const stop = f.make({ lane: "stop", pendingStore: f.stop }); await stop.refresh();
    await expect(stop.begin(action())).rejects.toThrow("invalid oral action");
    f.values.set(studyKey, "broken"); const corrupted = f.make(); await corrupted.refresh(); await corrupted.begin(action());
    expect(corrupted.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending" }); expect(f.send).not.toHaveBeenCalled();
  });

  const forbiddenTargets: [OralIntent, OralRead["current"]][] = [
    [intents[0], current()], [intents[1], current("presented")], [intents[2], current("revealed")],
    [intents[3], current("presented")], [intents[3], { ...current(), assignment: { ...current().assignment!, id: id(99) } }],
    [intents[2], { ...current("presented"), capabilities: { ...current("presented").capabilities, reveal_target: null } }],
    [intents[3], { ...current(), capabilities: { ...current().capabilities, grade_target: null } }],
    [intents[4], { ...current(), capabilities: { ...current().capabilities, stop: false } }],
    [intents[5], current()], [intents[5], { ...current("summary"), capabilities: { ...current("summary").capabilities, summary_home: false } }],
    [intents[3], { session_id: id(3), status: "not_found" }], [intents[3], { session_id: id(3), status: "unavailable" }],
    [intents[3], { ...current(), pair: "en-de" }], [intents[3], { ...current(), session_id: id(99) }],
  ];
  it.each(forbiddenTargets)("never retries %j against incompatible current target", async (intent, projection) => {
    const f = fixture(pending(intent)), controller = f.owner(intent);
    f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ current: projection, state_version: "8" });
    await controller.refresh(); await controller.retry();
    expect(controller.snapshot().canRetry).toBe(false); expect(f.send).not.toHaveBeenCalled();
    if ("pair" in projection && projection.pair === "en-de") expect(controller.snapshot().current).toBeNull();
  });
});

describe("oral proof and durable cleanup", () => {
  it.each(intents)("only atomic absence plus closure resolves $kind as not_applied", async intent => {
    const f = fixture(pending(intent)), controller = f.owner(intent); f.check.mockResolvedValue(closedProof());
    await controller.refresh(); await controller.retry();
    expect(controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: false, closedSession: closedProof().closed_session });
    expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["stale", "profile", "access", "session"])("keeps pending when atomic closed proof is %s", async condition => {
    const f = fixture(pending()), controller = f.make({ stateVersion: "8" }), reply = closedProof();
    if (condition === "stale") reply.state_version = "7";
    if (condition === "profile") reply.current.profile_id = id(99);
    if (condition === "access") reply.current.access.status = "rejected";
    if (condition === "session") reply.closed_session!.session_id = id(99);
    f.check.mockResolvedValue(reply); await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ outcome: null, pending: true, canRetry: false, closedSession: null });
  });
  it("a later closed read cannot prove non-application", async () => {
    const f = fixture(pending()); f.check.mockResolvedValue(missing()); f.read.mockResolvedValue({ current: current("closed"), state_version: "9" });
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ pending: true, outcome: null, problem: "closed", canRetry: false });
    expect(f.values.has(studyKey)).toBe(true);
  });
  it("failed durable save prevents POST; recovery retains the same UUID", async () => {
    const f = fixture(); await f.controller.refresh(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("save failed"));
    await f.controller.begin(action()); await f.controller.retry(); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, problem: "storage", canRetry: false });
    f.check.mockResolvedValue(missing()); await f.controller.refresh(); await f.controller.retry();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(intents[3]); expect(f.newId).toHaveBeenCalledOnce();
  });
  it.each(["accepted", "rejected", "not_applied"] as const)("failed exact cleanup retains %s and refresh only retries cleanup", async outcome => {
    const f = fixture(pending());
    if (outcome === "not_applied") f.check.mockResolvedValue(closedProof());
    else if (outcome === "rejected") {
      await f.controller.refresh(); f.send.mockResolvedValueOnce({ outcome: "rejected", state_version: "8", current: current(),
        command: { id: id(4), status: "rejected" }, error: { code: "TARGET_STALE" } });
      // Start a new explicit command after the original accepted fact cleared.
    }
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("clear failed"));
    if (outcome === "rejected") await f.controller.begin(action()); else await f.controller.refresh();
    const checks = f.check.mock.calls.length, posts = f.send.mock.calls.length;
    expect(f.controller.snapshot()).toMatchObject({ outcome, pending: true, problem: "storage", canRetry: false });
    await f.controller.retry(); await f.controller.begin(action()); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome, pending: false, phase: "settled" });
    expect(f.check).toHaveBeenCalledTimes(checks); expect(f.send).toHaveBeenCalledTimes(posts);
    if (outcome === "rejected") expect(f.controller.snapshot().rejectionCode).toBe("TARGET_STALE");
  });
  it("never clears a changed slot even when the original acceptance is known", async () => {
    const f = fixture(pending()); f.check.mockImplementationOnce(async intent => {
      const newer = pending(); newer.intent.command_id = id(99); f.values.set(studyKey, JSON.stringify(newer)); return recovered(intent);
    });
    await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: true, problem: "pending_changed", canRetry: false });
    expect(JSON.parse(f.values.get(studyKey)!).intent.command_id).toBe(id(99)); expect(f.send).not.toHaveBeenCalled();
  });
  it("persists mismatch through restart and never clears it using closed observations", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockResolvedValueOnce({ outcome: "mismatch", state_version: "8", current: current(),
      command: { id: id(4), status: "rejected" }, error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await f.controller.begin(action()); f.controller.dispose(); f.check.mockResolvedValue(closedProof());
    const next = f.make(); await next.refresh(); await next.retry();
    expect(next.snapshot()).toMatchObject({ outcome: null, pending: true, problem: "mismatch", canRetry: false });
    expect(JSON.parse(f.values.get(studyKey)!).mismatch).toBe(true); expect(f.check).not.toHaveBeenCalled();
  });
  it("a check payload mismatch is sticky, retains the exact intent and cannot become a false accepted fact", async () => {
    const f = fixture(pending());
    f.check.mockRejectedValueOnce(new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"));
    await f.controller.refresh(); await f.controller.retry(); await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "mismatch", pending: true,
      pendingIntent: intents[3], outcome: null, resolved: null, current: null, rejectionCode: null, canRetry: false });
    expect(JSON.parse(f.values.get(studyKey)!).mismatch).toBe(true);
    // Even a subsequent accepted-looking callback must not be consulted for this collision.
    await f.controller.refresh(); expect(f.check).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("a check mismatch with a failed marker stays known in memory and refresh only repairs the marker", async () => {
    const f = fixture(pending()); f.check.mockRejectedValueOnce(new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"));
    vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("marker failed"));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "storage", pending: true, outcome: null, canRetry: false });
    expect(JSON.parse(f.values.get(studyKey)!).mismatch).toBeUndefined();
    await f.controller.retry(); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", pending: true, outcome: null, current: null, canRetry: false });
    expect(JSON.parse(f.values.get(studyKey)!).mismatch).toBe(true);
    expect(f.check).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("check mismatch discovered by an explicit retry hides prior current and prevents its POST", async () => {
    const f = fixture(pending());
    f.check.mockResolvedValueOnce(missing()).mockRejectedValueOnce(new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"));
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ canRetry: true, current: { status: "active" } });
    await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", current: null, outcome: null, canRetry: false, pending: true });
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce(); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("ignores a check mismatch arriving after document disposal", async () => {
    const f = fixture(pending()), gate = deferred<void>();
    f.check.mockImplementationOnce(async () => { await gate.promise; throw new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"); });
    const work = f.controller.refresh(); await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce());
    const updates = f.updates.length; f.controller.dispose(); gate.resolve(); await work;
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", pending: true, outcome: null, current: null });
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.updates).toHaveLength(updates);
    expect(f.send).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it.each(["read", "write"])("disposal during check mismatch marker %s prevents subsequent owner effects", async stage => {
    const f = fixture(pending()), gate = deferred<string | null>(), raw = f.values.get(studyKey)!;
    f.check.mockRejectedValueOnce(new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"));
    if (stage === "read") vi.mocked(f.storage.get).mockResolvedValueOnce(raw).mockReturnValueOnce(gate.promise);
    else vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => { await gate.promise; f.values.set(key, value); });
    const work = f.controller.refresh();
    await vi.waitFor(() => stage === "read" ? expect(f.storage.get).toHaveBeenCalledTimes(2) : expect(f.storage.set).toHaveBeenCalledOnce());
    const updates = f.updates.length; f.controller.dispose(); gate.resolve(raw); await work;
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", pending: true, outcome: null, current: null });
    expect(f.updates).toHaveLength(updates); expect(f.send).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
    if (stage === "read") expect(f.storage.set).not.toHaveBeenCalled();
    else expect(JSON.parse(f.values.get(studyKey)!).mismatch).toBe(true);
  });
  it("retries a failed mismatch marker write locally without checking or resending the colliding UUID", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockImplementationOnce(async () => {
      vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("marker failed"));
      return { outcome: "mismatch", state_version: "8", current: current(),
        command: { id: id(4), status: "rejected" }, error: { code: "COMMAND_PAYLOAD_MISMATCH" } };
    });
    await f.controller.begin(action()); expect(f.controller.snapshot()).toMatchObject({ problem: "storage", canRetry: false });
    await f.controller.retry(); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", pending: true, outcome: null });
    expect(JSON.parse(f.values.get(studyKey)!).mismatch).toBe(true);
    expect(f.check).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("a competing owner cannot overwrite the slot discovered after initial refresh", async () => {
    const f = fixture(); await f.controller.refresh();
    const other = pending(); other.intent.command_id = id(99);
    await f.study.save(other, new AbortController().signal); await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ problem: "pending_changed", canRetry: false, pending: true });
    expect(JSON.parse(f.values.get(studyKey)!).intent.command_id).toBe(id(99)); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["load", "mismatch"])("storage failure during %s blocks any POST", async stage => {
    const f = fixture(stage === "mismatch" ? { ...pending(), mismatch: true } : undefined);
    vi.mocked(f.storage.get).mockRejectedValueOnce(new Error("unavailable"));
    await f.controller.refresh(); await f.controller.begin(action()); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: "storage", canRetry: false }); expect(f.send).not.toHaveBeenCalled();
  });
  it.each([401, 403])("records access refusal %i without permitting retry", async status => {
    const f = fixture(pending()); f.check.mockRejectedValueOnce(new ApiError("http", status));
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ problem: status === 401 ? "expired" : "forbidden", canRetry: false });
  });
});

describe("oral document lifetime, detached state and shared version floor", () => {
  it.each(["check", "read", "send"] as const)("ignores late %s callbacks after disposal or revocation", async stage => {
    for (const revoke of [false, true]) {
    const f = fixture(stage === "send" ? undefined : pending());
    const gate = deferred<OralStatus | OralRead | OralReply>();
    let work: Promise<void>;
    if (stage === "send") {
      await f.controller.refresh(); f.send.mockImplementationOnce(() => gate.promise as Promise<OralReply>); work = f.controller.begin(action());
    } else {
      if (stage === "check") f.check.mockImplementationOnce(() => gate.promise as Promise<OralStatus>);
      else { f.check.mockResolvedValue(missing()); f.read.mockImplementationOnce(() => gate.promise as Promise<OralRead>); }
      work = f.controller.refresh();
    }
    await vi.waitFor(() => expect(f[stage]).toHaveBeenCalledOnce()); const updates = f.updates.length;
    if (revoke) f.isLive.mockReturnValue(false); else f.controller.dispose();
    gate.resolve(stage === "read" ? { current: current(), state_version: "8" } : recovered()); await work;
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", outcome: null, current: null });
    expect(f.values.has(studyKey)).toBe(true); expect(f.updates).toHaveLength(updates);
    }
  });
  it.each(["load", "save_read", "save_write", "clear"] as const)("disposal during storage %s prevents later document effects", async stage => {
    const f = fixture(stage === "clear" ? pending() : undefined);
    const gate = deferred<string | null>();
    if (stage !== "load" && stage !== "clear") await f.controller.refresh();
    if (stage === "save_write") vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => { await gate.promise; f.values.set(key, value); });
    else if (stage === "clear") vi.mocked(f.storage.remove).mockImplementationOnce(async key => { await gate.promise; f.values.delete(key); });
    else vi.mocked(f.storage.get).mockReturnValueOnce(gate.promise);
    const work = stage === "load" || stage === "clear" ? f.controller.refresh() : f.controller.begin(action());
    await vi.waitFor(() => {
      if (stage === "save_write") expect(f.storage.set).toHaveBeenCalledOnce();
      else if (stage === "clear") expect(f.storage.remove).toHaveBeenCalledOnce();
      else expect(f.storage.get).toHaveBeenCalledTimes(stage === "load" ? 1 : 2);
    });
    f.controller.dispose(); gate.resolve(null); await work; expect(f.send).not.toHaveBeenCalled();
    if (stage === "load" || stage === "save_read") expect(f.storage.set).not.toHaveBeenCalled();
    if (stage === "save_write") expect(f.values.has(studyKey)).toBe(true);
    expect(f.controller.snapshot().phase).toBe("disposed");
  });
  it.each(["checking", "sending"])("onUpdate reentrant disposal at %s prevents following work", async phase => {
    const f = fixture(), controller = f.make({ onUpdate: snapshot => { if (snapshot.phase === phase) controller.dispose(); } });
    await controller.refresh(); if (phase === "sending") await controller.begin(action());
    expect(f.send).not.toHaveBeenCalled(); expect(f.storage.set).not.toHaveBeenCalled();
  });
  it("onUpdate can mutate only its detached snapshot while begin is in flight", async () => {
    const f = fixture(), controller = f.make({ onUpdate: snapshot => {
      if (snapshot.pendingIntent) {
        snapshot.pendingIntent.session_id = id(99); Object.assign(snapshot.pendingIntent.payload, { correct: false });
      }
      if (snapshot.phase === "sending") {
        expect(controller.begin(action())).toBe(controller.retry());
      }
    } });
    await controller.refresh(); await controller.begin(action()); expect(f.send).toHaveBeenCalledExactlyOnceWith(intents[3]);
    expect(f.newId).toHaveBeenCalledOnce();
  });
  it("revoked isLive during save prevents POST, and captured callbacks cannot switch to a replacement document", async () => {
    const f = fixture(), controller = new OralCommandController(f.options); await controller.refresh();
    const gate = deferred<void>(); vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => { await gate.promise; f.values.set(key, value); });
    const work = controller.begin(action()); await vi.waitFor(() => expect(f.storage.set).toHaveBeenCalledOnce());
    const replacement = vi.fn(async (intent: OralIntent) => accepted(intent)); f.options.send = replacement;
    gate.resolve(); await work; expect(f.send).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
    const next = f.make(); await next.refresh();
    vi.mocked(f.storage.set).mockImplementationOnce(async () => { f.isLive.mockReturnValue(false); });
    await next.begin(action()); expect(replacement).not.toHaveBeenCalled(); expect(next.snapshot().phase).toBe("disposed");
  });
  it("snapshots and callbacks cannot mutate durable payload, current or retained accepted addresses", async () => {
    const f = fixture(pending()); f.check.mockResolvedValue(missing()); await f.controller.refresh();
    const value = f.controller.snapshot(); Object.assign(value.pendingIntent!.payload, { correct: false });
    if (value.current && "assignment" in value.current && value.current.assignment?.revealed) value.current.assignment.translations.push("changed");
    expect(f.controller.snapshot().pendingIntent).toEqual(intents[3]);
    expect((f.controller.snapshot().current as OralSessionProjection).assignment).toMatchObject({ translations: ["дом"] });
    f.send.mockImplementationOnce(async intent => { intent.session_id = id(99); return accepted(intents[3]); });
    await f.controller.retry(); const settled = f.controller.snapshot(); settled.resolved!.resultId = id(99);
    expect(f.controller.snapshot().resolved).toMatchObject({ sessionId: id(3), resultId: id(11) });
  });
  it.each(["check", "read"])("rejects stale %s proof with BigInt version comparison", async stage => {
    const f = fixture(pending()), controller = f.make({ stateVersion: "9007199254740993" });
    const proof = missing(); proof.state_version = stage === "check" ? "9007199254740992" : "9007199254740993";
    f.check.mockResolvedValue(proof); f.read.mockResolvedValue({ current: current(), state_version: "9007199254740992" });
    await controller.refresh(); await controller.retry();
    expect(controller.snapshot()).toMatchObject({ problem: "stale_response", canRetry: false, stateVersion: "9007199254740993", current: null });
    expect(f.send).not.toHaveBeenCalled();
  });
  it("retains accepted fact while hiding stale or changed-pair current", async () => {
    for (const pairChanged of [false, true]) {
      const f = fixture(pending()), controller = f.make({ stateVersion: pairChanged ? "8" : "10" });
      const reply = recovered(); if (pairChanged) reply.current = { ...current(), pair: "en-de" };
      f.check.mockResolvedValue(reply); await controller.refresh();
      expect(controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, current: null, resolved: { resultId: id(11) } });
    }
  });
  it.each(["dispose", "revoke"])("a %s snapshot does not consult a departed shared version publisher", async mode => {
    const f = fixture(), minimum = vi.fn((): string | null => "8");
    const controller = f.make({ minimumStateVersion: minimum }); await controller.refresh();
    if (mode === "dispose") controller.dispose(); else f.isLive.mockReturnValue(false);
    minimum.mockImplementation(() => { throw new Error("publisher departed"); });
    const calls = minimum.mock.calls.length;
    expect(controller.snapshot()).toMatchObject({ phase: "disposed", current: null, canRetry: false });
    expect(minimum).toHaveBeenCalledTimes(calls);
  });
  it("a raised shared floor immediately hides projection and retry and never regresses", async () => {
    const f = fixture(pending()); let floor: string | null = "8";
    const controller = f.make({ minimumStateVersion: () => floor }); f.check.mockResolvedValue(missing()); await controller.refresh();
    expect(controller.snapshot().canRetry).toBe(true); floor = "10";
    expect(controller.snapshot()).toMatchObject({ current: null, canRetry: false }); floor = null;
    expect(controller.snapshot()).toMatchObject({ current: null, canRetry: false });
    await controller.refresh(); expect(controller.snapshot().problem).toBe("stale_response"); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["emit", "storage"])("shared floor increase during retry %s cancels its POST", async stage => {
    const f = fixture(pending()); let floor = "8";
    const controller = f.make({ minimumStateVersion: () => floor,
      onUpdate: snapshot => { if (stage === "emit" && snapshot.phase === "sending") floor = "10"; } });
    f.check.mockResolvedValue(missing()); await controller.refresh();
    if (stage === "storage") vi.mocked(f.storage.get).mockImplementationOnce(async key => { floor = "10"; return f.values.get(key) ?? null; });
    await controller.retry(); expect(f.send).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ pending: true, canRetry: false, problem: "stale_response", phase: "unresolved" });
  });
  it("independent Stop advances shared floor while grade is in flight; late grade cannot revive its question", async () => {
    const f = fixture(); let floor = "8";
    const onUpdate = (snapshot: OralCommandSnapshot) => { if (snapshot.stateVersion && BigInt(snapshot.stateVersion) > BigInt(floor)) floor = snapshot.stateVersion; };
    const study = f.make({ minimumStateVersion: () => floor, onUpdate });
    const stop = f.make({ lane: "stop", pendingStore: f.stop, newId: () => id(90), minimumStateVersion: () => floor, onUpdate });
    await study.refresh(); await stop.refresh(); const gate = deferred<OralReply>(); f.send.mockReturnValueOnce(gate.promise);
    const work = study.begin(action()); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.send.mockImplementationOnce(async intent => ({ ...accepted(intent), current: current("closed"), state_version: "10" }));
    await stop.begin(action(intents[4])); expect(f.values.has(studyKey)).toBe(true); expect(f.values.has(stopKey)).toBe(false);
    gate.resolve(accepted()); await work;
    expect(stop.snapshot()).toMatchObject({ outcome: "accepted", current: { status: "closed" }, stateVersion: "10" });
    expect(study.snapshot()).toMatchObject({ outcome: "accepted", current: null, pending: false, resolved: { resultId: id(11) } });
  });
});
