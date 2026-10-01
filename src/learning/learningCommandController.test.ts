import { previewContent } from "./learningPreview.test-support";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { LearningSessionProjection } from "../api/generated";
import type { AsyncStorage } from "../platform/storage";
import { LearningCommandController, type LearningCommandSnapshot, type LearningTransition } from "./learningCommandController";
import { createLearningSessionApi, type LearningSessionRead, type LearningSessionReply, type LearningSessionStatus } from "./learningSessionApi";
import type { LearningSessionIntent } from "./learningSessionIntent";
import { LearningSessionPendingStore, LearningStopPendingStore, type LearningSessionPending } from "./learningSessionPending";
import type { LearningAnswerIntent, LearningCommandIntent } from "./learningCommandIntent";
import type { LearningAnswerReply, LearningAnswerStatus } from "./learningAnswerApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slot = "wortly.pending.learning_session", stopSlot = "wortly.pending.learning_stop";
const intents: LearningSessionIntent[] = [
  { command_id: id(4), session_id: id(3), kind: "session.start", payload: { mode: "learning" } },
  { command_id: id(4), session_id: id(3), kind: "learning.preview_next", preview_id: id(5), payload: {} },
  { command_id: id(4), session_id: id(3), kind: "learning.known", preview_id: id(5), payload: {} },
  { command_id: id(4), session_id: id(3), kind: "assignment.present", assignment_id: id(6), payload: {} },
  { command_id: id(4), session_id: id(3), kind: "session.stop", payload: { reason: "stop" } },
  { command_id: id(4), session_id: id(3), kind: "session.stop", payload: { reason: "summary_home" } },
];
function action(intent = intents[1]): LearningTransition {
  const { command_id: _id, ...value } = structuredClone(intent); return value;
}
const pending = (intent: LearningCommandIntent = intents[1]): LearningSessionPending => ({ schemaVersion: 1, profileId: id(50),
  clientInstanceId: id(1), pair: "ru-de", intent: structuredClone(intent) });
const preview = (): LearningSessionProjection => ({ session_id: id(3), mode: "learning", status: "active",
  pair: "ru-de", local_date: "2026-09-30", close_reason: null,
  group: { id: id(10), status: "assembling", version: "1", preview_position: 0, total: 2 },
  preview: { id: id(5), card_id: id(11), position: 1, total: 2, content: previewContent(id(11)) }, assignment: null });
const question = (): LearningSessionProjection => ({ ...preview(), preview: null,
  group: { ...preview().group, status: "active", preview_position: 2 },
  assignment: { id: id(6), card_id: id(11), kind: "learning", status: "prefetched",
    prompt: { text: "дом", language: "ru", translations: ["дом"], personal_translation_version: null,
      hint: null, hint_version: null, conjunction_hint: null },
    answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } } });
