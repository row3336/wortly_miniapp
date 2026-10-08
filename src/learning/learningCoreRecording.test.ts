import { afterEach, describe, expect, it, vi } from "vitest";
import { conformsToGenerated } from "../written/generatedContract.test-support";
import { createLearningResultApi, type LearningResultCommand } from "./learningAnswerApi";
import { fixture } from "./learningFixtures.test-support";
import { createLearningSessionApi, type LearningSessionCommand } from "./learningSessionApi";
import { LearningViewController } from "./learningViewController";
import recording from "./learningCoreRecording.json";

/**
 * Bridge to the real API: replies recorded from core's own ASGI app (TestClient over a disposable wortly_test
 * schema, no network port) by core/tools/record_learning_session.py. Credentials were never recorded.
 * Two profiles walked two Learning paths: «main» (previews, a right answer and its grade, a wrong answer and its
 * correction, «Не помню» undone, Stop) and «summary» («Уже знаю», the last answer of a group, the undo from the
 * summary, the way home). Each client request must equal the request the server accepted, and each real reply must
 * pass the strict client decoders: first one by one through the adapters, then through the screen controller.
 * Apart from one refused second start of a closed session, only the successful path is recorded; nothing here depends on
 * automatic recovery, so the test holds on the tree with or without it.
 * Re-record from the core root after a change of the Learning contract:
 *   PYTHONDONTWRITEBYTECODE=1 PSYCOPG_IMPL=python DYLD_LIBRARY_PATH=/Applications/Postgres.app/Contents/Versions/18/lib
 *   .venv/bin/python tools/record_learning_session.py --out <miniapp>/src/learning/learningCoreRecording.json
 */
type Exchange = { name: string; method: "GET" | "POST"; path: string; query: Record<string, string>;
  body: Record<string, unknown> | null; status: number; schema: string[]; response: unknown };
const exchanges = recording.exchanges as unknown as Exchange[];
const exchange = (name: string): Exchange => {
  const found = exchanges.find(item => item.name === name);
  if (!found) throw new Error(`the recording has no exchange ${name}`);
  return found;
};
/** One value of a recorded reply by its path of keys. */
function field(name: string, ...path: string[]): unknown {
  return path.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], exchange(name).response);
}
const text = (name: string, ...path: string[]) => field(name, ...path) as string;
const sessionPart = (name: string) => exchange(name).body!.session_id as string;
const summaryPart = exchanges.findIndex(item => item.name === "summary_start");
/** The checks a screen never makes: statuses, a read of a closed session, a refused second start, the summary read. */
const adapterOnly = new Set(["status_start", "status_answer", "status_undo", "read_closed", "status_missing", "start_again", "summary_read"]);
const resultKinds = ["answer.submit", "result.grade", "result.correct", "result.undo"];

/** Serves the recorded replies in their order and notes every request that is not the recorded one. */
function replay(queue: Exchange[]) {
  const problems: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const expected = queue.shift();
    if (!expected) { problems.push(`unexpected request ${init?.method} ${String(url)}`); throw new Error("unexpected request"); }
    const parsed = new URL(String(url), "http://localhost");
    try {
      expect(init?.method).toBe(expected.method);
      expect(parsed.pathname).toBe(expected.path);
      expect(Object.fromEntries(parsed.searchParams)).toEqual(expected.query);
      if (expected.body) expect(JSON.parse(String(init?.body))).toEqual(expected.body);
      else expect(init?.body).toBeUndefined();
    } catch (error) {
      problems.push(`${expected.name}: ${(error as Error).message}`);
      throw error;
    }
    return new Response(JSON.stringify(expected.response), { status: expected.status });
  });
  return { fetcher, problems, left: () => queue.map(item => item.name) };
}
function adapters(fetcher: typeof fetch) {
  const options = { fetcher, timeoutMs: 1000, maxResponseBytes: 200000 };
  const sessions = createLearningSessionApi(options), results = createLearningResultApi(options);
  const command = (name: string) => exchange(name).body as unknown as Record<string, unknown> & { kind: string };
  const isResult = (name: string) => resultKinds.includes(command(name).kind);
  const send = (name: string) => isResult(name) ? results.send("token", "proof", command(name) as unknown as LearningResultCommand)
    : sessions.send("token", "proof", command(name) as unknown as LearningSessionCommand);
  const status = (original: string) => isResult(original) ? results.status("token", "proof", command(original) as unknown as LearningResultCommand)
    : sessions.status("token", "proof", command(original) as unknown as LearningSessionCommand);
  const origin = (name: string) => ({ client_instance_id: exchange(name).query.client_instance_id,
    document_id: exchange(name).query.document_id });
  const readSession = (name: string) => sessions.read("token", "proof", { session_id: exchange(name).path.split("/").at(-1)!, ...origin(name) });
  const readResult = (name: string) => results.read("token", "proof", { session_id: exchange(name).path.split("/").at(-1)!,
    assignment_id: exchange(name).query.assignment_id, result_id: exchange(name).query.result_id, ...origin(name) });
  return { sessions, results, command, send, status, readSession, readResult };
}

