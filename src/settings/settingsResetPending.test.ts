import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { SettingsPendingStore } from "./settingsPending";
import { SETTINGS_RESET_SLOT, SettingsResetPendingStore, validSettingsResetPending, type SettingsResetPending } from "./settingsResetPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const pending = (): SettingsResetPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: { command_id: id(3), kind: "settings.reset", payload: {} } });
function setup(raw: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(SETTINGS_RESET_SLOT, raw);
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
    expect([...values.keys()]).toEqual(["wortly.pending.settings-reset"]);
    expect(await store.load(id(1), signal())).toEqual(pending());
    expect(values.get(SETTINGS_RESET_SLOT)).not.toMatch(/token|proof|document|draft|value/);
    await store.clear(pending(), signal()); expect(values.size).toBe(0);
  });

  it("an older build's settings slot never sees a reset, and the reset slot never sees a save", async () => {
    const { store, storage, values } = setup();
    await store.save(pending(), signal());
    const settings = new SettingsPendingStore(storage);
    await expect(settings.load(id(1), signal())).resolves.toBeNull();
    expect(values.get(SETTINGS_RESET_SLOT)).toBeDefined();
    values.delete(SETTINGS_RESET_SLOT);
    await settings.save({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), intent: { command_id: id(4),
      kind: "setting.save", expected_field_version: "1", payload: { key: "retry_count", value: 3 } } }, signal());
    await expect(store.load(id(1), signal())).resolves.toBeNull();
  });

  it("drops another profile's reset on load instead of checking it for this one", async () => {
    const { store, values } = setup(JSON.stringify(pending()));
    await expect(store.load(id(9), signal())).resolves.toBeNull();
    expect(values.size).toBe(0);
  });

  it.each([
    "not json", JSON.stringify({ ...pending(), intent: { ...pending().intent, payload: { key: "retry_count" } } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, kind: "setting.save" } }),
    JSON.stringify({ ...pending(), extra: true }), JSON.stringify({ ...pending(), schemaVersion: 2 }),
    JSON.stringify({ ...pending(), mismatch: false }), JSON.stringify({ ...pending(), clientInstanceId: "x" }),
  ])("reports a damaged record as invalid and keeps it for inspection %#", async raw => {
    const { store, values } = setup(raw);
    await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(values.get(SETTINGS_RESET_SLOT)).toBe(raw);
  });

  it("refuses to overwrite or clear a different reset and keeps a mismatch mark", async () => {
    const { store, values } = setup();
    await store.save(pending(), signal());
    const other = pending(); other.intent.command_id = id(8);
    await expect(store.save(other, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.clear(other, signal())).rejects.toMatchObject({ kind: "changed" });
    await store.markMismatch(pending(), signal());
    expect(JSON.parse(values.get(SETTINGS_RESET_SLOT)!)).toEqual({ ...pending(), mismatch: true });
    expect(validSettingsResetPending({ ...pending(), mismatch: true })).toBe(true);
  });
});
