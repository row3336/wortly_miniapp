import { describe, expect, it, vi } from "vitest";
import type { ConjugationAssignment, ConjugationSessionProjection, ConjugationSummary, OpenedClient, WrittenResult } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { ConjugationCommandSnapshot } from "./conjugationCommandController";
import type { ConjugationDocumentSnapshot, ConjugationPresentationTicket, ConjugationResultSnapshot,
  ConjugationStepTicket } from "./conjugationDocumentController";
import { conjugationQuestion } from "./conjugationQuestion";
import { ConjugationTestFlow, type FlowInput } from "./conjugationTestFlow";

const id = (n: number) => `aaaaaaaa-bbbb-4000-8000-${String(n).padStart(12, "0")}`;
/** A0 is the answered assignment of A; B1/B2 are later questions. */
const S1 = id(1), S2 = id(2), A0 = id(10), B1 = id(11), B2 = id(12), R1 = id(21), C1 = id(31);
/** Opaque tickets are branded objects of the controller; the flow only compares their identity. */
const stepTicket = () => Object.freeze({}) as ConjugationStepTicket;
const presentationTicket = () => Object.freeze({}) as ConjugationPresentationTicket;
/** Tickets are empty frozen objects, equal by value; identity must be asserted with toBe, never toEqual/CalledWith. */
function onlyArgument(spy: { mock: { calls: unknown[][] } }): unknown {
  expect(spy.mock.calls).toHaveLength(1);
  return spy.mock.calls[0][0];
}

function assignment(assignmentId: string, status: "prefetched" | "presented" = "presented"): ConjugationAssignment {
  return { id: assignmentId, card_id: id(8), status, kind: "conjugation", cycle_id: C1, slot_id: { cycle_id: C1, pronoun_group: "du" },
    base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
    prompt: { verb: "gehen", translation: "идти", language: "ru", pronoun: "du", tense: "present" },
    answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } };
}
const summaryFixture = (): ConjugationSummary => ({ completed_cycle_ids: [C1], partial: [], results: [], completed: 6, correct: 6, wrong: 0,
  blocks: [{ cycle_id: C1, base_verb_id: id(8), base_lemma: "gehen", tense: "present",
    answered_groups: ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"], effect: "success", grade: 4 }] });
function projection(current: ConjugationAssignment | null, status: "active" | "summary" = "active"): ConjugationSessionProjection {
  return { session_id: S1, status, mode: "conjugation", direction: "conjugation", pair: "ru-de", local_date: "2026-10-01", close_reason: null,
    progress: { total: 6, completed: 1, correct: 1, wrong: 0 }, assignment: current, summary: status === "summary" ? summaryFixture() : null,
    capabilities: { answer_target: current?.status === "presented" ? current.id : null, correct_target: null, grades: null, undo_target: null,
      stop: true, summary_home: status === "summary" } };
}
function result(correct: boolean, version = "5", grade: 2 | 3 | 4 | 5 = correct ? 4 : 2): WrittenResult {
  return { result_id: R1, assignment_id: A0, version, grade, correct, status: "active", accepted_at: "2026-10-01T08:00:00Z",
    answer_date: "2026-10-01", detail: null };
}
function resultA(value: WrittenResult): ConjugationResultSnapshot {
  return { address: { session_id: S1, assignment_id: A0, result_id: R1 }, stateVersion: "10",
    action: { action_id: id(41), kind: "answer.submit", version: value.version, status: "active" }, result: value,
    capabilities: { answer_target: null, grades: null, correct_target: null, undo_target: null, stop: true, summary_home: false } };
}
function command(over: Partial<ConjugationCommandSnapshot> = {}): ConjugationCommandSnapshot {
  return { phase: "idle", pending: false, kind: null, sessionId: null, pendingIntent: null, outcome: null, resolved: null,
    rejectionCode: null, problem: null, canRetry: false, stateVersion: null, closedSession: null, view: null, ...over };
}
function snap(over: Partial<ConjugationDocumentSnapshot> = {}): ConjugationDocumentSnapshot {
  return { phase: "question", sessionId: S1, stateVersion: "10", terminalSessionIds: [], closed: null, acceptedAddress: null,
    commands: { study: command(), stop: command() }, problem: null,
    currentStep: { stateVersion: "10", step: projection(assignment(B1)) }, resultA: null,
    display: { kind: "step", assignmentId: B1 }, stepTicket: null, presentationTicket: null,
    canStart: false, canSubmit: true, canCorrect: false, canUndo: false, canStop: true, canSummaryHome: false, allowedGrades: [],
    canRetry: { study: false, stop: false }, ...over };
}
/** A with display result, row 11. */
function onResult(value: WrittenResult, over: Partial<ConjugationDocumentSnapshot> = {}): ConjugationDocumentSnapshot {
  return snap({ phase: "result", display: { kind: "result" }, resultA: resultA(value), canSubmit: false,
    currentStep: { stateVersion: "10", step: projection(assignment(B2, "prefetched")) }, acceptedAddress: { session_id: S1, assignment_id: A0, result_id: R1 },
    ...over });
}
/** The study lane just accepted the answer to B1 (this is what makes A a new "answer"). */
const acceptedAnswer = (commandId = id(51), assignmentId = A0) => command({ phase: "settled", outcome: "accepted", kind: "answer.submit",
  sessionId: S1, resolved: { commandId, kind: "answer.submit", sessionId: S1, assignmentId, resultId: R1 } });

const profile = (dictionary_language: "ru" | "uk" = "ru"): OpenedClient["profile"] => ({ profile_id: id(50), role: "user", ui_language: "ru",
  dictionary_language, time_zone: "UTC", state_version: "1", access: { status: "admitted", version: "1", reason: null } });
function access(generation = 1): OpenedAccess {
  return createOpenedAccess({ opened: { status: "opened", client_instance_id: id(60), document_id: id(61), document_epoch: "1",
    proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } },
  token: "synthetic-token", proof: "synthetic-proof", generation, isLive: () => true, onDenied: () => undefined });
}

function harness() {
  const actions = {
    refresh: vi.fn(async () => undefined), start: vi.fn(async () => undefined), openStep: vi.fn(), openResult: vi.fn(),
    shown: vi.fn(async () => undefined), submit: vi.fn(async () => undefined), grade: vi.fn(async () => undefined),
    correct: vi.fn(async () => undefined), undo: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), retry: vi.fn(async () => undefined),
  };
  const timers: { delay: number; run: () => void; cancelled: boolean }[] = [];
  const schedule = vi.fn((delay: 2000 | 3000, run: () => void) => {
    const timer = { delay, run, cancelled: false };
    timers.push(timer);
    return () => { timer.cancelled = true; };
  });
  const onToday = vi.fn(), onChange = vi.fn();
  const flow = new ConjugationTestFlow({ actions, schedule, onToday, onChange });
  const A1 = access(1);
  const input = (state: ConjugationDocumentSnapshot | null, over: Partial<FlowInput> = {}): FlowInput =>
    ({ source: { tuple: "tuple-1", access: A1 }, state, transitionMode: "normal", active: true, ...over });
  const show = (value: FlowInput) => { const view = flow.project(value); flow.commit(value); return view; };
  const calls = () => Object.values(actions).reduce((total, spy) => total + spy.mock.calls.length, 0);
  const running = () => timers.filter(timer => !timer.cancelled);
  /** Fires a timer the way a scheduler would; a cancelled one never runs. */
  const fire = (timer = running().at(-1)!) => { if (!timer.cancelled) timer.run(); };
  return { flow, actions, schedule, timers, running, fire, onToday, onChange, input, show, calls, A1 };
}
/** Every intent of the flow, as a user (or a stale callback) could call it. */
function everyIntent(flow: ConjugationTestFlow, ticket: ConjugationPresentationTicket) {
  flow.setDraft("x"); flow.submit(); flow.forget(); flow.grade(3); flow.grade(4); flow.grade(5); flow.correct(); flow.undo(); flow.next(); flow.previous();
  flow.committed(ticket); flow.enterReleased(); flow.enter({ repeat: false, composing: false }); flow.stop(); flow.home();
  flow.retry("study"); flow.retry("stop"); flow.refresh();
}

describe("conjugation test flow: question and draft", () => {
  it("builds the question only through the T3a adapter and keeps no ids beyond the draft address", () => {
    const h = harness();
    const view = h.show(h.input(snap()));
    expect(view.screen).toBe("question");
    if (view.screen !== "question") return;
    expect(view.question).toEqual(conjugationQuestion(assignment(B1)));
    // Root-approved CP2 correction: an empty draft cannot be submitted as text; "I forgot" keeps the right.
    expect(view).toMatchObject({ draft: "", editable: true, canSubmit: false, canForget: true, status: null });
  });

  it("does not submit an empty field, sends text verbatim and forgot as {forgot:true}", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.submit();
    h.flow.setDraft("   ");
    h.flow.submit();
    expect(h.actions.submit).not.toHaveBeenCalled();
    h.flow.setDraft("  gehst ");
    h.flow.submit();
    h.flow.forget();
    expect(h.actions.submit.mock.calls).toEqual([[{ text: "  gehst " }, B1], [{ forgot: true }, B1]]);
  });

  it("keeps the draft separate from rights: canSubmit=false or inactive is read-only, draft stays", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    const closed = h.show(h.input(snap({ canSubmit: false })));
    expect(closed).toMatchObject({ screen: "question", draft: "geh", editable: false, canSubmit: false });
    h.flow.setDraft("changed"); h.flow.submit();
    const inactive = h.show(h.input(snap(), { active: false }));
    expect(inactive).toMatchObject({ screen: "question", draft: "geh", editable: false, canSubmit: false });
    h.flow.submit(); h.flow.forget();
    expect(h.actions.submit).not.toHaveBeenCalled();
    expect(h.show(h.input(snap()))).toMatchObject({ draft: "geh", editable: true });
  });

  it("previous → result previous; Next → the same B with its draft", () => {
    const h = harness();
    const ticket = stepTicket();
    h.show(h.input(snap({ resultA: resultA(result(true)) })));
    h.flow.setDraft("gehst");
    h.flow.previous();
    expect(h.actions.openResult).toHaveBeenCalledTimes(1);
    const back = h.show(h.input(onResult(result(true), { stepTicket: ticket, currentStep: { stateVersion: "10", step: projection(assignment(B1)) } })));
    expect(back).toMatchObject({ screen: "result", mode: "previous", timer: null, canNext: true });
    h.flow.next();
    expect(onlyArgument(h.actions.openStep)).toBe(ticket);
    expect(h.show(h.input(snap({ resultA: resultA(result(true)) })))).toMatchObject({ screen: "question", draft: "gehst" });
  });

  it("drops the draft when B is replaced and after the accepted submit of that assignment", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    const replaced = snap({ currentStep: { stateVersion: "11", step: projection(assignment(B2)) }, display: { kind: "step", assignmentId: B2 } });
    expect(h.show(h.input(replaced))).toMatchObject({ draft: "" });
    h.show(h.input(snap()));
    expect(h.show(h.input(snap()))).toMatchObject({ draft: "" });

    const second = harness();
    second.show(second.input(snap()));
    second.flow.setDraft("gehst");
    // The step is not fresh here (null), so only the accepted submit of B1 can consume the draft.
    second.show(second.input(onResult(result(true), { currentStep: null, acceptedAddress: null,
      commands: { study: acceptedAnswer(id(52), B1), stop: command() } })));
    expect(second.show(second.input(snap()))).toMatchObject({ screen: "question", draft: "" });
  });
});

