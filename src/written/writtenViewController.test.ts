import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenIntent } from "./writtenIntent";
import { WrittenViewController } from "./writtenViewController";
import { deferred, id, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function harness(options: ServerOptions & { saved?: Partial<Record<"primary" | "stop", WrittenIntent>> } = {},
  mode: "normal" | "accelerated" = "normal", sessionId: string | null = null) {
  const f = writtenFixture(options);
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
    sessionId, transitionMode: () => mode, onUpdate: vi.fn() });
  owners.push(view);
  const kinds = () => f.posts().map(post => post.kind);
  const started = async () => { await view.refresh(); await view.start("words"); };
  const answer = async (text: string) => { view.setDraft(text); await view.submit(); };
  return { ...f, view, kinds, started, answer };
}

describe("written start and question", () => {
  it("starts from one tap: one session.start, then exactly one present of the first card", async () => {
    const h = harness(); await h.started();
    expect(h.kinds()).toEqual(["session.start", "assignment.present"]);
    expect(h.posts()[0]).toMatchObject({ kind: "session.start", payload: { mode: "written", bucket: "words" } });
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(6), status: "presented" }, canSubmit: false });
    await h.view.start("words"); expect(h.kinds()).toHaveLength(2);
  });
  it("shows a refused start with its server reason and keeps no session", async () => {
    const h = harness({ refuseStart: "NO_MATERIAL" }); await h.started();
    expect(h.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null, problem: "NO_MATERIAL", canStart: true, canStop: false });
    await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null, problem: "NO_MATERIAL", canStop: false });
  });
  // An unfinished IME composition is filtered by the input itself: WrittenScreen.test.tsx covers it end to end.
  it("never sends blank input", async () => {
    const h = harness(); await h.started();
    h.view.setDraft("  \n "); await h.view.submit();
    expect(h.kinds()).toEqual(["session.start", "assignment.present"]);
  });
  it("keeps the question and its text until the commit, and one tap is one intent", async () => {
    const h = harness(); await h.started(); h.view.setDraft("Haus");
    const gate = h.hold(); const sending = h.view.submit();
    await vi.waitFor(() => expect(h.kinds()).toContain("answer.submit"));
    expect(h.view.snapshot()).toMatchObject({ phase: "submitting", draft: "Haus", submittedText: "Haus", answer: null, canSubmit: false });
    h.view.setDraft("changed"); await h.view.submit(); await h.view.submit({ forgot: true });
    gate.resolve(); await sending;
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", draft: "", answer: { result: { grade: 4 } } });
  });
});

describe("one command_id per intent (Т02)", () => {
  it("a timeout before commit keeps the same command_id: check by GET, then a manual retry resends that ID", async () => {
    const h = harness(); await h.started(); h.view.setDraft("Haus");
    h.dropRequest(); await h.view.submit();
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", draft: "Haus", canRetryPrimary: false, answer: null });
    const first = h.posts().at(-1)!;
    await h.view.refresh();
    expect(h.gets(`/commands/${first.command_id}`)).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", draft: "Haus", canRetryPrimary: true });
    const ids = h.newId.mock.calls.length;
    await h.view.retry();
    const answers = h.posts().filter(post => post.kind === "answer.submit");
    expect(answers).toHaveLength(2); expect(answers[1]).toEqual(first);
    expect(h.newId.mock.calls.length).toBe(ids);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } } });
  });
  it("a reply lost after commit is resolved by the same ID without a second POST", async () => {
    const h = harness(); await h.started(); h.view.setDraft("Haus");
    h.loseReply(); await h.view.submit();
    expect(h.view.snapshot().phase).toBe("unknown");
    await h.view.refresh();
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } } });
  });
  it("after a reload a saved intent is checked by its original ID and never sent automatically", async () => {
    const saved: WrittenIntent = { command_id: id(400), session_id: id(3), kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } };
    const h = harness({ active: true, saved: { primary: saved } }, "normal", id(3));
    await h.view.refresh();
    expect(h.gets(`/commands/${id(400)}`)).toHaveLength(1); expect(h.posts()).toEqual([]);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", draft: "Haus", canRetryPrimary: true });
    await h.view.retry();
    expect(h.posts()).toEqual([{ ...saved, client_instance_id: id(1), document_id: id(2) }]);
  });
  it("a saved answer for a question no longer shown is checked by its ID but never offered for retry (TA §9)", async () => {
    const saved: WrittenIntent = { command_id: id(401), session_id: id(3), kind: "answer.submit", assignment_id: id(7), payload: { text: "Haus" } };
    const h = harness({ active: true, saved: { primary: saved } }, "normal", id(3));
    await h.view.refresh();
    expect(h.gets(`/commands/${id(401)}`)).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ problem: "step_changed", canRetryPrimary: false,
      commands: { primary: { pending: true, canRetry: false } } });
    await h.view.retry(); expect(h.posts()).toEqual([]);
  });
  it("a different payload under a saved ID is blocked, never resent", async () => {
    const h = harness({ active: true }, "normal", id(3));
    await h.view.refresh(); await h.answer("Haus");
    const sent = h.posts().at(-1)!;
    const other = writtenFixture({ active: true, saved: { primary: { ...sent, client_instance_id: undefined, document_id: undefined,
      payload: { text: "anders" } } as never } });
    other.fetcher.mockImplementation(h.fetcher.getMockImplementation()!);
    const view = new WrittenViewController({ access: other.access, storage: other.storage, transport: other.transport, newId: other.newId,
      sessionId: id(3), transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view); await view.refresh();
    expect(view.snapshot()).toMatchObject({ problem: "mismatch", canRetryPrimary: false });
    await view.retry(); expect(other.posts()).toEqual([]);
  });
});