const summary = (): LearningSessionProjection => ({ ...question(), status: "summary", assignment: null });
const closed = (): LearningSessionProjection => ({ ...summary(), status: "closed", close_reason: "stop" });
function accepted(intent = intents[1]): Extract<LearningSessionReply, { outcome: "accepted" }> {
  return { outcome: "accepted", state_version: "8", current: preview(), command: { id: intent.command_id,
    kind: intent.kind, status: "applied", applied_at: "2026-09-30T12:00:00Z",
    target_id: "preview_id" in intent ? intent.preview_id : "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: null, result_id: null, context_id: null, object_version: "preview_id" in intent ? "2" : null } };
}
function recovered(intent = intents[1]): Extract<LearningSessionStatus, { outcome: "accepted" }> {
  const reply = accepted(intent); return { ...reply, command: { ...reply.command, status: "already_applied" } };
}
const notFound = (): Extract<LearningSessionStatus, { outcome: "not_found" }> => ({ outcome: "not_found", state_version: "8",
  command: { id: id(4), status: "not_found" }, current: { profile_id: id(50), role: "user", ui_language: "ru",
    dictionary_language: "ru", time_zone: "UTC", state_version: "8", access: { status: "admitted", version: "1", reason: null } } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; }); return { promise, resolve };
}
type Options = ConstructorParameters<typeof LearningCommandController>[0];
function fixture(raw?: LearningSessionPending) {
  const values = new Map<string, string>(); if (raw) values.set(slot, JSON.stringify(raw));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const pendingStore = new LearningSessionPendingStore(storage), stopStore = new LearningStopPendingStore(storage);
  const send = vi.fn(async (intent: LearningSessionIntent): Promise<LearningSessionReply> => accepted(intent));
  const check = vi.fn(async (intent: LearningSessionIntent): Promise<LearningSessionStatus> => recovered(intent));
  const read = vi.fn(async (_sessionId: string): Promise<LearningSessionRead> => ({ current: preview(), state_version: "8" }));
  const newId = vi.fn(() => id(4)), isLive = vi.fn(() => true), updates: LearningCommandSnapshot[] = [];
  const make = (changes: Partial<Options> = {}) => new LearningCommandController({ profileId: id(50), clientInstanceId: id(1),
    pair: "ru-de", pendingStore, send, check, read, readResult: async () => { throw new Error("unexpected result read"); },
    newId, isLive, onUpdate: snapshot => { updates.push(snapshot); }, ...changes });
  return { controller: make(), make, values, storage, pendingStore, stopStore, send, check, read, newId, isLive, updates };
}

describe("Learning command durability and reconciliation", () => {
  it("loads before accepting input and never sends just because a document opens", async () => {
    const f = fixture(); await f.controller.begin(action()); await f.controller.retry();
    expect(f.newId).not.toHaveBeenCalled(); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "idle", pending: false, canRetry: false });
    expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it.each(intents)("saves $kind exactly before POST and permits only one in-flight action", async intent => {
    const f = fixture(); await f.controller.refresh(); const gate = deferred<LearningSessionReply>();
    f.send.mockImplementationOnce(async value => {
      expect(JSON.parse(f.values.get(slot)!)).toEqual(pending(intent)); expect(value).toEqual(intent); return gate.promise;
    });
    const input = action(intent), sending = f.controller.begin(input);
    input.session_id = id(99); Object.assign(input.payload, { wrong: true });
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.controller.snapshot()).toMatchObject({ phase: "sending", pending: true, canRetry: false });
    expect(f.controller.begin(action())).toBe(sending); expect(f.controller.retry()).toBe(sending);
    gate.resolve(accepted(intent)); await sending;
    expect(f.newId).toHaveBeenCalledOnce(); expect(f.values.size).toBe(0);
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", pending: false });
    await f.controller.refresh(); await f.controller.refresh();
    expect(f.check).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
    expect(f.controller.snapshot().phase).toBe("settled");
  });

  it("keeps a lost response unresolved and recovers acceptance with only GET after reload", async () => {
    const f = fixture(); await f.controller.refresh(); f.send.mockRejectedValueOnce(new ApiError("network"));
    await f.controller.begin(action()); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: "network", pending: true, outcome: null, canRetry: false });
    expect(f.send).toHaveBeenCalledOnce(); f.controller.dispose();
    const next = f.make(); await next.refresh();
    expect(f.check).toHaveBeenCalledExactlyOnceWith(intents[1]); expect(f.read).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce(); expect(next.snapshot()).toMatchObject({ outcome: "accepted", pending: false });
  });

  const retriable: [LearningSessionIntent, LearningSessionRead["current"]][] = [
    [intents[0], { session_id: id(3), status: "not_found" }], [intents[1], preview()], [intents[2], preview()],
    [intents[3], question()], [intents[4], preview()], [intents[4], summary()], [intents[5], summary()],
  ];
  it.each(retriable)("not-found for %j permits explicit retry only after checking its current target", async (intent, current) => {
    const f = fixture(pending(intent)); f.check.mockResolvedValue(notFound()); f.read.mockResolvedValue({ current, state_version: "9" });
    await f.controller.refresh(); expect(f.send).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledExactlyOnceWith(id(3));
    expect(f.controller.snapshot()).toMatchObject({ problem: "not_found", canRetry: true, stateVersion: "9", outcome: null });
    await f.controller.begin(action(intents[0])); expect(f.newId).not.toHaveBeenCalled();
    await f.controller.retry(); expect(f.send).toHaveBeenCalledExactlyOnceWith(intent);
  });

  const blocked: [string, LearningSessionIntent, LearningSessionRead["current"], string][] = [
    ["already created session is not proof", intents[0], preview(), "step_changed"],
    ["next preview", intents[1], { ...preview(), preview: { ...preview().preview!, id: id(90) } }, "step_changed"],
    ["already presented", intents[3], { ...question(), assignment: { ...question().assignment!, status: "presented" } }, "step_changed"],
    ["another assignment", intents[3], { ...question(), assignment: { ...question().assignment!, id: id(90) } }, "step_changed"],
    ["summary_home during active", intents[5], preview(), "step_changed"],
    ["another session", intents[1], { ...preview(), session_id: id(90) }, "step_changed"],
    ["another pair", intents[1], { ...preview(), pair: "en-de" }, "pair_changed"],
    ["closed", intents[4], closed(), "closed"],
    ["unavailable", intents[1], { session_id: id(3), status: "unavailable" }, "forbidden"],
    ["missing non-start target", intents[1], { session_id: id(3), status: "not_found" }, "step_changed"],
  ];
  it.each(blocked)("does not infer acceptance or resend when %s", async (_name, intent, current, problem) => {
    const f = fixture(pending(intent)); f.check.mockResolvedValue(notFound()); f.read.mockResolvedValue({ current, state_version: "9" });
    await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, outcome: null, canRetry: false, problem });
    expect(f.send).not.toHaveBeenCalled(); expect(f.values.has(slot)).toBe(true);
  });

  it.each(["profile", "access", "language", "client", "pair"])("not-found after changed %s cannot authorize a POST", async change => {
    const raw = pending(), status = notFound();
    if (change === "profile") status.current.profile_id = id(99);
    if (change === "access") status.current.access.status = "rejected";
    if (change === "language") status.current.dictionary_language = "en";
    if (change === "client") raw.clientInstanceId = id(99);
    if (change === "pair") raw.pair = "en-de";
    const f = fixture(raw); f.check.mockResolvedValue(status); await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, canRetry: false, current: null, outcome: null });
    expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("removes only the old account's slot and never checks its command with the new account", async () => {
    const f = fixture({ ...pending(), profileId: id(99) }); f.values.set(stopSlot, "untouched");
    await f.controller.refresh(); expect(f.check).not.toHaveBeenCalled(); expect(f.values.has(slot)).toBe(false);
    expect(f.values.get(stopSlot)).toBe("untouched"); expect(f.controller.snapshot().phase).toBe("idle");
  });

  it("can reconcile an accepted old-pair command without restoring its card or installation", async () => {
    const f = fixture({ ...pending(), clientInstanceId: id(99), pair: "en-de" });
    f.check.mockResolvedValue({ ...recovered(), current: { ...preview(), pair: "en-de" } });
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, current: null });
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it("acceptance with unavailable current clears only the command, not a right to display a card", async () => {
    const f = fixture(pending()); f.check.mockResolvedValue({ ...recovered(), current: { status: "unavailable" } });
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", current: { status: "unavailable" } });
    expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["status", "read"])("blocks retry when the %s is older than the observed state", async from => {
    const f = fixture(pending()); const controller = f.make({ stateVersion: "9" });
    f.check.mockResolvedValue({ ...notFound(), state_version: from === "status" ? "8" : "10" });
    f.read.mockResolvedValue({ current: preview(), state_version: "9" });
    await controller.refresh(); await controller.retry();
    expect(controller.snapshot()).toMatchObject({ problem: "stale_response", canRetry: false, current: null });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("retains a known acceptance fact but never rolls back current with an older response", async () => {
    const f = fixture(pending()), controller = f.make({ stateVersion: "9" }); await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, current: null, stateVersion: "9" });
  });

  it("clears previously read current before a later profile refusal", async () => {
    const f = fixture(pending()); f.check.mockResolvedValue(notFound()); await f.controller.refresh();
    expect(f.controller.snapshot().current).toEqual(preview());
    f.check.mockResolvedValue({ ...notFound(), current: { ...notFound().current, profile_id: id(99) } });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "profile_changed", current: null, canRetry: false });
  });

  it("cannot POST if persistence fails; a verified later retry saves the same command", async () => {
    const f = fixture(); await f.controller.refresh(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("write"));
    await f.controller.begin(action()); await f.controller.retry(); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ problem: "storage", pending: true, canRetry: false });
    f.check.mockResolvedValue(notFound()); await f.controller.refresh(); await f.controller.retry();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(intents[1]); expect(f.newId).toHaveBeenCalledOnce();
  });

  it.each(["accepted", "rejected"] as const)("cleanup failure after %s never re-enables a POST", async outcome => {
    const f = fixture(); await f.controller.refresh();
    if (outcome === "rejected") f.send.mockResolvedValue({ outcome, state_version: "9", current: closed(),
      command: { id: id(4), status: "rejected" }, error: { code: "SESSION_CLOSED" } });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("remove")); await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ outcome, pending: true, problem: "storage", canRetry: false });
    await f.controller.retry(); await f.controller.refresh(); expect(f.check).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.controller.snapshot()).toMatchObject({ outcome, pending: false, phase: "settled" });
  });

  it("retains durable mismatch and never treats another payload's fact as acceptance", async () => {
    const f = fixture(); await f.controller.refresh(); f.send.mockResolvedValue({ outcome: "mismatch", state_version: "9",
      current: preview(), command: { id: id(4), status: "rejected" }, error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await f.controller.begin(action()); f.controller.dispose(); const next = f.make(); await next.refresh(); await next.retry();
    expect(next.snapshot()).toMatchObject({ problem: "mismatch", pending: true, canRetry: false, outcome: null });
    expect(JSON.parse(f.values.get(slot)!).mismatch).toBe(true); expect(f.check).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("retries a failed mismatch marker write without resending or looking up the colliding fact", async () => {
    const f = fixture(); await f.controller.refresh(); f.send.mockImplementationOnce(async () => {
      vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("marker"));
      return { outcome: "mismatch", state_version: "9", current: preview(), command: { id: id(4), status: "rejected" },
        error: { code: "COMMAND_PAYLOAD_MISMATCH" } };
    });
    await f.controller.begin(action()); expect(f.controller.snapshot().canRetry).toBe(false);
    await f.controller.refresh(); expect(JSON.parse(f.values.get(slot)!).mismatch).toBe(true);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.check).not.toHaveBeenCalled();
  });

  it.each([401, 403])("never resends after HTTP%s", async status => {
    const f = fixture(pending()); f.check.mockRejectedValueOnce(new ApiError("http", status));
    await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: status === 401 ? "expired" : "forbidden", canRetry: false, current: null });
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it("bad persisted data is preserved and blocks all new commands", async () => {
    const f = fixture(); f.values.set(slot, "damaged"); await f.controller.refresh(); await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending", canRetry: false });
    expect(f.values.get(slot)).toBe("damaged"); expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
  });

  it("refuses to overwrite a different command discovered during save", async () => {
    const f = fixture(); await f.controller.refresh(); const other = pending({ ...intents[1], command_id: id(99) });
    f.values.set(slot, JSON.stringify(other)); await f.controller.begin(action());
    expect(f.controller.snapshot()).toMatchObject({ problem: "pending_changed", canRetry: false });
    expect(f.send).not.toHaveBeenCalled(); expect(JSON.parse(f.values.get(slot)!)).toEqual(other);
  });

  it("clear never deletes a replacement pending record", async () => {
    const f = fixture(); await f.controller.refresh(); const other = pending({ ...intents[1], command_id: id(99) });
    f.send.mockImplementationOnce(async intent => { f.values.set(slot, JSON.stringify(other)); return accepted(intent); });
    await f.controller.begin(action()); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", problem: "pending_changed", canRetry: false });
    expect(JSON.parse(f.values.get(slot)!)).toEqual(other); expect(f.send).toHaveBeenCalledOnce();
  });

  it.each(["dispose", "revoke"])("%s during durable save prevents POST", async mode => {
    const f = fixture(); await f.controller.refresh(); vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => {
      f.values.set(key, value); if (mode === "dispose") f.controller.dispose(); else f.isLive.mockReturnValue(false);
    });
    await f.controller.begin(action()); expect(f.send).not.toHaveBeenCalled(); expect(f.values.has(slot)).toBe(true);
  });

  it.each(["send", "check", "read"] as const)("ignores a late %s after document disposal", async source => {
    const f = fixture(source === "send" ? undefined : pending());
    const gate = deferred<LearningSessionReply>();
    if (source === "send") { await f.controller.refresh(); f.send.mockImplementationOnce(() => gate.promise); }
    else if (source === "check") f.check.mockImplementationOnce(async () => { await gate.promise; return recovered(); });
    else { f.check.mockResolvedValue(notFound()); f.read.mockImplementationOnce(async () => { await gate.promise; return { current: preview(), state_version: "9" }; }); }
    const task = source === "send" ? f.controller.begin(action()) : f.controller.refresh();
    await vi.waitFor(() => expect(f[source]).toHaveBeenCalledOnce()); f.controller.dispose(); const count = f.updates.length;
    gate.resolve(accepted()); await task;
    expect(f.updates).toHaveLength(count); expect(f.values.has(slot)).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", current: null, outcome: null, canRetry: false });
  });

  it("a revoked owner cannot read a previously cached card or start new work", async () => {
    const f = fixture(pending()); f.check.mockResolvedValue(notFound()); await f.controller.refresh();
    expect(f.controller.snapshot().current).toEqual(preview()); f.isLive.mockReturnValue(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", current: null, canRetry: false });
    await f.controller.refresh(); await f.controller.retry(); expect(f.check).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });

  it("caller mutation of a snapshot cannot alter the next snapshot", async () => {
    const f = fixture(pending()); await f.controller.refresh(); const snapshot = f.controller.snapshot();
    if (snapshot.current && "pair" in snapshot.current) snapshot.current.pair = "en-de";
    expect(f.controller.snapshot().current).toEqual(preview());
  });

  it("revocation before a queued refresh runs cannot remove a previous account's pending record", async () => {
    const f = fixture({ ...pending(), profileId: id(99) });
    const refresh = f.controller.refresh(); f.isLive.mockReturnValue(false); await refresh;
    expect(f.storage.get).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
    expect(f.values.has(slot)).toBe(true); expect(f.check).not.toHaveBeenCalled();
  });

  it.each(["checking", "sending"] as const)("an owner leaving on %s cannot start storage or HTTP work", async phase => {
    const f = fixture();
    const controller = f.make({ onUpdate: value => { if (value.phase === phase) f.isLive.mockReturnValue(false); } });
    await controller.refresh();
    if (phase === "sending") { vi.mocked(f.storage.get).mockClear(); await controller.begin(action()); }
    expect(f.storage.get).not.toHaveBeenCalled(); expect(f.storage.set).not.toHaveBeenCalled();
    expect(f.check).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });

  it("Stop has an independent durable lane while another command is still in flight", async () => {
    const f = fixture(), stop = f.make({ pendingStore: f.stopStore, newId: () => id(90) });
    await f.controller.refresh(); await stop.refresh(); const gate = deferred<LearningSessionReply>();
    f.send.mockImplementationOnce(() => gate.promise);
    const first = f.controller.begin(action()); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.send.mockImplementationOnce(async intent => {
      expect(JSON.parse(f.values.get(slot)!)).toEqual(pending());
      expect(JSON.parse(f.values.get(stopSlot)!).intent).toEqual({ ...intents[4], command_id: id(90) });
      return { ...accepted(intent), current: closed(), state_version: "10" };
    });
    await stop.begin(action(intents[4]));
    expect(stop.snapshot()).toMatchObject({ outcome: "accepted", pending: false, current: closed() });
    expect(f.values.has(slot)).toBe(true); expect(f.values.has(stopSlot)).toBe(false);
    f.controller.dispose(); gate.resolve(accepted()); await first;
    expect(f.values.has(slot)).toBe(true); expect(f.send).toHaveBeenCalledTimes(2);
  });

  it("a lost Stop reply is recovered independently without erasing another unknown command", async () => {
    const f = fixture(pending()); f.values.set(stopSlot, JSON.stringify(pending(intents[4])));
    const stop = f.make({ pendingStore: f.stopStore }); await stop.refresh();
    expect(f.check).toHaveBeenCalledExactlyOnceWith(intents[4]); expect(f.values.has(slot)).toBe(true);
    expect(f.values.has(stopSlot)).toBe(false); expect(f.send).not.toHaveBeenCalled();
  });

  it("the Stop store rejects an ordinary transition", async () => {
    const f = fixture(); await expect(f.stopStore.save(pending(), new AbortController().signal)).rejects.toMatchObject({ kind: "invalid" });
    expect(f.values.size).toBe(0);
  });

  it("real HTTP adapter and durable store recover a lost POST response using the exact GET and new document", async () => {
    const f = fixture(); let documentId = id(2);
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") { expect(f.values.has(slot)).toBe(true); throw new TypeError("lost response"); }
      const { outcome: _outcome, ...body } = recovered();
      return new Response(JSON.stringify(body));
    });
    const api = createLearningSessionApi({ fetcher, timeoutMs: 100, maxResponseBytes: 10000 });
    const callbacks = { send: (intent: LearningSessionIntent) => api.send("token", "proof", { ...intent, client_instance_id: id(1), document_id: documentId }),
      check: (intent: LearningSessionIntent) => api.status("token", "proof", { ...intent, client_instance_id: id(1), document_id: documentId }),
      read: (session_id: string) => api.read("token", "proof", { session_id, client_instance_id: id(1), document_id: documentId }) };
    const first = f.make(callbacks); await first.refresh(); await first.begin(action()); first.dispose(); documentId = id(99);
    const next = f.make(callbacks); await next.refresh();
    expect(next.snapshot()).toMatchObject({ outcome: "accepted", pending: false }); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "GET"]);
    const url = new URL(String(fetcher.mock.calls[1][0]), "http://localhost");
    expect(url.pathname).toBe(`/api/v1/commands/${id(4)}`); expect(url.searchParams.get("document_id")).toBe(id(99));
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer token", "X-Origin-Proof": "proof" });
    expect(vi.mocked(f.storage.set).mock.calls[0][1]).not.toMatch(/document_id|token|proof/);
  });
});