describe("conjugation test flow: К06-102 back from the summary to the last answer", () => {
  const summaryWithA = (over: Partial<ConjugationDocumentSnapshot> = {}) => snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false,
    canSummaryHome: true, resultA: resultA(result(false, "5", 2)), currentStep: { stateVersion: "10", step: projection(null, "summary") }, ...over });
  /** A reopened from the summary; the step ticket leads back to the summary; rights are the server's. */
  const reopened = (value: WrittenResult, ticket: ConjugationStepTicket, over: Partial<ConjugationDocumentSnapshot> = {}) =>
    onResult(value, { stepTicket: ticket, canSummaryHome: false, currentStep: { stateVersion: "10", step: projection(null, "summary") }, ...over });

  it("the live summary offers the return only with a known A, while active and not stopping", () => {
    const h = harness();
    expect(h.show(h.input(summaryWithA()))).toMatchObject({ screen: "summary", canPrevious: true, canHome: true });
    expect(h.show(h.input(summaryWithA(), { active: false }))).toMatchObject({ screen: "summary", canPrevious: false });
    expect(h.show(h.input(summaryWithA({ phase: "stopping", canSummaryHome: false })))).toMatchObject({ screen: "summary", canPrevious: false });
    expect(h.show(h.input(summaryWithA({ resultA: null })))).toMatchObject({ screen: "summary", canPrevious: false });
    h.flow.previous();
    expect(h.actions.openResult).not.toHaveBeenCalled();
  });

  it("previous from the summary opens A without a timer; correction keeps waiting for Next; Next returns to the summary", () => {
    const h = harness();
    // The answer was shown in answer mode first (its own timer history), then Next led to the summary.
    h.show(h.input(onResult(result(false, "5", 2), { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: stepTicket() })));
    h.show(h.input(summaryWithA()));
    h.flow.previous();
    expect(h.actions.openResult).toHaveBeenCalledTimes(1);
    const back = stepTicket();
    const view = h.show(h.input(reopened(result(false, "5", 2), back, { canCorrect: true })));
    expect(view).toMatchObject({ screen: "result", mode: "previous", timer: null, canCorrect: true, canNext: true });
    h.flow.correct();
    expect(h.actions.correct).toHaveBeenCalledTimes(1);
    // The corrected version (a new timer key) still waits: previous mode never arms and never advances by itself.
    const corrected = h.show(h.input(reopened(result(true, "6", 4), back, { allowedGrades: [3, 4, 5] })));
    expect(corrected).toMatchObject({ screen: "result", mode: "previous", result: { version: "6", grade: 4 }, timer: null, grades: [3, 4, 5] });
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.actions.openStep).not.toHaveBeenCalled();
    h.flow.next();
    expect(onlyArgument(h.actions.openStep)).toBe(back);
  });

  it("without server rights the reopened result offers no correction or grades", () => {
    const h = harness();
    h.show(h.input(summaryWithA()));
    h.flow.previous();
    expect(h.show(h.input(reopened(result(false, "5", 2), stepTicket())))).toMatchObject({ screen: "result", mode: "previous",
      canCorrect: false, grades: [], canNext: true, timer: null });
    h.flow.correct(); h.flow.grade(4);
    expect(h.actions.correct).not.toHaveBeenCalled();
    expect(h.actions.grade).not.toHaveBeenCalled();
  });
});

