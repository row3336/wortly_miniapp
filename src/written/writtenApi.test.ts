import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createWrittenApi, validWrittenStep } from "./writtenApi";
import type { WrittenCommand } from "./writtenIntent";
import { id, response, writtenServer } from "./writtenFixtures.test-support";

const origin = { client_instance_id: id(1), document_id: id(2) };
function harness(options: Parameters<typeof writtenServer>[0] = {}) {
  const server = writtenServer(options);
  const fetcher = vi.fn<typeof fetch>(server.handle);
  const api = createWrittenApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 200000 });
  const send = (body: object) => api.send("token", "proof", { ...origin, ...body } as WrittenCommand);
  const start = (n = 10) => send({ command_id: id(n), session_id: id(3), kind: "session.start", payload: { mode: "written", bucket: "words" } });
  const present = (n = 11, assignment = 6) => send({ command_id: id(n), session_id: id(3), kind: "assignment.present", assignment_id: id(assignment), payload: {} });
  const answer = (text: string, n = 12, assignment = 6) => send({ command_id: id(n), session_id: id(3), kind: "answer.submit",
    assignment_id: id(assignment), payload: { text } });
  return { server, fetcher, api, send, start, present, answer };
}
const lastBody = (fetcher: ReturnType<typeof vi.fn<typeof fetch>>) => JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body));

