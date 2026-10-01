import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { ManualPendingStore, type ManualPending } from "./manualPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const pending = (): ManualPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: { command_id: id(3), kind: "learning.select", expected_selection_version: "9007199254740997",
    payload: { card_id: id(4), expected_pair: "ru-de" } } });
function storageWith(raw: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set("wortly.pending.manual", raw);
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
    const saved = JSON.parse([...values.values()][0]);
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

  it("removes the previous account's temporary record before using the new account", async () => {
    const { store, values } = storageWith(JSON.stringify(pending()));
    expect(await store.load(id(9), signal())).toBeNull();
    expect(values.size).toBe(0);
  });

  it.each(["{}", "null", "[1]", "broken", JSON.stringify({ ...pending(), schemaVersion: 2 }),
    JSON.stringify({ ...pending(), token: "synthetic-only" }), JSON.stringify({ ...pending(), mismatch: false }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, proof: "synthetic-only" } }),
    JSON.stringify({ ...pending(), profileId: "profile" }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, expected_selection_version: "0" } }),
  ])("does not silently discard an unreadable record %#", async raw => {
    const { store, values } = storageWith(raw);
    await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.save(pending(), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect([...values.values()]).toEqual([raw]);
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

  it("serializes account cleanup and a following new save", async () => {
    const { store, storage, values } = storageWith(JSON.stringify(pending()));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(storage.remove).mockImplementationOnce(async key => { await gate; values.delete(key); });
    const cleaning = store.load(id(9), signal());
    const next = { ...pending(), profileId: id(9) };
    const saving = store.save(next, signal());
    await vi.waitFor(() => expect(storage.remove).toHaveBeenCalledOnce());
    expect(storage.set).not.toHaveBeenCalled();
    release(); await cleaning; await saving;
    expect(await store.load(id(9), signal())).toEqual(next);
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