describe("conjugation test flow: identity, mask and terminal", () => {
  it("state:null and phase:disposed mask the same identity: loading, draft kept, every intent sends nothing", () => {
    const h = harness();
    const ticket = presentationTicket();
    h.show(h.input(snap({ presentationTicket: ticket, phase: "prefetched", canSubmit: false,
      currentStep: { stateVersion: "10", step: projection(assignment(B1, "prefetched")) } })));
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    for (const state of [null, snap({ phase: "disposed", sessionId: null })]) {
      expect(h.show(h.input(state))).toEqual({ screen: "loading", canStop: false, stopping: false, problem: null, canRetry: { study: false, stop: false },
        canCheck: false, undoing: false });
      everyIntent(h.flow, ticket);
    }
    expect(h.calls()).toBe(0);
    expect(h.show(h.input(snap()))).toMatchObject({ screen: "question", draft: "geh" });
  });

  it("a new tuple or another session clears the draft already on the first project, before commit", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    const tuple = h.input(snap(), { source: { tuple: "tuple-2", access: h.A1 } });
    expect(h.flow.project(tuple)).toMatchObject({ draft: "" });
    // project is pure: the committed identity still has its draft.
    expect(h.flow.project(h.input(snap()))).toMatchObject({ draft: "geh" });
    expect(h.flow.project(h.input(snap({ sessionId: S2 })))).toMatchObject({ draft: "" });
    h.show(h.input(snap({ sessionId: S2 })));
    expect(h.show(h.input(snap()))).toMatchObject({ draft: "" });
  });

  it("sessionId:null after idle (B2) is a new identity: flow memory is gone", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    expect(h.show(h.input(snap({ sessionId: null, phase: "idle", currentStep: null, display: { kind: "none" } })))).toMatchObject({ screen: "loading" });
    expect(h.show(h.input(snap()))).toMatchObject({ draft: "" });
  });

  it("a different access of the same identity keeps the draft and cancels the timer", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    expect(h.show(h.input(snap(), { source: { tuple: "tuple-1", access: access(2) } }))).toMatchObject({ draft: "geh" });
  });

  it("a confirmed terminal erases draft and last question; closed shows only C2 facts", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    const closed = snap({ phase: "closed", terminalSessionIds: [S1], display: { kind: "closed" }, currentStep: null, canSubmit: false, canStop: false,
      closed: { sessionId: S1, reason: "midnight", summary: summaryFixture() } });
    expect(h.show(h.input(closed))).toMatchObject({ screen: "closed", reason: "midnight", summary: summaryFixture() });
    // Even if the same session id came back active, the erased memory does not.
    expect(h.flow.project(h.input(snap({ terminalSessionIds: [] })))).toMatchObject({ screen: "closed" });
    expect(h.onToday).not.toHaveBeenCalled();
  });

  it("closed with unknown reason and summary stays unknown; manual refresh is the only GET path (C2)", () => {
    const h = harness();
    const closed = snap({ phase: "closed", terminalSessionIds: [S1], display: { kind: "closed" }, currentStep: null, canSubmit: false, canStop: false,
      closed: { sessionId: S1, reason: null, summary: null } });
    expect(h.show(h.input(closed))).toMatchObject({ screen: "closed", reason: null, summary: null });
    expect(h.actions.refresh).not.toHaveBeenCalled();
    h.flow.refresh();
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    h.show(h.input({ ...closed, closed: { sessionId: S1, reason: "stop", summary: summaryFixture() } }));
    h.flow.refresh();
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    h.flow.today(); h.flow.today();
    expect(h.onToday).toHaveBeenCalledTimes(1);
  });

  it("onToday exactly once after its own accepted summary_home; other reasons only offer the button", () => {
    const h = harness();
    const summary = snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false, canSummaryHome: true,
      currentStep: { stateVersion: "10", step: projection(null, "summary") } });
    expect(h.show(h.input(summary))).toMatchObject({ screen: "summary", canHome: true, summary: summaryFixture() });
    h.flow.home();
    expect(h.actions.stop).toHaveBeenCalledWith("summary_home");
    const closed = snap({ phase: "closed", terminalSessionIds: [S1], display: { kind: "closed" }, currentStep: null, canSubmit: false,
      closed: { sessionId: S1, reason: "summary_home", summary: summaryFixture() } });
    h.show(h.input(closed)); h.show(h.input(closed)); h.flow.today();
    expect(h.onToday).toHaveBeenCalledTimes(1);

    const other = harness();
    other.show(other.input(summary));
    other.show(other.input({ ...closed, closed: { sessionId: S1, reason: "summary_home", summary: null } }));
    expect(other.onToday).not.toHaveBeenCalled();
  });
});

