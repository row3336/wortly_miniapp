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
    automaticPrimary: false, closedAction: null };
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
    retry: vi.fn(async () => {}), refresh: vi.fn(async () => {}), clearSettled: vi.fn(async () => {}),
    readSession: vi.fn(async () => ({ state_version: String(version), current: current(assignment(6, "presented")) as object })),
    readResult: vi.fn(async () => ({ state_version: String(version), step: current(assignment(6, "presented")), ...answer(4) })),
    setRecoveryActive: vi.fn(), dispose: vi.fn(), knowsClosed: vi.fn(() => false),
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
  /** A later step of a read throws (M-WRITTEN-STUCK, C101). */
  failAfterRead = false;
  protected afterRead(): Promise<void> { return this.failAfterRead ? Promise.reject(new Error("after read failed")) : Promise.resolve(); }
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
  { ignoreUnboundUnavailable: true, keepClosedAfterRead: true, waitRestoredCorrection: false, ...options.rules }, f.connect);
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

describe("shared study view: a pair changed elsewhere (M-WRITTEN-STUCK)", () => {
  const OTHER = id(30);
  /** A projection of another pair, as the server reports a session after the pair changed on another device. */
  const foreign = (status: StudyCurrent["status"], session = SESSION): StudyCurrent =>
    ({ session_id: session, status, pair: "uk-de", close_reason: status === "closed" ? "pair_changed" : null,
      assignment: status === "active" ? assignment(6, "presented") : null });

  it("S1: a closed projection of its own session closes the view whatever pair it names", async () => {
    const f = view();
    f.commands.readSession.mockResolvedValueOnce({ state_version: "5", current: foreign("closed") });
    await f.controller.refresh();
    expect(f.controller.snapshot().phase).toBe("closed");
    expect(f.controller.closed).toEqual([{ sessionId: SESSION, reason: "pair_changed" }]);
    // The closed step of the other pair opens nothing: no question, nothing to answer.
    expect(f.controller.snapshot()).toMatchObject({ question: null, canSubmit: false, current: { status: "closed" } });
  });
  it("S5: a closed projection of its own session below the lanes' version floor is ignored", async () => {
    const f = view(); await f.controller.refresh();
    f.state.stateVersion = "20";
    f.state.primary = { ...idle(), current: foreign("closed"), stateVersion: "19" };
    f.publish();
    expect(f.controller.closed).toEqual([]);
    expect(f.controller.snapshot().phase).not.toBe("closed");
  });
  it("S2: an open projection of its own session in another pair is still ignored", async () => {
    for (const status of ["active", "summary"] as const) {
      const f = view(); await f.controller.refresh();
      const before = f.controller.snapshot();
      expect(before.phase).toBe("question");
      f.commands.readSession.mockResolvedValueOnce({ state_version: "5", current: foreign(status) });
      await f.controller.refresh();
      expect(f.controller.closed).toEqual([]);
      // Nothing of the other pair is shown: the view keeps its own step.
      expect(f.controller.snapshot()).toMatchObject({ phase: "question", current: { pair: "ru-de", status: "active" } });
    }
  });
  it("S3: a closed projection of another session in another pair is ignored", async () => {
    const f = view(); await f.controller.refresh();
    f.commands.readSession.mockResolvedValueOnce({ state_version: "5", current: foreign("closed", OTHER) });
    await f.controller.refresh();
    expect(f.controller.closed).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", current: { session_id: SESSION, pair: "ru-de" } });
  });
  it("S4: a view without a session ignores a closed projection of another pair", () => {
    const f = view({ sessionId: null });
    f.state.stateVersion = "6";
    f.state.primary = { ...idle(), current: foreign("closed"), stateVersion: "6" };
    f.publish();
    expect(f.controller.closed).toEqual([]);
    expect(f.controller.snapshot().phase).not.toBe("closed");
    expect(f.controller.snapshot().current).toBeNull();
  });
});

