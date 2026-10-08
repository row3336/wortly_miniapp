// The shared result view of the answer modes (M-REFAC-CMD), driven over scripted document lanes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile, PublicAssignment } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import { StudyView, type StudyAnswer, type StudyCommands, type StudyCurrent, type StudyLanes, type StudyViewFields,
  type StudyViewRules, type StudyPhase } from "./studyView";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SESSION = id(3);
const assignment = (n: number, status: "prefetched" | "presented"): PublicAssignment => ({ id: id(n), card_id: id(n + 50),
  status, kind: "original", prompt: { text: "дом", language: "ru", translations: ["дом"], personal_translation_version: null,
    conjunction_hint: null }, answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } });
const current = (item: PublicAssignment | null, status: StudyCurrent["status"] = "active"): StudyCurrent =>
  ({ session_id: SESSION, status, pair: "ru-de", close_reason: null, assignment: item });
const target = (version: string) => ({ session_id: SESSION, assignment_id: id(6), result_id: id(7), expected_result_version: version });
const answer = (grade: number, version = "1"): StudyAnswer => ({ action: { action_id: id(8), version, status: "active" },
  result: { result_id: id(7), assignment_id: id(6), version, grade, status: "active" },
  capabilities: { correct_target: grade === 2 ? target(version) : null, grades: grade >= 3 ? { ...target(version), values: [3, 4, 5] } : null,
    undo_target: null } });
type Lane = StudyLanes["primary"];
const idle = (): Lane => ({ phase: "idle", pending: false, kind: null, pendingIntent: null, outcome: null, resolved: null,
  rejectionCode: null, problem: null, canRetry: false, current: null, answer: null, closedSession: null, stateVersion: null });
type Snapshot = StudyViewFields<StudyCurrent, StudyAnswer, StudyLanes> & { phase: StudyPhase };

/** Scripted lanes: each begin settles at once with the reply the test prepared for its kind. */
function lanes() {
  let version = 5, next = 100;
  const state: StudyLanes = { live: true, stateVersion: "5", canBegin: true, canStop: true, primary: idle(), stop: idle(), recovery: null,
    automaticPrimary: false };
  let publish: (state: StudyLanes) => void = () => {};
  const replies = new Map<string, (action: Record<string, unknown>) => Partial<Lane>>();
  const commands = {
    snapshot: () => structuredClone(state),
    begin: vi.fn(async (action: Record<string, unknown>) => {
      version += 1; state.stateVersion = String(version);
      const reply = replies.get(String(action.kind))?.(action) ?? {};
      state.primary = { ...idle(), phase: "settled", outcome: "accepted", stateVersion: String(version),
        resolved: { commandId: id(next++), kind: String(action.kind), sessionId: SESSION }, ...reply };
      publish(structuredClone(state));
    }),
    retry: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    readSession: vi.fn(async () => ({ state_version: String(version), current: current(assignment(6, "presented")) as object })),
    readResult: vi.fn(async () => ({ state_version: String(version), step: current(assignment(6, "presented")), ...answer(4) })),
    setRecoveryActive: vi.fn(), dispose: vi.fn(),
  } satisfies StudyCommands;
  return { state, commands, replies, publish: () => publish(structuredClone(state)),
    connect: (onUpdate: (state: StudyLanes) => void) => { publish = onUpdate; return commands; } };
}

const profile: Profile = { profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
  state_version: "5", access: { status: "admitted", version: "1", reason: null } };
const opened: OpenedClient = { status: "opened", client_instance_id: id(2), document_id: id(4), document_epoch: "1", proof_version: "1",
  profile, session: null, compatibility: { compatible: true, contract_version: "1" } };
