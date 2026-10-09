import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenIntent } from "./writtenIntent";
import { WrittenViewController } from "./writtenViewController";
import { deferred, id, profile, tick, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

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
  // Q27-А: a closure not chosen in this window keeps its server reason and reads the summary of the closed session.
  for (const reason of ["midnight", "timezone_date_changed", "pair_changed", "remote_stop"] as const) {
    it(`an external closure (${reason}) met by an answer keeps its reason and reads the summary once`, async () => {
      const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("Haus"); await h.view.next();
      Object.assign(h.server.state, { status: "closed", closeReason: reason, assignment: null, version: h.server.state.version + 1 });
      await h.answer("Tisch");
      await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
      expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason,
        summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } } });
      expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(0);
    });
  }
  it("F3 the own Stop of a session already closed elsewhere shows that closure's summary and reason at once, no manual check", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.answer("Haus");
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    await h.view.stop();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "remote_stop",
      summary: { completed: 1, correct: 1, wrong: 0 } } });
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
  });
  it("an external closure seen by a read keeps its reason and its summary without another read", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.answer("Haus");
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot().closed).toMatchObject({ reason: "remote_stop", summary: { completed: 1, correct: 1, wrong: 0 } });
  });
  it("F1 a natural end closed later by the server stays natural: no reason shown, no rights, no summary read", async () => {
    const h = harness({ cards: [6] }); await h.started(); await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", canSummaryHome: true });
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "midnight", natural: true, homeRequested: false },
      summary: { completed: 1, correct: 1, wrong: 0 }, canUndo: false, canStop: false, canSummaryHome: false, canSubmit: false });
  });
  it("F1 an active session closed from outside is not natural, even with its numbers known", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.answer("Haus");
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot().closed).toMatchObject({ reason: "midnight", natural: false });
  });
  it("F1 «На Сегодня» met by SESSION_CLOSED on a natural summary is the requested return home", async () => {
    const h = harness({ cards: [6] }); await h.started(); await h.answer("Haus"); await h.view.next();
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    await h.view.stop("summary_home");
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { natural: true, homeRequested: true } });
  });
  // D1: «Шаг назад» from the summary reopened the session; a later closure is an interruption, never a natural end.
  it("D1 undo from the summary applied, its reply lost, closed by midnight before any read: interrupted, not natural", async () => {
    const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", canUndo: true });
    h.fetcher.mockImplementationOnce(async (...call) => {
      await h.server.handle(...call);
      Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
      throw new TypeError("network");
    });
    await h.view.undo();
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot().closed).toMatchObject({ reason: "midnight", natural: false, summary: { completed: 0, correct: 0, wrong: 0 } });
  });
  for (const lost of [false, true]) {
    it(`D1 undo from the summary (reply lost: ${lost}), then midnight: interrupted with its reason`, async () => {
      const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
      if (lost) h.loseReply();
      await h.view.undo();
      await vi.waitFor(() => expect(h.server.state.status).toBe("active"));
      Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
      await h.view.refresh();
      await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
      expect(h.view.snapshot().closed).toMatchObject({ reason: "midnight", natural: false, summary: { completed: 0 } });
    });
  }
  it("D2 a reopened session whose closure comes without a projection is not natural, even when its summary cannot be read", async () => {
    const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
    await h.view.undo();
    await vi.waitFor(() => expect(h.view.snapshot().phase).toBe("question"));
    // Midnight closes the reopened session; the answer never reaches the server and every session read fails, so the
    // closure is known only from the status check of that answer (closed_session, no projection).
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    let dropped = false;
    h.fetcher.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url), "http://localhost");
      if (init?.method === "POST" && !dropped) { dropped = true; throw new TypeError("network"); }
      if ((init?.method ?? "GET") === "GET" && parsed.pathname.includes("/sessions/")) throw new TypeError("network");
      return h.server.handle(url, init);
    });
    await h.answer("Haus");
    await vi.waitFor(() => expect(h.view.snapshot().phase).toBe("closed"));
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("failed"));
    expect(h.view.snapshot().closed).toMatchObject({ natural: false });
  });
  // C088: every card of the session excluded (K07-071): core's ordinary summary with real zeros and ratio null.
  const zeroCounts = { completed: 0, total: 0, correct: 0, wrong: 0 }, zeroSummary = { completed: 0, correct: 0, wrong: 0, ratio: null };
  /** Rewrites every session step the server sends: an emptied queue, its summary as given (null = missing). */
  function emptied(h: ReturnType<typeof harness>, summary: object | null) {
    const rewrite = (value: unknown): unknown => Array.isArray(value) ? value.map(rewrite) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "progress" ? zeroCounts
        : key === "summary" && item !== null ? summary : rewrite(item)])) : value;
    h.fetcher.mockImplementation(async (url, init) => {
      const reply = await h.server.handle(url, init);
      return new Response(JSON.stringify(rewrite(await reply.json())), { status: reply.status });
    });
  }
  it("D3 a real summary of 0 of 0 (every card excluded) closed later is a natural end, without rights", async () => {
    const h = harness({ cards: [6] }); await h.started(); emptied(h, zeroSummary);
    Object.assign(h.server.state, { status: "summary", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", summary: zeroSummary });
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", version: h.server.state.version + 1 });
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "midnight", natural: true },
      canUndo: false, canStop: false, canSummaryHome: false, canSubmit: false });
  });
  it("D3 a closed 0 of 0 without an earlier summary of the session is not a natural end", async () => {
    const h = harness({ cards: [6] }); await h.started(); emptied(h, zeroSummary);
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot().closed).toMatchObject({ reason: "midnight", natural: false });
  });
  it("D3 a summary step whose summary is missing proves no natural end", async () => {
    const h = harness({ cards: [6] }); await h.started(); emptied(h, null);
    Object.assign(h.server.state, { status: "summary", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", version: h.server.state.version + 1 });
    await h.view.refresh();
    // The wire decoder already refuses such a step (stale); whatever is shown, no natural end is made up.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.view.snapshot().closed?.natural ?? null).not.toBe(true);
  });
  it("D3 counts that disagree with their summary prove no natural end", async () => {
    const h = harness({ cards: [6] }); await h.started(); emptied(h, { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } });
    Object.assign(h.server.state, { status: "summary", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", version: h.server.state.version + 1 });
    await h.view.refresh();
    // The wire decoder already refuses such a step (stale); whatever is shown, no natural end is made up.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(h.view.snapshot().closed?.natural ?? null).not.toBe(true);
  });
  it("C088 a lost «Шаг назад» reply, the closure and failed reads: no completed summary is made up", async () => {
    const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
    // The undo is applied but its reply is lost; then midnight closes the session, and every later request fails.
    h.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        await h.server.handle(url, init);
        Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
      }
      throw new TypeError("network");
    });
    await h.view.undo();
    await h.view.refresh();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.view.snapshot().phase).not.toBe("summary");
    expect(h.view.snapshot().closed?.natural ?? null).not.toBe(true);
  });
  it("C088 while «Шаг назад» from the summary is unresolved nothing is shown as finished; its refusal confirms the natural end", async () => {
    const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
    const gate = h.hold(); const undoing = h.view.undo();
    await vi.waitFor(() => expect(h.view.snapshot().commands.primary.pendingIntent?.kind).toBe("result.undo"));
    // Midnight closes the session before the held undo reaches the server.
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    expect(h.view.snapshot()).toMatchObject({ phase: "undoing", closed: null, summary: { completed: 1 } });
    // The undo meets the closed session and is refused: the summary stood, so the end was natural.
    gate.resolve(); await undoing;
    await vi.waitFor(() => expect(h.view.snapshot().closed?.natural).toBe(true));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "midnight" }, canUndo: false, canStop: false,
      canSummaryHome: false });
  });
  it("C088 an unknown «Шаг назад», then «Выйти» meets the closed session with whole counts: the end stays unknown", async () => {
    const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
    // The undo never reaches the server and no check of it can be made; midnight closes the session.
    h.fetcher.mockImplementation(async (url, init) => {
      const body = init?.method === "POST" ? JSON.parse(String(init.body)) : null;
      if (body?.kind === "result.undo" || (init?.method ?? "GET") === "GET" && String(url).includes("/commands/")) throw new TypeError("network");
      return h.server.handle(url, init);
    });
    await h.view.undo();
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    await h.view.stop();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(h.view.snapshot().closed).toMatchObject({ reason: "midnight", natural: null });
  });
  // QA delta 2 (N8–N11): each path that confirms or withdraws a natural end holds on its own.
  it("N8 a closed projection that no longer counts the whole queue withdraws the end at once, never shown as natural", async () => {
    const seen: (boolean | null)[] = [];
    const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
    const view = new WrittenViewController({ access: h.access, storage: h.storage, transport: h.transport, newId: h.newId,
      sessionId: h.view.snapshot().sessionId, transitionMode: () => "normal",
      onUpdate: snapshot => { if (snapshot.phase === "closed") seen.push(snapshot.closed?.natural ?? null); } });
    owners.push(view);
    await view.refresh();
    expect(view.snapshot().phase).toBe("summary");
    // Unseen by this view the session was reopened (its answer undone) and then closed: the closed counts are 0 of 1.
    for (const item of h.server.results.values()) item.status = "undone";
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    await view.refresh();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(true);
    expect(view.snapshot().closed?.natural).toBe(false);
  });
  it("N1 an active step withdraws the end even without an own undo: a later boundary closure with a failed read is not natural", async () => {
    const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
    // A second view of the same session saw the natural summary; the first one then undid the answer.
    const view = new WrittenViewController({ access: h.access, storage: h.storage, transport: h.transport, newId: h.newId,
      sessionId: h.view.snapshot().sessionId, transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view);
    await view.refresh(); expect(view.snapshot().phase).toBe("summary");
    await h.view.undo(); expect(h.server.state.status).toBe("active");
    await view.refresh(); expect(view.snapshot().phase).not.toBe("summary");
    // Midnight closes it; the second view learns that only from the status check of a lost answer, and reads fail.
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    let dropped = false;
    h.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && !dropped) { dropped = true; throw new TypeError("network"); }
      if ((init?.method ?? "GET") === "GET" && String(url).includes("/sessions/")) throw new TypeError("network");
      return h.server.handle(url, init);
    });
    view.setDraft("Haus"); await view.submit();
    await vi.waitFor(() => expect(view.snapshot().phase).toBe("closed"));
    expect(view.snapshot().closed?.natural).toBe(false);
  });
  /** A natural summary whose «На Сегодня» was lost; the closure is then known only from its status check (boundary). */
  async function boundaryClosure(reopened: boolean) {
    const h = harness({ cards: [6] }); await h.started(); await h.answer("Haus"); await h.view.next();
    h.dropRequest(); await h.view.stop("summary_home");
    if (reopened) for (const item of h.server.results.values()) item.status = "undone";
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
    const reads = h.gets(`/sessions/${h.server.state.sessionId}?client_instance_id`).length;
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    return { h, reads };
  }
  it("N11 a natural end known only from a boundary is confirmed by one read of the closed session", async () => {
    const { h, reads } = await boundaryClosure(false);
    expect(h.gets(`/sessions/${h.server.state.sessionId}?client_instance_id`).length).toBeGreaterThan(reads);
    expect(h.view.snapshot().closed).toMatchObject({ natural: true, summary: { completed: 1 } });
  });
  it("N9 that read withdraws the end when the closed counts are no longer whole", async () => {
    const { h } = await boundaryClosure(true);
    expect(h.view.snapshot().closed).toMatchObject({ natural: false, summary: { completed: 0 } });
  });
  // QA delta 3 (Q1/Q4/Q7/Q8): the not_applied outcome of an unresolved «Шаг назад», its read of the closed session and the withdrawal proof.
  const midnight = (h: ReturnType<typeof harness>) =>
    Object.assign(h.server.state, { status: "closed", closeReason: "midnight", assignment: null, version: h.server.state.version + 1 });
  // The undo reaches the server (or not), every reply and status check is lost; midnight closes the session; the network returns.
  for (const applied of [false, true]) {
    it(`Q1/Q7/Q8 an unknown «Шаг назад» (applied: ${applied}) reads the closed session at once; the network's return settles the end by the undo's outcome`, async () => {
      vi.useFakeTimers();
      const h = harness({ cards: [6], undo: true }); await h.started(); await h.answer("Haus"); await h.view.next();
      let offline = true;
      h.fetcher.mockImplementation(async (url, init) => {
        const body = init?.method === "POST" ? JSON.parse(String(init.body)) : null;
        if (!offline) return h.server.handle(url, init);
        if (body?.kind === "result.undo") { if (applied) await h.server.handle(url, init); throw new TypeError("network"); }
        if ((init?.method ?? "GET") === "GET" && String(url).includes("/commands/")) throw new TypeError("network");
        return h.server.handle(url, init);
      });
      void h.view.undo(); await tick(0);
      midnight(h);
      void h.view.stop(); await tick(0);
      // Q8: the closed session is read although the end is unknown; its counts show whether the undo was applied.
      expect(h.view.snapshot().closed).toMatchObject({ reason: "midnight", natural: applied ? false : null, summaryRead: "known",
        summary: { completed: applied ? 0 : 1 } });
      offline = false;
      for (let i = 0; i < 6; i++) await tick(10_000);
      // Q1/Q7: not_applied keeps the summary that stood (natural); an accepted undo reopened the session (interrupted).
      expect(h.view.snapshot().commands.primary.outcome).toBe(applied ? "accepted" : "not_applied");
      expect(h.view.snapshot().closed).toMatchObject({ natural: !applied, summary: { completed: applied ? 0 : 1 } });
    });
  }
  it("Q4 a closed 0 of 1 read withdraws the proof itself: repeated returns never turn the end natural again", async () => {
    const { h } = await boundaryClosure(true);
    expect(h.view.snapshot().closed).toMatchObject({ natural: false, summary: { completed: 0 } });
    await h.view.refresh(); await h.view.refresh();
    expect(h.view.snapshot().closed).toMatchObject({ natural: false, summary: { completed: 0 } });
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

describe("a pair changed elsewhere and an empty Stop (M-WRITTEN-STUCK)", () => {
  type Lanes = { commands: { readSession(sessionId: string): Promise<unknown>; begin(action: object): Promise<void>; refresh(): Promise<void> } };
  const lanesOf = (view: WrittenViewController) => (view as unknown as Lanes).commands;
  const closeElsewhere = (h: ReturnType<typeof harness>, reason: "pair_changed" | "remote_stop" = "pair_changed") =>
    Object.assign(h.server.state, { status: "closed", closeReason: reason, assignment: null, version: h.server.state.version + 1 });
  const sessionReads = (h: ReturnType<typeof harness>) => h.gets(`/sessions/${h.server.state.sessionId}?client_instance_id`).length;
  /** A shown correct result whose session the lanes already know closed while the view does not (DESIGN 2.2). */
  async function closedUnderTheView() {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.answer("Haus");
    closeElsewhere(h, "remote_stop");
    // Only the lanes read the session: the view keeps its screen.
    await lanesOf(h.view).readSession(h.view.snapshot().sessionId!);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", canStop: true, closed: null });
    return h;
  }
  /** A lost applied answer; then the pair changed elsewhere and a new owner of the new pair is created on return. */
  async function newOwnerOfAnotherPair() {
    const h = harness({ cards: [6, 7] }); await h.started();
    h.loseReply(); const online = h.offline(); await h.answer("Haus");
    await vi.waitFor(() => expect(h.values.has("wortly.pending.written_session")).toBe(true));
    h.view.dispose();
    // Another device changed the pair: the server closed the old-pair session; this document is rebound to the new pair.
    closeElsewhere(h);
    h.replace({ profile: { ...profile(), dictionary_language: "uk" } }); online();
    const owner = new WrittenViewController({ access: h.access, storage: h.storage, transport: h.transport, newId: h.newId,
      sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(owner);
    return { h, owner };
  }

  it("W1: a new owner of another pair closes the old session it recovered by its answer's receipt", async () => {
    const { h, owner } = await newOwnerOfAnotherPair();
    await owner.refresh();
    await vi.waitFor(() => expect(owner.snapshot().closed?.summaryRead).toBe("known"));
    expect(owner.snapshot()).toMatchObject({ phase: "closed", canStop: false, canNext: false, question: null,
      closed: { reason: "pair_changed", natural: false, summary: { completed: 1, correct: 1, wrong: 0 } } });
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(0);
  });
  for (const change of ["profile", "installation"] as const) {
    it(`W1: a read that returns under a foreign ${change} closes nothing`, async () => {
      const { h, owner } = await newOwnerOfAnotherPair();
      const gate = deferred<void>(), handle = h.fetcher.getMockImplementation()!;
      h.fetcher.mockImplementation(async (url, init) => {
        if (String(url).includes("/sessions/")) await gate.promise;
        return handle(url, init);
      });
      const reading = owner.refresh();
      await vi.waitFor(() => expect(h.gets("/sessions/").length).toBeGreaterThan(0));
      h.replace(change === "profile" ? { profile: { ...profile(), profile_id: id(51), dictionary_language: "uk" } }
        : { client_instance_id: id(9), profile: { ...profile(), dictionary_language: "uk" } });
      gate.resolve(); await reading.catch(() => undefined); await new Promise(done => setTimeout(done, 0));
      expect(owner.snapshot()).toMatchObject({ phase: "disposed", closed: null });
      expect((owner as unknown as { closedFacts: unknown }).closedFacts).toBeNull();
    });
  }
  it("W2: a Stop the lanes refuse locally sends nothing; one read shows the closure they know, with its reason", async () => {
    const h = await closedUnderTheView(), posts = h.posts().length, reads = sessionReads(h);
    await h.view.stop();
    expect(h.posts()).toHaveLength(posts);
    expect(sessionReads(h)).toBe(reads + 1);
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).toBe("known"));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", canStop: false,
      closed: { reason: "remote_stop", natural: false, summary: { completed: 1, correct: 1, wrong: 0 } },
      emptyStop: { refusal: "session_closed", read: "applied" } });
  });
  it("W2: an unknown closure gets no new exit: the read fails, the screen stays where Stop was tapped", async () => {
    const h = await closedUnderTheView(), posts = h.posts().length;
    h.offline();
    await h.view.stop();
    expect(h.posts()).toHaveLength(posts);
    // The failed read keeps its existing state and reason; no waiting for Stop and no closure is shown.
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", closed: null, emptyStop: { refusal: "session_closed", read: "failed" } });
    expect(h.view.snapshot().problem).not.toBeNull();
  });
  it("W2: a view closed meanwhile is neither reopened nor read again by the empty Stop", async () => {
    const h = await closedUnderTheView(), lanes = lanesOf(h.view), begin = lanes.begin.bind(lanes);
    const sessionId = h.view.snapshot().sessionId!, refresh = vi.spyOn(h.view, "refresh");
    // The closure reaches the view while the refused Stop is in hand.
    lanes.begin = async action => {
      await begin(action);
      (h.view as unknown as { close(sessionId: string, reason: string | null): void }).close(sessionId, "remote_stop");
    };
    await h.view.stop();
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "remote_stop" } });
    expect(refresh).not.toHaveBeenCalled();
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(0);
  });
  it("W5: while a Stop check is in flight Stop is not offered: a tap neither exits nor discards the input", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); h.view.setDraft("Hau");
    const tap = vi.spyOn(h.view as never, "tapStop"), checking = lanesOf(h.view).refresh();
    expect(h.view.snapshot().canStop).toBe(false);
    await h.view.stop(); await checking;
    expect(tap).not.toHaveBeenCalled();
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(0);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", draft: "Hau", canStop: true });
    await h.view.stop();
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", draft: "", closed: { reason: "stop" } });
  });
  it("W5: a Stop retry that joins a check in flight of its unknown Stop keeps waiting, sends no second Stop", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); h.view.setDraft("Hau");
    h.dropRequest(); await h.view.stop();
    await lanesOf(h.view).refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "stopping", commands: { stop: { pending: true, canRetry: true } } });
    const refresh = vi.spyOn(h.view, "refresh"), gate = h.hold(), checking = lanesOf(h.view).refresh();
    const retrying = h.view.retry("stop");
    gate.resolve(); await checking; await retrying;
    expect(refresh).not.toHaveBeenCalled();
    expect(h.view.snapshot()).toMatchObject({ phase: "stopping", draft: "", commands: { stop: { pending: true } } });
  });
  it("W6: a Stop refused before any request keeps the unsent input, reads once and still surfaces the refusal", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); h.view.setDraft("Hau");
    const lanes = lanesOf(h.view), reads = sessionReads(h);
    lanes.begin = async () => { throw new Error("invalid intent"); };
    await expect(h.view.stop()).rejects.toThrow("invalid intent");
    expect(h.posts().filter(post => post.kind === "session.stop")).toHaveLength(0);
    expect(sessionReads(h)).toBe(reads + 1);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", draft: "Hau", canStop: true,
      emptyStop: { refusal: null, read: "applied" } });
  });
  /** Three empty Exit taps: each sends nothing and reads the session exactly once; nothing is read afterwards. */
  async function threeEmptyTaps(h: ReturnType<typeof harness>) {
    const gets = () => h.fetcher.mock.calls.filter(call => (call[1]?.method ?? "GET") === "GET").length;
    const posts = h.posts().length;
    for (let tap = 0; tap < 3; tap += 1) {
      const before = gets();
      await h.view.stop(); await new Promise(done => setTimeout(done, 30));
      expect(h.posts()).toHaveLength(posts);
      expect(gets() - before).toBe(1);
      expect(h.view.snapshot().closed).toBeNull();
      // The lanes' proof and the failed read are kept apart: neither is turned into a confirmed summary.
      expect(h.view.snapshot().emptyStop).toMatchObject({ refusal: "session_closed", read: "failed" });
    }
    const quiet = gets(); await new Promise(done => setTimeout(done, 300));
    expect(gets()).toBe(quiet);
  }
  it("W7: reads below the version floor: each of 3 empty taps reads once, sends nothing, no read loop", async () => {
    const h = await closedUnderTheView();
    // The server now answers with an older state version than the lanes have seen.
    h.server.state.version -= 1;
    await threeEmptyTaps(h);
  });
  it("W8: offline: each of 3 empty taps tries one read, sends nothing, opens no exit, no read loop", async () => {
    const h = await closedUnderTheView(); h.offline();
    await threeEmptyTaps(h);
  });
  it("W3: a Stop sent without its answer keeps waiting and its input stays discarded", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); h.view.setDraft("Hau");
    h.dropRequest(); await h.view.stop();
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "stopping", draft: "", canStop: false, closed: null, emptyStop: null,
      commands: { stop: { pending: true } } });
  });
  it("W3: an accepted Stop closes and its input stays discarded", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); h.view.setDraft("Hau");
    await h.view.stop();
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", draft: "", closed: { reason: "stop" }, emptyStop: null });
  });
  it("W4: an earlier Stop outcome of another session does not count as sent by this Stop", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.view.stop();
    const earlier = h.view.snapshot().commands.stop.resolved!;
    expect(h.view.snapshot().phase).toBe("closed");
    h.server.state.closeReason = null; await h.view.start("words"); await h.answer("Haus");
    expect(h.view.snapshot().sessionId).not.toBe(earlier.sessionId);
    closeElsewhere(h, "remote_stop");
    await lanesOf(h.view).readSession(h.view.snapshot().sessionId!);
    const posts = h.posts().length;
    await h.view.stop();
    expect(h.posts()).toHaveLength(posts);
    expect(h.view.snapshot().commands.stop.resolved).toMatchObject({ commandId: earlier.commandId });
    await vi.waitFor(() => expect(h.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "remote_stop" } }));
  });
  it("W9: an empty Stop of an earlier session does not follow a new session", async () => {
    const h = await closedUnderTheView();
    await h.view.stop();
    await vi.waitFor(() => expect(h.view.snapshot().emptyStop).toMatchObject({ refusal: "session_closed", read: "applied" }));
    h.server.state.closeReason = null; await h.view.start("words");
    expect(h.view.snapshot()).toMatchObject({ phase: "question", emptyStop: null });
  });
});

