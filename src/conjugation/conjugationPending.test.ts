import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { PendingStoreError } from "../commands/pendingSlot";
import type { ConjugationIntent } from "./conjugationIntent";
import { canonicalConjugationIntent, ConjugationCatalogPendingStore, ConjugationSessionPendingStore,
  ConjugationStopPendingStore, validConjugationPending, type ConjugationPending } from "./conjugationPending";
import { pendingRaw, seedRaw } from "../commands/pendingSeed.test-support";
import { payloadKeyOf, pointerKeyOf } from "../commands/pendingSlot";

const id = (n: number) => `aaaaaaaa-bbbb-4000-8000-${String(n).padStart(12, "0")}`;
const signal = () => new AbortController().signal;
const intents: ConjugationIntent[] = [
  { command_id: id(1), kind: "conjugation.schedule", payload: { base_verb_id: id(7), tense: "present" } },
  { command_id: id(2), kind: "answer.submit", session_id: id(3), assignment_id: id(4), payload: { text: "  ä\né🙂  " } },
  { command_id: id(5), kind: "session.stop", session_id: id(3), payload: { reason: "stop" } },
];
function pending(intent = intents[1]): ConjugationPending {
  return { schemaVersion: 1, profileId: id(90), clientInstanceId: id(91), pair: "ru-de", intent };
}
function fixture() {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  return { values, storage, stores: [new ConjugationCatalogPendingStore(storage), new ConjugationSessionPendingStore(storage), new ConjugationStopPendingStore(storage)] };
}

