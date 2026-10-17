// The closure record C (M-RECOV-AUTO CP4a-1, D-CP4 4.6.1; QA CP4a-1 probes Q-C1, Q-C2) and the Stop with X (T1).
// Before M1b C was only read and never sent; since core 35c3844 (N2/N3, CP4b; CON table 2.1 :82 refinement C486,
// project notices ed.2.4 §4.1) C is sent by the automatic recovery and the person's Stop may name X. The written
// fingerprint names the unsaved action (DS 2.1.6); without X the payload stays `{reason}`.
import { describe, expect, it, vi } from "vitest";
import { readableLearningSessionIntent, validLearningSessionIntent } from "../learning/learningSessionIntent";
import { validLearningSessionPending } from "../learning/learningSessionPending";
import { createWrittenApi } from "../written/writtenApi";
import { readableWrittenIntent, validWrittenIntent, writtenIntentHash } from "../written/writtenIntent";
import { validWrittenPending } from "../written/writtenPending";
import { copySaveFailedStop, copyStopPayload, sendableIntent, unsavedActionId, validSaveFailedStop, validStopPayload } from "./closeIntent";
import { hashInPlace } from "./recoveryTime.test-support";
import { testGate } from "./testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const c = { command_id: id(300), session_id: id(3), kind: "session.stop" as const,
  payload: { reason: "save_failed" as const, unsaved_command_id: id(100) } };
const record = (intent: unknown) => ({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent });

describe("the closure record C", () => {
  it("is readable by both modes and their Stop slots, and sendable in its exact form (CP4b)", () => {
    expect([readableLearningSessionIntent(c), readableWrittenIntent(c)]).toEqual([true, true]);
    expect([validLearningSessionIntent(c), validWrittenIntent(c), sendableIntent(c)]).toEqual([true, true, true]);
    expect(sendableIntent({ kind: "session.stop", payload: { reason: "save_failed" } })).toBe(false);
    expect(sendableIntent({ kind: "session.stop", payload: { reason: "stop" } })).toBe(true);
    expect([validLearningSessionPending(record(c)), validWrittenPending(record(c))]).toEqual([true, true]);
    expect(copySaveFailedStop(c)).toEqual(c);
  });
  it.each([
    ["names itself (another case)", { ...c, payload: { ...c.payload, unsaved_command_id: c.command_id.toUpperCase() } }],
    ["an extra payload key", { ...c, payload: { ...c.payload, extra: 1 } }],
    ["an extra envelope key", { ...c, extra: 1 }],
    ["no unsaved action", { ...c, payload: { reason: "save_failed" } }],
    ["a malformed unsaved action", { ...c, payload: { ...c.payload, unsaved_command_id: "nope" } }],
    ["summary_home with the unsaved action", { ...c, payload: { reason: "summary_home", unsaved_command_id: id(100) } }],
  ])("is refused with %s", (_name, value) => {
    expect(validSaveFailedStop(value)).toBe(false);
    expect(readableWrittenIntent(value)).toBe(false);
    expect(readableLearningSessionIntent(value)).toBe(false);
  });
  it("the written API sends it as is; its status fingerprint names the unsaved action", async () => {
    hashInPlace();
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
    const api = createWrittenApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    await expect(api.send("token", "proof", { ...c, client_instance_id: id(1), document_id: id(2) } as never)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls[0][1]!.body)).payload).toEqual({ reason: "save_failed", unsaved_command_id: id(100) });
    const plain = await writtenIntentHash({ command_id: id(300), session_id: id(3), kind: "session.stop", payload: { reason: "stop" } } as never);
    const one = await writtenIntentHash(c as never);
    const other = await writtenIntentHash({ ...c, payload: { ...c.payload, unsaved_command_id: id(101) } } as never);
    const upper = await writtenIntentHash({ ...c, payload: { ...c.payload, unsaved_command_id: id(100).toUpperCase() } } as never);
    expect(new Set([plain, one, other]).size).toBe(3);
    expect(upper).toBe(one);
  });
});

describe("session.stop payload (T1, project notices §4.1)", () => {
  it("without X it is byte for byte {reason}; with X only stop and save_failed, never summary_home or its own id", () => {
    expect(JSON.stringify(copyStopPayload({ reason: "stop" }))).toBe('{"reason":"stop"}');
    expect(JSON.stringify(copyStopPayload({ reason: "summary_home" }))).toBe('{"reason":"summary_home"}');
    expect(validStopPayload({ reason: "stop", unsaved_command_id: id(100) }, id(300))).toBe(true);
    expect(validStopPayload({ reason: "save_failed", unsaved_command_id: id(100) }, id(300))).toBe(true);
    expect(validStopPayload({ reason: "save_failed" }, id(300))).toBe(false);
    expect(validStopPayload({ reason: "summary_home", unsaved_command_id: id(100) }, id(300))).toBe(false);
    expect(validStopPayload({ reason: "stop", unsaved_command_id: id(300) }, id(300))).toBe(false);
    expect(validStopPayload({ reason: "stop", unsaved_command_id: null }, id(300))).toBe(false);
  });
  it("the written stop with X is a sendable intent; its hash differs from the stop without X", async () => {
    hashInPlace();
    const plain = { command_id: id(300), session_id: id(3), kind: "session.stop" as const, payload: { reason: "stop" as const } };
    const withX = { ...plain, payload: { reason: "stop" as const, unsaved_command_id: id(100) } };
    expect([validWrittenIntent(withX), validLearningSessionIntent(withX)]).toEqual([true, true]);
    expect(await writtenIntentHash(plain as never)).not.toBe(await writtenIntentHash(withX as never));
  });
  it("X is the unconfirmed study action of this very session only", () => {
    const lane = (kind: string, session = id(3), outcome: string | null = null) => ({ pending: true, outcome,
      pendingIntent: { command_id: id(100), kind, session_id: session } });
    expect(unsavedActionId(lane("answer.submit"), id(3))).toBe(id(100));
    expect(unsavedActionId(lane("oral.grade"), id(3).toUpperCase())).toBe(id(100));
    expect(unsavedActionId(lane("answer.submit", id(4)), id(3))).toBeNull();
    expect(unsavedActionId(lane("answer.submit", id(3), "accepted"), id(3))).toBeNull();
    for (const kind of ["session.start", "session.stop", "session.cancel_start", "assignment.present", "oral.reveal", "result.undo",
      "learning.known"]) expect(unsavedActionId(lane(kind), id(3))).toBeNull();
    expect(unsavedActionId(lane("result.grade"), id(3))).toBe(id(100));
    expect(unsavedActionId({ pending: false, outcome: null, pendingIntent: null }, id(3))).toBeNull();
    expect(unsavedActionId({ pending: true, outcome: null, pendingIntent: null, lost: { commandId: id(101), kind: "answer.submit", sessionId: id(3) } }, id(3))).toBe(id(101));
    expect(unsavedActionId({ pending: true, outcome: null, pendingIntent: null, lost: { commandId: id(101), kind: "answer.submit", sessionId: id(4) } }, id(3))).toBeNull();
    // C549: a bare id without its envelope's kind is no answer.
    expect(unsavedActionId({ pending: true, outcome: null, pendingIntent: null, lost: { commandId: id(101), sessionId: id(3) } }, id(3))).toBeNull();
  });
});
