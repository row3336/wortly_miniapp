import { describe, expect, it, vi } from "vitest";
import { conformsToGenerated } from "./generatedContract.test-support";
import { createWrittenApi } from "./writtenApi";
import type { WrittenCommand } from "./writtenIntent";
import recording from "./writtenCoreRecording.json";

/**
 * Bridge to the real API: replies recorded from core's own ASGI app (TestClient over a disposable wortly_test
 * schema, no network port) by core/tools/record_written_session.py. Each client request must equal the request
 * the server accepted, and each real reply must pass the strict client parser. Credentials were never recorded.
 * Re-record from the core root after a change of the written contract:
 *   PYTHONDONTWRITEBYTECODE=1 PSYCOPG_IMPL=python DYLD_LIBRARY_PATH=/Applications/Postgres.app/Contents/Versions/18/lib
 *   .venv/bin/python tools/record_written_session.py --out <miniapp>/src/written/writtenCoreRecording.json
 */
type Exchange = { name: string; method: "GET" | "POST"; path: string; query: Record<string, string>;
  body: Record<string, unknown> | null; status: number; schema: string[]; response: unknown };
const exchanges = recording.exchanges as unknown as Exchange[];
const exchange = (name: string) => exchanges.find(item => item.name === name)!;
/** The «Шаг назад» part is a second session appended after the first one (M-UNDO). */
const undoPart = exchanges.findIndex(item => item.name === "undo_start");

function replay(from = 0) {
  const queue = exchanges.slice(from);
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const expected = queue.shift()!;
    const parsed = new URL(String(url), "http://localhost");
    expect(init?.method).toBe(expected.method);
    expect(parsed.pathname).toBe(expected.path);
    const query = Object.fromEntries(parsed.searchParams);
    // The probe asked for an unknown ID without a fingerprint; the client always sends its own.
    if (expected.name === "status_missing") delete query.expected_intent_hash;
    expect(query).toEqual(expected.query);
    if (expected.body) expect(JSON.parse(String(init?.body))).toEqual(expected.body);
    return new Response(JSON.stringify(expected.response), { status: expected.status });
  });
  return { api: createWrittenApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 200000 }), fetcher };
}
const command = (name: string) => exchange(name).body as unknown as WrittenCommand;
const origin = () => ({ client_instance_id: command("start").client_instance_id, document_id: command("start").document_id });
const sessionId = () => command("start").session_id;
const resultAddress = (name: string) => ({ session_id: sessionId(), assignment_id: exchange(name).query.assignment_id,
  result_id: exchange(name).query.result_id, ...origin() });

