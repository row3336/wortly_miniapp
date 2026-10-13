import type { LearningSessionProjection, PublicAssignment } from "../api/generated";
import { CLOSE_REASONS, sameId } from "../api/wireValidation";
import type { DocumentLane } from "../commands/documentLanes";
import type { ResultTimerView } from "../commands/resultTimer";
import { StudyView, type EmptyStop, type StudyLanes, type StudyPhase } from "../commands/studyView";
import type { LearningCommandSnapshot, LearningTransition } from "./learningCommandController";
import { LearningDocumentCommands, type LearningDocumentSnapshot } from "./learningDocumentCommands";
import { LEAVING_START_REFUSALS } from "./learningSessionApi";

type Answer = NonNullable<LearningCommandSnapshot["answer"]>;
type OwnerOptions = ConstructorParameters<typeof LearningDocumentCommands>[0];
type Options = Omit<OwnerOptions, "onUpdate"> & {
  sessionId: string | null;
  transitionMode(): "normal" | "accelerated" | null;
  /** Route/configuration gate; independent of Stop and read-only pending recovery. */
  enabled?(): boolean;
  /** The accepted milestone «Learning completed» (К09-004); the host turns it into a haptic signal (К09-007). */
  onLearningComplete?(): void;
  onUpdate(snapshot: LearningViewSnapshot): void;
};
type CloseReason = LearningSessionProjection["close_reason"];
/** The reason a closure is known by; null while it is unknown. Learning has no summary numbers of its own. */
export type LearningClosed = { sessionId: string; reason: CloseReason };
export type LearningViewSnapshot = {
  phase: StudyPhase;
  sessionId: string | null;
  current: LearningSessionProjection | null;
  question: PublicAssignment | null;
  draft: string;
  answer: Answer | null;
  submittedText: string | null;
  problem: string | null;
  commands: LearningDocumentSnapshot;
  /** The closure of this view's own session once known (its reason, when the server named one); null otherwise. */
  closed: LearningClosed | null;
  timer: ResultTimerView | null;
  canSubmit: boolean;
  canEditDraft: boolean;
  canForget: boolean;
  canNext: boolean;
  canPrevious: boolean;
  canCorrect: boolean;
  grades: (3 | 4 | 5)[];
  /** «Шаг назад»: only the server's undo_target of the answer on screen (its result view or the phase summary). */
  canUndo: boolean;
  canStop: boolean;
  canAdvancePreview: boolean;
  canRetryPrimary: boolean;
  /** The last Stop of this session that sent nothing: internal facts, nothing of it is shown (EmptyStop). */
  emptyStop: EmptyStop | null;
  /** The session the server proved open in another pair: a fact, never the shown problem (StudyViewFields). */
  pairMismatch: string | null;
};

/**
 * The lanes hold a final refusal of a start that this view leaves (LEAVING_START_REFUSALS), by its reply or its check,
 * and its number names no session: a real session of that number (its projection in the refusal) is never left (C210).
 */
const leavingRefusal = (state: StudyLanes): boolean => state.primary.outcome === "rejected"
  && state.primary.resolved?.kind === "session.start" && LEAVING_START_REFUSALS.has(state.primary.rejectionCode ?? "")
  && !(state.primary.current !== null && "pair" in state.primary.current);

const closeReason = (value: string | null | undefined): CloseReason =>
  value && CLOSE_REASONS.includes(value) ? value as CloseReason : null;

