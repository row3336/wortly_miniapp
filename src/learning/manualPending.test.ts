import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { ManualPendingStore, type ManualPending } from "./manualPending";
import { seedRaw } from "../commands/pendingSeed.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const pending = (): ManualPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: { command_id: id(3), kind: "learning.select", expected_selection_version: "9007199254740997",
    payload: { card_id: id(4), expected_pair: "ru-de" } } });
function storageWith(raw: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) seedRaw(values, "wortly.pending.manual", raw, id(1));
  const storage: AsyncStorage = {
    get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
    remove: vi.fn(async key => { values.delete(key); }),
  };
  return { storage, values, store: new ManualPendingStore(storage) };
}

describe("temporary manual intent store", () => {
  it("round-trips only the original semantic intent, scoped to its profile and client", async () => {
    const { store, values } = storageWith();
    await store.save(pending(), signal());
    expect(await store.load(id(1), signal())).toEqual(pending());
    expect(values.size).toBe(1);
    // Profile addressing (§2): the one pointer of this profile holds the record; a selection has no content payload.
    const pointer = JSON.parse([...values.values()][0]);
    expect(Object.keys(pointer)).toEqual(["schemaVersion", "record"]);
    const saved = pointer.record;
    expect(saved).toEqual(pending());
    expect(saved.intent.expected_selection_version).toBe("9007199254740997");
    expect(JSON.stringify(saved)).not.toMatch(/token|proof|document/i);
    await store.clear(pending(), signal());
    expect(values.size).toBe(0);
  });

  it("an idempotent save does not rewrite the durable record", async () => {
    const { store, storage } = storageWith();
    await store.save(pending(), signal());
    await store.save(pending(), signal());
    expect(storage.set).toHaveBeenCalledOnce();
  });

  it("preserves a confirmed mismatch and cannot downgrade it via an ordinary save", async () => {
    const { store } = storageWith();
    await store.save(pending(), signal());
    await store.markMismatch(pending(), signal());
    await expect(store.save(pending(), signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.clear(pending(), signal())).rejects.toMatchObject({ kind: "changed" });
    expect(await store.load(id(1), signal())).toEqual({ ...pending(), mismatch: true });
  });

  it("does not mark a different stored command as mismatched", async () => {
    const { store } = storageWith(JSON.stringify(pending()));
    const other = pending(); other.intent.command_id = id(99);
    await expect(store.markMismatch(other, signal())).rejects.toMatchObject({ kind: "changed" });
    expect(await store.load(id(1), signal())).toEqual(pending());
  });

  it("snapshots data before queued writes", async () => {
    const { store } = storageWith();
    const value = pending();
    const saving = store.save(value, signal());
    value.intent.payload.card_id = id(99);
    await saving;
    expect(await store.load(id(1), signal())).toEqual(pending());
  });

  it.each(["command_id", "expected_selection_version", "kind", "payload"] as const)(
    "does not overwrite or clear changed %s", async field => {
      const { store } = storageWith(JSON.stringify(pending()));
      const other = pending();
      if (field === "command_id") other.intent.command_id = id(99);
      if (field === "expected_selection_version") other.intent.expected_selection_version = "2";
      if (field === "kind") other.intent.kind = "learning.unselect";
      if (field === "payload") other.intent.payload.card_id = id(99);
      await expect(store.save(other, signal())).rejects.toMatchObject({ kind: "changed" });
      await expect(store.clear(other, signal())).rejects.toMatchObject({ kind: "changed" });
      expect(await store.load(id(1), signal())).toEqual(pending());
    });

  // §3.4: load no longer «self-cleans» another account's record — it stays under that account's own pointer.
  it("leaves the previous account's temporary record under its own pointer when the new account reads", async () => {
    const { store, values, storage } = storageWith(JSON.stringify(pending()));
    const before = [...values];
    expect(await store.load(id(9), signal())).toBeNull();
    expect([...values]).toEqual(before); expect(storage.remove).not.toHaveBeenCalled();
  });

  it.each(["{}", "null", "[1]", "broken", JSON.stringify({ ...pending(), schemaVersion: 2 }),
    JSON.stringify({ ...pending(), token: "synthetic-only" }), JSON.stringify({ ...pending(), mismatch: false }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, proof: "synthetic-only" } }),
    JSON.stringify({ ...pending(), profileId: "profile" }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, expected_selection_version: "0" } }),
  ])("does not silently discard an unreadable record %#", async raw => {
    const { store, values } = storageWith(raw);
    const before = [...values];
    await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.save(pending(), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect([...values]).toEqual(before); // the damaged pointer stays exactly as it was
  });

  it("does not start a queued write after its document was disposed", async () => {
    const { store, storage, values } = storageWith();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(storage.get).mockImplementationOnce(async () => { await gate; return null; });
    const first = store.load(id(1), signal());
    const document = new AbortController();
    const saving = store.save(pending(), document.signal);
    const assertion = expect(saving).rejects.toMatchObject({ kind: "cancelled" });
    document.abort(); release();
    await first; await assertion;
    expect(storage.set).not.toHaveBeenCalled();
    expect(values.size).toBe(0);
  });

  it("rechecks disposal after reading, before removal", async () => {
    const { store, storage, values } = storageWith(JSON.stringify(pending()));
    const document = new AbortController();
    vi.mocked(storage.get).mockImplementationOnce(async () => { document.abort(); return JSON.stringify(pending()); });
    await expect(store.load(id(9), document.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(values.size).toBe(1);
  });

  // The account change no longer cleans anything (§3.4); the slot still serializes the new account's read and save.
  it("serializes the new account's read and a following new save; the earlier account's record stays", async () => {
    const { store, storage, values } = storageWith(JSON.stringify(pending()));
    const earlier = [...values];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const base = vi.mocked(storage.get).getMockImplementation()!;
    vi.mocked(storage.get).mockImplementationOnce(async key => { await gate; return base(key); });
    const reading = store.load(id(9), signal());
    const next = { ...pending(), profileId: id(9) };
    const saving = store.save(next, signal());
    await vi.waitFor(() => expect(storage.get).toHaveBeenCalledOnce());
    expect(storage.set).not.toHaveBeenCalled();
    release(); await reading; await saving;
    expect(await store.load(id(9), signal())).toEqual(next);
    expect(earlier.every(([key, value]) => values.get(key) === value)).toBe(true);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("redacts a storage exception and allows a later retry after recovery", async () => {
    const { store, storage } = storageWith();
    vi.mocked(storage.get).mockRejectedValueOnce(new Error("synthetic-private-error"));
    const error = await store.load(id(1), signal()).catch(error => error);
    expect(error).toMatchObject({ kind: "unavailable", message: "unavailable" });
    expect(JSON.stringify(error)).not.toContain("synthetic-private-error");
    await expect(store.save(pending(), signal())).resolves.toBeUndefined();
  });
});
