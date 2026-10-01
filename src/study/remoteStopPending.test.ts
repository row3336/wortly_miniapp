import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { RemoteStopPendingStore, type RemoteStopPending } from "./remoteStopPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const pending = (): RemoteStopPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: { command_id: id(3), kind: "session.stop_remote", session_id: id(4), payload: { confirmed: true } } });
function setup(raw: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set("wortly.pending.remote_stop", raw);
  const storage: AsyncStorage = {
    get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
    remove: vi.fn(async key => { values.delete(key); }),
  };
  return { values, storage, store: new RemoteStopPendingStore(storage) };
}

describe("remote stop recovery intent", () => {
  it("retains the exact confirmed target across recreation without credentials", async () => {
    const { store, storage, values } = setup();
    const value = pending();
    await store.save(value, signal());
    await store.save(structuredClone(value), signal());
    expect(storage.set).toHaveBeenCalledOnce();
    expect([...values.values()][0]).not.toMatch(/token|proof|document|draft/);
    const resumed = new RemoteStopPendingStore(storage);
    expect(await resumed.load(id(1), signal())).toEqual(value);
    await resumed.clear(value, signal());
    expect(await store.load(id(1), signal())).toBeNull();
  });

  it("isolates the stored target from caller and UI mutations", async () => {
    const { store } = setup(); const value = pending();
    const saving = store.save(value, signal());
    value.intent.session_id = id(99);
    await saving;
    const loaded = (await store.load(id(1), signal()))!;
    expect(loaded).toEqual(pending());
    loaded.intent.session_id = id(88);
    expect(await store.load(id(1), signal())).toEqual(pending());
  });

  it.each(["target", "command", "client"])("cannot overwrite or clear a different %s", async (change) => {
    const { store } = setup(JSON.stringify(pending()));
    const value = pending();
    if (change === "target") value.intent.session_id = id(99);
    if (change === "command") value.intent.command_id = id(99);
    if (change === "client") value.clientInstanceId = id(99);
    await expect(store.save(value, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.clear(value, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.markMismatch(value, signal())).rejects.toMatchObject({ kind: "changed" });
    expect(await store.load(id(1), signal())).toEqual(pending());
  });

  it("preserves the mismatch marker and rejects an older unmarked cleanup", async () => {
    const { store, storage } = setup(); const value = pending();
    await store.save(value, signal());
    await store.markMismatch(value, signal());
    const resumed = new RemoteStopPendingStore(storage);
    expect(await resumed.load(id(1), signal())).toEqual({ ...value, mismatch: true });
    await expect(store.clear(value, signal())).rejects.toMatchObject({ kind: "changed" });
  });

  it.each([
    "broken", "null", "[]", JSON.stringify({ ...pending(), schemaVersion: 2 }),
    JSON.stringify({ ...pending(), token: "synthetic" }), JSON.stringify({ ...pending(), proof: "synthetic" }),
    JSON.stringify({ ...pending(), documentId: id(9) }), JSON.stringify({ ...pending(), mismatch: false }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, proof: "synthetic" } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, session_id: "current" } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, payload: { confirmed: false } } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, payload: { confirmed: 1 } } }),
    JSON.stringify({ ...pending(), intent: { ...pending().intent, payload: { confirmed: true, proof: "synthetic" } } }),
  ])("does not mistake damaged or secret-bearing data for an empty slot %#", async (raw) => {
    const { store, values } = setup(raw);
    await expect(store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(store.save(pending(), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect([...values.values()]).toEqual([raw]);
  });

  it("removes only the old account's remote intent when the account changes", async () => {
    const { store, values } = setup(JSON.stringify(pending()));
    values.set("wortly.pending.setting", "unrelated");
    expect(await store.load(id(99), signal())).toBeNull();
    expect([...values.entries()]).toEqual([["wortly.pending.setting", "unrelated"]]);
  });

  it("does not write after Entry disposal during a pending read", async () => {
    const { store, storage } = setup(); const owner = new AbortController();
    vi.mocked(storage.get).mockImplementationOnce(async () => { owner.abort(); return null; });
    await expect(store.save(pending(), owner.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("a failed save stays failed and can be retried without losing the original target", async () => {
    const { store, storage } = setup();
    vi.mocked(storage.set).mockRejectedValueOnce(new Error("synthetic detail"));
    await expect(store.save(pending(), signal())).rejects.toMatchObject({ kind: "unavailable", message: "unavailable" });
    expect(await store.load(id(1), signal())).toBeNull();
    await store.save(pending(), signal());
    expect(await store.load(id(1), signal())).toEqual(pending());
  });
});
