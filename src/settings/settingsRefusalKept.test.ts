import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile, SettingsResponse } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { PendingSlot, PendingStoreError } from "../commands/pendingSlot";
import type { AsyncStorage } from "../platform/storage";
import { KnownRefusal, type SettingsApi, type SettingStatusReply } from "./settingsApi";
import { SettingsController } from "./settingsController";
import { SettingsPendingStore, settingsSlotOf, validSettingsPending, type SettingsPending } from "./settingsPending";
import { SettingsResetPendingStore } from "./settingsResetPending";
import { settingsResponse } from "./settingsRead.test-support";

// R2-09 / K19-024 / P5-013 (C282): the 422 of an ordinary settings save is kept with its pending record between openings,
// lifted only by a proven change of the server's state or by the user's explicit cancel of that earlier change.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const big = "9007199254740995";
const slot = settingsSlotOf(id(1));
const otherSlot = settingsSlotOf(id(9));
const profile = (): Profile => ({ profile_id: id(1), access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: big });
const opened = (document: string): OpenedClient => ({ status: "opened", client_instance_id: id(2), document_id: document,
  document_epoch: "1", proof_version: "1", profile: profile(), session: null,
  compatibility: { compatible: true, contract_version: "1" } });
const intent = (commandId = id(78)) => ({ command_id: commandId, kind: "setting.save" as const, expected_field_version: "2",
  payload: { key: "retry_count" as const, value: 5 } });
const record = (extra: Partial<SettingsPending> = {}, commandId = id(78)): SettingsPending => ({ schemaVersion: 1, profileId: id(1),
  clientInstanceId: id(2), intent: intent(commandId), ...extra });
const notFound = async (): Promise<SettingStatusReply> => ({ outcome: "not_found", command: { id: id(78), status: "not_found" },
  current: profile(), state_version: big });
const otherProfileRecord = JSON.stringify({ schemaVersion: 1, profileId: id(9), clientInstanceId: id(2), refused: true,
  intent: { ...intent(id(90)) } });

function storage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial));
  const backing: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  return { values, backing };
}
/** One opening of the app: a new document over the same device storage. */
function opening(disk: ReturnType<typeof storage>, document: string, read: () => SettingsResponse = settingsResponse) {
  const api = { get: vi.fn<SettingsApi["get"]>(async () => read()), save: vi.fn<SettingsApi["save"]>(),
    status: vi.fn<SettingsApi["status"]>(notFound), reset: vi.fn<SettingsApi["reset"]>(), resetStatus: vi.fn<SettingsApi["resetStatus"]>() };
  let access: OpenedAccess | null = null;
  const handle: OpenedAccess = createOpenedAccess({ opened: opened(document), token: "synthetic-token", proof: "synthetic-proof",
    generation: 1, isLive: () => access === handle, onDenied: vi.fn() });
  access = handle;
  let sequence = 500;
  const controller = new SettingsController({ api, pendingStore: new SettingsPendingStore(disk.backing),
    resetStore: new SettingsResetPendingStore(disk.backing), access: () => access, newId: () => id(sequence++), onUpdate: () => {} });
  return { controller, api };
}
/** An opening that repeats the stored save of retry_count and gets the 422. */
async function refusedOnce(disk: ReturnType<typeof storage>, document: string) {
  const o = opening(disk, document);
  await o.controller.refresh();
  o.api.save.mockRejectedValueOnce(new KnownRefusal("command_refused", 422, "VALIDATION_FAILED"));
  await o.controller.retry();
  expect(o.api.save).toHaveBeenCalledOnce();
  return o;
}

describe("the 422 of an ordinary save is kept between openings", () => {
  it("is written with its record, and the next opening shows it at once: no repeat, the cancel offered", async () => {
    const disk = storage({ [slot]: JSON.stringify(record()), [otherSlot]: otherProfileRecord });
    await refusedOnce(disk, id(301));
    expect(JSON.parse(disk.values.get(slot)!)).toEqual(record({ refused: true }));
    const next = opening(disk, id(302));
    await next.controller.refresh();
    expect(next.api.status).toHaveBeenCalledOnce();
    expect(next.controller.snapshot()).toMatchObject({ phase: "unresolved", problem: { reason: "command_refused", code: "VALIDATION_FAILED" },
      canRetry: false, canEdit: false, canCancelStored: true, drafts: { retry_count: { input: 5 } } });
    await next.controller.retry(); await next.controller.refresh();
    expect(next.api.save).not.toHaveBeenCalled();
    expect(disk.values.get(otherSlot)).toBe(otherProfileRecord);
  });
  it("a proven change of the server's state lifts it: another field version releases the record, the input stays as a conflict", async () => {
    const disk = storage({ [slot]: JSON.stringify(record({ refused: true })) });
    const changed = () => { const data = settingsResponse(); data.settings.retry_count = { value: 7, version: "3" }; return data; };
    const o = opening(disk, id(303), changed);
    await o.controller.refresh();
    expect(disk.values.has(slot)).toBe(false);
    const state = o.controller.snapshot();
    expect(state).toMatchObject({ phase: "ready", pending: null, problem: null, canEdit: true, canCancelStored: false,
      outcome: { commandId: id(78), key: "retry_count", status: "rejected", code: "VALIDATION_FAILED" } });
    expect(state.drafts.retry_count).toMatchObject({ input: 5, conflict: true });
    expect(o.api.save).not.toHaveBeenCalled();
  });
  it("the same field version is no proof: the refusal stands", async () => {
    const disk = storage({ [slot]: JSON.stringify(record({ refused: true })) });
    const o = opening(disk, id(304));
    await o.controller.refresh();
    expect(o.controller.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canCancelStored: true });
    expect(disk.values.get(slot)).toBe(JSON.stringify(record({ refused: true })));
  });
  it("the old ID found applied settles it as any stored save", async () => {
    const disk = storage({ [slot]: JSON.stringify(record({ refused: true })) });
    const o = opening(disk, id(305));
    o.api.status.mockImplementation(async () => {
      const data = settingsResponse(); data.settings.retry_count = { value: 5, version: "3" };
      return { outcome: "accepted", command: { id: id(78), kind: "setting.save", status: "already_applied", applied_at: "2026-10-13T00:00:00Z",
        target_id: id(1), action_id: null, result_id: null, context_id: null, object_version: "3" }, current: data, state_version: big };
    });
    await o.controller.refresh();
    expect(o.controller.snapshot()).toMatchObject({ pending: null, outcome: { status: "accepted" }, canEdit: true });
    expect(disk.values.has(slot)).toBe(false);
  });
});