describe("result timer (Т09, A02)", () => {
  it("does not run before the answer commit and only shows the next card after it", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); h.view.setDraft("Haus");
    const gate = h.hold(); const sending = h.view.submit();
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.view.snapshot()).toMatchObject({ phase: "submitting", timer: null, answer: null });
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "answer.submit"]);
    gate.resolve(); await sending;
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await vi.advanceTimersByTimeAsync(2999); expect(h.kinds()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.kinds().at(-1)).toBe("assignment.present");
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, timer: null });
  });
  it("a pending 4→5 stops the old timer: it neither keeps 4 nor shows the next card; 5 advances only after its commit", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("Haus");
    expect(h.view.snapshot().timer?.durationMs).toBe(3000);
    const gate = h.hold(); const grading = h.view.grade(5);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.view.snapshot()).toMatchObject({ phase: "changing_result", timer: null, answer: { result: { grade: 4 } } });
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "answer.submit", "result.grade"]);
    gate.resolve(); await grading;
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "answer.submit", "result.grade", "assignment.present"]);
    expect(h.server.results.get(id(706))).toMatchObject({ grade: 5, version: 2 });
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
  });
  it("an unknown 4→5 does not claim 4 as current, blocks the next answer and is resolved by its own ID", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("Haus");
    h.loseReply(); await h.view.grade(5);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", grades: [], canNext: false, timer: null,
      commands: { primary: { pendingIntent: { kind: "result.grade", payload: { grade: 5 } } } } });
    expect(h.kinds().at(-1)).toBe("result.grade");
    await h.view.refresh();
    expect(h.kinds().filter(kind => kind === "result.grade")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ answer: { result: { grade: 5, version: "2" } } });
  });
  it.each(["normal", "accelerated"] as const)("%s: a wrong answer waits or moves on after 2 s", async mode => {
    vi.useFakeTimers(); const h = harness({}, mode); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot().timer?.durationMs ?? null).toBe(mode === "normal" ? null : 2000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.kinds().at(-1)).toBe(mode === "normal" ? "answer.submit" : "assignment.present");
  });
  it("after background the result waits for «Далее» and no card is turned in the background (Т90)", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("Haus");
    h.view.suspend(); await vi.advanceTimersByTimeAsync(10000);
    expect(h.kinds().at(-1)).toBe("answer.submit");
    h.replace(); await h.view.resume();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000); expect(h.kinds().at(-1)).toBe("answer.submit");
    await h.view.next(); expect(h.kinds().at(-1)).toBe("assignment.present");
  });
});