describe("Learning adapters against recorded core replies", () => {
  it("every recorded reply has exactly the structure of the generated OpenAPI contract the recorder matched", () => {
    expect(exchanges.length).toBeGreaterThan(0);
    for (const item of exchanges) {
      // The recorder checked each reply against core's OpenAPI; the same schema must hold in the Mini App's copy.
      expect(item.schema.length, item.name).toBeGreaterThan(0);
      expect(conformsToGenerated(item.response, item.schema[0]), `${item.name}: ${item.schema[0]}`).toBe(true);
    }
  });

  it("no real question or answer carries the legacy personal hint (K07-125) or the private answer before it is checked", () => {
    const prompts = JSON.stringify(exchanges.map(item => item.response)).match(/"prompt":\{[^}]*/g) ?? [];
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt).not.toMatch(/"hint(_version)?":/);
    // A question holds only the public answer shape; the variants appear only in the detail of a saved result.
    const questions = exchanges.map(item => item.response as { step?: { assignment?: unknown }; current?: { assignment?: unknown } })
      .map(reply => reply.step?.assignment ?? reply.current?.assignment).filter(Boolean);
    expect(questions.length).toBeGreaterThan(0);
    expect(JSON.stringify(questions)).not.toMatch(/"variants"|"parts"/);
  });

  it("sends the same requests the server accepted and accepts every real reply of the main path", async () => {
    const { fetcher, problems, left } = replay(exchanges.slice(0, summaryPart));
    const api = adapters(fetcher);
    const started = await api.send("start");
    expect(started).toMatchObject({ outcome: "accepted", current: { status: "active", mode: "learning", pair: "ru-de", assignment: null,
      group: { status: "assembling", preview_position: 0, total: 2 }, preview: { position: 1, total: 2,
        content: { card: { lemma: "Haus", type: "noun" }, translations: { common: ["дом"] } } } } });
    // The fingerprint-free status of the start shows the same current step, and a read of the session the same preview.
    expect(await api.status("start")).toMatchObject({ outcome: "accepted", command: { status: "already_applied", kind: "session.start" },
      current: { preview: { id: text("start", "current", "preview", "id") } } });
    expect(await api.readSession("read_preview")).toMatchObject({ current: { status: "active", preview: { position: 1 } } });
    expect(await api.send("preview_first")).toMatchObject({ outcome: "accepted", command: { kind: "learning.preview_next", object_version: expect.any(String) },
      current: { preview: { position: 2, content: { card: { lemma: "Buch" } } } } });
    expect(await api.send("preview_second")).toMatchObject({ outcome: "accepted", current: { preview: null, group: { status: "active" },
      assignment: { kind: "learning", status: "prefetched", prompt: { text: "дом" }, answer_spec: { kind: "forms", part_count: 2 } } } });
    expect(await api.send("present_first")).toMatchObject({ outcome: "accepted", current: { assignment: { status: "presented" } } });

    const first = exchange("answer_first").body!.assignment_id as string, firstResult = text("answer_first", "result", "result_id");
    const answered = await api.send("answer_first");
    expect(answered).toMatchObject({ outcome: "accepted", result: { grade: 4, version: "1", status: "active", detail: { input: { kind: "text" },
      initial_check: { correct: true } } }, capabilities: { answer_target: null, correct_target: null, grades: { values: [3, 4, 5] },
      undo_target: { session_id: sessionPart("start"), assignment_id: first, result_id: firstResult, expected_result_version: "1",
        action_id: text("answer_first", "action", "action_id"), kind: "answer.submit" } },
    step: { assignment: { status: "prefetched" } } });
    // The client computes the same checks of an answer by its ID as core reports.
    expect(await api.status("answer_first")).toMatchObject({ outcome: "accepted",
      command: { status: "already_applied", kind: "answer.submit" }, result: { result_id: firstResult, grade: 4 } });
    expect(await api.send("grade_first")).toMatchObject({ outcome: "accepted", command: { kind: "result.grade" }, result: { grade: 5, version: "2" } });
    expect(await api.send("present_second")).toMatchObject({ outcome: "accepted", current: { assignment: { status: "presented", prompt: { text: "книга" } } } });
    expect(await api.readResult("read_first")).toMatchObject({ result: { result_id: firstResult, grade: 5 }, step: { status: "active" },
      capabilities: { answer_target: text("present_second", "current", "assignment", "id"), grades: { values: [3, 4, 5] } } });

    // The real server grants the correction of this error by its exact current address.
    const correction = api.command("correct_second");
    const target = { session_id: sessionPart("start"), assignment_id: exchange("answer_second").body!.assignment_id as string,
      result_id: correction.result_id as string, expected_result_version: "1" };
    expect(correction).toMatchObject({ kind: "result.correct", ...target, payload: {} });
    expect(await api.send("answer_second")).toMatchObject({ outcome: "accepted", result: { grade: 2, result_id: target.result_id },
      capabilities: { grades: null, correct_target: target } });
    expect(await api.send("correct_second")).toMatchObject({ outcome: "accepted", result: { grade: 4, version: "2",
      detail: { initial_check: { correct: false } } }, capabilities: { correct_target: null, grades: { values: [3, 4, 5], expected_result_version: "2" } } });
    expect(await api.send("present_third")).toMatchObject({ outcome: "accepted" });
    expect(await api.readResult("read_second")).toMatchObject({ result: { grade: 4, version: "2" } });

    // «Не помню» is a saved error with no text; core grants its undo by the exact address, and the card is issued anew.
    const forgot = await api.send("answer_third");
    const right = { session_id: sessionPart("start"), assignment_id: exchange("answer_third").body!.assignment_id as string,
      result_id: text("answer_third", "result", "result_id"), expected_result_version: "1" };
    expect(forgot).toMatchObject({ outcome: "accepted", result: { grade: 2, detail: { input: { kind: "forgot" } } },
      capabilities: { correct_target: right, undo_target: { ...right, kind: "answer.submit", action_id: text("answer_third", "action", "action_id") } } });
    // The command is the address of that right only, without its action ID (CT 2.3).
    expect(api.command("undo")).toMatchObject({ kind: "result.undo", ...right, payload: {} });
    expect(api.command("undo")).not.toHaveProperty("action_id");
    const undone = await api.send("undo");
    expect(undone).toMatchObject({ outcome: "accepted", command: { kind: "result.undo", object_version: "2" },
      result: { result_id: right.result_id, status: "undone", version: "2", detail: null }, action: { status: "undone", version: "2" },
      capabilities: { undo_target: null, correct_target: null, grades: null },
      step: { status: "active", assignment: { status: "prefetched", card_id: text("present_third", "current", "assignment", "card_id") } } });
    const again = text("undo", "step", "assignment", "id");
    expect(again).not.toBe(right.assignment_id);
    expect(await api.status("undo")).toMatchObject({ outcome: "accepted", command: { status: "already_applied", kind: "result.undo" },
      result: { status: "undone" } });
    expect(api.command("present_again")).toMatchObject({ kind: "assignment.present", assignment_id: again });
    expect(await api.send("present_again")).toMatchObject({ outcome: "accepted", current: { assignment: { id: again, status: "presented" } } });

    expect(await api.send("stop")).toMatchObject({ outcome: "accepted", current: { status: "closed", close_reason: "stop", assignment: null } });
    expect(await api.readResult("read_closed")).toMatchObject({ result: { status: "undone", detail: null }, step: { status: "closed" } });
    const missing = exchange("status_missing").path.split("/").at(-1)!;
    expect(await api.sessions.status("token", "proof", { ...api.command("stop"), command_id: missing } as unknown as LearningSessionCommand)).toMatchObject({ outcome: "not_found",
      closed_session: { status: "closed", close_reason: "stop" } });
    expect(await api.send("start_again")).toMatchObject({ outcome: "rejected", error: { code: "SESSION_CLOSED" } });
    expect(problems).toEqual([]);
    expect(left()).toEqual([]);
  });

  it("accepts the real summary path: «Уже знаю», the last answer, the undo from the summary and the way home", async () => {
    expect(summaryPart).toBeGreaterThan(0);
    const { fetcher, problems, left } = replay(exchanges.slice(summaryPart));
    const api = adapters(fetcher);
    expect(sessionPart("summary_start")).not.toBe(sessionPart("start"));
    expect(await api.send("summary_start")).toMatchObject({ outcome: "accepted", current: { preview: { position: 1 } } });
    // A skipped card gets no answer: the other card's preview follows, then its question.
    expect(await api.send("summary_known")).toMatchObject({ outcome: "accepted", command: { kind: "learning.known" },
      current: { preview: { position: 2, content: { card: { lemma: "Buch" } } } } });
    expect(await api.send("summary_preview")).toMatchObject({ outcome: "accepted", current: { preview: null, assignment: { status: "prefetched" } } });
    expect(await api.send("summary_present")).toMatchObject({ outcome: "accepted", current: { assignment: { status: "presented" } } });
    const done = await api.send("summary_answer");
    const address = { session_id: sessionPart("summary_start"), assignment_id: exchange("summary_answer").body!.assignment_id as string,
      result_id: text("summary_answer", "result", "result_id"), expected_result_version: "1" };
    expect(done).toMatchObject({ outcome: "accepted", result: { grade: 4 }, step: { status: "summary", assignment: null, group: { status: "completed" } },
      capabilities: { summary_home: true, stop: true, undo_target: { ...address, kind: "answer.submit" }, grades: { values: [3, 4, 5] } } });
    const undone = await api.send("summary_undo");
    expect(undone).toMatchObject({ outcome: "accepted", result: { status: "undone", version: "2" },
      step: { status: "active", group: { status: "active" }, assignment: { status: "prefetched", card_id: text("summary_preview", "current", "assignment", "card_id") } }, capabilities: { summary_home: false, undo_target: null } });
    expect(text("summary_undo", "step", "assignment", "id")).not.toBe(address.assignment_id);
    expect(await api.send("summary_present_again")).toMatchObject({ outcome: "accepted", current: { assignment: { status: "presented" } } });
    expect(await api.send("summary_answer_again")).toMatchObject({ outcome: "accepted", result: { grade: 4 }, step: { status: "summary" },
      capabilities: { summary_home: true } });
    expect(await api.readSession("summary_read")).toMatchObject({ current: { status: "summary", group: { status: "completed" } } });
    expect(await api.send("summary_home")).toMatchObject({ outcome: "accepted", current: { status: "closed", close_reason: "summary_home" } });
    expect(problems).toEqual([]);
    expect(left()).toEqual([]);
  });
});

