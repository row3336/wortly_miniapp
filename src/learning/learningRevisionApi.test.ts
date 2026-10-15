import { describe, expect, it, vi } from "vitest";
import type { LearningAnswerResponse, ResultCorrectCommand, ResultGradeCommand } from "../api/generated";
import { createLearningResultApi } from "./learningAnswerApi";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Command = ResultCorrectCommand | ResultGradeCommand;
function command(kind: Command["kind"] = "result.correct"): Command {
  const target = { command_id: id(1), client_instance_id: id(2), document_id: id(3), session_id: id(4),
    assignment_id: id(5), result_id: id(6), expected_result_version: "1" };
  return kind === "result.correct" ? { ...target, kind, payload: {} } : { ...target, kind, payload: { grade: 5 } };
}
function response(original = command()): LearningAnswerResponse {
  const grade = original.kind === "result.correct" ? 4 : original.payload.grade;
  return { command: { id: original.command_id, kind: original.kind, status: "applied", applied_at: "2026-09-30T12:00:05Z",
    target_id: id(5), action_id: id(7), result_id: id(6), context_id: null, object_version: "2" },
    state_version: "9", action: { action_id: id(7), kind: "answer.submit", status: "active", version: "2" },
    result: { result_id: id(6), assignment_id: id(5), version: "2", grade: grade as 3 | 4 | 5, correct: true, status: "active",
      accepted_at: "2026-09-30T12:00:00Z", answer_date: "2026-09-30", detail: null },
    step: { session_id: id(4), status: "summary", mode: "learning", pair: "ru-de", local_date: "2026-09-30",
      close_reason: null, group: { id: id(8), status: "active", version: "3", preview_position: 1, total: 1 }, preview: null, assignment: null },
    capabilities: { answer_target: null, correct_target: null, undo_target: null, stop: true, summary_home: true,
      grades: { session_id: id(4), assignment_id: id(5), result_id: id(6), expected_result_version: "2", values: [3, 4, 5] } } };
}
function fixture(value: unknown = response(), status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  return { fetcher, api: createLearningResultApi({ fetcher, timeoutMs: 100, maxResponseBytes: 10000, gate: testGate() }) };
}

