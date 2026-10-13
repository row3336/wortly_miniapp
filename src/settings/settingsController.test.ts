import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile, SavedCommandFact, SettingsResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { type EditableSettingIntent, type SettingIntent, type SettingKey, type SettingSaveReply, type SettingStatusReply, type SettingsApi,
  type SettingsResetIntent } from "./settingsApi";
import { SettingsController, type SettingsSnapshot } from "./settingsController";
import { SettingsPendingStore, type SettingsPending } from "./settingsPending";
import { SettingsResetPendingStore, type SettingsResetPending } from "./settingsResetPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const big = "9007199254740995";
const next = "9007199254740996";
const slot = `wortly.pending.setting:profile:${id(1)}`;
function current(state = big): SettingsResponse {
  return { state_version: state, needs_setup: true, settings: {
    ui_language: { value: "ru", version: "1" }, dictionary_language: { value: "uk", version: "1" },
    time_zone: { value: "UTC", version: "1" }, retry_gap: { value: null, version: "1" },
    retry_count: { value: 3, version: big }, learning_group_size: { value: null, version: "1" },
    learning_intervals_seconds: { value: [120, 30, 120], version: "1" },
    learning_reminder_pause_seconds: { value: null, version: "1" }, learning_mix: { value: null, version: "1" },
    strict_case: { value: true, version: "1" }, include_preterite: { value: false, version: "1" },
    include_comparative: { value: null, version: "1" }, transition_mode: { value: null, version: "1" },
    review_error_mode: { value: "strict", version: "1" },
    learning_content: { value: "words", version: "1" },
    material: { value: null, version: "1" },
  }, constraints: {
    ui_language: { type: "enum", values: ["ru", "uk", "en"] },
    dictionary_language: { type: "enum", values: ["ru", "uk", "en"] },
    retry_gap: { type: "integer", minimum: 1, maximum: 2147483647 },
    retry_count: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_group_size: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_reminder_pause_seconds: { type: "integer", minimum: 60, maximum: 2147483647 },
    learning_intervals_seconds: { type: "ordered_integer_list", nonempty: true, item_minimum: 1, item_maximum: 2147483647 },
    learning_mix: { type: "boolean" }, strict_case: { type: "boolean" }, include_preterite: { type: "boolean" },
    include_comparative: { type: "boolean" }, transition_mode: { type: "enum", values: ["normal", "accelerated"] },
    review_error_mode: { type: "enum", values: ["strict", "soft"] },
    learning_content: { type: "enum", values: ["words", "phrases", "mixed"] },
    material: { type: "exclusive_choice", modes: { level: { selected_level: ["A1", "A2", "B1", "B2", "C1", "C2"] },
      topics: { topic_ids: "nonempty_existing_uuid_list" } } },
  } };
}
const profile = (): Profile => ({ profile_id: id(1), access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: big });
const opened = (): OpenedClient => ({ status: "opened", client_instance_id: id(2), document_id: id(3),
  document_epoch: "1", proof_version: "1", profile: profile(), session: null,
  compatibility: { compatible: true, contract_version: "1" } });
const intent = (): EditableSettingIntent => ({ command_id: id(100), kind: "setting.save", expected_field_version: big,
  payload: { key: "retry_count", value: 4 } });
const pending = (): SettingsPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), intent: intent() });
const fact = (request: SettingIntent = intent()): SavedCommandFact => ({ id: request.command_id, kind: "setting.save", status: "applied",
  applied_at: "2026-09-30T00:00:00Z", target_id: id(1), action_id: null, result_id: null, context_id: null,
  object_version: String(BigInt(request.expected_field_version) + 1n) });
function accepted(request: SettingIntent = intent()): SettingSaveReply {
  const data = current(next);
  Object.assign(data.settings[request.payload.key as SettingKey], { value: structuredClone(request.payload.value),
    version: String(BigInt(request.expected_field_version) + 1n) });
  return { outcome: "accepted", command: fact(request), current: data, state_version: data.state_version };
}
const missing = (state = big): SettingStatusReply => ({ outcome: "not_found", command: { id: id(100), status: "not_found" },
  current: { ...profile(), state_version: state }, state_version: state });
function applied(data = current(next)): Extract<SettingStatusReply, { outcome: "accepted" }> {
  return { outcome: "accepted", command: { ...fact(), status: "already_applied" }, current: data, state_version: data.state_version };
}
function rejected(data = current(next), mismatch = false): SettingSaveReply {
  return { outcome: mismatch ? "mismatch" : "rejected", command: { id: id(100), status: "rejected" },
    error: { code: mismatch ? "COMMAND_PAYLOAD_MISMATCH" : "VERSION_CONFLICT" }, current: data, state_version: data.state_version };
}
const resetSlot = `wortly.pending.settings-reset:profile:${id(1)}`;
const resetIntent = (commandId = id(100)): SettingsResetIntent => ({ command_id: commandId, kind: "settings.reset", payload: {} });
const resetRecord = (commandId = id(100)): SettingsResetPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: resetIntent(commandId) });
/** The server's settings after a reset: the eleven fields at their initial values, versions advanced. */
function resetData(): SettingsResponse {
  const data = current(next);
  const initial: Record<string, unknown> = { learning_group_size: 5, learning_content: "words", learning_mix: false,
    review_error_mode: "soft", transition_mode: "normal", strict_case: true, include_preterite: false, include_comparative: false,
    learning_intervals_seconds: [30, 120, 600, 3600, 10800, 18000], retry_gap: 3, retry_count: 4 };
  for (const [key, value] of Object.entries(initial)) {
    const field = data.settings[key as SettingKey];
    Object.assign(field, { value, version: String(BigInt(field.version) + 1n) });
  }
  return data;
}
const resetFact = (commandId = id(100)): SavedCommandFact => ({ id: commandId,
  kind: "settings.reset", status: "applied", applied_at: "2026-10-08T00:00:00Z", target_id: id(1), action_id: null, result_id: null,
  context_id: null, object_version: "7" });