describe("the explicit cancel of the earlier change", () => {
  it("reads the old ID, clears only this record and its input, reads fresh settings; nothing is sent, the other profile is untouched", async () => {
    const disk = storage({ [slot]: JSON.stringify(record({ refused: true })), [otherSlot]: otherProfileRecord });
    const o = opening(disk, id(306));
    await o.controller.refresh();
    const reads = o.api.get.mock.calls.length;
    await o.controller.cancelStored();
    expect(o.api.status).toHaveBeenCalledTimes(2);
    expect(o.api.status.mock.calls[1][2]).toEqual(intent());
    expect(o.api.get).toHaveBeenCalledTimes(reads + 1);
    expect(o.api.save).not.toHaveBeenCalled();
    expect(disk.values.has(slot)).toBe(false);
    expect(disk.values.get(otherSlot)).toBe(otherProfileRecord);
    const state = o.controller.snapshot();
    expect(state).toMatchObject({ phase: "ready", pending: null, problem: null, canEdit: true, outcome: null });
    expect(state.drafts).toEqual({});
    expect(state.data!.settings.retry_count).toEqual(settingsResponse().settings.retry_count);
  });
  it("a newer intent written to the slot meanwhile is never removed: the cancel fails as changed and keeps it", async () => {
    const disk = storage({ [slot]: JSON.stringify(record({ refused: true })) });
    const o = opening(disk, id(307));
    await o.controller.refresh();
    const newer = JSON.stringify(record({}, id(79)));
    disk.values.set(slot, newer);
    await o.controller.cancelStored();
    expect(disk.values.get(slot)).toBe(newer);
    expect(o.controller.snapshot().problem).toMatchObject({ reason: "pending_changed" });
  });
});

describe("PendingSlot.replace (QA r4 S6)", () => {
  const copy = (value: unknown) => { if (!validSettingsPending(value)) throw new PendingStoreError("invalid"); return structuredClone(value); };
  const signal = new AbortController().signal;
  it("does not overwrite another intent stored between the read and the replace", async () => {
    const newer = JSON.stringify(record({}, id(79)));
    const disk = storage({ k: newer });
    const slotOf = new PendingSlot<SettingsPending>(disk.backing, "k", copy);
    await expect(slotOf.replace(record(), record({ refused: true }), signal)).rejects.toMatchObject({ kind: "changed" });
    expect(disk.values.get("k")).toBe(newer);
    expect(disk.backing.set).not.toHaveBeenCalled();
  });
  it("writes the mark over exactly the expected record; an absent record is not recreated; the marked one is left", async () => {
    const disk = storage({ k: JSON.stringify(record()) });
    const slotOf = new PendingSlot<SettingsPending>(disk.backing, "k", copy);
    await slotOf.replace(record(), record({ refused: true }), signal);
    expect(JSON.parse(disk.values.get("k")!)).toEqual(record({ refused: true }));
    await slotOf.replace(record(), record({ refused: true }), signal);
    expect(disk.backing.set).toHaveBeenCalledOnce();
    disk.values.delete("k");
    await slotOf.replace(record(), record({ refused: true }), signal);
    expect(disk.values.has("k")).toBe(false);
  });
  it("in the controller: the slot rewritten by another window before the 422 keeps that intent; the refusal is held in memory", async () => {
    const disk = storage({ [slot]: JSON.stringify(record()) });
    const o = opening(disk, id(308));
    await o.controller.refresh();
    const newer = JSON.stringify(record({}, id(79)));
    o.api.save.mockImplementationOnce(async () => { disk.values.set(slot, newer); throw new KnownRefusal("command_refused", 422, "VALIDATION_FAILED"); });
    await o.controller.retry();
    expect(disk.values.get(slot)).toBe(newer);
    expect(o.controller.snapshot()).toMatchObject({ problem: { reason: "command_refused" }, canRetry: false });
  });
});