describe("written HTTP adapter", () => {
  it("sends each command once to /commands with the origin and accepts only its exact fact", async () => {
    const h = harness();
    const started = await h.start();
    expect(String(h.fetcher.mock.calls[0][0])).toBe("/api/v1/commands");
    expect(lastBody(h.fetcher)).toEqual({ command_id: id(10), session_id: id(3), kind: "session.start", payload: { mode: "written", bucket: "words" }, ...origin });
    expect(started).toMatchObject({ outcome: "accepted", current: { status: "active", assignment: { id: id(6), status: "prefetched" } } });
    expect(await h.present()).toMatchObject({ outcome: "accepted", current: { assignment: { status: "presented" } } });
    const answered = await h.answer("Haus");
    expect(answered).toMatchObject({ outcome: "accepted", result: { grade: 4, version: "1" },
      step: { progress: { completed: 1, total: 2, correct: 1, wrong: 0 }, summary: null, assignment: { id: id(7), status: "prefetched" } },
      capabilities: { grades: { values: [3, 4, 5], expected_result_version: "1" }, correct_target: null } });
  });

  it("reports a refusal with its stable code and a payload mismatch separately", async () => {
    const h = harness({ refuseStart: "NO_MATERIAL" });
    expect(await h.start()).toMatchObject({ outcome: "rejected", error: { code: "NO_MATERIAL" }, command: { status: "rejected" } });
    const g = harness(); await g.start(); await g.present();
    await g.answer("Haus", 12);
    expect(await g.answer("anders", 12)).toMatchObject({ outcome: "mismatch", error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
  });

  it("accepts correct_target only as the address of this live error; undo_target stays null", async () => {
    const h = harness(); await h.start(); await h.present();
    const target = { session_id: id(3), assignment_id: id(6), result_id: id(706), expected_result_version: "1" };
    expect(await h.answer("falsch")).toMatchObject({ outcome: "accepted", result: { grade: 2 },
      capabilities: { grades: null, correct_target: target, undo_target: null } });
    type View = Record<string, unknown> & { capabilities: Record<string, unknown>; result: Record<string, unknown>;
      action: Record<string, unknown>; step: Record<string, unknown> };
    const view = h.server.view(id(706)) as View;
    const read = () => h.api.readResult("token", "proof", { session_id: id(3), assignment_id: id(6), result_id: id(706), ...origin });
    h.fetcher.mockResolvedValueOnce(response({ ...view, state_version: "9" }));
    expect(await read()).toMatchObject({ capabilities: { correct_target: target } });
    const caps = (correct_target: unknown) => ({ ...view.capabilities, correct_target });
    const closedStep = { ...view.step, status: "closed", close_reason: "stop", assignment: null,
      summary: { completed: 1, correct: 0, wrong: 1, ratio: { numerator: 0, denominator: 1 } } };
    for (const body of [
      { ...view, capabilities: caps({ ...target, result_id: id(707) }) },
      { ...view, capabilities: caps({ ...target, assignment_id: id(7) }) },
      { ...view, capabilities: caps({ ...target, session_id: id(4) }) },
      { ...view, capabilities: caps({ ...target, expected_result_version: "2" }) },
      { ...view, capabilities: caps({ ...target, values: [3, 4, 5] }) },
      { ...view, capabilities: caps({ session_id: id(3), assignment_id: id(6), result_id: id(706) }) },
      // A correct answer is revised by grades, never by correct_target.
      { ...view, result: { ...view.result, grade: 4, correct: true }, capabilities: caps(target) },
      { ...view, result: { ...view.result, status: "undone" }, action: { ...view.action, status: "undone" }, capabilities: caps(target) },
      { ...view, step: closedStep, result: { ...view.result, detail: null }, capabilities: { ...caps(target), stop: false } },
      { ...view, capabilities: { ...view.capabilities, undo_target: { action_id: id(806), kind: "answer.submit", version: "1" } } },
    ]) {
      h.fetcher.mockResolvedValueOnce(response({ ...body, state_version: "9" }));
      await expect(read()).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });

  it("accepts a correction fact at version+1 with grade 4 and the grade right that follows it", async () => {
    const h = harness(); await h.start(); await h.present(); await h.answer("falsch");
    const correct = { command_id: id(20), session_id: id(3), kind: "result.correct", assignment_id: id(6), result_id: id(706),
      expected_result_version: "1", payload: {} };
    expect(await h.send(correct)).toMatchObject({ outcome: "accepted", result: { grade: 4, version: "2", correct: true },
      command: { kind: "result.correct", object_version: "2" },
      capabilities: { correct_target: null, grades: { expected_result_version: "2", values: [3, 4, 5] } } });
    expect(lastBody(h.fetcher)).toEqual({ ...correct, ...origin });
    // The same ID replays its fact; its fingerprint (empty payload) is verified by status.
    expect(await h.send(correct)).toMatchObject({ outcome: "accepted", command: { status: "already_applied", object_version: "2" } });
    expect(await h.api.status("token", "proof", { ...origin, ...correct } as WrittenCommand))
      .toMatchObject({ outcome: "accepted", result: { grade: 4 } });
    // A fact that claims the same version for another grade, or no revision at all, is not this correction.
    type Body = { result: { grade: number }; command: { object_version: string } };
    for (const change of [(body: Body) => { body.result.grade = 3; }, (body: Body) => { body.command.object_version = "1"; }]) {
      const g = harness(); await g.start(); await g.present(); await g.answer("falsch");
      g.fetcher.mockImplementationOnce(async (url, init) => {
        const body = await (await g.server.handle(url as RequestInfo, init)).json() as Body;
        change(body); return response(body);
      });
      await expect(g.send(correct)).rejects.toMatchObject({ kind: "invalid_response" });
    }
  });

  it("changes a grade at version+1, and re-selecting the saved grade keeps the version (К10-077)", async () => {
    const h = harness(); await h.start(); await h.present(); await h.answer("Haus");
    const five = await h.send({ command_id: id(20), session_id: id(3), kind: "result.grade", assignment_id: id(6), result_id: id(706),
      expected_result_version: "1", payload: { grade: 5 } });
    expect(five).toMatchObject({ outcome: "accepted", result: { grade: 5, version: "2" }, command: { object_version: "2" },
      capabilities: { grades: { expected_result_version: "2" } } });
    const same = await h.send({ command_id: id(21), session_id: id(3), kind: "result.grade", assignment_id: id(6), result_id: id(706),
      expected_result_version: "2", payload: { grade: 5 } });
    expect(same).toMatchObject({ outcome: "accepted", result: { grade: 5, version: "2" }, command: { object_version: "2" } });
    expect(await h.send({ command_id: id(22), session_id: id(3), kind: "result.grade", assignment_id: id(6), result_id: id(706),
      expected_result_version: "1", payload: { grade: 3 } })).toMatchObject({ outcome: "rejected", error: { code: "VERSION_CONFLICT" } });
  });

  it("rejects a grade fact whose result at the same version carries another grade", async () => {
    const h = harness(); await h.start(); await h.present(); await h.answer("Haus");
    type Body = { result: { grade: number; version: string }; action: { version: string };
      capabilities: { grades: { expected_result_version: string } } };
    const grade = (n: number, value: 3 | 5, expected: string, change: (body: Body) => void) => {
      h.fetcher.mockImplementationOnce(async (url, init) => {
        const body = await (await h.server.handle(url as RequestInfo, init)).json() as Body;
        change(body); return response(body);
      });
      return h.send({ command_id: id(n), session_id: id(3), kind: "result.grade", assignment_id: id(6), result_id: id(706),
        expected_result_version: expected, payload: { grade: value } });
    };
    // The applied version is the result's own version: its grade must be the one this command asked for.
    await expect(grade(30, 5, "1", body => { body.result.grade = 3; })).rejects.toMatchObject({ kind: "invalid_response" });
    // A newer revision may carry another grade without denying that this command applied its own.
    const later = await grade(31, 3, "2", body => {
      body.result.version = body.action.version = body.capabilities.grades.expected_result_version = "4"; body.result.grade = 4;
    });
    expect(later).toMatchObject({ outcome: "accepted", command: { object_version: "3" }, result: { version: "4", grade: 4 } });
  });

  it("checks status with the server fingerprint and treats a fingerprint mismatch as an HTTP 409 refusal", async () => {
    const h = harness(); await h.start();
    const command = { ...origin, command_id: id(10), session_id: id(3), kind: "session.start", payload: { mode: "written", bucket: "words" } } as WrittenCommand;
    expect(await h.api.status("token", "proof", command)).toMatchObject({ outcome: "accepted", command: { status: "already_applied" } });
    const url = new URL(String(h.fetcher.mock.calls.at(-1)![0]), "http://localhost");
    expect([...url.searchParams.keys()]).toEqual(["client_instance_id", "document_id", "session_id", "expected_intent_hash"]);
    expect(url.searchParams.get("expected_intent_hash")).toBe("e6c0dff823aa5a65ed5753bd18b697e9f618879af15aebdac5eaa863f7fdc347");
    const other = { ...command, payload: { mode: "written", bucket: "phrases" } } as WrittenCommand;
    await expect(h.api.status("token", "proof", other)).rejects.toMatchObject({ kind: "http", status: 409, code: "COMMAND_PAYLOAD_MISMATCH" });
    const missing = { ...command, command_id: id(99) } as WrittenCommand;
    expect(await h.api.status("token", "proof", missing)).toMatchObject({ outcome: "not_found", current: { profile_id: id(50) } });
  });

  it("rejects an accepted status whose verified fingerprint is absent", async () => {
    const h = harness(); await h.start();
    const command = { ...origin, command_id: id(10), session_id: id(3), kind: "session.start", payload: { mode: "written", bucket: "words" } } as WrittenCommand;
    h.fetcher.mockResolvedValueOnce(response({ command: { ...h.server.receipts.get(id(10))!.fact, status: "already_applied" },
      current: h.server.projection(), state_version: "2" }));
    await expect(h.api.status("token", "proof", command)).rejects.toBeInstanceOf(ApiError);
  });

  it("reads one exact result with its written step and summary", async () => {
    const h = harness({ cards: [6] }); await h.start(); await h.present(); await h.answer("Haus");
    const read = await h.api.readResult("token", "proof", { session_id: id(3), assignment_id: id(6), result_id: id(706), ...origin });
    const url = new URL(String(h.fetcher.mock.calls.at(-1)![0]), "http://localhost");
    expect(url.pathname).toBe(`/api/v1/sessions/${id(3)}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ assignment_id: id(6), result_id: id(706), ...origin });
    expect(read.step).toMatchObject({ status: "summary", summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } });
  });

  it("validates step counts and summary against each other", () => {
    const server = writtenServer({ cards: [6] });
    server.state.sessionId = id(3); server.state.status = "summary";
    const step = server.step();
    expect(validWrittenStep(step, id(3))).toBe(true);
    expect(validWrittenStep({ ...step, summary: null }, id(3))).toBe(false);
    expect(validWrittenStep({ ...step, progress: { ...step.progress, correct: 1 } }, id(3))).toBe(false);
    expect(validWrittenStep({ ...step, summary: { ...step.summary!, ratio: { numerator: 0, denominator: 0 } } }, id(3))).toBe(false);
    expect(validWrittenStep({ ...step, practice: { ...step.practice, direction: "de-l1" } }, id(3))).toBe(false);
    expect(validWrittenStep({ status: "unavailable" }, id(3))).toBe(true);
    expect(validWrittenStep({ session_id: id(4), status: "not_found" }, id(3))).toBe(false);
  });

  it("refuses to send a command for another mode or with access fields mixed into the intent", async () => {
    const h = harness();
    await expect(h.send({ command_id: id(10), session_id: id(3), kind: "session.start", payload: { mode: "oral", bucket: "words" } })).rejects.toThrow();
    await expect(h.api.send("", "proof", { ...origin, command_id: id(10), session_id: id(3), kind: "session.stop",
      payload: { reason: "stop" } } as WrittenCommand)).rejects.toThrow();
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});