type Fake = ReturnType<typeof lanes>["commands"];
class TestView extends StudyView<Fake, StudyCurrent, StudyAnswer, Snapshot> {
  closed: { sessionId: string; reason: string | null }[] = [];
  closeNow = false;
  protected close(sessionId: string, reason: string | null): void { this.cancelTimer(); this.phase = "closed"; this.closed.push({ sessionId, reason }); }
  protected closure(): { reason: string | null } | null { return this.closeNow ? { reason: "stop" } : null; }
  protected recoveredSession(state: StudyLanes): string | null { return state.primary.pendingIntent?.session_id ?? null; }
  protected activeAssignment(): PublicAssignment | null { return this.current?.status === "active" ? this.current.assignment : null; }
  protected runStop(send: () => Promise<void>): Promise<void> { return send(); }
  snapshot(): Snapshot { const { fields, live } = this.view(); return { phase: live ? this.phase : "disposed", ...fields }; }
}
function view(options: { mode?: "normal" | "accelerated"; rules?: Partial<StudyViewRules>; sessionId?: string | null } = {}) {
  const f = lanes(), access = createOpenedAccess({ opened, token: "t", proof: "p", generation: 1, isLive: () => true, onDenied: () => {} });
  const onUpdate = vi.fn<(snapshot: Snapshot) => void>();
  const controller = new TestView({ access: () => access, newId: () => id(99), sessionId: options.sessionId === undefined ? SESSION : options.sessionId,
    transitionMode: () => options.mode ?? "normal", onUpdate },
  { ignoreUnboundUnavailable: true, keepClosedAfterRead: true, ...options.rules }, f.connect);
  return { ...f, controller, onUpdate };
}
/** An answer whose undo the server grants (C-UNDO-1). */
const undoable = (grade: number): StudyAnswer => ({ ...answer(grade),
  capabilities: { ...answer(grade).capabilities, undo_target: { ...target("1"), action_id: id(8), kind: "answer.submit" } } });
const undoResolved = { commandId: id(92), kind: "result.undo", sessionId: SESSION, assignmentId: id(6), resultId: id(7) };
/** The answer reply: the result and the next prefetched question B. */
const answered = (grade: number) => () => ({ resolved: { commandId: id(90), kind: "answer.submit", sessionId: SESSION, assignmentId: id(6), resultId: id(7) },
  answer: answer(grade), current: current(assignment(10, "prefetched")) });

