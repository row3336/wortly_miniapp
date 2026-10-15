import { describe, expect, it, vi } from "vitest";
import type { ConjugationCatalog, ConjugationSessionProjection, ConjugationResultReadResponse, Profile, SavedCommandFact, OpenedClient } from "../api/generated";
import { ApiError } from "../api/http";
import { ClosedAccessError, createOpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { createConjugationApi, type ConjugationReply } from "./conjugationApi";
import { conjugationIntentHash, type ConjugationIntent } from "./conjugationIntent";
import { ConjugationCatalogPendingStore, ConjugationSessionPendingStore, ConjugationStopPendingStore,
  conjugationLane, type ConjugationPending } from "./conjugationPending";
import { ConjugationCommandController, resultAddressed, type ConjugationCommandOptions, type ConjugationRead, type ConjugationTransition } from "./conjugationCommandController";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

const id = (n: number) => `aaaaaaaa-bbbb-4000-8000-${String(n).padStart(12, "0")}`;
const base = { command_id: id(10), session_id: id(3) };
const intents: ConjugationIntent[] = [
  { command_id: id(10), kind: "conjugation.schedule", payload: { base_verb_id: id(8), tense: "present" } },
  { ...base, kind: "session.start", payload: { mode: "conjugation" } },
  { ...base, kind: "assignment.present", assignment_id: id(4), payload: {} },
  { ...base, kind: "answer.submit", assignment_id: id(4), payload: { text: "  komme\né🙂  " } },
  { ...base, kind: "result.grade", assignment_id: id(4), result_id: id(6), expected_result_version: "1", payload: { grade: 5 } },
  { ...base, kind: "result.correct", assignment_id: id(4), result_id: id(6), expected_result_version: "1", payload: {} },
  { ...base, kind: "session.stop", payload: { reason: "stop" } },
  { ...base, kind: "result.undo", assignment_id: id(4), result_id: id(6), expected_result_version: "1", payload: {} },
];
const profile: Profile = { profile_id: id(90), access: { status: "admitted", version: "1", reason: null }, role: "user",
  ui_language: "ru", dictionary_language: "ru", time_zone: "Europe/Berlin", state_version: "9" };
function catalog(): ConjugationCatalog {
  return { pair: "ru-de", local_date: "2026-10-01", items: [
    { base_verb_id: id(8), lemma: "kommen", tense: "present", status: "openable", due_date: null, can_schedule: true } ] };
}
function session(assignmentId = id(4), presented = true): ConjugationSessionProjection {
  return { session_id: id(3), status: "active", mode: "conjugation", direction: "conjugation", pair: "ru-de", local_date: "2026-10-01",
    close_reason: null, progress: { total: 3, completed: 1, correct: 1, wrong: 0 },
    assignment: { id: assignmentId, card_id: id(8), status: presented ? "presented" : "prefetched", kind: "conjugation",
      cycle_id: id(9), slot_id: { cycle_id: id(9), pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
      prompt: { verb: "kommen", translation: "приходить", language: "ru", pronoun: "du", tense: "present" },
      answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } }, summary: null,
    capabilities: { answer_target: presented ? assignmentId : null, correct_target: null, grades: null, undo_target: null, stop: true, summary_home: false } };
}
function closed(): ConjugationSessionProjection {
  return { ...session(), status: "closed", close_reason: "stop", assignment: null,
    summary: { completed_cycle_ids: [], partial: [{ cycle_id: id(9), answered_groups: ["ich"] }],
      results: [{ result_id: id(6), version: "1" }], completed: 1, correct: 1, wrong: 0,
      blocks: [{ cycle_id: id(9), base_verb_id: id(8), base_lemma: "kommen", tense: "present", answered_groups: ["ich"], effect: "incomplete", grade: null }] },
    capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false } };
}
function result(version = "1", grade: 2 | 3 | 4 | 5 = 4): ConjugationResultReadResponse {
  const step = session(id(5));
  const target = { session_id: id(3), assignment_id: id(4), result_id: id(6), expected_result_version: version };
  return { action: { action_id: id(7), kind: "answer.submit", version, status: "active" },
    result: { result_id: id(6), assignment_id: id(4), version, grade, correct: grade >= 3, status: "active",
      accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: null },
    step, capabilities: { ...step.capabilities, grades: grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: grade === 2 ? target : null }, state_version: "9" };
}
/** The right of the live answer on screen (core: undo_target of the answer), with its action. */
function withUndo(view: ConjugationResultReadResponse, version = "1"): ConjugationResultReadResponse {
  view.capabilities.undo_target = { session_id: id(3), assignment_id: id(4), result_id: id(6), expected_result_version: version,
    action_id: id(7), kind: "answer.submit" };
  return view;
}
/** The reply of an accepted undo: the answer retired at its next version, the same form issued anew as a prefetched question. */
function undone(expected: string): ConjugationResultReadResponse {
  const step = session(id(25), false), next = (BigInt(expected) + 1n).toString();
  return { action: { action_id: id(7), kind: "answer.submit", version: next, status: "undone" },
    result: { result_id: id(6), assignment_id: id(4), version: next, grade: 4, correct: true, status: "undone",
      accepted_at: "2026-10-01T08:00:00Z", answer_date: "2026-10-01", detail: null },
    step, capabilities: { ...step.capabilities }, state_version: "9" };
}
function readFor(intent: ConjugationIntent): ConjugationRead {
  if (intent.kind === "result.undo") return withUndo(result(intent.expected_result_version), intent.expected_result_version);
  if (intent.kind === "conjugation.schedule") return { current: catalog(), state_version: "9" };
  if (intent.kind === "session.start") return { current: { session_id: id(3), status: "not_found" }, state_version: "9" };
  if (intent.kind === "result.grade" || intent.kind === "result.correct") return result(intent.expected_result_version, intent.kind === "result.correct" ? 2 : 4);
  return { current: session(id(4), intent.kind !== "assignment.present"), state_version: "9" };
}
function acceptedBody(intent: ConjugationIntent, status = false): Record<string, unknown> {
  const isResult = ["answer.submit", "result.grade", "result.correct", "result.undo"].includes(intent.kind);
  const objectVersion = intent.kind === "result.grade" || intent.kind === "result.correct" || intent.kind === "result.undo"
    ? (BigInt(intent.expected_result_version) + 1n).toString() : "1";
  const command: SavedCommandFact = { id: intent.command_id, kind: intent.kind, status: status ? "already_applied" : "applied",
    applied_at: "2026-10-01T08:00:00Z", target_id: intent.kind === "conjugation.schedule" ? intent.payload.base_verb_id : "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: isResult ? id(7) : null, result_id: isResult ? id(6) : null, context_id: null,
    object_version: isResult || intent.kind === "conjugation.schedule" ? objectVersion : null };
  const view = intent.kind === "result.undo" ? undone(intent.expected_result_version)
    : isResult ? result(objectVersion, intent.kind === "result.grade" ? intent.payload.grade as 3 | 4 | 5 : 4)
    : { current: intent.kind === "conjugation.schedule" ? catalog() : intent.kind === "session.stop" ? closed() : session(), state_version: "9" };
  return { ...view, command };
}
function pending(intent = intents[3]): ConjugationPending {
  return { schemaVersion: 1, profileId: id(90), clientInstanceId: id(1), pair: "ru-de", intent: structuredClone(intent) };
}
function action(intent = intents[3]): ConjugationTransition {
  const { command_id: _commandId, ...transition } = structuredClone(intent);
  return transition;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Model = {
  status: "missing" | "accepted" | "mismatch";
  readBody: ConjugationRead;
  statusVersion: string;
  statusProfile: Profile;
  closedProof?: { session_id: string; status: "closed"; close_reason: "stop" };
  lostReply: boolean;
  acceptedOverride?: Record<string, unknown>;
  intercept?: (url: URL, init: RequestInit) => Promise<Response | null>;
};
/** Synthetic HTTP MODEL, not PG captures. The real Adapter validates every body,
 * status fact and expected_intent_hash; this fixture supplies no real credentials. */
function fixture(seed?: ConjugationPending, source = seed?.intent ?? intents[3]) {
  const values = new Map<string, string>(), events: string[] = [];
  const keys = { catalog: "wortly.pending.conjugation_catalog", study: "wortly.pending.conjugation_session", stop: "wortly.pending.conjugation_stop" };
  const key = keys[conjugationLane(source)];
  if (seed) values.set(key, JSON.stringify(seed));
  const storage: AsyncStorage = { get: vi.fn(async k => { events.push("storage:get"); return values.get(k) ?? null; }),
    set: vi.fn(async (k, value) => { events.push("storage:set"); values.set(k, value); }),
    remove: vi.fn(async k => { events.push("storage:remove"); values.delete(k); }) };
  const stores = { catalog: new ConjugationCatalogPendingStore(storage), study: new ConjugationSessionPendingStore(storage), stop: new ConjugationStopPendingStore(storage) };
  const model: Model = { status: "missing", readBody: readFor(source), statusVersion: "9", statusProfile: structuredClone(profile), lostReply: false };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://synthetic.invalid");
    events.push(`${init!.method}:${url.pathname}`);
    const intercepted = await model.intercept?.(url, init!);
    if (intercepted) return intercepted;
    if (init!.method === "POST") {
      const { client_instance_id: _client, document_id: _document, ...intent } = JSON.parse(String(init!.body)) as ConjugationIntent & { client_instance_id: string; document_id: string };
      model.status = "accepted";
      if (model.lostReply) throw new Error("synthetic lost POST reply");
      return new Response(JSON.stringify(acceptedBody(intent)), { status: 200 });
    }
    if (url.pathname.includes("/commands/")) {
      if (model.status === "mismatch") return new Response(JSON.stringify({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }), { status: 409 });
      if (model.status === "accepted") return new Response(JSON.stringify({ ...acceptedBody(source, true), ...model.acceptedOverride,
        verified_intent_hash: await conjugationIntentHash(source) }), { status: 200 });
      return new Response(JSON.stringify({ command: { id: source.command_id, status: "not_found" }, current: model.statusProfile,
        state_version: model.statusVersion, ...(model.closedProof ? { closed_session: model.closedProof } : {}) }), { status: 200 });
    }
    return new Response(JSON.stringify(model.readBody), { status: 200 });
  });
  const api = createConjugationApi({ fetcher, timeoutMs: 10000, maxResponseBytes: 20000, gate: testGate() });
  const isLive = vi.fn(() => true), newId = vi.fn(() => id(10));
  const command = (intent: ConjugationIntent) => ({ ...intent, client_instance_id: id(1), document_id: id(2) });
  const send = vi.fn((intent: ConjugationIntent) => api.send("synthetic-token", "synthetic-proof", command(intent)));
  const check = vi.fn((intent: ConjugationIntent) => readWithTicket(command(intent), (__command, __ticket) => api.status("synthetic-token", "synthetic-proof", __command, __ticket)));
  const read = vi.fn((intent: ConjugationIntent): Promise<ConjugationRead> => {
    if (intent.kind === "conjugation.schedule") return api.catalog("synthetic-token");
    const address = { session_id: intent.session_id, client_instance_id: id(1), document_id: id(2) };
    return resultAddressed(intent)
      ? api.read("synthetic-token", "synthetic-proof", { ...address, assignment_id: intent.assignment_id, result_id: intent.result_id })
      : api.read("synthetic-token", "synthetic-proof", address);
  });
  const options: ConjugationCommandOptions = { profileId: id(90), clientInstanceId: id(1), pair: "ru-de", lane: conjugationLane(source),
    pendingStore: stores[conjugationLane(source)], isLive, newId, send, check, read, onUpdate: vi.fn() };
  const make = (extra: Partial<ConjugationCommandOptions> = {}) => new ConjugationCommandController({ ...options, ...extra });
  return { values, events, key, storage, stores, model, fetcher, api, options, isLive, newId, send, check, read, make, controller: make() };
}

