// D-STALE-WINDOW 3.1.1, 3.1.3, 3.1.13: every study adapter meets the core's own refusal envelopes. A refusal of this
// attempt (DOCUMENT_STALE) is thrown as a plain HTTP refusal before the envelope is parsed;
// every business code keeps its envelope outcome, so no refusal turns into an unknown outcome wholesale.
import { describe, expect, it, vi } from "vitest";
import { ApiError, type HttpOptions } from "../api/http";
import { recordedConjugationStart, recordedLearningStart, recordedOralStart, recordedWrittenStart } from "../api/realCoreStartRecordings.test-support";
import { answerKinds, staleCommand } from "../app/openRules.test-support";
import { createConjugationApi } from "../conjugation/conjugationApi";
import { createLearningResultApi } from "../learning/learningAnswerApi";
import { createLearningSessionApi } from "../learning/learningSessionApi";
import { createOralApi } from "../oral/oralApi";
import { createWrittenApi } from "../written/writtenApi";
import { attemptRefusal } from "./commandRefusal";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const origin = { client_instance_id: id(1), document_id: id(2) };
const base = { ...origin, session_id: id(3), command_id: id(4) };
const result = { assignment_id: id(6), result_id: id(7), expected_result_version: "1" };
/** The catalog the core projects for a refused schedule (conjugation_sessions.schedule → catalog_projection). */
const catalog = { pair: "ru-de", local_date: "2026-10-01", items: [
  { base_verb_id: id(8), lemma: "kommen", tense: "present", status: "openable", due_date: null, can_schedule: true }] };

type Mode = "written" | "learning" | "learning-answer" | "oral" | "conjugation";
const apis: Record<Mode, (options: HttpOptions) => { send(token: string, proof: string, command: never): Promise<unknown> }> = {
  written: createWrittenApi, learning: createLearningSessionApi, "learning-answer": createLearningResultApi,
  oral: createOralApi, conjugation: createConjugationApi,
};
/** Every study command kind of D-STALE-WINDOW 1.1 (28 pairs of mode and kind) and conjugation.schedule (Р4). */
const commands: Array<[Mode, Record<string, unknown>]> = [
  ["written", { ...base, kind: "session.start", payload: { mode: "written", bucket: "words" } }],
  ["written", { ...base, kind: "assignment.present", assignment_id: id(6), payload: {} }],
  ["written", { ...base, kind: "session.stop", payload: { reason: "stop" } }],
  ["written", { ...base, kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } }],
  ["written", { ...base, ...result, kind: "result.grade", payload: { grade: 5 } }],
  ["written", { ...base, ...result, kind: "result.correct", payload: {} }],
  ["written", { ...base, ...result, kind: "result.undo", payload: {} }],
  ["learning", { ...base, kind: "session.start", payload: { mode: "learning" } }],
  ["learning", { ...base, kind: "assignment.present", assignment_id: id(6), payload: {} }],
  ["learning", { ...base, kind: "learning.preview_next", preview_id: id(5), payload: {} }],
  ["learning", { ...base, kind: "learning.known", preview_id: id(5), payload: {} }],
  ["learning", { ...base, kind: "session.stop", payload: { reason: "stop" } }],
  ["learning-answer", { ...base, kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } }],
  ["learning-answer", { ...base, ...result, kind: "result.grade", payload: { grade: 5 } }],
  ["learning-answer", { ...base, ...result, kind: "result.correct", payload: {} }],
  ["learning-answer", { ...base, ...result, kind: "result.undo", payload: {} }],
  ["oral", { ...base, kind: "session.start", payload: { mode: "oral", bucket: "words" } }],
  ["oral", { ...base, kind: "assignment.present", assignment_id: id(6), payload: {} }],
  ["oral", { ...base, kind: "oral.reveal", assignment_id: id(6), payload: {} }],
  ["oral", { ...base, kind: "oral.grade", assignment_id: id(6), payload: { correct: true } }],
  ["oral", { ...base, kind: "session.stop", payload: { reason: "stop" } }],
  ["conjugation", { ...base, kind: "session.start", payload: { mode: "conjugation" } }],
  ["conjugation", { ...base, kind: "assignment.present", assignment_id: id(6), payload: {} }],
  ["conjugation", { ...base, kind: "answer.submit", assignment_id: id(6), payload: { text: "komme" } }],
  ["conjugation", { ...base, ...result, kind: "result.grade", payload: { grade: 5 } }],
  ["conjugation", { ...base, ...result, kind: "result.correct", payload: {} }],
  ["conjugation", { ...base, ...result, kind: "result.undo", payload: {} }],
  ["conjugation", { ...base, kind: "session.stop", payload: { reason: "stop" } }],
  ["conjugation", { ...origin, command_id: id(4), kind: "conjugation.schedule", payload: { base_verb_id: id(8), tense: "present" } }],
];
const named = commands.map(([mode, command]) => [`${mode} ${command.kind}`, mode, command] as const);

