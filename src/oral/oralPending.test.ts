import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import type { OralIntent } from "./oralIntent";
import { OralSessionPendingStore, OralStopPendingStore, type OralPending } from "./oralPending";
import { pendingRaw, hasPending, seedRaw, pointerKeyOf } from "../commands/pendingSeed.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const studyKey = "wortly.pending.oral_session", stopKey = "wortly.pending.oral_stop";
const signal = () => new AbortController().signal;
const address = { command_id: id(3), session_id: id(4) };
const intents: OralIntent[] = [
  { ...address, kind: "session.start", payload: { mode: "oral", bucket: "words" } },
  { ...address, kind: "assignment.present", assignment_id: id(5), payload: {} },
  { ...address, kind: "oral.reveal", assignment_id: id(5), payload: {} },
  { ...address, kind: "oral.grade", assignment_id: id(5), payload: { correct: false } },
  { ...address, kind: "session.stop", payload: { reason: "stop" } },
  { ...address, kind: "session.stop", payload: { reason: "summary_home" } },
];
const pending = (intent = intents[0]): OralPending => ({ schemaVersion: 1, profileId: id(1),
  clientInstanceId: id(2), pair: "ru-de", intent: structuredClone(intent) });
function fixture() {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  return { values, storage, study: new OralSessionPendingStore(storage), stop: new OralStopPendingStore(storage) };
}