const answerIntent = (): LearningAnswerIntent => ({ command_id: id(4), session_id: id(3), assignment_id: id(6),
  kind: "answer.submit", payload: { text: "Hallo" } });
function answerReply(intent = answerIntent()): Extract<LearningAnswerReply, { outcome: "accepted" }> {
  const text = "text" in intent.payload ? intent.payload.text : null;
  return { outcome: "accepted", state_version: "9",
    command: { id: intent.command_id, kind: "answer.submit", status: "applied", applied_at: "2026-09-30T12:00:00Z",
      target_id: intent.assignment_id, action_id: id(20), result_id: id(21), context_id: null, object_version: "1" },
    action: { action_id: id(20), kind: "answer.submit", version: "1", status: "active" },
    result: { result_id: id(21), assignment_id: id(6), version: "1", grade: 2, correct: false, status: "active",
      accepted_at: "2026-09-30T12:00:00Z", answer_date: "2026-09-30",
      detail: { input: text === null ? { kind: "forgot" } : { kind: "text", text },
        conjunction_hint: null, examples: null, variants: [{ parts: ["Haus"] }], initial_check: { correct: false, variant_index: null, correct_answer: "Haus",
          other_answers: [], matched_spans: [], span_unit: "unicode_code_point", span_bounds: "start_inclusive_end_exclusive" } } },
    step: { ...question(), assignment: { ...question().assignment!, id: id(77) } },
    capabilities: { answer_target: null, grades: null, correct_target: null, undo_target: null, stop: true, summary_home: false } };
}
function answerFixture(raw?: LearningSessionPending) {
  const f = fixture(raw);
  const send = vi.fn<Options["send"]>(async intent => {
    if (intent.kind === "result.correct" || intent.kind === "result.grade") throw new Error("unexpected revision");
    return intent.kind === "answer.submit" ? answerReply(intent) : accepted(intent);
  });
  const check = vi.fn<Options["check"]>(async intent => {
    if (intent.kind === "result.correct" || intent.kind === "result.grade") throw new Error("unexpected revision");
    return intent.kind === "answer.submit"
      ? { ...answerReply(intent), command: { ...answerReply(intent).command, status: "already_applied" } } : recovered(intent);
  });
  f.read.mockResolvedValue({ current: { ...question(), assignment: { ...question().assignment!, status: "presented" } }, state_version: "8" });
  const make = (changes: Partial<Options> = {}) => f.make({ send, check, ...changes });
  return { ...f, make, controller: make(), send, check };
}
function answerAction(intent = answerIntent()): LearningTransition {
  const { command_id: _id, ...value } = structuredClone(intent); return value;
}

