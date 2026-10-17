import { describe, expect, it, vi } from "vitest";
import { ApiError, createJsonTransport, httpError, TRACE_HEADER } from "./http";
import { WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";
import { proofRefusalCandidate } from "../commands/proofRefusal";

// DEV-41 M1/M2 at the transport (plan ред.3 §8 п.1/п.5, §9 п.1; QA M1/M2 PZ3–PZ5): the actual-send snapshot carries this
// attempt's own trace and, for POST /profile/delete only, its command_id; a refusal whose body stalls past the deadline
// carries it too, never as the bare FORBIDDEN. Synthetic requests and answers only.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DOC = { clientInstanceId: id(1), documentId: id(2) };
function recorder(answer: () => Response) {
  const headers: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    headers.push((init!.headers as Record<string, string>)[TRACE_HEADER]);
    return answer();
  });
  let n = 500;
  const request = createJsonTransport({ fetcher, timeoutMs: 50, maxResponseBytes: 1000, gate: new WriteGate({ clock: new ManualClock() }),
    newTraceId: () => id(++n) });
  return { request, headers };
}
const stalled = (status: number) => () => new Response(new ReadableStream({ start() { /* never closes */ } }), { status });
const deleteBody = (commandId: string) => ({ command_id: commandId, confirmed_profile_id: id(11), confirmation: "delete_profile",
  client_instance_id: id(1) });

describe("the actual-send snapshot of DEV-41 (trace, deleteCommandId)", () => {
  it("PZ5: trace is the header this client set, never the echo; deleteCommandId only for POST /profile/delete", async () => {
    const t = recorder(() => new Response(JSON.stringify({ error: { code: "VALIDATION_FAILED" } }),
      { status: 422, headers: { [TRACE_HEADER]: id(999) } }));
    const del = await t.request("/profile/delete", { method: "POST", token: "t", proof: "p", body: deleteBody(id(10)) });
    const cmd = await t.request("/commands", { method: "POST", token: "t", proof: "p",
      body: { command_id: id(20), kind: "settings.reset", client_instance_id: id(1), document_id: id(2), payload: {} } });
    expect([del.sent?.trace, cmd.sent?.trace]).toEqual(t.headers);
    expect(t.headers).not.toContain(id(999));
    // The echo stays where it was, on the reply.
    expect([del.trace, cmd.trace]).toEqual([id(999), id(999)]);
    expect(del.sent).toMatchObject({ kind: null, commandId: null, deleteCommandId: id(10) });
    expect(cmd.sent).toMatchObject({ kind: "settings.reset", commandId: id(20), deleteCommandId: null });
    // Still not enumerable: the reply the modules read is as it was.
    expect(Object.keys(del)).not.toContain("sent");
  });

  it("PZ4 §8 п.5: a 4xx whose body stalls past the deadline carries this attempt's snapshot, bareForbidden=false, no code", async () => {
    const t = recorder(stalled(422));
    const error = await t.request("/profile/delete", { method: "POST", token: "t", proof: "p", body: deleteBody(id(30)) })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const refusal = error as ApiError;
    expect([refusal.kind, refusal.status, refusal.code]).toEqual(["http", 422, undefined]);
    expect(refusal.sentRefusal).toMatchObject({ bareForbidden: false, sent: { trace: t.headers[0], deleteCommandId: id(30) } });
  });

  it("PZ3: the proof-refusal classifier is unchanged — a stalled 403 is no candidate, a bare readable FORBIDDEN still is", async () => {
    const body = { command_id: id(40), kind: "session.stop", client_instance_id: DOC.clientInstanceId,
      document_id: DOC.documentId, payload: {} };
    const stalledError = await recorder(stalled(403)).request("/commands", { method: "POST", token: "t", proof: "p", body })
      .catch((caught: unknown) => caught) as ApiError;
    expect(stalledError.sentRefusal?.bareForbidden).toBe(false);
    expect(proofRefusalCandidate(stalledError, DOC)).toBe(false);
    const bare = await recorder(() => new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), { status: 403 }))
      .request("/commands", { method: "POST", token: "t", proof: "p", body });
    expect(httpError(bare).sentRefusal?.bareForbidden).toBe(true);
    expect(proofRefusalCandidate(httpError(bare), DOC)).toBe(true);
  });
});