describe("oral durable pending lanes", () => {
  it.each(intents)("retains exact $kind intent in its own lane across restart", async intent => {
    const f = fixture(), value = pending(intent), stop = intent.kind === "session.stop";
    const store = stop ? f.stop : f.study, key = stop ? stopKey : studyKey;
    await store.save(value, signal());
    const restarted = stop ? new OralStopPendingStore(f.storage) : new OralSessionPendingStore(f.storage);
    expect(await restarted.load(id(1), signal())).toEqual(value);
    // The pointer of this profile holds service data only; a self-assessment (oral.grade) is content in its payload (C467).
    const pointer = f.values.get(pointerKeyOf(key, id(1)))!;
    expect(pointer).not.toMatch(/token|proof|document|text|translation|answer/);
    const payloadKey = JSON.parse(pointer).payloadKey as string | undefined;
    expect(payloadKey !== undefined).toBe(intent.kind === "oral.grade");
    if (payloadKey) expect(f.values.get(payloadKey)).not.toMatch(/token|proof|document|text|translation|answer/);
    await restarted.clear(value, signal()); expect(hasPending(f.values, key)).toBe(false);
    expect([...f.values.keys()].some(name => name.startsWith("wortly.payload."))).toBe(false);
  });
  it("keeps study and Stop independent, including mismatch", async () => {
    const f = fixture(), study = pending(intents[3]), stop = pending(intents[4]);
    await f.study.save(study, signal()); await f.stop.save(stop, signal());
    await f.study.markMismatch(study, signal()); await f.stop.clear(stop, signal());
    expect(await f.study.load(id(1), signal())).toEqual({ ...study, mismatch: true });
    expect(hasPending(f.values, stopKey)).toBe(false);
    await expect(f.study.save(stop, signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(f.stop.save(study, signal())).rejects.toMatchObject({ kind: "invalid" });
    seedRaw(f.values, stopKey, JSON.stringify(study), id(1));
    await expect(f.stop.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
  });
  it("canonicalizes order and detaches input before the first storage wait", async () => {
    const f = fixture(), value = pending(intents[3]);
    const saving = f.study.save(value, signal());
    value.intent.command_id = id(99); Object.assign(value.intent.payload, { correct: true, proof: "synthetic" });
    await saving;
    const original = pending(intents[3]);
    original.intent = { payload: { correct: false }, assignment_id: id(5), kind: "oral.grade", session_id: id(4), command_id: id(3) };
    // The first save wrote the payload of the self-assessment and then the pointer; a repeat of the same command writes nothing.
    const writes = vi.mocked(f.storage.set).mock.calls.length; expect(writes).toBe(2);
    await f.study.save(original, signal()); expect(f.storage.set).toHaveBeenCalledTimes(writes);
    const loaded = (await f.study.load(id(1), signal()))!; loaded.intent.session_id = id(99);
    expect(await f.study.load(id(1), signal())).toEqual(pending(intents[3]));
    await f.study.clear(original, signal());
  });
  it.each(["command", "session", "assignment", "payload", "client", "pair"])("protects exact %s against save, clear and mismatch", async field => {
    const f = fixture(), original = pending(intents[3]), changed = pending(intents[3]);
    if (field === "command") changed.intent.command_id = id(99);
    if (field === "session") changed.intent.session_id = id(99);
    if (field === "assignment") Object.assign(changed.intent, { assignment_id: id(99) });
    if (field === "payload") Object.assign(changed.intent.payload, { correct: true });
    if (field === "client") changed.clientInstanceId = id(99);
    if (field === "pair") changed.pair = "en-de";
    await f.study.save(original, signal());
    for (const operation of ["save", "clear", "markMismatch"] as const) {
      await expect(f.study[operation](changed, signal())).rejects.toMatchObject({ kind: "changed" });
    }
    expect(await f.study.load(id(1), signal())).toEqual(original);
  });
  it("persists mismatch across restart and refuses unmarked cleanup", async () => {
    const f = fixture(), value = pending(intents[2]);
    await f.study.save(value, signal()); await f.study.markMismatch(value, signal());
    expect(await new OralSessionPendingStore(f.storage).load(id(1), signal())).toEqual({ ...value, mismatch: true });
    await expect(f.study.clear(value, signal())).rejects.toMatchObject({ kind: "changed" });
  });
  const invalid: unknown[] = ["broken", "null", "[]", { ...pending(), schemaVersion: 2 },
    { ...pending(), token: "synthetic" }, { ...pending(), proof: "synthetic" }, { ...pending(), document_id: id(9) },
    { ...pending(), mismatch: false }, { ...pending(), pair: "de-ru" },
    { ...pending(), intent: { ...intents[0], document_id: id(9) } },
    { ...pending(), intent: { ...intents[3], payload: { correct: true, text: "synthetic" } } },
    { ...pending(), intent: { ...intents[0], payload: { mode: "learning" } } }];
  it.each(invalid)("blocks corrupted or extended data without treating it as empty %#", async input => {
    const f = fixture(), raw = typeof input === "string" ? input : JSON.stringify(input);
    seedRaw(f.values, studyKey, raw, id(1));
    await expect(f.study.load(id(1), signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(f.study.save(pending(), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(pendingRaw(f.values, studyKey)).toBe(raw); expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("inherits scoped account cleanup without touching Stop", async () => {
    const f = fixture(); await f.study.save(pending(), signal()); await f.stop.save(pending(intents[4]), signal());
    expect(await f.study.load(id(99), signal())).toBeNull();
    expect(await f.stop.load(id(1), signal())).toEqual(pending(intents[4]));
  });
  it("serializes shared owners, rejects a competing UUID and stops writes after disposal", async () => {
    const f = fixture(), other = pending(); other.intent.command_id = id(99);
    const results = await Promise.allSettled([f.study.save(pending(), signal()), f.study.save(other, signal())]);
    expect(results[0].status).toBe("fulfilled"); expect(results[1]).toMatchObject({ status: "rejected", reason: { kind: "changed" } });
    const lifetime = new AbortController();
    vi.mocked(f.storage.get).mockImplementationOnce(async () => { lifetime.abort(); return null; });
    await expect(f.stop.save(pending(intents[4]), lifetime.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(hasPending(f.values, stopKey)).toBe(false);
  });
  it("reports storage failures without exposing details or losing the original intent", async () => {
    const f = fixture(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("synthetic detail"));
    await expect(f.study.save(pending(), signal())).rejects.toMatchObject({ kind: "unavailable", message: "unavailable" });
    await f.study.save(pending(), signal());
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("synthetic detail"));
    await expect(f.study.clear(pending(), signal())).rejects.toMatchObject({ kind: "unavailable" });
    expect(await f.study.load(id(1), signal())).toEqual(pending());
  });
});
