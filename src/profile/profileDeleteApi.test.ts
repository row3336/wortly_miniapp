import { describe, expect, it, vi } from "vitest";
import { POST_ROUTES, WriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";
import { testGate } from "../commands/testGate.test-support";
import { classifyDeleteReply, createProfileDeleteApi, type ProfileDeleteIntent } from "./profileDeleteApi";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const intent: ProfileDeleteIntent = { profileId: id(50), commandId: id(100) };
const credentials = { token: "token", proof: "proof", clientInstanceId: id(1) };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const error = (code: string, status: number) => response({ error: { code } }, status);
const appliedBody = (status = "applied", commandId = id(100)) => ({
  command: { id: commandId, kind: "profile.delete", status, applied_at: "2026-10-16T10:00:00Z" },
  deletion: { request_id: id(900), working_data: "deleted", archive: "pending", archive_deadline: "2026-10-23T10:00:00Z",
    fully_deleted: false },
  session: "revoked",
});

function api(reply: () => Response | Promise<Response>, gate: WriteGate = testGate()) {
  const fetcher = vi.fn<typeof fetch>(async () => reply());
  return { fetcher, api: createProfileDeleteApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate }) };
}

describe("POST /api/v1/profile/delete", () => {
  it("is a gated route of the client's POST registry (RD-7, default-deny)", () => {
    expect(POST_ROUTES["/profile/delete"]).toBe("gated");
  });

  it("sends exactly the four fields of ProfileDeleteRequest with the token, the proof and the contract version", async () => {
    const { api: client, fetcher } = api(() => response(appliedBody()));
    expect(await client.delete(credentials, intent)).toEqual({ outcome: "applied", status: "applied" });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe("/api/v1/profile/delete");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer token", "X-Origin-Proof": "proof", "X-Wortly-Contract-Version": "1" });
    expect(JSON.parse(String(init?.body))).toEqual({ command_id: id(100), confirmed_profile_id: id(50),
      confirmation: "delete_profile", client_instance_id: id(1) });
  });

  it("a closed gate keeps the request on the client: fetch is never called (PAUSED_BEFORE_SEND)", async () => {
    const gate = new WriteGate({ clock: new ManualClock() });
    gate.closeByMaintenance(null);
    const { api: client, fetcher } = api(() => response(appliedBody()), gate);
    expect(await client.delete(credentials, intent)).toEqual({ outcome: "paused" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["already_applied", () => response(appliedBody("already_applied")), { outcome: "applied", status: "already_applied" }],
    ["PROFILE_DELETED", () => error("PROFILE_DELETED", 403), { outcome: "applied", status: "profile_deleted" }],
    ["AUTH_EXPIRED", () => error("AUTH_EXPIRED", 401), { outcome: "auth", code: "AUTH_EXPIRED" }],
    ["AUTH_INVALID", () => error("AUTH_INVALID", 401), { outcome: "auth", code: "AUTH_INVALID" }],
    ["ACCESS_PENDING", () => error("ACCESS_PENDING", 403), { outcome: "refused", code: "ACCESS_PENDING" }],
    ["ACCESS_REJECTED", () => error("ACCESS_REJECTED", 403), { outcome: "refused", code: "ACCESS_REJECTED" }],
    ["FORBIDDEN (owner, proof sent)", () => error("FORBIDDEN", 403), { outcome: "refused", code: "FORBIDDEN" }],
    ["CLIENT_INCOMPATIBLE", () => error("CLIENT_INCOMPATIBLE", 409), { outcome: "refused", code: "CLIENT_INCOMPATIBLE" }],
    ["COMMAND_PAYLOAD_MISMATCH", () => error("COMMAND_PAYLOAD_MISMATCH", 409), { outcome: "defect", status: 409, code: "COMMAND_PAYLOAD_MISMATCH" }],
    ["VALIDATION_FAILED", () => error("VALIDATION_FAILED", 422), { outcome: "defect", status: 422, code: "VALIDATION_FAILED" }],
    ["MAINTENANCE", () => response({ error: { code: "MAINTENANCE", retry_after_s: 5 } }, 503), { outcome: "maintenance" }],
    ["WRITE_UNAVAILABLE", () => error("WRITE_UNAVAILABLE", 503), { outcome: "write_unavailable" }],
    ["503 without the core's body", () => new Response("down", { status: 503 }), { outcome: "unknown" }],
    ["502", () => new Response("", { status: 502 }), { outcome: "unknown" }],
    ["504", () => new Response("", { status: 504 }), { outcome: "unknown" }],
    ["408 (a lost answer, never a client defect)", () => error("REQUEST_TIMEOUT", 408), { outcome: "unknown" }],
    ["500 INTERNAL_ERROR (rolled back or not: unknown, never a refusal)", () => response({ error: { code: "INTERNAL_ERROR", diagnostic_id: "d" } }, 500), { outcome: "unknown" }],
    ["429", () => error("RATE_LIMITED", 429), { outcome: "unknown" }],
    ["200 of another command_id", () => response(appliedBody("applied", id(101))), { outcome: "unknown" }],
    ["200 saying fully deleted", () => response({ ...appliedBody(), deletion: { ...appliedBody().deletion, fully_deleted: true } }), { outcome: "unknown" }],
  ])("%s", async (_name, reply, expected) => {
    expect(await api(reply).api.delete(credentials, intent)).toEqual(expected);
  });

  it("a refused connection is an unknown outcome, never a refusal", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("offline"); });
    const client = createProfileDeleteApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    expect(await client.delete(credentials, intent)).toEqual({ outcome: "unknown" });
  });

  it("a 4xx without a readable body keeps its class by status", () => {
    expect(classifyDeleteReply({ status: 401, ok: false, value: undefined }, id(100))).toEqual({ outcome: "auth", code: null });
    expect(classifyDeleteReply({ status: 403, ok: false, value: undefined }, id(100))).toEqual({ outcome: "defect", status: 403, code: null });
  });
});

describe("the read that decides a defect code (GET /settings by the same session)", () => {
  it("a failed read (no connection) is «unknown», never «not deleted»", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("offline"); });
    const client = createProfileDeleteApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    expect(await client.check("token")).toBe("unknown");
  });
  it.each([
    ["200", () => response({ state_version: "3" }), "not_deleted"],
    ["PROFILE_DELETED", () => error("PROFILE_DELETED", 403), "deleted"],
    ["AUTH_INVALID", () => error("AUTH_INVALID", 401), "auth"],
    ["502", () => new Response("", { status: 502 }), "unknown"],
  ])("%s", async (_name, reply, expected) => {
    const { api: client, fetcher } = api(reply);
    expect(await client.check("token")).toBe(expected);
    expect(String(fetcher.mock.calls[0][0])).toBe("/api/v1/settings");
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
  });
});