describe("shared study view: the facts of an empty Stop (M-WRITTEN-STUCK)", () => {
  type Stops = { tapStop(): unknown; unsentStop(tap: unknown): Promise<boolean> };
  it("S6: a read ignored below the view's floor stays ignored; without the lanes' closure no refusal is proven", async () => {
    const f = view(); await f.controller.refresh();
    f.state.stateVersion = "9";
    f.commands.readSession.mockResolvedValueOnce({ state_version: "8", current: current(null, "closed") });
    const stops = f.controller as unknown as Stops;
    expect(await stops.unsentStop(stops.tapStop())).toBe(true);
    expect(f.controller.closed).toEqual([]);
    expect(f.controller.snapshot().emptyStop).toEqual({ sessionId: SESSION, refusal: null, read: "ignored", joined: false });
  });
  it("S7: the lanes' closure is the proven refusal; a failed read stays a failed read", async () => {
    const f = view(); await f.controller.refresh();
    f.commands.knowsClosed.mockReturnValue(true);
    f.commands.readSession.mockRejectedValueOnce(new Error("offline"));
    const stops = f.controller as unknown as Stops;
    await stops.unsentStop(stops.tapStop());
    expect(f.controller.closed).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: "load",
      emptyStop: { sessionId: SESSION, refusal: "session_closed", read: "failed" } });
  });
});

describe("shared study view: the read an empty Stop got (M-WRITTEN-STUCK, C101)", () => {
  type Stops = { tapStop(): unknown; unsentStop(tap: unknown): Promise<boolean>; readOnce(): Promise<{ outcome: string; joined: boolean }> };
  const stops = (f: ReturnType<typeof view>) => f.controller as unknown as Stops;
  const emptyStop = (f: ReturnType<typeof view>) => stops(f).unsentStop(stops(f).tapStop());
  const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    return { gate, release };
  };
  const reply = (version: string) => ({ state_version: version, current: current(assignment(6, "presented")) as object });
  const settle = () => new Promise(done => setTimeout(done, 5));
  beforeEach(() => { vi.useRealTimers(); });

  it("S8: a later step of the read throws: the Stop rejects, the session GET's outcome is still kept", async () => {
    const f = view(); await f.controller.refresh();
    f.controller.failAfterRead = true;
    await expect(emptyStop(f)).rejects.toThrow("after read failed");
    expect(f.controller.snapshot().emptyStop).toMatchObject({ read: "applied", joined: false });
  });
  it("S9: a closure the lanes learn only from this Stop's own read is not its refusal", async () => {
    const f = view(); await f.controller.refresh();
    const before = f.commands.readSession.mock.calls.length;
    f.commands.knowsClosed.mockImplementation(() => f.commands.readSession.mock.calls.length > before);
    f.commands.readSession.mockResolvedValueOnce({ state_version: "5", current: { ...current(null, "closed"), close_reason: "remote_stop" } });
    await emptyStop(f);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", emptyStop: { refusal: null, read: "applied" } });
  });
  it("S10: a Stop that joins a queue another call made is joined; its creator's own read is not", async () => {
    const f = view(); await f.controller.refresh();
    const reads = f.commands.readSession.mock.calls.length, held = gated();
    f.commands.readSession.mockImplementation(async () => reply(f.state.stateVersion));
    f.commands.readSession.mockImplementationOnce(async () => { await held.gate; return reply("5"); });
    const r0 = f.controller.refresh(); await settle();
    f.state.stateVersion = "6";
    const creator = stops(f).readOnce(), stopping = emptyStop(f); await settle();
    held.release(); await r0;
    expect(await creator).toMatchObject({ outcome: "applied", joined: false });
    await stopping;
    expect(f.controller.snapshot().emptyStop).toMatchObject({ read: "applied", joined: true });
    expect(f.commands.readSession.mock.calls.length - reads).toBe(2);
  });
  it("S11: a queue that awaits a read a subscriber started reports it joined", async () => {
    const f = view(); await f.controller.refresh();
    const reads = f.commands.readSession.mock.calls.length, held = gated();
    f.commands.readSession.mockImplementation(async () => reply(f.state.stateVersion));
    f.commands.readSession.mockImplementationOnce(async () => { await held.gate; return reply("5"); });
    const r0 = f.controller.refresh(); await settle();
    f.state.stateVersion = "6";
    const queued = stops(f).readOnce();
    // The first publication after the first read ends starts a read before the queue looks again.
    let subscriber: Promise<void> | null = null;
    f.onUpdate.mockImplementation(() => { subscriber ??= f.controller.refresh(); });
    held.release(); await r0;
    expect(await queued).toEqual({ outcome: "applied", joined: true });
    await subscriber;
    expect(f.commands.readSession.mock.calls.length - reads).toBe(2);
  });
});