describe("conjugation test flow: timer (§5; a return waits for Next, DC 2.19)", () => {
  const answer = (value: WrittenResult, over: Partial<ConjugationDocumentSnapshot> = {}) =>
    onResult(value, { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: ticket, ...over });
  let ticket = stepTicket();

  it("normal+correct → 3000 → openStep with the same ticket; normal+wrong and mode=null → nothing; accelerated → 2000", () => {
    ticket = stepTicket();
    const h = harness();
    const view = h.show(h.input(answer(result(true))));
    expect(view).toMatchObject({ screen: "result", mode: "answer", timer: { durationMs: 3000 } });
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.timers[0].delay).toBe(3000);
    h.fire();
    expect(onlyArgument(h.actions.openStep)).toBe(ticket);

    const wrong = harness();
    expect(wrong.show(wrong.input(answer(result(false))))).toMatchObject({ timer: null });
    const none = harness();
    none.show(none.input(answer(result(true)), { transitionMode: null }));
    expect(wrong.schedule).not.toHaveBeenCalled();
    expect(none.schedule).not.toHaveBeenCalled();
    const fast = harness();
    fast.show(fast.input(answer(result(false)), { transitionMode: "accelerated" }));
    expect(fast.timers.map(timer => timer.delay)).toEqual([2000]);
  });

  it("is cancelled by grade/correct pending, previous mode, display change, version change, identity and dispose; correct never re-arms", () => {
    ticket = stepTicket();
    const cases: ((h: ReturnType<typeof harness>) => void)[] = [
      h => h.show(h.input(answer(result(true), { commands: { study: command({ pending: true, phase: "sending", kind: "result.grade" }), stop: command() } }))),
      h => h.show(h.input(answer(result(true), { display: { kind: "step", assignmentId: B2 }, phase: "prefetched" }))),
      h => h.show(h.input(answer(result(true, "6")))),
      h => h.show(h.input(answer(result(true), { sessionId: S2 }))),
      h => h.flow.dispose(),
      h => { h.flow.next(); },
    ];
    for (const change of cases) {
      const h = harness();
      h.show(h.input(answer(result(true))));
      change(h);
      expect(h.timers[0].cancelled).toBe(true);
      const before = h.actions.openStep.mock.calls.length;
      h.timers[0].run();
      expect(h.actions.openStep.mock.calls.length).toBe(before);
    }
    const corrected = harness();
    corrected.show(corrected.input(answer(result(false, "5", 2), { canCorrect: true }), { transitionMode: "accelerated" }));
    corrected.flow.correct();
    expect(corrected.actions.correct).toHaveBeenCalledTimes(1);
    expect(corrected.timers[0].cancelled).toBe(true);
    corrected.show(corrected.input(answer(result(false, "5", 2)), { transitionMode: "accelerated" }));
    expect(corrected.schedule).toHaveBeenCalledTimes(1);
  });

  it("a stale callback (other generation, cancelled, other ticket) does nothing", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(answer(result(true))));
    const first = h.timers[0];
    h.show(h.input(answer(result(true)), { source: { tuple: "tuple-1", access: access(2) } }));
    expect(first.cancelled).toBe(true);
    first.run(); // a scheduler that ignores cancel: generation and timer identity still refuse it
    expect(h.actions.openStep).not.toHaveBeenCalled();
    // A new access of the same identity is a return: the same result waits for Next, nothing re-arms.
    expect(h.timers).toHaveLength(1);

    const other = harness();
    other.show(other.input(answer(result(true))));
    const armed = other.timers[0];
    // Same row 11 and key, but the controller issued another step ticket: the armed callback must not use either.
    other.show(other.input(answer(result(true), { stepTicket: stepTicket() })));
    expect(other.timers).toHaveLength(1);
    armed.run();
    expect(other.actions.openStep).not.toHaveBeenCalled();
  });

  it("П02: the same result projected again with a newer document version keeps the one running timer (no second schedule)", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(answer(result(true))));
    const again = h.show(h.input(answer(result(true), { stateVersion: "50" })));
    expect(again).toMatchObject({ screen: "result", mode: "answer", timer: { durationMs: 3000 } });
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.timers[0].cancelled).toBe(false);
    h.fire();
    expect(onlyArgument(h.actions.openStep)).toBe(ticket);
    // A corrected result (new version) is another result: its own timer.
    const corrected = harness();
    corrected.show(corrected.input(answer(result(true))));
    corrected.show(corrected.input(answer(result(true, "6", 5))));
    expect(corrected.timers[0].cancelled).toBe(true);
    expect(corrected.schedule).toHaveBeenCalledTimes(2);
  });

  it("Ф12: after active=false→true the same result waits for Next; the timer never re-arms (DC 2.19, К05-152)", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(answer(result(true))));
    const paused = h.show(h.input(answer(result(true)), { active: false }));
    expect(paused).toMatchObject({ screen: "result", timer: null, canNext: false, grades: [] });
    expect(h.timers[0].cancelled).toBe(true);
    const back = h.show(h.input(answer(result(true))));
    expect(back).toMatchObject({ timer: null, canNext: true });
    for (const mode of ["normal", "accelerated"] as const) h.show(h.input(answer(result(true)), { transitionMode: mode }));
    expect(h.schedule).toHaveBeenCalledTimes(1);
    h.flow.next();
    expect(onlyArgument(h.actions.openStep)).toBe(ticket);
  });

  const graded = (state: ConjugationDocumentSnapshot) => ({ ...state, allowedGrades: [3, 4, 5] as const });
  /** The study lane after the grade command: its own outcome, the same result address. */
  const gradeOutcome = (outcome: "accepted" | "rejected", commandId = id(53)) => command({ phase: "settled", outcome, kind: "result.grade",
    sessionId: S1, rejectionCode: outcome === "rejected" ? "VERSION_CONFLICT" : null,
    resolved: { commandId, kind: "result.grade", sessionId: S1, assignmentId: A0, resultId: R1 } });

  it("an accepted grade in answer mode opens the step; in previous mode it stays", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(graded(answer(result(true)))));
    h.flow.grade(5);
    expect(h.actions.grade).toHaveBeenCalledWith(5);
    const next = stepTicket();
    h.show(h.input(answer(result(true, "6", 5), { stepTicket: next, commands: { study: gradeOutcome("accepted"), stop: command() } })));
    expect(onlyArgument(h.actions.openStep)).toBe(next);

    const p = harness();
    p.show(p.input(snap({ resultA: resultA(result(true)) })));
    p.flow.previous();
    p.show(p.input(graded(onResult(result(true), { stepTicket: ticket }))));
    p.flow.grade(3);
    p.show(p.input(onResult(result(true, "6", 3), { stepTicket: stepTicket(), commands: { study: gradeOutcome("accepted"), stop: command() } })));
    expect(p.actions.openStep).not.toHaveBeenCalled();
    expect(p.schedule).not.toHaveBeenCalled();
  });

  it("Ф7: the same grade (accepted as a no-op, version unchanged) advances once its command is accepted, not on a version", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(graded(answer(result(true)))));
    h.flow.grade(4);
    expect(h.timers[0].cancelled).toBe(true);
    // Before the command's outcome: the same version and grade are not an acknowledgement.
    const next = stepTicket();
    h.show(h.input(answer(result(true), { stepTicket: next })));
    expect(h.actions.openStep).not.toHaveBeenCalled();
    h.show(h.input(answer(result(true), { stepTicket: next, commands: { study: gradeOutcome("accepted"), stop: command() } })));
    expect(onlyArgument(h.actions.openStep)).toBe(next);
    expect(h.schedule).toHaveBeenCalledTimes(1);
  });

  it("Ф7: a version that grew without this grade's accepted command does not advance; a refusal drops the request", () => {
    ticket = stepTicket();
    const grown = harness();
    grown.show(grown.input(graded(answer(result(true)))));
    grown.flow.grade(5);
    grown.show(grown.input(answer(result(true, "6", 5), { stepTicket: stepTicket() })));
    expect(grown.actions.openStep).not.toHaveBeenCalled();

    const refused = harness();
    refused.show(refused.input(graded(answer(result(true)))));
    refused.flow.grade(5);
    refused.show(refused.input(answer(result(true), { stepTicket: stepTicket(), commands: { study: gradeOutcome("rejected"), stop: command() } })));
    // A later acceptance of some other grade command is not this request's outcome any more.
    refused.show(refused.input(answer(result(true, "6", 5), { stepTicket: stepTicket(), commands: { study: gradeOutcome("accepted", id(54)), stop: command() } })));
    expect(refused.actions.openStep).not.toHaveBeenCalled();
  });

  it("Ф7: the outcome resolved before the click is never taken for the new grade", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(graded(answer(result(true), { stepTicket: null }))));
    h.flow.grade(5);
    // The first grade is accepted while no step ticket exists yet; then a second, different grade is clicked.
    const earlier = { study: gradeOutcome("accepted", id(55)), stop: command() };
    h.show(h.input(graded(answer(result(true, "6", 5), { stepTicket: null, commands: earlier }))));
    h.flow.grade(4);
    h.show(h.input(answer(result(true, "7", 4), { stepTicket: stepTicket(), commands: earlier })));
    expect(h.actions.openStep).not.toHaveBeenCalled();
  });

  it("Ф7: an acceptance seen while inactive advances once on return, through the restored result", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(graded(answer(result(true)))));
    h.flow.grade(4);
    const accepted = { study: gradeOutcome("accepted"), stop: command() };
    h.show(h.input(answer(result(true), { commands: accepted }), { active: false }));
    expect(h.actions.openStep).not.toHaveBeenCalled();
    // A new document of the same identity: nothing selected yet; row 4a reopens A, the next commit advances.
    const A2 = access(2), fresh = { study: command(), stop: command() };
    h.show(h.input(answer(result(true), { display: { kind: "none" }, phase: "prefetched", commands: fresh }), { source: { tuple: "tuple-1", access: A2 } }));
    expect(h.actions.openResult).toHaveBeenCalledTimes(1);
    const next = stepTicket();
    h.show(h.input(answer(result(true), { stepTicket: next, commands: fresh }), { source: { tuple: "tuple-1", access: A2 } }));
    expect(onlyArgument(h.actions.openStep)).toBe(next);
    expect(h.schedule).toHaveBeenCalledTimes(1);
  });

  it("Enter-Next only on a correct answer row, only after the held Enter was released, never on repeat/IME", () => {
    ticket = stepTicket();
    const h = harness();
    h.show(h.input(snap()));
    h.flow.enter({ repeat: false, composing: false }); // the Enter that submitted, still held
    h.show(h.input(answer(result(true))));
    h.flow.enter({ repeat: true, composing: false });
    h.flow.enter({ repeat: false, composing: false });
    expect(h.actions.openStep).not.toHaveBeenCalled();
    h.flow.enterReleased();
    h.flow.enter({ repeat: false, composing: true });
    h.flow.enterReleased();
    h.flow.enter({ repeat: false, composing: false });
    expect(h.actions.openStep).toHaveBeenCalledTimes(1);

    const wrong = harness();
    wrong.show(wrong.input(answer(result(false))));
    wrong.flow.enter({ repeat: false, composing: false });
    expect(wrong.actions.openStep).not.toHaveBeenCalled();
  });
});