/** Presentation is local; only document commands can establish a saved answer or presentation. */
export class LearningViewController extends StudyView<LearningDocumentCommands, LearningSessionProjection, Answer, LearningViewSnapshot> {
  private readonly onLearningComplete: (() => void) | undefined;
  private closedFacts: LearningClosed | null = null;
  constructor(options: Options) {
    super(options, { ignoreUnboundUnavailable: false, keepClosedAfterRead: false, waitRestoredCorrection: false },
      onUpdate => new LearningDocumentCommands({ ...options, onUpdate }));
    this.onLearningComplete = options.onLearningComplete;
  }
  /** Learning keeps only the closure reason: no summary numbers exist for it (learning_service projection), so none are invented. */
  protected close(sessionId: string, reason: string | null): void {
    this.cancelTimer(); this.phase = "closed"; this.question = null; this.draft = ""; this.draftAssignmentId = null;
    this.answer = null; this.answerVersion = null; this.pendingGradeAdvance = null;
    if (!this.closedFacts || !sameId(this.closedFacts.sessionId, sessionId)) this.closedFacts = { sessionId, reason: null };
    // The first known reason wins; a later observation only fills an unknown one.
    this.closedFacts.reason ??= closeReason(reason);
  }
  protected closure(state: StudyLanes): { reason: string | null } | null {
    if (!this.sessionId) return null;
    // An accepted own Stop proves the closure but names no reason: runStop or the projection supplies it.
    if (state.stop.outcome === "accepted" && state.stop.resolved?.kind === "session.stop"
      && sameId(state.stop.resolved.sessionId, this.sessionId)) return { reason: null };
    const boundary = state.primary.closedSession ?? state.stop.closedSession;
    return boundary && sameId(boundary.session_id, this.sessionId) ? { reason: boundary.close_reason } : null;
  }
  protected recoveredSession(state: StudyLanes): string | null {
    // A start refused for good created no session, by its reply or by its stored refusal after a reload: its number is
    // never read or routed to again.
    return state.primary.pendingIntent?.session_id ?? (leavingRefusal(state) ? null : state.primary.resolved?.sessionId ?? null);
  }
  /**
   * The server's own refusal of this start with a final code proves that it was not applied (not its unavailable
   * projection alone): the view returns to idle like the written quiz, so no Stop addresses the number and Today is
   * reached by the idle path. The lane keeps the refusal record; only a new tap takes a new number.
   */
  protected refused(kind: string): boolean {
    const state = this.commands.snapshot(), primary = state.primary;
    if (kind !== "session.start" || !leavingRefusal(state) || !this.sessionId || !sameId(primary.resolved!.sessionId, this.sessionId)) return false;
    this.sessionId = null; this.current = null; this.phase = "idle";
    return true;
  }
  protected activeAssignment(): PublicAssignment | null { return this.current?.assignment ?? null; }
  /**
   * The session of the last start whose manual retry was permitted at the tap: the lane's right to it (canRetry) holds
   * LearningPageStarts.owns (35.1-А, C243), so this page created that start, whichever view of the page began it (C249,
   * C251). It is the permission at the tap, not a proof that any HTTP request began. A start of another page has no such
   * right and is never marked.
   */
  private pageRetry: string | null = null;
  /** Only the retry of a start of this page takes that session's step (StudyView.retriedOwnStart). */
  protected beganStart(sessionId: string): boolean { return this.pageRetry !== null && sameId(this.pageRetry, sessionId); }
  /**
   * An idle view without a session has no step to choose. A read that found the stored refusal of this start (its status
   * check after a lost reply) has just left it idle in consume(); the read's tail must not turn that into a stale view.
   */
  protected chooseCurrent(): void {
    if (this.sessionId === null && this.is("idle")) return;
    super.chooseCurrent();
  }
  /**
   * TA:50, К09-004: Learning is completed by this client's own accepted answer whose step is the summary of a completed
   * group (IL Л03: success on the last stage completes it; the answer carries no member stage, the group status is the
   * observable fact). A correction that completes it counts too (К05-151); a grade, an undo, «Уже знаю», a read, Stop
   * and an automatic closure do not. consume() takes each command once, so a duplicate reply of the same command_id
   * never repeats the signal; an outcome first confirmed by its check still gives it.
   * root decision, pending owner (M-LEARN-FIN Р1–Р5).
   */
  protected consume(): boolean {
    const consumed = super.consume();
    const kind = this.commands.snapshot().primary.resolved?.kind;
    if (consumed && (kind === "answer.submit" || kind === "result.correct")
      && this.current?.status === "summary" && this.current.group.status === "completed") {
      // An unavailable haptic API never changes the screen (TA:50).
      try { this.onLearningComplete?.(); } catch { /* the signal is optional */ }
    }
    return consumed;
  }
  protected chooseOther(current: LearningSessionProjection): boolean {
    if (!current.preview) return false;
    this.phase = "preview";
    return true;
  }
  snapshot(): LearningViewSnapshot {
    const { fields, live, ready } = this.view(), commands = fields.commands;
    const closed = this.closedFacts;
    return { phase: live ? this.phase : "disposed", ...fields,
      closed: live && this.phase === "closed" && closed && this.sessionId && sameId(closed.sessionId, this.sessionId) ? { ...closed } : null,
      canAdvancePreview: ready && this.phase === "preview" && !!this.current?.preview,
      // stop() checks this same right: a direct call while a new start is still being stored sends nothing (21.1-А),
      // nor while a stored start was never sent (33.1-А): no session of its number can exist yet.
      // 17.2-А: no Stop of the R1 session from the window that has not got its pair yet (StudyView.foreignStart).
      canStop: live && commands.canStop && !commands.primary.preparingStart && !commands.primary.startNotSent
        && this.sessionId !== null && !this.is("closed", "idle") && !this.foreignStart() };
  }
  start(): Promise<void> {
    if (!this.live() || !this.interactive() || !this.commands.snapshot().canBegin || !this.is("idle", "closed")) return Promise.resolve();
    // Only what this view itself showed before the tap (its idle screen or the closure it knew), never server rights.
    const before = { sessionId: this.sessionId, closedFacts: this.closedFacts, phase: this.phase };
    const started = this.options.newId();
    this.sessionId = started; this.closedFacts = null; this.current = null; this.currentVersion = null;
    this.question = null; this.answer = null; this.answerVersion = null; this.draft = ""; this.draftAssignmentId = null; this.previous = false; this.pendingGradeAdvance = null; this.waitNext = false;
    return this.run(async () => {
      this.phase = "loading"; this.problem = null;
      await this.commands.begin({ kind: "session.start", session_id: started, payload: { mode: "learning" } });
      if (!this.live() || this.is("closed", "stopping")) return;
      // The start met another record in the shared slot and was neither stored nor sent: no session of its ID exists to
      // read or check. The view goes back to what it showed, unless something newer replaced this start meanwhile.
      if (this.unsentSlot()) {
        // "unknown": the lane held the start for a moment while it was being stored; nothing newer than this start.
        if (this.sessionId === started && this.is("loading", "unknown")) Object.assign(this, before);
        return;
      }
      this.consume();
      if (this.commands.snapshot().primary.outcome === "accepted") {
        this.chooseCurrent();
        if (this.current?.assignment) await this.showQuestion();
      }
    });
  }
  advancePreview(known = false): Promise<void> {
    if (!this.snapshot().canAdvancePreview || !this.current?.preview || !this.sessionId) return Promise.resolve();
    const action: LearningTransition = { kind: known ? "learning.known" : "learning.preview_next",
      session_id: this.sessionId, preview_id: this.current.preview.id, payload: {} };
    return this.run(async () => {
      this.problem = null; await this.commands.begin(action);
      if (!this.live() || this.is("closed", "stopping")) return;
      this.consume();
      if (this.commands.snapshot().primary.outcome === "accepted") {
        this.chooseCurrent();
        if (this.current?.assignment) await this.showQuestion();
      }
    });
  }
  retry(lane: DocumentLane = "primary"): Promise<void> {
    // The permission at the tap (canRetry with page.owns): once the retry runs, the lane no longer shows that right.
    const primary = this.commands.snapshot().primary, intent = primary.pendingIntent;
    if (lane === "primary" && primary.canRetry && intent?.kind === "session.start") this.pageRetry = intent.session_id;
    return super.retry(lane);
  }
  /** An open IME composition sends nothing (the Learning screen also filters it in its input). */
  submit(options: { forgot?: boolean; composing?: boolean } = {}): Promise<void> {
    return options.composing ? Promise.resolve() : super.submit(options);
  }
  stop(reason: "stop" | "summary_home" = "stop"): Promise<void> {
    if (!this.snapshot().canStop || !this.sessionId) return this.stopping ?? Promise.resolve();
    const sessionId = this.sessionId;
    return this.runStop(() => this.commands.begin({ kind: "session.stop", session_id: sessionId, payload: { reason } }), reason);
  }
  /** Stop and its exact retry must never queue behind a stalled answer request. */
  protected runStop(send: () => Promise<void>, reason?: "stop" | "summary_home"): Promise<void> {
    if (this.stopping) return this.stopping;
    const tap = this.tapStop(), sessionId = this.sessionId;
    const task = send().then(async () => {
      if (!this.live() || !sessionId || await this.unsentStop(tap)) return;
      const state = this.commands.snapshot().stop;
      // A retried Stop (from the base) carries no reason: the closed projection or the boundary names it.
      if (state.outcome === "accepted") this.close(sessionId, reason ?? (this.current?.status === "closed" ? this.current.close_reason : null));
      else if (state.outcome === "not_applied") this.close(sessionId, state.closedSession?.close_reason ?? null);
      else if (state.outcome === "rejected") { this.phase = "stale"; this.problem = state.rejectionCode ?? "stop_rejected"; }
    }, async (error: unknown) => {
      // A Stop refused before any request (its intent) shows no waiting either; the refusal itself still surfaces.
      if (this.live() && sessionId) await this.unsentStop(tap);
      throw error;
    }).finally(() => { if (this.stopping === task) this.stopping = null; this.emit(); });
    this.stopping = task; this.emit(); return task;
  }
}
