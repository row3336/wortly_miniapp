import { describe, expect, it, vi } from "vitest";
import { createWrittenApi } from "./writtenApi";
import type { WrittenCommand } from "./writtenIntent";
import recording from "./writtenCoreRecording.json";

/**
 * Bridge to the real API: replies recorded from core's own ASGI app (TestClient over a disposable wortly_test
 * schema, no network port; probe in the M-WRITTEN stand). Each client request must equal the request the
 * server accepted, and each real reply must pass the strict client parser. Credentials were never recorded.
 */
type Exchange = { name: string; method: "GET" | "POST"; path: string; query: Record<string, string>;
  body: Record<string, unknown> | null; status: number; response: unknown };
const exchanges = recording.exchanges as unknown as Exchange[];
const exchange = (name: string) => exchanges.find(item => item.name === name)!;

function replay() {
  const queue = [...exchanges];
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

describe("written adapter against recorded core replies", () => {
  it("sends the same requests the server accepted and accepts every real reply of one session", async () => {
    const { api, fetcher } = replay();
    const start = await api.send("token", "proof", command("start"));
    expect(start).toMatchObject({ outcome: "accepted", current: { status: "active", mode: "written", bucket: "phrases" } });
    expect(await api.send("token", "proof", command("present_first"))).toMatchObject({ outcome: "accepted" });
    const answered = await api.send("token", "proof", command("answer_first"));
    expect(answered).toMatchObject({ outcome: "accepted", result: { grade: 4, version: "1" },
      capabilities: { correct_target: null, undo_target: null, grades: { values: [3, 4, 5] } } });
    // The client computes the same intent fingerprint as core identity.intent_hash on real data.
    expect(await api.status("token", "proof", command("answer_first"))).toMatchObject({ outcome: "accepted",
      command: { status: "already_applied" } });
    expect(await api.send("token", "proof", command("present_second"))).toMatchObject({ outcome: "accepted" });
    const first = exchange("read_first").query;
    expect(await api.readResult("token", "proof", { session_id: command("start").session_id, assignment_id: first.assignment_id,
      result_id: first.result_id, ...origin() })).toMatchObject({ result: { grade: 4 }, step: { status: "active" } });
    expect(await api.send("token", "proof", command("grade_first"))).toMatchObject({ outcome: "accepted", result: { grade: 5, version: "2" } });
    expect(await api.read("token", "proof", { session_id: command("start").session_id, ...origin() }))
      .toMatchObject({ current: { status: "active" } });
    const wrong = await api.send("token", "proof", command("answer_second"));
    expect(wrong).toMatchObject({ outcome: "accepted", result: { grade: 2 }, capabilities: { grades: null, correct_target: null },
      step: { assignment: { kind: "drill", status: "prefetched" } } });
    expect(await api.send("token", "proof", command("stop"))).toMatchObject({ outcome: "accepted", current: { status: "closed", close_reason: "stop" } });
    const closed = exchange("read_closed").query;
    expect(await api.readResult("token", "proof", { session_id: command("start").session_id, assignment_id: closed.assignment_id,
      result_id: closed.result_id, ...origin() })).toMatchObject({ result: { detail: null },
      step: { status: "closed", summary: { completed: 2, correct: 1, wrong: 1, ratio: { numerator: 1, denominator: 2 } } } });
    const missing = exchange("status_missing").path.split("/").at(-1)!;
    expect(await api.status("token", "proof", { ...command("stop"), command_id: missing })).toMatchObject({ outcome: "not_found",
      closed_session: { status: "closed", close_reason: "stop" } });
    expect(await api.send("token", "proof", command("start_again"))).toMatchObject({ outcome: "rejected", error: { code: "SESSION_CLOSED" } });
    expect(fetcher).toHaveBeenCalledTimes(exchanges.length);
  });
});