describe("conjugation persistence and immutable command lifecycle", () => {
  it("requires hydration, saves before one POST, serializes double begin and detaches input", async () => {
    const f = fixture(), intent = action(); await f.controller.begin(intent); expect(f.send).not.toHaveBeenCalled();
    await f.controller.refresh(); const first = f.controller.begin(intent), second = f.controller.begin(intent);
    expect(first).toBe(second); Object.assign(intent.payload, { text: "mutated" });
    await first; expect(f.newId).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledExactlyOnceWith(intents[3]);
    expect(f.events.indexOf("storage:set")).toBeLessThan(f.events.indexOf("POST:/api/v1/commands"));
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, resolved: { assignmentId: id(4), actionId: id(7), resultId: id(6), objectVersion: "1" } });
    expect(JSON.stringify(f.controller.snapshot())).not.toMatch(/synthetic-token|synthetic-proof/);
  });
  it("failed save cannot POST", async () => {
    const f = fixture(); await f.controller.refresh(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("disk unavailable"));
    await f.controller.begin(action()); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ problem: "storage", canRetry: false, outcome: null });
  });
  it.each(["\ud800", "x\udfff"])("rejects malformed Unicode before allocating an ID, saving or POSTing", async text => {
    const f = fixture(); await f.controller.refresh();
    await expect(f.controller.begin({ kind: "answer.submit", session_id: id(3), assignment_id: id(4), payload: { text } })).rejects.toMatchObject({ kind: "invalid" });
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it("malformed persisted Unicode blocks hydration without issuing a proof GET", async () => {
    const f = fixture(pending({ ...intents[3], kind: "answer.submit", session_id: id(3), assignment_id: id(4), payload: { text: "\ud800" } }));
    const raw = f.values.get(f.key); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "invalid_pending", phase: "blocked", canRetry: false });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.values.get(f.key)).toBe(raw);
  });
  it("an intervening replacement slot blocks later check, retry and clearing", async () => {
    const f = fixture(); await f.controller.refresh(); const replacement = pending(); replacement.intent.command_id = id(99);
    await f.stores.study.save(replacement, new AbortController().signal); await f.controller.begin(action()); await f.controller.refresh(); await f.controller.retry();
    // The new intent was neither stored nor sent: no unknown outcome is left of it; the other record stays as it was.
    expect(f.controller.snapshot()).toMatchObject({ problem: "pending_changed", pending: false, phase: "blocked", canRetry: false });
    expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(JSON.parse(f.values.get(f.key)!).intent.command_id).toBe(id(99));
  });
  it("a retained intent whose slot changed before its retry keeps its record and stays unknown", async () => {
    const f = fixture(pending()); await f.controller.refresh(); expect(f.controller.snapshot().canRetry).toBe(true);
    const replacement = pending(); replacement.intent.command_id = id(99); f.values.set(f.key, JSON.stringify(replacement));
    await f.controller.retry();
    // A retry is no new intent: the slot conflict leaves its unknown outcome as it was, and nothing is sent.
    expect(f.controller.snapshot()).toMatchObject({ problem: "pending_changed", pending: true, canRetry: false });
    expect(f.controller.snapshot().pendingIntent?.command_id).toBe(id(10));
    expect(f.send).not.toHaveBeenCalled(); expect(JSON.parse(f.values.get(f.key)!).intent.command_id).toBe(id(99));
  });
  it.each(intents.map((intent, index) => ({ kind: intent.kind, intent, index })))("lost $kind reply reloads with only exact addressed GET proof", async ({ intent }) => {
    const f = fixture(undefined, intent); f.model.lostReply = true; await f.controller.refresh(); await f.controller.begin(action(intent));
    expect(f.controller.snapshot()).toMatchObject({ pending: true, outcome: null, problem: "network" });
    f.controller.dispose(); const next = f.make(); const before = f.fetcher.mock.calls.length; await next.refresh(); await next.retry();
    expect(f.send).toHaveBeenCalledOnce(); expect(next.snapshot()).toMatchObject({ outcome: "accepted", pending: false });
    expect(f.fetcher.mock.calls.slice(before).every(([, init]) => init!.method === "GET")).toBe(true);
    const statusUrl = new URL(String(f.fetcher.mock.calls.at(-1)![0]), "https://synthetic.invalid");
    expect(statusUrl.pathname).toBe(`/api/v1/commands/${id(10)}`);
    expect(statusUrl.searchParams.get("expected_intent_hash")).toBe(await conjugationIntentHash(intent));
    expect(statusUrl.searchParams.get("session_id")).toBe(intent.kind === "conjugation.schedule" ? null : id(3));
  });
  it("unknown answer reads only its original session without inventing a result address", async () => {
    const f = fixture(pending()); await f.controller.refresh(); expect(f.controller.snapshot().canRetry).toBe(true);
    const url = new URL(String(f.fetcher.mock.calls.at(-1)![0]), "https://synthetic.invalid");
    expect(url.pathname).toBe(`/api/v1/sessions/${id(3)}`); expect(url.searchParams.has("result_id")).toBe(false);
    expect(url.searchParams.has("assignment_id")).toBe(false); expect(f.send).not.toHaveBeenCalled();
  });
  it("concurrent refresh shares one GET observation and cannot resend", async () => {
    const f = fixture(pending()), gate = deferred<Response>();
    f.model.intercept = async url => url.pathname.includes("/commands/") ? gate.promise : null;
    const first = f.controller.refresh(), second = f.controller.refresh(); expect(first).toBe(second);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    gate.resolve(new Response(JSON.stringify({ command: { id: id(10), status: "not_found" }, current: profile, state_version: "9" })));
    await first; expect(f.check).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(intents.map(intent => ({ kind: intent.kind, intent })))("manual $kind retry obtains new proof and sends the identical command", async ({ intent }) => {
    const f = fixture(pending(intent)); await f.controller.refresh(); expect(f.controller.snapshot().canRetry).toBe(true);
    const snapshot = f.controller.snapshot(); if (snapshot.pendingIntent) Object.assign(snapshot.pendingIntent.payload, { text: "mutated" });
    await f.controller.retry(); expect(f.check).toHaveBeenCalledTimes(2); expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(intent); expect(f.newId).not.toHaveBeenCalled();
  });
  it.each(["target", "version", "caps", "values"])("fresh revision retry blocks changed %s", async change => {
    const f = fixture(pending(intents[4])); await f.controller.refresh(); expect(f.controller.snapshot().canRetry).toBe(true);
    const view = result(change === "version" ? "2" : "1");
    if (change === "target") { view.result!.result_id = id(99); view.capabilities.grades!.result_id = id(99); }
    if (change === "caps") view.capabilities.grades = null;
    if (change === "values") view.capabilities.grades!.values = [3, 4]; // Invalid wire is rejected by the Adapter.
    f.model.readBody = view; await f.controller.retry(); expect(f.send).not.toHaveBeenCalled(); expect(f.controller.snapshot().canRetry).toBe(false);
  });
  it.each(["target", "version", "caps", "action", "inactive"])("a lost undo is resent only while the server still grants exactly this right: changed %s blocks it", async change => {
    const f = fixture(pending(intents[7])); await f.controller.refresh();
    // The unchanged right is verified first: only then may the same ID be sent again (CT 2.3, no right is created anew).
    expect(f.controller.snapshot()).toMatchObject({ canRetry: true, problem: "not_found" });
    const view = readFor(intents[7]) as ConjugationResultReadResponse;
    if (change === "target") { view.result!.result_id = id(99); view.capabilities.undo_target!.result_id = id(99); }
    if (change === "version") { view.result!.version = view.action!.version = "2"; }
    if (change === "caps") view.capabilities.undo_target = null;
    if (change === "action") view.capabilities.undo_target!.action_id = id(98);
    if (change === "inactive") { view.result!.status = view.action!.status = "undone"; view.capabilities.undo_target = null; }
    f.model.readBody = view;
    await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled(); expect(f.controller.snapshot()).toMatchObject({ canRetry: false, outcome: null, pending: true });
  });
  it("an accepted undo is remembered as the retired answer, never as a live one", async () => {
    const f = fixture(undefined, intents[7]); await f.controller.refresh(); await f.controller.begin(action(intents[7]));
    expect(f.send).toHaveBeenCalledExactlyOnceWith(intents[7]);
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false,
      resolved: { commandId: id(10), kind: "result.undo", assignmentId: id(4), resultId: id(6), objectVersion: "2" },
      view: { kind: "result", result: { status: "undone", version: "2" }, step: { assignment: { id: id(25), status: "prefetched" } } } });
  });
  it("disappeared schedule and changed answer assignment are unresolved rather than successful", async () => {
    const schedule = fixture(pending(intents[0])); await schedule.controller.refresh();
    schedule.model.readBody = { current: { ...catalog(), items: [] }, state_version: "9" }; await schedule.controller.retry();
    expect(schedule.controller.snapshot()).toMatchObject({ outcome: null, problem: "step_changed", canRetry: false });
    const answer = fixture(pending()); await answer.controller.refresh(); answer.model.readBody = { current: session(id(5)), state_version: "9" };
    await answer.controller.retry(); expect(answer.controller.snapshot()).toMatchObject({ outcome: null, canRetry: false });
    expect(schedule.send).not.toHaveBeenCalled(); expect(answer.send).not.toHaveBeenCalled();
  });
});