function resetApplied(data = resetData()): Extract<SettingStatusReply, { outcome: "accepted" }> {
  return { outcome: "accepted", command: { ...resetFact(), status: "already_applied" }, current: data, state_version: data.state_version };
}
function resetAccepted(commandId = id(100)): SettingSaveReply {
  const data = resetData();
  return { outcome: "accepted", command: resetFact(commandId), current: data, state_version: data.state_version };
}
function persisted() {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  return { values, storage, store: new SettingsPendingStore(storage), resetStore: new SettingsResetPendingStore(storage) };
}
function fixture(options: { disk?: ReturnType<typeof persisted>; opened?: OpenedClient; minimumStateVersion?(): string | null } = {}) {
  const disk = options.disk ?? persisted();
  const api = { get: vi.fn<SettingsApi["get"]>(async () => current()),
    save: vi.fn<SettingsApi["save"]>(async (_token, _proof, _profile, request) => accepted(request)),
    status: vi.fn<SettingsApi["status"]>(async () => missing()),
    reset: vi.fn<SettingsApi["reset"]>(async (_token, _proof, _profile, request) => resetAccepted(request.command_id)),
    resetStatus: vi.fn<SettingsApi["resetStatus"]>(async () => missing()) };
  const states: SettingsSnapshot[] = [];
  const onDenied = vi.fn();
  let access: OpenedAccess | null = null;
  function replace(data = options.opened ?? opened(), generation = 1, suffix = "initial") {
    let handle!: OpenedAccess;
    handle = createOpenedAccess({ opened: data, token: `synthetic-token-${suffix}`, proof: `synthetic-proof-${suffix}`,
      generation, isLive: () => access === handle, onDenied });
    access = handle;
    return handle;
  }
  replace();
  let sequence = 100;
  const newId = vi.fn(() => id(sequence++));
  const controller = new SettingsController({ api, pendingStore: disk.store, resetStore: disk.resetStore, access: () => access,
    newId, minimumStateVersion: options.minimumStateVersion, onUpdate: state => states.push(state) });
  return { controller, api, disk, states, onDenied, newId, replace, close: () => { access = null; } };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function seed(disk: ReturnType<typeof persisted>, record = pending()) {
  await disk.store.save(record, new AbortController().signal);
}
async function editing(f = fixture()) {
  await f.controller.refresh();
  f.controller.edit("retry_count", "4");
  return f;
}

describe("settings drafts and version conflicts", () => {
  it("does not expose settings older than the opened profile", async () => {
    const f = fixture({ opened: { ...opened(), profile: { ...profile(), state_version: next } } });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ data: null, canEdit: false });
    f.controller.edit("retry_count", "4"); await f.controller.save("retry_count");
    expect(f.api.save).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    f.api.get.mockResolvedValueOnce(current(next)); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", data: current(next), canEdit: true });
  });
  it("a refreshed profile invalidates old editing rights immediately without losing the draft", async () => {
    const f = await editing();
    f.replace({ ...opened(), profile: { ...profile(), state_version: next } });
    expect(f.controller.snapshot()).toMatchObject({ dataCurrent: false, canEdit: false, drafts: { retry_count: { input: "4", canSave: false } } });
    await f.controller.save("retry_count"); expect(f.api.save).not.toHaveBeenCalled();
    f.api.get.mockResolvedValueOnce(current(next)); await f.controller.refresh();
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "4", canSave: true });
  });
  it("a newer shared version immediately blocks stale edits and an older GET cannot lower it", async () => {
    let minimum = big; const f = await editing(fixture({ minimumStateVersion: () => minimum }));
    minimum = next;
    expect(f.controller.snapshot()).toMatchObject({ dataCurrent: false, canEdit: false, drafts: { retry_count: { input: "4", canSave: false, error: null } } });
    f.controller.edit("retry_count", "99"); await f.controller.keepMine("retry_count"); await f.controller.save("retry_count");
    expect(f.controller.snapshot().drafts.retry_count?.input).toBe("4"); expect(f.api.save).not.toHaveBeenCalled();
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ dataCurrent: false, problem: { reason: "stale_response" } });
    minimum = "1"; expect(f.controller.snapshot().dataCurrent).toBe(false);
    f.api.get.mockResolvedValueOnce(current(next)); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ dataCurrent: true, canEdit: true, drafts: { retry_count: { input: "4", canSave: true } } });
  });
  it("fresh field data still reports a conflict after a version-gated refresh", async () => {
    let minimum = big; const f = await editing(fixture({ minimumStateVersion: () => minimum })); minimum = next;
    const fresh = current(next); fresh.settings.retry_count = { value: 7, version: next };
    f.api.get.mockResolvedValueOnce(fresh); await f.controller.refresh();
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "4", original: 3, fieldVersion: big,
      conflict: true, error: "conflict", canSave: false, canKeepMine: true });
    await f.controller.save("retry_count"); expect(f.api.save).not.toHaveBeenCalled();
  });
  it("a stale accepted save remains accepted and only fresh data can unlock editing", async () => {
    let minimum = big; const f = await editing(fixture({ minimumStateVersion: () => minimum }));
    const waiting = gate<SettingSaveReply>(); f.api.save.mockReturnValueOnce(waiting.promise);
    const saving = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    minimum = "9007199254740997"; waiting.resolve(accepted(f.api.save.mock.calls[0][3])); await saving;
    expect(f.controller.snapshot()).toMatchObject({ pending: null, outcome: { status: "accepted" }, dataCurrent: false,
      canEdit: false, canRetry: false, problem: { reason: "stale_response" } });
    expect(f.disk.values.has(slot)).toBe(false); expect(f.controller.snapshot().drafts.retry_count).toBeUndefined();
    f.api.get.mockResolvedValueOnce(current(minimum)); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ dataCurrent: true, canEdit: true, outcome: { status: "accepted" } });
    expect(f.api.save).toHaveBeenCalledOnce();
  });
  it("an accepted status below the opened version clears only its own pending record", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk, opened: { ...opened(), profile: { ...profile(), state_version: "9007199254740997" } } });
    f.api.status.mockResolvedValueOnce(applied(current(next))); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pending: null, outcome: { status: "accepted" }, data: null, dataCurrent: false, canEdit: false });
    expect(disk.values.has(slot)).toBe(false); expect(f.api.save).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
  });
  it("loads before editing and exposes actual nullable values without defaults", async () => {
    const f = fixture(); f.controller.edit("retry_count", "4"); await f.controller.save("retry_count");
    expect(f.controller.snapshot().drafts).toEqual({}); expect(f.api.save).not.toHaveBeenCalled();
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", data: current(), canEdit: true, pending: null });
    expect(f.api.status).not.toHaveBeenCalled();
  });

  it.each(["", " ", "1.5", "1e2", "NaN", "-1", "0", "2147483648", "9007199254740993", null])(
    "keeps invalid numeric input %# editable without a command", async input => {
      const f = await editing(); f.controller.edit("retry_count", input); await f.controller.save("retry_count");
      expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input, original: 3, fieldVersion: big,
        valid: false, error: "invalid", canSave: false });
      expect(f.controller.snapshot().canEdit).toBe(true); expect(f.api.save).not.toHaveBeenCalled();
      expect(f.newId).not.toHaveBeenCalled();
    });

  it("uses current API constraints on refresh, keeping the unmodified input", async () => {
    const f = await editing(); const changed = current(next); changed.constraints.retry_count.maximum = 2;
    f.api.get.mockResolvedValueOnce(changed); await f.controller.refresh();
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "4", original: 3, valid: false, conflict: false });
    await f.controller.save("retry_count"); expect(f.api.save).not.toHaveBeenCalled();
  });

  it("preserves original, new current, and draft until explicitly accepting the server value", async () => {
    const f = await editing(); const changed = current(next); changed.settings.retry_count = { value: 7, version: next };
    f.api.get.mockResolvedValueOnce(changed); await f.controller.refresh();
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "4", original: 3, fieldVersion: big,
      conflict: true, error: "conflict", canSave: false, canKeepMine: true });
    expect(f.controller.snapshot().data?.settings.retry_count.value).toBe(7);
    await f.controller.save("retry_count"); expect(f.api.save).not.toHaveBeenCalled();
    f.controller.acceptCurrent("retry_count");
    expect(f.controller.snapshot().drafts).toEqual({}); expect(f.api.save).not.toHaveBeenCalled();
  });

  it("saves mine only on an explicit choice, using the latest exact field version", async () => {
    const f = await editing(); const changed = current(next); changed.settings.retry_count = { value: 7, version: next };
    f.api.get.mockResolvedValueOnce(changed); await f.controller.refresh(); await f.controller.keepMine("retry_count");
    expect(f.api.save.mock.calls[0][3]).toMatchObject({ command_id: id(100), expected_field_version: next,
      payload: { key: "retry_count", value: 4 } });
    expect(f.controller.snapshot().drafts).toEqual({});
  });

  it("revalidates an explicit conflict choice and does not overflow a field version", async () => {
    const f = await editing(); const changed = current(next);
    changed.settings.retry_count = { value: 7, version: "9223372036854775807" };
    f.api.get.mockResolvedValueOnce(changed); await f.controller.refresh(); await f.controller.keepMine("retry_count");
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ error: "version_exhausted", canKeepMine: false });
    expect(f.api.save).not.toHaveBeenCalled();
  });

  it("retains independent drafts and preserves ordered interval values exactly", async () => {
    const f = await editing(); const input = ["120", "30", "120"];
    f.controller.edit("learning_intervals_seconds", input); input[0] = "999";
    await f.controller.save("learning_intervals_seconds");
    expect(f.api.save.mock.calls[0][3].payload).toEqual({ key: "learning_intervals_seconds", value: [120, 30, 120] });
    expect(f.controller.snapshot().drafts.retry_count?.input).toBe("4");
    expect(f.controller.snapshot().drafts.learning_intervals_seconds).toBeUndefined();
  });

  it("clones nested editor and snapshot values without exposing credentials", async () => {
    const f = await editing(); const material = { mode: "topics", topic_ids: [id(8)] };
    f.controller.edit("material", material); material.topic_ids.push(id(9));
    const snapshot = f.controller.snapshot(); (snapshot.drafts.material!.input as typeof material).topic_ids.push(id(10));
    snapshot.data!.settings.retry_count.value = 999;
    expect(f.controller.snapshot().drafts.material?.input).toEqual({ mode: "topics", topic_ids: [id(8)] });
    expect(f.controller.snapshot().data?.settings.retry_count.value).toBe(3);
    expect(JSON.stringify(f.states)).not.toMatch(/synthetic-token|synthetic-proof/);
  });
});