describe("shared study view", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a correct result advances by its timer to the next question with exactly one present", async () => {
    const f = view(); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", canSubmit: false });
    f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4));
    f.replies.set("assignment.present", () => ({ current: current(assignment(10, "presented")) }));
    await f.controller.submit();
    expect(f.commands.begin.mock.calls[0][0]).toEqual({ kind: "answer.submit", session_id: SESSION, assignment_id: id(6), payload: { text: "Haus" } });
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", draft: "", // the read pauses and the submit cancels once: the second generation is armed.
      timer: { key: `${SESSION}:${id(7)}:1:2`, durationMs: 3000 } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.commands.begin.mock.calls.map(call => call[0].kind)).toEqual(["answer.submit", "assignment.present"]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", question: { id: id(10), status: "presented" }, timer: null });
  });
  it("a wrong result waits for «Далее» in the normal mode and advances in the accelerated one", async () => {
    for (const [mode, timer] of [["normal", null], ["accelerated", 2000]] as const) {
      const f = view({ mode }); await f.controller.refresh();
      f.controller.setDraft("x"); f.replies.set("answer.submit", answered(2)); await f.controller.submit();
      expect(f.controller.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true, grades: [] });
      expect(f.controller.snapshot().timer?.durationMs ?? null).toBe(timer);
    }
  });
  it("background is not Stop: the timer stops and the result waits for «Далее» after return", async () => {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4)); await f.controller.submit();
    expect(f.controller.snapshot().timer).not.toBeNull();
    f.controller.suspend();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: false });
    f.commands.readResult.mockResolvedValueOnce({ state_version: "6", step: current(assignment(10, "prefetched")), ...answer(4) });
    await f.controller.resume();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.commands.begin).toHaveBeenCalledOnce();
  });
  /** A shown result with 2 of its 3 seconds gone, then a profile version bump (as a Settings change makes) before the next read. */
  async function shownResultAfterTwoSeconds() {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4));
    f.replies.set("assignment.present", () => ({ current: current(assignment(10, "presented")) }));
    await f.controller.submit();
    expect(f.controller.snapshot().timer).toMatchObject({ durationMs: 3000 });
    await vi.advanceTimersByTimeAsync(2000);
    f.state.stateVersion = "50";
    f.commands.readSession.mockResolvedValue({ state_version: "50", current: current(assignment(10, "prefetched")) as object });
    return f;
  }
  const readOf = (result: StudyAnswer) => ({ state_version: "50", step: current(assignment(10, "prefetched")), ...result });

  it("П02: the same result with the same version, received again, continues the original countdown", async () => {
    const f = await shownResultAfterTwoSeconds();
    f.commands.readResult.mockResolvedValue(readOf(answer(4)));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 1000 } });
    await vi.advanceTimersByTimeAsync(999);
    expect(f.commands.begin).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.commands.begin.mock.calls.map(call => call[0].kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("П02: the countdown keeps running while the read is in flight", async () => {
    const f = await shownResultAfterTwoSeconds();
    f.commands.readResult.mockResolvedValue(readOf(answer(4)));
    f.commands.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { setTimeout(resolve, 400); }));
    const reading = f.controller.refresh();
    await vi.advanceTimersByTimeAsync(400); await reading;
    expect(f.controller.snapshot().timer).toMatchObject({ durationMs: 600 });
  });
  it("П02: a result with a new version (a corrected grade) starts the full countdown again", async () => {
    const f = await shownResultAfterTwoSeconds();
    f.commands.readResult.mockResolvedValue(readOf(answer(5, "2")));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await vi.advanceTimersByTimeAsync(2999);
    expect(f.commands.begin).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.commands.begin).toHaveBeenCalledTimes(2);
  });
  it("П02: background after a read still cancels the countdown and the result waits for «Далее»", async () => {
    const f = await shownResultAfterTwoSeconds();
    f.commands.readResult.mockResolvedValue(readOf(answer(4)));
    await f.controller.refresh();
    f.controller.suspend();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: null });
    await f.controller.resume();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.commands.begin).toHaveBeenCalledOnce();
  });
  it("П02: a read that starts while another one runs (queued re-read) still continues the original countdown", async () => {
    const f = await shownResultAfterTwoSeconds();
    f.commands.readResult.mockResolvedValue(readOf(answer(4)));
    let release: () => void = () => {};
    f.commands.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const first = f.controller.refresh();
    // The version grows while the first read is on its way: the second refresh is queued behind it.
    f.state.stateVersion = "60";
    f.commands.readSession.mockResolvedValue({ state_version: "60", current: current(assignment(10, "prefetched")) as object });
    f.commands.readResult.mockResolvedValue({ ...readOf(answer(4)), state_version: "60" });
    const second = f.controller.refresh();
    release(); await first; await second;
    expect(f.controller.snapshot().timer).toMatchObject({ durationMs: 1000, elapsedMs: 2000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.commands.begin.mock.calls.map(call => call[0].kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("П02: a failed read leaves no remainder behind: the next successful read of the same result starts afresh", async () => {
    const f = await shownResultAfterTwoSeconds();
    f.commands.readSession.mockRejectedValueOnce(new Error("network"));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", timer: null });
    await vi.advanceTimersByTimeAsync(5000);
    f.commands.readResult.mockResolvedValue(readOf(answer(4)));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
  });
  it("П02: background while the view is stale after a failed read keeps the result waiting for «Далее»", async () => {
    const f = await shownResultAfterTwoSeconds();
    f.commands.readSession.mockRejectedValueOnce(new Error("network"));
    await f.controller.refresh();
    expect(f.controller.snapshot().phase).toBe("stale");
    f.controller.suspend();
    f.commands.readResult.mockResolvedValue(readOf(answer(4)));
    await f.controller.resume();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.commands.begin).toHaveBeenCalledOnce();
  });
  it("an explicit grade is sent for the server's own target and advances once", async () => {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4)); await f.controller.submit();
    f.replies.set("result.grade", () => ({ resolved: { commandId: id(91), kind: "result.grade", sessionId: SESSION, assignmentId: id(6), resultId: id(7) },
      answer: answer(5, "2"), current: current(assignment(10, "prefetched")) }));
    f.replies.set("assignment.present", () => ({ current: current(assignment(10, "presented")) }));
    await f.controller.grade(5);
    expect(f.commands.begin.mock.calls[1][0]).toEqual({ kind: "result.grade", ...target("1"), payload: { grade: 5 } });
    expect(f.commands.begin.mock.calls.map(call => call[0].kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
    await f.controller.grade(3); expect(f.commands.begin).toHaveBeenCalledTimes(3);
  });
  it("a correction exists only as the server's correct_target of this result", async () => {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("x"); f.replies.set("answer.submit", () => ({ ...answered(2)(), answer: { ...answer(2), capabilities: { correct_target: null, grades: null, undo_target: null } } }));
    await f.controller.submit();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: false });
    await f.controller.correct(); expect(f.commands.begin).toHaveBeenCalledOnce();
  });
  it("a refused revision keeps the result it addressed; a refused answer returns to its question", async () => {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("x"); f.replies.set("answer.submit", answered(2)); await f.controller.submit();
    f.replies.set("result.correct", () => ({ outcome: "rejected", rejectionCode: "RESULT_STALE", answer: answer(2),
      resolved: { commandId: id(92), kind: "result.correct", sessionId: SESSION } }));
    await f.controller.correct();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_wrong", problem: "RESULT_STALE" });
  });
  it("an unavailable step of no session of this view is ignored or makes it stale, by mode rule", async () => {
    for (const [ignore, phase] of [[true, "idle"], [false, "stale"]] as const) {
      const f = view({ sessionId: null, rules: { ignoreUnboundUnavailable: ignore } }); await f.controller.refresh();
      f.state.primary = { ...idle(), current: { session_id: SESSION, status: "unavailable" }, stateVersion: "9" };
      f.state.stateVersion = "9";
      f.replies.set("session.start", () => ({ current: { session_id: SESSION, status: "unavailable" } }));
      await f.commands.begin({ kind: "session.start" });
      expect(f.controller.snapshot().phase).toBe(phase);
    }
  });
  it("a closure observed during a session read keeps the view closed, or lets the step be chosen again, by mode rule", async () => {
    // Re-chosen, the prefetched next question is shown at once (one present).
    for (const [keep, phase] of [[true, "closed"], [false, "question"]] as const) {
      const f = view({ rules: { keepClosedAfterRead: keep } }); await f.controller.refresh();
      f.replies.set("assignment.present", () => ({ current: current(assignment(10, "presented")) }));
      f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4)); await f.controller.submit();
      f.commands.readSession.mockResolvedValueOnce({ state_version: "6", current: current(assignment(10, "prefetched")) });
      f.commands.readResult.mockImplementationOnce(async () => {
        f.controller.closeNow = true; f.publish(); f.controller.closeNow = false;
        return { state_version: "6", step: current(assignment(10, "prefetched")), ...answer(4) };
      });
      await f.controller.refresh();
      expect(f.controller.snapshot().phase).toBe(phase);
    }
  });
});

