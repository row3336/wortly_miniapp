// The durable record of a session.cancel_start (D-CP2C-START table 2.8.1, M-CP2C-START CP1).
import { describe, expect, it } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { PendingStoreError } from "./pendingSlot";
import { copyStartCancelPending, startCancelKey, startCancelStore, StartCancelPendingStore, validStartCancelPending,
  type StartCancelPending } from "./startCancelPending";
import { pendingRaw, seedRaw } from "./pendingSeed.test-support";
const seedRawAt = (profileId: string, values: Map<string, string>, base: string, raw: string) => seedRaw(values, base, raw, profileId);

const RECORD: StartCancelPending = { schemaVersion: 1, profileId: "00000000-0000-4000-8000-000000000001",
  clientInstanceId: "00000000-0000-4000-8000-000000000002", pair: "ru-de", sessionId: "00000000-0000-4000-8000-000000000003",
  startCommandId: "00000000-0000-4000-8000-000000000004", cancelCommandId: "00000000-0000-4000-8000-000000000005" };
const OTHER_PROFILE = "00000000-0000-4000-8000-000000000009";

function memory(): AsyncStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
}
const signal = () => new AbortController().signal;

describe("the cancel record", () => {
  it("has the exact keys of table 2.8.1 and three different numbers", () => {
    expect(validStartCancelPending(RECORD)).toBe(true);
    expect(validStartCancelPending({ ...RECORD, extra: 1 })).toBe(false);
    const { cancelCommandId: _cancel, ...missing } = RECORD;
    expect(validStartCancelPending(missing)).toBe(false);
    expect(validStartCancelPending({ ...RECORD, schemaVersion: 2 })).toBe(false);
    expect(validStartCancelPending({ ...RECORD, pair: "de-de" })).toBe(false);
    expect(validStartCancelPending({ ...RECORD, sessionId: "not-a-uuid" })).toBe(false);
    // The cancel never reuses the start's command_id, and no command_id equals the session number (REV F03).
    expect(validStartCancelPending({ ...RECORD, cancelCommandId: RECORD.startCommandId })).toBe(false);
    expect(validStartCancelPending({ ...RECORD, cancelCommandId: RECORD.startCommandId.toUpperCase() })).toBe(false);
    expect(validStartCancelPending({ ...RECORD, cancelCommandId: RECORD.sessionId })).toBe(false);
    expect(validStartCancelPending({ ...RECORD, startCommandId: RECORD.sessionId })).toBe(false);
  });

  it("copies canonically and refuses an invalid value as a store error", () => {
    const shuffled = { cancelCommandId: RECORD.cancelCommandId, sessionId: RECORD.sessionId, pair: RECORD.pair,
      startCommandId: RECORD.startCommandId, clientInstanceId: RECORD.clientInstanceId, profileId: RECORD.profileId, schemaVersion: 1 };
    expect(JSON.stringify(copyStartCancelPending(shuffled))).toBe(JSON.stringify(RECORD));
    expect(() => copyStartCancelPending({ ...RECORD, extra: true })).toThrow(PendingStoreError);
  });

  it("lives in its own key per mode, apart from the lane slots", () => {
    expect(startCancelKey("written")).toBe("wortly.pending.written_start_cancel");
    expect(startCancelKey("learning")).toBe("wortly.pending.learning_start_cancel");
    expect(startCancelKey("oral")).toBe("wortly.pending.oral_start_cancel");
    expect(startCancelKey("conjugation")).toBe("wortly.pending.conjugation_start_cancel");
  });

  it("saves, loads and clears; another profile's load never removes this record (pending profile addresses)", async () => {
    const storage = memory(), store = new StartCancelPendingStore(storage, "written");
    await store.save(RECORD, signal());
    expect(JSON.parse(pendingRaw(storage.values, "wortly.pending.written_start_cancel")!)).toEqual(RECORD);
    expect(await store.load(RECORD.profileId, signal())).toEqual(RECORD);
    // A second cancel of another start cannot overwrite the first one.
    await expect(store.save({ ...RECORD, cancelCommandId: "00000000-0000-4000-8000-000000000006" }, signal()))
      .rejects.toMatchObject({ kind: "changed" });
    await store.clear(RECORD, signal());
    expect(storage.values.size).toBe(0);
    await store.save(RECORD, signal());
    expect(await store.load(OTHER_PROFILE, signal())).toBeNull();
    expect(storage.values.size).toBe(1);
    expect(await store.load(RECORD.profileId, signal())).toEqual(RECORD);
  });

  it("a corrupt stored value is an invalid record, not an absent one", async () => {
    const storage = memory(), store = new StartCancelPendingStore(storage, "learning");
    seedRawAt(RECORD.profileId, storage.values, "wortly.pending.learning_start_cancel", JSON.stringify({ ...RECORD, cancelCommandId: RECORD.startCommandId }));
    await expect(store.load(RECORD.profileId, signal())).rejects.toMatchObject({ kind: "invalid" });
  });

  it("one shared store per storage and mode", () => {
    const a = memory(), b = memory();
    expect(startCancelStore(a, "written")).toBe(startCancelStore(a, "written"));
    expect(startCancelStore(a, "written")).not.toBe(startCancelStore(a, "learning"));
    expect(startCancelStore(a, "written")).not.toBe(startCancelStore(b, "written"));
  });
});
