import type { LearningSessionProjection, PublicAssignment } from "../api/generated";
import { CLOSE_REASONS, sameId } from "../api/wireValidation";
import type { ResultTimerView } from "../commands/resultTimer";
import { StudyView, type StudyLanes, type StudyPhase } from "../commands/studyView";
import type { LearningCommandSnapshot, LearningTransition } from "./learningCommandController";
import { LearningDocumentCommands, type LearningDocumentSnapshot } from "./learningDocumentCommands";

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
};

const closeReason = (value: string | null | undefined): CloseReason =>
  value && CLOSE_REASONS.includes(value) ? value as CloseReason : null;

/** Presentation is local; only document commands can establish a saved answer or presentation. */
export class LearningViewController extends StudyView<LearningDocumentCommands, LearningSessionProjection, Answer, LearningViewSnapshot> {
  private readonly onLearningComplete: (() => void) | undefined;
  private closedFacts: LearningClosed | null = null;
  constructor(options: Options) {
    super(options, { ignoreUnboundUnavailable: false, keepClosedAfterRead: false },
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
    return state.primary.pendingIntent?.session_id ?? state.primary.resolved?.sessionId ?? null;
  }
  protected activeAssignment(): PublicAssignment | null { return this.current?.assignment ?? null; }
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
      canStop: live && commands.canStop && this.sessionId !== null && !this.is("closed", "idle") };
  }
  start(): Promise<void> {
    if (!this.live() || !this.interactive() || !this.commands.snapshot().canBegin || !this.is("idle", "closed")) return Promise.resolve();
    this.sessionId = this.options.newId(); this.closedFacts = null; this.current = null; this.currentVersion = null;
    this.question = null; this.answer = null; this.answerVersion = null; this.draft = ""; this.draftAssignmentId = null; this.previous = false; this.pendingGradeAdvance = null; this.waitNext = false;
    return this.run(async () => {
      this.phase = "loading"; this.problem = null;
      await this.commands.begin({ kind: "session.start", session_id: this.sessionId!, payload: { mode: "learning" } });
      if (!this.live() || this.is("closed", "stopping")) return;
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