describe("settings command lifecycle", () => {
  it("persists before POST and reports success only after the returned commit", async () => {
    const f = await editing(); const sending = gate<SettingSaveReply>();
    f.api.save.mockImplementationOnce(async (_token, _proof, subject, request) => {
      expect(subject).toBe(id(1)); expect(JSON.parse(f.disk.values.get(slot)!)).toEqual(pending());
      expect(request).toEqual({ ...intent(), client_instance_id: id(2), document_id: id(3) });
      expect(f.controller.snapshot()).toMatchObject({ phase: "sending", outcome: null, canEdit: false });
      return sending.promise;
    });
    const first = f.controller.save("retry_count"); const duplicate = f.controller.save("retry_count");
    expect(duplicate).toBe(first); await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    f.controller.edit("retry_count", "8"); expect(f.controller.snapshot().drafts.retry_count?.input).toBe("4");
    sending.resolve(accepted()); await first;
    expect(f.controller.snapshot()).toMatchObject({ pending: null, phase: "ready", canEdit: true,
      outcome: { commandId: id(100), key: "retry_count", status: "accepted" }, drafts: {} });
    expect(f.disk.values.size).toBe(0); expect(f.newId).toHaveBeenCalledOnce();
  });

  it("does not erase an edit made in the microtask before dispatch starts", async () => {
    const f = await editing(); const saving = f.controller.save("retry_count");
    f.controller.edit("retry_count", "9"); await saving;
    expect(f.api.save.mock.calls[0][3].payload.value).toBe(4);
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "9", original: 4, fieldVersion: next,
      conflict: false, canSave: true });
  });

  it("keeps a newer draft conflicted when current advanced beyond this accepted command", async () => {
    const f = await editing(); const reply = accepted(); reply.current.settings.retry_count = { value: 7, version: "9007199254740997" };
    f.api.save.mockResolvedValueOnce(reply); const saving = f.controller.save("retry_count");
    f.controller.edit("retry_count", "9"); await saving;
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "9", original: 3, fieldVersion: big, conflict: true });
    expect(f.controller.snapshot().outcome?.status).toBe("accepted");
  });

  it.each([new ApiError("network"), new ApiError("http", 503), new ApiError("invalid_response")])(
    "keeps outcome unknown after transport failure %# and manually repeats the same command", async error => {
      const f = await editing(); f.api.save.mockRejectedValueOnce(error); await f.controller.save("retry_count");
      expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canRetry: true, canEdit: false, outcome: null,
        pending: pending(), problem: { reason: "network" } });
      await f.controller.save("retry_count"); expect(f.api.save).toHaveBeenCalledOnce();
      f.replace(opened(), 1, "renewed"); await f.controller.retry();
      expect(f.api.save.mock.calls[1]).toEqual(["synthetic-token-renewed", "synthetic-proof-renewed", id(1), f.api.save.mock.calls[0][3]]);
      expect(f.newId).toHaveBeenCalledOnce(); expect(f.controller.snapshot().pending).toBeNull();
    });

  it("restores only the sent intent; not_found reads current without automatically sending", async () => {
    const disk = persisted(); await seed(disk); const data = opened(); data.document_id = id(30);
    const f = fixture({ disk, opened: data }); await f.controller.refresh();
    expect(f.api.status).toHaveBeenCalledExactlyOnceWith("synthetic-token-initial", id(1), intent());
    expect(f.api.get).toHaveBeenCalledOnce(); expect(f.api.save).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), canRetry: true, outcome: null,
      problem: { reason: "not_found" }, drafts: { retry_count: { input: 4, fieldVersion: big } } });
    expect(f.controller.snapshot().drafts.retry_count).not.toHaveProperty("original");
    await f.controller.retry();
    expect(f.api.save.mock.calls[0][3]).toEqual({ ...intent(), client_instance_id: id(2), document_id: id(30) });
    expect(f.newId).not.toHaveBeenCalled();
  });

  it("confirms an applied command independently of later current values", async () => {
    const disk = persisted(); await seed(disk); const f = fixture({ disk }); const data = current("9007199254740998");
    data.settings.retry_count = { value: 12, version: "9007199254740997" };
    f.api.status.mockResolvedValueOnce(applied(data)); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pending: null, outcome: { status: "accepted" }, drafts: {}, data });
    expect(f.disk.values.size).toBe(0); expect(f.api.get).not.toHaveBeenCalled(); expect(f.api.save).not.toHaveBeenCalled();
  });

  it("leaves the draft on a known rejection and requires a new explicit conflict decision", async () => {
    const f = await editing(); const data = current(next); data.settings.retry_count = { value: 8, version: next };
    f.api.save.mockResolvedValueOnce(rejected(data)); await f.controller.save("retry_count");
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canRetry: false, outcome: { status: "rejected", code: "VERSION_CONFLICT" },
      drafts: { retry_count: { input: "4", conflict: true, original: 3, canKeepMine: true } } });
    await f.controller.retry(); expect(f.api.save).toHaveBeenCalledOnce();
    await f.controller.keepMine("retry_count");
    expect(f.api.save.mock.calls[1][3]).toMatchObject({ command_id: id(101), expected_field_version: next });
  });

  it("does not rebase a not_found retry onto a different field version", async () => {
    const disk = persisted(); await seed(disk); const f = fixture({ disk });
    const data = current(next); data.settings.retry_count = { value: 8, version: next };
    f.api.status.mockResolvedValueOnce(missing(next)); f.api.get.mockResolvedValueOnce(data);
    await f.controller.refresh(); await f.controller.retry();
    expect(f.api.save.mock.calls[0][3]).toMatchObject({ ...intent() });
  });

  it("never lowers current state and refuses a read below the not_found version floor", async () => {
    const f = await editing(); f.api.get.mockResolvedValueOnce(current("9007199254740994")); await f.controller.refresh();
    expect(f.controller.snapshot().data?.state_version).toBe(big);
    f.api.save.mockRejectedValueOnce(new ApiError("network")); await f.controller.save("retry_count");
    f.api.status.mockResolvedValueOnce(missing(next)); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ data: null, pending: pending(), outcome: null, canRetry: true,
      problem: { reason: "stale_response" } });
  });

  it("coalesces foreground reads queued behind a send without queuing another POST", async () => {
    const f = await editing(); const sending = gate<SettingSaveReply>(); f.api.save.mockReturnValueOnce(sending.promise);
    const saving = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    const a = f.controller.refresh(), b = f.controller.refresh(); expect(a).toBe(b);
    sending.resolve(accepted()); await Promise.all([saving, a, b]);
    expect(f.api.save).toHaveBeenCalledOnce(); expect(f.api.get).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot().data?.state_version).toBe(next);
  });
});

