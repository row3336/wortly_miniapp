import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenIntent } from "./writtenIntent";
import { WrittenViewController } from "./writtenViewController";
import { deferred, id, tick, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

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
  it("a timeout before commit keeps the same command_id: checked by GET at once, resent with that ID after 2 s (Я15, Я15.6)", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); h.view.setDraft("Haus");
    h.dropRequest(); await h.view.submit();
    const first = h.posts().at(-1)!, ids = h.newId.mock.calls.length;
    await tick(0);
    expect(h.gets(`/commands/${first.command_id}`)).toHaveLength(1);
    // No manual retry: the machine waits for the pause of retry №1.
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", draft: "Haus", canRetryPrimary: false, answer: null,
      commands: { recovery: { commandId: first.command_id, state: { name: "retry_wait", attempt: 2 } } } });
    await tick(1999);
    expect(h.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
    await tick(1);
    const answers = h.posts().filter(post => post.kind === "answer.submit");
    expect(answers).toHaveLength(2); expect(answers[1]).toEqual(first);
    // The check right before the retry asked by the same ID again.
    expect(h.gets(`/commands/${first.command_id}`)).toHaveLength(2);
    expect(h.newId.mock.calls.length).toBe(ids);
    await tick(0);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, timer: { durationMs: 3000 } });
  });
  it("a reply lost after commit is resolved by the same ID without a second POST, its timer runs from the confirmation", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); h.view.setDraft("Haus");
    h.loseReply(); await h.view.submit();
    await tick(0);
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, timer: { durationMs: 3000 },
      commands: { recovery: { state: { name: "settled" }, sends: 1 } } });
    await tick(10000);
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
  });
  it("after a reload a saved intent is checked by its original ID; with an unknown count it is never sent (CT §6.1 п. 4)", async () => {
    vi.useFakeTimers();
    const saved: WrittenIntent = { command_id: id(400), session_id: id(3), kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } };
    const h = harness({ active: true, saved: { primary: saved } }, "normal", id(3));
    await h.view.refresh(); await tick(0);
    expect(h.gets(`/commands/${id(400)}`).length).toBeGreaterThanOrEqual(1); expect(h.posts()).toEqual([]);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", draft: "Haus", canRetryPrimary: false,
      commands: { recovery: { state: { name: "counter_unknown", cause: "unknown" }, sends: null } } });
    const checks = h.gets(`/commands/${id(400)}`).length;
    // Only checks on the probe schedule (5, 10, 20, then 30 s), never a POST and never an exhaustion:
    // at 5, 15, 35, 65, … 275 s of these five minutes.
    for (let second = 0; second < 300; second += 5) await tick(5000);
    expect(h.posts()).toEqual([]);
    expect(h.gets(`/commands/${id(400)}`).length).toBe(checks + 11);
    expect(h.view.snapshot().commands.recovery?.state.name).toBe("counter_unknown");
    await h.view.retry(); expect(h.posts()).toEqual([]);
  });
  it("a saved answer for a question no longer shown is never retried; the shown question takes a new answer (TA §9, CT §6.1 п. 7)", async () => {
    vi.useFakeTimers();
    const saved: WrittenIntent = { command_id: id(401), session_id: id(3), kind: "answer.submit", assignment_id: id(7), payload: { text: "Haus" } };
    const h = harness({ active: true, saved: { primary: saved } }, "normal", id(3));
    await h.view.refresh(); await tick(0);
    // The changed step is a final outcome: the record goes and the screen continues by the server's state (CT §6.1 п. 7).
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(6), status: "presented" }, problem: null,
      canRetryPrimary: false, canForget: true, commands: { primary: { pending: false }, recovery: { state: { name: "terminated", reason: "step_stale" } } } });
    expect(h.values.has("wortly.pending.written_session")).toBe(false);
    const checks = h.gets(`/commands/${id(401)}`).length;
    await tick(60_000);
    expect(h.gets(`/commands/${id(401)}`)).toHaveLength(checks);
    await h.view.retry(); expect(h.posts()).toEqual([]);
    h.view.setDraft("Haus"); await h.view.submit(); await tick();
    expect(h.posts().map(post => [post.kind, post.assignment_id])).toEqual([["answer.submit", id(6)]]);
    expect(h.posts()[0].command_id).not.toBe(id(401));
    expect(h.view.snapshot().phase).toBe("result_correct");
  });
  it("a saved answer of a step that moved on to an unshown question: the next question is presented as usual", async () => {
    vi.useFakeTimers();
    const saved: WrittenIntent = { command_id: id(402), session_id: id(3), kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } };
    const h = harness({ active: true, saved: { primary: saved } }, "normal", id(3));
    // The server already moved past card 6 (another answer of it was saved); card 7 is issued but not shown yet.
    Object.assign(h.server.state, { index: 1, assignment: "prefetched", version: h.server.state.version + 1 });
    await h.view.refresh(); await tick(0); await tick(0);
    expect(h.posts().map(post => [post.kind, post.assignment_id])).toEqual([["assignment.present", id(7)]]);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7), status: "presented" },
      commands: { primary: { pending: false } } });
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
    h.loseReply(); const online = h.offline(); await h.view.grade(5);
    await tick(10000);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", grades: [], canNext: false, timer: null,
      commands: { primary: { pendingIntent: { kind: "result.grade", payload: { grade: 5 } } }, recovery: { state: { name: "unreachable" } } } });
    expect(h.kinds().at(-1)).toBe("result.grade");
    // The connection returns: the next check finds the grade by its ID; nothing is sent again.
    online(); await tick(20000);
    expect(h.kinds().filter(kind => kind === "result.grade")).toHaveLength(1);
    expect(h.server.results.get(id(706))).toMatchObject({ grade: 5, version: 2 });
  });
  it.each(["normal", "accelerated"] as const)("%s: a wrong answer waits or moves on after 2 s", async mode => {
    vi.useFakeTimers(); const h = harness({}, mode); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot().timer?.durationMs ?? null).toBe(mode === "normal" ? null : 2000);
    await tick(5000);
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
  it("Т06: a correction of A waits for the present of the visible B; B and its draft survive, 3/5 follow, no timer (К05-059…061)", async () => {
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true, grades: [] });
    const gate = h.hold(); const showing = h.view.next();
    await vi.waitFor(() => expect(h.kinds().at(-1)).toBe("assignment.present"));
    h.view.setDraft("B draft"); h.view.previousResult();
    // While the present of the visible B is unconfirmed, A's correction is not offered and cannot be sent (CT:107).
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", canCorrect: false, grades: [], timer: null, draft: "B draft" });
    await h.view.correct(); await h.view.submit();
    expect(h.kinds().filter(kind => kind === "result.correct" || kind === "answer.submit")).toEqual(["answer.submit"]);
    gate.resolve(); await showing;
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", canCorrect: true, draft: "B draft" });
    await h.view.correct();
    expect([...h.server.receipts.values()].map(item => item.intent.kind))
      .toEqual(["session.start", "assignment.present", "answer.submit", "assignment.present", "result.correct"]);
    // One tap: no text, no grade, the address of the issued right only (К05-050…054).
    expect(h.posts().at(-1)).toEqual({ command_id: expect.any(String), session_id: h.server.state.sessionId, kind: "result.correct",
      assignment_id: id(6), result_id: id(706), expected_result_version: "1", payload: {}, client_instance_id: id(1), document_id: id(2) });
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", answer: { result: { grade: 4, version: "2" } },
      canCorrect: false, grades: [3, 4, 5], timer: null, draft: "B draft" });
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, draft: "B draft" });
    expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });
  it("the correction button follows the server right, not the error: a right ended elsewhere shows none (К05-057)", async () => {
    const h = harness(); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true });
    h.server.revokeRights(id(706)); await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", answer: { result: { grade: 2 } }, canCorrect: false, grades: [] });
    await h.view.correct(); expect(h.kinds()).not.toContain("result.correct");
  });
  it("after the next accepted answer the previous error has no correction any more (capability null)", async () => {
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("falsch"); await h.view.next();
    h.view.previousResult(); expect(h.view.snapshot().canCorrect).toBe(true);
    await h.view.next(); await h.answer("Haus");
    expect(h.server.view(id(706)).capabilities.correct_target).toBeNull();
    expect(h.view.snapshot()).toMatchObject({ answer: { result: { assignment_id: id(7) } }, canCorrect: false, canPrevious: false });
    await h.view.correct(); expect(h.kinds()).not.toContain("result.correct");
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
  it("Stop after answers shows the summary of the closed session projection itself, without an answer address (C-WSUM)", async () => {
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("Haus"); await h.view.next(); await h.answer("falsch");
    const reads = h.fetcher.mock.calls.length;
    await h.view.stop();
    expect(h.view.snapshot().closed).toMatchObject({ reason: "stop", summaryRead: "known", summary: { completed: 2, correct: 1, wrong: 1,
      ratio: { numerator: 1, denominator: 2 } } });
    // Only the Stop itself went to the server.
    expect(h.fetcher.mock.calls.slice(reads).map(call => call[1]?.method)).toEqual(["POST"]);
    expect(h.gets(`result_id=${id(707)}`)).toHaveLength(0);
  });
  it("without the closed projection at hand the summary of an own Stop is read from the session once", async () => {
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("Haus");
    h.dropRequest(); await h.view.stop();
    expect(h.view.snapshot()).toMatchObject({ phase: "stopping", commands: { stop: { pending: true } } });
    // Meanwhile the session was closed by Stop; this lost request never reached the server.
    Object.assign(h.server.state, { status: "closed", closeReason: "stop", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "stop",
      summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } } });
    expect(h.gets(`/sessions/${h.server.state.sessionId}?client_instance_id`)).toHaveLength(1);
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
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

describe("written correction (C-WCORR: Т06, Т07/Т70, CT:111, TA:111)", () => {
  it("a pending correction before B is shown stops the timer; the withdrawn drill is never shown (CT:111)", async () => {
    vi.useFakeTimers(); const h = harness({ drills: true }, "accelerated"); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true, timer: { durationMs: 2000 } });
    expect(h.server.step().assignment).toMatchObject({ id: id(906), kind: "drill", status: "prefetched" });
    const gate = h.hold(); const correcting = h.view.correct();
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.view.snapshot()).toMatchObject({ phase: "changing_result", timer: null, canNext: false, answer: { result: { grade: 2 } } });
    expect(h.kinds().at(-1)).toBe("result.correct");
    gate.resolve(); await correcting;
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, grades: [3, 4, 5],
      current: { assignment: { id: id(7), kind: "original", status: "prefetched" } } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
    expect(h.posts().filter(post => post.kind === "assignment.present").map(post => post.assignment_id)).toEqual([id(6), id(7)]);
  });
  it("Т70: a correction of the original error keeps the shown drill and its input; no new present (К05-116/117)", async () => {
    const h = harness({ drills: true }); await h.started(); await h.answer("falsch"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(906), kind: "drill" } });
    h.view.setDraft("Drill"); h.view.previousResult(); await h.view.correct();
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", answer: { result: { grade: 4 } }, draft: "Drill" });
    expect(h.server.step().assignment).toMatchObject({ id: id(906), status: "presented" });
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(906) }, draft: "Drill", canSubmit: true });
    expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });
  it("a correction whose reply is lost keeps one command_id; its unknown outcome blocks the answer to B", async () => {
    vi.useFakeTimers();
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("falsch"); await h.view.next();
    h.view.setDraft("B text"); h.view.previousResult();
    h.dropRequest(); const ids = h.newId.mock.calls.length; await h.view.correct();
    const first = h.posts().at(-1)!;
    expect(first).toMatchObject({ kind: "result.correct", result_id: id(706) });
    await tick(0);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", canNext: false, canSubmit: false, grades: [], canCorrect: false,
      canRetryPrimary: false, commands: { primary: { pendingIntent: { kind: "result.correct" } }, recovery: { state: { name: "retry_wait" } } } });
    await h.view.submit(); await h.view.next();
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
    await tick(2000);
    expect(h.posts().filter(post => post.kind === "result.correct")).toEqual([first, first]);
    expect(h.newId.mock.calls.length).toBe(ids + 1);
    await tick(0);
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", answer: { result: { grade: 4 } }, draft: "B text" });
    await h.view.next(); await h.view.submit();
    expect(h.posts().at(-1)).toMatchObject({ kind: "answer.submit", assignment_id: id(7), payload: { text: "B text" } });
  });
  it("a correction committed but replied lost is resolved by its ID, never sent twice", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("falsch");
    h.loseReply(); await h.view.correct();
    await tick(0);
    expect(h.kinds().filter(kind => kind === "result.correct")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4, version: "2" } }, grades: [3, 4, 5] });
  });
  it("a grade acknowledged while hidden advances once on return (К05-047; suspend keeps the pending advance)", async () => {
    vi.useFakeTimers(); const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("Haus");
    const gate = h.hold(); const grading = h.view.grade(5);
    await vi.waitFor(() => expect(h.kinds().at(-1)).toBe("result.grade"));
    h.view.suspend(); gate.resolve(); await grading;
    expect(h.kinds().at(-1)).toBe("result.grade");
    h.replace(); await h.view.resume();
    expect(h.kinds().at(-1)).toBe("assignment.present");
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
    expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });
  it("an unknown correction keeps its result visible: after background it waits for «Далее» (TA:109)", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("falsch");
    h.loseReply(); const online = h.offline(); await h.view.correct(); await tick(0);
    expect(h.view.snapshot().phase).toBe("unknown");
    h.view.suspend(); online(); h.replace(); await h.view.resume(); await tick(0);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, timer: null, canNext: true });
    await tick(10000); expect(h.kinds().at(-1)).toBe("result.correct");
    await h.view.next(); expect(h.kinds().at(-1)).toBe("assignment.present");
  });
  it("a correction confirmed in the foreground runs the ordinary result timer of a correct answer", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot().timer).toBeNull();
    await h.view.correct();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await vi.advanceTimersByTimeAsync(3000); expect(h.kinds().at(-1)).toBe("assignment.present");
  });
});

describe("liveness of the snapshot", () => {
  it("a revoked document reports no material (bucket) like every other field", async () => {
    const h = harness(); await h.started();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", bucket: "words" });
    h.revoke();
    expect(h.view.snapshot()).toMatchObject({ phase: "disposed", bucket: null, current: null, question: null });
  });
});