/** The view's internal fact that the server proved its session open in another pair (never its shown problem, C149). */
/** The published fact that the server proved the session open in another pair (C151), never the shown problem. */
const mismatch = (view: { snapshot(): { pairMismatch: string | null } }) => view.snapshot().pairMismatch !== null;

describe("shared study view: a session the server shows open in another pair (M-LANE-PAIR-GUARD)", () => {
  const foreign = (status: StudyCurrent["status"] = "active"): StudyCurrent =>
    ({ session_id: SESSION, status, pair: "uk-de", close_reason: null, assignment: status === "active" ? assignment(6, "presented") : null });
  const accepted = (version: string): Lane => ({ ...idle(), phase: "settled", outcome: "accepted", stateVersion: version,
    resolved: { commandId: id(90), kind: "answer.submit", sessionId: SESSION, assignmentId: id(6), resultId: id(7) } });

  it("SG1: a read of the view's own session open in another pair is a known mismatch: kept, never shown as a problem", async () => {
    const f = view(); f.state.stateVersion = "9";
    f.commands.readSession.mockResolvedValueOnce({ state_version: "9", current: foreign() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: null, current: null, question: null });
    expect(mismatch(f.controller)).toBe(true);
  });
  it("SG19: a projection of this pair of the same session ends the known mismatch", async () => {
    const f = view(); f.state.stateVersion = "9";
    f.commands.readSession.mockResolvedValueOnce({ state_version: "9", current: foreign() });
    await f.controller.refresh();
    expect(mismatch(f.controller)).toBe(true);
    f.commands.readSession.mockResolvedValueOnce({ state_version: "9", current: current(assignment(6, "presented")) });
    await f.controller.refresh();
    expect(mismatch(f.controller)).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", problem: null });
  });
  it("SG2: the same read below the lanes' floor is a stale view, not this reason", async () => {
    const f = view(); f.state.stateVersion = "9";
    f.commands.readSession.mockResolvedValueOnce({ state_version: "8", current: foreign() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: null, current: null });
    expect(mismatch(f.controller)).toBe(false);
  });
  it("SG3: a session this view took in its own pair keeps its step and gets no reason from a later read", async () => {
    const f = view(); await f.controller.refresh();
    f.commands.readSession.mockResolvedValueOnce({ state_version: "5", current: foreign() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", problem: null, current: { pair: "ru-de" } });
  });
  it("SG4: an accepted answer whose result step names another pair shows no result (P7 source a)", async () => {
    const f = view(); await f.controller.refresh();
    f.state.stateVersion = "6"; f.state.primary = accepted("6");
    f.commands.readSession.mockResolvedValueOnce({ state_version: "6", current: current(assignment(6, "presented")) });
    f.commands.readResult.mockResolvedValueOnce({ state_version: "6", step: foreign(), ...answer(4) });
    await f.controller.refresh();
    expect(f.commands.readResult).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: null, answer: null });
    expect(mismatch(f.controller)).toBe(true);
    // The result is not read again by a later read: it is settled for this view.
    f.commands.readSession.mockResolvedValueOnce({ state_version: "6", current: current(assignment(6, "presented")) });
    await f.controller.refresh();
    expect(f.commands.readResult).toHaveBeenCalledOnce();
  });
  it("SG5: a result step of another pair below the floor withholds the result but proves no reason (C122 п. 2)", async () => {
    const f = view(); await f.controller.refresh();
    f.state.stateVersion = "6"; f.state.primary = accepted("6");
    f.commands.readSession.mockResolvedValueOnce({ state_version: "6", current: current(assignment(6, "presented")) });
    f.commands.readResult.mockResolvedValueOnce({ state_version: "5", step: foreign(), ...answer(4) });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: null, answer: null, canNext: false });
    expect(mismatch(f.controller)).toBe(false);
  });
  it("SG6: a session known open in another pair has its result neither read nor shown", async () => {
    const f = view(); f.state.stateVersion = "6"; f.state.primary = accepted("6");
    f.commands.readSession.mockResolvedValueOnce({ state_version: "6", current: foreign() });
    await f.controller.refresh();
    expect(f.commands.readResult).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: null, answer: null });
    expect(mismatch(f.controller)).toBe(true);
  });
  it("SG7: the lanes' reason of the view's session marks it; a closure proven after it closes the view", async () => {
    const f = view();
    f.state.primary = { ...accepted("6"), problem: "pair_changed", resolved: { commandId: id(91), kind: "session.start", sessionId: SESSION } };
    f.state.stateVersion = "6"; f.publish();
    // The fact only, not a shown problem; the phase is the view's own (a start or a read chooses it).
    expect(f.controller.snapshot()).toMatchObject({ problem: null, current: null });
    expect(mismatch(f.controller)).toBe(true);
    f.commands.readSession.mockResolvedValueOnce({ state_version: "7", current: foreign("closed") });
    f.state.stateVersion = "7";
    await f.controller.refresh();
    expect(f.controller.closed).toEqual([{ sessionId: SESSION, reason: null }]);
    expect(f.controller.snapshot().phase).toBe("closed");
  });
  it("SG8: a projection of this pair of the same session ends the mark", async () => {
    const f = view(); const marked = () => (f.controller as unknown as { foreign(): boolean }).foreign();
    f.state.primary = { ...accepted("6"), problem: "pair_changed", resolved: { commandId: id(91), kind: "session.start", sessionId: SESSION } };
    f.state.stateVersion = "6"; f.publish();
    expect(marked()).toBe(true);
    f.state.primary = { ...f.state.primary, problem: null };
    f.commands.readSession.mockResolvedValueOnce({ state_version: "6", current: current(assignment(6, "presented")) });
    await f.controller.refresh();
    expect(marked()).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({ phase: "question", problem: null });
  });
});