describe("Learning answer uses the same durable command barrier", () => {
  it.each([{ text: "  Häüser\n😀 / token / proof" }, { text: "" }, { forgot: true }] as const)(
    "saves exact input %j before POST and recovers with no second send", async payload => {
      const intent = { ...answerIntent(), payload }, f = answerFixture(); await f.controller.refresh();
      f.send.mockImplementationOnce(async received => {
        expect(received).toEqual(intent); expect(JSON.parse(f.values.get(slot)!)).toEqual(pending(intent));
        throw new ApiError("network");
      });
      const value = answerAction(intent), sending = f.controller.begin(value);
      Object.assign(value.payload, { text: "changed by caller", extra: true });
      await sending; await f.controller.retry();
      expect(f.controller.snapshot()).toMatchObject({ pending: true, outcome: null, answer: null, canRetry: false });
      f.controller.dispose(); const next = f.make(); await next.refresh();
      expect(f.check).toHaveBeenCalledExactlyOnceWith(intent); expect(f.send).toHaveBeenCalledOnce();
      expect(next.snapshot()).toMatchObject({ phase: "settled", pending: false, outcome: "accepted",
        answer: { result: { detail: { input: "text" in payload ? { kind: "text", text: payload.text } : { kind: "forgot" } } } } });
      expect(f.values.size).toBe(0);
    });

  it.each(["text", "assignment", "forgot"] as const)("does not change the persisted %s of an unknown answer", async change => {
    const original = pending(answerIntent()), f = answerFixture(original), changed = pending(answerIntent());
    if (changed.intent.kind !== "answer.submit") throw new Error();
    if (change === "text") changed.intent.payload = { text: "another" };
    if (change === "assignment") changed.intent.assignment_id = id(99);
    if (change === "forgot") changed.intent.payload = { forgot: true };
    for (const op of ["save", "clear", "markMismatch"] as const) {
      await expect(f.pendingStore[op](changed, new AbortController().signal)).rejects.toMatchObject({ kind: "changed" });
    }
    expect(JSON.parse(f.values.get(slot)!)).toEqual(original);
  });

  it("not-found allows only an explicit repeat of the same presented assignment", async () => {
    const f = answerFixture(pending(answerIntent())); f.check.mockResolvedValue(notFound());
    await f.controller.refresh(); expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, canRetry: true, answer: null, problem: "not_found" });
    await f.controller.begin(action()); expect(f.newId).not.toHaveBeenCalled();
    await f.controller.retry(); expect(f.send).toHaveBeenCalledExactlyOnceWith(answerIntent());
    expect(f.controller.snapshot().answer?.result?.assignment_id).toBe(id(6));
    expect(f.controller.snapshot().current).toMatchObject({ assignment: { id: id(77), status: "prefetched" } });
  });

  it.each(["prefetched", "another", "closed", "summary", "pair"] as const)(
    "does not resend when the current target is %s", async state => {
      const f = answerFixture(pending(answerIntent())); f.check.mockResolvedValue(notFound());
      const current = { ...question(), assignment: { ...question().assignment!, status: "presented" as const } };
      const read: LearningSessionRead = { current, state_version: "8" };
      if (state === "prefetched") read.current = question();
      if (state === "another") current.assignment.id = id(99);
      if (state === "closed") read.current = closed();
      if (state === "summary") read.current = summary();
      if (state === "pair") current.pair = "en-de";
      f.read.mockResolvedValue(read); await f.controller.refresh(); await f.controller.retry();
      expect(f.controller.snapshot()).toMatchObject({ canRetry: false, pending: true, outcome: null, answer: null });
      expect(f.send).not.toHaveBeenCalled();
    });

  it("an unknown answer cannot be overwritten by a session/preview transition", async () => {
    const f = answerFixture(pending(answerIntent())); f.check.mockResolvedValue(notFound()); await f.controller.refresh();
    await f.controller.begin(action(intents[1]));
    await expect(f.pendingStore.save(pending(intents[1]), new AbortController().signal)).rejects.toMatchObject({ kind: "changed" });
    expect(f.send).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    expect(JSON.parse(f.values.get(slot)!).intent.kind).toBe("answer.submit");
  });

  it("an unknown present blocks an answer in the same slot", async () => {
    const f = answerFixture(pending(intents[3])); f.check.mockResolvedValue(notFound()); await f.controller.refresh();
    await f.controller.begin(answerAction());
    await expect(f.pendingStore.save(pending(answerIntent()), new AbortController().signal)).rejects.toMatchObject({ kind: "changed" });
    expect(f.send).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    expect(JSON.parse(f.values.get(slot)!).intent.kind).toBe("assignment.present");
  });

  it("durability failure does not send or expose an invented result", async () => {
    const f = answerFixture(); await f.controller.refresh(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("write"));
    await f.controller.begin(answerAction()); await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled(); expect(f.controller.snapshot()).toMatchObject({ problem: "storage", answer: null, outcome: null });
    f.check.mockResolvedValue(notFound()); await f.controller.refresh(); await f.controller.retry();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(answerIntent()); expect(f.newId).toHaveBeenCalledOnce();
  });

  it("known acceptance survives failed pending cleanup with its current result intact", async () => {
    const f = answerFixture(); await f.controller.refresh(); vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("remove"));
    await f.controller.begin(answerAction());
    expect(f.controller.snapshot()).toMatchObject({ outcome: "accepted", pending: true, canRetry: false, problem: "storage",
      answer: { result: { result_id: id(21), version: "1" } }, current: { assignment: { id: id(77) } } });
    await f.controller.retry(); await f.controller.refresh();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.check).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: false, phase: "settled", answer: { result: { result_id: id(21) } } });
  });

  it("mismatch survives reload and cannot confirm a colliding answer", async () => {
    const f = answerFixture(); await f.controller.refresh();
    f.send.mockResolvedValue({ ...answerReply(), outcome: "mismatch", command: { id: id(4), status: "rejected" },
      error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await f.controller.begin(answerAction()); f.controller.dispose();
    const next = f.make(); await next.refresh(); await next.retry();
    expect(next.snapshot()).toMatchObject({ answer: null, canRetry: false, problem: "mismatch", outcome: null });
    expect(f.check).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
  });

  it("a stale accepted reply resolves the intent but cannot restore an older result", async () => {
    const f = answerFixture(pending(answerIntent())), controller = f.make({ stateVersion: "10" });
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, stateVersion: "10", answer: null, current: null });
  });

  it.each(["pair", "unavailable", "revoked"] as const)("accepted detail stays hidden after %s", async reason => {
    const f = answerFixture(pending(answerIntent()));
    const value: Extract<LearningAnswerStatus, { outcome: "accepted" }> = { ...answerReply(),
      command: { ...answerReply().command, status: "already_applied" } };
    if (reason === "pair") value.step = { ...question(), pair: "en-de" };
    if (reason === "unavailable") { value.step = { status: "unavailable" }; value.action = value.result = null; }
    f.check.mockResolvedValue(value); await f.controller.refresh();
    if (reason === "revoked") f.isLive.mockReturnValue(false);
    expect(f.controller.snapshot().answer).toBeNull();
  });

  it("snapshot consumers cannot mutate retained answer detail or rights", async () => {
    const f = answerFixture(pending(answerIntent())); await f.controller.refresh();
    const value = f.controller.snapshot(); value.answer!.result!.grade = 5; value.answer!.capabilities.stop = false;
    expect(f.controller.snapshot().answer).toMatchObject({ result: { grade: 2 }, capabilities: { stop: true } });
  });

  it("Stop can finish while an answer POST remains unresolved, and late answer cannot revive its detail", async () => {
    const f = answerFixture(), stop = f.make({ pendingStore: f.stopStore, newId: () => id(90) });
    await f.controller.refresh(); await stop.refresh(); const gate = deferred<LearningAnswerReply>();
    f.send.mockImplementationOnce(() => gate.promise);
    const saving = f.controller.begin(answerAction()); await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.send.mockImplementationOnce(async intent => {
      if (intent.kind !== "session.stop") throw new Error();
      expect(JSON.parse(f.values.get(slot)!).intent).toEqual(answerIntent());
      return { ...accepted(intent), current: closed(), state_version: "10" };
    });
    await stop.begin(action(intents[4])); f.controller.dispose();
    gate.resolve(answerReply()); await saving;
    expect(stop.snapshot()).toMatchObject({ outcome: "accepted", current: { status: "closed" } });
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", answer: null, current: null, outcome: null });
    expect(f.values.has(slot)).toBe(true); expect(f.values.has(stopSlot)).toBe(false);
    expect(f.send).toHaveBeenCalledTimes(2);
  });

  it.each([{ text: "answer", forgot: true }, { forgot: false }, { text: 1 }, {}, { text: "answer", proof: "synthetic" }])(
    "malformed persisted answer %j is not treated as empty", async payload => {
      const f = answerFixture(); f.values.set(slot, JSON.stringify(pending({ ...answerIntent(), payload } as LearningAnswerIntent)));
      await f.controller.refresh(); await f.controller.begin(answerAction());
      expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending" });
      expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled(); expect(f.values.has(slot)).toBe(true);
    });
});