describe("proof collisions, closure and confirmed cleanup", () => {
  it("failed mismatch marker remains sticky; refresh repairs only the marker; restart proves collision again", async () => {
    const f = fixture(pending()); f.model.status = "mismatch"; vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("marker failed"));
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ problem: "storage", outcome: null, canRetry: false });
    expect(JSON.parse(f.values.get(f.key)!).mismatch).toBeUndefined();
    f.controller.dispose(); const restarted = f.make(); await restarted.refresh();
    expect(restarted.snapshot()).toMatchObject({ problem: "mismatch", outcome: null, canRetry: false });
    expect(f.check).toHaveBeenCalledTimes(2); expect(JSON.parse(f.values.get(f.key)!).mismatch).toBe(true);
    f.model.status = "accepted"; await restarted.refresh(); await restarted.retry(); expect(f.check).toHaveBeenCalledTimes(2); expect(f.send).not.toHaveBeenCalled();
  });
  it("marker failure on a living owner never permits an accepted-looking recheck", async () => {
    const f = fixture(pending()); f.model.status = "mismatch"; vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("marker failed"));
    await f.controller.refresh(); f.model.status = "accepted"; await f.controller.refresh(); await f.controller.retry();
    expect(f.check).toHaveBeenCalledOnce(); expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", pending: true, outcome: null });
  });
  it("a transport mismatch from POST becomes sticky before its failed durable marker", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockImplementationOnce(async () => { vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("marker failed")); throw new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"); });
    await f.controller.begin(action()); await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", pending: true, outcome: null, canRetry: false });
    expect(f.send).toHaveBeenCalledOnce(); expect(f.check).not.toHaveBeenCalled(); expect(JSON.parse(f.values.get(f.key)!).mismatch).toBe(true);
  });
  it("retry discovering a collision never POSTs and detaches the previous view", async () => {
    const f = fixture(pending()); await f.controller.refresh(); f.model.status = "mismatch"; await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", view: null, outcome: null, canRetry: false }); expect(f.send).not.toHaveBeenCalled();
  });
  it("known acceptance with failed clear remains accepted and subsequent refresh only clears", async () => {
    const f = fixture(pending()); f.model.status = "accepted"; vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("cleanup failed"));
    await f.controller.refresh(); const snapshot = f.controller.snapshot(); expect(snapshot).toMatchObject({ outcome: "accepted", pending: true, problem: "storage", canRetry: false });
    snapshot.resolved!.resultId = id(99); await f.controller.retry(); await f.controller.refresh();
    expect(f.check).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: false, outcome: "accepted", resolved: { resultId: id(6) } });
  });
  it("confirmed facts do not delete a replacement slot", async () => {
    const f = fixture(pending()); f.model.status = "accepted";
    const replacement = pending(); replacement.intent.command_id = id(99);
    vi.mocked(f.storage.remove).mockImplementationOnce(async () => { throw new Error("first cleanup fails"); });
    await f.controller.refresh(); f.values.set(f.key, JSON.stringify(replacement)); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: true, problem: "pending_changed" });
    expect(JSON.parse(f.values.get(f.key)!).intent.command_id).toBe(id(99)); expect(f.send).not.toHaveBeenCalled();
  });
  it("atomic missing+closed proves not_applied; a later closed read remains unknown", async () => {
    const atomic = fixture(pending()); atomic.model.closedProof = { session_id: id(3), status: "closed", close_reason: "stop" };
    await atomic.controller.refresh(); expect(atomic.controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: false, closedSession: { session_id: id(3) } });
    expect(atomic.read).not.toHaveBeenCalled();
    const later = fixture(pending()); later.model.readBody = { current: closed(), state_version: "9" }; await later.controller.refresh();
    expect(later.controller.snapshot()).toMatchObject({ outcome: null, pending: true, problem: "closed", canRetry: false }); expect(later.send).not.toHaveBeenCalled();
  });
  it("catalog cannot consume closed_session proof", async () => {
    const f = fixture(pending(intents[0])); f.model.closedProof = { session_id: id(3), status: "closed", close_reason: "stop" };
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ outcome: null, pending: true, canRetry: false }); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("atomic absence with failed cleanup remains proven and does not recheck or POST", async () => {
    const f = fixture(pending()); f.model.closedProof = { session_id: id(3), status: "closed", close_reason: "stop" };
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("cleanup failed")); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: true, canRetry: false });
    await f.controller.refresh(); await f.controller.retry(); expect(f.check).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: false });
  });
  it("addressed rejection survives a failed cleanup and cannot resend", async () => {
    const f = fixture(); await f.controller.refresh();
    f.model.intercept = async (_url, init) => init.method === "POST" ? new Response(JSON.stringify({ ...result(),
      command: { id: id(10), status: "rejected" }, error: { code: "TARGET_STALE" } }), { status: 409 }) : null;
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("cleanup failed")); await f.controller.begin(action()); await f.controller.retry(); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "rejected", pending: false, rejectionCode: "TARGET_STALE" });
    expect(f.send).toHaveBeenCalledOnce(); expect(f.check).not.toHaveBeenCalled();
  });
});