describe("present barrier and previous result (A01, К05-059–063)", () => {
  it("a grade of A cannot overtake the present of the visible B; B and its draft survive", async () => {
    const h = harness(); await h.started(); await h.answer("Haus");
    const gate = h.hold(); const showing = h.view.next();
    await vi.waitFor(() => expect(h.kinds().at(-1)).toBe("assignment.present"));
    expect(h.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", question: { id: id(7) }, canSubmit: false, canEditDraft: true });
    h.view.setDraft("B draft"); h.view.previousResult();
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", grades: [], timer: null, draft: "B draft" });
    await h.view.grade(5); await h.view.submit();
    expect(h.kinds().filter(kind => kind === "result.grade")).toEqual([]);
    gate.resolve(); await showing;
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", grades: [3, 4, 5], draft: "B draft", timer: null });
    await h.view.grade(5);
    expect([...h.server.receipts.values()].map(item => item.intent.kind))
      .toEqual(["session.start", "assignment.present", "answer.submit", "assignment.present", "result.grade"]);
    // Changing the grade of the previous result keeps it open, without a timer (К05-062).
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", answer: { result: { grade: 5, version: "2" } }, timer: null });
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, draft: "B draft" });
    expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });
  it("a wrong answer offers neither correction nor grades while the server grants no written correct_target", async () => {
    const h = harness(); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", grades: [], canNext: true });
    expect("correct" in h.view).toBe(false);
  });
  it("the next accepted answer ends the previous grade right", async () => {
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("Haus"); await h.view.next();
    h.view.previousResult(); expect(h.view.snapshot().grades).toEqual([3, 4, 5]);
    await h.view.next(); await h.answer("falsch");
    expect(h.server.view(id(706)).capabilities.grades).toBeNull();
    expect(h.view.snapshot()).toMatchObject({ answer: { result: { assignment_id: id(7) } }, canPrevious: false });
  });
});

describe("Stop and summary (Д02, Т96)", () => {
  it("Stop while an answer is still in flight is its own command; the answer is resolved by ID and the summary read", async () => {
    const h = harness(); await h.started(); h.view.setDraft("Haus");
    const gate = h.hold(); const sending = h.view.submit();
    await vi.waitFor(() => expect(h.kinds().at(-1)).toBe("answer.submit"));
    const stopping = h.view.stop(); await h.view.stop();
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    await stopping; gate.resolve(); await sending;
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", draft: "", question: null,
      closed: { reason: "stop", summary: { completed: 0, correct: 0, wrong: 0, ratio: null } } });
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
  });
  it("an answer committed before Stop but replied after it never reopens the question, and the summary counts it (A01)", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); h.view.setDraft("Haus");
    const gate = deferred<void>();
    h.fetcher.mockImplementationOnce(async (...call) => { const reply = await h.server.handle(...call); await gate.promise; return reply; });
    const sending = h.view.submit();
    await vi.waitFor(() => expect(h.server.results.size).toBe(1));
    await h.view.stop();
    gate.resolve(); await sending;
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", question: null, answer: null,
      closed: { reason: "stop", summary: { completed: 1, correct: 1, wrong: 0 } } });
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "answer.submit", "session.stop"]);
  });
  it("Stop after answers shows the server summary of the closed session", async () => {
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("Haus"); await h.view.next(); await h.answer("falsch");
    await h.view.stop();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot().closed).toMatchObject({ reason: "stop", summary: { completed: 2, correct: 1, wrong: 1,
      ratio: { numerator: 1, denominator: 2 } } });
    expect(h.gets(`result_id=${id(707)}`)).toHaveLength(1);
  });
  it("a natural end shows the confirmed summary; «На Сегодня» closes it with summary_home", async () => {
    const h = harness({ cards: [6] }); await h.started(); await h.answer("Haus");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", canStop: true });
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", canSummaryHome: true, canStop: false,
      summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } });
    await h.view.stop("summary_home");
    expect(h.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } });
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "summary_home" } });
  });
  it("a known Stop failure offers a retry of the same ID; nothing creates a second Stop", async () => {
    const h = harness(); await h.started();
    h.dropRequest(); await h.view.stop();
    const stop = h.posts().at(-1)!;
    expect(h.view.snapshot()).toMatchObject({ commands: { stop: { pending: true, canRetry: false } } });
    await h.view.stop(); expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    await h.view.refresh(); expect(h.view.snapshot().commands.stop.canRetry).toBe(true);
    await h.view.retry("stop");
    expect(h.posts().filter(post => post.kind === "session.stop")).toEqual([stop, stop]);
    expect(h.view.snapshot().phase).toBe("closed");
  });
});
