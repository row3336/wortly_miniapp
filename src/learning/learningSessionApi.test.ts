import { previewContent } from "./learningPreview.test-support";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { LearningSessionProjection, Profile } from "../api/generated";
import { createLearningSessionApi, type LearningSessionCommand } from "./learningSessionApi";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = { client_instance_id: id(1), document_id: id(2), session_id: id(3) };
const base = { ...origin, command_id: id(4) };
const commands: LearningSessionCommand[] = [
  { ...base, kind: "session.start", payload: { mode: "learning" } },
  { ...base, kind: "learning.preview_next", preview_id: id(5), payload: {} },
  { ...base, kind: "learning.known", preview_id: id(5), payload: {} },
  { ...base, kind: "assignment.present", assignment_id: id(6), payload: {} },
  { ...base, kind: "session.stop", payload: { reason: "stop" } },
  { ...base, kind: "session.stop", payload: { reason: "summary_home" } },
];
const preview = (): LearningSessionProjection => ({ session_id: id(3), mode: "learning", status: "active",
  pair: "ru-de", local_date: "2026-09-30", close_reason: null,
  group: { id: id(10), status: "assembling", version: "1", preview_position: 0, total: 2 },
  preview: { id: id(5), card_id: id(11), position: 1, total: 2, content: previewContent(id(11)) }, assignment: null });
function question(): LearningSessionProjection {
  return { ...preview(), preview: null, group: { ...preview().group, status: "active", preview_position: 2 },
    assignment: { id: id(6), card_id: id(11), kind: "learning", status: "prefetched",
      prompt: { text: "дом", language: "ru", translations: ["дом"], personal_translation_version: null,
        conjunction_hint: null }, answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } } };
}
const profile: Profile = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: "3", access: { status: "admitted", version: "1", reason: null } };
function response(command = commands[0], current: unknown = preview(), status: "applied" | "already_applied" = "applied") {
  return { current, state_version: "3", error: null, command: { id: command.command_id, kind: command.kind, status,
    applied_at: "2026-09-30T12:00:00Z", target_id: "preview_id" in command ? command.preview_id
      : "assignment_id" in command ? command.assignment_id : command.session_id,
    action_id: null, result_id: null, context_id: null, object_version: "preview_id" in command ? "2" : null } };
}
function fixture(value: unknown = response(), status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  const api = createLearningSessionApi({ fetcher, timeoutMs: 100, maxResponseBytes: 10000, gate: testGate() });
  return { api, fetcher };
}