describe("identity, tagged results and document/version lifetime", () => {
  it("same UUID case is one profile; a truly foreign profile is removed without network", async () => {
    const own = fixture({ ...pending(), profileId: id(90).toUpperCase(), clientInstanceId: id(1).toUpperCase() });
    const same = own.make({ profileId: id(90).toUpperCase(), clientInstanceId: id(1).toUpperCase() }); await same.refresh(); expect(same.snapshot().canRetry).toBe(true);
    const foreign = fixture({ ...pending(), profileId: id(89) }); await foreign.controller.refresh();
    expect(foreign.fetcher).not.toHaveBeenCalled(); expect(foreign.values.has(foreign.key)).toBe(false); expect(foreign.controller.snapshot().phase).toBe("idle");
  });
  it.each(["client", "pair"])("foreign %s hides payload and rights, but an exact accepted fact may clean up", async identity => {
    const p = pending(); if (identity === "client") p.clientInstanceId = id(88); else p.pair = "en-de";
    const f = fixture(p); await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ canRetry: false, pendingIntent: null, view: null, sessionId: null });
    expect(f.read).not.toHaveBeenCalled(); f.model.status = "accepted"; await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, resolved: null, view: null }); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["mode", "session", "profile", "denied"])("wrong %s cannot restore retry rights", async wrong => {
    const f = fixture(pending());
    if (wrong === "profile") f.model.statusProfile.profile_id = id(89);
    if (wrong === "denied") f.model.statusProfile.access = { status: "rejected", version: "2", reason: "removed" };
    if (wrong === "mode") f.model.readBody = { current: { ...session(), mode: "oral" } as unknown as ConjugationSessionProjection, state_version: "9" };
    if (wrong === "session") f.model.readBody = { current: { ...session(), session_id: id(99) }, state_version: "9" };
    await f.controller.refresh(); expect(f.controller.snapshot().canRetry).toBe(false); await f.controller.retry(); expect(f.send).not.toHaveBeenCalled();
  });
  it("accepted result A preserves action/result/capabilities separately from current assignment B", async () => {
    const f = fixture(pending()); f.model.status = "accepted"; await f.controller.refresh();
    const snapshot = f.controller.snapshot(); expect(snapshot.view).toMatchObject({ kind: "result", action: { action_id: id(7) },
      result: { assignment_id: id(4), result_id: id(6) }, step: { assignment: { id: id(5) } }, capabilities: { answer_target: id(5), grades: { assignment_id: id(4) } } });
    if (snapshot.view?.kind === "result") snapshot.view.result!.assignment_id = id(99);
    expect(f.controller.snapshot().view).toMatchObject({ result: { assignment_id: id(4) } });
  });
  it("accepted unavailable result still records the immutable fact without manufacturing a result view", async () => {
    const f = fixture(pending()); f.model.status = "accepted"; f.model.acceptedOverride = { action: null, result: null, step: { status: "unavailable" },
      capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false } };
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false,
      resolved: { resultId: id(6), objectVersion: "1" }, view: { kind: "result", result: null, action: null } });
  });
  it("remembers >2^53 shared floor after its publisher disappears and keeps stale accepted facts", async () => {
    const f = fixture(pending()); let floor: string | null = "9007199254740993";
    const c = f.make({ stateVersion: "9007199254740992", minimumStateVersion: () => floor }); await c.refresh();
    expect(c.snapshot()).toMatchObject({ problem: "stale_response", view: null, pendingIntent: null, canRetry: false });
    floor = null; f.model.status = "accepted"; await c.refresh();
    expect(c.snapshot()).toMatchObject({ outcome: "accepted", pending: false, view: null, resolved: { resultId: id(6) }, stateVersion: "9007199254740992" });
  });
  it("fresh missing fact does not authorize retry through an older addressed read above 2^53", async () => {
    const f = fixture(pending()); f.model.statusVersion = "9007199254740993"; f.model.readBody.state_version = "9007199254740992";
    await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: "stale_response", canRetry: false, view: null, stateVersion: "9007199254740993" }); expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["emit", "storage"])("raised floor during retry %s prevents following POST", async stage => {
    const f = fixture(pending()); let floor = "9";
    const c = f.make({ minimumStateVersion: () => floor, onUpdate: s => { if (stage === "emit" && s.phase === "sending") floor = "10"; } });
    await c.refresh();
    if (stage === "storage") vi.mocked(f.storage.get).mockImplementationOnce(async key => { floor = "10"; return f.values.get(key) ?? null; });
    await c.retry(); expect(f.send).not.toHaveBeenCalled(); expect(c.snapshot()).toMatchObject({ canRetry: false, view: null, problem: "stale_response" });
  });
  it("independent Stop can settle while study is unknown and makes a late accepted study view stale", async () => {
    const f = fixture(); let floor = "9";
    const update: ConjugationCommandOptions["onUpdate"] = s => { if (s.stateVersion && BigInt(s.stateVersion) > BigInt(floor)) floor = s.stateVersion; };
    const study = f.make({ stateVersion: "9", minimumStateVersion: () => floor, onUpdate: update }), gate = deferred<ConjugationReply>();
    await study.refresh(); f.send.mockReturnValueOnce(gate.promise); const work = study.begin(action()); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    const stop = f.make({ lane: "stop", pendingStore: f.stores.stop, newId: () => id(99), stateVersion: "9", minimumStateVersion: () => floor, onUpdate: update,
      send: async intent => ({ ...await f.api.send("synthetic-token", "synthetic-proof", { ...intent, client_instance_id: id(1), document_id: id(2) }), state_version: "10" }) });
    await stop.refresh(); await stop.begin(action(intents[6])); expect(f.values.has(f.key)).toBe(true); expect(f.values.has("wortly.pending.conjugation_stop")).toBe(false);
    gate.resolve(await f.api.send("synthetic-token", "synthetic-proof", { ...intents[3], client_instance_id: id(1), document_id: id(2) })); await work;
    expect(stop.snapshot()).toMatchObject({ outcome: "accepted", view: { kind: "session", current: { status: "closed" } } });
    expect(study.snapshot()).toMatchObject({ outcome: "accepted", pending: false, view: null, resolved: { resultId: id(6) } });
  });
  it.each(["checking", "sending"])("onUpdate disposal during %s prevents all following store/network effects", async phase => {
    const f = fixture(), c = f.make({ onUpdate: snapshot => { if (snapshot.phase === phase) c.dispose(); } });
    await c.refresh(); if (phase === "sending") await c.begin(action());
    expect(f.storage.set).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(c.snapshot().phase).toBe("disposed");
  });
  it("onUpdate detached mutation and reentrant calls cannot substitute the pending payload", async () => {
    const f = fixture(), c = f.make({ onUpdate: snapshot => {
      if (snapshot.pendingIntent) Object.assign(snapshot.pendingIntent.payload, { text: "changed" });
      if (snapshot.phase === "sending") expect(c.begin(action())).toBe(c.refresh());
    } }); await c.refresh(); await c.begin(action()); expect(f.send).toHaveBeenCalledExactlyOnceWith(intents[3]);
  });
  it.each(["save", "check", "read", "send"])("late %s after disposal cannot perform subsequent owner effects", async stage => {
    const f = fixture(stage === "check" || stage === "read" ? pending() : undefined);
    const gate = deferred<void>(); let work: Promise<void>;
    if (stage === "save" || stage === "send") await f.controller.refresh();
    if (stage === "save") vi.mocked(f.storage.get).mockImplementationOnce(async () => { await gate.promise; return null; });
    if (stage === "check") f.check.mockImplementationOnce(async () => { await gate.promise; throw new ApiError("http", 403); });
    if (stage === "read") f.read.mockImplementationOnce(async () => { await gate.promise; return readFor(intents[3]); });
    if (stage === "send") f.send.mockImplementationOnce(async () => { await gate.promise; return { ...result(), outcome: "accepted", command: acceptedBody(intents[3]).command as SavedCommandFact }; });
    work = stage === "save" || stage === "send" ? f.controller.begin(action()) : f.controller.refresh();
    await vi.waitFor(() => stage === "save" ? expect(f.storage.get).toHaveBeenCalledTimes(2) : expect(f[stage as "send" | "check" | "read"]).toHaveBeenCalledOnce());
    const updates = vi.mocked(f.options.onUpdate).mock.calls.length; f.controller.dispose(); gate.resolve(); await work;
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", outcome: null, view: null, resolved: null });
    expect(vi.mocked(f.options.onUpdate)).toHaveBeenCalledTimes(updates); expect(f.storage.remove).not.toHaveBeenCalled();
    if (stage === "save") expect(f.storage.set).not.toHaveBeenCalled();
    if (stage !== "send") expect(f.send).not.toHaveBeenCalled();
  });
  it("captures immutable callbacks rather than a caller's mutable replacement", async () => {
    const f = fixture(), c = new ConjugationCommandController(f.options); await c.refresh();
    const replacement = vi.fn((intent: ConjugationIntent) => f.send(intent)); f.options.send = replacement; await c.begin(action()); expect(replacement).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("revocation during a durable save prevents the POST and hides the owner's payload", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => { f.values.set(key, value); f.isLive.mockReturnValue(false); });
    await f.controller.begin(action()); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", pendingIntent: null, view: null, canRetry: false }); expect(f.values.has(f.key)).toBe(true);
  });
  it.each([401, 403])("real Adapter + guarded access.run prevents late %s of old owner from revoking live access", async status => {
    const f = fixture(pending()), gate = deferred<Response>(), onDenied = vi.fn();
    const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
      profile, session: { id: id(3), phase: "active" }, compatibility: { compatible: true, contract_version: "1" } };
    const access = createOpenedAccess({ opened, token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => true, onDenied });
    f.model.intercept = async url => url.pathname.includes("/commands/") ? gate.promise : null;
    const c = f.make({ check: intent => access.run(async credentials => {
      try {
        const response = await readWithTicket({ ...intent, client_instance_id: credentials.clientInstanceId, document_id: credentials.documentId }, (__command, __ticket) => f.api.status(credentials.token, credentials.proof, __command, __ticket));
        if (c.snapshot().phase === "disposed") throw new ClosedAccessError();
        return response;
      } catch (error) {
        if (c.snapshot().phase === "disposed") throw new ClosedAccessError();
        throw error;
      }
    }) });
    const work = c.refresh(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); c.dispose();
    gate.resolve(new Response(JSON.stringify({ error: { code: "ACCESS_DENIED" } }), { status })); await work;
    expect(onDenied).not.toHaveBeenCalled(); expect(access.isLive()).toBe(true); expect(c.snapshot().phase).toBe("disposed");
  });
  it("the same guarded access callback still propagates a genuine live-owner denial", async () => {
    const f = fixture(pending()), onDenied = vi.fn();
    const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
      profile, session: { id: id(3), phase: "active" }, compatibility: { compatible: true, contract_version: "1" } };
    const access = createOpenedAccess({ opened, token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => true, onDenied });
    f.model.intercept = async () => new Response(JSON.stringify({ error: { code: "ACCESS_DENIED" } }), { status: 403 });
    const c = f.make({ check: intent => access.run(async credentials => {
      try {
        const response = await readWithTicket({ ...intent, client_instance_id: credentials.clientInstanceId, document_id: credentials.documentId }, (__command, __ticket) => f.api.status(credentials.token, credentials.proof, __command, __ticket));
        if (c.snapshot().phase === "disposed") throw new ClosedAccessError();
        return response;
      } catch (error) {
        if (c.snapshot().phase === "disposed") throw new ClosedAccessError();
        throw error;
      }
    }) }); await c.refresh(); expect(onDenied).toHaveBeenCalledOnce(); expect(c.snapshot()).toMatchObject({ problem: "forbidden", canRetry: false });
  });
});