const views: LearningViewController[] = [];
afterEach(() => { views.splice(0).forEach(view => view.dispose()); vi.useRealTimers(); });

/**
 * The Learning screen controller on the recorded exchanges of one part. The client asks for its IDs in the order of the
 * recorded requests (the session ID of a start, then the command ID), so every request is exactly the recorded one.
 */
function screen(part: Exchange[]) {
  const queue = part.filter(item => !adapterOnly.has(item.name));
  const ids = queue.filter(item => item.method === "POST").flatMap(item => item.body!.kind === "session.start"
    ? [item.body!.session_id as string, item.body!.command_id as string] : [item.body!.command_id as string]);
  const served = replay(queue);
  const f = fixture();
  const first = part[0].body!;
  // The part's profile has its own installation and document; it has no session of its own yet.
  f.replace({ client_instance_id: first.client_instance_id as string, document_id: first.document_id as string, session: null });
  const onUpdate = vi.fn(), complete = vi.fn();
  const view = new LearningViewController({ access: f.access, storage: f.storage, transport: { fetcher: served.fetcher, timeoutMs: 30000,
    maxResponseBytes: 200000 }, newId: () => ids.shift()!, sessionId: null, transitionMode: () => "normal", onUpdate, onLearningComplete: complete });
  views.push(view);
  const draft = async (name: string) => {
    const payload = exchange(name).body!.payload as { text?: string; forgot?: true };
    if (payload.forgot) { await view.submit({ forgot: true }); return; }
    view.setDraft(payload.text!);
    await view.submit();
  };
  return { ...served, view, complete, ids, draft };
}