describe("shared study view: «Шаг назад» (M-UNDO)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const submitted = async (grade: number) => {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("Haus");
    f.replies.set("answer.submit", () => ({ ...answered(grade)(), answer: undoable(grade) }));
    await f.controller.submit();
    return f;
  };

  it("offers the right only while the answer is as fresh as the lanes", async () => {
    const f = await submitted(4);
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", canUndo: true });
    // A newer projection arrives without a new read of this answer: its rights may be gone, so none is offered.
    f.state.stateVersion = "20";
    f.state.primary = { ...f.state.primary, current: current(assignment(10, "prefetched")), stateVersion: "20" };
    f.publish();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", canNext: true, canUndo: false });
    await f.controller.undo();
    expect(f.commands.begin.mock.calls.map(call => call[0].kind)).toEqual(["answer.submit"]);
  });
  it("a refused undo keeps the result without its timer: it waits for «Далее»", async () => {
    const f = await submitted(4);
    expect(f.controller.snapshot().timer).not.toBeNull();
    f.replies.set("result.undo", () => ({ outcome: "rejected", rejectionCode: "CAPABILITY_EXPIRED", resolved: undoResolved,
      answer: answer(4), current: current(assignment(10, "prefetched")) }));
    await f.controller.undo();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", problem: "CAPABILITY_EXPIRED", canUndo: false, timer: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.commands.begin.mock.calls.map(call => call[0].kind)).toEqual(["answer.submit", "result.undo"]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
  });
  it("a refusal whose projection shows the answer already undone shows the current step instead", async () => {
    const f = await submitted(2);
    const gone = answer(2);
    gone.result!.status = "undone"; gone.action!.status = "undone"; gone.capabilities = { correct_target: null, grades: null, undo_target: null };
    f.replies.set("result.undo", () => ({ outcome: "rejected", rejectionCode: "ASSIGNMENT_STALE", resolved: undoResolved,
      answer: gone, current: current(assignment(11, "prefetched")) }));
    f.replies.set("assignment.present", () => ({ current: current(assignment(11, "presented")) }));
    f.commands.readSession.mockImplementation(async () => ({ state_version: f.state.stateVersion, current: current(assignment(11, "prefetched")) }));
    await f.controller.undo();
    // The current step is the new issue of the card: it is shown by one present (whose own outcome replaces the refusal).
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", question: { id: id(11) }, answer: null, canUndo: false,
      canPrevious: false });
    expect(f.commands.begin.mock.calls.map(call => call[0].kind)).toEqual(["answer.submit", "result.undo", "assignment.present"]);
  });
});
