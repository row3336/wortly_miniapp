import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import type { LearningSessionIntent } from "./learningSessionIntent";
import { LearningSessionPendingStore, type LearningSessionPending } from "./learningSessionPending";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const key = "wortly.pending.learning_session";
const signal = () => new AbortController().signal;
const address = { command_id: id(3), session_id: id(4) };
const intents: LearningSessionIntent[] = [
  { ...address, kind: "session.start", payload: { mode: "learning" } },
  { ...address, kind: "learning.preview_next", preview_id: id(5), payload: {} },
  { ...address, kind: "learning.known", preview_id: id(5), payload: {} },
  { ...address, kind: "assignment.present", assignment_id: id(6), payload: {} },
  { ...address, kind: "session.stop", payload: { reason: "stop" } },
  { ...address, kind: "session.stop", payload: { reason: "summary_home" } },
];
const pending = (intent = intents[0]): LearningSessionPending => ({ schemaVersion: 1, profileId: id(1),
  clientInstanceId: id(2), pair: "ru-de", intent: structuredClone(intent) });
function setup(raw: string | null = null) {
  const values = new Map<string, string>();
  if (raw !== null) values.set(key, raw);
  const storage: AsyncStorage = { get: vi.fn(async name => values.get(name) ?? null),
    set: vi.fn(async (name, value) => { values.set(name, value); }), remove: vi.fn(async name => { values.delete(name); }) };
  return { values, storage, store: new LearningSessionPendingStore(storage) };
}