describe("settings recovery storage", () => {
  it("does not POST if persisting fails and can retry the same in-memory intent", async () => {
    const f = await editing(); vi.mocked(f.disk.storage.set).mockRejectedValueOnce(new Error("private-details"));
    await f.controller.save("retry_count");
    expect(f.api.save).not.toHaveBeenCalled(); expect(f.controller.snapshot()).toMatchObject({ canRetry: true,
      pending: pending(), problem: { reason: "storage" }, outcome: null });
    expect(JSON.stringify(f.states)).not.toContain("private-details");
    await f.controller.retry(); expect(f.api.save).toHaveBeenCalledOnce(); expect(f.newId).toHaveBeenCalledOnce();
  });

  it("keeps an accepted fact when cleanup fails and blocks new writes until cleanup succeeds", async () => {
    const f = await editing(); vi.mocked(f.disk.storage.remove).mockRejectedValueOnce(new Error("disk"));
    await f.controller.save("retry_count");
    expect(f.controller.snapshot()).toMatchObject({ outcome: { status: "accepted" }, pending: pending(),
      canEdit: false, canRetry: false, problem: { reason: "storage" } });
    await f.controller.retry(); expect(f.api.save).toHaveBeenCalledOnce();
    await f.controller.refresh(); expect(f.controller.snapshot()).toMatchObject({ pending: null, canEdit: true, outcome: { status: "accepted" } });
    expect(f.api.status).not.toHaveBeenCalled(); expect(f.disk.values.size).toBe(0);
  });

  it.each(["bad-json", JSON.stringify({ ...pending(), token: "synthetic-private" })])(
    "blocks malformed persisted records %# without fetching or sending", async raw => {
      const disk = persisted(); disk.values.set(slot, raw); const f = fixture({ disk }); await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "invalid_pending" }, canEdit: false });
      expect(f.api.get).not.toHaveBeenCalled(); expect(f.api.save).not.toHaveBeenCalled();
      expect(f.disk.values.get(slot)).toBe(raw);
    });

  it("A → B → A: entering profile B neither reads, replaces nor deletes A's unfinished save, and A gets the same ID back", async () => {
    const disk = persisted(); await seed(disk); const stored = disk.values.get(slot)!;
    const other = opened(); other.profile.profile_id = id(99);
    const b = fixture({ disk, opened: other }); await b.controller.refresh();
    expect(b.controller.snapshot()).toMatchObject({ problem: null, pending: null, canEdit: true, phase: "ready" });
    b.controller.edit("retry_count", 5); await b.controller.save("retry_count");
    expect(b.api.save).toHaveBeenCalledOnce(); expect(b.api.status).not.toHaveBeenCalled();
    expect(disk.values.get(slot)).toBe(stored);
    const bKey = `wortly.pending.setting:profile:${id(99)}`;
    expect(disk.values.has(bKey)).toBe(false);
    const a = fixture({ disk }); await a.controller.refresh();
    expect(a.api.status).toHaveBeenCalledOnce();
    expect(a.api.status.mock.calls[0][2]).toMatchObject({ command_id: pending().intent.command_id });
    expect(a.api.save).not.toHaveBeenCalled(); expect(a.newId).not.toHaveBeenCalled();
  });
  it("a legacy global save of this profile is recovered by status for the same command_id and then cleared, without a new send", async () => {
    const disk = persisted(); const legacy = "wortly.pending.setting"; disk.values.set(legacy, JSON.stringify(pending()));
    const a = fixture({ disk }); a.api.status.mockResolvedValueOnce(applied());
    await a.controller.refresh();
    expect(a.api.status).toHaveBeenCalledOnce(); expect(a.api.status.mock.calls[0][2]).toMatchObject({ command_id: pending().intent.command_id });
    expect(a.api.save).not.toHaveBeenCalled(); expect(a.newId).not.toHaveBeenCalled();
    expect(a.controller.snapshot()).toMatchObject({ pending: null, canEdit: true, outcome: { status: "accepted" } });
    expect(disk.values.has(legacy)).toBe(false); expect(disk.values.size).toBe(0);
  });
  it("a legacy global save stays (same ID, no resend) while its status is unknown, is ignored by another profile, and repeats only on explicit retry", async () => {
    const disk = persisted(); const legacy = "wortly.pending.setting"; const raw = JSON.stringify(pending()); disk.values.set(legacy, raw);
    const a = fixture({ disk }); await a.controller.refresh();
    expect(a.controller.snapshot()).toMatchObject({ phase: "unresolved", problem: { reason: "not_found" }, pending: { intent: { command_id: id(100) } } });
    expect(a.api.save).not.toHaveBeenCalled(); expect(disk.values.get(legacy)).toBe(raw); expect(disk.values.size).toBe(1);
    const other = opened(); other.profile.profile_id = id(99);
    const b = fixture({ disk, opened: other }); await b.controller.refresh();
    expect(b.controller.snapshot()).toMatchObject({ problem: null, pending: null, canEdit: true });
    expect(disk.values.get(legacy)).toBe(raw);
    await a.controller.retry();
    expect(a.api.save).toHaveBeenCalledOnce(); expect(a.api.save.mock.calls[0][3]).toMatchObject({ command_id: id(100) });
    expect(a.newId).not.toHaveBeenCalled(); expect(disk.values.has(legacy)).toBe(false);
  });
  it("a legacy global mismatch survives a visit of another profile and still blocks the owner without status or send", async () => {
    const disk = persisted(); const legacy = "wortly.pending.setting"; const raw = JSON.stringify({ ...pending(), mismatch: true });
    disk.values.set(legacy, raw);
    const a = fixture({ disk }); await a.controller.refresh(); await a.controller.retry();
    expect(a.controller.snapshot()).toMatchObject({ canRetry: false, problem: { reason: "mismatch" }, pending: { mismatch: true } });
    const other = opened(); other.profile.profile_id = id(99);
    const b = fixture({ disk, opened: other }); await b.controller.refresh();
    expect(b.controller.snapshot()).toMatchObject({ problem: null, pending: null, canEdit: true });
    expect(disk.values.get(legacy)).toBe(raw);
    const again = fixture({ disk }); await again.controller.refresh(); await again.controller.retry();
    expect(again.controller.snapshot()).toMatchObject({ canRetry: false, problem: { reason: "mismatch" } });
    for (const f of [a, again]) { expect(f.api.status).not.toHaveBeenCalled(); expect(f.api.save).not.toHaveBeenCalled(); }
  });
  it("a legacy global save of another client is looked up by status only (client_changed), never repeated, and stays", async () => {
    const disk = persisted(); const legacy = "wortly.pending.setting"; const raw = JSON.stringify(pending()); disk.values.set(legacy, raw);
    const data = opened(); data.client_instance_id = id(22);
    const f = fixture({ disk, opened: data }); await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: false, problem: { reason: "client_changed" } });
    expect(f.api.status).toHaveBeenCalledOnce(); expect(f.api.save).not.toHaveBeenCalled(); expect(disk.values.get(legacy)).toBe(raw);
  });
  it("a legacy global save plus an occupied profile slot of the same profile blocks as invalid pending and keeps both", async () => {
    const disk = persisted(); const own = pending(); own.intent.command_id = id(777);
    disk.values.set("wortly.pending.setting", JSON.stringify(pending())); disk.values.set(slot, JSON.stringify(own));
    const a = fixture({ disk }); await a.controller.refresh();
    expect(a.controller.snapshot()).toMatchObject({ problem: { reason: "invalid_pending" }, canEdit: false });
    expect(a.api.status).not.toHaveBeenCalled(); expect(a.api.save).not.toHaveBeenCalled(); expect(disk.values.size).toBe(2);
  });

  it.each(["learning_poll_seconds", "learning_ready_percent"])(
    "an unfinished save of the retired %s does not block editing: it is dropped and a new save goes through", async key => {
      const disk = persisted(); const report = vi.spyOn(console, "warn").mockImplementation(() => {});
      disk.values.set(slot, JSON.stringify({ ...pending(), intent: { ...intent(), payload: { key, value: 80 } } }));
      const f = fixture({ disk }); await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ problem: null, pending: null, canEdit: true, phase: "ready" });
      expect(disk.values.has(slot)).toBe(false); expect(report).toHaveBeenCalledOnce();
      f.controller.edit("retry_count", 5); await f.controller.save("retry_count");
      expect(f.api.save).toHaveBeenCalledOnce();
      expect(f.api.save.mock.calls[0][3].payload).toEqual({ key: "retry_count", value: 5 });
      expect(f.api.status).not.toHaveBeenCalled();
      report.mockRestore();
    });

  it.each(["get", "remove"] as const)(
    "shows a storage problem, not a network one, when %s fails while dropping a retired slot", async method => {
      const disk = persisted(); const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      disk.values.set(slot, JSON.stringify({ ...pending(), intent: { ...intent(), payload: { key: "learning_poll_seconds", value: 80 } } }));
      vi.mocked(disk.storage[method]).mockRejectedValueOnce(new Error("private-details"));
      const f = fixture({ disk }); await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "storage" }, canEdit: false });
      expect(JSON.stringify(f.states)).not.toContain("private-details");
      warn.mockRestore();
    });

  it("cannot overwrite an intent placed in the slot by another controller", async () => {
    const f = await editing(); const other = pending(); other.intent.command_id = id(777); await seed(f.disk, other);
    await f.controller.save("retry_count");
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "pending_changed" }, canRetry: false });
    expect(f.api.save).not.toHaveBeenCalled(); expect(JSON.parse(f.disk.values.get(slot)!)).toEqual(other);
  });

  it("persists a known mismatch across refresh and a new controller without trusting status", async () => {
    const f = await editing(); f.api.save.mockResolvedValueOnce(rejected(current(next), true)); await f.controller.save("retry_count");
    expect(f.controller.snapshot()).toMatchObject({ outcome: null, canRetry: false, pending: { mismatch: true } });
    await f.controller.refresh(); expect(f.api.status).not.toHaveBeenCalled(); f.controller.dispose();
    const recovered = fixture({ disk: f.disk }); await recovered.controller.refresh(); await recovered.controller.retry();
    expect(recovered.controller.snapshot()).toMatchObject({ canRetry: false, problem: { reason: "mismatch" }, pending: { mismatch: true } });
    expect(recovered.api.status).not.toHaveBeenCalled(); expect(recovered.api.save).not.toHaveBeenCalled();
  });

  it("retains the mismatch block in memory when marker persistence fails", async () => {
    const f = await editing(); f.api.save.mockImplementationOnce(async () => {
      vi.mocked(f.disk.storage.set).mockRejectedValueOnce(new Error("disk")); return rejected(current(next), true);
    });
    await f.controller.save("retry_count"); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: { mismatch: true }, canRetry: false, outcome: null });
    expect(f.api.save).toHaveBeenCalledOnce(); await f.controller.refresh();
    expect(f.api.status).not.toHaveBeenCalled(); expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
  });
});

