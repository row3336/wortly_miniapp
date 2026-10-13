import { vi } from "vitest";
import type { LearningSessionProjection, WrittenAnswerDetail } from "../api/generated";
import type { LearningCommandIntent } from "./learningCommandIntent";
import { LearningViewController } from "./learningViewController";
import { current, fact, fixture, id, response, resultRead } from "./learningFixtures.test-support";
import { previewContent } from "./learningPreview.test-support";

/** Synthetic HTTP state with the real view, durable command owner and strict transport adapters. */
export function learningViewFixture(mode: "normal" | "accelerated" = "normal", sessionId: string | null = id(3)) {
  const f = fixture();
  if (sessionId === null) f.replace({ session: null });
  let step = current(), version = 1, answerGrade = 4, latest: string | null = null, answerDetail: WrittenAnswerDetail | null = null;
  const results = new Map<string, ReturnType<typeof resultRead>>(), receipts = new Map<string, { intent: LearningCommandIntent; fact: ReturnType<typeof fact> }>();
  function project(result: ReturnType<typeof resultRead>) {
    const value = structuredClone(result); value.state_version = String(version); value.step = structuredClone(step);
    const open = step.status !== "closed", revise = open && value.result.result_id === latest;
    const target = { session_id: step.session_id, assignment_id: value.result.assignment_id,
      result_id: value.result.result_id, expected_result_version: value.result.version };
    value.capabilities = { answer_target: open && step.assignment?.status === "presented" ? step.assignment.id : null,
      grades: revise && value.result.grade >= 3 ? { ...target, values: [3, 4, 5] } : null,
      correct_target: revise && value.result.grade === 2 ? target : null, undo_target: null, stop: open, summary_home: step.status === "summary" };
    return value;
  }
  f.fetcher.mockImplementation(async (url, init) => {
    const parsed = new URL(String(url), "http://localhost");
    if (init?.method === "GET") {
      if (parsed.pathname.includes("/commands/")) {
        const receipt = receipts.get(parsed.pathname.split("/").at(-1)!);
        if (!receipt) throw new Error("test needs an explicit not-found reply");
        const key = "result_id" in receipt.intent ? receipt.intent.result_id : receipt.fact.result_id;
        return response(key ? { ...project(results.get(key)!), command: { ...receipt.fact, status: "already_applied" } }
          : { current: step, state_version: String(version), command: { ...receipt.fact, status: "already_applied" } });
      }
      const resultId = parsed.searchParams.get("result_id");
      return response(resultId ? project(results.get(resultId)!) : { current: step, state_version: String(version) });
    }
    const body = JSON.parse(String(init?.body));
    const { client_instance_id: _client, document_id: _document, ...command } = body;
    const intent = command as LearningCommandIntent; version++;
    if (intent.kind === "answer.submit") {
      const index = Number(intent.assignment_id.slice(-3)), resultId = id(700 + index), actionId = id(800 + index);
      const result = resultRead("1", answerGrade, String(version), step);
      result.result.assignment_id = intent.assignment_id; result.result.result_id = resultId; result.action.action_id = actionId;
      if (answerDetail) (result.result as { detail: unknown }).detail = structuredClone(answerDetail);
      results.set(resultId, result); latest = resultId;
      step = { ...step, assignment: { ...current().assignment!, id: id(index + 1), status: "prefetched" } };
      const saved = { ...fact(intent, true), result_id: resultId, action_id: actionId };
      receipts.set(intent.command_id, { intent, fact: saved }); return response({ ...project(result), command: saved });
    }
    if (intent.kind === "result.correct" || intent.kind === "result.grade") {
      const result = results.get(intent.result_id)!;
      result.result.version = String(Number(result.result.version) + 1); result.action.version = result.result.version;
      result.result.grade = intent.kind === "result.correct" ? 4 : intent.payload.grade as number; result.result.correct = result.result.grade >= 3;
      const saved = { ...fact(intent, true), result_id: intent.result_id, action_id: result.action.action_id, object_version: result.result.version };
      receipts.set(intent.command_id, { intent, fact: saved }); return response({ ...project(result), command: saved });
    }
    if (intent.kind === "assignment.present") step = { ...step, assignment: { ...step.assignment!, status: "presented" } };
    else if (intent.kind === "session.stop") step = { ...step, status: "closed",
      // This synthetic core is R1/R2a: it never applies the closure C (save_failed), whose record the client only reads.
      close_reason: intent.payload.reason as "stop" | "summary_home", assignment: null, preview: null };
    else if (intent.kind === "session.start") step = { ...current(intent.session_id), group: { ...current().group, status: "assembling", preview_position: 0 },
      assignment: null, preview: { id: id(20), card_id: id(21), position: 1, total: 1, content: previewContent(id(21)) } };
    else step = { ...current(step.session_id), assignment: { ...current().assignment!, status: "prefetched" } };
    const saved = fact(intent); receipts.set(intent.command_id, { intent, fact: saved });
    return response({ current: step, state_version: String(version), command: saved });
  });
  const onUpdate = vi.fn();
  const view = new LearningViewController({ access: f.access, storage: f.storage, newId: f.newId,
    transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000 }, sessionId, transitionMode: () => mode, onUpdate });
  return { ...f, view, onUpdate, wrong: () => { answerGrade = 2; },
    /** The detail every later answer carries (the default result has none). */
    setDetail: (value: WrittenAnswerDetail) => { answerDetail = value; },
    setStep: (value: LearningSessionProjection) => { step = value; },
    posts: () => f.fetcher.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1]?.body))),
    handler: f.fetcher.getMockImplementation()! };
}

