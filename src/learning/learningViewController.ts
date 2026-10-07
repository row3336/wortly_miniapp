import type { LearningSessionProjection, PublicAssignment } from "../api/generated";
import { sameId } from "../api/wireValidation";
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
  onUpdate(snapshot: LearningViewSnapshot): void;
};
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
  timer: { key: string; durationMs: number } | null;
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

/** Presentation is local; only document commands can establish a saved answer or presentation. */
export class LearningViewController extends StudyView<LearningDocumentCommands, LearningSessionProjection, Answer, LearningViewSnapshot> {
  constructor(options: Options) {
    super(options, { ignoreUnboundUnavailable: false, keepClosedAfterRead: false },
      onUpdate => new LearningDocumentCommands({ ...options, onUpdate }));
  }
  /** Learning keeps no closure facts: a closed session clears its answer and shows no summary of its own. */
  protected close(): void {
    this.cancelTimer(); this.phase = "closed"; this.question = null; this.draft = ""; this.draftAssignmentId = null;
    this.answer = null; this.answerVersion = null; this.pendingGradeAdvance = null;
  }
  protected closure(state: StudyLanes): { reason: string | null } | null {
    const closed = state.stop.outcome === "accepted" && state.stop.resolved?.kind === "session.stop"
      ? state.stop.resolved.sessionId : state.primary.closedSession?.session_id ?? state.stop.closedSession?.session_id;
    return closed && this.sessionId && sameId(closed, this.sessionId) ? { reason: null } : null;
  }
  protected recoveredSession(state: StudyLanes): string | null {
    return state.primary.pendingIntent?.session_id ?? state.primary.resolved?.sessionId ?? null;
  }
  protected activeAssignment(): PublicAssignment | null { return this.current?.assignment ?? null; }
  protected chooseOther(current: LearningSessionProjection): boolean {
    if (!current.preview) return false;
    this.phase = "preview";
    return true;
  }
  snapshot(): LearningViewSnapshot {
    const { fields, live, ready } = this.view(), commands = fields.commands;
    return { phase: live ? this.phase : "disposed", ...fields,
      canAdvancePreview: ready && this.phase === "preview" && !!this.current?.preview,
      canStop: live && commands.canStop && this.sessionId !== null && !this.is("closed", "idle") };
  }
  start(): Promise<void> {
    if (!this.live() || !this.interactive() || !this.commands.snapshot().canBegin || !this.is("idle", "closed")) return Promise.resolve();
    this.sessionId = this.options.newId(); this.current = null; this.currentVersion = null;
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
    return this.runStop(() => this.commands.begin({ kind: "session.stop", session_id: sessionId, payload: { reason } }));
  }
  /** Stop and its exact retry must never queue behind a stalled answer request. */
  protected runStop(send: () => Promise<void>): Promise<void> {
    if (this.stopping) return this.stopping;
    this.cancelTimer(); this.pendingGradeAdvance = null; this.draft = ""; this.draftAssignmentId = null; this.phase = "stopping";
    const task = send().then(() => {
      if (!this.live()) return;
      const state = this.commands.snapshot().stop;
      if (state.outcome === "accepted" || state.outcome === "not_applied") this.close();
      else if (state.outcome === "rejected") { this.phase = "stale"; this.problem = state.rejectionCode ?? "stop_rejected"; }
    }).finally(() => { if (this.stopping === task) this.stopping = null; this.emit(); });
    this.stopping = task; this.emit(); return task;
  }
}
