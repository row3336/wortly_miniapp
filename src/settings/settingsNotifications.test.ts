import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile, SavedCommandFact, SettingsResponse } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { createSettingsApi, KnownRefusal, notificationFlags, notificationHours, validSettingIntent, type SettingIntent, type SettingKey,
  type SettingSaveReply, type SettingsApi } from "./settingsApi";
import { SettingsController, type SettingsSnapshot } from "./settingsController";
import { SettingsPendingStore, validSettingsPending } from "./settingsPending";
import { SettingsResetPendingStore } from "./settingsResetPending";
import { settingsResponse } from "./settingsRead.test-support";
import { testGate } from "../commands/testGate.test-support";

// project_notifications §5, §8.2 (M1/M2): the notification keys in the settings decoder and the submenu's controller rules.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const big = "9007199254740995";
const next = "9007199254740996";
const profile = (): Profile => ({ profile_id: id(1), access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: big });
const opened = (document = id(3)): OpenedClient => ({ status: "opened", client_instance_id: id(2), document_id: document,
  document_epoch: "1", proof_version: "1", profile: profile(), session: null,
  compatibility: { compatible: true, contract_version: "1" } });
const fact = (request: SettingIntent): SavedCommandFact => ({ id: request.command_id, kind: "setting.save", status: "applied",
  applied_at: "2026-10-13T00:00:00Z", target_id: id(1), action_id: null, result_id: null, context_id: null,
  object_version: String(BigInt(request.expected_field_version) + 1n) });
function accepted(request: SettingIntent, state = next): SettingSaveReply {
  const data = settingsResponse(); data.state_version = state;
  Object.assign(data.settings[request.payload.key as SettingKey], { value: structuredClone(request.payload.value),
    version: String(BigInt(request.expected_field_version) + 1n) });
  return { outcome: "accepted", command: fact(request), current: data, state_version: state };
}
function closedBot(): SettingsResponse {
  const data = settingsResponse(); data.notifications.telegram_opened = false;
  for (const key of notificationFlags) data.settings[key] = { value: false, version: "1" };
  return data;
}
function refused(request: SettingIntent, code: string, data = closedBot(),
  outcome: "rejected" | "mismatch" = "rejected"): SettingSaveReply {
  data.state_version = next;
  return { outcome, command: { id: request.command_id, status: "rejected" }, error: { code }, current: data,
    state_version: next };
}
/** `document`: another opening of the app is another document (the page-memory refusals are per document). */
function fixture(read: () => SettingsResponse = settingsResponse, stored: Record<string, string> = {}, document = id(3)) {
  const values = new Map<string, string>(Object.entries(stored));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const api = { get: vi.fn<SettingsApi["get"]>(async () => read()),
    save: vi.fn<SettingsApi["save"]>(async (_token, _proof, _profile, request) => accepted(request)),
    status: vi.fn<SettingsApi["status"]>(), reset: vi.fn<SettingsApi["reset"]>(), resetStatus: vi.fn<SettingsApi["resetStatus"]>() };
  let access: OpenedAccess | null = null;
  const handle: OpenedAccess = createOpenedAccess({ opened: opened(document), token: "synthetic-token", proof: "synthetic-proof",
    generation: 1, isLive: () => access === handle, onDenied: vi.fn() });
  access = handle;
  let sequence = 100;
  const states: SettingsSnapshot[] = [];
  const controller = new SettingsController({ gate: testGate(), api, pendingStore: new SettingsPendingStore(storage),
    resetStore: new SettingsResetPendingStore(storage), access: () => access, newId: () => id(sequence++),
    onUpdate: state => states.push(state) });
  return { controller, api, states, values };
}
/** The submenu's «choice saved at once»: one edit and one save of that key (NotificationsPanel). */
function choose(controller: SettingsController, key: SettingKey, value: unknown) {
  controller.edit(key, value);
  return controller.save(key);
}