describe("written adapter against recorded core replies", () => {
  it("every recorded reply has exactly the structure of the generated OpenAPI contract the recorder matched", () => {
    expect(exchanges.length).toBeGreaterThan(0);
    for (const item of exchanges) {
      // The recorder checked each reply against core's OpenAPI; the same schema must hold in the Mini App's copy.
      expect(item.schema.length, item.name).toBeGreaterThan(0);
      expect(conformsToGenerated(item.response, item.schema[0]), `${item.name}: ${item.schema[0]}`).toBe(true);
    }
  });

  it("sends the same requests the server accepted and accepts every real reply of one session", async () => {
    const { api, fetcher } = replay();
    const start = await api.send("token", "proof", command("start"));
    expect(start).toMatchObject({ outcome: "accepted", current: { status: "active", mode: "written", bucket: "phrases",
      progress: { completed: 0, correct: 0, wrong: 0 }, summary: null } });
    expect(await api.send("token", "proof", command("present_first"))).toMatchObject({ outcome: "accepted" });
    const answered = await api.send("token", "proof", command("answer_first"));
    expect(answered).toMatchObject({ outcome: "accepted", result: { grade: 4, version: "1" },
      capabilities: { correct_target: null, grades: { values: [3, 4, 5] } } });
    // Core now grants the undo of the live answer by its exact address (C-UNDO-1); this client only decodes it (M-UNDO-DEC).
    expect(answered).toMatchObject({ capabilities: { undo_target: { session_id: sessionId(), assignment_id: exchange("answer_first").body!.assignment_id,
      result_id: exchange("read_first").query.result_id, expected_result_version: "1", action_id: expect.any(String), kind: "answer.submit" } } });
    // The client computes the same intent fingerprint as core identity.intent_hash on real data.
    expect(await api.status("token", "proof", command("answer_first"))).toMatchObject({ outcome: "accepted",
      command: { status: "already_applied" } });
    expect(await api.send("token", "proof", command("present_second"))).toMatchObject({ outcome: "accepted" });
    expect(await api.readResult("token", "proof", resultAddress("read_first")))
      .toMatchObject({ result: { grade: 4 }, step: { status: "active" } });
    expect(await api.send("token", "proof", command("grade_first"))).toMatchObject({ outcome: "accepted", result: { grade: 5, version: "2" } });
    expect(await api.read("token", "proof", { session_id: sessionId(), ...origin() }))
      .toMatchObject({ current: { status: "active", summary: null, progress: { completed: 1, correct: 1, wrong: 0 } } });
    // The real server grants the correction of this error by its exact current address (C-WCORR).
    const correction = command("correct_second");
    const target = { session_id: sessionId(), assignment_id: exchange("answer_second").body!.assignment_id,
      result_id: "result_id" in correction ? correction.result_id : "", expected_result_version: "1" };
    expect(correction).toMatchObject({ kind: "result.correct", ...target, payload: {} });
    expect(await api.send("token", "proof", command("answer_second"))).toMatchObject({ outcome: "accepted",
      result: { grade: 2, result_id: target.result_id }, capabilities: { grades: null, correct_target: target },
      step: { assignment: { kind: "drill", status: "prefetched" } } });
    // Corrected before its drill was shown: the drill is withdrawn and the queue ends in the summary (CT:111).
    expect(await api.send("token", "proof", command("correct_second"))).toMatchObject({ outcome: "accepted",
      result: { grade: 4, version: "2", detail: { initial_check: { correct: false } } },
      capabilities: { correct_target: null, grades: { values: [3, 4, 5], expected_result_version: "2" } },
      step: { status: "summary", assignment: null, summary: { completed: 2, correct: 2, wrong: 0, ratio: { numerator: 2, denominator: 2 } } } });
    // The fingerprint of a correction (empty payload) equals core's.
    expect(await api.status("token", "proof", command("correct_second"))).toMatchObject({ outcome: "accepted",
      command: { status: "already_applied", kind: "result.correct" }, result: { grade: 4 } });
    expect(await api.read("token", "proof", { session_id: sessionId(), ...origin() })).toMatchObject({ current: { status: "summary",
      summary: { completed: 2, correct: 2, wrong: 0, ratio: { numerator: 2, denominator: 2 } } } });
    expect(await api.send("token", "proof", command("stop"))).toMatchObject({ outcome: "accepted",
      current: { status: "closed", close_reason: "summary_home", summary: { completed: 2, correct: 2, wrong: 0 } } });
    expect(await api.readResult("token", "proof", resultAddress("read_closed"))).toMatchObject({ result: { detail: null },
      step: { status: "closed", summary: { completed: 2, correct: 2, wrong: 0, ratio: { numerator: 2, denominator: 2 } } } });
    const missing = exchange("status_missing").path.split("/").at(-1)!;
    expect(await api.status("token", "proof", { ...command("stop"), command_id: missing })).toMatchObject({ outcome: "not_found",
      closed_session: { status: "closed", close_reason: "summary_home" } });
    expect(await api.send("token", "proof", command("start_again"))).toMatchObject({ outcome: "rejected", error: { code: "SESSION_CLOSED" } });
    expect(fetcher).toHaveBeenCalledTimes(undoPart);
  });

  it("accepts a real «Шаг назад»: the undone answer, its status by the same ID and the new issue of the card (C-UNDO-1)", async () => {
    expect(undoPart).toBeGreaterThan(0);
    const { api, fetcher } = replay(undoPart);
    const session = command("undo_start").session_id;
    expect(session).not.toBe(sessionId());
    expect(await api.send("token", "proof", command("undo_start"))).toMatchObject({ outcome: "accepted", current: { status: "active" } });
    expect(await api.send("token", "proof", command("undo_present"))).toMatchObject({ outcome: "accepted" });
    const answered = await api.send("token", "proof", command("undo_answer"));
    const answer = command("undo_answer");
    if (!("result" in answered) || !answered.result || !answered.action) throw new Error("the answer has no result");
    const right = { session_id: session, assignment_id: answer.kind === "answer.submit" ? answer.assignment_id : "",
      result_id: answered.result.result_id, expected_result_version: "1", action_id: answered.action.action_id, kind: "answer.submit" };
    expect(answered).toMatchObject({ outcome: "accepted", result: { grade: 2 }, capabilities: { undo_target: right } });
    // The command is the address of that right only, without its action ID (CT 2.3).
    const { action_id: _action, kind: _kind, ...address } = right;
    expect(command("undo")).toMatchObject({ kind: "result.undo", ...address, payload: {} });
    expect(command("undo")).not.toHaveProperty("action_id");
    const undone = await api.send("token", "proof", command("undo"));
    expect(undone).toMatchObject({ outcome: "accepted", command: { kind: "result.undo", object_version: "2" },
      result: { result_id: right.result_id, status: "undone", version: "2", detail: null }, action: { status: "undone", version: "2" },
      capabilities: { undo_target: null, correct_target: null, grades: null },
      step: { status: "active", summary: null, progress: { completed: 0 }, assignment: { status: "prefetched", kind: "original" } } });
    const again = "step" in undone && undone.step.status === "active" && "assignment" in undone.step ? undone.step.assignment?.id : null;
    expect(again).toBeTruthy();
    expect(again).not.toBe(right.assignment_id);
    // The client fingerprint of an undo equals core's on real data.
    expect(await api.status("token", "proof", command("undo"))).toMatchObject({ outcome: "accepted",
      command: { status: "already_applied", kind: "result.undo" }, result: { status: "undone" } });
    expect(command("undo_present_again")).toMatchObject({ kind: "assignment.present", assignment_id: again });
    expect(await api.send("token", "proof", command("undo_present_again"))).toMatchObject({ outcome: "accepted",
      current: { assignment: { id: again, status: "presented" } } });
    expect(fetcher).toHaveBeenCalledTimes(exchanges.length - undoPart);
  });
});