describe("Learning session HTTP adapter", () => {
  it.each(["send", "status"] as const)("rejects extra envelope data during %s", async method => {
    const value = response(commands[0], preview(), method === "status" ? "already_applied" : "applied");
    const f = fixture({ ...value, unexpected_private_snapshot: { variants: ["hidden"] } });
    await expect((method === "status" ? readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket)) : f.api.send("token", "proof", commands[0]))).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([201, 202, 206])("rejects HTTP%s as command status confirmation", async status => {
    const f = fixture(response(commands[0], preview(), "already_applied"), status);
    await expect(readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each(commands)("sends $kind once and confirms the exact fact separately from current", async command => {
    const current = { ...preview(), preview: { ...preview().preview!, id: id(99) } };
    const f = fixture(response(command, current));
    const result = await f.api.send("synthetic-token", "synthetic-proof", command);
    expect(result.outcome).toBe("accepted"); expect(result.current).toEqual(current);
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/commands"); expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" });
    expect(JSON.parse(String(init?.body))).toEqual(command);
    expect(String(init?.body)).not.toMatch(/synthetic-token|synthetic-proof/);
  });

  it.each([preview(), question(), { ...question(), group: { ...question().group, status: "completed" } },
    { ...question(), status: "summary", assignment: null },
    { ...preview(), status: "closed", close_reason: "stop", preview: null },
    { session_id: id(3), status: "not_found" }, { session_id: id(3), status: "unavailable" }])(
    "reads only the addressed current state %j", async current => {
      const f = fixture({ current, state_version: "3" });
      expect(await f.api.read("token", "proof", origin)).toEqual({ current, state_version: "3" });
      const [url, init] = f.fetcher.mock.calls[0]; const parsed = new URL(String(url), "http://localhost");
      expect(parsed.pathname).toBe(`/api/v1/sessions/${origin.session_id}`);
      expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(1), document_id: id(2) });
      expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
      expect(init?.headers).toMatchObject({ "X-Origin-Proof": "proof" });
    });

  it.each(commands)("recovers $kind through GET without repeating the mutation", async command => {
    const value = response(command, preview(), "already_applied"), f = fixture(value);
    const result = await readWithTicket(command, (__command, __ticket) => f.api.status("token", "proof", __command, __ticket));
    expect(result.outcome).toBe("accepted"); expect(result.command).toEqual(value.command);
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(String(f.fetcher.mock.calls[0][0])).toContain(`/commands/${command.command_id}?`);
    expect(f.fetcher.mock.calls[0][1]?.method).toBe("GET");
    expect(f.fetcher.mock.calls[0][1]?.body).toBeUndefined();
  });

  it("an accepted fact without current rights does not restore a step", async () => {
    const f = fixture(response(commands[0], { status: "unavailable" }, "already_applied"));
    expect(await readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).toMatchObject({ outcome: "accepted", current: { status: "unavailable" } });
  });
  it("not-found remains unresolved and keeps the admitted profile separate", async () => {
    const f = fixture({ command: { id: id(4), status: "not_found" }, current: profile, state_version: "3" });
    expect(await readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).toEqual({ outcome: "not_found",
      command: { id: id(4), status: "not_found" }, current: profile, state_version: "3" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each([[409, "ASSIGNMENT_STALE", "rejected"], [409, "COMMAND_PAYLOAD_MISMATCH", "mismatch"],
    [403, "FORBIDDEN", "rejected"], [422, "VALIDATION_FAILED", "rejected"]] as const)(
    "distinguishes %s/%s from accepted and unknown outcomes", async (status, code, outcome) => {
      const f = fixture({ command: { id: id(4), status: "rejected" }, current: preview(), state_version: "3", error: { code } }, status);
      expect(await f.api.send("token", "proof", commands[0])).toMatchObject({ outcome, error: { code } });
      expect(f.fetcher).toHaveBeenCalledOnce();
    });

  const badFacts = [
    { id: id(90) }, { kind: "session.stop" }, { target_id: id(90) }, { status: "not_found" },
    { applied_at: "2026-02-30T12:00:00Z" }, { applied_at: "2026-09-30T12:00:00+02:00" },
    { result_id: id(90) }, { action_id: id(90) }, { context_id: id(90) }, { object_version: "4" },
  ];
  it.each(badFacts)("rejects a malformed or wrongly addressed acceptance fact %j", async change => {
    const value = response(); Object.assign(value.command, change);
    const f = fixture(value); await expect(f.api.send("token", "proof", commands[0])).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each(["0", "9223372036854775808", 3, null])("refuses invalid server version %s", async value => {
    const f = fixture({ ...response(), state_version: value });
    await expect(f.api.send("token", "proof", commands[0])).rejects.toMatchObject({ kind: "invalid_response" });
  });

  const invalidCurrent: [string, (value: Record<string, any>) => void][] = [
    ["foreign session", value => { value.session_id = id(90); }],
    ["wrong mode", value => { value.mode = "written"; }],
    ["impossible date", value => { value.local_date = "2026-02-30"; }],
    ["unapproved content", value => { value.preview.content = { lemma: "hidden" }; }],
    ["invalid group version", value => { value.group.version = "0"; }],
    ["past end of group", value => { value.group.preview_position = 4; }],
    ["wrong preview position", value => { value.preview.position = 2; }],
    ["inconsistent total", value => { value.preview.total = 3; }],
    ["closed with preview", value => { value.status = "closed"; value.close_reason = "stop"; }],
    ["active without step", value => { value.preview = null; }],
    ["two active steps", value => { value.assignment = question().assignment; }],
  ];
  it.each(invalidCurrent)("rejects inconsistent or private current: %s", async (_name, mutate) => {
    const current = preview(); mutate(current);
    const f = fixture({ current, state_version: "3" });
    await expect(f.api.read("token", "proof", origin)).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([["word", ["word"]], ["forms", ["Singular", "Plural"]], ["phrase", ["Satz"]]] as const)(
    "accepts a Learning %s question, phrases included (K04-105)", async (kind, labels) => {
      const current = question();
      current.assignment!.answer_spec = { kind, labels: [...labels], part_count: labels.length, case_sensitive: true };
      const f = fixture({ current, state_version: "3" });
      expect((await f.api.read("token", "proof", origin)).current).toEqual(current);
    });
  it.each(["answers", "wrong_language", "wrong_kind", "wrong_count", "unknown_spec"])("refuses an unsafe question: %s", async problem => {
    const current = question();
    if (problem === "answers") Object.assign(current.assignment!.answer_spec, { variants: [{ parts: ["Haus"] }] });
    if (problem === "wrong_language") current.assignment!.prompt.language = "en";
    if (problem === "wrong_kind") current.assignment!.kind = "original";
    if (problem === "wrong_count") current.assignment!.answer_spec.part_count = 3;
    if (problem === "unknown_spec") Object.assign(current.assignment!.answer_spec, { kind: "sentence" });
    const f = fixture({ current, state_version: "3" });
    await expect(f.api.read("token", "proof", origin)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each(["send", "status"] as const)("HTTP200 with an error never establishes success in %s", async method => {
    const f = fixture({ ...response(commands[0], preview(), method === "status" ? "already_applied" : "applied"),
      error: { code: "WRITE_UNAVAILABLE" } });
    await expect((method === "status" ? readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket)) : f.api.send("token", "proof", commands[0]))).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([401, 403, 500, 503])("HTTP%s without a trusted outcome stays a transport refusal", async status => {
    const f = fixture({ error: { code: "WRITE_UNAVAILABLE" } }, status);
    await expect(f.api.send("token", "proof", commands[0])).rejects.toMatchObject({ kind: "http", status });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("a network failure never retries the command", async () => {
    const f = fixture(); f.fetcher.mockRejectedValueOnce(new TypeError("synthetic network"));
    await expect(f.api.send("token", "proof", commands[0])).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("freezes a command before awaiting and never puts proof in the body or URL", async () => {
    const original = structuredClone(commands[1]), saved = structuredClone(original);
    const f = fixture(); let finish!: (response: Response) => void;
    f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = f.api.send("token", "proof", original);
    original.command_id = id(100); Object.assign(original.payload, { unexpected: true });
    finish(new Response(JSON.stringify(response(saved))));
    expect((await pending).command.id).toBe(saved.command_id);
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual(saved);
    expect(String(f.fetcher.mock.calls[0][0])).not.toContain("proof");
  });
  it.each([{ ...commands[0], payload: { mode: "written", bucket: "words" } },
    { ...commands[0], payload: { mode: "learning", size: 3 } },
    { ...commands[1], preview_id: "bad" }, { ...commands[3], payload: { answered: true } },
    { ...commands[4], payload: { reason: "midnight" } }, { ...commands[0], document_id: "bad" },
    { ...commands[0], proof: "extra" }])("invalid outgoing values fail before fetch: %j", async command => {
      const f = fixture(); await expect(f.api.send("token", "proof", command as LearningSessionCommand)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  it.each([["", "proof"], ["token", ""]])("requires authentication and origin proof", async (token, proof) => {
    const f = fixture(); await expect(f.api.read(token, proof, origin)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

const missing = (closed_session: unknown) => ({ command: { id: id(4), status: "not_found" },
  state_version: "3", current: profile, closed_session });
describe("Learning session missing-command closure", () => {
  it.each(["stop", "midnight", "pair_changed", "timezone_date_changed", "remote_stop", "summary_home"])(
    "reads a minimal exact-session closure after %s", async reason => {
      const value = missing({ session_id: id(3), status: "closed", close_reason: reason }), f = fixture(value);
      expect(await readWithTicket(commands[1], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).toEqual({ ...value, outcome: "not_found" });
      const parsed = new URL(String(f.fetcher.mock.calls[0][0]), "http://localhost");
      expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(1), document_id: id(2), session_id: id(3) });
      expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.fetcher.mock.calls[0][1]?.method).toBe("GET");
    });
  it.each([null, {}, { session_id: id(99), status: "closed", close_reason: "stop" },
    { session_id: id(3), status: "active", close_reason: "stop" },
    { session_id: id(3), status: "closed", close_reason: null },
    { session_id: id(3), status: "closed", close_reason: "unknown" },
    { session_id: id(3), status: "closed", close_reason: "stop", assignment: {} }])(
    "rejects malformed or foreign closure %j", async closed => {
      const f = fixture(missing(closed));
      await expect(readWithTicket(commands[1], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
    });
});

/** core identity.intent_hash of the start of commands[0], computed here apart from the client's own canonical JSON. */
const startHash = createHash("sha256").update(`{"kind":"session.start","payload":{"mode":"learning","session_id":"${id(3)}"}}`).digest("hex");
/** command_status._refused_start with expected_intent_hash: a stored final refusal of the start of commands[0]. */
const refusal = (code = "SETUP_REQUIRED", current: unknown = { session_id: id(3), status: "not_found" }): Record<string, unknown> => ({
  command: { id: id(4), kind: "session.start", status: "rejected", refused_at: "2026-09-30T12:00:00Z" },
  error: { code }, current, state_version: "3", verified_intent_hash: startHash });
describe("Learning start status with its stored final refusal (C197)", () => {
  it("asks only a start for its refusal, with the core's intent hash of that start", async () => {
    const f = fixture(missing(undefined));
    await readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket));
    const query = Object.fromEntries(new URL(String(f.fetcher.mock.calls[0][0]), "http://localhost").searchParams);
    expect(query).toEqual({ client_instance_id: id(1), document_id: id(2), session_id: id(3), include_refusal: "true",
      expected_intent_hash: startHash });
  });
  it.each(commands.slice(1))("sends no refusal request for $kind and reads a rejected status as invalid", async command => {
    const f = fixture(refusal());
    await expect(readWithTicket(command, (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
    const query = Object.fromEntries(new URL(String(f.fetcher.mock.calls[0][0]), "http://localhost").searchParams);
    expect(query).toEqual({ client_instance_id: id(1), document_id: id(2), session_id: id(3) });
  });
  it("a core that does not read include_refusal keeps answering not_found, as before", async () => {
    const f = fixture(missing(undefined));
    expect(await readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).toMatchObject({ outcome: "not_found" });
  });
  it.each([["SETUP_REQUIRED", { session_id: id(3), status: "not_found" }], ["NO_MATERIAL", { session_id: id(3), status: "unavailable" }],
    ["SESSION_BUSY", { status: "unavailable" }]] as const)("reads a stored %s refusal of this start (current %j)", async (code, current) => {
    const f = fixture(refusal(code, current));
    expect(await readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).toEqual({ outcome: "rejected",
      command: { id: id(4), kind: "session.start", status: "rejected", refused_at: "2026-09-30T12:00:00Z" },
      error: { code }, current, state_version: "3" });
  });
  const broken: [string, (value: Record<string, unknown>) => void][] = [
    ["another command id", value => { (value.command as Record<string, unknown>).id = id(99); }],
    ["another kind", value => { (value.command as Record<string, unknown>).kind = "session.stop"; }],
    ["no refused_at", value => { delete (value.command as Record<string, unknown>).refused_at; }],
    ["a malformed refused_at", value => { (value.command as Record<string, unknown>).refused_at = "yesterday"; }],
    ["an extra fact field", value => { (value.command as Record<string, unknown>).target_id = id(3); }],
    ["no verified hash", value => { delete value.verified_intent_hash; }],
    ["another intent hash", value => { value.verified_intent_hash = "0".repeat(64); }],
    ["a stored code the core never keeps", value => { value.error = { code: "ASSIGNMENT_STALE" }; }],
    ["an unknown code", value => { value.error = { code: "MAINTENANCE" }; }],
    ["no error", value => { delete value.error; }],
    ["an extra error field", value => { value.error = { code: "SETUP_REQUIRED", message: "x" }; }],
    ["a real session of another number as current", value => { value.current = { ...preview(), session_id: id(99) }; }],
    ["another number as current", value => { value.current = { session_id: id(99), status: "not_found" }; }],
    ["a profile as current", value => { value.current = profile; }],
    ["an extra envelope field", value => { value.closed_session = null; }],
    ["a bad state version", value => { value.state_version = "0"; }],
  ];
  it.each([["SESSION_CLOSED", { session_id: id(3), status: "not_found" }],
    ["SESSION_CLOSED", { ...preview(), status: "closed", close_reason: "stop", preview: null }],
    ["SETUP_REQUIRED", preview()]] as const)("reads every final code the core stores, with this number's real current too: %s %j",
    async (code, current) => {
      const f = fixture(refusal(code, current));
      expect(await readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).toMatchObject({ outcome: "rejected", error: { code }, current });
    });
  it.each(broken)("proves no refusal with %s", async (_name, mutate) => {
    const value = refusal(); mutate(value);
    const f = fixture(value);
    await expect(readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).rejects.toThrow();
  });
  it("a refusal with an error status stays a transport refusal", async () => {
    const f = fixture(refusal(), 409);
    await expect(readWithTicket(commands[0], (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).rejects.toMatchObject({ kind: "http", status: 409 });
  });
  it("a fact of the start keeps its precedence; its echoed hash must be this start's", async () => {
    const fact = { ...response(commands[0], preview(), "already_applied"), verified_intent_hash: startHash };
    expect(await readWithTicket(commands[0], (__command, __ticket) => fixture(fact).api.status("token", "proof", __command, __ticket))).toMatchObject({ outcome: "accepted" });
    await expect(readWithTicket(commands[0], (__command, __ticket) => fixture({ ...fact, verified_intent_hash: "0".repeat(64) }).api.status("token", "proof", __command, __ticket)))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
});
