import { describe, expect, it, vi } from "vitest";
import { createConjugationApi } from "./conjugationApi";
import { conjugationIntentHash, type ConjugationIntent, type ConjugationCommand } from "./conjugationIntent";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session_id = "abcdefab-abcd-4abc-8abc-abcdefabcdef", assignment_id = "fedcbafe-dcba-4fed-8fed-fedcbafedcba";
const result_id = "abcdef01-abcd-4abc-8abc-abcdefabcdef", base_verb_id = "abcdef02-abcd-4abc-8abc-abcdefabcdef";
const addressed = { command_id: id(1), session_id, assignment_id };
// Independent Python json/hashlib vectors over the actual service payload shapes.
const vectors: [ConjugationIntent, string][] = [
  [{ command_id: id(1), kind: "conjugation.schedule", payload: { base_verb_id, tense: "present" } }, "0daa98bded567c0c980c6731dd632a94ba16d0a5340b65dfac1936caa03673a4"],
  [{ command_id: id(1), session_id, kind: "session.start", payload: { mode: "conjugation" } }, "d77a3162ed38117671b3e030b12dfe1d050072efc7fd9fc5ea577f7b0afe1719"],
  [{ ...addressed, kind: "assignment.present", payload: {} }, "1693877ed48edd832247c40a88ed81cabafb4b7c7c331245b383af22f2fea561"],
  [{ ...addressed, kind: "answer.submit", payload: { text: " Käme 🐻\nA\u0308\\\" " } }, "975cf1febf9060f1b2cb8f2827ecbba8520e13d6215c3567940d509a34f3d1e3"],
  [{ ...addressed, kind: "answer.submit", payload: { forgot: true } }, "342e60aa416f37426071c2aa37569dc9a1e08549b6ea8574be82885d72833256"],
  [{ ...addressed, kind: "result.grade", result_id, expected_result_version: "9007199254740993", payload: { grade: 5 } }, "c299c4cb2d848d786ecfb64955c1187bd09fbb0fa0d4f3f64fdeac89fe0c8b46"],
  [{ ...addressed, kind: "result.correct", result_id, expected_result_version: "9223372036854775807", payload: {} }, "390fbf843165e5878c90c45312b0178c4a7a4ace82edbf05c643526192786a41"],
  [{ command_id: id(1), session_id, kind: "session.stop", payload: { reason: "summary_home" } }, "aa9b7c5e18606a4cef0951e5efbc108f42fa7e394200adb8c3195d4b40e7b8ed"],
];
const wire = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const api = (fetcher: typeof fetch) => createConjugationApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 20000 });
const command = (intent: ConjugationIntent): ConjugationCommand => ({ ...intent, client_instance_id: id(2), document_id: id(3) });
function receipt(intent: ConjugationIntent, verified: unknown) {
  const result = ["answer.submit", "result.grade", "result.correct"].includes(intent.kind);
  const version = "expected_result_version" in intent ? String(BigInt(intent.expected_result_version) + 1n) : "1";
  return { command: { id: intent.command_id, kind: intent.kind, status: "already_applied", applied_at: "2026-10-01T00:00:00Z",
    target_id: intent.kind === "conjugation.schedule" ? intent.payload.base_verb_id : "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: result ? id(4) : null, result_id: result ? "result_id" in intent ? intent.result_id : id(5) : null,
    context_id: null, object_version: result ? version : intent.kind === "conjugation.schedule" ? "1" : null },
    ...(result ? { action: null, result: null, step: { status: "unavailable" }, capabilities: {
      answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false } }
      : { current: { status: "unavailable" } }), state_version: "20", verified_intent_hash: verified };
}

describe("conjugation exact intent status proof", () => {
  it.each(vectors)("hashes %j exactly as Python, preserving nested payload and decimal versions", async (intent, expected) => {
    expect(await conjugationIntentHash(intent)).toBe(expected);
    const upper = structuredClone(intent); upper.command_id = id(90);
    if ("session_id" in upper) upper.session_id = upper.session_id.toUpperCase();
    if ("assignment_id" in upper) upper.assignment_id = upper.assignment_id.toUpperCase();
    if ("result_id" in upper) upper.result_id = upper.result_id.toUpperCase();
    if (upper.kind === "conjugation.schedule") upper.payload.base_verb_id = upper.payload.base_verb_id.toUpperCase();
    expect(await conjugationIntentHash(upper)).toBe(expected);
  });
  it.each(vectors.filter(([intent]) => intent.kind !== "result.correct"))("requires exact proof even without current/detail for %j", async (intent, expected) => {
    const fetcher = vi.fn<typeof fetch>(async () => wire(receipt(intent, expected)));
    expect((await api(fetcher).status("synthetic", "synthetic", command(intent))).outcome).toBe("accepted");
    const url = new URL(String(fetcher.mock.calls[0][0]), "https://model.invalid");
    expect(url.searchParams.get("expected_intent_hash")).toBe(expected);
    expect(url.searchParams.get("session_id")).toBe(intent.kind === "conjugation.schedule" ? null : intent.session_id);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET" }); expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
  });
  it.each([undefined, null, "a".repeat(64), false, { hash: "a".repeat(64) }])("refuses missing/wrong proof %j without a fallback request", async proof => {
    const [intent] = vectors[4], fetcher = vi.fn<typeof fetch>(async () => wire(receipt(intent, proof)));
    await expect(api(fetcher).status("synthetic", "synthetic", command(intent))).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("does not confuse same UUID/target with another payload after a restart", async () => {
    const [saved, savedHash] = vectors[3], [local, localHash] = vectors[4];
    const fetcher = vi.fn<typeof fetch>(async url => new URL(String(url), "https://model.invalid").searchParams.get("expected_intent_hash") === savedHash
      ? wire(receipt(saved, savedHash)) : wire({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409));
    for (let restart = 0; restart < 2; restart++) {
      await expect(api(fetcher).status("synthetic", "synthetic", command(local))).rejects.toMatchObject({ status: 409, code: "COMMAND_PAYLOAD_MISMATCH" });
    }
    expect(localHash).not.toBe(savedHash); expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await api(fetcher).status("synthetic", "synthetic", command(saved))).outcome).toBe("accepted");
  });
  it("copies the whole intent before asynchronous hashing and fails closed if hashing is unavailable", async () => {
    const [intent, hash] = vectors[4], original = command(structuredClone(intent));
    const fetcher = vi.fn<typeof fetch>(async () => wire(receipt(intent, hash)));
    const pending = api(fetcher).status("synthetic", "synthetic", original);
    Object.assign(original, { command_id: id(90), session_id: id(91), payload: { text: "changed" } });
    expect((await pending).outcome).toBe("accepted");
    expect(String(fetcher.mock.calls[0][0])).toContain(`/commands/${intent.command_id}?`);
    const fail = vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(Error("synthetic unavailable"));
    try { await expect(api(fetcher).status("synthetic", "synthetic", command(intent))).rejects.toThrow(); }
    finally { fail.mockRestore(); }
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