describe("conjugation test flow: present barrier, C1 and commit", () => {
  it("one shown per ticket after commit; repeated, foreign or inactive tickets send nothing", () => {
    const h = harness();
    const ticket = presentationTicket();
    const prefetched = snap({ phase: "prefetched", canSubmit: false, presentationTicket: ticket,
      currentStep: { stateVersion: "10", step: projection(assignment(B1, "prefetched")) } });
    h.flow.committed(ticket);
    expect(h.flow.project(h.input(prefetched))).toMatchObject({ screen: "question", presentationTicket: ticket, editable: true });
    h.flow.committed(ticket); // projected only, not committed
    expect(h.actions.shown).not.toHaveBeenCalled();
    h.flow.commit(h.input(prefetched));
    h.flow.committed(presentationTicket());
    h.flow.committed(ticket); h.flow.committed(ticket);
    h.show(h.input(prefetched));
    h.flow.committed(ticket);
    expect(onlyArgument(h.actions.shown)).toBe(ticket);
    const other = harness();
    other.show(other.input(prefetched, { active: false }));
    other.flow.committed(ticket);
    expect(other.actions.shown).not.toHaveBeenCalled();
  });

  it("rows 6–7: presenting keeps submit/grades/correct closed; Next back to B only with the C1 ticket", () => {
    const h = harness();
    const question = h.show(h.input(snap({ phase: "visible_unconfirmed", canSubmit: false, resultA: resultA(result(true)) })));
    expect(question).toMatchObject({ screen: "question", status: "presenting", canSubmit: false, editable: true, canPrevious: true });
    h.flow.setDraft("geh"); h.flow.submit();
    h.flow.previous();
    const noTicket = h.show(h.input(onResult(result(true), { phase: "visible_unconfirmed", allowedGrades: [], canCorrect: false })));
    expect(noTicket).toMatchObject({ screen: "result", mode: "previous", barrier: true, grades: [], canCorrect: false, canNext: false, timer: null });
    h.flow.next(); h.flow.grade(4); h.flow.correct();
    const back = stepTicket();
    expect(h.show(h.input(onResult(result(true), { phase: "visible_unconfirmed", stepTicket: back })))).toMatchObject({ barrier: true, canNext: true });
    h.flow.next();
    expect(h.actions.submit).not.toHaveBeenCalled();
    expect(h.actions.grade).not.toHaveBeenCalled();
    expect(h.actions.correct).not.toHaveBeenCalled();
    expect(onlyArgument(h.actions.openStep)).toBe(back);
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it("rows 4/4a: exactly one automatic local transition, only on commit and only when active", () => {
    const h = harness();
    const ticket = stepTicket();
    const none = snap({ phase: "prefetched", display: { kind: "none" }, stepTicket: ticket, canSubmit: false,
      currentStep: { stateVersion: "10", step: projection(assignment(B1, "prefetched")) } });
    h.flow.project(h.input(none));
    expect(h.calls()).toBe(0);
    h.show(h.input(none, { active: false }));
    expect(h.calls()).toBe(0);
    h.show(h.input(none)); h.show(h.input(none));
    expect(onlyArgument(h.actions.openStep)).toBe(ticket);

    const restore = harness();
    const a = onResult(result(true), { display: { kind: "none" }, phase: "prefetched", stepTicket: stepTicket() });
    restore.show(restore.input(a)); restore.show(restore.input(a));
    expect(restore.actions.openResult).toHaveBeenCalledTimes(1);
    expect(restore.actions.openStep).not.toHaveBeenCalled();

    const step = harness();
    step.show(step.input(snap({ resultA: resultA(result(true)) })));
    const back = stepTicket();
    step.show(step.input(onResult(result(true), { display: { kind: "none" }, phase: "prefetched", stepTicket: back })));
    expect(onlyArgument(step.actions.openStep)).toBe(back);
    expect(step.actions.openResult).not.toHaveBeenCalled();
  });

  /** The live summary after the answer A; a document after a return has no display yet and offers its step ticket. */
  const summaryOf = (over: Partial<ConjugationDocumentSnapshot> = {}) => snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false,
    canSummaryHome: true, resultA: resultA(result(true)), currentStep: { stateVersion: "10", step: projection(null, "summary") }, ...over });
  const returned = (ticket: ConjugationStepTicket, over: Partial<ConjugationDocumentSnapshot> = {}) => summaryOf({ display: { kind: "none" },
    stepTicket: ticket, ...over });

  it("row 4a: a return from the background on the summary restores the summary, not the result of the last answer", () => {
    const h = harness();
    h.show(h.input(onResult(result(true), { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: stepTicket() })));
    h.show(h.input(summaryOf()));
    h.show(h.input(summaryOf(), { active: false }));
    const back = stepTicket();
    h.show(h.input(returned(back), { active: false }));
    expect(h.calls()).toBe(0);
    h.show(h.input(returned(back))); h.show(h.input(returned(back)));
    expect(onlyArgument(h.actions.openStep)).toBe(back);
    expect(h.actions.openResult).not.toHaveBeenCalled();
    expect(h.show(h.input(summaryOf()))).toMatchObject({ screen: "summary", canHome: true, canPrevious: true });
    // К06-102 still works after the return: previous reopens A, and the remembered display is A again.
    h.flow.previous();
    expect(h.actions.openResult).toHaveBeenCalledTimes(1);
    h.show(h.input(onResult(result(true), { stepTicket: stepTicket(), currentStep: { stateVersion: "10", step: projection(null, "summary") } })));
    h.show(h.input(returned(stepTicket())));
    expect(h.actions.openResult).toHaveBeenCalledTimes(2);
    expect(h.actions.openStep).toHaveBeenCalledTimes(1);
  });

  it("row 4a: the remembered summary belongs to its session; a new session with a known A restores that A", () => {
    const direct = harness();
    direct.show(direct.input(summaryOf()));
    const other = onResult(result(true), { sessionId: S2, display: { kind: "none" }, phase: "prefetched", stepTicket: stepTicket() });
    direct.show(direct.input(other));
    expect(direct.actions.openResult).toHaveBeenCalledTimes(1);
    expect(direct.actions.openStep).not.toHaveBeenCalled();

    const closed = harness();
    closed.show(closed.input(summaryOf()));
    closed.show(closed.input(snap({ phase: "closed", display: { kind: "closed" }, currentStep: null, terminalSessionIds: [S1],
      closed: { sessionId: S1, reason: "summary_home", summary: summaryFixture() } })));
    closed.show(closed.input(other));
    expect(closed.actions.openResult).toHaveBeenCalledTimes(1);
    expect(closed.actions.openStep).not.toHaveBeenCalled();
  });
});

