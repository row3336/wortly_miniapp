import { describe, expect, it, vi } from "vitest";
import { createOralApi, type OralCommand, type OralIntent } from "./oralApi";
import { oralIntentHash } from "./oralIntent";
import { OralCommandController } from "./oralCommandController";
import { OralSessionPendingStore } from "./oralPending";
import type { AsyncStorage } from "../platform/storage";
import { testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = "abcdefab-abcd-4abc-8abc-abcdefabcdef", assignment = "fedcbafe-dcba-4fed-8fed-fedcbafedcba";
// Independent Python identity.intent_hash vectors for exactly these synthetic addresses.
const trueHash = "e6f6bd1814790594bb905104c7d8ecf3ac8ace602dbd245e51a6ae02aea0762a", falseHash = "181e8e00d66c624d9a2273a9626ecf664db42174645b5a08518e935647ab0bf2";
const intent = (correct: boolean): Extract<OralIntent, { kind: "oral.grade" }> => ({ kind: "oral.grade", command_id: id(4),
  session_id: session, assignment_id: assignment, payload: { correct } });
const command = (correct: boolean): OralCommand => ({ ...intent(correct), client_instance_id: id(1), document_id: id(2) });
const fact = { id: id(4), kind: "oral.grade", status: "already_applied", target_id: assignment,
  action_id: id(5), result_id: id(6), context_id: null, object_version: "1", applied_at: "2026-10-01T00:00:00Z" };
const accepted = { command: fact, current: { status: "unavailable" }, state_version: "10", verified_intent_hash: trueHash };
const wire = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const apiFor = (fetcher: typeof fetch) => createOralApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000, gate: testGate() });

function lifecycle(lostReply = false) {
  let raw: string | null = null;
  const storage: AsyncStorage = { get: async () => raw,
    set: async (_key, value) => { if (JSON.parse(value).mismatch) throw Error("synthetic marker failure"); raw = value; },
    remove: async () => { raw = null; } };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (init?.method === "POST") {
      if (lostReply) throw Error("lost reply after server acceptance");
      return wire({ command: { id: id(4), status: "rejected" },
        current: { session_id: session, status: "unavailable" }, state_version: "10",
        error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
    }
    const expected = new URL(String(url), "https://synthetic.invalid").searchParams.get("expected_intent_hash");
    return expected === trueHash ? wire(accepted) : wire({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
  });
  const api = apiFor(fetcher);
  const make = () => new OralCommandController({ profileId: id(50), clientInstanceId: id(1), pair: "ru-de", lane: "study",
    pendingStore: new OralSessionPendingStore(storage), isLive: () => true, newId: () => id(4), onUpdate: () => {},
    send: value => api.send("synthetic", "synthetic", { ...value, client_instance_id: id(1), document_id: id(2) }),
    check: value => api.status("synthetic", "synthetic", { ...value, client_instance_id: id(1), document_id: id(2) }),
    read: async () => { throw Error("no current read needed for a known fact or mismatch"); } });
  return { make, fetcher, raw: () => raw };
}

describe("oral exact intent recovery", () => {
  it("keeps opposite grade unresolved after failed marker write and immediate repeated restarts", async () => {
    const f = lifecycle(), first = f.make(); await first.refresh();
    const { command_id: _id, ...action } = intent(false); await first.begin(action);
    expect(first.snapshot()).toMatchObject({ pending: true, outcome: null, canRetry: false, problem: "storage" });
    expect(JSON.parse(f.raw()!).mismatch).toBeUndefined(); first.dispose();
    for (let i = 0; i < 2; i++) {
      const next = f.make(); await next.refresh(); await next.retry();
      expect(next.snapshot()).toMatchObject({ pending: true, outcome: null, canRetry: false, problem: "storage", current: null });
      expect(JSON.parse(f.raw()!).intent).toEqual(intent(false)); next.dispose();
    }
    expect(f.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET", "GET"]);
    for (const [url, init] of f.fetcher.mock.calls.slice(1)) {
      expect(new URL(String(url), "https://synthetic.invalid").searchParams.get("expected_intent_hash")).toBe(falseHash);
      expect(init?.body).toBeUndefined();
    }
  });
  it("still resolves ordinary lost reply with exact proof and unavailable current", async () => {
    const f = lifecycle(true), first = f.make(); await first.refresh();
    const { command_id: _id, ...action } = intent(true); await first.begin(action);
    expect(first.snapshot()).toMatchObject({ pending: true, outcome: null }); first.dispose();
    const next = f.make(); await next.refresh();
    expect(next.snapshot()).toMatchObject({ pending: false, outcome: "accepted", resolved: { commandId: id(4), resultId: id(6) } });
    expect(f.raw()).toBeNull(); expect(f.fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(["POST", "GET"]);
  });
  it.each([undefined, null, falseHash, trueHash.toUpperCase(), "short", { hash: trueHash }])(
    "rejects absent or invalid verified proof %j without falling back", async proof => {
      const fetcher = vi.fn<typeof fetch>(async () => wire({ ...accepted, verified_intent_hash: proof }));
      await expect(apiFor(fetcher).status("synthetic", "synthetic", command(true))).rejects.toMatchObject({ kind: "invalid_response" });
      expect(fetcher).toHaveBeenCalledOnce(); expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    });
  it("fails closed before fetch if WebCrypto is unavailable", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(Error("synthetic crypto unavailable"));
    try { await expect(apiFor(fetcher).status("synthetic", "synthetic", command(true))).rejects.toThrow(); }
    finally { digest.mockRestore(); }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses canonical UUIDs and ignores command identity while preserving the complete service intent", async () => {
    const upper = { ...intent(true), session_id: session.toUpperCase(), assignment_id: assignment.toUpperCase(), command_id: id(99) };
    expect(await oralIntentHash(upper)).toBe(trueHash);
    expect(await oralIntentHash(intent(false))).toBe(falseHash);
    expect(await oralIntentHash({ ...intent(true), session_id: id(77) })).not.toBe(trueHash);
    expect(await oralIntentHash({ ...intent(true), assignment_id: id(78) })).not.toBe(trueHash);
  });
  it("freezes the addressed intent before asynchronous hashing", async () => {
    const original = command(true), fetcher = vi.fn<typeof fetch>(async () => wire(accepted));
    const work = apiFor(fetcher).status("synthetic", "synthetic", original);
    original.session_id = id(77); original.command_id = id(78); Object.assign(original.payload, { correct: false });
    expect(await work).toMatchObject({ outcome: "accepted", command: { id: id(4) } });
    const url = new URL(String(fetcher.mock.calls[0][0]), "https://synthetic.invalid");
    expect(url.pathname).toBe(`/api/v1/commands/${id(4)}`); expect(url.searchParams.get("session_id")).toBe(session);
    expect(url.searchParams.get("expected_intent_hash")).toBe(trueHash);
  });
});
