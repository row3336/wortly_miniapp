import { describe, expect, it } from "vitest";
import { copyWrittenIntent, validWrittenIntent, writtenIntentHash, type WrittenIntent } from "./writtenIntent";
import { PendingStoreError } from "../commands/pendingSlot";
import { writtenStores } from "./writtenPending";
import { id, pending } from "./writtenFixtures.test-support";

const s = id(3), a = id(6), r = id(701), c = id(100);
const start: WrittenIntent = { command_id: c, session_id: s, kind: "session.start", payload: { mode: "written", bucket: "words" } };
const present: WrittenIntent = { command_id: c, session_id: s, kind: "assignment.present", assignment_id: a, payload: {} };
const stop: WrittenIntent = { command_id: c, session_id: s, kind: "session.stop", payload: { reason: "stop" } };
const text: WrittenIntent = { command_id: c, session_id: s, kind: "answer.submit", assignment_id: a,
  payload: { text: "die Straße,\t\"Häuser\"\n\u0001" } };
const forgot: WrittenIntent = { command_id: c, session_id: s, kind: "answer.submit", assignment_id: a, payload: { forgot: true } };
const grade: WrittenIntent = { command_id: c, session_id: s, kind: "result.grade", assignment_id: a, result_id: r,
  expected_result_version: "2", payload: { grade: 5 } };

describe("written intents", () => {
  it("accepts exactly the written session payloads and the shared answer/revision envelopes", () => {
    for (const intent of [start, present, stop, text, forgot, grade]) {
      expect(validWrittenIntent(intent)).toBe(true);
      expect(copyWrittenIntent(intent)).toEqual(intent);
    }
    expect(validWrittenIntent({ ...start, payload: { mode: "oral", bucket: "words" } })).toBe(false);
    expect(validWrittenIntent({ ...start, payload: { mode: "written", bucket: "verbs" } })).toBe(false);
    expect(validWrittenIntent({ ...start, payload: { mode: "learning" } })).toBe(false);
    expect(validWrittenIntent({ ...present, extra: true })).toBe(false);
    expect(validWrittenIntent({ ...stop, payload: { reason: "midnight" } })).toBe(false);
    expect(validWrittenIntent({ ...grade, payload: { grade: 2 } })).toBe(false);
    // No written correction right exists in the contract yet, so its command is not an intent of this client.
    expect(validWrittenIntent({ ...grade, kind: "result.correct", payload: {} })).toBe(false);
    expect(validWrittenIntent({ ...text, client_instance_id: id(1) })).toBe(false);
  });

  // Reference values: core identity.service.intent_hash over the same service payloads (see M-WRITTEN WORKLOG, CP2).
  it.each([
    ["session.start", start, "e6c0dff823aa5a65ed5753bd18b697e9f618879af15aebdac5eaa863f7fdc347"],
    ["assignment.present", present, "5ffb65afab3630ed601ef97b2ed613a64ced3a24c56fe7b639a66b7a00cbc950"],
    ["session.stop", stop, "9469e8627c7ed2cc827d96d93ad8cacf5ec8dccadc964952c4031a6ac1110485"],
    ["answer.submit text", text, "302f647ae26995ea7b24886d663184efafc012685e8896f93f3d8dc4f87fe8c6"],
    ["answer.submit forgot", forgot, "9fa837cb9a83fdc1b2e1566638b8053dacfa4ee951f92affe0bc7c00631f7671"],
    ["result.grade", grade, "904789a7601379baca7a321dd520205431e7863ab0f4005a97f43708e832bc8a"],
  ] as const)("fingerprints %s exactly like the server", async (_name, intent, expected) => {
    expect(await writtenIntentHash(intent)).toBe(expected);
    // The command ID and the letter case of UUIDs are not part of the fingerprint.
    expect(await writtenIntentHash({ ...intent, command_id: id(999), session_id: s.toUpperCase() })).toBe(expected);
  });

  it("keeps one pending slot pair per storage and separates the Stop lane", async () => {
    const values = new Map<string, string>();
    const storage = { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); },
      remove: async (key: string) => { values.delete(key); } };
    const stores = writtenStores(storage);
    expect(writtenStores(storage)).toBe(stores);
    const signal = new AbortController().signal;
    await expect(stores.primary.save(pending(stop) as never, signal)).rejects.toBeInstanceOf(PendingStoreError);
    await stores.stop.save(pending(stop) as never, signal);
    expect(await stores.stop.load(id(50), signal)).toEqual(pending(stop));
    expect(await stores.primary.load(id(50), signal)).toBeNull();
  });
});