describe("conjugation durable slots through the public store Interface", () => {
  it("uses three independent namespaces and refuses cross-lane commands", async () => {
    const f = fixture();
    for (const [i, store] of f.stores.entries()) {
      await store.save(pending(intents[i]), signal());
      await expect(store.save(pending(intents[(i + 1) % 3]), signal())).rejects.toMatchObject({ kind: "invalid" });
    }
    // Profile addressing (§2): one pointer per lane of this profile; the answer's content apart in its write-once payload.
    expect([...f.values.keys()].sort()).toEqual([pointerKeyOf("wortly.pending.conjugation_catalog", id(90)),
      payloadKeyOf("wortly.pending.conjugation_session", id(90), id(2)), pointerKeyOf("wortly.pending.conjugation_session", id(90)),
      pointerKeyOf("wortly.pending.conjugation_stop", id(90))].sort());
    await f.stores[2].clear(pending(intents[2]), signal());
    expect(f.values.size).toBe(3);
  });
  it("canonicalizes order and UUID case before exact guards without altering answer text", async () => {
    const f = fixture(), p = pending();
    const raw = { intent: { payload: { text: "  ä\né🙂  " }, assignment_id: id(4).toUpperCase(), session_id: id(3).toUpperCase(),
      kind: "answer.submit", command_id: id(2).toUpperCase() }, pair: "ru-de", clientInstanceId: id(91).toUpperCase(), profileId: id(90).toUpperCase(), schemaVersion: 1 };
    // The slot stores only the canonical record (§3.2, the pointer comparator): a non-canonical intent is canonicalized by
    // save; the same record then reads back under the profile's UUID in any case, and a repeat writes nothing.
    await f.stores[1].save(raw as unknown as ConjugationPending, signal());
    expect(await f.stores[1].load(id(90).toUpperCase(), signal())).toEqual(p);
    vi.mocked(f.storage.set).mockClear();
    await f.stores[1].save(p, signal()); expect(f.storage.set).not.toHaveBeenCalled();
    await f.stores[1].clear(p, signal()); expect(f.values.size).toBe(0);
  });
  it("returns detached payloads and persists only whitelisted fields", async () => {
    const f = fixture(), p = pending(); await f.stores[1].save(p, signal());
    const savedText = (p.intent as { payload: { text: string } }).payload.text;
    Object.assign(p.intent.payload, { text: "changed" });
    const loaded = await f.stores[1].load(id(90), signal()); Object.assign(loaded!.intent.payload, { text: "mutated snapshot" });
    expect((await f.stores[1].load(id(90), signal()))!.intent.payload).toEqual({ text: "  ä\né🙂  " });
    const pointer = JSON.parse(f.values.get(pointerKeyOf("wortly.pending.conjugation_session", id(90)))!);
    expect(Object.keys(pointer)).toEqual(["schemaVersion", "record", "payloadKey"]);
    expect(Object.keys(pointer.record)).toEqual(["schemaVersion", "profileId", "clientInstanceId", "pair", "intent"]);
    expect(pointer.record.intent.payload).toEqual({}); // the answer is content: it lives only in the payload
    expect(JSON.parse(f.values.get(pointer.payloadKey)!)).toEqual({ text: savedText });
  });
  it.each(["schema", "profile", "client", "pair", "extra", "mismatch", "payload", "mode", "kind", "version"])("blocks malformed %s without deleting data", async kind => {
    const f = fixture(), p: Record<string, unknown> = structuredClone(pending());
    if (kind === "schema") p.schemaVersion = 2;
    if (kind === "profile") p.profileId = "foreign";
    if (kind === "client") p.clientInstanceId = "bad";
    if (kind === "pair") p.pair = "ru-fr";
    if (kind === "extra") p.token = "synthetic-extra";
    if (kind === "mismatch") p.mismatch = false;
    if (kind === "payload") p.intent = { ...intents[1], payload: { text: "", forgot: true } };
    if (kind === "mode") p.intent = { command_id: id(2), kind: "session.start", session_id: id(3), payload: { mode: "oral" } };
    if (kind === "kind") p.intent = { ...intents[1], kind: "oral.grade" };
    if (kind === "version") p.intent = { command_id: id(2), kind: "result.grade", session_id: id(3), assignment_id: id(4), result_id: id(6), expected_result_version: 9007199254740993, payload: { grade: 4 } };
    expect(validConjugationPending(p)).toBe(false);
    seedRaw(f.values, "wortly.pending.conjugation_session", JSON.stringify(p), id(90));
    await expect(f.stores[1].load(id(90), signal())).rejects.toBeInstanceOf(PendingStoreError);
    expect(f.storage.remove).not.toHaveBeenCalled();
  });
  it("exact guards preserve replacements and serialize foreign-profile cleanup with the new write", async () => {
    const f = fixture(), store = f.stores[1], p = pending(); await store.save(p, signal());
    const replacement = { ...p, intent: { ...p.intent, command_id: id(99) } };
    await expect(store.clear(replacement, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.markMismatch(replacement, signal())).rejects.toMatchObject({ kind: "changed" });
    const foreign = { ...p, profileId: id(88) };
    const cleanup = store.load(id(88), signal()), save = store.save(foreign, signal());
    expect(await cleanup).toBeNull(); await save;
    expect(await store.load(id(88), signal())).toEqual(foreign);
  });
  it("preserves exact large revision versions, empty text and forgot independently", () => {
    const large: ConjugationIntent = { command_id: id(2), kind: "result.grade", session_id: id(3), assignment_id: id(4), result_id: id(6), expected_result_version: "9007199254740993", payload: { grade: 5 } };
    expect(canonicalConjugationIntent(large)).toEqual(large);
    expect(canonicalConjugationIntent({ ...intents[1], kind: "answer.submit", session_id: id(3), assignment_id: id(4), payload: { text: "" } }).payload).toEqual({ text: "" });
    expect(canonicalConjugationIntent({ ...intents[1], kind: "answer.submit", session_id: id(3), assignment_id: id(4), payload: { forgot: true } }).payload).toEqual({ forgot: true });
  });
  it("keeps an undo in the study slot with its exact address, lower-cased, and refuses an undo payload", async () => {
    const f = fixture(), upper = (value: string) => value.toUpperCase();
    const undo: ConjugationIntent = { command_id: id(2), kind: "result.undo", session_id: id(3), assignment_id: id(4), result_id: id(6),
      expected_result_version: "9007199254740993", payload: {} };
    await f.stores[1].save(pending(undo), signal());
    expect(await f.stores[1].load(id(90), signal())).toEqual(pending(undo));
    await expect(f.stores[0].save(pending(undo), signal())).rejects.toMatchObject({ kind: "invalid" });
    await expect(f.stores[2].save(pending(undo), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(canonicalConjugationIntent({ ...undo, session_id: upper(undo.session_id), result_id: upper(id(6)) })).toEqual(undo);
    for (const payload of [{ grade: 4 }, { text: "x" }, { forgot: true }]) {
      expect(validConjugationPending(pending({ ...undo, payload } as ConjugationIntent))).toBe(false);
    }
  });
  it("aborted read prevents a following write and keeps malformed JSON untouched", async () => {
    const f = fixture(), abort = new AbortController();
    vi.mocked(f.storage.get).mockImplementationOnce(async () => { abort.abort(); return null; });
    await expect(f.stores[1].save(pending(), abort.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect(f.storage.set).not.toHaveBeenCalled();
    seedRaw(f.values, "wortly.pending.conjugation_session", "broken-json", id(90));
    await expect(f.stores[1].load(id(90), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(pendingRaw(f.values, "wortly.pending.conjugation_session")).toBe("broken-json");
  });
  it.each(["\ud800", "x\udfff"])("refuses a lone surrogate without changing or deleting the persisted text", async text => {
    const f = fixture(), p = pending({ command_id: id(2), kind: "answer.submit", session_id: id(3), assignment_id: id(4), payload: { text } });
    expect(validConjugationPending(p)).toBe(false); expect(() => canonicalConjugationIntent(p.intent)).toThrow(PendingStoreError);
    const raw = JSON.stringify(p); seedRaw(f.values, "wortly.pending.conjugation_session", raw, id(90));
    await expect(f.stores[1].load(id(90), signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(pendingRaw(f.values, "wortly.pending.conjugation_session")).toBe(raw); expect(f.storage.remove).not.toHaveBeenCalled();
  });
});