describe("durable Learning transition intent", () => {
  it.each(intents)("retains $kind exactly across restart, without document or credentials", async intent => {
    const f = setup(), value = pending(intent);
    await f.store.save(value, signal());
    const resumed = new LearningSessionPendingStore(f.storage);
    expect(await resumed.load(id(1), signal())).toEqual(value);
    expect(f.values.get(key)).not.toMatch(/token|proof|document|draft/);
    await resumed.clear(value, signal());
    expect(await f.store.load(id(1), signal())).toBeNull();
  });

  it("canonicalizes equivalent property order without rewriting the pending command", async () => {
    const f = setup(); await f.store.save(pending(), signal());
    const value = pending();
    value.intent = { payload: { mode: "learning" }, kind: "session.start", session_id: id(4), command_id: id(3) };
    await f.store.save(value, signal());
    expect(f.storage.set).toHaveBeenCalledOnce();
    await f.store.clear(value, signal());
    expect(f.values.has(key)).toBe(false);
  });

  it("copies before storage awaits and returns detached data to callers", async () => {
    const f = setup(), value = pending(intents[1]);
    const saving = f.store.save(value, signal());
    value.intent.command_id = id(99); Object.assign(value.intent.payload, { secret: "not-persisted" });
    await saving;
    const loaded = (await f.store.load(id(1), signal()))!;
    expect(loaded).toEqual(pending(intents[1])); loaded.intent.session_id = id(99);
    expect(await f.store.load(id(1), signal())).toEqual(pending(intents[1]));
    expect(f.values.get(key)).not.toContain("not-persisted");
  });

  it.each(["session", "command", "client", "pair", "kind", "preview"])(
    "cannot overwrite, clear or mark a different %s", async change => {
      const original = pending(intents[1]), f = setup(JSON.stringify(original)), value = structuredClone(original);
      if (change === "session") value.intent.session_id = id(99);
      if (change === "command") value.intent.command_id = id(99);
      if (change === "client") value.clientInstanceId = id(99);
      if (change === "pair") value.pair = "en-de";
      if (change === "kind") value.intent = { ...address, kind: "learning.known", preview_id: id(5), payload: {} };
      if (change === "preview") Object.assign(value.intent, { preview_id: id(99) });
      for (const operation of ["save", "clear", "markMismatch"] as const) {
        await expect(f.store[operation](value, signal())).rejects.toMatchObject({ kind: "changed" });
      }
      expect(await f.store.load(id(1), signal())).toEqual(original);
    });

  it("persists mismatch across restart and prevents older unmarked cleanup", async () => {
    const f = setup(), value = pending(intents[2]);
    await f.store.save(value, signal()); await f.store.markMismatch(value, signal());
    const restored = new LearningSessionPendingStore(f.storage);
    expect(await restored.load(id(1), signal())).toEqual({ ...value, mismatch: true });
    await expect(restored.clear(value, signal())).rejects.toMatchObject({ kind: "changed" });
  });

  const invalid = ["broken", "null", "[]", { ...pending(), schemaVersion: 2 },
    { ...pending(), pair: "de-ru" }, { ...pending(), clientInstanceId: "current" },
    { ...pending(), token: "synthetic" }, { ...pending(), proof: "synthetic" },
    { ...pending(), documentId: id(9) }, { ...pending(), mismatch: false },
    { ...pending(), intent: { ...intents[0], document_id: id(9) } },
    { ...pending(), intent: { ...intents[0], client_instance_id: id(2) } },
    { ...pending(), intent: { ...intents[0], payload: { mode: "learning", count: 3 } } },
    { ...pending(), intent: { ...intents[1], assignment_id: id(9) } },
    { ...pending(), intent: { ...intents[1], preview_id: null } },
    { ...pending(), intent: { ...intents[4], payload: { reason: "midnight" } } },
    { ...pending(), intent: { ...intents[0], kind: "answer.submit", payload: { text: "synthetic" } } },
  ];
  it.each(invalid)("does not interpret damaged/secret-bearing pending as an empty slot %#", async input => {
    const raw = typeof input === "string" ? input : JSON.stringify(input), f = setup(raw);
    await expect(f.store.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(f.store.save(pending(), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(f.values.get(key)).toBe(raw); expect(f.storage.remove).not.toHaveBeenCalled();
  });

  it("account change clears only this account's pending slot", async () => {
    const f = setup(JSON.stringify(pending())); f.values.set("wortly.pending.remote_stop", "unrelated");
    expect(await f.store.load(id(99), signal())).toBeNull();
    expect([...f.values]).toEqual([["wortly.pending.remote_stop", "unrelated"]]);
  });
  it("a changed pair remains part of the original intent until the controller reconciles it", async () => {
    const original = { ...pending(), pair: "en-de" as const }, f = setup(JSON.stringify(original));
    expect(await f.store.load(id(1), signal())).toEqual(original);
    expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("serializes concurrent saves and never replaces an unresolved ID", async () => {
    const f = setup(), second = pending(); second.intent.command_id = id(99);
    const results = await Promise.allSettled([f.store.save(pending(), signal()), f.store.save(second, signal())]);
    expect(results[0].status).toBe("fulfilled"); expect(results[1]).toMatchObject({ status: "rejected", reason: { kind: "changed" } });
    expect(await f.store.load(id(1), signal())).toEqual(pending());
  });
  it("disposal during read prevents a new storage write", async () => {
    const f = setup(), lifetime = new AbortController();
    vi.mocked(f.storage.get).mockImplementationOnce(async () => { lifetime.abort(); return null; });
    await expect(f.store.save(pending(), lifetime.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(f.storage.set).not.toHaveBeenCalled();
  });
  it("a failed save reports failure without changing the original ID for the next attempt", async () => {
    const f = setup(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("synthetic private detail"));
    await expect(f.store.save(pending(), signal())).rejects.toMatchObject({ kind: "unavailable", message: "unavailable" });
    expect(await f.store.load(id(1), signal())).toBeNull();
    await f.store.save(pending(), signal()); expect(await f.store.load(id(1), signal())).toEqual(pending());
  });
  it("a failed clear preserves the original pending command", async () => {
    const f = setup(JSON.stringify(pending())); vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("synthetic failure"));
    await expect(f.store.clear(pending(), signal())).rejects.toMatchObject({ kind: "unavailable" });
    expect(await f.store.load(id(1), signal())).toEqual(pending());
  });
});
