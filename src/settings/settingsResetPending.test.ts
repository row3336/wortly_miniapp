import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { SettingsPendingStore } from "./settingsPending";
import { SETTINGS_RESET_SLOT, SettingsResetPendingStore, settingsResetSlotOf, validSettingsResetPending, type SettingsResetPending } from "./settingsResetPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const pending = (): SettingsResetPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: { command_id: id(3), kind: "settings.reset", payload: {} } });
const SLOT_A = settingsResetSlotOf(id(1));
const SLOT_B = settingsResetSlotOf(id(9));
const pendingB = (): SettingsResetPending => ({ schemaVersion: 1, profileId: id(9), clientInstanceId: id(2),
  intent: { command_id: id(13), kind: "settings.reset", payload: {} } });
/** `raw` fills the profile 1 slot; `legacy` fills the old global key. */
function setup(raw: string | null = null, legacy: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(SLOT_A, raw);
  if (legacy !== null) values.set(SETTINGS_RESET_SLOT, legacy);
  const storage: AsyncStorage = {
    get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
    remove: vi.fn(async key => { values.delete(key); }),
  };
  return { values, storage, store: new SettingsResetPendingStore(storage) };
}

describe("temporary settings reset intent storage (D-SET-RESET 4.3.2, 5.3.6)", () => {
  it("round-trips the intent in its own slot without credentials or setting values", async () => {
    const { store, storage, values } = setup();
    await store.save(pending(), signal()); await store.save(structuredClone(pending()), signal());
    expect(storage.set).toHaveBeenCalledOnce();
    expect([...values.keys()]).toEqual([SLOT_A]);
    expect(await store.load(id(1), signal())).toEqual(pending());
    expect(values.get(SLOT_A)).not.toMatch(/token|proof|document|draft|value/);
    await store.clear(pending(), signal()); expect(values.size).toBe(0);
  });

  it("an older build's settings slot never sees a reset, and the reset slot never sees a save", async () => {
    const { store, storage, values } = setup();
    await store.save(pending(), signal());
    const settings = new SettingsPendingStore(storage);
    await expect(settings.load(id(1), signal())).resolves.toBeNull();
    expect(values.get(SLOT_A)).toBeDefined();
    values.delete(SLOT_A);
    await settings.save({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), intent: { command_id: id(4),
      kind: "setting.save", expected_field_version: "1", payload: { key: "retry_count", value: 3 } } }, signal());
    await expect(store.load(id(1), signal())).resolves.toBeNull();
  });

  it("keys are deterministic per profile and distinct from the legacy global key", () => {
    expect(SLOT_A).toBe(`wortly.pending.settings-reset:profile:${id(1)}`);
    expect(settingsResetSlotOf(id(1).toUpperCase())).toBe(SLOT_A);
    expect(SLOT_A).not.toBe(SLOT_B); expect(SLOT_A).not.toBe(SETTINGS_RESET_SLOT);
    expect(() => settingsResetSlotOf("x")).toThrow(expect.objectContaining({ kind: "invalid" }));
  });

  it("A -> B -> A: B neither sees, changes nor deletes A's record, which comes back exact (status included)", async () => {
    const { store, values } = setup();
    await store.save(pending(), signal()); await store.markMismatch(pending(), signal());
    const stored = values.get(SLOT_A);
    await expect(store.load(id(9), signal())).resolves.toBeNull();
    await store.save(pendingB(), signal());
    await store.markMismatch(pendingB(), signal());
    await store.clearMarked(pendingB(), signal());
    await store.clear(pendingB(), signal());
    await expect(store.load(id(9), signal())).resolves.toBeNull();
    expect(values.get(SLOT_A)).toBe(stored);
    await expect(store.load(id(1), signal())).resolves.toEqual({ ...pending(), mismatch: true });
  });

  it("two profiles keep their own resets side by side and clear them independently", async () => {
    const { store, values } = setup();
    await store.save(pending(), signal()); await store.save(pendingB(), signal());
    expect([...values.keys()].sort()).toEqual([SLOT_A, SLOT_B].sort());
    await expect(store.load(id(1), signal())).resolves.toEqual(pending());
    await expect(store.load(id(9), signal())).resolves.toEqual(pendingB());
    const other = pending(); other.intent.command_id = id(8);
    await expect(store.save(other, signal())).rejects.toMatchObject({ kind: "changed" });
    await store.clear(pendingB(), signal());
    expect([...values.keys()]).toEqual([SLOT_A]);
    await expect(store.load(id(1), signal())).resolves.toEqual(pending());
  });

  it("B's operations are keyed by B's ID only: they never read or write A's key", async () => {
    const { store, storage } = setup();
    await store.save(pending(), signal());
    vi.mocked(storage.get).mockClear(); vi.mocked(storage.set).mockClear(); vi.mocked(storage.remove).mockClear();
    await store.load(id(9), signal()); await store.save(pendingB(), signal());
    await store.markMismatch(pendingB(), signal()); await store.clearMarked(pendingB(), signal());
    await store.clear(pendingB(), signal());
    const touched = [storage.get, storage.set, storage.remove].flatMap(fn => vi.mocked(fn).mock.calls.map(call => call[0]));
    expect(touched).not.toContain(SLOT_A);
  });

  it("an upper- and a lower-case spelling of one profile ID are the same record and nothing is deleted", async () => {
    const upper = { ...pending(), profileId: "00000000-0000-4ABC-8ABC-000000000010" };
    const lowerId = upper.profileId.toLowerCase();
    const { store, values } = setup();
    await store.save(upper, signal());
    const key = settingsResetSlotOf(lowerId); const stored = values.get(key);
    expect(stored).toBeDefined();
    await expect(store.load(lowerId, signal())).resolves.toEqual({ ...upper, profileId: lowerId });
    await expect(store.load(upper.profileId, signal())).resolves.toEqual({ ...upper, profileId: lowerId });
    expect(values.get(key)).toBe(stored);
    // A record written by an earlier spelling is read, not erased, under the other one.
    values.set(key, JSON.stringify(upper));
    await expect(store.load(lowerId, signal())).resolves.not.toBeNull();
    expect(values.get(key)).toBe(JSON.stringify(upper));
    await store.clear({ ...upper, profileId: lowerId }, signal()); expect(values.has(key)).toBe(false);
  });

  it("a record under a profile's key that names another profile is invalid and is kept, not deleted", async () => {
    const raw = JSON.stringify(pendingB());
    const { store, values } = setup(raw);
    await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(values.get(SLOT_A)).toBe(raw);
  });

  describe("legacy global slot (P02 migration pending)", () => {
    it("is never read as anyone's record, and another profile neither inherits nor erases it", async () => {
      const legacy = JSON.stringify(pending());
      const { store, storage, values } = setup(null, legacy);
      await expect(store.load(id(9), signal())).resolves.toBeNull();
      await store.save(pendingB(), signal()); await store.clear(pendingB(), signal());
      expect(values.get(SETTINGS_RESET_SLOT)).toBe(legacy);
      expect(storage.remove).not.toHaveBeenCalledWith(SETTINGS_RESET_SLOT);
      expect(storage.set).not.toHaveBeenCalledWith(SETTINGS_RESET_SLOT, expect.anything());
    });

    it("fails closed for its own profile on every operation and stays untouched", async () => {
      const legacy = JSON.stringify(pending());
      const { store, storage, values } = setup(null, legacy);
      for (const run of [() => store.load(id(1), signal()), () => store.save(pending(), signal()),
        () => store.clear(pending(), signal()), () => store.clearMarked(pending(), signal()),
        () => store.markMismatch(pending(), signal())]) await expect(run()).rejects.toMatchObject({ kind: "invalid" });
      expect(values.get(SETTINGS_RESET_SLOT)).toBe(legacy);
      expect(values.has(SLOT_A)).toBe(false);
      expect(storage.set).not.toHaveBeenCalled(); expect(storage.remove).not.toHaveBeenCalled();
    });

    it("a damaged legacy record has no known owner: blocks every profile and is kept", async () => {
      const { store, values } = setup(null, "not json");
      await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
      await expect(store.load(id(9), signal())).rejects.toMatchObject({ kind: "invalid" });
      expect(values.get(SETTINGS_RESET_SLOT)).toBe("not json");
    });

    it("a storage read failure is unavailable, and a cancelled signal is cancelled", async () => {
      const { store, storage } = setup();
      vi.mocked(storage.get).mockRejectedValueOnce(new Error("idb"));
      await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "unavailable" });
      const controller = new AbortController(); controller.abort();
      await expect(store.load(id(1), controller.signal)).rejects.toMatchObject({ kind: "cancelled" });
    });
  });

  it.each([
    "not json", JSON.stringify({ ...pending(), intent: { ...pending().intent, payload: { key: "retry_count" } } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, kind: "setting.save" } }),
    JSON.stringify({ ...pending(), extra: true }), JSON.stringify({ ...pending(), schemaVersion: 2 }),
    JSON.stringify({ ...pending(), mismatch: false }), JSON.stringify({ ...pending(), clientInstanceId: "x" }),
  ])("reports a damaged record as invalid and keeps it for inspection %#", async raw => {
    const { store, values } = setup(raw);
    await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(values.get(SLOT_A)).toBe(raw);
  });

  it("refuses to overwrite or clear a different reset and keeps a mismatch mark", async () => {
    const { store, values } = setup();
    await store.save(pending(), signal());
    const other = pending(); other.intent.command_id = id(8);
    await expect(store.save(other, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.clear(other, signal())).rejects.toMatchObject({ kind: "changed" });
    await store.markMismatch(pending(), signal());
    expect(JSON.parse(values.get(SLOT_A)!)).toEqual({ ...pending(), mismatch: true });
    expect(validSettingsResetPending({ ...pending(), mismatch: true })).toBe(true);
  });
});