describe("D-STALE-WINDOW 3.1.4: the core's DOCUMENT_STALE envelope refuses this attempt, not the intent", () => {
  /** The core's refusal envelope of this intent (study/coordinator.py; app.py flattens answer kinds; schedule projects its catalog). */
  function refusal(intent: ConjugationIntent, code: string): Record<string, unknown> {
    const head = { command: { id: intent.command_id, status: "rejected" }, state_version: "9", error: { code } };
    if (intent.kind === "conjugation.schedule") return { ...head, current: catalog() };
    if (["answer.submit", "result.grade", "result.correct", "result.undo"].includes(intent.kind)) return { ...head, action: null, result: null,
      step: { session_id: id(3), status: "unavailable" },
      capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false } };
    return { ...head, current: { session_id: id(3), status: "unavailable" } };
  }
  it.each(intents)("$kind keeps its record, sends once and stays unresolved as window_stale", async intent => {
    const f = fixture(undefined, intent); await f.controller.refresh();
    let saved: string | undefined;
    f.model.intercept = async (_url, init) => {
      if (init.method !== "POST") return null;
      saved = f.values.get(f.key);
      return new Response(JSON.stringify(refusal(intent, "DOCUMENT_STALE")), { status: 409 });
    };
    await f.controller.begin(action(intent));
    expect(saved).toBeDefined();
    // The same raw record as before the POST: neither cleared nor rewritten.
    expect(f.values.get(f.key)).toBe(saved);
    expect(f.storage.remove).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", pending: true, outcome: null, rejectionCode: null,
      problem: "window_stale", canRetry: false });
  });
  it.each(intents)("$kind refused as SESSION_CLOSED still settles rejected and clears its record", async intent => {
    const f = fixture(undefined, intent); await f.controller.refresh();
    f.model.intercept = async (_url, init) => init.method === "POST"
      ? new Response(JSON.stringify(refusal(intent, "SESSION_CLOSED")), { status: 409 }) : null;
    await f.controller.begin(action(intent));
    expect(f.values.has(f.key)).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ outcome: "rejected", pending: false, rejectionCode: "SESSION_CLOSED" });
  });
});