describe("settings access and document lifetime", () => {
  it("retains edits made while a foreground GET is in flight", async () => {
    const f = await editing(); const reading = gate<SettingsResponse>(); f.api.get.mockReturnValueOnce(reading.promise);
    const refreshing = f.controller.refresh(); await vi.waitFor(() => expect(f.api.get).toHaveBeenCalledTimes(2));
    f.controller.edit("retry_count", "6"); const updated = current(next); updated.settings.retry_count = { value: 9, version: next };
    reading.resolve(updated); await refreshing;
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "6", original: 3, fieldVersion: big, conflict: true });
    expect(f.api.save).not.toHaveBeenCalled();
  });

  it.each(["success", "401", "403"])("does not publish late GET %s from the previous foreground handle", async result => {
    const f = await editing(); const reading = gate<SettingsResponse>(); f.api.get.mockReturnValueOnce(reading.promise);
    const refreshing = f.controller.refresh(); await vi.waitFor(() => expect(f.api.get).toHaveBeenCalledTimes(2));
    f.replace(opened(), 1, "fresh");
    if (result === "success") {
      const stale = current(next); stale.settings.retry_count = { value: 9, version: next }; reading.resolve(stale);
    } else reading.reject(new ApiError("http", Number(result)));
    await refreshing;
    expect(f.onDenied).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "context_refreshed" },
      data: { settings: { retry_count: { value: 3, version: big } } }, drafts: { retry_count: { input: "4" } } });
    await f.controller.refresh(); expect(f.controller.snapshot().drafts.retry_count?.canSave).toBe(true);
  });

  it("cannot send through changed profile access after persistence completes", async () => {
    const f = await editing(); const writing = gate<void>();
    vi.mocked(f.disk.storage.set).mockImplementationOnce(async (key, value) => {
      await writing.promise; f.disk.values.set(key, value);
    });
    const saving = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.disk.storage.set).toHaveBeenCalledOnce());
    const other = opened(); other.profile.profile_id = id(99); f.replace(other); writing.resolve(); await saving;
    expect(f.api.save).not.toHaveBeenCalled(); expect(f.controller.snapshot()).toMatchObject({ data: null, pending: null, canRetry: false });
    expect(JSON.parse(f.disk.values.get(slot)!)).toEqual(pending());
  });

  it.each(["save", "retry"] as const)("keeps %s bound to the handle that authorized it during persistence", async operation => {
    const f = await editing();
    if (operation === "retry") {
      f.api.save.mockRejectedValueOnce(new Error("lost reply"));
      await f.controller.save("retry_count");
      f.api.save.mockClear();
    }
    const writing = gate<void>();
    const persist = vi.spyOn(f.disk.store, "save");
    persist.mockImplementationOnce(async (record, signal) => {
      await writing.promise;
      await SettingsPendingStore.prototype.save.call(f.disk.store, record, signal);
    });
    const sending = operation === "save" ? f.controller.save("retry_count") : f.controller.retry();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    f.replace(opened(), 1, "foreground");
    writing.resolve(); await sending;
    expect(f.api.save).not.toHaveBeenCalled();
    expect(JSON.parse(f.disk.values.get(slot)!)).toEqual(pending());
    expect(f.controller.snapshot().problem?.reason).toBe("context_refreshed");
    await f.controller.refresh();
    expect(f.api.status).toHaveBeenCalledExactlyOnceWith("synthetic-token-foreground", id(1), intent());
    expect(f.api.save).not.toHaveBeenCalled();
    await f.controller.retry();
    expect(f.api.save).toHaveBeenCalledOnce();
    expect(f.api.save.mock.calls[0][3]).toMatchObject(intent());
    expect(f.newId).toHaveBeenCalledOnce();
  });

  it.each(["save", "retry"] as const)("does not move %s to a replacement handle before its first microtask", async operation => {
    const f = await editing();
    if (operation === "retry") {
      f.api.save.mockRejectedValueOnce(new Error("lost reply"));
      await f.controller.save("retry_count");
      f.api.save.mockClear();
    }
    const sending = operation === "save" ? f.controller.save("retry_count") : f.controller.retry();
    f.replace(opened(), 1, "foreground");
    await sending;
    expect(f.api.save).not.toHaveBeenCalled();
    expect(f.controller.snapshot().problem?.reason).toBe("context_refreshed");
    expect(f.newId).toHaveBeenCalledTimes(operation === "save" ? 0 : 1);
    expect(f.disk.values.has(slot)).toBe(operation === "retry");
  });

  it("does not clear recovery data after disposal during status", async () => {
    const disk = persisted(); await seed(disk); const f = fixture({ disk }); const reading = gate<SettingStatusReply>();
    f.api.status.mockReturnValueOnce(reading.promise); const refreshing = f.controller.refresh();
    await vi.waitFor(() => expect(f.api.status).toHaveBeenCalledOnce()); f.controller.dispose(); const count = f.states.length;
    reading.resolve(applied()); await refreshing;
    expect(f.disk.values.has(slot)).toBe(true); expect(f.states).toHaveLength(count);
  });

  it("keeps a newer stored command when accepted cleanup encounters a different record", async () => {
    const f = await editing(); const other = pending(); other.intent.command_id = id(999);
    f.api.save.mockImplementationOnce(async () => { f.disk.values.set(slot, JSON.stringify(other)); return accepted(); });
    await f.controller.save("retry_count");
    expect(f.controller.snapshot()).toMatchObject({ outcome: { status: "accepted" }, canEdit: false, canRetry: false,
      problem: { reason: "pending_changed" } });
    expect(JSON.parse(f.disk.values.get(slot)!)).toEqual(other);
  });

  it("preserves drafts through a same-key foreground access refresh", async () => {
    const f = await editing(); f.replace(opened(), 1, "foreground"); await f.controller.refresh();
    expect(f.api.get).toHaveBeenLastCalledWith("synthetic-token-foreground");
    expect(f.controller.snapshot().drafts.retry_count).toMatchObject({ input: "4", original: 3, canSave: true });
  });

  it("resolves a late POST through status after foreground invalidates its old access handle", async () => {
    const f = await editing(); const sending = gate<SettingSaveReply>(); f.api.save.mockReturnValueOnce(sending.promise);
    const saving = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    f.replace(opened(), 1, "foreground"); f.api.status.mockResolvedValueOnce(applied());
    const refreshing = f.controller.refresh(); sending.resolve(accepted()); await Promise.all([saving, refreshing]);
    expect(f.api.status).toHaveBeenCalledExactlyOnceWith("synthetic-token-foreground", id(1), intent());
    expect(f.api.save).toHaveBeenCalledOnce(); expect(f.controller.snapshot().outcome?.status).toBe("accepted");
  });

  it.each(["profile", "client", "document", "generation", "closed"])("hides old data and cannot write after %s changes", async kind => {
    const f = await editing(); const data = opened();
    if (kind === "profile") data.profile.profile_id = id(88);
    if (kind === "client") data.client_instance_id = id(88);
    if (kind === "document") data.document_id = id(88);
    if (kind === "closed") f.close(); else f.replace(data, kind === "generation" ? 2 : 1);
    expect(f.controller.snapshot()).toMatchObject({ data: null, drafts: {}, pending: null, outcome: null, canEdit: false });
    await f.controller.save("retry_count"); await f.controller.refresh(); expect(f.api.save).not.toHaveBeenCalled();
    expect(f.api.get).toHaveBeenCalledOnce();
  });

  it("does not retry another client's pending command, while still allowing fact lookup", async () => {
    const disk = persisted(); await seed(disk); const data = opened(); data.client_instance_id = id(22);
    const f = fixture({ disk, opened: data }); await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: false, problem: { reason: "client_changed" } });
    expect(f.api.status).toHaveBeenCalledOnce(); expect(f.api.save).not.toHaveBeenCalled();
  });

  it.each([401, 403])("cannot revive write access after HTTP %s", async status => {
    const f = await editing(); f.api.save.mockRejectedValueOnce(new ApiError("http", status)); await f.controller.save("retry_count");
    expect(f.onDenied).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ data: null, drafts: {}, canRetry: false, canEdit: false,
      problem: { reason: status === 401 ? "expired" : "forbidden" } });
    await f.controller.refresh(); await f.controller.retry(); expect(f.controller.snapshot().canEdit).toBe(false);
    expect(f.api.save).toHaveBeenCalledOnce();
  });

  it("accepts the saved fact without reviving unavailable settings", async () => {
    const disk = persisted(); await seed(disk); const f = fixture({ disk });
    f.api.status.mockResolvedValueOnce({ ...applied(), current: { status: "unavailable" } });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ data: null, drafts: {}, pending: null, canEdit: false,
      outcome: { status: "accepted" }, problem: { reason: "forbidden" } });
  });

  it("does not consume a not_found response for a different profile", async () => {
    const disk = persisted(); await seed(disk); const f = fixture({ disk }); const reply = missing();
    if (reply.outcome === "not_found") reply.current.profile_id = id(99);
    f.api.status.mockResolvedValueOnce(reply); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ data: null, canRetry: false, problem: { reason: "profile_changed" } });
    expect(f.api.get).not.toHaveBeenCalled();
  });

  it("does not POST when disposed during persistence", async () => {
    const f = await editing(); const savingDisk = gate<void>();
    vi.mocked(f.disk.storage.set).mockImplementationOnce(async (key, value) => {
      await savingDisk.promise; f.disk.values.set(key, value);
    });
    const saving = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.disk.storage.set).toHaveBeenCalledOnce());
    f.controller.dispose(); const count = f.states.length; savingDisk.resolve(); await saving;
    expect(f.api.save).not.toHaveBeenCalled(); expect(f.states).toHaveLength(count);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", data: null, drafts: {} });
  });

  it("ignores a late committed reply after disposal and leaves persisted recovery data", async () => {
    const f = await editing(); const sending = gate<SettingSaveReply>(); f.api.save.mockReturnValueOnce(sending.promise);
    const saving = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    f.controller.dispose(); const count = f.states.length; sending.resolve(accepted()); await saving;
    expect(f.disk.values.has(slot)).toBe(true); expect(f.states).toHaveLength(count);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", outcome: null });
  });
});

describe("review error mode and learning content (M-SET)", () => {
  const cases = [["review_error_mode", "soft"], ["learning_content", "phrases"], ["learning_content", "mixed"]] as const;
  async function ready() { const f = fixture(); await f.controller.refresh(); return f; }

  it.each(cases)("sends %s=%s through setting.save and reports success only after the commit", async (key, value) => {
    const f = await ready(); const sending = gate<SettingSaveReply>();
    f.api.save.mockImplementationOnce(async () => {
      expect(f.controller.snapshot()).toMatchObject({ phase: "sending", outcome: null });
      return sending.promise;
    });
    f.controller.edit(key, value);
    expect(f.api.save).not.toHaveBeenCalled(); // choosing alone is not a commit
    const saving = f.controller.save(key);
    await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    const request = f.api.save.mock.calls[0][3];
    expect(request).toMatchObject({ kind: "setting.save", expected_field_version: "1", payload: { key, value } });
    expect(f.controller.snapshot().outcome).toBeNull();
    sending.resolve(accepted({ command_id: id(100), kind: "setting.save", expected_field_version: "1", payload: { key, value } }));
    await saving;
    expect(f.controller.snapshot()).toMatchObject({ outcome: { key, status: "accepted" }, drafts: {} });
    expect(f.controller.snapshot().data?.settings[key]).toEqual({ value, version: "2" });
  });

  it.each([["review_error_mode", "lenient"], ["review_error_mode", "Soft"], ["review_error_mode", true],
    ["learning_content", "verbs"], ["learning_content", "soft"], ["learning_content", ""]] as const)(
    "keeps invalid %s=%j editable and neither sends nor replaces it", async (key, input) => {
      const f = await ready(); f.controller.edit(key, input); await f.controller.save(key);
      expect(f.controller.snapshot().drafts[key]).toMatchObject({ input, valid: false, error: "invalid", canSave: false });
      expect(f.controller.snapshot().data?.settings[key].value).toBe(key === "learning_content" ? "words" : "strict");
      expect(f.api.save).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    });

  it("rejects a choice the server's current constraint no longer offers", async () => {
    const f = await ready(); f.controller.edit("learning_content", "mixed");
    const changed = current(next); changed.constraints.learning_content.values = ["words", "phrases"];
    f.api.get.mockResolvedValueOnce(changed); await f.controller.refresh();
    expect(f.controller.snapshot().drafts.learning_content).toMatchObject({ input: "mixed", valid: false, error: "invalid" });
    await f.controller.save("learning_content"); expect(f.api.save).not.toHaveBeenCalled();
  });

  it("reports a version conflict for review_error_mode and saves mine only on explicit choice", async () => {
    const f = await ready(); f.controller.edit("review_error_mode", "soft");
    const changed = current(next); changed.settings.review_error_mode = { value: "strict", version: "5" };
    f.api.get.mockResolvedValueOnce(changed); await f.controller.refresh();
    expect(f.controller.snapshot().drafts.review_error_mode).toMatchObject({ input: "soft", conflict: true, error: "conflict",
      canSave: false, canKeepMine: true });
    await f.controller.save("review_error_mode"); expect(f.api.save).not.toHaveBeenCalled();
    await f.controller.keepMine("review_error_mode");
    expect(f.api.save.mock.calls[0][3]).toMatchObject({ expected_field_version: "5", payload: { key: "review_error_mode", value: "soft" } });
  });
});