describe("conjugation test flow: unknown, lanes and no automatic commands", () => {
  const unknownText = (payload: { text: string } | { forgot: true }) => snap({ phase: "unknown", canSubmit: false, currentStep: null,
    display: { kind: "none" }, canRetry: { study: true, stop: false },
    commands: { study: command({ phase: "unresolved", pending: true, kind: "answer.submit", sessionId: S1,
      pendingIntent: { command_id: id(70), kind: "answer.submit", session_id: S1, assignment_id: B1, payload } }), stop: command() } });

  it("unknown answer shows the last question with the exact pending text read-only; Retry once; 10 min → nothing", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("different");
    const view = h.show(h.input(unknownText({ text: " gehst  " })));
    expect(view).toMatchObject({ screen: "question", draft: " gehst  ", editable: false, canSubmit: false, status: "unknown", pendingForgot: false });
    h.flow.submit(); h.flow.setDraft("x");
    h.flow.retry("study");
    expect(h.actions.retry.mock.calls).toEqual([["study"]]);
    for (let i = 0; i < 600; i++) h.show(h.input(unknownText({ text: " gehst  " })));
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.calls()).toBe(1);
    expect(h.show(h.input(unknownText({ forgot: true })))).toMatchObject({ draft: "", pendingForgot: true });
  });

  it("rows 9/14 and an unknown revision: submitting and stopping are read-only; unknown grade keeps A without rights", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    const sending = command({ phase: "sending", pending: true, kind: "answer.submit", sessionId: S1 });
    expect(h.show(h.input(snap({ canSubmit: false, commands: { study: sending, stop: command() } }))))
      .toMatchObject({ screen: "question", status: "submitting", editable: false, canSubmit: false, draft: "geh", canPrevious: false });
    expect(h.show(h.input(snap({ phase: "stopping", canSubmit: false, canStop: false }))))
      .toMatchObject({ screen: "question", stopping: true, editable: false, canStop: false, draft: "geh" });
    h.flow.setDraft("x"); h.flow.submit(); h.flow.stop();
    expect(h.calls()).toBe(0);

    const r = harness();
    r.show(r.input(onResult(result(true), { allowedGrades: [3, 4, 5] })));
    const revision = command({ phase: "unresolved", pending: true, kind: "result.grade", sessionId: S1,
      pendingIntent: { command_id: id(71), kind: "result.grade", session_id: S1, assignment_id: A0, result_id: R1,
        expected_result_version: "5", payload: { grade: 4 } } });
    expect(r.show(r.input(snap({ phase: "unknown", display: { kind: "none" }, currentStep: null, resultA: null, canSubmit: false,
      commands: { study: revision, stop: command() } })))).toMatchObject({ screen: "result", pending: "unknown", grades: [], canCorrect: false,
      canNext: false, timer: null, result: { result_id: R1, version: "5" } });
    r.flow.grade(4); r.flow.next();
    expect(r.calls()).toBe(0);
  });

  it("Ф2: an unknown answer, an unknown revision and recovery offer a manual check (GET), only while active", () => {
    const h = harness();
    h.show(h.input(snap()));
    const unknown = h.show(h.input(unknownText({ text: "gehst" })));
    expect(unknown).toMatchObject({ screen: "question", status: "unknown", canCheck: true });
    h.flow.refresh();
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    expect(h.show(h.input(unknownText({ text: "gehst" }), { active: false }))).toMatchObject({ canCheck: false });
    h.flow.refresh();
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);

    const r = harness();
    r.show(r.input(onResult(result(true))));
    const revision = command({ phase: "unresolved", pending: true, kind: "result.grade", sessionId: S1,
      pendingIntent: { command_id: id(71), kind: "result.grade", session_id: S1, assignment_id: A0, result_id: R1,
        expected_result_version: "5", payload: { grade: 4 } } });
    expect(r.show(r.input(snap({ phase: "unknown", display: { kind: "none" }, currentStep: null, resultA: null, canSubmit: false,
      commands: { study: revision, stop: command() } })))).toMatchObject({ screen: "result", pending: "unknown", canCheck: true });
    r.flow.refresh();
    expect(r.actions.refresh).toHaveBeenCalledTimes(1);

    const recovery = harness();
    expect(recovery.show(recovery.input({ ...unknownText({ text: "x" }), sessionId: null }))).toMatchObject({ screen: "recovery", canCheck: true });
    recovery.flow.refresh();
    expect(recovery.actions.refresh).toHaveBeenCalledTimes(1);
  });

  it("Ф2: an ordinary question, result or summary offers no check; refresh there sends nothing", () => {
    const h = harness();
    const summary = snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false, canSummaryHome: true,
      currentStep: { stateVersion: "10", step: projection(null, "summary") } });
    for (const state of [snap(), onResult(result(true)), summary]) {
      expect(h.show(h.input(state))).toMatchObject({ canCheck: false });
      h.flow.refresh();
    }
    expect(h.actions.refresh).not.toHaveBeenCalled();
  });

  it("Ф10: an unknown answer to another assignment is never shown under the remembered question", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    const foreign = command({ phase: "unresolved", pending: true, kind: "answer.submit", sessionId: S1,
      pendingIntent: { command_id: id(72), kind: "answer.submit", session_id: S1, assignment_id: B2, payload: { text: "kommst" } } });
    const view = h.show(h.input({ ...unknownText({ text: "x" }), commands: { study: foreign, stop: command() } }));
    expect(view.screen).toBe("recovery");
    expect(h.calls()).toBe(0);
  });

  it("without the question in memory (recovery, no seed) the view is recovery with manual retry only", () => {
    const h = harness();
    const recovery = { ...unknownText({ text: "x" }), sessionId: null, problem: "unconfirmed_session" };
    expect(h.show(h.input(recovery))).toMatchObject({ screen: "recovery", problem: "unconfirmed_session", canRetry: { study: true, stop: false } });
    expect(h.calls()).toBe(0);
  });

  it("lanes are independent: Stop and its retry stay available while the study answer is unknown", () => {
    const h = harness();
    h.show(h.input(snap()));
    h.show(h.input({ ...unknownText({ text: "a" }), canRetry: { study: false, stop: true }, canStop: true }));
    h.flow.retry("study"); h.flow.retry("stop"); h.flow.stop();
    expect(h.actions.retry.mock.calls).toEqual([["stop"]]);
    expect(h.actions.stop.mock.calls).toEqual([["stop"]]);
  });

  it("stale → manual refresh only; start/submit/retry/stop/refresh are never automatic", () => {
    const h = harness();
    const ticket = stepTicket();
    const sequence = [snap(), snap({ phase: "stale", problem: "network", currentStep: null, display: { kind: "none" } }),
      onResult(result(true), { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: ticket }),
      snap({ phase: "loading", display: { kind: "none" } }), null,
      snap({ phase: "closed", terminalSessionIds: [S1], display: { kind: "closed" }, closed: { sessionId: S1, reason: "stop", summary: null } })];
    for (const state of sequence) h.show(h.input(state));
    h.timers.forEach(timer => timer.run());
    for (const spy of [h.actions.start, h.actions.submit, h.actions.retry, h.actions.stop, h.actions.refresh, h.actions.shown, h.actions.grade, h.actions.correct]) {
      expect(spy).not.toHaveBeenCalled();
    }
    const stale = harness();
    expect(stale.show(stale.input(sequence[1]))).toMatchObject({ screen: "stale", problem: "network" });
    stale.flow.refresh();
    expect(stale.actions.refresh).toHaveBeenCalledTimes(1);
  });
});