describe("the read an empty Stop got (M-WRITTEN-STUCK, C101)", () => {
  type Lanes = { commands: { readSession(sessionId: string): Promise<unknown>; begin(action: object): Promise<void>;
    refresh(): Promise<void>; knowsClosed(sessionId: string): boolean } };
  const lanesOf = (view: WrittenViewController) => (view as unknown as Lanes).commands;
  const closeView = (h: ReturnType<typeof harness>) =>
    (h.view as unknown as { close(sessionId: string, reason: string | null): void }).close(h.view.snapshot().sessionId!, "remote_stop");
  const sessionGets = (h: ReturnType<typeof harness>) => h.gets("/sessions/").filter(url => !url.includes("result_id=")).length;
  const flush = () => new Promise(done => setTimeout(done, 20));
  /** A shown correct result whose next Stop is refused before any request. */
  async function refusedStop() {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.answer("Haus");
    expect(h.view.snapshot().phase).toBe("result_correct");
    const lanes = lanesOf(h.view), begin = lanes.begin.bind(lanes);
    lanes.begin = async () => { throw new Error("refused"); };
    return { h, restore: () => { lanes.begin = begin; } };
  }
  /** Hold (or fail) the result GET only. */
  function resultGate(h: ReturnType<typeof harness>, fail: boolean) {
    const gate = deferred<void>();
    h.fetcher.mockImplementation(async (...call) => {
      if (String(call[0]).includes("result_id=")) { await gate.promise; if (fail) throw new TypeError("network"); }
      return h.server.handle(...call);
    });
    return gate;
  }
  function sessionGate(h: ReturnType<typeof harness>) {
    const gate = deferred<void>();
    h.fetcher.mockImplementationOnce(async (...call) => { await gate.promise; return h.server.handle(...call); });
    return gate;
  }

  it("T1: a later step that fails does not change the session GET's outcome", async () => {
    const { h } = await refusedStop(); resultGate(h, true).resolve();
    await expect(h.view.stop()).rejects.toThrow("refused");
    // The read as a whole failed (its existing state), its session GET was taken.
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", problem: "load",
      emptyStop: { refusal: null, read: "applied", joined: false } });
  });
  it("T2a: a Stop that joins a read held on its session GET gets that read's outcome, marked joined", async () => {
    const { h } = await refusedStop(); const gate = sessionGate(h);
    const r0 = h.view.refresh(); await flush();
    const stopping = h.view.stop().catch(error => error); await flush();
    expect(h.view.snapshot().emptyStop).toMatchObject({ read: null });
    gate.resolve(); await r0; await stopping;
    expect(sessionGets(h)).toBe(1);
    expect(h.view.snapshot().emptyStop).toMatchObject({ read: "applied", joined: true });
  });
  it("T2b: a Stop that joins a read past its session GET still gets that GET's outcome", async () => {
    const { h } = await refusedStop(); const gate = resultGate(h, false);
    const r0 = h.view.refresh(); await flush();
    const stopping = h.view.stop().catch(error => error); await flush();
    gate.resolve(); await r0; await stopping;
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", emptyStop: { read: "applied", joined: true } });
  });
  it("T2c: the joined read failing later keeps its session GET's outcome", async () => {
    const { h } = await refusedStop(); const gate = resultGate(h, true);
    const r0 = h.view.refresh(); await flush();
    const stopping = h.view.stop().catch(error => error); await flush();
    gate.resolve(); await r0; await stopping;
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", problem: "load", emptyStop: { read: "applied", joined: true } });
  });
  it("T3: a newer handle during the read: the Stop gets the outcome of the queued second read, its own", async () => {
    const { h } = await refusedStop(); const gate = sessionGate(h);
    const r0 = h.view.refresh(); await flush();
    h.replace({});
    const stopping = h.view.stop().catch(error => error); await flush();
    gate.resolve(); await r0.catch(() => undefined); await stopping; await flush();
    expect(sessionGets(h)).toBe(2);
    expect(h.view.snapshot().emptyStop).toMatchObject({ read: "applied", joined: false });
  });
  it("T4: a joined read whose reply comes after the view closed reports it ignored", async () => {
    const { h } = await refusedStop(); const gate = sessionGate(h);
    const r0 = h.view.refresh(); await flush();
    const stopping = h.view.stop().catch(error => error); await flush();
    closeView(h);
    gate.resolve(); await r0; await stopping;
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", emptyStop: { read: "ignored", joined: true } });
  });
  it("T5: a closure known before the GET: no GET, not_read", async () => {
    const { h } = await refusedStop(); const lanes = lanesOf(h.view), refresh = lanes.refresh.bind(lanes);
    const reads = sessionGets(h);
    lanes.refresh = async () => { await refresh(); closeView(h); };
    await expect(h.view.stop()).rejects.toThrow("refused");
    // The read itself made no GET; the closed view then reads its summary once (afterRead), as for any closure.
    expect(sessionGets(h)).toBe(reads + 1);
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", emptyStop: { read: "not_read", joined: false } });
  });
  it("T6: a failed lane check makes no GET: not_read, never failed", async () => {
    const { h } = await refusedStop(); const reads = sessionGets(h);
    lanesOf(h.view).refresh = async () => { throw new Error("lane check failed"); };
    await expect(h.view.stop()).rejects.toThrow("refused");
    expect(sessionGets(h)).toBe(reads);
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", problem: "load", emptyStop: { read: "not_read" } });
  });
  it("T7: the session GET itself failing is failed", async () => {
    const { h } = await refusedStop(); h.offline();
    await expect(h.view.stop()).rejects.toThrow("refused");
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", emptyStop: { read: "failed", joined: false } });
  });
  it("MQ1, MQ2: the lanes know a closure only at or above their floor, and only while the document is live", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.answer("Haus");
    const lanes = lanesOf(h.view), sessionId = h.view.snapshot().sessionId!;
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null });
    h.server.state.version -= 1;
    await expect(lanes.readSession(sessionId)).rejects.toThrow();
    expect(lanes.knowsClosed(sessionId)).toBe(false);
    h.server.state.version += 2;
    await lanes.readSession(sessionId);
    expect(lanes.knowsClosed(sessionId)).toBe(true);
    h.revoke();
    expect(lanes.knowsClosed(sessionId)).toBe(false);
  });
  it("MQ3: a new tap drops the facts of the previous empty Stop; a sent Stop has none", async () => {
    const { h, restore } = await refusedStop();
    await expect(h.view.stop()).rejects.toThrow("refused");
    expect(h.view.snapshot().emptyStop).toMatchObject({ read: "applied" });
    restore();
    const gate = h.hold(), stopping = h.view.stop();
    await vi.waitFor(() => expect(h.view.snapshot().phase).toBe("stopping"));
    expect(h.view.snapshot().emptyStop).toBeNull();
    gate.resolve(); await stopping;
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", emptyStop: null });
  });
  it("MQ6: a revoked document shows no facts of an empty Stop", async () => {
    const { h } = await refusedStop();
    await expect(h.view.stop()).rejects.toThrow("refused");
    expect(h.view.snapshot().emptyStop).not.toBeNull();
    h.revoke();
    expect(h.view.snapshot()).toMatchObject({ phase: "disposed", emptyStop: null });
  });
});
