// session.cancel_start over HTTP (D-CP2C-START 2.4.1–2.4.2, tests 3.3.13–3.3.14; M-CP2C-START CP1).
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Profile, SessionCancelStartCommand } from "../api/generated";
import { ApiError } from "../api/http";
import { createStartCancelApi, startCancelIntent, startCancelIntentHash } from "./startCancelApi";
import { readWithTicket, testGate } from "./testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COMMAND: SessionCancelStartCommand = { command_id: id(5), client_instance_id: id(1), document_id: id(2),
  session_id: id(3), kind: "session.cancel_start", payload: {} };
/** core identity.intent_hash("session.cancel_start", {"session_id": id(3)}), computed by the core itself (WORKLOG 19:20). */
const CORE_HASH = "3c338cee431a8267bc58946646040d0648eb7d7de68a1e6bbe786619dc82e8f8";
/** The same function over an empty payload: what a client that hashed the body's payload would send. */
const EMPTY_PAYLOAD_HASH = "342c39bcba2dde350787234a47a653b6b1e2ac39cb88e762f2e8d997f2f0dec9";
const profile: Profile = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: "3", access: { status: "admitted", version: "1", reason: null } };

function fact(status: "applied" | "already_applied", patch: Record<string, unknown> = {}) {
  return { id: COMMAND.command_id, kind: "session.cancel_start", status, applied_at: "2026-10-08T12:00:00Z",
    target_id: COMMAND.session_id, action_id: null, result_id: null, context_id: null, object_version: null, ...patch };
}
const reply = (current: unknown = { session_id: id(3), outcome: "cancelled" }, patch: Record<string, unknown> = {}) =>
  ({ command: fact("applied"), current, state_version: "4", ...patch });
const found = (current: unknown = { session_id: id(3), outcome: "cancelled" }, patch: Record<string, unknown> = {}) =>
  ({ command: fact("already_applied"), current, state_version: "4", verified_intent_hash: CORE_HASH, ...patch });
const missing = (patch: Record<string, unknown> = {}) =>
  ({ command: { id: COMMAND.command_id, status: "not_found" }, current: profile, state_version: "4", ...patch });

function fixture(value: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  return { api: createStartCancelApi({ fetcher, timeoutMs: 100, maxResponseBytes: 10000, gate: testGate() }), fetcher };
}