describe("conjugation test flow: project against the last commit (adapter seam)", () => {
  it("project never calls actions, schedule or onToday and does not change what intents act on", () => {
    const h = harness();
    const ticket = stepTicket();
    h.show(h.input(snap()));
    h.flow.setDraft("geh");
    for (const value of [h.input(null), h.input(snap(), { source: { tuple: "tuple-2", access: access(3) } }),
      h.input(onResult(result(true), { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: ticket })),
      h.input(snap({ phase: "closed", terminalSessionIds: [S1], display: { kind: "closed" }, closed: { sessionId: S1, reason: "summary_home", summary: null } }))]) {
      h.flow.project(value);
    }
    expect(h.calls()).toBe(0);
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.onToday).not.toHaveBeenCalled();
    expect(h.flow.project(h.input(snap()))).toMatchObject({ screen: "question", draft: "geh" });
  });

  it("after commit of a new access or state:null, a callback armed under the old source sends nothing", () => {
    const h = harness();
    const ticket = stepTicket();
    h.show(h.input(onResult(result(true), { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: ticket })));
    const armed = h.timers[0];
    h.show(h.input(null));
    armed.run();
    h.show(h.input(onResult(result(true), { stepTicket: ticket }), { source: { tuple: "tuple-1", access: access(2) } }));
    armed.run();
    expect(h.actions.openStep).not.toHaveBeenCalled();
    // Between such a render and its commit the flow still holds the previous commit; the adapter (hook actions
    // bound to the current source) is the layer that refuses the old transport — proven with the real hook in CP2.
  });
});

describe("conjugation test flow: change notification (G-2 V3) and CP2 corrections", () => {
  it("onChange only after an accepted, different draft; never from project, commit, refused or repeated text, or after dispose", () => {
    const h = harness();
    h.flow.project(h.input(snap()));
    h.show(h.input(snap()));
    for (let i = 0; i < 20; i++) h.show(h.input(snap({ stateVersion: String(11 + i) })));
    expect(h.onChange).not.toHaveBeenCalled();
    h.flow.setDraft("g"); h.flow.setDraft("ge"); h.flow.setDraft("ge");
    expect(h.onChange).toHaveBeenCalledTimes(2);
    expect(h.flow.project(h.input(snap()))).toMatchObject({ draft: "ge" });
    h.show(h.input(snap({ canSubmit: false })));
    h.flow.setDraft("refused");
    h.show(h.input(null));
    h.flow.setDraft("masked");
    expect(h.onChange).toHaveBeenCalledTimes(2);
    h.show(h.input(snap()));
    h.flow.dispose();
    h.flow.setDraft("after dispose");
    expect(h.onChange).toHaveBeenCalledTimes(2);
    expect(h.calls()).toBe(0);
  });

  it("requires onChange: no silent default", () => {
    const actions = harness().actions;
    const options = { actions, schedule: () => () => undefined, onToday: () => undefined };
    expect(() => new ConjugationTestFlow({ ...options, onChange: undefined as unknown as () => void })).toThrow("onChange");
  });

  it("canSubmit is false for a blank draft while 'I forgot' keeps its right; a text answer stays verbatim", () => {
    const h = harness();
    expect(h.show(h.input(snap()))).toMatchObject({ canSubmit: false, canForget: true, editable: true });
    h.flow.setDraft("   ");
    expect(h.show(h.input(snap()))).toMatchObject({ draft: "   ", canSubmit: false, canForget: true });
    h.flow.submit();
    expect(h.actions.submit).not.toHaveBeenCalled();
    h.flow.forget();
    h.flow.setDraft("  geht ");
    expect(h.show(h.input(snap()))).toMatchObject({ canSubmit: true });
    h.flow.submit();
    expect(h.actions.submit.mock.calls).toEqual([[{ forgot: true }, B1], [{ text: "  geht " }, B1]]);
    expect(h.show(h.input(snap({ canSubmit: false })))).toMatchObject({ canSubmit: false, canForget: false });
  });

  it("an armed timer keeps its armed duration: normal→accelerated neither re-arms nor redraws; accelerated→normal on a wrong answer does not cancel", () => {
    const ticket = stepTicket();
    const answer = (value: WrittenResult) => onResult(value, { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: ticket });
    const h = harness();
    expect(h.show(h.input(answer(result(true))))).toMatchObject({ timer: { durationMs: 3000 } });
    const view = h.show(h.input(answer(result(true)), { transitionMode: "accelerated" }));
    expect(view).toMatchObject({ timer: { durationMs: 3000 } });
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.timers[0]).toMatchObject({ delay: 3000, cancelled: false });
    h.fire();
    expect(onlyArgument(h.actions.openStep)).toBe(ticket);

    const wrong = harness();
    wrong.show(wrong.input(answer(result(false)), { transitionMode: "accelerated" }));
    expect(wrong.show(wrong.input(answer(result(false)), { transitionMode: "normal" }))).toMatchObject({ timer: { durationMs: 2000 } });
    expect(wrong.timers).toHaveLength(1);
    expect(wrong.timers[0].cancelled).toBe(false);
  });
});