describe("shared study view: a result of another pair below the lanes' floor (M-LANE-PAIR-GUARD, C122 п. 2)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const NEW_RESULT = id(17);
  const other = (): StudyCurrent => ({ session_id: SESSION, status: "active", pair: "uk-de", close_reason: null,
    assignment: assignment(10, "presented") });
  /** A wrong answer of the new result, with its correction right, as the server would project it. */
  const newAnswer = (version = "1"): StudyAnswer => {
    const base = answer(2, version);
    return { ...base, result: { ...base.result!, result_id: NEW_RESULT, assignment_id: id(10) },
      capabilities: { ...base.capabilities, correct_target: { ...target(version), assignment_id: id(10), result_id: NEW_RESULT } } };
  };
  /** A shown own correct result, then a second answer accepted by the lanes whose reply carried no result. */
  async function acceptedWithoutResult() {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4)); await f.controller.submit();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { result_id: id(7) } } });
    f.state.stateVersion = "9";
    f.state.primary = { ...idle(), phase: "settled", outcome: "accepted", stateVersion: "9",
      resolved: { commandId: id(95), kind: "answer.submit", sessionId: SESSION, assignmentId: id(10), resultId: NEW_RESULT } };
    f.commands.readSession.mockResolvedValueOnce({ state_version: "9", current: current(assignment(10, "presented")) });
    return f;
  }

  it("SG9: an older result step naming another pair shows nothing of that result and proves no reason", async () => {
    const f = await acceptedWithoutResult(), begins = f.commands.begin.mock.calls.length;
    f.commands.readResult.mockResolvedValueOnce({ state_version: "8", step: other(), ...newAnswer() });
    await f.controller.refresh();
    const after = f.controller.snapshot();
    // Nothing of the other pair: not its result, no timer, no grade/correction/next right, no POST.
    expect(after.answer?.result?.result_id).not.toBe(NEW_RESULT);
    expect(after).toMatchObject({ phase: "stale", timer: null, canNext: false, canCorrect: false, grades: [], canUndo: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.commands.begin.mock.calls.length).toBe(begins);
    // An older step proves no current pair change.
    expect(after.problem).toBeNull(); expect(mismatch(f.controller)).toBe(false);
    // The own confirmed result stays known (its fact is not cleared).
    expect((f.controller as unknown as { answer: StudyAnswer | null }).answer?.result?.result_id).toBe(id(7));
  });
  it("SG10: that refusal is not final: a later fresh read of this pair recovers the same accepted result", async () => {
    const f = await acceptedWithoutResult();
    f.commands.readResult.mockResolvedValueOnce({ state_version: "8", step: other(), ...newAnswer() });
    await f.controller.refresh();
    f.commands.readSession.mockResolvedValueOnce({ state_version: "9", current: current(assignment(10, "presented")) });
    f.commands.readResult.mockResolvedValueOnce({ state_version: "9", step: current(assignment(10, "presented")), ...newAnswer() });
    await f.controller.refresh();
    expect(f.commands.readResult).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_wrong", problem: null, answer: { result: { result_id: NEW_RESULT } } });
  });
  it("SG11: an older result step of this pair is unchanged: its result is shown (a stale step, not another pair)", async () => {
    const f = await acceptedWithoutResult();
    f.commands.readResult.mockResolvedValueOnce({ state_version: "8", step: current(assignment(10, "presented")), ...newAnswer() });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_wrong", answer: { result: { result_id: NEW_RESULT } } });
  });
  it("SG12: a fresh result step of another pair keeps the proven reason (as SG4)", async () => {
    const f = await acceptedWithoutResult();
    f.commands.readResult.mockResolvedValueOnce({ state_version: "9", step: other(), ...newAnswer() });
    await f.controller.refresh();
    const after = f.controller.snapshot();
    expect(after).toMatchObject({ phase: "stale", problem: null, canNext: false, grades: [], canCorrect: false });
    expect(mismatch(f.controller)).toBe(true);
    expect(after.answer?.result?.result_id).not.toBe(NEW_RESULT);
  });
  it("SG13: a closed own-session result step of another pair is the closure, not this guard", async () => {
    const f = await acceptedWithoutResult();
    f.commands.readResult.mockResolvedValueOnce({ state_version: "9",
      step: { ...other(), status: "closed", close_reason: "pair_changed", assignment: null }, ...newAnswer() });
    await f.controller.refresh();
    expect(f.controller.closed).toEqual([{ sessionId: SESSION, reason: "pair_changed" }]);
    expect(f.controller.snapshot().phase).toBe("closed");
  });
  /** A closed step of the view's session naming another pair, as a result read may carry it. */
  const closedOther = (): StudyCurrent => ({ ...other(), status: "closed", close_reason: "pair_changed", assignment: null });
  it("SG15 (F3, case 1): an older closed step of another pair gives no new result, no Next and no reason (C158)", async () => {
    const f = await acceptedWithoutResult(), begins = f.commands.begin.mock.calls.length;
    f.commands.readResult.mockResolvedValueOnce({ state_version: "8", step: closedOther(), ...newAnswer() });
    await f.controller.refresh();
    const after = f.controller.snapshot();
    // The old version proves neither the closure nor the pair change, and the new result of that step is not taken.
    expect(f.controller.closed).toEqual([]);
    expect(after.answer?.result?.result_id).not.toBe(NEW_RESULT);
    expect(after).toMatchObject({ phase: "stale", problem: null, pairMismatch: null, timer: null, canNext: false,
      canCorrect: false, grades: [], canUndo: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.commands.begin.mock.calls.length).toBe(begins);
  });
  it("SG20 (F3, case 2): the own confirmed result stays known after that refusal", async () => {
    const f = await acceptedWithoutResult();
    f.commands.readResult.mockResolvedValueOnce({ state_version: "8", step: closedOther(), ...newAnswer() });
    await f.controller.refresh();
    expect((f.controller as unknown as { answer: StudyAnswer | null }).answer?.result?.result_id).toBe(id(7));
  });
  it("SG21 (F3): the refusal is not final: a fresh own result is recovered with its current rights and version", async () => {
    const f = await acceptedWithoutResult();
    f.commands.readResult.mockResolvedValueOnce({ state_version: "8", step: closedOther(), ...newAnswer() });
    await f.controller.refresh();
    f.commands.readSession.mockResolvedValueOnce({ state_version: "9", current: current(assignment(10, "presented")) });
    f.commands.readResult.mockResolvedValueOnce({ state_version: "9", step: current(assignment(10, "presented")), ...newAnswer("3") });
    await f.controller.refresh();
    // The accepted result itself is read again (it was not taken as handled), not merely the shown own answer.
    expect(f.commands.readResult).toHaveBeenCalledTimes(2);
    expect((f.commands.readResult.mock.calls[1] as unknown[])[0]).toMatchObject({ result_id: NEW_RESULT });
    expect(f.controller.snapshot()).toMatchObject({ phase: "result_wrong", problem: null, canCorrect: true,
      answer: { result: { result_id: NEW_RESULT, version: "3" }, capabilities: { correct_target: { expected_result_version: "3" } } } });
  });
  it("SG22 (F3, case 3): the own closure at the floor ends the view as before, with no grade or undo", async () => {
    const f = await acceptedWithoutResult();
    f.commands.readResult.mockResolvedValueOnce({ state_version: "9", step: closedOther(), ...newAnswer() });
    await f.controller.refresh();
    expect(f.controller.closed).toEqual([{ sessionId: SESSION, reason: "pair_changed" }]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", grades: [], canUndo: false, canCorrect: false, canNext: false });
  });
  it("SG23 (F3): re-reading the shown own result takes nothing from an older closed step of another pair", async () => {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4)); await f.controller.submit();
    const before = (f.controller as unknown as { answer: StudyAnswer }).answer;
    f.controller.suspend();
    f.state.stateVersion = "7";
    f.commands.readSession.mockResolvedValueOnce({ state_version: "7", current: current(assignment(10, "prefetched")) });
    f.commands.readResult.mockResolvedValueOnce({ state_version: "6", step: closedOther(), ...answer(4, "2"),
      capabilities: { ...answer(4, "2").capabilities, grades: { ...target("2"), values: [3, 4, 5] } } });
    await f.controller.resume();
    expect(f.controller.closed).toEqual([]);
    expect((f.controller as unknown as { answer: StudyAnswer }).answer).toEqual(before);
  });
  it("SG14: re-reading the shown own result never takes rights from a step of another pair", async () => {
    const f = view(); await f.controller.refresh();
    f.controller.setDraft("Haus"); f.replies.set("answer.submit", answered(4)); await f.controller.submit();
    const before = (f.controller as unknown as { answer: StudyAnswer }).answer;
    f.controller.suspend();
    f.commands.readSession.mockResolvedValueOnce({ state_version: "6", current: current(assignment(10, "prefetched")) });
    f.commands.readResult.mockResolvedValueOnce({ state_version: "6", step: other(), ...answer(4, "2"),
      capabilities: { ...answer(4, "2").capabilities, grades: { ...target("2"), values: [3, 4, 5] } } });
    await f.controller.resume();
    expect((f.controller as unknown as { answer: StudyAnswer }).answer).toEqual(before);
  });
});

