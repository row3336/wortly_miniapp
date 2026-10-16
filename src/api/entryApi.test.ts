import { describe, expect, it, vi } from "vitest";
import { createEntryApi, EntryApiError } from "./entryApi";
import { freshTestGate } from "../commands/testGate.test-support";

const sampleProfile = () => ({ profile_id: "profile", access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null, state_version: "1" });
const compatibility = { compatible: true, contract_version: "1" };
const openRequest = { client_instance_id: "client", document_id: "document", time_zone: "UTC",
  event: "open" as const, client_version: "0.0.0", contract_version: "1" };
const authRequest = { init_data: "synthetic", client_version: "0.0.0", contract_version: "1" };

function respondingWith(body: unknown) {
  return createEntryApi({ fetcher: vi.fn(async () => new Response(JSON.stringify(body))) as typeof fetch,
    timeoutMs: 1000, maxResponseBytes: 10000, gate: freshTestGate() });
}

describe("entry API transport", () => {
  it("sends auth without a token and keeps proof in the open header", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      if (_url.endsWith("/auth/telegram")) {
        expect(init.headers).not.toHaveProperty("Authorization");
        return new Response(JSON.stringify({
          access_token: "secret-token", expires_at: "2026-10-01T00:00:00Z",
          profile: { profile_id: "p", access: { status: "admitted", version: "1", reason: null }, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null, state_version: "1" },
          compatibility: { compatible: true, contract_version: "1" },
        }), { status: 200 });
      }
      expect(init.headers).toMatchObject({ Authorization: "Bearer secret-token", "X-Origin-Proof": "proof" });
      expect(JSON.stringify(init.body)).not.toContain("proof");
      return new Response(JSON.stringify({
        status: "SESSION_BUSY", profile: { profile_id: "p", access: { status: "admitted", version: "1", reason: null }, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null, state_version: "1" },
        session: { status: "busy" }, compatibility: { compatible: true, contract_version: "1" },
      }), { status: 200 });
    });
    const api = createEntryApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 10000, gate: freshTestGate() });
    const auth = await api.auth({ init_data: "signed", client_version: "0.0.0", contract_version: "1" });
    await api.open(auth.access_token, "proof", { client_instance_id: "c", document_id: "d", time_zone: "Europe/Berlin", event: "open", client_version: "0.0.0", contract_version: "1" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed success data rather than treating it as authorization", async () => {
    const api = createEntryApi({ fetcher: vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch, timeoutMs: 1000, maxResponseBytes: 10000, gate: freshTestGate() });
    await expect(api.auth({ init_data: "signed", client_version: "0.0.0", contract_version: "1" }))
      .rejects.toMatchObject({ kind: "invalid_response" } satisfies Partial<EntryApiError>);
  });

  it("enforces the supplied response limit", async () => {
    const api = createEntryApi({
      fetcher: vi.fn(async () => new Response("x".repeat(32), { status: 200 })) as typeof fetch,
      timeoutMs: 1000,
      maxResponseBytes: 16, gate: freshTestGate(),
    });
    await expect(api.auth({ init_data: "signed", client_version: "0.0.0", contract_version: "1" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
    expect(() => createEntryApi({ fetcher: fetch, timeoutMs: 0, maxResponseBytes: 16, gate: freshTestGate() })).toThrow();
  });

  it("preserves the bounded business code on an HTTP conflict", async () => {
    const api = createEntryApi({
      fetcher: vi.fn(async () => new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT" } }), { status: 409 })) as typeof fetch,
      timeoutMs: 1000, maxResponseBytes: 1000, gate: freshTestGate(),
    });
    await expect(api.reapply("token", { command_id: "intent", expected_access_version: "3" }))
      .rejects.toMatchObject({ kind: "http", status: 409, code: "VERSION_CONFLICT" });
  });

  it.each(["role", "ui_language", "dictionary_language", "access.status"])(
    "rejects an array in enum %s", async (key) => {
      const profile = sampleProfile();
      const malformed = key === "access.status"
        ? { ...profile, access: { ...profile.access, status: [profile.access.status] } }
        : { ...profile, [key]: [profile[key as keyof typeof profile]] };
      await expect(respondingWith({ access_token: "synthetic", expires_at: "2026-10-01T00:00:00Z",
        profile: malformed, compatibility }).auth(authRequest)).rejects.toMatchObject({ kind: "invalid_response" });
    });

  it.each([undefined, [], {}, { id: "session" }, { id: "", phase: "active" },
    { id: "session", phase: ["active"] }, { id: "session", phase: "closed" }])(
    "rejects malformed opened session %#", async (session) => {
      await expect(respondingWith({ status: "opened", profile: sampleProfile(), compatibility,
        client_instance_id: "client", document_id: "document", proof_version: "1", document_epoch: "1",
        session }).open("synthetic", "synthetic", openRequest)).rejects.toMatchObject({ kind: "invalid_response" });
    });

  it.each([null, { id: "session", phase: "active" }, { id: "session", phase: "summary" }])(
    "accepts the defined session states %#", async (session) => {
      const result = await respondingWith({ status: "opened", profile: sampleProfile(), compatibility,
        client_instance_id: "client", document_id: "document", proof_version: "1", document_epoch: "1",
        session }).open("synthetic", "synthetic", openRequest);
      expect(result.session).toEqual(session);
    });

  it.each(["2026-02-30T12:00:00Z", "2026-09-29T24:00:00Z", "2026-09-29T12:00:00+02:00", "not-a-date"])(
    "rejects invalid event time %s", async (expires_at) => {
      await expect(respondingWith({ access_token: "synthetic", expires_at,
        profile: sampleProfile(), compatibility }).auth(authRequest)).rejects.toMatchObject({ kind: "invalid_response" });
    });

  it.each([undefined, null, "11111111-1111-4111-8111-111111111111"])(
    "preserves an optional addressed remote-stop target %#", async (stop_remote_target) => {
      const session = { status: "busy", ...(stop_remote_target === undefined ? {} : { stop_remote_target }) };
      const result = await respondingWith({ status: "SESSION_BUSY", profile: sampleProfile(),
        compatibility, session }).open("synthetic", "synthetic", openRequest);
      expect(result.session).toEqual(session);
    });

  it.each([true, 1, "", "another-session", {}, [], ["11111111-1111-4111-8111-111111111111"]])(
    "rejects a malformed remote-stop target %#", async (stop_remote_target) => {
      await expect(respondingWith({ status: "SESSION_BUSY", profile: sampleProfile(), compatibility,
        session: { status: "busy", stop_remote_target } }).open("synthetic", "synthetic", openRequest))
        .rejects.toMatchObject({ kind: "invalid_response" });
    });

  it.each([
    { stop_remote_target: null, document_conflict: true, document_epoch: "1" },
    { stop_remote_target: "11111111-1111-4111-8111-111111111111", document_conflict: false, document_epoch: null },
    { stop_remote_target: null, document_conflict: false, document_epoch: "9223372036854775807" },
  ])("accepts the document conflict and its live epoch %#", async (fields) => {
    const session = { status: "busy", ...fields };
    const result = await respondingWith({ status: "SESSION_BUSY", profile: sampleProfile(),
      compatibility, session }).open("synthetic", "synthetic", openRequest);
    expect(result.session).toEqual(session);
  });

  it.each([
    { document_conflict: "true" }, { document_conflict: 1 }, { document_conflict: null },
    { document_epoch: 1 }, { document_epoch: "0" }, { document_epoch: "01" }, { document_epoch: "" },
    { document_epoch: "9223372036854775808" }, { document_epoch: ["1"] },
  ])("rejects a malformed document conflict %#", async (fields) => {
    await expect(respondingWith({ status: "SESSION_BUSY", profile: sampleProfile(), compatibility,
      session: { status: "busy", stop_remote_target: null, ...fields } }).open("synthetic", "synthetic", openRequest))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("incompatible client open and refusals of a write (M-COMPAT-HDR)", () => {
  const incompatible = (patch: Record<string, unknown> = {}) => ({ status: "incompatible", client_instance_id: "client",
    profile: sampleProfile(), session: null, compatibility: { compatible: false, contract_version: "2" }, ...patch });

  it.each([
    [{}], [{ session: { id: "s", phase: "active" } }], [{ session: { id: "s", phase: "summary" } }],
  ])("accepts the incompatible answer as its own status, not as an invalid response %#", async patch => {
    const result = await respondingWith(incompatible(patch)).open("synthetic", "synthetic", openRequest);
    expect(result).toMatchObject({ status: "incompatible", client_instance_id: "client" });
  });

  it.each([
    { client_instance_id: "" }, { client_instance_id: 1 }, { client_instance_id: undefined },
    { profile: { ...sampleProfile(), role: "admin" } }, { profile: undefined },
    { session: undefined }, { session: "s" }, { session: {} }, { session: { id: "s", phase: "closed" } },
    { session: { id: "", phase: "active" } },
    { compatibility: undefined }, { compatibility: { compatible: "no", contract_version: "2" } }, { compatibility: { compatible: false } },
  ])("keeps the incompatible answer strict %#", async patch => {
    await expect(respondingWith(incompatible(patch)).open("synthetic", "synthetic", openRequest))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("does not let an unknown status pass as incompatible", async () => {
    await expect(respondingWith(incompatible({ status: "incompatible_client" })).open("synthetic", "synthetic", openRequest))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("sends the contract version header on the writes of the entry flow", async () => {
    const seen: Record<string, string | null> = {};
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      seen[url] = new Headers(init.headers).get("X-Wortly-Contract-Version");
      return new Response(JSON.stringify({ error: { code: "CLIENT_INCOMPATIBLE" } }), { status: 409 });
    });
    const api = createEntryApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 1000, gate: freshTestGate(), contractVersion: "5" });
    await expect(api.reapply("t", { command_id: "c", expected_access_version: "1" })).rejects
      .toMatchObject({ kind: "http", status: 409, code: "CLIENT_INCOMPATIBLE" });
    await expect(api.open("t", "p", openRequest)).rejects.toMatchObject({ code: "CLIENT_INCOMPATIBLE" });
    expect(seen).toEqual({ "/api/v1/access/reapply": "5", "/api/v1/client/open": "5" });
  });

  it("carries the pause estimate of a paused reapply", async () => {
    const api = createEntryApi({ fetcher: vi.fn(async () => new Response(JSON.stringify({
      error: { code: "MAINTENANCE", estimated_end_at: "2026-10-07T12:00:00Z", wait_seconds: 40 } }),
      { status: 503, headers: { "Retry-After": "40" } })) as typeof fetch, timeoutMs: 1000, maxResponseBytes: 1000, gate: freshTestGate() });
    await expect(api.reapply("t", { command_id: "c", expected_access_version: "1" })).rejects.toMatchObject({
      kind: "http", status: 503, code: "MAINTENANCE", pause: { waitSeconds: 40 } });
  });
});