describe("settings reset (M-SET-RESET, D-SET-RESET 4.2, owner answers R11/R12)", () => {
  async function ready(f = fixture()) { await f.controller.refresh(); return f; }
  async function seedReset(disk: ReturnType<typeof persisted>, record = resetRecord()) {
    await disk.resetStore.save(record, new AbortController().signal);
  }

  it("a double press sends one command, stored first; success and data come only from the server's reply", async () => {
    const f = await ready(); const sending = gate<SettingSaveReply>();
    f.api.reset.mockImplementationOnce(async (token, proof, subject, request) => {
      expect([token, proof, subject]).toEqual(["synthetic-token-initial", "synthetic-proof-initial", id(1)]);
      expect(JSON.parse(f.disk.values.get(resetSlot)!)).toEqual(resetRecord());
      expect(request).toEqual({ ...resetIntent(), client_instance_id: id(2), document_id: id(3) });
      return sending.promise;
    });
    const first = f.controller.reset(); const duplicate = f.controller.reset();
    expect(duplicate).toBe(first); await vi.waitFor(() => expect(f.api.reset).toHaveBeenCalledOnce());
    expect(f.controller.snapshot()).toMatchObject({ phase: "sending", resetPending: resetRecord(), resetOutcome: null,
      canEdit: false, canReset: false, data: current() });
    expect(f.controller.reset()).toBe(first); expect(f.api.reset).toHaveBeenCalledOnce();
    sending.resolve(resetAccepted()); await first;
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", resetPending: null, pending: null, canEdit: true, canReset: true,
      resetOutcome: { commandId: id(100), status: "accepted" }, outcome: null, data: resetData() });
    expect(f.disk.values.size).toBe(0); expect(f.newId).toHaveBeenCalledOnce(); expect(f.api.save).not.toHaveBeenCalled();
  });

  it("an unsent field save blocks the reset and a sent reset blocks saving", async () => {
    const f = await editing(); const saving = gate<SettingSaveReply>(); f.api.save.mockReturnValueOnce(saving.promise);
    const save = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    expect(f.controller.snapshot().canReset).toBe(false);
    void f.controller.reset(); saving.resolve(accepted()); await save;
    expect(f.api.reset).not.toHaveBeenCalled(); expect(f.disk.values.has(resetSlot)).toBe(false);
    expect(f.controller.snapshot().canReset).toBe(true);

    const resetting = gate<SettingSaveReply>(); f.api.reset.mockReturnValueOnce(resetting.promise);
    const reset = f.controller.reset(); await vi.waitFor(() => expect(f.api.reset).toHaveBeenCalledOnce());
    f.controller.edit("retry_count", "9"); expect(f.controller.save("retry_count")).toBe(reset);
    expect(f.controller.snapshot()).toMatchObject({ canEdit: false, drafts: {} });
    expect(f.api.save).toHaveBeenCalledOnce(); expect(f.disk.values.has(slot)).toBe(false);
    resetting.reject(new ApiError("network")); await reset;
    f.controller.edit("retry_count", "9"); await f.controller.save("retry_count");
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canEdit: false, canReset: false, drafts: {} });
    expect(f.api.save).toHaveBeenCalledOnce();
  });

  it.each([new ApiError("network"), new ApiError("http", 503), new ApiError("invalid_response")])(
    "a lost reply %# keeps the intent; the manual repeat sends the same ID and body, never a new one", async error => {
      const f = await ready(); f.api.reset.mockRejectedValueOnce(error); await f.controller.reset();
      expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canRetry: true, canReset: false, canEdit: false,
        resetOutcome: null, resetPending: resetRecord(), problem: { reason: "network" } });
      expect(JSON.parse(f.disk.values.get(resetSlot)!)).toEqual(resetRecord());
      await f.controller.reset(); expect(f.api.reset).toHaveBeenCalledOnce();
      f.replace(opened(), 1, "renewed"); await f.controller.retry();
      expect(f.api.reset.mock.calls[1]).toEqual(["synthetic-token-renewed", "synthetic-proof-renewed", id(1), f.api.reset.mock.calls[0][3]]);
      expect(f.newId).toHaveBeenCalledOnce();
      expect(f.controller.snapshot()).toMatchObject({ resetPending: null, resetOutcome: { status: "accepted" } });
    });

  it("on opening, an unconfirmed reset is checked by status first; an applied one succeeds without a POST", async () => {
    const disk = persisted(); await seedReset(disk); const f = fixture({ disk }); const data = resetData();
    f.api.resetStatus.mockResolvedValueOnce(resetApplied(data));
    await f.controller.refresh();
    expect(f.api.resetStatus).toHaveBeenCalledExactlyOnceWith("synthetic-token-initial", id(1), resetIntent());
    expect(f.api.reset).not.toHaveBeenCalled(); expect(f.api.get).not.toHaveBeenCalled(); expect(f.api.status).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", resetPending: null, data, resetOutcome: { status: "accepted" } });
    expect(f.disk.values.size).toBe(0);
  });

  it("not_found shows the current state and offers only the manual repeat of the same ID", async () => {
    const disk = persisted(); await seedReset(disk); const data = opened(); data.document_id = id(30);
    const f = fixture({ disk, opened: data }); await f.controller.refresh();
    expect(f.api.resetStatus).toHaveBeenCalledOnce(); expect(f.api.get).toHaveBeenCalledOnce(); expect(f.api.reset).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", resetPending: resetRecord(), canRetry: true, canReset: false,
      problem: { reason: "not_found" }, data: current() });
    await f.controller.retry();
    expect(f.api.reset).toHaveBeenCalledExactlyOnceWith("synthetic-token-initial", "synthetic-proof-initial", id(1),
      { ...resetIntent(), client_instance_id: id(2), document_id: id(30) });
    expect(f.newId).not.toHaveBeenCalled();
  });

  it("a refresh while unresolved checks the status before anything can be repeated", async () => {
    const f = await ready(); f.api.reset.mockRejectedValueOnce(new ApiError("network")); await f.controller.reset();
    await f.controller.refresh();
    expect(f.api.resetStatus).toHaveBeenCalledExactlyOnceWith("synthetic-token-initial", id(1), resetIntent());
    expect(f.api.reset).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "not_found" }, canRetry: true });
  });

  it("a mismatch is never repeated and survives reopening", async () => {
    const f = await ready(); f.api.reset.mockResolvedValueOnce(rejected(current(next), true)); await f.controller.reset();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canRetry: false, canReset: false,
      resetPending: { mismatch: true }, problem: { reason: "mismatch" }, resetOutcome: null });
    await f.controller.retry(); expect(f.api.reset).toHaveBeenCalledOnce();
    expect(JSON.parse(f.disk.values.get(resetSlot)!)).toEqual({ ...resetRecord(), mismatch: true });
    const reopened = fixture({ disk: f.disk }); await reopened.controller.refresh();
    expect(reopened.api.resetStatus).not.toHaveBeenCalled(); expect(reopened.api.reset).not.toHaveBeenCalled();
    expect(reopened.controller.snapshot()).toMatchObject({ canRetry: false, problem: { reason: "mismatch" }, resetPending: { mismatch: true } });
  });

  it("a refusal changes nothing: data from current, every draft kept, no repeat offered", async () => {
    const f = await editing(); f.controller.edit("ui_language", "en"); const data = current(next);
    const refusal = rejected(data); if (refusal.outcome !== "accepted") refusal.error = { code: "DOCUMENT_STALE" };
    f.api.reset.mockResolvedValueOnce(refusal); await f.controller.reset();
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", resetPending: null, canRetry: false, canReset: true, data,
      resetOutcome: { status: "rejected", code: "DOCUMENT_STALE" },
      drafts: { retry_count: { input: "4" }, ui_language: { input: "en" } } });
    expect(f.disk.values.size).toBe(0);
  });

  it("R12: a confirmed reset discards only the drafts of the reset fields and shows the initial values", async () => {
    const f = await editing();
    f.controller.edit("learning_group_size", "7"); f.controller.edit("review_error_mode", "strict");
    f.controller.edit("ui_language", "en"); f.controller.edit("learning_reminder_pause_seconds", "900");
    f.controller.edit("material", { mode: "level", selected_level: "B1" });
    await f.controller.reset();
    const state = f.controller.snapshot();
    expect(Object.keys(state.drafts).sort()).toEqual(["learning_reminder_pause_seconds", "material", "ui_language"]);
    expect(state.drafts).toMatchObject({ ui_language: { input: "en", conflict: false }, learning_reminder_pause_seconds: { input: "900" } });
    expect(state.data?.settings).toMatchObject({ retry_count: { value: 4 }, learning_group_size: { value: 5 },
      review_error_mode: { value: "soft" } });
  });

  // Taken over from the independent QA (M-SET-RESET-QA, qa_reset.test.ts; mutations M01, M02).
  const resetDrafts: Record<string, unknown> = { learning_group_size: "7", learning_content: "phrases", learning_mix: true,
    review_error_mode: "soft", transition_mode: "accelerated", strict_case: false, include_preterite: true, include_comparative: true,
    learning_intervals_seconds: ["40", "50"], retry_gap: "9", retry_count: "9" };
  const outsideDrafts: Record<string, unknown> = { ui_language: "en", dictionary_language: "ru", learning_reminder_pause_seconds: "1200",
    material: { mode: "level", selected_level: "B1" } };
  async function withAllDrafts() {
    const f = await ready();
    for (const [key, value] of Object.entries({ ...resetDrafts, ...outsideDrafts })) f.controller.edit(key as SettingKey, value);
    expect(Object.keys(f.controller.snapshot().drafts)).toHaveLength(15);
    return f;
  }
  const inputs = (state: SettingsSnapshot) => Object.fromEntries(Object.entries(state.drafts).map(([key, draft]) => [key, draft!.input]));

  it("R12: an accepted reset drops the drafts of all eleven reset fields and keeps the four others intact", async () => {
    const f = await withAllDrafts(); await f.controller.reset();
    const state = f.controller.snapshot();
    expect(state.resetOutcome?.status).toBe("accepted");
    expect(inputs(state)).toEqual(outsideDrafts);
    for (const key of Object.keys(outsideDrafts)) {
      expect(state.drafts[key as SettingKey]).toMatchObject({ conflict: false, error: null, canSave: true });
    }
  });

  it("R12: a mismatch keeps every draft", async () => {
    const f = await withAllDrafts(); f.api.reset.mockResolvedValueOnce(rejected(current(next), true)); await f.controller.reset();
    expect(f.controller.snapshot().problem?.reason).toBe("mismatch");
    expect(inputs(f.controller.snapshot())).toEqual({ ...resetDrafts, ...outsideDrafts });
  });

  it("the reset is not offered while a refresh runs, and a press then sends nothing", async () => {
    const f = await ready(); const reading = gate<SettingsResponse>(); f.api.get.mockReturnValueOnce(reading.promise);
    const refreshing = f.controller.refresh();
    expect(f.controller.snapshot().canReset).toBe(false);
    await vi.waitFor(() => expect(f.api.get).toHaveBeenCalledTimes(2));
    expect(f.controller.snapshot()).toMatchObject({ phase: "checking", canReset: false });
    expect(f.controller.reset()).toBe(refreshing);
    reading.resolve(current()); await refreshing;
    expect(f.api.reset).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    expect(f.controller.snapshot().canReset).toBe(true);
  });

  it("R12: an unknown outcome keeps the drafts until the status confirms the reset", async () => {
    const f = await editing(); f.controller.edit("ui_language", "en");
    f.api.reset.mockRejectedValueOnce(new ApiError("network")); await f.controller.reset();
    expect(f.controller.snapshot().drafts).toMatchObject({ retry_count: { input: "4" }, ui_language: { input: "en" } });
    const data = resetData();
    f.api.resetStatus.mockResolvedValueOnce(resetApplied(data));
    await f.controller.refresh();
    expect(Object.keys(f.controller.snapshot().drafts)).toEqual(["ui_language"]);
    expect(f.controller.snapshot()).toMatchObject({ resetOutcome: { status: "accepted" }, data });
  });

  it("a later edit or save clears the reset result", async () => {
    const f = await ready(); await f.controller.reset();
    expect(f.controller.snapshot().resetOutcome?.status).toBe("accepted");
    f.controller.edit("ui_language", "en"); expect(f.controller.snapshot().resetOutcome).toBeNull();
  });

  it("both slots filled cannot be trusted: nothing is checked or sent and editing stays blocked", async () => {
    const disk = persisted(); await seed(disk); await seedReset(disk); const f = fixture({ disk });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "invalid_pending" }, canEdit: false, canReset: false, canRetry: false });
    for (const call of [f.api.status, f.api.resetStatus, f.api.save, f.api.reset]) expect(call).not.toHaveBeenCalled();
    expect(disk.values.size).toBe(2);
  });

  it("an expired login during the reset keeps the intent without claiming success", async () => {
    const f = await ready(); f.api.reset.mockRejectedValueOnce(new ApiError("http", 401)); await f.controller.reset();
    expect(f.controller.snapshot()).toMatchObject({ data: null, resetOutcome: null, canRetry: false, canReset: false,
      resetPending: resetRecord(), problem: { reason: "expired" } });
  });
});