describe("shared study view: a known mismatch against an update in progress and a failed update (C149)", () => {
  const foreign = (): StudyCurrent => ({ session_id: SESSION, status: "active", pair: "uk-de", close_reason: null,
    assignment: assignment(6, "presented") });
  const r1 = (f: ReturnType<typeof view>) => {
    f.state.primary = { ...idle(), phase: "settled", outcome: "accepted", stateVersion: "6", problem: "pair_changed",
      resolved: { commandId: id(91), kind: "session.start", sessionId: SESSION } };
    f.state.stateVersion = "6"; f.publish();
  };
  it("SG16: the lanes' pair reason of an applied command is no shown problem; an unknown command's still is", () => {
    const f = view(); r1(f);
    // The fact stays published for whoever needs it (the lane's reason and the view's pairMismatch, C151).
    expect(f.controller.snapshot()).toMatchObject({ problem: null, pairMismatch: SESSION,
      commands: { primary: { outcome: "accepted", problem: "pair_changed" } } });
    f.state.primary = { ...idle(), phase: "unresolved", pending: true, kind: "answer.submit", problem: "pair_changed" };
    f.publish();
    expect(f.controller.snapshot().problem).toBe("pair_changed");
  });
  it("SG17: while the update runs nothing claims a failure", async () => {
    const f = view(); r1(f);
    let release!: () => void;
    f.commands.readSession.mockImplementationOnce(() => new Promise(done => {
      release = () => done({ state_version: "6", current: foreign() }); }));
    const reading = f.controller.refresh();
    await vi.waitFor(() => expect(f.commands.readSession).toHaveBeenCalled());
    expect(f.controller.snapshot().problem).toBeNull();
    release(); await reading;
    expect(f.controller.snapshot()).toMatchObject({ phase: "stale", problem: null });
    expect(mismatch(f.controller)).toBe(true);
  });
  it("SG18: a failed update keeps its own problem after the mismatch (read failure, refused check, stale check)", async () => {
    const failed = view(); r1(failed);
    failed.commands.readSession.mockRejectedValueOnce(new Error("offline"));
    await failed.controller.refresh();
    expect(failed.controller.snapshot()).toMatchObject({ phase: "stale", problem: "load" });
    for (const problem of ["network", "stale_response"]) {
      const f = view(); r1(f);
      f.state.primary = { ...idle(), phase: "unresolved", pending: true, kind: "answer.submit", problem };
      f.publish();
      expect(f.controller.snapshot().problem).toBe(problem);
    }
  });
});
