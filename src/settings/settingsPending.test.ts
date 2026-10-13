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

  describe("legacy global key", () => {
    const ops = ["load", "save", "clear", "clearMarked", "markMismatch"] as const;
    const run = (store: SettingsPendingStore, op: (typeof ops)[number], profileId: string) =>
      op === "load" ? store.load(profileId, signal()) : store[op](forProfile(profileId), signal());

    it("is ignored, kept and not inherited by another profile", async () => {
      const raw = JSON.stringify(forProfile(A)); const f = make({ [LEGACY]: raw }); const store = f.build();
      expect(await store.load(B, signal())).toBeNull();
      await store.save(forProfile(B, id(4)), signal()); await store.clear(forProfile(B, id(4)), signal());
      expect(f.values.get(LEGACY)).toBe(raw);
      expect(f.storage.set).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.storage.set).mock.calls[0][0]).toBe(settingsSlotOf(B));
    });

    const legacyOf = (profileId: string, extra: object = {}) => JSON.stringify({ ...forProfile(profileId), ...extra });

    it("routes the owner's load/save/mismatch/clear through the legacy key: same IDs and status, no copy, removed only on its own clear", async () => {
      const raw = legacyOf(A); const f = make({ [LEGACY]: raw }); const store = f.build(); const a = forProfile(A);
      expect(await store.load(A, signal())).toEqual(a);
      await store.save(a, signal()); expect(f.storage.set).not.toHaveBeenCalled();
      await store.markMismatch(a, signal());
      expect(JSON.parse(f.values.get(LEGACY)!)).toEqual({ ...a, mismatch: true });
      expect(await f.build().load(A, signal())).toEqual({ ...a, mismatch: true });
      await expect(store.clear(a, signal())).rejects.toMatchObject({ kind: "changed" });
      await store.clearMarked(a, signal());
      expect(f.values.size).toBe(0);
      expect([...f.values.keys()]).not.toContain(settingsSlotOf(A));
      await store.save(a, signal());
      expect([...f.values.keys()]).toEqual([settingsSlotOf(A)]);
    });

    it("legacy X → B → X: B neither sees, changes nor removes X's record, X gets the same ID back", async () => {
      const raw = legacyOf(A); const f = make({ [LEGACY]: raw }); const store = f.build();
      expect(await store.load(A, signal())).toEqual(forProfile(A));
      expect(await store.load(B, signal())).toBeNull();
      const b = forProfile(B, id(4)); await store.save(b, signal()); await store.markMismatch(b, signal());
      await store.clearMarked(b, signal());
      expect(f.values.get(LEGACY)).toBe(raw); expect(f.storage.remove).not.toHaveBeenCalledWith(LEGACY);
      expect(await store.load(A, signal())).toEqual(forProfile(A));
    });

    it("an exact clear of a different command never removes the legacy record", async () => {
      const raw = legacyOf(A); const f = make({ [LEGACY]: raw }); const store = f.build();
      await expect(store.clear(forProfile(A, id(5)), signal())).rejects.toMatchObject({ kind: "changed" });
      await expect(store.save(forProfile(A, id(5)), signal())).rejects.toMatchObject({ kind: "changed" });
      expect(f.values.get(LEGACY)).toBe(raw);
    });

    it("an upper-case legacy owner is recognised; a lower-case caller reads it back", async () => {
      const upper = "AAAAAAAA-0000-4000-8000-00000000000A", lower = upper.toLowerCase();
      const f = make({ [LEGACY]: legacyOf(upper) }); const store = f.build();
      expect(await store.load(lower, signal())).toEqual(forProfile(lower));
      expect(await store.load(upper, signal())).toEqual(forProfile(lower));
      expect(await store.load(B, signal())).toBeNull();
      await store.clear(forProfile(upper), signal()); expect(f.values.size).toBe(0);
    });

    it("fails closed when the owner's profile key is also occupied, keeping both records", async () => {
      const legacy = legacyOf(A), own = JSON.stringify(forProfile(A, id(4)));
      const f = make({ [LEGACY]: legacy, [settingsSlotOf(A)]: own }); const store = f.build();
      for (const op of ops) await expect(run(store, op, A)).rejects.toMatchObject({ kind: "invalid" });
      await expect(store.clear(forProfile(A, id(4)), signal())).rejects.toMatchObject({ kind: "invalid" });
      expect(f.values.get(LEGACY)).toBe(legacy); expect(f.values.get(settingsSlotOf(A))).toBe(own);
      expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
      expect(await store.load(B, signal())).toBeNull();
    });

    it("fails closed when the owner's profile key is damaged and a legacy record exists", async () => {
      const f = make({ [LEGACY]: legacyOf(A), [settingsSlotOf(A)]: "broken" }); const store = f.build();
      await expect(store.load(A, signal())).rejects.toMatchObject({ kind: "invalid" });
      expect(f.storage.remove).not.toHaveBeenCalled();
    });

    it.each(["get", "set", "remove"] as const)("a failing storage %s on the legacy route is unavailable and keeps the record", async method => {
      const raw = legacyOf(A); const f = make({ [LEGACY]: raw }); const store = f.build();
      const target = method === "set" ? () => store.markMismatch(forProfile(A), signal())
        : method === "remove" ? () => store.clearMarked(forProfile(A), signal()) : () => store.load(A, signal());
      vi.mocked(f.storage[method]).mockRejectedValueOnce(new Error("private-details"));
      const error = await target().catch(error => error);
      expect(error).toMatchObject({ kind: "unavailable" }); expect(JSON.stringify(error)).not.toContain("private-details");
      expect(f.values.get(LEGACY)).toBe(raw);
      expect(await store.load(A, signal())).toEqual(forProfile(A));
    });

    it("an abort during the slot's own read on the legacy route writes and removes nothing", async () => {
      const raw = legacyOf(A);
      for (const op of ops) {
        const f = make({ [LEGACY]: raw }); const store = f.build(); const owner = new AbortController();
        let reads = 0;
        vi.mocked(f.storage.get).mockImplementation(async key => { if (key === LEGACY && ++reads === 2) owner.abort(); return f.values.get(key) ?? null; });
        await expect(op === "load" ? store.load(A, owner.signal) : store[op](forProfile(A), owner.signal)).rejects.toMatchObject({ kind: "cancelled" });
        expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled(); expect(f.values.get(LEGACY)).toBe(raw);
      }
    });

    it("a retired record under the owner's own key beside a valid legacy record: only load drops it, writes fail closed", async () => {
      const retiredOwn = JSON.stringify({ ...forProfile(A), intent: { ...pending().intent, payload: { key: "learning_poll_seconds", value: 80 } } });
      const legacy = legacyOf(A);
      const f = make({ [LEGACY]: legacy, [settingsSlotOf(A)]: retiredOwn }); const store = f.build(); const report = vi.fn();
      for (const op of ["save", "clear", "clearMarked", "markMismatch"] as const)
        await expect(run(store, op, A)).rejects.toMatchObject({ kind: "invalid" });
      expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
      const dropping = f.build(report);
      expect(await dropping.load(A, signal())).toEqual(forProfile(A));
      expect(f.values.get(LEGACY)).toBe(legacy); expect(f.values.has(settingsSlotOf(A))).toBe(false); expect(report).toHaveBeenCalledOnce();
    });

    it("one legacy key serves successive owners: X is cleared, then a record of Y appears there", async () => {
      const f = make({ [LEGACY]: legacyOf(A) }); const store = f.build();
      expect(await store.load(A, signal())).toEqual(forProfile(A)); await store.clear(forProfile(A), signal());
      expect(f.values.size).toBe(0);
      f.values.set(LEGACY, legacyOf(B, { intent: { ...pending().intent, command_id: id(4) } }));
      expect((await store.load(B, signal()))?.intent.command_id).toBe(id(4));
      expect(await store.load(A, signal())).toBeNull();
      await store.clear(forProfile(B, id(4)), signal()); expect(f.values.size).toBe(0);
    });

    it("calls for one profile share a chain whatever the ID spelling, even when the first read is slow", async () => {
      const upper = "AAAAAAAA-0000-4000-8000-00000000000A", lower = upper.toLowerCase();
      const f = make(); const store = f.build(); let slow = true;
      vi.mocked(f.storage.get).mockImplementation(async key => {
        if (slow) { slow = false; await new Promise(resolve => setTimeout(resolve, 30)); }
        return f.values.get(key) ?? null;
      });
      await Promise.all([store.save(forProfile(upper), signal()), store.clear(forProfile(lower), signal())]);
      expect(f.values.size).toBe(0);
    });

    describe("a stale route (second window) never recreates the legacy key or fills both slots", () => {
      /** Window 2 chooses its route, then parks on its slot's own read while `meanwhile` runs through window 1. */
      async function race(op: "save" | "markMismatch", meanwhile: (first: SettingsPendingStore) => Promise<void>) {
        const f = make({ [LEGACY]: legacyOf(A) });
        const other: AsyncStorage = { get: vi.fn(async key => { reads++; if (reads === 3) await gate; return f.values.get(key) ?? null; }),
          set: f.storage.set, remove: f.storage.remove };
        let reads = 0; let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
        const second = new SettingsPendingStore(other); const task = second[op](forProfile(A), signal()).catch(error => error);
        await vi.waitFor(() => expect(reads).toBe(3));
        await meanwhile(f.build()); open();
        return { f, error: await task };
      }

      it("R-a: window 1 cleared the legacy record", async () => {
        const { f, error } = await race("save", first => first.clear(forProfile(A), signal()));
        expect(error).toMatchObject({ kind: "changed" }); expect(f.values.size).toBe(0);
      });
      it("R-b: window 1 cleared it and saved a new record under the profile key", async () => {
        const next = forProfile(A, id(4));
        const { f, error } = await race("save", async first => { await first.clear(forProfile(A), signal()); await first.save(next, signal()); });
        expect(error).toMatchObject({ kind: "changed" });
        expect([...f.values.keys()]).toEqual([settingsSlotOf(A)]); expect(JSON.parse(f.values.get(settingsSlotOf(A))!)).toEqual(next);
      });
      it("R-b for markMismatch: the new profile record is not overwritten and the legacy key stays gone", async () => {
        const next = forProfile(A, id(4));
        const { f, error } = await race("markMismatch", async first => { await first.clear(forProfile(A), signal()); await first.save(next, signal()); });
        expect(error).toMatchObject({ kind: "changed" });
        expect([...f.values.keys()]).toEqual([settingsSlotOf(A)]); expect(JSON.parse(f.values.get(settingsSlotOf(A))!)).toEqual(next);
      });
      it("a profile-key write is refused when a legacy record of the same profile appeared after the route was chosen", async () => {
        const f = make(); let reads = 0; let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
        const other: AsyncStorage = { get: vi.fn(async key => { reads++; if (reads === 3) await gate; return f.values.get(key) ?? null; }),
          set: f.storage.set, remove: f.storage.remove };
        const task = new SettingsPendingStore(other).save(forProfile(A), signal()).catch(error => error);
        await vi.waitFor(() => expect(reads).toBe(3));
        f.values.set(LEGACY, legacyOf(A, { intent: { ...pending().intent, command_id: id(4) } })); open();
        expect(await task).toMatchObject({ kind: "changed" });
        expect([...f.values.keys()]).toEqual([LEGACY]);
      });
    });

    it("two stores over one storage (two windows) never lose the legacy record or invent an ID", async () => {
      const raw = legacyOf(A); const f = make({ [LEGACY]: raw }); const first = f.build(), second = f.build();
      const [one, two] = await Promise.all([first.load(A, signal()), second.load(A, signal())]);
      expect(one).toEqual(forProfile(A)); expect(two).toEqual(forProfile(A));
      await Promise.all([first.markMismatch(forProfile(A), signal()), second.markMismatch(forProfile(A), signal())]);
      expect(JSON.parse(f.values.get(LEGACY)!)).toEqual({ ...forProfile(A), mismatch: true });
      expect(f.values.size).toBe(1);
    });

    it.each(["broken", "[]", JSON.stringify({ ...pending(), token: "x" }), JSON.stringify({ ...pending(), profileId: "bad" })])(
      "a damaged legacy record %# has no known owner: it blocks every profile and is kept", async raw => {
        const f = make({ [LEGACY]: raw }); const store = f.build();
        for (const profileId of [A, B]) for (const op of ops) await expect(run(store, op, profileId)).rejects.toMatchObject({ kind: "invalid" });
        expect(f.values.get(LEGACY)).toBe(raw); expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
      });

    const retired = (profileId: string) => JSON.stringify({ ...forProfile(profileId),
      intent: { ...pending().intent, payload: { key: "learning_poll_seconds", value: 80 } } });

    it("drops a retired legacy save for its own profile only, with a key-name-only record", async () => {
      const f = make({ [LEGACY]: retired(A) }); const report = vi.fn(); const store = f.build(report);
      expect(await store.load(B, signal())).toBeNull();
      expect(f.values.get(LEGACY)).toBe(retired(A)); expect(report).not.toHaveBeenCalled();
      expect(await store.load(A, signal())).toBeNull();
      expect(f.values.has(LEGACY)).toBe(false);
      expect(report).toHaveBeenCalledOnce(); expect(report.mock.calls[0][0]).toContain("learning_poll_seconds");
      expect(report.mock.calls[0][0]).not.toMatch(/80|token|proof/);
    });

    it("refuses writes while its own retired legacy save is still present instead of removing it silently", async () => {
      const f = make({ [LEGACY]: retired(A) }); const store = f.build();
      await expect(store.save(forProfile(A), signal())).rejects.toMatchObject({ kind: "invalid" });
      expect(f.values.get(LEGACY)).toBe(retired(A)); expect(f.storage.remove).not.toHaveBeenCalled();
    });
  });

  it("runs the calls of one profile in call order even when the guard's reads finish out of order", async () => {
    const f = make(); const store = f.build(); const a = forProfile(A);
    let slow = true;
    vi.mocked(f.storage.get).mockImplementation(async key => {
      if (slow) { slow = false; await new Promise(resolve => setTimeout(resolve, 30)); }
      return f.values.get(key) ?? null;
    });
    await Promise.all([store.save(a, signal()), store.clear(a, signal())]);
    expect(f.values.size).toBe(0);
    slow = true;
    await Promise.all([store.save(a, signal()), store.markMismatch(a, signal()), store.clear({ ...a, mismatch: true }, signal())]);
    expect(f.values.size).toBe(0);
  });

  it("a failed call does not poison the next call of the same profile", async () => {
    const f = make(); const store = f.build();
    vi.mocked(f.storage.get).mockRejectedValueOnce(new Error("x"));
    const failing = store.save(forProfile(A), signal()); const next = store.save(forProfile(A), signal());
    await expect(failing).rejects.toMatchObject({ kind: "unavailable" }); await next;
    expect(await store.load(A, signal())).toEqual(forProfile(A));
  });

  describe("the signal of a call is checked again after the recheck of the route, right before the write", () => {
    const routes = [
      { name: "profile", seed: (a: SettingsPending) => ({ [settingsSlotOf(A)]: JSON.stringify(a) }), key: settingsSlotOf(A) },
      { name: "legacy", seed: (a: SettingsPending) => ({ [LEGACY]: JSON.stringify(a) }), key: LEGACY },
    ];
    // Reads of one call: 1 own key, 2 legacy key, 3 the slot's own read, 4 and 5 the recheck before `set`.
    const cases = routes.flatMap(route => ([4, 5] as const).flatMap(nth => (["save", "markMismatch"] as const).map(op => ({ route, nth, op }))))
      // a legacy-route `save` of the stored record is a no-op that never reaches `set`
      .filter(({ route, op }) => !(route.name === "legacy" && op === "save"));
    it.each(cases)("$route.name route, $op, abort on get #$nth: cancelled, nothing written or removed", async ({ route, nth, op }) => {
      const a = forProfile(A);
      // `save` reaches `set` only on an empty profile slot; `markMismatch` rewrites the stored record.
      const seeded = op === "save" ? {} : route.seed(a);
      const f = make(seeded); const before = new Map(f.values); const store = f.build(); const owner = new AbortController();
      let reads = 0;
      vi.mocked(f.storage.get).mockImplementation(async key => { if (++reads === nth) owner.abort(); return f.values.get(key) ?? null; });
      await expect(store[op](a, owner.signal)).rejects.toMatchObject({ kind: "cancelled" });
      expect(reads).toBeGreaterThanOrEqual(nth);
      expect(f.storage.set).not.toHaveBeenCalled(); expect(f.storage.remove).not.toHaveBeenCalled();
      expect(new Map(f.values)).toEqual(before);
      // the profile chain still works for the next call
      vi.mocked(f.storage.get).mockImplementation(async key => f.values.get(key) ?? null);
      await store.markMismatch(a, signal());
      expect(JSON.parse(f.values.get(route.key)!)).toEqual({ ...a, mismatch: true });
    });

    it.each([4, 5])("a storage failure on get #%i of the recheck is unavailable and writes nothing", async nth => {
      const f = make(); const store = f.build(); let reads = 0;
      vi.mocked(f.storage.get).mockImplementation(async key => {
        if (++reads === nth) throw new Error("private-details");
        return f.values.get(key) ?? null;
      });
      const error = await store.save(forProfile(A), signal()).catch(error => error);
      expect(error).toMatchObject({ kind: "unavailable" }); expect(JSON.stringify(error)).not.toContain("private-details");
      expect(f.storage.set).not.toHaveBeenCalled(); expect(f.values.size).toBe(0);
    });

    it("a later call is not cancelled by an earlier call's aborted signal", async () => {
      const f = make(); const store = f.build(); const first = new AbortController();
      const one = store.save(forProfile(A), first.signal).catch(error => error); first.abort();
      const two = store.save(forProfile(A), signal());
      expect(await one).toMatchObject({ kind: "cancelled" }); await two;
      expect(JSON.parse(f.values.get(settingsSlotOf(A))!)).toEqual(forProfile(A));
    });
  });

  it("keeps a damaged own record and does not turn it into an empty slot", async () => {
    const f = make({ [settingsSlotOf(A)]: "broken" }); const store = f.build();
    await expect(store.load(A, signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.save(forProfile(A), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(await store.load(B, signal())).toBeNull();
    expect(f.values.get(settingsSlotOf(A))).toBe("broken"); expect(f.storage.remove).not.toHaveBeenCalled();
  });

  it.each(["get", "set", "remove"] as const)("turns a failing storage %s into an unavailable store and keeps A's record", async method => {
    const f = make(); const store = f.build(); await store.save(forProfile(A), signal());
    const before = f.values.get(settingsSlotOf(A));
    const target = method === "set" ? store.save(forProfile(B), signal())
      : method === "remove" ? store.clear(forProfile(A), signal()) : store.load(B, signal());
    vi.mocked(f.storage[method]).mockRejectedValueOnce(new Error("private-details"));
    const error = await target.catch(error => error);
    expect(error).toMatchObject({ kind: "unavailable" }); expect(JSON.stringify(error)).not.toContain("private-details");
    expect(f.values.get(settingsSlotOf(A))).toBe(before);
    expect(await store.load(A, signal())).toEqual(forProfile(A));
  });

  it("neither reads past nor writes after a cancelled signal", async () => {
    const f = make(); const store = f.build(); await store.save(forProfile(A), signal());
    const owner = new AbortController(); owner.abort();
    for (const call of [() => store.load(B, owner.signal), () => store.save(forProfile(B), owner.signal)])
      await expect(call()).rejects.toMatchObject({ kind: "cancelled" });
    expect([...f.values.keys()]).toEqual([settingsSlotOf(A)]);
  });
});