describe("conjugation test flow: «Шаг назад» (result.undo)", () => {
  const undoable = (state: ConjugationDocumentSnapshot) => ({ ...state, canUndo: true });
  const summaryWithA = (over: Partial<ConjugationDocumentSnapshot> = {}) => snap({ phase: "summary", display: { kind: "summary" }, canSubmit: false,
    canSummaryHome: true, canUndo: true, resultA: resultA(result(true)), currentStep: { stateVersion: "10", step: projection(null, "summary") }, ...over });
  const undoIntent = { command_id: id(72), kind: "result.undo" as const, session_id: S1, assignment_id: A0, result_id: R1, expected_result_version: "5", payload: {} };
  const undoCommand = (over: Partial<ConjugationCommandSnapshot> = {}) => command({ kind: "result.undo", sessionId: S1, ...over });

  it("the result screen and the live summary offer it exactly when the document grants it", () => {
    const h = harness();
    expect(h.show(h.input(onResult(result(true))))).toMatchObject({ screen: "result", canUndo: false });
    expect(h.show(h.input(undoable(onResult(result(true)))))).toMatchObject({ screen: "result", canUndo: true });
    expect(h.show(h.input(undoable(onResult(result(false)))))).toMatchObject({ screen: "result", canUndo: true });
    expect(h.show(h.input(undoable(onResult(result(true))), { active: false }))).toMatchObject({ screen: "result", canUndo: false });
    expect(h.show(h.input(summaryWithA()))).toMatchObject({ screen: "summary", canUndo: true });
    expect(h.show(h.input(summaryWithA({ canUndo: false })))).toMatchObject({ screen: "summary", canUndo: false });
    expect(h.show(h.input(summaryWithA(), { active: false }))).toMatchObject({ screen: "summary", canUndo: false });
    // The question of the next form never offers it (M-UNDO §9.2).
    expect(h.show(h.input(undoable(snap())))).toMatchObject({ screen: "question" });
    expect(h.show(h.input(undoable(snap())))).not.toHaveProperty("canUndo");
  });

  it("undo() asks the document once; the running timer is cancelled for good and never re-arms", () => {
    const h = harness();
    const ticket = stepTicket();
    const state = undoable(onResult(result(true), { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: ticket }));
    expect(h.show(h.input(state))).toMatchObject({ screen: "result", mode: "answer", timer: { durationMs: 3000 } });
    expect(h.running()).toHaveLength(1);
    h.flow.undo();
    expect(h.actions.undo).toHaveBeenCalledTimes(1);
    expect(h.running()).toHaveLength(0);
    expect(h.show(h.input(state))).toMatchObject({ timer: null });
    expect(h.schedule).toHaveBeenCalledTimes(1);
    expect(h.actions.openStep).not.toHaveBeenCalled();
  });

  it("undo() from the summary and from a previous answer; never from a question, inactive, or without the right", () => {
    const s1 = harness();
    s1.show(s1.input(summaryWithA()));
    s1.flow.undo();
    expect(s1.actions.undo).toHaveBeenCalledTimes(1);

    const prev = harness();
    prev.show(prev.input(snap({ resultA: resultA(result(true)) })));
    prev.flow.previous();
    prev.show(prev.input(undoable(onResult(result(true), { stepTicket: stepTicket() }))));
    prev.flow.undo();
    expect(prev.actions.undo).toHaveBeenCalledTimes(1);

    const none = harness();
    none.show(none.input(snap()));
    none.flow.undo();
    none.show(none.input(onResult(result(true))));
    none.flow.undo();
    none.show(none.input(undoable(onResult(result(true))), { active: false }));
    none.flow.undo();
    none.show(none.input(null));
    none.flow.undo();
    expect(none.actions.undo).not.toHaveBeenCalled();
  });

  it("while the command runs the view is busy: «changing», no grades, no second undo, status text flag", () => {
    const h = harness();
    h.show(h.input(undoable(onResult(result(true)))));
    const busy = onResult(result(true), { allowedGrades: [], canUndo: false,
      commands: { study: undoCommand({ phase: "sending", pending: true, pendingIntent: undoIntent }), stop: command() } });
    expect(h.show(h.input(busy))).toMatchObject({ screen: "result", pending: "changing", undoing: true, canUndo: false, grades: [], canCorrect: false, canNext: false });
    h.flow.undo(); h.flow.grade(5); h.flow.next();
    expect(h.actions.undo).not.toHaveBeenCalled();
    const summaryBusy = summaryWithA({ canUndo: false, commands: { study: undoCommand({ phase: "sending", pending: true, pendingIntent: undoIntent }), stop: command() } });
    expect(h.show(h.input(summaryBusy))).toMatchObject({ screen: "summary", undoing: true, canUndo: false });
    expect(h.show(h.input(onResult(result(true))))).toMatchObject({ undoing: false });
    // A stale right in the document snapshot cannot be offered while a revision of the same answer is in flight.
    const grading = onResult(result(true), { canUndo: true, commands: { study: command({ phase: "sending", pending: true, kind: "result.grade", sessionId: S1,
      pendingIntent: { command_id: id(74), kind: "result.grade", session_id: S1, assignment_id: A0, result_id: R1, expected_result_version: "5", payload: { grade: 5 } } }),
      stop: command() } });
    expect(h.show(h.input(grading))).toMatchObject({ screen: "result", pending: "changing", canUndo: false });
  });

  it("an unknown outcome keeps the answer on screen as «checking», with check and retry, and cannot undo again", () => {
    const h = harness();
    h.show(h.input(undoable(onResult(result(true)))));
    const unknown = snap({ phase: "unknown", display: { kind: "none" }, currentStep: null, resultA: null, canSubmit: false, canRetry: { study: true, stop: false },
      commands: { study: undoCommand({ phase: "unresolved", pending: true, canRetry: true, pendingIntent: undoIntent }), stop: command() } });
    expect(h.show(h.input(unknown))).toMatchObject({ screen: "result", pending: "unknown", undoing: false, canUndo: false, grades: [], canCorrect: false,
      canNext: false, canCheck: true, canRetry: { study: true }, result: { result_id: R1, version: "5" } });
    h.flow.undo(); h.flow.refresh(); h.flow.retry("study");
    expect(h.actions.undo).not.toHaveBeenCalled();
    expect(h.actions.refresh).toHaveBeenCalledTimes(1);
    expect(h.actions.retry).toHaveBeenCalledWith("study");
    // Without the remembered answer (e.g. after a restart) only the generic recovery remains.
    const fresh = harness();
    expect(fresh.show(fresh.input(unknown))).toMatchObject({ screen: "recovery", canCheck: true });
  });

  it.each(["CAPABILITY_EXPIRED", "VERSION_CONFLICT", "FORBIDDEN", "ASSIGNMENT_STALE"])("refusal %s is the «step back is gone» problem of the answer screen only", code => {
    const h = harness();
    const rejected = undoCommand({ phase: "settled", outcome: "rejected", rejectionCode: code,
      resolved: { commandId: id(72), kind: "result.undo", sessionId: S1, assignmentId: A0 } });
    const refused = onResult(result(true), { problem: code, commands: { study: rejected, stop: command() } });
    expect(h.show(h.input(refused))).toMatchObject({ screen: "result", problem: "UNDO_UNAVAILABLE", canUndo: false });
    expect(h.show(h.input(summaryWithA({ canUndo: false, problem: code, commands: { study: rejected, stop: command() } })))).toMatchObject({ screen: "summary", problem: "UNDO_UNAVAILABLE" });
    // Once the person reaches the next question the old refusal is not repeated under it.
    expect(h.show(h.input(snap({ problem: code, commands: { study: rejected, stop: command() } })))).toMatchObject({ screen: "question", problem: null });
  });

  it("other refusals and other commands keep their own problem codes", () => {
    const h = harness();
    const code = (kind: "result.undo" | "result.grade", rejectionCode: string) => undoCommand({ phase: "settled", outcome: "rejected", rejectionCode, kind: null,
      resolved: { commandId: id(72), kind, sessionId: S1, assignmentId: A0 } });
    for (const [kind, rejection] of [["result.undo", "SESSION_CLOSED"], ["result.undo", "SESSION_BUSY"], ["result.grade", "VERSION_CONFLICT"]] as const) {
      const state = onResult(result(true), { problem: rejection, commands: { study: code(kind, rejection), stop: command() } });
      expect(h.show(h.input(state))).toMatchObject({ screen: "result", problem: rejection });
    }
    // A problem of another source is not turned into the undo message even right after an undo refusal.
    const rejected = code("result.undo", "VERSION_CONFLICT");
    expect(h.show(h.input(onResult(result(true), { problem: "network", commands: { study: rejected, stop: command() } })))).toMatchObject({ problem: "network" });
  });

  it("an accepted undo leaves nothing of the answer: the form comes back as the next question and «Предыдущий ответ» is gone", () => {
    const h = harness();
    const ticket = stepTicket();
    h.show(h.input(undoable(onResult(result(true), { commands: { study: acceptedAnswer(), stop: command() }, stepTicket: ticket }))));
    const accepted = undoCommand({ phase: "settled", outcome: "accepted", kind: null,
      resolved: { commandId: id(72), kind: "result.undo", sessionId: S1, assignmentId: A0, resultId: R1, objectVersion: "6" } });
    const again = snap({ phase: "prefetched", display: { kind: "step", assignmentId: B2 }, resultA: null, acceptedAddress: null, canSubmit: false,
      currentStep: { stateVersion: "11", step: projection(assignment(B2, "prefetched")) }, commands: { study: accepted, stop: command() } });
    const view = h.show(h.input(again));
    expect(view).toMatchObject({ screen: "question", canPrevious: false, draft: "", problem: null });
    expect(view).toMatchObject({ question: conjugationQuestion(assignment(B2, "prefetched")) });
    // The forgotten answer is not restored by any later snapshot of the same identity (also not in the unknown screen).
    const revision = command({ phase: "unresolved", pending: true, kind: "result.grade", sessionId: S1,
      pendingIntent: { command_id: id(73), kind: "result.grade", session_id: S1, assignment_id: A0, result_id: R1, expected_result_version: "5", payload: { grade: 4 } } });
    expect(h.show(h.input(snap({ phase: "unknown", display: { kind: "none" }, currentStep: null, resultA: null, canSubmit: false,
      commands: { study: revision, stop: command() } })))).toMatchObject({ screen: "recovery" });
  });
});