describe("the cancel body and fingerprint (3.3.13)", () => {
  it("POST: a new command_id of the cancel, the session_id in the envelope, an empty payload, the installation proof", async () => {
    const f = fixture(reply());
    const result = await f.api.send("synthetic-token", "synthetic-proof", COMMAND);
    expect(result).toMatchObject({ outcome: "accepted", current: { session_id: id(3), outcome: "cancelled" }, state_version: "4" });
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/commands");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" });
    // The exact body the core accepts (C/tests/identity/test_session_start_cancel_api.py cancel_body).
    expect(JSON.parse(String(init?.body))).toEqual({ command_id: id(5), client_instance_id: id(1), document_id: id(2),
      session_id: id(3), kind: "session.cancel_start", payload: {} });
  });

  it("refuses to send a payload with the number (the core answers 422) or any other shape", async () => {
    const f = fixture(reply());
    const wrong: unknown[] = [{ ...COMMAND, payload: { session_id: id(3) } }, { ...COMMAND, payload: null },
      { ...COMMAND, kind: "session.start" }, { ...COMMAND, session_id: "not-a-uuid" }, { ...COMMAND, extra: 1 },
      { ...COMMAND, command_id: COMMAND.session_id }];
    for (const command of wrong) {
      await expect(f.api.send("t", "p", command as SessionCancelStartCommand)).rejects.toThrow("invalid session.cancel_start");
      await expect(readWithTicket(command as SessionCancelStartCommand, (__command, __ticket) => f.api.status("t", "p", __command, __ticket))).rejects.toThrow("invalid session.cancel_start");
    }
    await expect(f.api.send("", "p", COMMAND)).rejects.toThrow();
    await expect(f.api.send("t", "", COMMAND)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("the fingerprint is the core's hash of {kind, payload: {session_id}}, not of the empty body payload", async () => {
    const canonical = `{"kind":"session.cancel_start","payload":{"session_id":"${id(3)}"}}`;
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(CORE_HASH);
    expect(await startCancelIntentHash(id(3))).toBe(CORE_HASH);
    // The core writes str(UUID): lower case. A number with hex letters, as the core hashes it (QA14, recomputed by the core).
    const lettered = "abcdefab-0000-4000-8000-0000000000ff";
    const letteredHash = "db1a5dc7f90ae9f9c084bbfcbfb6a9008da520b2e8f6c1c9a654d2a5b8f281e2";
    expect(await startCancelIntentHash(lettered)).toBe(letteredHash);
    expect(await startCancelIntentHash(lettered.toUpperCase())).toBe(letteredHash);
    expect(CORE_HASH).not.toBe(EMPTY_PAYLOAD_HASH);
  });

  it("GET by the cancel's own ID with the origin, the session number and the expected fingerprint", async () => {
    const f = fixture(found());
    const result = await readWithTicket(COMMAND, (__command, __ticket) => f.api.status("synthetic-token", "synthetic-proof", __command, __ticket));
    expect(result).toMatchObject({ outcome: "accepted", current: { session_id: id(3), outcome: "cancelled" } });
    const [url, init] = f.fetcher.mock.calls[0];
    const parsed = new URL(String(url), "https://wortly.test");
    expect(parsed.pathname).toBe(`/api/v1/commands/${id(5)}`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(1), document_id: id(2),
      session_id: id(3), expected_intent_hash: CORE_HASH });
    expect(init?.method).toBe("GET");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" });
  });

  it("a fact without the same verified fingerprint is not this cancel", async () => {
    for (const value of [found(undefined, { verified_intent_hash: EMPTY_PAYLOAD_HASH }), found(undefined, { verified_intent_hash: null })]) {
      await expect(readWithTicket(COMMAND, (__command, __ticket) => fixture(value).api.status("t", "p", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
    }
    const { verified_intent_hash: _hash, ...without } = found();
    await expect(readWithTicket(COMMAND, (__command, __ticket) => fixture(without).api.status("t", "p", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("the intent helper builds exactly that cancel", () => {
    expect(startCancelIntent(id(5), id(3))).toEqual({ command_id: id(5), session_id: id(3), kind: "session.cancel_start", payload: {} });
  });
});

describe("the cancel reply", () => {
  it.each([
    [{ session_id: id(3), outcome: "cancelled" }],
    [{ session_id: id(3), outcome: "session_exists" }],
    // Hidden from a document that is not the live one: the fact exists, the outcome is not shown.
    [{ session_id: id(3), status: "unavailable" }],
  ])("accepts the fact with its view %#", async current => {
    const result = await fixture(reply(current)).api.send("t", "p", COMMAND);
    expect(result).toMatchObject({ outcome: "accepted", current });
    const again = await fixture(reply(current, { command: fact("already_applied"), error: null })).api.send("t", "p", COMMAND);
    expect(again).toMatchObject({ outcome: "accepted", current });
  });

  it("a business refusal keeps its code; another payload under the same ID is a mismatch", async () => {
    const refusal = (code: string, status: number) => fixture({ command: { id: id(5), status: "rejected" },
      current: { session_id: id(3), status: "unavailable" }, state_version: "4", error: { code } }, status);
    expect(await refusal("DOCUMENT_STALE", 409).api.send("t", "p", COMMAND)).toMatchObject({ outcome: "rejected", error: { code: "DOCUMENT_STALE" } });
    expect(await refusal("FORBIDDEN", 403).api.send("t", "p", COMMAND)).toMatchObject({ outcome: "rejected", error: { code: "FORBIDDEN" } });
    expect(await refusal("COMMAND_PAYLOAD_MISMATCH", 409).api.send("t", "p", COMMAND)).toMatchObject({ outcome: "mismatch" });
  });

  it("a refusal without a command fact (validation, an older core) is an HTTP error with its code", async () => {
    await expect(fixture({ error: { code: "VALIDATION_FAILED" } }, 422).api.send("t", "p", COMMAND))
      .rejects.toMatchObject({ kind: "http", status: 422, code: "VALIDATION_FAILED" });
    await expect(fixture({ error: { code: "MAINTENANCE", wait_seconds: 30 } }, 503).api.send("t", "p", COMMAND))
      .rejects.toMatchObject({ kind: "http", status: 503, code: "MAINTENANCE", pause: { waitSeconds: 30 } });
  });

  it.each([
    ["an extra key", reply(undefined, { extra: 1 })],
    ["a foreign session_id", reply({ session_id: id(9), outcome: "cancelled" })],
    ["an unknown outcome", reply({ session_id: id(3), outcome: "refused" })],
    ["a view without the number", reply({ status: "unavailable" })],
    ["not_found as a view", reply({ session_id: id(3), status: "not_found" })],
    ["a fact of another ID", reply(undefined, { command: fact("applied", { id: id(8) }) })],
    ["a fact of another kind", reply(undefined, { command: fact("applied", { kind: "session.start" }) })],
    ["a fact of another target", reply(undefined, { command: fact("applied", { target_id: id(9) }) })],
    ["a fact with an object version", reply(undefined, { command: fact("applied", { object_version: "1" }) })],
    ["a missing state version", reply(undefined, { state_version: undefined })],
    ["an error beside an acceptance", reply(undefined, { error: { code: "SESSION_BUSY" } })],
  ])("3.3.14 %s is an invalid response, never an outcome", async (_name, value) => {
    await expect(fixture(value).api.send("t", "p", COMMAND)).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("the cancel status", () => {
  it("not_found: the locked profile observation, nothing else", async () => {
    const result = await readWithTicket(COMMAND, (__command, __ticket) => fixture(missing()).api.status("t", "p", __command, __ticket));
    expect(result).toEqual({ outcome: "not_found", command: { id: id(5), status: "not_found" }, current: profile, state_version: "4" });
  });

  it("not_found with the closure of exactly this number is passed on as a fact", async () => {
    const closed = { session_id: id(3), status: "closed", close_reason: "stop" };
    expect(await readWithTicket(COMMAND, (__command, __ticket) => fixture(missing({ closed_session: closed })).api.status("t", "p", __command, __ticket))).toMatchObject({ closed_session: closed });
    await expect(readWithTicket(COMMAND, (__command, __ticket) => fixture(missing({ closed_session: { ...closed, session_id: id(9) } })).api.status("t", "p", __command, __ticket)))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("closed_session: null (allowed by generated.ts) means no closure, like an absent field", async () => {
    const result = await readWithTicket(COMMAND, (__command, __ticket) => fixture(missing({ closed_session: null })).api.status("t", "p", __command, __ticket));
    expect(result).toEqual({ outcome: "not_found", command: { id: id(5), status: "not_found" }, current: profile, state_version: "4" });
  });

  it("a found fact may hide its view altogether (no usable origin)", async () => {
    expect(await readWithTicket(COMMAND, (__command, __ticket) => fixture(found({ status: "unavailable" })).api.status("t", "p", __command, __ticket))).toMatchObject({ current: { status: "unavailable" } });
  });

  it.each([
    ["an extra key", found(undefined, { extra: 1 })],
    ["a foreign session_id", found({ session_id: id(9), outcome: "cancelled" })],
    ["an unknown outcome", found({ session_id: id(3), outcome: "unknown" })],
    ["a fresh 'applied' status", found(undefined, { command: fact("applied") })],
    ["not_found of another ID", missing({ command: { id: id(8), status: "not_found" } })],
    ["not_found with an extra key", missing({ extra: true })],
    ["not_found without a profile", missing({ current: { status: "unavailable" } })],
  ])("3.3.14 %s is an invalid response", async (_name, value) => {
    await expect(readWithTicket(COMMAND, (__command, __ticket) => fixture(value).api.status("t", "p", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("HTTP refusals stay HTTP errors (mismatch, stale document, access)", async () => {
    for (const [status, code] of [[409, "COMMAND_PAYLOAD_MISMATCH"], [409, "DOCUMENT_STALE"], [401, "UNAUTHORIZED"]] as const) {
      const error = await readWithTicket(COMMAND, (__command, __ticket) => fixture({ error: { code } }, status).api.status("t", "p", __command, __ticket)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ kind: "http", status, code });
    }
  });
});
