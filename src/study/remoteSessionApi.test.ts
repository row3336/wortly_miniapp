import { describe, expect, it, vi } from "vitest";
import type { SessionStopRemoteCommand } from "../api/generated";
import { createRemoteSessionApi } from "./remoteSessionApi";
import { testGate } from "../commands/testGate.test-support";

const ids = {
  command: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  session: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  client: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  document: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  profile: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};
function command(): SessionStopRemoteCommand {
  return { kind: "session.stop_remote", command_id: ids.command, session_id: ids.session,
    client_instance_id: ids.client, document_id: ids.document, payload: { confirmed: true } };
}
function accepted() {
  return { command: { id: ids.command, kind: "session.stop_remote", status: "applied",
    applied_at: "2026-09-30T12:00:00Z", target_id: ids.session, object_version: null,
    action_id: null, result_id: null, context_id: null },
  current: { session_id: ids.session, status: "closed", close_reason: "remote_stop" }, state_version: "8" };
}
function profile() {
  return { profile_id: ids.profile, access: { status: "admitted", version: "1", reason: null },
    role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "9" };
}
function apiFor(body: unknown, status = 200) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  return { fetcher, api: createRemoteSessionApi({ fetcher: fetcher as typeof fetch,
    timeoutMs: 1000, maxResponseBytes: 10000, gate: testGate() }) };
}

describe("addressed remote stop transport", () => {
  it("posts the exact confirmed command once and keeps proof out of its body", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/commands");
      expect(init.method).toBe("POST");
      expect(init.headers).toMatchObject({ Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" });
      expect(JSON.parse(init.body as string)).toEqual(command());
      return new Response(JSON.stringify(accepted()));
    });
    const api = createRemoteSessionApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 10000, gate: testGate() });
    const got = await api.stop("synthetic-token", "synthetic-proof", command());
    expect(got.outcome).toBe("accepted");
    expect(got.current).toEqual(accepted().current);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resolves a lost response with GET and the current document proof", async () => {
    const body = accepted(); body.command.status = "already_applied";
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url, "http://localhost");
      expect(parsed.pathname).toBe(`/api/v1/commands/${ids.command}`);
      expect(parsed.searchParams.get("client_instance_id")).toBe(ids.client);
      expect(parsed.searchParams.get("document_id")).toBe(ids.document);
      expect(url).not.toContain("synthetic-proof");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.headers).toMatchObject({ "X-Origin-Proof": "synthetic-proof" });
      return new Response(JSON.stringify(body));
    });
    const api = createRemoteSessionApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 10000, gate: testGate() });
    expect(await api.status("synthetic-token", "synthetic-proof", command())).toMatchObject({ outcome: "accepted" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["SESSION_CLOSED", "FORBIDDEN", "SESSION_BUSY", "COMMAND_PAYLOAD_MISMATCH"])(
    "distinguishes a confirmed refusal from ambiguous reused ID: %s", async (code) => {
      const { api } = apiFor({ command: { id: ids.command, status: "rejected" },
        current: { session_id: ids.session, status: "unavailable" }, state_version: "9", error: { code } },
      code === "FORBIDDEN" ? 403 : 409);
      expect(await api.stop("synthetic", "synthetic", command())).toMatchObject({
        outcome: code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected", error: { code },
      });
    });

  it("does not turn a not-found status into refusal or resend", async () => {
    const { api, fetcher } = apiFor({ command: { id: ids.command, status: "not_found" }, current: profile(), state_version: "9" });
    expect(await api.status("synthetic", "synthetic", command())).toMatchObject({ outcome: "not_found" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([{ status: "unavailable" }, { session_id: ids.session, status: "unavailable" },
    { session_id: ids.session, status: "not_found" }])("preserves an accepted fact with unavailable current %#", async (current) => {
    const body = accepted(); body.command.status = "already_applied";
    const { api } = apiFor({ ...body, current });
    expect(await api.status("synthetic", "synthetic", command())).toMatchObject({ outcome: "accepted", current });
  });

  it.each([
    { id: ids.session }, { target_id: ids.command }, { kind: "session.stop" }, { status: "rejected" },
    { object_version: "1" }, { action_id: ids.command }, { result_id: ids.command }, { context_id: ids.command },
    { applied_at: "2026-02-30T12:00:00Z" }, { applied_at: "2026-09-30T12:00:00+02:00" },
  ])("rejects an unrelated or malformed fact %#", async (changes) => {
    const body = accepted();
    const { api } = apiFor({ ...body, command: { ...body.command, ...changes } });
    await expect(api.stop("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("accepts save_failed as the close reason of the other device's session (R2a)", async () => {
    const { api } = apiFor({ ...accepted(), current: { session_id: ids.session, status: "closed", close_reason: "save_failed" } });
    await expect(api.stop("synthetic", "synthetic", command())).resolves.toMatchObject({ current: { close_reason: "save_failed" } });
  });

  it.each([
    { session_id: ids.command, status: "closed", close_reason: "remote_stop" },
    { session_id: ids.session, status: "active", close_reason: "remote_stop" },
    { session_id: ids.session, status: "closed", close_reason: null },
    { session_id: ids.session, status: "closed", close_reason: ["remote_stop"] },
    { session_id: ids.session, status: "closed", close_reason: "unknown" },
    { session_id: ids.session, status: "unavailable", assignment: {} },
    { session_id: ids.session, status: "closed", close_reason: "remote_stop", assignment: {} },
  ])("rejects wrong target or question-bearing remote data %#", async (current) => {
    const { api } = apiFor({ ...accepted(), current });
    await expect(api.stop("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([0, "0", "01", "9223372036854775808", null, []])("rejects malformed state version %#", async (state_version) => {
    const { api } = apiFor({ ...accepted(), state_version });
    await expect(api.stop("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([{ payload: { confirmed: false } }, { payload: { confirmed: 1 } }, { payload: {} },
    { payload: { confirmed: true, reason: "stop" } }, { session_id: "not-an-id" }, { client_instance_id: "" },
    { document_id: null }, { command_id: "" }, { profile_id: ids.profile }])(
    "refuses malformed outgoing commands before sending %#", async (changes) => {
      const { api, fetcher } = apiFor(accepted());
      const bad = { ...command(), ...changes } as unknown as SessionStopRemoteCommand;
      await expect(api.stop("synthetic", "synthetic", bad)).rejects.toThrow();
      await expect(api.status("synthetic", "synthetic", bad)).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    });

  it("does not accept an HTTP failure body as a successful confirmation", async () => {
    const { api } = apiFor(accepted(), 503);
    await expect(api.stop("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "http", status: 503 });
  });

  it("does not accept errors attached to a success as confirmation", async () => {
    const { api } = apiFor({ ...accepted(), error: { code: "SESSION_CLOSED" } });
    await expect(api.stop("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
    const body = accepted(); body.command.status = "already_applied";
    const recovered = apiFor({ ...body, error: { code: "SESSION_CLOSED" } });
    await expect(recovered.api.status("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("requires a recovered fact rather than an unrelated command or POST status", async () => {
    const { api } = apiFor(accepted());
    await expect(api.status("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
    const body = accepted(); body.command.status = "already_applied";
    const unrelated = apiFor({ ...body, command: { ...body.command, target_id: ids.command } });
    await expect(unrelated.api.status("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("keeps a network loss unresolved and never retries POST automatically", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("synthetic connection loss"); });
    const api = createRemoteSessionApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 10000, gate: testGate() });
    await expect(api.stop("synthetic", "synthetic", command())).rejects.toMatchObject({ kind: "network" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
