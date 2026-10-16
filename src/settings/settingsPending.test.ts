import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { ManualPendingStore, type ManualPending } from "../learning/manualPending";
import type { EditableSettingIntent } from "./settingsApi";
import { SettingsPendingStore, settingsSlotOf, type SettingsPending } from "./settingsPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const pending = (): SettingsPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: { command_id: id(3), kind: "setting.save", expected_field_version: "9007199254740997",
    payload: { key: "learning_intervals_seconds", value: [120, 30, 120] } } });
function setup(raw: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(`wortly.pending.setting:profile:${id(1)}`, raw);
  const storage: AsyncStorage = {
    get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
    remove: vi.fn(async key => { values.delete(key); }),
  };
  return { values, storage, store: new SettingsPendingStore(storage) };
}

describe("temporary settings intent storage", () => {
  const payloads: EditableSettingIntent["payload"][] = [
    { key: "strict_case", value: false }, { key: "retry_count", value: 3 },
    { key: "learning_intervals_seconds", value: [120, 30, 120] },
    { key: "ui_language", value: "uk" }, { key: "transition_mode", value: "accelerated" },
    { key: "material", value: { mode: "level", selected_level: "B1" } },
    { key: "material", value: { mode: "topics", topic_ids: [id(9), id(8)] } },
  ];
  it.each(payloads)("round-trips $key without credentials, sorting or coercion %#", async payload => {
    const { store, storage, values } = setup(); const original = pending(); original.intent.payload = payload;
    await store.save(original, signal()); await store.save(structuredClone(original), signal());
    expect(storage.set).toHaveBeenCalledOnce();
    expect(await store.load(id(1), signal())).toEqual(original);
    expect(values.size).toBe(1);
    expect([...values.values()][0]).not.toMatch(/token|proof|document|draft/);
    await store.clear(original, signal()); expect(values.size).toBe(0);
  });

  it("copies nested arrays before asynchronous persistence and before exposing a loaded value", async () => {
    const { store, storage } = setup(); const original = pending();
    const topics = { mode: "topics" as const, topic_ids: [id(9)] };
    original.intent.payload = { key: "material", value: topics };
    const expected = structuredClone(original);
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    vi.mocked(storage.get).mockImplementationOnce(async () => { await gate; return null; });
    const saving = store.save(original, signal()); topics.topic_ids.push(id(8)); original.intent.command_id = id(99);
    finish(); await saving;
    const loaded = (await store.load(id(1), signal()))!;
    expect(loaded).toEqual(expected);
    loaded.intent.payload.value = false; loaded.intent.expected_field_version = "2";
    expect(await store.load(id(1), signal())).toEqual(expected);
  });

  it.each(["level", "topics"] as const)("compares %s material by content, independent of object property order", async mode => {
    const { store, storage } = setup(); const original = pending();
    original.intent.payload = { key: "material", value: mode === "level"
      ? { mode, selected_level: "A1" } : { mode, topic_ids: [id(9), id(8)] } };
    await store.save(original, signal());
    const equivalent = pending();
    equivalent.intent.payload = { key: "material", value: mode === "level"
      ? { selected_level: "A1", mode } : { topic_ids: [id(9), id(8)], mode } };
    await store.save(equivalent, signal()); expect(storage.set).toHaveBeenCalledOnce();
    await store.clear(equivalent, signal());
    expect(await store.load(id(1), signal())).toBeNull();
  });

  it.each(["client", "command", "field", "version", "value", "order"] as const)("never clears or replaces another %s intent", async changed => {
    const { store } = setup(JSON.stringify(pending())); const next = pending();
    if (changed === "client") next.clientInstanceId = id(99);
    if (changed === "command") next.intent.command_id = id(99);
    if (changed === "field") next.intent.payload = { key: "strict_case", value: true };
    if (changed === "version") next.intent.expected_field_version = "2";
    if (changed === "value") next.intent.payload.value = [10];
    if (changed === "order") next.intent.payload.value = [30, 120, 120];
    await expect(store.save(next, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.clear(next, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.markMismatch(next, signal())).rejects.toMatchObject({ kind: "changed" });
    expect(await store.load(id(1), signal())).toEqual(pending());
  });

  it("retains mismatch across reconstruction and refuses cleanup from an older unmarked view", async () => {
    const { store, storage } = setup(); const original = pending();
    await store.save(original, signal());
    const marking = store.markMismatch(original, signal());
    const clearing = expect(store.clear(original, signal())).rejects.toMatchObject({ kind: "changed" });
    await marking; await clearing;
    const restored = new SettingsPendingStore(storage);
    expect(await restored.load(id(1), signal())).toEqual({ ...original, mismatch: true });
    await expect(restored.save(original, signal())).rejects.toMatchObject({ kind: "changed" });
  });

  it("keeps settings and manual-selection slots separate, including profile cleanup", async () => {
    const { store, storage, values } = setup();
    const manual = new ManualPendingStore(storage);
    const selection: ManualPending = { schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
      intent: { command_id: id(4), kind: "learning.select", expected_selection_version: "1",
        payload: { card_id: id(5), expected_pair: "ru-de" } } };
    await Promise.all([manual.save(selection, signal()), store.save(pending(), signal())]);
    expect(values.size).toBe(2);
    expect(await store.load(id(99), signal())).toBeNull(); expect(values.size).toBe(2);
    expect(await manual.load(id(1), signal())).toEqual(selection);
    expect(await store.load(id(1), signal())).toEqual(pending()); expect(values.size).toBe(2);
  });

  it.each(["broken", "[]", "null", JSON.stringify({ ...pending(), schemaVersion: 2 }),
    JSON.stringify({ ...pending(), token: "synthetic" }), JSON.stringify({ ...pending(), proof: "synthetic" }),
    JSON.stringify({ ...pending(), documentId: id(7) }), JSON.stringify({ ...pending(), draft: "unsent" }),
    JSON.stringify({ ...pending(), mismatch: false }), JSON.stringify({ ...pending(), profileId: "bad" }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, expected_field_version: "0" } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, kind: "learning.select" } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, payload: { key: "retry_count", value: true } } }),
  ])("does not discard malformed recovery data or turn it into an empty slot %#", async raw => {
    const { store, values } = setup(raw);
    await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.save(pending(), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect([...values.values()]).toEqual([raw]);
  });

  it.each(["learning_poll_seconds", "learning_ready_percent"])(
    "drops an unfinished save of the retired %s with a technical record, and then accepts new intents", async key => {
      const retired = JSON.stringify({ ...pending(), intent: { ...pending().intent, payload: { key, value: 80 } } });
      const { storage, values } = setup(retired); const report = vi.fn();
      const store = new SettingsPendingStore(storage, report);
      expect(await store.load(id(1), signal())).toBeNull();
      expect(values.size).toBe(0);
      expect(report).toHaveBeenCalledOnce();
      expect(report.mock.calls[0][0]).toContain(key);
      expect(report.mock.calls[0][0]).not.toMatch(/80|token|proof/);
      await store.save(pending(), signal());
      expect(await store.load(id(1), signal())).toEqual(pending());
      expect(report).toHaveBeenCalledOnce();
    });

  const retiredRaw = () => JSON.stringify({ ...pending(), intent: { ...pending().intent,
    payload: { key: "learning_poll_seconds", value: 80 } } });

  it.each(["get", "remove"] as const)("turns a failing storage %s on a retired slot into an unavailable store", async method => {
    const { storage, values } = setup(retiredRaw()); const report = vi.fn();
    vi.mocked(storage[method]).mockRejectedValueOnce(new Error("private-details"));
    await expect(new SettingsPendingStore(storage, report).load(id(1), signal())).rejects.toMatchObject({ kind: "unavailable" });
    expect(report).not.toHaveBeenCalled();
    if (method === "remove") expect(values.size).toBe(1);
  });

  it("neither removes nor reports a retired slot when the signal is already cancelled or cancelled during the read", async () => {
    const { storage, values } = setup(retiredRaw()); const report = vi.fn();
    const store = new SettingsPendingStore(storage, report); const owner = new AbortController(); owner.abort();
    await expect(store.load(id(1), owner.signal)).rejects.toMatchObject({ kind: "cancelled" });
    const during = new AbortController();
    vi.mocked(storage.get).mockImplementationOnce(async () => { during.abort(); return retiredRaw(); });
    await expect(store.load(id(1), during.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(storage.remove).not.toHaveBeenCalled(); expect(report).not.toHaveBeenCalled(); expect(values.size).toBe(1);
  });

  it("removes a retired slot once with a live signal and reports the key name only", async () => {
    const { storage } = setup(retiredRaw()); const report = vi.fn();
    expect(await new SettingsPendingStore(storage, report).load(id(1), signal())).toBeNull();
    expect(storage.remove).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledWith(expect.stringContaining("learning_poll_seconds"));
    expect(report.mock.calls[0][0]).not.toMatch(/80|token|proof/);
  });

  it("reports nothing and keeps the slot when the stored intent is an ordinary one", async () => {
    const { storage, values } = setup(JSON.stringify(pending())); const report = vi.fn();
    expect(await new SettingsPendingStore(storage, report).load(id(1), signal())).toEqual(pending());
    expect(report).not.toHaveBeenCalled(); expect(values.size).toBe(1);
  });

  it("does not persist after disposal during the read before a write", async () => {
    const { store, storage, values } = setup(); const owner = new AbortController();
    vi.mocked(storage.get).mockImplementationOnce(async () => { owner.abort(); return null; });
    await expect(store.save(pending(), owner.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(storage.set).not.toHaveBeenCalled(); expect(values.size).toBe(0);
  });

  it.each(["save", "clear", "markMismatch", "load"] as const)("cancels %s in the microtask gap after the read has completed", async action => {
    const raw = action === "save" ? null : JSON.stringify(pending());
    const { store, storage, values } = setup(raw); const owner = new AbortController();
    vi.mocked(storage.get).mockImplementationOnce(async () => {
      queueMicrotask(() => queueMicrotask(() => owner.abort()));
      return raw;
    });
    const task = action === "load" ? store.load(id(99), owner.signal) : store[action](pending(), owner.signal);
    await expect(task).rejects.toMatchObject({ kind: "cancelled" });
    expect(storage.set).not.toHaveBeenCalled(); expect(storage.remove).not.toHaveBeenCalled();
    expect([...values.values()]).toEqual(raw === null ? [] : [raw]);
  });

  it("does not let a storage error poison later exact retries", async () => {
    const { store, storage } = setup();
    vi.mocked(storage.set).mockRejectedValueOnce(new Error("synthetic-private-detail"));
    const error = await store.save(pending(), signal()).catch(error => error);
    expect(error).toMatchObject({ kind: "unavailable", message: "unavailable" });
    expect(JSON.stringify(error)).not.toContain("synthetic-private-detail");
    await store.save(pending(), signal()); expect(await store.load(id(1), signal())).toEqual(pending());
  });
});

describe("profile isolation of the unfinished settings save", () => {
  const A = id(1), B = id(7), LEGACY = "wortly.pending.setting";
  const forProfile = (profileId: string, commandId = id(3)): SettingsPending => {
    const record = pending(); record.profileId = profileId; record.intent.command_id = commandId; return record;
  };
  function make(seed: Record<string, string> = {}) {
    const values = new Map(Object.entries(seed));
    const storage: AsyncStorage = {
      get: vi.fn(async key => values.get(key) ?? null),
      set: vi.fn(async (key, value) => { values.set(key, value); }),
      remove: vi.fn(async key => { values.delete(key); }),
    };
    return { values, storage, report: vi.fn(), store: undefined as unknown as SettingsPendingStore,
      build(report = vi.fn()) { return new SettingsPendingStore(storage, report); } };
  }

  it("derives a deterministic lowercase key per profile and rejects a malformed ID", () => {
    expect(settingsSlotOf(A)).toBe(`wortly.pending.setting:profile:${A}`);
    expect(settingsSlotOf("AAAAAAAA-0000-4000-8000-00000000000A")).toBe("wortly.pending.setting:profile:aaaaaaaa-0000-4000-8000-00000000000a");
    expect(() => settingsSlotOf("bad")).toThrow(expect.objectContaining({ kind: "invalid" }));
  });

  it("A → B → A keeps A's IDs and mismatch status byte-identical", async () => {
    const f = make(); const store = f.build(); const a = forProfile(A);
    await store.save(a, signal()); await store.markMismatch(a, signal());
    const before = f.values.get(settingsSlotOf(A));
    expect(await store.load(B, signal())).toBeNull();
    expect(f.storage.remove).not.toHaveBeenCalled();
    expect(f.values.get(settingsSlotOf(A))).toBe(before);
    expect(await store.load(A, signal())).toEqual({ ...a, mismatch: true });
    expect(await f.build().load(A, signal())).toEqual({ ...a, mismatch: true });
  });

  it("holds two profiles at once and every operation of one leaves the other untouched", async () => {
    const f = make(); const store = f.build(); const a = forProfile(A), b = forProfile(B, id(4));
    await store.save(a, signal()); await store.save(b, signal());
    expect(await store.load(A, signal())).toEqual(a); expect(await store.load(B, signal())).toEqual(b);
    await store.markMismatch(b, signal()); await store.clearMarked(b, signal());
    expect(await store.load(B, signal())).toBeNull();
    expect(await store.load(A, signal())).toEqual(a);
    await store.save(b, signal()); await store.clear(b, signal());
    expect([...f.values.keys()]).toEqual([settingsSlotOf(A)]);
    await expect(store.clear(forProfile(A, id(5)), signal())).rejects.toMatchObject({ kind: "changed" });
  });

  it("B's operations touch only B's key and the legacy key (read), never A's key", async () => {
    const f = make(); const store = f.build(); await store.save(forProfile(A), signal());
    for (const spy of [f.storage.get, f.storage.set, f.storage.remove]) vi.mocked(spy).mockClear();
    const b = forProfile(B, id(4));
    await store.load(B, signal()); await store.save(b, signal()); await store.markMismatch(b, signal());
    await store.clearMarked(b, signal()); await store.save(b, signal()); await store.clear(b, signal());
    const touched = [f.storage.get, f.storage.set, f.storage.remove].flatMap(spy => vi.mocked(spy).mock.calls.map(call => call[0]));
    expect(touched).not.toContain(settingsSlotOf(A));
    expect(new Set(touched)).toEqual(new Set([settingsSlotOf(B), LEGACY]));
    expect(vi.mocked(f.storage.set).mock.calls.map(call => call[0]).every(key => key === settingsSlotOf(B))).toBe(true);
    expect(vi.mocked(f.storage.remove).mock.calls.map(call => call[0]).every(key => key === settingsSlotOf(B))).toBe(true);
  });

  it("reads one record under either spelling of the ID and never erases it", async () => {
    const f = make(); const store = f.build();
    const record = forProfile("AAAAAAAA-0000-4000-8000-00000000000A");
    await store.save(record, signal());
    const loaded = await store.load("aaaaaaaa-0000-4000-8000-00000000000a", signal());
    expect(loaded).toEqual({ ...record, profileId: record.profileId.toLowerCase() });
    expect(await store.load(record.profileId, signal())).toEqual(loaded);
    expect(f.storage.remove).not.toHaveBeenCalled();
  });

  it("keeps a record under a profile's key that names another profile and reports it invalid", async () => {
    const raw = JSON.stringify(forProfile(A));
    const f = make({ [settingsSlotOf(B)]: raw }); const store = f.build();
    await expect(store.load(B, signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.save(forProfile(B), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(f.values.get(settingsSlotOf(B))).toBe(raw); expect(f.storage.remove).not.toHaveBeenCalled();
  });

  describe("the legacy global key (pending profile addresses §3.4, §4): only read by the preflight of a NEW save", () => {
    it("is never routed to: the owner's load sees nothing, clear and markMismatch do not touch it", async () => {
      const raw = JSON.stringify(forProfile(A));
      const f = make({ [LEGACY]: raw }); const store = f.build();
      expect(await store.load(A, signal())).toBeNull();
      await store.clear(forProfile(A), signal()); await store.clearMarked(forProfile(A), signal());
      expect(f.values.get(LEGACY)).toBe(raw); expect(f.storage.remove).not.toHaveBeenCalled();
    });

    it.each(["present", "unreadable"] as const)("%s: a NEW save is refused as 'legacy' — nothing written, the legacy record kept", async kind => {
      const raw = JSON.stringify(forProfile(B));
      const f = make({ [LEGACY]: raw }); const report = vi.fn(); const store = f.build(report);
      if (kind === "unreadable") vi.mocked(f.storage.get).mockImplementation(async key => { if (key === LEGACY) throw new Error("read"); return f.values.get(key) ?? null; });
      await expect(store.save(forProfile(A), signal())).rejects.toMatchObject({ kind: "legacy" });
      expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
      expect(f.values.get(LEGACY)).toBe(raw);
      // The report names the fixed key only, never a record, profile or value.
      expect(report).toHaveBeenCalledOnce();
      expect(String(report.mock.calls[0][0])).toContain(LEGACY);
      expect(String(report.mock.calls[0][0])).not.toContain(B);
    });

    it("the repeat of the profile's own stored save is no new save: it goes on beside a legacy key", async () => {
      const f = make({ [settingsSlotOf(A)]: JSON.stringify(forProfile(A)), [LEGACY]: "{}" }); const store = f.build();
      await store.save(forProfile(A), signal());
      expect(f.storage.set).not.toHaveBeenCalled();
      await store.markMismatch(forProfile(A), signal());
      expect(JSON.parse(f.values.get(settingsSlotOf(A))!)).toMatchObject({ mismatch: true });
      expect(f.values.get(LEGACY)).toBe("{}");
    });

    it("an unfinished save of a retired setting under the profile key is dropped once by its load; a legacy one is not touched", async () => {
      const retired = JSON.stringify({ ...forProfile(A), intent: { ...forProfile(A).intent, payload: { key: "learning_poll_seconds", value: 80 } } });
      const f = make({ [settingsSlotOf(A)]: retired, [LEGACY]: retired }); const report = vi.fn(); const store = f.build(report);
      expect(await store.load(A, signal())).toBeNull();
      expect(f.values.has(settingsSlotOf(A))).toBe(false); expect(f.values.get(LEGACY)).toBe(retired);
      expect(report).toHaveBeenCalledWith(expect.stringContaining("learning_poll_seconds"));
    });
  });
});
