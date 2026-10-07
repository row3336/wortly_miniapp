import { describe, expect, it } from "vitest";
import { id } from "../learning/learningFixtures.test-support";
import type { AsyncStorage } from "../platform/storage";
import { FeedbackPendingStore, validFeedbackPending, type FeedbackPending } from "./feedbackPending";

const record: FeedbackPending = { schemaVersion: 1, profileId: id(50),
  intent: { command_id: id(100), kind: "feedback.send", payload: { text: "Das Wort ist falsch" } } };
function memory() {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
  return { values, storage };
}
const signal = () => new AbortController().signal;

describe("feedback pending record", () => {
  it("keeps only the sent intent in its own slot and returns a detached copy", async () => {
    const { values, storage } = memory(), store = new FeedbackPendingStore(storage);
    await store.save(record, signal());
    expect([...values.keys()]).toEqual(["wortly.pending.feedback"]);
    expect(JSON.parse(values.get("wortly.pending.feedback")!)).toEqual(record);
    const loaded = await store.load(id(50), signal());
    expect(loaded).toEqual(record); expect(loaded).not.toBe(record);
    await store.clear(record, signal());
    expect(values.size).toBe(0);
  });
  it("a different intent cannot overwrite an unresolved one", async () => {
    const { storage } = memory(), store = new FeedbackPendingStore(storage);
    await store.save(record, signal());
    await expect(store.save({ ...record, intent: { ...record.intent, command_id: id(101) } }, signal())).rejects.toMatchObject({ kind: "changed" });
    await expect(store.save({ ...record, intent: { ...record.intent, payload: { text: "other" } } }, signal())).rejects.toMatchObject({ kind: "changed" });
  });
  it("another profile's record is removed on load", async () => {
    const { values, storage } = memory(), store = new FeedbackPendingStore(storage);
    await store.save(record, signal());
    expect(await store.load(id(51), signal())).toBeNull(); expect(values.size).toBe(0);
  });
  it.each([
    ["wrong schema", { ...record, schemaVersion: 2 }], ["extra field", { ...record, mismatch: true }], ["no profile", { ...record, profileId: "x" }],
    ["blank text", { ...record, intent: { ...record.intent, payload: { text: " " } } }],
    ["another kind", { ...record, intent: { ...record.intent, kind: "setting.save" } }],
    ["not an object", 5], ["array", []],
  ])("%s is invalid", async (_name, value) => {
    expect(validFeedbackPending(value)).toBe(false);
    const { storage } = memory(); await storage.set("wortly.pending.feedback", JSON.stringify(value));
    await expect(new FeedbackPendingStore(storage).load(id(50), signal())).rejects.toMatchObject({ kind: "invalid" });
  });
});