describe("Q36: leaving a mismatched setting.save with the server's current settings", () => {
  /** The server's data after a concurrent change: retry_count is 7. */
  function serverData() {
    const data = current(next); data.settings.retry_count = { value: 7, version: next }; return data;
  }
  async function mismatched(f = fixture()) {
    await f.controller.refresh(); f.controller.edit("retry_count", "4");
    f.api.save.mockResolvedValueOnce(rejected(serverData(), true)); await f.controller.save("retry_count");
    return f;
  }
  const oldId = intent().command_id;

  it("the old ID is never sent again; the action appears only after a refresh whose readback succeeded", async () => {
    const f = await mismatched();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: false, canContinueWithServer: false, pending: { mismatch: true } });
    // R9-01: the live mismatch read the server by itself (the default read is older than the reply, so it is stale):
    // two reads so far, and a press of the action without an offered readback reads nothing more.
    expect(f.api.get).toHaveBeenCalledTimes(2);
    await f.controller.continueWithServer(); expect(f.api.get).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
    f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ canContinueWithServer: true, canRetry: false, problem: { reason: "mismatch" } });
    expect(f.api.save).toHaveBeenCalledOnce(); expect(f.api.status).not.toHaveBeenCalled();
  });

  describe("R9-01 variant 1: the live mismatch reads the server by itself", () => {
    /** A save answered with a live mismatch whose automatic read returns `later` (default: the server's data). */
    async function live(later: () => Promise<SettingsResponse> = async () => serverData()) {
      const f = fixture(); await f.controller.refresh(); f.controller.edit("retry_count", "4");
      f.api.save.mockResolvedValueOnce(rejected(serverData(), true)); f.api.get.mockResolvedValue(serverData());
      f.api.get.mockImplementationOnce(later);
      return f;
    }

    it("offers the continuation right after the reply, with one read and no repeat of the old command or the draft", async () => {
      const f = await live(); await f.controller.save("retry_count");
      expect(f.api.get).toHaveBeenCalledTimes(2);
      expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canContinueWithServer: true, canEdit: false, canRetry: false,
        canReset: false, problem: { reason: "mismatch" }, pending: { mismatch: true }, drafts: { retry_count: { input: "4" } } });
      expect(f.api.save).toHaveBeenCalledOnce(); expect(f.api.status).not.toHaveBeenCalled();
      expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
      await f.controller.continueWithServer();
      expect(f.controller.snapshot()).toMatchObject({ pending: null, problem: null, canEdit: true, phase: "ready" });
      expect(f.disk.values.size).toBe(0); expect(f.api.save).toHaveBeenCalledOnce();
    });

    it("keeps every editor and command closed until the read answers, and says it is checking", async () => {
      const reading = gate<SettingsResponse>(); const f = await live(() => reading.promise);
      const saving = f.controller.save("retry_count");
      await vi.waitFor(() => expect(f.api.get).toHaveBeenCalledTimes(2));
      const during = f.controller.snapshot();
      expect(during).toMatchObject({ phase: "checking", canEdit: false, canReset: false, canRetry: false, canContinueWithServer: false });
      expect(during.drafts.retry_count).toMatchObject({ canSave: false, canKeepMine: false });
      f.controller.edit("retry_count", "9"); expect(f.controller.snapshot().drafts.retry_count?.input).toBe("4");
      // While the read runs these presses join it and start nothing.
      void f.controller.continueWithServer(); void f.controller.retry(); void f.controller.reset();
      expect(f.api.save).toHaveBeenCalledOnce(); expect(f.api.reset).not.toHaveBeenCalled();
      reading.resolve(serverData()); await saving;
      expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canContinueWithServer: true });
    });

    it("a failed automatic read leaves the manual path: no continuation, the block stays, the refresh offers it", async () => {
      const f = await live(async () => { throw new ApiError("network"); }); await f.controller.save("retry_count");
      expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canContinueWithServer: false, canEdit: false, canRetry: false,
        problem: { reason: "network" }, pending: { mismatch: true } });
      expect(f.api.save).toHaveBeenCalledOnce(); expect(f.api.status).not.toHaveBeenCalled();
      await f.controller.continueWithServer(); expect(f.disk.values.size).toBe(1);
      f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
      expect(f.controller.snapshot()).toMatchObject({ canContinueWithServer: true, problem: { reason: "mismatch" } });
    });

    it("a stale automatic read does not offer the continuation; the refresh does once the read is current", async () => {
      const f = await live(async () => current(big)); await f.controller.save("retry_count");
      expect(f.controller.snapshot()).toMatchObject({ canContinueWithServer: false, canEdit: false, problem: { reason: "mismatch" } });
      f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
      expect(f.controller.snapshot().canContinueWithServer).toBe(true);
    });

    it("an expired login during the automatic read keeps the record and closes the editor without a continuation", async () => {
      const f = await live(async () => { throw new ApiError("http", 401); }); await f.controller.save("retry_count");
      expect(f.controller.snapshot()).toMatchObject({ data: null, canContinueWithServer: false, canEdit: false, problem: { reason: "expired" } });
      expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
    });

    it("a changed access or a disposal during the automatic read offers and clears nothing", async () => {
      const reading = gate<SettingsResponse>(); const f = await live(() => reading.promise);
      const saving = f.controller.save("retry_count"); await vi.waitFor(() => expect(f.api.get).toHaveBeenCalledTimes(2));
      f.replace(opened(), 2, "foreground"); reading.resolve(serverData()); await saving;
      expect(f.controller.snapshot().canContinueWithServer).toBe(false);
      expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
      const gone = gate<SettingsResponse>(); const g = await live(() => gone.promise);
      const saving2 = g.controller.save("retry_count"); await vi.waitFor(() => expect(g.api.get).toHaveBeenCalledTimes(2));
      g.controller.dispose(); gone.resolve(serverData()); await saving2;
      expect(JSON.parse(g.disk.values.get(slot)!)).toHaveProperty("mismatch", true); expect(g.api.save).toHaveBeenCalledOnce();
    });

    it("a mismatched reset reads nothing by itself and gets no continuation (P02)", async () => {
      const f = fixture(); await f.controller.refresh();
      f.api.reset.mockResolvedValueOnce(rejected(serverData(), true)); await f.controller.reset();
      expect(f.api.get).toHaveBeenCalledOnce();
      expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "mismatch" }, canContinueWithServer: false, canEdit: false });
    });

    it("an exact retry that is answered with a mismatch reads by itself as well", async () => {
      const f = fixture(); await f.controller.refresh(); f.controller.edit("retry_count", "4");
      f.api.save.mockRejectedValueOnce(new ApiError("network")); await f.controller.save("retry_count");
      expect(f.controller.snapshot().canRetry).toBe(true);
      f.api.save.mockResolvedValueOnce(rejected(serverData(), true)); f.api.get.mockResolvedValueOnce(serverData());
      await f.controller.retry();
      expect(f.api.get).toHaveBeenCalledTimes(2); expect(f.controller.snapshot()).toMatchObject({ canContinueWithServer: true, canRetry: false });
    });

    it("R9-02 variant 1: the continuation drops only the conflicting field's draft; other drafts stay, unsent, marked where the server moved on", async () => {
      const f = await live(); f.controller.edit("learning_group_size", "6"); f.controller.edit("strict_case", false);
      const moved = serverData(); moved.settings.learning_group_size = { value: 8, version: next };
      f.api.get.mockReset(); f.api.get.mockResolvedValue(moved);
      await f.controller.save("retry_count"); expect(f.controller.snapshot().canContinueWithServer).toBe(true);
      await f.controller.continueWithServer();
      const state = f.controller.snapshot();
      expect(state.drafts.retry_count).toBeUndefined();
      expect(state.drafts.learning_group_size).toMatchObject({ input: "6", conflict: true, error: "conflict", canSave: false, canKeepMine: true });
      expect(state.drafts.strict_case).toMatchObject({ input: false, conflict: false, canSave: true });
      expect(state.data!.settings.retry_count.value).toBe(7);
      expect(f.api.save).toHaveBeenCalledOnce();
    });
  });

  it("clears the marked record, drops the draft, shows server values and the next save gets a new ID", async () => {
    const f = await mismatched(); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    const reads = f.api.get.mock.calls.length;
    await f.controller.continueWithServer();
    expect(f.api.get.mock.calls.length).toBe(reads + 1);
    expect(f.disk.values.size).toBe(0);
    const state = f.controller.snapshot();
    expect(state).toMatchObject({ pending: null, problem: null, canEdit: true, canContinueWithServer: false, canRetry: false, phase: "ready" });
    expect(state.drafts.retry_count).toBeUndefined(); expect(state.data!.settings.retry_count.value).toBe(7);
    f.controller.edit("retry_count", "9"); await f.controller.save("retry_count");
    expect(f.api.save).toHaveBeenCalledTimes(2);
    const sent = f.api.save.mock.calls[1][3];
    expect(sent.command_id).not.toBe(oldId); expect(sent.expected_field_version).toBe(next);
    expect(f.api.save.mock.calls.filter(call => call[3].command_id === oldId)).toHaveLength(1);
  });

  it("a failed or stale readback at the action clears nothing and keeps the block", async () => {
    const f = await mismatched(); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    f.api.get.mockRejectedValueOnce(new Error("offline")); await f.controller.continueWithServer();
    expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
    expect(f.controller.snapshot()).toMatchObject({ pending: { mismatch: true }, canEdit: false, canRetry: false, canContinueWithServer: false });
    f.api.get.mockResolvedValue(serverData()); await f.controller.refresh(); expect(f.controller.snapshot().canContinueWithServer).toBe(true);
    f.api.get.mockResolvedValueOnce(current(big)); await f.controller.continueWithServer();
    expect(f.disk.values.size).toBe(1); expect(f.controller.snapshot()).toMatchObject({ pending: { mismatch: true }, canEdit: false });
    expect(f.api.save).toHaveBeenCalledOnce();
  });

  it("a stale readback in the refresh does not offer the action", async () => {
    const f = await mismatched(); f.api.get.mockResolvedValue(current(big)); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ canContinueWithServer: false, problem: { reason: "mismatch" } });
    await f.controller.continueWithServer(); expect(f.disk.values.size).toBe(1);
  });

  it("a changed access during the readback clears nothing", async () => {
    const f = await mismatched(); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    const reading = gate<SettingsResponse>(); f.api.get.mockReturnValueOnce(reading.promise);
    const leaving = f.controller.continueWithServer(); await vi.waitFor(() => expect(f.api.get.mock.calls.length).toBeGreaterThan(2));
    f.replace(opened(), 2, "foreground"); reading.resolve(serverData()); await leaving;
    expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
    expect(f.controller.snapshot()).toMatchObject({ canEdit: false, canContinueWithServer: false });
  });

  it("another profile's document cannot use or clear the record", async () => {
    const f = await mismatched(); const other = opened(); other.profile.profile_id = id(99);
    const b = fixture({ disk: f.disk, opened: other }); b.api.get.mockResolvedValue(serverData()); await b.controller.refresh();
    expect(b.controller.snapshot()).toMatchObject({ pending: null, canContinueWithServer: false, canEdit: true });
    await b.controller.continueWithServer();
    expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
  });

  it("an abort (dispose) during the readback clears nothing", async () => {
    const f = await mismatched(); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    const reading = gate<SettingsResponse>(); f.api.get.mockReturnValueOnce(reading.promise);
    const leaving = f.controller.continueWithServer(); await vi.waitFor(() => expect(f.api.get.mock.calls.length).toBeGreaterThan(2));
    f.controller.dispose(); reading.resolve(serverData()); await leaving;
    expect(f.disk.values.size).toBe(1); expect(JSON.parse(f.disk.values.get(slot)!)).toHaveProperty("mismatch", true);
  });

  it.each(["remove", "get"] as const)("a failing storage %s leaves the record and the block; a refresh offers the action again", async method => {
    const f = await mismatched(); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    const before = f.disk.values.get(slot);
    vi.mocked(f.disk.storage[method]).mockRejectedValueOnce(new Error("private-details"));
    await f.controller.continueWithServer();
    expect(f.disk.values.get(slot)).toBe(before);
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "storage" }, pending: { mismatch: true }, canEdit: false, canRetry: false, canContinueWithServer: false });
    expect(JSON.stringify(f.states)).not.toContain("private-details");
    await f.controller.refresh(); expect(f.controller.snapshot().canContinueWithServer).toBe(true);
    expect(f.api.save).toHaveBeenCalledOnce();
  });

  it("a record replaced by another window is not cleared (pending_changed)", async () => {
    const f = await mismatched(); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    const other = pending(); other.intent.command_id = id(777); f.disk.values.set(slot, JSON.stringify(other));
    await f.controller.continueWithServer();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "pending_changed" }, canEdit: false });
    expect(JSON.parse(f.disk.values.get(slot)!)).toEqual(other);
  });

  it("re-entry: a new controller recovers the mismatch, offers the action after its readback, and the cleared state survives another entry", async () => {
    const f = await mismatched(); f.controller.dispose();
    const again = fixture({ disk: f.disk }); again.api.get.mockResolvedValue(serverData()); await again.controller.refresh();
    expect(again.controller.snapshot()).toMatchObject({ canContinueWithServer: true, pending: { mismatch: true }, canEdit: false });
    expect(again.api.status).not.toHaveBeenCalled(); expect(again.api.save).not.toHaveBeenCalled();
    await again.controller.continueWithServer(); again.controller.dispose();
    const third = fixture({ disk: f.disk }); third.api.get.mockResolvedValue(serverData()); await third.controller.refresh();
    expect(third.controller.snapshot()).toMatchObject({ pending: null, problem: null, canEdit: true, canContinueWithServer: false });
    expect(third.api.status).not.toHaveBeenCalled();
  });

  it("a legacy-key mismatch of the owner is left the same way and only its own record is removed", async () => {
    const disk = persisted(); const legacy = "wortly.pending.setting";
    disk.values.set(legacy, JSON.stringify({ ...pending(), mismatch: true })); disk.values.set(`wortly.pending.setting:profile:${id(99)}`, "other-profile-record");
    const f = fixture({ disk }); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ canContinueWithServer: true });
    await f.controller.continueWithServer();
    expect(disk.values.has(legacy)).toBe(false); expect(disk.values.get(`wortly.pending.setting:profile:${id(99)}`)).toBe("other-profile-record");
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canEdit: true });
  });

  it("a mismatched settings.reset gets no such action (waits for P02)", async () => {
    const disk = persisted(); await disk.resetStore.save({ ...resetRecord(), mismatch: true }, new AbortController().signal);
    const f = fixture({ disk }); f.api.get.mockResolvedValue(serverData()); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "mismatch" }, canContinueWithServer: false });
    await f.controller.continueWithServer(); expect(disk.values.get(resetSlot)).toContain('"mismatch":true');
  });
});