// M-SLOT-INVALID: a NEW action whose save the slot refuses over an unreadable record was neither stored nor sent: it is no unknown
// outcome, so it is never checked or retried. The unreadable record itself stays untouched; a retained one keeps its record.
describe("conjugation: an unreadable record in the shared slot meets a new action", () => {
  it.each([["not JSON", "{not json"], ["JSON of another shape", "{\"a\":1}"]])("%s: the action is dropped, nothing is requested", async (_name, raw) => {
    const f = fixture(); await f.controller.refresh(); const before = f.fetcher.mock.calls.length;
    f.values.set(f.key, raw);
    await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending", pending: false, pendingIntent: null, canRetry: false });
    await f.controller.refresh(); await f.controller.retry();
    expect(f.fetcher.mock.calls.length).toBe(before);
    expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: "idle", pending: false });
    expect(f.values.get(f.key)).toBe(raw);
  });
  it("a retained intent keeps its record and stays pending when the slot turns unreadable under its retry", async () => {
    const f = fixture(pending()); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, canRetry: true });
    f.values.set(f.key, "{not json");
    await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, problem: "invalid_pending", canRetry: false });
    expect(f.values.get(f.key)).toBe("{not json");
  });
  it("once the record is gone, a new action goes out once with a new ID", async () => {
    const f = fixture(); await f.controller.refresh();
    f.values.set(f.key, "{not json"); await f.controller.begin(action());
    f.values.delete(f.key); await f.controller.refresh();
    await f.controller.begin(action());
    expect(f.send).toHaveBeenCalledOnce(); expect(f.check).not.toHaveBeenCalled();
  });
});