describe("Learning screen against recorded core replies", () => {
  it("walks the main path: previews, question, right answer, grade, wrong answer, correction, «Не помню», step back, Stop", async () => {
    const s = screen(exchanges.slice(0, summaryPart)), { view } = s;
    await view.refresh();
    expect(view.snapshot()).toMatchObject({ phase: "idle", sessionId: null });
    await view.start();
    expect(view.snapshot()).toMatchObject({ phase: "preview", sessionId: sessionPart("start"), canAdvancePreview: true, canStop: true,
      current: { status: "active", preview: { position: 1, content: { card: { lemma: "Haus" } } }, assignment: null } });
    // A reload of the screen reads the session and shows the same preview.
    await view.refresh();
    expect(view.snapshot()).toMatchObject({ phase: "preview", current: { preview: { id: text("start", "current", "preview", "id") } } });
    await view.advancePreview();
    expect(view.snapshot()).toMatchObject({ phase: "preview", current: { preview: { position: 2, content: { card: { lemma: "Buch" } } } } });
    // The last preview opens the first question; the screen shows it only after core confirmed its presentation.
    await view.advancePreview();
    expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: text("preview_second", "current", "assignment", "id"), status: "presented",
      prompt: { text: "дом" } }, draft: "", canSubmit: false, canForget: true, current: { preview: null } });

    await s.draft("answer_first");
    expect(view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4, version: "1" } }, grades: [3, 4, 5],
      canCorrect: false, canUndo: true, canNext: true, timer: { durationMs: 3000 } });
    // An explicit grade is saved and the next question is presented right after it; the previous result is read once more.
    await view.grade(5);
    expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: text("present_second", "current", "assignment", "id"), status: "presented",
      prompt: { text: "книга" } }, answer: { result: { grade: 5, version: "2" } }, canPrevious: true, timer: null });

    await s.draft("answer_second");
    expect(view.snapshot()).toMatchObject({ phase: "result_wrong", answer: { result: { grade: 2 } }, canCorrect: true, canUndo: true, grades: [], timer: null });
    await view.correct();
    expect(view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4, version: "2" } }, canCorrect: false,
      grades: [3, 4, 5], canNext: true });
    await view.next();
    expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: text("present_third", "current", "assignment", "id"), status: "presented" },
      answer: { result: { grade: 4, version: "2" } } });

    await s.draft("answer_third");
    expect(view.snapshot()).toMatchObject({ phase: "result_wrong", answer: { result: { grade: 2 } }, canCorrect: true, canUndo: true });
    // Step back: the answer is undone by the issued right, and the same card is shown again under its new ID.
    await view.undo();
    expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: text("present_again", "current", "assignment", "id"), status: "presented",
      prompt: { text: "дом" } }, answer: null, draft: "", canUndo: false, canPrevious: false });

    await view.stop();
    expect(view.snapshot()).toMatchObject({ phase: "closed", question: null, answer: null, canStop: false });
    expect(s.problems).toEqual([]);
    expect(s.left()).toEqual([]);
    expect(s.ids).toEqual([]);
    expect(s.complete).not.toHaveBeenCalled();
  });

  it("walks the summary path: «Уже знаю», the last answer completes the group, step back from the summary, the way home", async () => {
    const s = screen(exchanges.slice(summaryPart)), { view } = s;
    await view.refresh();
    await view.start();
    expect(view.snapshot()).toMatchObject({ phase: "preview", sessionId: sessionPart("summary_start"), current: { preview: { position: 1 } } });
    await view.advancePreview(true);
    expect(view.snapshot()).toMatchObject({ phase: "preview", current: { preview: { position: 2, content: { card: { lemma: "Buch" } } } } });
    await view.advancePreview();
    expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: text("summary_preview", "current", "assignment", "id"), status: "presented" } });

    await s.draft("summary_answer");
    expect(view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, current: { status: "summary", group: { status: "completed" } } });
    // The milestone «Learning completed» is the client's own accepted answer that completes the group.
    expect(s.complete).toHaveBeenCalledTimes(1);
    await view.next();
    expect(view.snapshot()).toMatchObject({ phase: "summary", canUndo: true, current: { status: "summary", assignment: null } });
    await view.undo();
    expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: text("summary_present_again", "current", "assignment", "id"), status: "presented" },
      answer: null, canUndo: false, current: { status: "active", group: { status: "active" } } });

    await s.draft("summary_answer_again");
    expect(view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, current: { status: "summary" } });
    expect(s.complete).toHaveBeenCalledTimes(2);
    await view.next();
    expect(view.snapshot()).toMatchObject({ phase: "summary" });
    await view.stop("summary_home");
    expect(view.snapshot()).toMatchObject({ phase: "closed", question: null, answer: null });
    expect(s.problems).toEqual([]);
    expect(s.left()).toEqual([]);
    expect(s.ids).toEqual([]);
  });
});