/** The core's refusal envelope of this command with this code (study/coordinator.py; app.py flattens answer kinds). */
function envelope(command: Record<string, unknown>, code: string) {
  if (command.kind === "conjugation.schedule") {
    return { command: { id: command.command_id, status: "rejected" }, current: catalog, state_version: "7", error: { code } };
  }
  return staleCommand(command.command_id as string, command.session_id as string, 7, command.kind as string, code);
}
function send(mode: Mode, command: Record<string, unknown>, body: unknown, status: number) {
  const onDocumentStale = vi.fn();
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  const reply = apis[mode]({ fetcher, timeoutMs: 500, maxResponseBytes: 100000, onDocumentStale }).send("t", "p", command as never);
  return { reply, onDocumentStale, fetcher };
}
const refusal = (status: number, code: string) => ({ kind: "http", status, code });

describe("attemptRefusal: the closed list of attempt refusals", () => {
  it.each([
    [409, "DOCUMENT_STALE", true], [403, "FORBIDDEN", false],
    [403, "DOCUMENT_STALE", false], [409, "FORBIDDEN", false], [409, "COMMAND_PAYLOAD_MISMATCH", false],
    [409, "SESSION_BUSY", false], [409, "SESSION_CLOSED", false], [409, "ASSIGNMENT_STALE", false], [409, "NO_MATERIAL", false],
    [409, "SETUP_REQUIRED", false], [409, "VERSION_CONFLICT", false], [422, "VALIDATION_FAILED", false],
    [409, "CAPABILITY_EXPIRED", false], [409, "CLIENT_INCOMPATIBLE", false], [503, "MAINTENANCE", false], [409, undefined, false],
  ] as const)("%i %s → %s", (status, code, expected) => {
    expect(attemptRefusal(status, code)).toBe(expected);
  });
});

describe("3.1.1 the core's DOCUMENT_STALE envelope is thrown, never read as a refused intent", () => {
  it.each(named)("%s", async (_name, mode, command) => {
    const { reply, onDocumentStale, fetcher } = send(mode, command, envelope(command, "DOCUMENT_STALE"), 409);
    const error = await reply.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject(refusal(409, "DOCUMENT_STALE"));
    // The one transport hook still asks the window check, exactly once (api/http.ts).
    expect(onDocumentStale).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("3.1.3 business refusals keep their envelope outcome (no mass move to an unknown outcome)", () => {
  const codes: Array<[number, string]> = [[409, "SESSION_CLOSED"], [409, "ASSIGNMENT_STALE"], [409, "SESSION_BUSY"],
    [409, "NO_MATERIAL"], [409, "SETUP_REQUIRED"], [409, "VERSION_CONFLICT"], [422, "VALIDATION_FAILED"], [409, "CAPABILITY_EXPIRED"]];
  const cases = named.flatMap(([name, mode, command]) => codes.map(([status, code]) => [`${name} ${status} ${code}`, mode, command, status, code] as const));
  it.each(cases)("%s → rejected", async (_name, mode, command, status, code) => {
    const { reply } = send(mode, command, envelope(command, code), status);
    await expect(reply).resolves.toMatchObject({ outcome: "rejected", command: { id: id(4), status: "rejected" }, error: { code } });
  });
  it.each(named)("%s 409 COMMAND_PAYLOAD_MISMATCH → mismatch", async (_name, mode, command) => {
    const { reply } = send(mode, command, envelope(command, "COMMAND_PAYLOAD_MISMATCH"), 409);
    await expect(reply).resolves.toMatchObject({ outcome: "mismatch", error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
  });
  // Real core replies (Р5): a start refused as SESSION_BUSY stays rejected, an applied start stays accepted.
  const recorded: Array<[Mode, typeof recordedWrittenStart | typeof recordedLearningStart | typeof recordedOralStart | typeof recordedConjugationStart]> = [
    ["written", recordedWrittenStart], ["learning", recordedLearningStart], ["oral", recordedOralStart], ["conjugation", recordedConjugationStart]];
  it.each(recorded)("%s recorded start: 409 SESSION_BUSY → rejected, 200 → accepted", async (mode, exchanges) => {
    const command = { ...exchanges.start_refused.request };
    const refused = send(mode, command, exchanges.start_refused.reply, exchanges.start_refused.status);
    await expect(refused.reply).resolves.toMatchObject({ outcome: "rejected", error: { code: "SESSION_BUSY" } });
    const held = send(mode, { ...exchanges.start_held.request }, exchanges.start_held.reply, exchanges.start_held.status);
    await expect(held.reply).resolves.toMatchObject({ outcome: "accepted", command: { status: "applied" } });
  });
});

describe("3.1.13 the synthetic envelope is the core's", () => {
  it("session kinds carry the unavailable current; answer kinds the flattened unavailable step (HTTP test session_shape / answer_shape)", () => {
    expect(staleCommand(id(4), id(3), 7, "assignment.present")).toEqual({ command: { id: id(4), status: "rejected" },
      current: { session_id: id(3), status: "unavailable" }, state_version: "7", error: { code: "DOCUMENT_STALE" } });
    for (const kind of answerKinds) {
      expect(staleCommand(id(4), id(3), 7, kind)).toEqual({ command: { id: id(4), status: "rejected" }, state_version: "7",
        error: { code: "DOCUMENT_STALE" }, action: null, result: null, step: { session_id: id(3), status: "unavailable" },
        capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false } });
    }
  });
});
