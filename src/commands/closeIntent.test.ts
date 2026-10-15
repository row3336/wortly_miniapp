// The reader of the closure record C (M-RECOV-AUTO CP4a-1, D-CP4 4.6.1; QA CP4a-1 probes Q-C1, Q-C2): every validator
// reads it, none lets it be sent, and the written fingerprint names its unsaved action (DS 2.1.6).
import { describe, expect, it, vi } from "vitest";
import { readableLearningSessionIntent, validLearningSessionIntent } from "../learning/learningSessionIntent";
import { validLearningSessionPending } from "../learning/learningSessionPending";
import { createWrittenApi } from "../written/writtenApi";
import { readableWrittenIntent, validWrittenIntent, writtenIntentHash } from "../written/writtenIntent";
import { validWrittenPending } from "../written/writtenPending";
import { copySaveFailedStop, sendableIntent, validSaveFailedStop } from "./closeIntent";
import { hashInPlace } from "./recoveryTime.test-support";
import { testGate } from "./testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const c = { command_id: id(300), session_id: id(3), kind: "session.stop" as const,
  payload: { reason: "save_failed" as const, unsaved_command_id: id(100) } };
const record = (intent: unknown) => ({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent });

describe("the closure record C", () => {
  it("is readable by both modes and their Stop slots, never sendable", () => {
    expect([readableLearningSessionIntent(c), readableWrittenIntent(c)]).toEqual([true, true]);
    expect([validLearningSessionIntent(c), validWrittenIntent(c), sendableIntent(c)]).toEqual([false, false, false]);
    expect(sendableIntent({ kind: "session.stop", payload: { reason: "stop" } })).toBe(true);
    expect([validLearningSessionPending(record(c)), validWrittenPending(record(c))]).toEqual([true, true]);
    expect(copySaveFailedStop(c)).toEqual(c);
  });
  it.each([
    ["names itself (another case)", { ...c, payload: { ...c.payload, unsaved_command_id: c.command_id.toUpperCase() } }],
    ["an extra payload key", { ...c, payload: { ...c.payload, extra: 1 } }],
    ["an extra envelope key", { ...c, extra: 1 }],
    ["no unsaved action", { ...c, payload: { reason: "save_failed" } }],
    ["another reason with the unsaved action", { ...c, payload: { reason: "stop", unsaved_command_id: id(100) } }],
    ["a malformed unsaved action", { ...c, payload: { ...c.payload, unsaved_command_id: "nope" } }],
  ])("is refused with %s", (_name, value) => {
    expect(validSaveFailedStop(value)).toBe(false);
    expect(readableWrittenIntent(value)).toBe(false);
    expect(readableLearningSessionIntent(value)).toBe(false);
  });
  it("the written API refuses to send it without a request; its status fingerprint names the unsaved action", async () => {
    hashInPlace();
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
    const api = createWrittenApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    await expect(api.send("token", "proof", { ...c, client_instance_id: id(1), document_id: id(2) } as never)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const plain = await writtenIntentHash({ command_id: id(300), session_id: id(3), kind: "session.stop", payload: { reason: "stop" } } as never);
    const one = await writtenIntentHash(c as never);
    const other = await writtenIntentHash({ ...c, payload: { ...c.payload, unsaved_command_id: id(101) } } as never);
    const upper = await writtenIntentHash({ ...c, payload: { ...c.payload, unsaved_command_id: id(100).toUpperCase() } } as never);
    expect(new Set([plain, one, other]).size).toBe(3);
    expect(upper).toBe(one);
  });
});