describe("Learning revision transport", () => {
  it.each([201, 202, 206])("rejects HTTP%s as revision status confirmation", async status => {
    const value = response(); Object.assign(value.command, { status: "already_applied" });
    await expect(readWithTicket(command(), (__command, __ticket) => fixture(value, status).api.status("token", "proof", __command, __ticket)))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each(["result.correct", "result.grade"] as const)("sends exact %s once with no new answer input", async kind => {
    const original = command(kind), value = response(original), f = fixture(value);
    expect(await f.api.send("token", "proof", original)).toEqual({ ...value, outcome: "accepted" });
    expect(f.fetcher).toHaveBeenCalledOnce(); const [url, options] = f.fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/commands"); expect(options?.method).toBe("POST");
    expect(JSON.parse(String(options?.body))).toEqual(original);
    expect(options?.headers).toMatchObject({ Authorization: "Bearer token", "X-Origin-Proof": "proof" });
    expect(String(options?.body)).not.toMatch(/token|proof|text|forgot/);
  });
  it.each(["result.correct", "result.grade"] as const)("recovers %s using only its original ID", async kind => {
    const original = command(kind), value = response(original); Object.assign(value.command, { status: "already_applied" });
    const f = fixture(value), parsed = await readWithTicket(original, (__command, __ticket) => f.api.status("token", "proof", __command, __ticket));
    expect(parsed).toEqual({ ...value, outcome: "accepted" });
    expect(f.fetcher).toHaveBeenCalledOnce(); const [url, options] = f.fetcher.mock.calls[0];
    const address = new URL(String(url), "http://localhost");
    expect(address.pathname).toBe(`/api/v1/commands/${id(1)}`);
    expect(Object.fromEntries(address.searchParams)).toEqual({ client_instance_id: id(2), document_id: id(3), session_id: id(4) });
    expect(options?.method).toBe("GET"); expect(options?.body).toBeUndefined();
  });
  it("keeps an older accepted correction separate from a newer grade", async () => {
    const value = response(); Object.assign(value.command, { status: "already_applied" });
    value.result!.version = value.action!.version = value.capabilities.grades!.expected_result_version = "3";
    value.result!.grade = 3;
    const parsed = await readWithTicket(command(), (__command, __ticket) => fixture(value).api.status("token", "proof", __command, __ticket));
    expect(parsed.command).toMatchObject({ kind: "result.correct", object_version: "2" });
    if (parsed.outcome === "accepted") expect(parsed.result).toMatchObject({ grade: 3, version: "3" });
  });
  it("accepts a no-op grade fact at the expected version", async () => {
    const original = command("result.grade"), value = response(original);
    Object.assign(value.command, { object_version: "1" });
    value.result!.version = value.action!.version = value.capabilities.grades!.expected_result_version = "1";
    expect((await fixture(value).api.send("token", "proof", original)).outcome).toBe("accepted");
  });
  it.each(["result.correct", "result.grade"] as const)("can recover %s without old detail or rights", async kind => {
    const original = command(kind), value = response(original); Object.assign(value.command, { status: "already_applied" });
    value.result = value.action = null; value.step = { status: "unavailable" };
    value.capabilities = { answer_target: null, grades: null, correct_target: null, undo_target: null, stop: false, summary_home: false };
    expect((await readWithTicket(original, (__command, __ticket) => fixture(value).api.status("token", "proof", __command, __ticket))).outcome).toBe("accepted");
    Object.assign(value.command, { result_id: id(99) });
    await expect(readWithTicket(original, (__command, __ticket) => fixture(value).api.status("token", "proof", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
  });
  const damages: [string, (value: LearningAnswerResponse) => void][] = [
    ["command ID", value => { value.command.id = id(99); }],
    ["command kind", value => { Object.assign(value.command, { kind: "result.grade" }); }],
    ["target", value => { Object.assign(value.command, { target_id: id(99) }); }],
    ["fact result", value => { Object.assign(value.command, { result_id: id(99) }); }],
    ["current result", value => { value.result!.result_id = id(99); }],
    ["action", value => { Object.assign(value.command, { action_id: id(99) }); }],
    ["future fact", value => { Object.assign(value.command, { object_version: "3" }); }],
    ["no-op correction", value => { Object.assign(value.command, { object_version: "1" }); }],
    ["wrong accepted grade", value => { value.result!.grade = 5; }],
    ["old current", value => { value.result!.version = value.action!.version = value.capabilities.grades!.expected_result_version = "1"; }],
    ["error on HTTP200", value => { value.error = { code: "FORBIDDEN" }; }],
  ];
  it.each(damages)("rejects inconsistent %s", async (_name, damage) => {
    const value = response(); damage(value);
    await expect(fixture(value).api.send("token", "proof", command())).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each(["result.correct", "result.grade"] as const)("supports large exact version strings for %s", async kind => {
    const original = { ...command(kind), expected_result_version: "9007199254740993" }, value = response(original);
    Object.assign(value.command, { object_version: "9007199254740994" });
    value.result!.version = value.action!.version = value.capabilities.grades!.expected_result_version = "9007199254740994";
    expect((await fixture(value).api.send("token", "proof", original)).outcome).toBe("accepted");
  });
  it.each([{}, { closed_session: { session_id: id(4), status: "closed", close_reason: "stop" } }])(
    "keeps not-found separate, with optional final closure %j", async extra => {
      const value = { command: { id: id(1), status: "not_found" }, state_version: "8",
        current: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
          state_version: "8", access: { status: "admitted", version: "1", reason: null } }, ...extra };
      const f = fixture(value); expect(await readWithTicket(command(), (__command, __ticket) => f.api.status("token", "proof", __command, __ticket))).toEqual({ ...value, outcome: "not_found" });
      expect(f.fetcher).toHaveBeenCalledOnce();
    });
  it.each(["VERSION_CONFLICT", "FORBIDDEN", "COMMAND_PAYLOAD_MISMATCH"])("does not claim %s as acceptance", async code => {
    const value = response(); value.command = { id: id(1), status: "rejected" }; value.error = { code };
    const parsed = await fixture(value, code === "FORBIDDEN" ? 403 : 409).api.send("token", "proof", command());
    expect(parsed.outcome).toBe(code === "COMMAND_PAYLOAD_MISMATCH" ? "mismatch" : "rejected");
  });
  it("does not accept or automatically resend an acceptance-shaped HTTP503", async () => {
    const f = fixture(response(), 503);
    await expect(f.api.send("token", "proof", command())).rejects.toMatchObject({ status: 503 });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("captures version, target and grade before the first await", async () => {
    const original = command("result.grade"), expected = structuredClone(original), f = fixture(response(original));
    const call = f.api.send("token", "proof", original);
    original.result_id = id(99); original.expected_result_version = "2"; Object.assign(original.payload, { grade: 3 });
    expect((await call).outcome).toBe("accepted");
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual(expected);
  });
  it.each([
    { payload: { text: "Hallo" } }, { payload: { grade: 4 } }, { payload: { forgot: true } }, { payload: null },
    { expected_result_version: 1 }, { expected_result_version: "0" }, { expected_result_version: "1.0" },
    { result_id: "invalid" }, { token: "must-not-send" }, { proof: "must-not-send" }, { session_id: "" },
  ])("rejects invalid correction intent %j before HTTP", async changes => {
    const f = fixture(); await expect(f.api.send("token", "proof", { ...command(), ...changes } as Command)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([2, 6, true, "5", null, undefined, 4.5])("rejects invalid grade %j before HTTP", async grade => {
    const f = fixture(); await expect(f.api.send("token", "proof", { ...command("result.grade"), payload: { grade } } as Command)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

const address = () => ({ session_id: id(4), assignment_id: id(5), result_id: id(6), client_instance_id: id(2), document_id: id(3) });
function readValue() { const { command: _command, ...value } = response(); return value; }
describe("Addressed Learning result read", () => {
  it("reads the exact original result without a command or mutation", async () => {
    const value = readValue(), f = fixture(value);
    expect(await f.api.read("token", "proof", address())).toEqual(value);
    expect(f.fetcher).toHaveBeenCalledOnce(); const [url, options] = f.fetcher.mock.calls[0];
    const parsed = new URL(String(url), "http://localhost");
    expect(parsed.pathname).toBe(`/api/v1/sessions/${id(4)}`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ client_instance_id: id(2), document_id: id(3), assignment_id: id(5), result_id: id(6) });
    expect(options?.method).toBe("GET"); expect(options?.body).toBeUndefined();
    expect(options?.headers).toMatchObject({ Authorization: "Bearer token", "X-Origin-Proof": "proof" });
    expect(String(url)).not.toMatch(/token|proof|grade|command_id/);
  });
  it("does not infer a fact or substitute a result when the addressed result is absent", async () => {
    const value = readValue(); value.result = value.action = null; value.capabilities.grades = null;
    const parsed = await fixture(value).api.read("token", "proof", address());
    expect(parsed.result).toBeNull(); expect(parsed).not.toHaveProperty("command"); expect(parsed).not.toHaveProperty("outcome");
  });
  it("reads a newer version without claiming it is the pending command's effect", async () => {
    const value = readValue(); value.result!.version = value.action!.version = value.capabilities.grades!.expected_result_version = "5";
    const result = await fixture(value).api.read("token", "proof", address());
    expect(result.result?.version).toBe("5"); expect(result).not.toHaveProperty("outcome");
  });
  it.each(["result", "assignment", "session", "extra", "command"])("rejects wrong read response %s", async field => {
    const value = readValue();
    if (field === "result") value.result!.result_id = id(99);
    if (field === "assignment") value.result!.assignment_id = id(99);
    if (field === "session") Object.assign(value.step, { session_id: id(99) });
    if (field === "extra") Object.assign(value, { private: true });
    if (field === "command") Object.assign(value, { command: response().command });
    await expect(fixture(value).api.read("token", "proof", address())).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it.each([{ result_id: "" }, { assignment_id: null }, { session_id: 1 }, { command_id: id(90) }, { proof: "private" }])(
    "rejects invalid read address %j before HTTP", async changes => {
      const f = fixture(); await expect(f.api.read("token", "proof", { ...address(), ...changes } as ReturnType<typeof address>)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  it.each([401, 403, 409, 503])("does not treat HTTP%s as a usable result read", async status => {
    const f = fixture(readValue(), status); await expect(f.api.read("token", "proof", address())).rejects.toMatchObject({ status });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("copies the address before awaiting the response", async () => {
    const f = fixture(readValue()), original = address(), pending = f.api.read("token", "proof", original);
    original.result_id = id(99); original.assignment_id = id(99);
    expect((await pending).result?.result_id).toBe(id(6));
    expect(String(f.fetcher.mock.calls[0][0])).toContain(`result_id=${id(6)}`);
  });
});
