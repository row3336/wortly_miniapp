import { describe, expect, it, vi } from "vitest";
import { createLearningSessionApi, type LearningSessionCommand } from "./learningSessionApi";
import recording from "./learningRefusalRecording.json";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

/**
 * A stored final refusal of a Learning start, recorded from core's own ASGI app by core/tools/record_learning_refusal.py
 * (C232): a second start while the first session is open is refused SESSION_BUSY, then its status is read with
 * include_refusal. The recorded replies pass the strict client decoders unedited; each request must equal the recorded one.
 */
type Exchange = { name: string; method: "GET" | "POST"; path: string; query: Record<string, string>;
  body: Record<string, unknown> | null; status: number; response: unknown };
const exchange = (name: string) => (recording.exchanges as unknown as Exchange[]).find(item => item.name === name)!;

function replay(expected: Exchange) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(String(url), "http://localhost");
    expect(init?.method).toBe(expected.method);
    expect(parsed.pathname).toBe(expected.path);
    expect(Object.fromEntries(parsed.searchParams)).toEqual(expected.query);
    if (expected.body) expect(JSON.parse(String(init?.body))).toEqual(expected.body);
    return new Response(JSON.stringify(expected.response), { status: expected.status });
  });
}
const api = (fetcher: typeof fetch) => createLearningSessionApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
const command = (): LearningSessionCommand => {
  const body = exchange("busy_refused").body!;
  return { command_id: body.command_id as string, session_id: body.session_id as string, kind: "session.start",
    payload: { mode: "learning" }, client_instance_id: body.client_instance_id as string, document_id: body.document_id as string };
};

describe("Learning start refusal against a recorded core reply (C232)", () => {
  it("the refused second start reads as a SESSION_BUSY refusal of its own command", async () => {
    const fetcher = replay(exchange("busy_refused"));
    expect(await api(fetcher).send("token", "proof", command())).toMatchObject({ outcome: "rejected", error: { code: "SESSION_BUSY" },
      command: { id: command().command_id, status: "rejected" } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("its status, asked with include_refusal and the start's hash, passes the strict RefusedStartFact decoder", async () => {
    const fetcher = replay(exchange("busy_refused_status"));
    expect(await readWithTicket(command(), (__command, __ticket) => api(fetcher).status("token", "proof", __command, __ticket))).toMatchObject({ outcome: "rejected", error: { code: "SESSION_BUSY" },
      command: { id: command().command_id, kind: "session.start", status: "rejected" } });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