const missingClosed = (): Extract<LearningSessionStatus, { outcome: "not_found" }> => ({ ...notFound(),
  closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } });
describe("Authoritative closure of a missing Learning command", () => {
  it.each([...intents, answerIntent()])("resolves $kind without a POST and allows a new explicit action", async intent => {
    const f = fixture(pending(intent)); f.check.mockResolvedValue(missingClosed());
    f.values.set(stopSlot, "separate Stop");
    await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", pending: false, outcome: "not_applied",
      current: null, answer: null, canRetry: false, closedSession: missingClosed().closed_session });
    expect(f.read).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled(); expect(f.values.has(slot)).toBe(false);
    expect(f.values.get(stopSlot)).toBe("separate Stop");
    f.newId.mockReturnValue(id(90));
    await f.controller.begin({ kind: "session.start", session_id: id(91), payload: { mode: "learning" } });
    expect(f.send).toHaveBeenCalledExactlyOnceWith({ command_id: id(90), session_id: id(91), kind: "session.start", payload: { mode: "learning" } });
    expect(f.controller.snapshot().closedSession).toBeNull();
  });

  it.each(["client", "pair", "language"])("can reconcile its own final closure after %s changes", async changed => {
    const raw = pending(answerIntent()), reply = missingClosed();
    if (changed === "client") raw.clientInstanceId = id(99);
    if (changed === "pair") raw.pair = "en-de";
    if (changed === "language") reply.current.dictionary_language = "en";
    const f = fixture(raw); f.check.mockResolvedValue(reply); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: false, canRetry: false });
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it.each(["stale", "profile", "access", "session"])("does not clear an unresolved command for %s proof", async problem => {
    const reply = missingClosed();
    if (problem === "stale") reply.state_version = "7";
    if (problem === "profile") reply.current.profile_id = id(99);
    if (problem === "access") reply.current.access.status = "rejected";
    if (problem === "session") reply.closed_session!.session_id = id(99);
    const f = fixture(pending(answerIntent())), controller = f.make({ stateVersion: "8" });
    f.check.mockResolvedValue(reply); await controller.refresh(); await controller.retry();
    expect(controller.snapshot()).toMatchObject({ outcome: null, pending: true, canRetry: false, closedSession: null });
    expect(f.values.has(slot)).toBe(true); expect(f.send).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it("a later closed read is unresolved until absence and closure are confirmed together", async () => {
    const f = fixture(pending(answerIntent())); f.check.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(missingClosed());
    f.read.mockResolvedValue({ current: closed(), state_version: "8" });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: null, problem: "closed", pending: true });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: false, closedSession: missingClosed().closed_session });
    expect(f.send).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce();
  });

  it("retains a known non-application after cleanup failure, then retries only exact local cleanup", async () => {
    const f = fixture(pending(answerIntent())); f.check.mockResolvedValue(missingClosed());
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("remove failed"));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: true, problem: "storage", canRetry: false });
    await f.controller.retry(); await f.controller.begin(action()); expect(f.send).not.toHaveBeenCalled();
    const snapshot = f.controller.snapshot(); snapshot.closedSession!.close_reason = "midnight";
    expect(f.controller.snapshot().closedSession?.close_reason).toBe("stop");
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "not_applied", pending: false });
    expect(f.check).toHaveBeenCalledOnce(); expect(f.values.has(slot)).toBe(false);
  });

  it("does not erase a different saved intent after observing final closure", async () => {
    const f = fixture(pending(answerIntent()));
    f.check.mockImplementationOnce(async () => {
      f.values.set(slot, JSON.stringify(pending({ ...answerIntent(), command_id: id(99) }))); return missingClosed();
    });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ outcome: "not_applied", pending: true, problem: "pending_changed", canRetry: false });
    expect(JSON.parse(f.values.get(slot)!).intent.command_id).toBe(id(99)); expect(f.send).not.toHaveBeenCalled();
  });

  it("a durable mismatch cannot be resolved using somebody else's missing fact", async () => {
    const f = fixture({ ...pending(answerIntent()), mismatch: true }); f.check.mockResolvedValue(missingClosed());
    await f.controller.refresh();
    expect(f.check).not.toHaveBeenCalled(); expect(f.controller.snapshot()).toMatchObject({ outcome: null, pending: true, problem: "mismatch" });
  });

  it.each(["dispose", "revoked"])("ignores a late closure after %s", async condition => {
    const f = fixture(pending(answerIntent())), gate = deferred<LearningSessionStatus>();
    f.check.mockReturnValueOnce(gate.promise); const work = f.controller.refresh();
    await vi.waitFor(() => expect(f.check).toHaveBeenCalledOnce());
    if (condition === "dispose") f.controller.dispose(); else f.isLive.mockReturnValue(false);
    gate.resolve(missingClosed()); await work;
    expect(f.values.has(slot)).toBe(true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", outcome: null, closedSession: null });
  });
});