describe("notification settings decoder (M1)", () => {
  const reply = (body: unknown) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status: 200 }));
    return createSettingsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 20000, gate: testGate() }).get("synthetic");
  };
  it("reads the four switches, the three hours and notifications.telegram_opened exactly as served", async () => {
    const data = settingsResponse(); data.notifications.telegram_opened = false; data.settings.daily_report_hour.value = 0;
    data.settings.evening_reminder_hour.value = 23;
    await expect(reply(data)).resolves.toEqual(data);
  });
  it("does not need, and refuses, the retired Learning reminder pause (R14-02)", async () => {
    const data = settingsResponse();
    expect(Object.keys(data.settings)).not.toContain("learning_reminder_pause_seconds");
    await expect(reply(data)).resolves.toEqual(data);
    const withPause = structuredClone(data) as SettingsResponse & { settings: Record<string, unknown>; constraints: Record<string, unknown> };
    withPause.settings.learning_reminder_pause_seconds = { value: 0, version: "1" };
    withPause.constraints.learning_reminder_pause_seconds = { type: "integer", minimum: 0, maximum: 2147483647 };
    await expect(reply(withPause)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  const bad: Array<[string, (data: SettingsResponse) => void]> = [
    ["missing notifications", x => { Reflect.deleteProperty(x, "notifications"); }],
    ["non-boolean telegram_opened", x => { Object.assign(x.notifications, { telegram_opened: "yes" }); }],
    ["extra notifications field", x => { Object.assign(x.notifications, { telegram_opened_at: null }); }],
    ["null switch", x => { Object.assign(x.settings.notify_weekly, { value: null }); }],
    ["numeric switch", x => { Object.assign(x.settings.notify_learning, { value: 1 }); }],
    ["null hour", x => { Object.assign(x.settings.daily_report_hour, { value: null }); }],
    ["fractional hour", x => { Object.assign(x.settings.weekly_report_hour, { value: 7.5 }); }],
    ["boolean hour", x => { Object.assign(x.settings.evening_reminder_hour, { value: true }); }],
    ["missing switch", x => { Reflect.deleteProperty(x.settings, "notify_evening"); }],
    ["missing hour constraint", x => { Reflect.deleteProperty(x.constraints, "weekly_report_hour"); }],
    ["hour constraint as boolean", x => { x.constraints.daily_report_hour = { type: "boolean" }; }],
    ["a weekday of the weekly report (R12-02)", x => { Object.assign(x.settings, { weekly_report_day: { value: 1, version: "1" } }); }],
  ];
  it.each(bad)("rejects %s", async (_name, corrupt) => {
    const data = settingsResponse(); corrupt(data);
    await expect(reply(data)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("notification submenu controller rules (M2)", () => {
  it.each([...notificationFlags.map(key => [key, false] as const), ...notificationHours.map(key => [key, 9] as const)])(
    "a choice of %s sends exactly one setting.save of that key alone, at its field version", async (key, value) => {
      const f = fixture(); await f.controller.refresh();
      const before = settingsResponse().settings[key].version;
      await choose(f.controller, key, value);
      expect(f.api.save).toHaveBeenCalledOnce();
      const command = f.api.save.mock.calls[0][3];
      expect(command).toMatchObject({ kind: "setting.save", expected_field_version: before, payload: { key, value } });
      expect(Object.keys(command.payload)).toEqual(["key", "value"]);
      const state = f.controller.snapshot();
      expect(state.outcome).toMatchObject({ key, status: "accepted" });
      expect(state.drafts).toEqual({});
      expect(state.data!.settings[key]).toEqual({ value, version: String(BigInt(before) + 1n) });
    });
  it("closes every field while the save is in flight and opens them after the reply", async () => {
    let release!: () => void;
    const f = fixture(); await f.controller.refresh();
    f.api.save.mockImplementationOnce((_t, _p, _s, request) => new Promise(resolve => { release = () => resolve(accepted(request)); }));
    const running = choose(f.controller, "notify_daily", true);
    await vi.waitFor(() => expect(f.api.save).toHaveBeenCalledOnce());
    expect(f.controller.snapshot()).toMatchObject({ phase: "sending", canEdit: false });
    // A second choice while one is in flight creates no command.
    f.controller.edit("weekly_report_hour", 9); void f.controller.save("weekly_report_hour");
    expect(f.api.save).toHaveBeenCalledOnce();
    release();
    await running;
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", canEdit: true });
  });
  it("NOTIFICATIONS_NOT_OPENED: the switch draft is dropped and the settings are read afresh; nothing is resent", async () => {
    let served = settingsResponse();
    const f = fixture(() => served); await f.controller.refresh();
    expect(f.api.get).toHaveBeenCalledOnce();
    f.api.save.mockImplementationOnce(async (_t, _p, _s, request) => refused(request, "NOTIFICATIONS_NOT_OPENED"));
    served = closedBot(); served.state_version = next;
    await choose(f.controller, "notify_learning", false);
    const state = f.controller.snapshot();
    expect(f.api.save).toHaveBeenCalledOnce();
    expect(f.api.get).toHaveBeenCalledTimes(2);
    expect(state.drafts.notify_learning).toBeUndefined();
    expect(state.outcome).toMatchObject({ key: "notify_learning", status: "rejected", code: "NOTIFICATIONS_NOT_OPENED" });
    expect(state.data!.notifications.telegram_opened).toBe(false);
    expect(state.data!.settings.notify_learning.value).toBe(false);
    expect(state).toMatchObject({ phase: "ready", pending: null, canEdit: true, problem: null });
  });
  it("another refusal keeps the user's draft (the existing 422/409 states), with no extra read", async () => {
    const f = fixture(); await f.controller.refresh();
    f.api.save.mockImplementationOnce(async (_t, _p, _s, request) => refused(request, "VERSION_CONFLICT", (() => {
      const data = settingsResponse(); data.settings.evening_reminder_hour = { value: 20, version: "2" }; return data; })()));
    await choose(f.controller, "evening_reminder_hour", 19);
    const state = f.controller.snapshot();
    expect(f.api.get).toHaveBeenCalledOnce();
    expect(state.drafts.evening_reminder_hour).toMatchObject({ input: 19, conflict: true, error: "conflict", canKeepMine: true });
    await f.controller.keepMine("evening_reminder_hour");
    expect(f.api.save).toHaveBeenCalledTimes(2);
    expect(f.api.save.mock.calls[1][3]).toMatchObject({ expected_field_version: "2", payload: { key: "evening_reminder_hour", value: 19 } });
  });
  it("a mismatch on a notification key reads the server by itself, offers the continuation and never resends (N-AC24)", async () => {
    const f = fixture(() => { const data = settingsResponse(); data.state_version = next; return data; }); await f.controller.refresh();
    f.controller.edit("retry_count", "9");
    f.api.save.mockImplementationOnce(async (_t, _p, _s, request) => refused(request, "COMMAND_PAYLOAD_MISMATCH",
      settingsResponse(), "mismatch"));
    await choose(f.controller, "notify_weekly", false);
    let state = f.controller.snapshot();
    expect(f.api.get).toHaveBeenCalledTimes(2);
    expect(state).toMatchObject({ canEdit: false, canRetry: false, canContinueWithServer: true, problem: { reason: "mismatch" } });
    // The draft of another field stays, unsent.
    expect(state.drafts.retry_count).toMatchObject({ input: "9" });
    await f.controller.continueWithServer();
    state = f.controller.snapshot();
    expect(f.api.save).toHaveBeenCalledOnce();
    expect(state).toMatchObject({ pending: null, canEdit: true, problem: null });
    expect(state.drafts.notify_weekly).toBeUndefined();
    expect(state.drafts.retry_count).toMatchObject({ input: "9" });
  });
  it("a hour outside the server's 0–23 is never sent", async () => {
    const f = fixture(); await f.controller.refresh();
    for (const value of [24, -1, 7.5, true]) await choose(f.controller, "daily_report_hour", value);
    expect(f.api.save).not.toHaveBeenCalled();
    expect(f.controller.snapshot().drafts.daily_report_hour).toMatchObject({ error: "invalid", canSave: false });
  });
});

// QA P3-1 (C278): an unfinished save of the retired pause key, left in the device's pending slot by an earlier build, takes the
// recovery path of every stored save (as retry_count): the status read by its command ID decides its outcome.
describe("a stored unfinished save of the Learning reminder pause (R14-02)", () => {
  const slot = `wortly.pending.setting:profile:${id(1)}`;
  const pauseIntent = { command_id: id(78), kind: "setting.save" as const, expected_field_version: "1",
    payload: { key: "learning_reminder_pause_seconds" as const, value: 900 } };
  const stored = (clientInstanceId = id(2)) => ({ [slot]: JSON.stringify({ schemaVersion: 1, profileId: id(1), clientInstanceId,
    intent: pauseIntent }) });
  it("is a valid stored intent (a whole number), while the key stays out of the projection and of the editable keys", () => {
    expect(validSettingIntent(pauseIntent)).toBe(true);
    expect(validSettingIntent({ ...pauseIntent, payload: { ...pauseIntent.payload, value: "900" } })).toBe(false);
    expect(Object.keys(settingsResponse().settings)).not.toContain("learning_reminder_pause_seconds");
  });
  it("its outcome is read by its own command ID; not found keeps the record, says so and offers only the exact repeat", async () => {
    const f = fixture(settingsResponse, stored());
    f.api.status.mockImplementation(async () => ({ outcome: "not_found", command: { id: id(78), status: "not_found" },
      current: { ...profile() }, state_version: big }));
    await f.controller.refresh();
    expect(f.api.status).toHaveBeenCalledOnce();
    expect(f.api.status.mock.calls[0][2]).toEqual(pauseIntent);
    let state = f.controller.snapshot();
    expect(state).toMatchObject({ phase: "unresolved", problem: { reason: "not_found" }, canRetry: true, canEdit: false });
    expect(state.pending?.intent).toEqual(pauseIntent);
    expect(state.drafts).toEqual({});
    expect(f.values.get(slot)).toBeDefined();
    // The explicit repeat sends the same ID and payload; the server refuses the unknown key (422): known refusal, record kept.
    f.api.save.mockRejectedValueOnce(new KnownRefusal("command_refused", 422, "VALIDATION_FAILED"));
    await f.controller.retry();
    expect(f.api.save).toHaveBeenCalledOnce();
    expect(f.api.save.mock.calls[0][3]).toMatchObject({ command_id: id(78), payload: pauseIntent.payload });
    state = f.controller.snapshot();
    expect(state).toMatchObject({ problem: { reason: "command_refused" }, canRetry: false, canCancelStored: true, canEdit: false });
    expect(f.values.get(slot)).toBeDefined();
  });
  // R2-09 / K19-024 / P5-013: the 422 of the old ID stands until the user explicitly cancels that earlier change.
  async function refusedStored() {
    const f = fixture(settingsResponse, stored());
    f.api.status.mockImplementation(async () => ({ outcome: "not_found", command: { id: id(78), status: "not_found" },
      current: { ...profile() }, state_version: big }));
    await f.controller.refresh();
    f.api.save.mockRejectedValueOnce(new KnownRefusal("command_refused", 422, "VALIDATION_FAILED"));
    // The refusal is kept per document in page memory (KnownRefusal): an earlier test of this document may already hold it.
    if (f.controller.snapshot().canRetry) await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canCancelStored: true });
    return f;
  }
  it("after the 422 nothing clears the record by itself: a refresh keeps it, the refusal and the offered cancel", async () => {
    const f = await refusedStored();
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canCancelStored: true, canEdit: false });
    expect(JSON.parse(f.values.get(slot)!).intent.command_id).toBe(id(78));
    expect(f.api.save.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it("the explicit cancel reads the old ID once more, then clears the record and opens Settings with fresh data", async () => {
    const f = await refusedStored();
    const reads = f.api.get.mock.calls.length, checks = f.api.status.mock.calls.length, sends = f.api.save.mock.calls.length;
    await f.controller.cancelStored();
    expect(f.api.status).toHaveBeenCalledTimes(checks + 1);
    expect(f.api.status.mock.calls.at(-1)![2]).toEqual(pauseIntent);
    expect(f.api.get).toHaveBeenCalledTimes(reads + 1);
    expect(f.api.save).toHaveBeenCalledTimes(sends);
    expect(f.values.has(slot)).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pending: null, problem: null, canEdit: true, canCancelStored: false });
  });
  it("if the cancel finds the old ID applied after all, that outcome is taken instead", async () => {
    const f = await refusedStored();
    f.api.status.mockImplementation(async () => ({ outcome: "accepted", state_version: next,
      command: { ...fact(pauseIntent), status: "already_applied" }, current: (() => { const data = settingsResponse();
        data.state_version = next; return data; })() }));
    await f.controller.cancelStored();
    expect(f.controller.snapshot().outcome).toEqual({ commandId: id(78), key: "learning_reminder_pause_seconds", status: "accepted" });
    expect(f.values.has(slot)).toBe(false);
  });
  it("the 422 is kept with the record: the next opening shows the refusal and the cancel at once, with no repeat", async () => {
    const f = await refusedStored();
    const kept = JSON.parse(f.values.get(slot)!);
    expect(kept).toMatchObject({ refused: true, intent: { command_id: id(78) } });
    // Another opening: a new document with the stored record only (the page-memory refusal of the old one is not used).
    const g = fixture(settingsResponse, { [slot]: f.values.get(slot)! }, id(301));
    g.api.status.mockImplementation(async () => ({ outcome: "not_found", command: { id: id(78), status: "not_found" },
      current: { ...profile() }, state_version: big }));
    await g.controller.refresh();
    expect(g.api.status).toHaveBeenCalledOnce();
    expect(g.api.save).not.toHaveBeenCalled();
    expect(g.controller.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canRetry: false, canCancelStored: true,
      canEdit: false });
    await g.controller.cancelStored();
    expect(g.values.has(slot)).toBe(false);
    expect(g.controller.snapshot()).toMatchObject({ pending: null, canEdit: true, problem: null });
    expect(g.api.save).not.toHaveBeenCalled();
  });
  it("a record of another launch: the cancel is offered, nothing is cleared without the press; the press checks, then clears", async () => {
    const f = fixture(settingsResponse, stored(id(77)), id(302));
    f.api.status.mockImplementation(async () => ({ outcome: "not_found", command: { id: id(78), status: "not_found" },
      current: { ...profile() }, state_version: big }));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "client_changed" }, canRetry: false, canCancelStored: true });
    await f.controller.refresh();
    expect(f.values.get(slot)).toBeDefined();
    expect(f.api.status).toHaveBeenCalledTimes(2);
    f.api.status.mockRejectedValueOnce(new Error("offline"));
    await f.controller.cancelStored();
    expect(f.values.get(slot)).toBeDefined();
    await f.controller.cancelStored();
    expect(f.api.status).toHaveBeenCalledTimes(4);
    expect(f.values.has(slot)).toBe(false);
    expect(f.api.save).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canEdit: true, problem: null });
  });
  it("an ordinary key from another launch is not offered this cancel", async () => {
    const record = { schemaVersion: 1, profileId: id(1), clientInstanceId: id(77), intent: { command_id: id(79), kind: "setting.save",
      expected_field_version: "2", payload: { key: "retry_count", value: 5 } } };
    const f = fixture(settingsResponse, { [slot]: JSON.stringify(record) }, id(303));
    f.api.status.mockImplementation(async () => ({ outcome: "not_found", command: { id: id(79), status: "not_found" },
      current: { ...profile() }, state_version: big }));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "client_changed" }, canCancelStored: false });
  });
  it("the refused mark is a valid mark of any stored save (R2-09 / K19-024), only as true", () => {
    const ordinary = { schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), refused: true, intent: { command_id: id(79),
      kind: "setting.save", expected_field_version: "2", payload: { key: "retry_count", value: 5 } } };
    expect(validSettingsPending(ordinary)).toBe(true);
    expect(validSettingsPending({ ...ordinary, intent: pauseIntent })).toBe(true);
    expect(validSettingsPending({ ...ordinary, intent: pauseIntent, refused: false })).toBe(false);
  });
  it("a failed check on cancel clears nothing; an ordinary key refused with 422 is offered the same cancel", async () => {
    const f = await refusedStored();
    f.api.status.mockRejectedValueOnce(new Error("offline"));
    await f.controller.cancelStored();
    expect(f.values.get(slot)).toBeDefined();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canCancelStored: true });
    const g = fixture(); await g.controller.refresh();
    g.api.save.mockRejectedValueOnce(new KnownRefusal("command_refused", 422, "VALIDATION_FAILED"));
    g.controller.edit("retry_count", "5"); await g.controller.save("retry_count");
    expect(g.controller.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canCancelStored: true });
  });
  it("from another launch of the app: the record stays and «Изменение отправлено из другого запуска» is the state", async () => {
    const f = fixture(settingsResponse, stored(id(77)));
    f.api.status.mockImplementation(async () => ({ outcome: "not_found", command: { id: id(78), status: "not_found" },
      current: { ...profile() }, state_version: big }));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "client_changed" }, canRetry: false });
    expect(f.values.get(slot)).toBeDefined();
  });
  it("applied earlier: the outcome is accepted under its own ID, the record is cleared and the settings open", async () => {
    const f = fixture(settingsResponse, stored());
    f.api.status.mockImplementation(async () => ({ outcome: "accepted", state_version: next,
      command: { ...fact(pauseIntent), status: "already_applied" }, current: (() => { const data = settingsResponse();
        data.state_version = next; return data; })() }));
    await f.controller.refresh();
    const state = f.controller.snapshot();
    expect(state.outcome).toEqual({ commandId: id(78), key: "learning_reminder_pause_seconds", status: "accepted" });
    expect(state).toMatchObject({ phase: "ready", pending: null, canEdit: true, problem: null });
    expect(f.values.has(slot)).toBe(false);
    expect(f.api.save).not.toHaveBeenCalled();
  });
});
