import type { PublicAssignment } from "../api/generated";
import { sameId } from "../api/wireValidation";
import type { OpenedAccess } from "../app/openedAccess";
import type { DocumentLane, DocumentLanesSnapshot, ResultAddress } from "./documentLanes";
import type { RevisionTarget } from "./resultRevision";
import { ResultTimer, type ResultTimerView } from "./resultTimer";
import { undoAction, type UndoTarget } from "./resultUndo";

export type StudyPhase = "loading" | "idle" | "preview" | "question" | "visible_unconfirmed" | "submitting" | "unknown"
  | "result_correct" | "result_wrong" | "changing_result" | "undoing" | "previous_result" | "summary" | "stopping" | "closed" | "stale"
  | "disposed";
/** The session projection a study view keeps (written quiz or Learning). */
export type StudyCurrent = { session_id: string; status: "active" | "summary" | "closed"; pair: string;
  close_reason: string | null; assignment: PublicAssignment | null };
/** The saved answer of the visible question and the server rights over it. */
export type StudyAnswer = {
  action: { action_id: string; version: string; status: string } | null;
  result: { result_id: string; assignment_id: string; version: string; grade: number; status: string } | null;
  capabilities: { correct_target: RevisionTarget | null; grades: (RevisionTarget & { values: (3 | 4 | 5)[] }) | null;
    undo_target: UndoTarget | null };
};
type Intent = { command_id: string; kind: string; session_id: string; assignment_id?: string; payload?: object };
/** The fields of a lane snapshot a study view reads. */
type LaneView = {
  phase: string;
  pending: boolean;
  kind: string | null;
  pendingIntent: Intent | null;
  outcome: "accepted" | "rejected" | "not_applied" | null;
  resolved: { commandId: string; kind: string; sessionId: string; assignmentId?: string; resultId?: string } | null;
  rejectionCode: string | null;
  problem: string | null;
  canRetry: boolean;
  current: object | null;
  answer: StudyAnswer | null;
  closedSession: { session_id: string; close_reason: string } | null;
  stateVersion: string | null;
};
export type StudyLanes = DocumentLanesSnapshot<LaneView>;
/** What a Stop tap discarded, and the stop lane before it was sent. */
type StopTap = { phase: StudyPhase; draft: string; draftAssignmentId: string | null; lane: LaneView };
/**
 * How the session GET of one read ended, and only that GET: its reply taken by the view ("applied"), its reply not
 * taken (below the floor, another session or pair, or the view moved on meanwhile: "ignored"), the GET itself failed
 * ("failed"), or no GET was made (the lane check failed or ended the read before it: "not_read"). Later steps of the
 * read (the result read, a recovered result) never change it.
 */
export type StudyReadOutcome = "applied" | "ignored" | "failed" | "not_read";
/** The read one call got: its session GET outcome, and joined when that read had started before the call. */
export type StudyRead = { outcome: StudyReadOutcome; joined: boolean };
/** A queue of reads and the read it last awaited, known even when a later step of that read threw. */
type ReadQueue = { task: Promise<StudyRead>; last: StudyRead | null };
/**
 * The last Stop of this session that sent nothing, as separate facts: why the lanes refused it, when they prove a
 * reason ("session_closed": they saw this session closed; null: no proven reason), and the read it got (read: null while
 * it runs; joined: that read had started before the tap). Internal facts only: nothing here is shown, offered or stored.
 */
export type EmptyStop = { sessionId: string; refusal: "session_closed" | null; read: StudyReadOutcome | null; joined: boolean };
/** Recovery states that end without an outcome of the action: nothing is sent or checked any more. */
const ENDED_RECOVERY: ReadonlySet<string> = new Set(["refused", "terminated", "conflict"]);
/**
 * The automatic recovery of the pending primary action ended without its outcome (CT §6.1 п. 7, 10): the view shows the
 * server's state instead of an unknown action; "conflict" also keeps its own problem (Я17).
 */
function endedRecovery(state: StudyLanes): string | null {
  const recovery = state.recovery, id = state.primary.pendingIntent?.command_id;
  return recovery !== null && id !== undefined && recovery.commandId === id && ENDED_RECOVERY.has(recovery.state.name)
    ? recovery.state.name : null;
}
type SessionRead = { state_version: string; current: object };
type ResultRead = StudyAnswer & { state_version: string; step: object };
/** The document command owner of a study view. */
export type StudyCommands = {
  snapshot(): StudyLanes;
  begin(action: never): Promise<void>;
  retry(lane: DocumentLane): Promise<void>;
  refresh(): Promise<void>;
  /** S07: repeat only the local cleanup of a confirmed primary outcome; nothing is requested. */
  clearSettled(): Promise<void>;
  readSession(sessionId: string): Promise<SessionRead>;
  /** The lanes saw this session closed under the current document (DocumentLanes.knowsClosed). */
  knowsClosed(sessionId: string): boolean;
  readResult(address: ResultAddress): Promise<ResultRead>;
  /** The activity of this view drives the automatic recovery of the primary action (Я15.3, Я15.7). */
  setRecoveryActive(active: boolean): void;
  dispose(): void;
};
export type StudyViewOptions = {
  access(): OpenedAccess;
  newId(): string;
  sessionId: string | null;
  transitionMode(): "normal" | "accelerated" | null;
  /** Route/configuration gate; independent of Stop and read-only pending recovery. */
  enabled?(): boolean;
};
/** The view fields both modes share; each mode adds its own (written: summary and closure; Learning: preview). */
export type StudyViewFields<C, A, D> = {
  sessionId: string | null;
  current: C | null;
  question: PublicAssignment | null;
  draft: string;
  answer: A | null;
  submittedText: string | null;
  problem: string | null;
  commands: D;
  timer: ResultTimerView | null;
  canSubmit: boolean;
  canEditDraft: boolean;
  canForget: boolean;
  canNext: boolean;
  canPrevious: boolean;
  /** Only the server's correct_target of this exact result grants the one-tap correction, never the error itself. */
  canCorrect: boolean;
  grades: (3 | 4 | 5)[];
  /** «Шаг назад»: only the server's undo_target of the answer on screen, on its result or on the summary (К05-066, RA Д02). */
  canUndo: boolean;
  canRetryPrimary: boolean;
  /** The last Stop of the current session that sent nothing (internal facts, see EmptyStop); null otherwise. */
  emptyStop: EmptyStop | null;
};
/** Mode rules that differ on purpose; each keeps the mode's established behavior. */
export type StudyViewRules = {
  /**
   * An unavailable projection while this view has no session yet: the written quiz ignores it (a refused start leaves
   * no session of this owner), Learning marks the view stale.
   */
  ignoreUnboundUnavailable: boolean;
  /** The written quiz never lets a session read reopen a view that became closed meanwhile; Learning re-chooses its step. */
  keepClosedAfterRead: boolean;
};

/**
 * Presentation is local; only document commands can establish a saved answer, presentation or closure. This is the
 * shared result view of the answer modes: one question at a time, its result with the auto-advance timer, the grade and
 * correction rights, background (not Stop) and the read that recovers a receipt by its ID.
 */
export abstract class StudyView<K extends StudyCommands, C extends StudyCurrent, A extends StudyAnswer, S> {
  protected readonly commands: K;
  private readonly pair: string;
  protected sessionId: string | null;
  protected phase: StudyPhase = "loading";
  protected current: C | null = null;
  protected currentVersion: string | null = null;
  protected question: PublicAssignment | null = null;
  protected draft = "";
  protected draftAssignmentId: string | null = null;
  protected answer: A | null = null;
  protected answerVersion: string | null = null;
  protected problem: string | null = null;
  private lastResolved: string | null = null;
  protected previous = false;
  /** After background or an explicit return the result waits for «Далее» (К05-152, DC 2.19). */
  protected waitNext = false;
  private readonly timer = new ResultTimer();
  protected operation: Promise<void> | null = null;
  /** The read in flight; it resolves to the outcome of its own session GET. */
  protected reading: Promise<StudyReadOutcome> | null = null;
  private readingSource: OpenedAccess | null = null;
  private emptyStop: EmptyStop | null = null;
  private readingMinimumVersion = "0";
  /** Reads a newer handle or version required after the one in flight; last is the read they last awaited. */
  private queuedRead: ReadQueue | null = null;
  /** Reads that paused the countdown and have not finished their tail yet; the pause outlives overlapping reads (П02). */
  private pausingReads = 0;
  protected stopping: Promise<void> | null = null;
  private disposed = false;
  private active = true;
  private activationGeneration = 0;
  protected pendingGradeAdvance: string | null = null;
  /** Where «Шаг назад» was tapped: a refusal returns there (the result or the summary). */
  private undoFrom: StudyPhase | null = null;
  /** The last action whose automatic recovery this view has shown; each is shown once. */
  private recoveredCommand: string | null = null;

  constructor(protected readonly options: StudyViewOptions & { onUpdate(snapshot: S): void }, private readonly rules: StudyViewRules,
    commands: (onUpdate: (state: StudyLanes) => void) => K) {
    this.sessionId = options.sessionId;
    this.pair = `${options.access().profile.dictionary_language}-de`;
    this.commands = commands(state => this.observe(state));
  }
  /** Close this view's session; reason is the server's close reason when known. */
  protected abstract close(sessionId: string, reason: string | null): void;
  /** A closure the lanes prove for this view's session, or null. */
  protected abstract closure(state: StudyLanes): { reason: string | null } | null;
  /** The session a read recovers when this view has none yet. */
  protected abstract recoveredSession(state: StudyLanes): string | null;
  /** The assignment of the kept projection that may be shown or answered. */
  protected abstract activeAssignment(): PublicAssignment | null;
  /** A captured projection of this session (after the shared bookkeeping, before its closure). */
  protected captured(_step: C, _version: string): void {}
  /** A refused command of this kind ends here (e.g. a refused start); false lets the shared handling continue. */
  protected refused(_kind: string): boolean { return false; }
  /** A step before the question (e.g. a Learning preview); true when chosen. */
  protected chooseOther(_current: C): boolean { return false; }
  /** Work after a session read settled, before the view continues. */
  protected afterRead(): Promise<void> { return Promise.resolve(); }
  /** Stop and its exact retry; they never queue behind a stalled answer request. */
  protected abstract runStop(send: () => Promise<void>): Promise<void>;
  /**
   * A Stop tap: Exit discards unsent study input (recorded answers stay, К05-065) and waits for Stop. The returned tap
   * keeps what was discarded and the stop lane before sending, for unsentStop.
   */
  protected tapStop(): StopTap {
    const tap: StopTap = { phase: this.phase, draft: this.draft, draftAssignmentId: this.draftAssignmentId, lane: this.commands.snapshot().stop };
    this.cancelTimer(); this.pendingGradeAdvance = null; this.draft = ""; this.draftAssignmentId = null; this.phase = "stopping";
    this.emptyStop = null;
    return tap;
  }
  /**
   * Stop of this tap sent nothing: the lanes refused it locally (a session they know closed, a joined check, not ready)
   * or before any request. Every send starts the lane afresh (a new pending record), so an unchanged lane that is not
   * pending is no request at all; a Stop without its answer stays pending and keeps waiting. Then nothing was exited:
   * the screen returns to where Stop was tapped with its unsent input, and one session read shows the server's actual
   * state (a closure the lanes already know closes this view with its reason). true when nothing was sent.
   */
  protected async unsentStop(tap: StopTap): Promise<boolean> {
    const after = this.commands.snapshot().stop;
    if (after.pending || after.resolved?.commandId !== tap.lane.resolved?.commandId) return false;
    // The view moved on meanwhile (e.g. it closed from the lanes): that state stands.
    if (!this.is("stopping")) return true;
    this.phase = tap.phase; this.draft = tap.draft; this.draftAssignmentId = tap.draftAssignmentId;
    const sessionId = this.sessionId;
    // The refusal is what the lanes prove now, never derived from canStop (readiness and work in flight also clear it).
    const facts: EmptyStop | null = sessionId
      ? { sessionId, refusal: this.commands.knowsClosed(sessionId) ? "session_closed" : null, read: null, joined: false } : null;
    this.emptyStop = facts;
    // Known as soon as the session GET ended, even if a later step of the read then throws.
    await this.readOnce(read => { if (facts) { facts.read = read.outcome; facts.joined = read.joined; } });
    return true;
  }

  protected is(...phases: StudyPhase[]): boolean { return phases.includes(this.phase); }
  protected live(): boolean { return !this.disposed && this.commands.snapshot().live; }
  protected enabled(): boolean { return this.options.enabled?.() !== false && this.options.transitionMode() !== null; }
  protected interactive(): boolean { return this.active && this.enabled(); }
  abstract snapshot(): S;
  protected emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  protected cancelTimer(): void { this.timer.cancel(); }
  /** Every action this view creates is one of its mode's transitions. */
  protected begin(action: object): Promise<void> { return this.commands.begin(action as never); }
  private setQuestion(assignment: PublicAssignment): void {
    // A temporary unavailable projection hides the question, but does not reassign its local input.
    if (!sameId(this.draftAssignmentId ?? "", assignment.id)) this.draft = "";
    this.draftAssignmentId = assignment.id; this.question = structuredClone(assignment);
  }
  /** Take a step of a read or a lane; true when it was taken (the view's state now follows it). */
  protected capture(step: object | null, version: string | null): boolean {
    if (!step || !version || BigInt(version) < BigInt(this.commands.snapshot().stateVersion)) return false;
    if (!("pair" in step)) {
      if ("session_id" in step && typeof step.session_id === "string"
        && (this.rules.ignoreUnboundUnavailable ? !this.sessionId || !sameId(step.session_id, this.sessionId)
          : this.sessionId && !sameId(step.session_id, this.sessionId))) return false;
      this.current = null; this.currentVersion = version; this.question = null; this.cancelTimer(); this.phase = "stale"; return true;
    }
    const projection = step as C;
    const own = this.sessionId !== null && sameId(projection.session_id, this.sessionId);
    // A closed projection of this view's own session is its closure whatever pair it names: the pair changed elsewhere
    // and the server closed the session (pair_changed). Open steps of another pair stay ignored; nothing of them is shown.
    if (projection.pair !== this.pair && !(own && projection.status === "closed")) return false;
    if (this.sessionId !== null && !own) return false;
    this.sessionId = projection.session_id; this.current = structuredClone(projection); this.currentVersion = version;
    this.captured(projection, version);
    if (projection.status === "closed") this.close(projection.session_id, projection.close_reason);
    return true;
  }
  private observe(state: StudyLanes): void {
    if (this.disposed || !state.live) return;
    const recovery = state.recovery, ended = endedRecovery(state);
    if (recovery && recovery.commandId !== this.recoveredCommand && (recovery.afterLoss && recovery.state.name === "settled" || ended)) {
      this.recoveredCommand = recovery.commandId;
      // The machine confirmed the outcome by the same ID: show it as a check by that ID does (the result, its timer
      // from now, or the refusal). An ended recovery reads the session and shows its actual state (CT §6.1 п. 7).
      // Outside this update: a read starts from here.
      void Promise.resolve().then(() => this.refresh());
    }
    this.capture(state.primary.current, state.primary.stateVersion);
    this.capture(state.stop.current, state.stop.stateVersion);
    const closure = this.closure(state);
    if (closure) this.close(this.sessionId!, closure.reason);
    else if (!this.is("closed")) {
      if (!state.canBegin) this.cancelTimer();
      if (state.stop.pending && state.stop.outcome === null) this.phase = "stopping";
      else if (this.is("stopping") && state.stop.outcome === "rejected") {
        this.phase = "stale"; this.problem = state.stop.rejectionCode ?? "stop_rejected";
      } else if (state.primary.pending && state.primary.outcome === null && !ended) {
        const kind = state.primary.kind;
        if (kind === "assignment.present") {
          if (!this.is("previous_result")) this.phase = this.question ? "visible_unconfirmed" : "unknown";
        } else if (kind === "answer.submit") this.phase = state.primary.phase === "sending" ? "submitting" : "unknown";
        else if (kind === "result.undo") this.phase = state.primary.phase === "sending" ? "undoing" : "unknown";
        else if (kind === "result.grade" || kind === "result.correct") {
          this.phase = state.primary.phase === "sending" ? "changing_result" : "unknown";
        } else this.phase = "unknown";
      }
    }
    this.emit();
  }
  /** The shared part of a snapshot with the readiness facts a mode needs for its own rights. */
  protected view(): { fields: StudyViewFields<C, A, ReturnType<K["snapshot"]>>; live: boolean; interactive: boolean; ready: boolean } {
    const commands = this.commands.snapshot() as ReturnType<K["snapshot"]>, live = !this.disposed && commands.live;
    const fresh = this.currentVersion !== null && BigInt(this.currentVersion) >= BigInt(commands.stateVersion);
    const answerFresh = this.answerVersion !== null && BigInt(this.answerVersion) >= BigInt(commands.stateVersion);
    const interactive = this.interactive();
    const ready = live && interactive && commands.canBegin && !this.operation && !this.reading && !this.stopping && fresh;
    const activeQuestion = this.phase === "question" && this.question?.status === "presented";
    const resultView = this.is("result_correct", "result_wrong", "previous_result");
    const canRevise = ready && answerFresh && resultView;
    const pending = commands.primary.pendingIntent;
    const pendingPresent = pending?.kind === "assignment.present" && this.question !== null
      && sameId(pending.assignment_id, this.question.id) && sameId(pending.session_id, this.sessionId ?? "");
    const visibleQuestion = this.is("question", "visible_unconfirmed", "submitting") || this.is("unknown") && pending?.kind === "answer.submit";
    const payload = pending?.payload;
    return { live, interactive, ready, fields: { sessionId: this.sessionId,
      current: live && fresh ? structuredClone(this.current) : null,
      question: live && visibleQuestion ? structuredClone(this.question) : null, draft: live ? this.draft : "",
      answer: live ? structuredClone(this.answer) : null,
      submittedText: live && pending?.kind === "answer.submit" && payload && "text" in payload ? payload.text as string : null,
      // After an ended recovery the lane's reason is no instruction to the user; only a conflict names itself (Я17).
      problem: this.problem ?? (["refused", "terminated"].includes(endedRecovery(commands) ?? "") ? null
        : commands.primary.rejectionCode ?? commands.primary.problem) ?? commands.stop.rejectionCode ?? commands.stop.problem,
      commands, timer: live && ready ? this.timer.view() : null,
      canSubmit: ready && activeQuestion && this.draft.trim().length > 0,
      canEditDraft: live && interactive && !this.reading && this.is("question", "visible_unconfirmed") && !!this.question,
      canForget: ready && activeQuestion,
      canNext: live && interactive && !this.reading && fresh && (ready && resultView || this.is("previous_result") && pendingPresent),
      canPrevious: live && interactive && !this.reading && !!this.answer?.result && this.is("question", "visible_unconfirmed"),
      canCorrect: canRevise && !!this.answer?.capabilities.correct_target,
      grades: canRevise ? [...this.answer?.capabilities.grades?.values ?? []] : [],
      canUndo: ready && answerFresh && (resultView || this.is("summary")) && !!this.answer?.capabilities.undo_target,
      canRetryPrimary: live && interactive && !this.operation && !this.reading && !this.stopping
        && commands.primary.canRetry && !commands.stop.pending,
      emptyStop: live && this.emptyStop && this.sessionId && sameId(this.emptyStop.sessionId, this.sessionId) ? { ...this.emptyStop } : null } };
  }
  private canNext(): boolean { return this.view().fields.canNext; }
  private armTimer(): void {
    // A read in flight has paused the countdown and arms it again when it ends: do not wipe the pause meanwhile.
    if (this.reading) return;
    const result = this.answer?.result, mode = this.options.transitionMode();
    if (this.waitNext || !this.is("result_correct", "result_wrong") || !result || !this.canNext()
      || mode === null || mode === "normal" && result.grade === 2) { this.cancelTimer(); return; }
    // The timer itself decides between a full duration and the paused remainder of this very result (П02).
    this.timer.start(`${this.sessionId}:${result.result_id}:${result.version}`, mode === "accelerated" ? 2000 : 3000,
      { live: () => this.live(), due: () => this.canNext() }, () => { void this.next(); });
    this.emit();
  }
  private setAnswer(read: Pick<ResultRead, "action" | "result" | "capabilities" | "state_version">): void {
    this.answer = structuredClone({ action: read.action, result: read.result, capabilities: read.capabilities }) as A;
    this.answerVersion = read.state_version;
  }
  private resultPhase(grade: number): StudyPhase { return this.previous ? "previous_result" : grade === 2 ? "result_wrong" : "result_correct"; }
  private acceptResult(read: Pick<ResultRead, "action" | "result" | "capabilities" | "state_version">, kind: string): void {
    if (!read.result) return;
    if (kind === "result.undo") { this.undone(); return; }
    this.setAnswer(read);
    if (kind === "answer.submit") { this.draft = ""; this.previous = false; this.waitNext = false; }
    this.phase = this.resultPhase(read.result.grade);
    if (kind === "result.grade" && !this.previous) this.pendingGradeAdvance = `${read.result.result_id}:${read.result.version}`;
  }
  /**
   * The undone answer leaves the screen together with the question the server withdrew (its draft too): one undo, no
   * history (К05-066). The current step then carries the new issue of the same card, shown by one present (TA:117).
   */
  private undone(): void {
    this.answer = null; this.answerVersion = null; this.question = null; this.draft = ""; this.draftAssignmentId = null;
    this.previous = false; this.waitNext = false; this.pendingGradeAdvance = null;
    this.chooseCurrent();
  }
  /**
   * A refused undo shows the refusal's projection of the addressed answer where it was tapped; its right is re-read.
   * The result then waits for «Далее», as after a refused revision: no timer advances it under the refusal message.
   */
  private refusedUndo(answer: StudyAnswer | null, stateVersion: string | null): void {
    const result = answer?.result;
    if (result?.status === "undone") { this.undone(); return; }
    // Also without a projection: the re-read brings the result back, and it must not advance by itself.
    this.waitNext = true;
    if (!answer || !result || !stateVersion) { this.phase = "stale"; return; }
    this.setAnswer({ ...answer, state_version: stateVersion });
    this.phase = this.undoFrom === "summary" && this.current?.status === "summary" ? "summary" : this.resultPhase(result.grade);
  }
  protected consume(): boolean {
    const state = this.commands.snapshot(), primary = state.primary;
    if (!state.live || this.is("closed") || state.stop.pending) return false;
    this.capture(primary.current, primary.stateVersion);
    if (this.is("closed")) return false;
    if (primary.outcome === null || !primary.resolved || primary.resolved.commandId === this.lastResolved) return false;
    if (primary.outcome === "accepted" && primary.resolved.resultId && !primary.answer?.result) {
      if (primary.resolved.kind === "answer.submit") { this.draft = ""; this.previous = false; }
      this.phase = "stale";
      return false;
    }
    this.lastResolved = primary.resolved.commandId;
    if (primary.outcome !== "accepted") {
      this.problem = primary.rejectionCode ?? "rejected";
      if (this.refused(primary.resolved.kind)) return false;
      if (primary.resolved.kind === "result.undo") { this.refusedUndo(primary.answer, primary.stateVersion); return false; }
      const revision = primary.resolved.kind === "result.grade" || primary.resolved.kind === "result.correct";
      if (revision && primary.answer?.result && primary.stateVersion) {
        this.setAnswer({ ...primary.answer, state_version: primary.stateVersion });
        this.phase = this.resultPhase(primary.answer.result.grade);
      } else {
        const assignment = this.activeAssignment();
        this.phase = this.question && assignment?.id === this.question.id && assignment.status === "presented" ? "question" : "stale";
      }
      return false;
    }
    if (primary.answer?.result && primary.stateVersion) {
      this.acceptResult({ ...primary.answer, state_version: primary.stateVersion }, primary.resolved.kind);
      return true;
    }
    if (!this.current || this.currentVersion === null || BigInt(this.currentVersion) < BigInt(state.stateVersion)) this.phase = "stale";
    return false;
  }
  private async recoverAcceptedResult(): Promise<boolean> {
    const primary = this.commands.snapshot().primary, resolved = primary.resolved;
    if (primary.outcome !== "accepted" || !resolved?.assignmentId || !resolved.resultId || resolved.commandId === this.lastResolved) return false;
    const read = await this.commands.readResult({ session_id: resolved.sessionId,
      assignment_id: resolved.assignmentId, result_id: resolved.resultId });
    if (!this.live() || this.is("closed", "stopping") || this.commands.snapshot().primary.resolved?.commandId !== resolved.commandId) return true;
    this.capture(read.step, read.state_version);
    if (this.is("closed")) return true;
    if (!read.result) { this.phase = "stale"; this.problem = "load"; return true; }
    this.acceptResult(read, resolved.kind); this.lastResolved = resolved.commandId;
    return true;
  }
  protected run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.operation) return this.operation;
    const task = action().catch(() => {
      if (this.live() && !this.is("closed", "stopping")) { this.problem = "load"; this.phase = "stale"; }
    }).finally(() => {
      if (this.operation === task) this.operation = null;
      this.emit();
    });
    this.operation = task;
    return task;
  }
  /**
   * Background is not Stop. Keep the draft and receipt, never present unseen work, and let the result wait.
   * "disabled" (another route, unconfirmed settings) stops only the view: automatic recovery belongs to a visible window
   * with a live document, whatever its route (Я15.7, RESULTS_VP 9.1.5).
   */
  suspend(reason: "background" | "disabled" = "background"): void {
    // pendingGradeAdvance is kept: an explicit grade acknowledged around the background still advances once on return (К05-047).
    // A revision with an unknown outcome keeps the old result on screen: it waits too. A lost answer.submit does not (no result seen yet).
    const kind = this.commands.snapshot().primary.pendingIntent?.kind;
    // A stale view that still holds the shown result (a failed read) keeps waiting for «Далее» after the return too.
    if (this.is("result_correct", "result_wrong", "changing_result") || this.is("stale") && !!this.answer?.result
      || this.is("unknown") && (kind === "result.correct" || kind === "result.grade")) this.waitNext = true;
    this.active = false; this.activationGeneration++; this.cancelTimer();
    if (reason === "background") this.commands.setRecoveryActive(false);
    this.emit();
  }
  /** The window is visible again with a fresh open handle: recovery checks and goes on with the rest of its budget (Я15.3). */
  resumeRecovery(): void { if (this.live()) this.commands.setRecoveryActive(true); }
  /** Foreground callers must first supply a fresh open handle; route/config callers retain that boundary. */
  async resume(): Promise<void> {
    // A background has already stopped recovery; a return from another route must not interrupt it.
    this.suspend("disabled");
    const generation = this.activationGeneration;
    await this.refresh();
    if (!this.live() || generation !== this.activationGeneration) return;
    this.resumeRecovery();
    if (!this.enabled()) return;
    this.active = true;
    await this.continueView(); this.emit();
  }
  private async continueView(): Promise<void> {
    if (!this.live() || !this.interactive()) return;
    if (this.is("loading") && this.question?.status === "prefetched") { await this.showQuestion(); return; }
    if (!this.is("result_correct", "result_wrong")) return;
    const result = this.answer?.result;
    if (result && this.pendingGradeAdvance === `${result.result_id}:${result.version}`) {
      if (this.canNext()) { this.pendingGradeAdvance = null; await this.next(); }
      return;
    }
    this.pendingGradeAdvance = null; this.armTimer();
  }
  async refresh(): Promise<void> { await this.readOnce(); }
  /**
   * One read of the session (its lanes checked first), coalesced with a read in flight as refresh always was. The
   * result is the outcome of the read this call awaited: its own, the one in flight it joined, or the last read of the
   * queue that a newer handle or version required. settled learns that outcome as soon as the session GET has ended,
   * also when a later step of the read (afterRead, continueView) then throws and this call rejects.
   */
  protected async readOnce(settled?: (read: StudyRead) => void): Promise<StudyRead> {
    const known = (read: StudyRead) => { settled?.(read); return read; };
    if (!this.live()) return known({ outcome: "not_read", joined: false });
    if (this.reading) {
      if (this.readingSource === this.options.access()
        && BigInt(this.readingMinimumVersion) >= BigInt(this.commands.snapshot().stateVersion)) {
        return known({ outcome: await this.reading, joined: true });
      }
      if (this.queuedRead) return this.awaitQueue(this.queuedRead, true, settled);
      // A newer handle or confirmed Settings version can invalidate this read: coalesce, then read again.
      const pending = this.reading;
      const queue: ReadQueue = { task: Promise.resolve({ outcome: "not_read", joined: false }), last: null };
      queue.task = (async (): Promise<StudyRead> => {
        queue.last = { outcome: await pending, joined: true };
        while (this.live()) {
          // A subscriber can already have started a read while the old task was publishing: await that read
          // directly, never our own queue.
          const existing = this.reading;
          const source = existing ? this.readingSource : this.options.access();
          const minimum = existing ? this.readingMinimumVersion : this.commands.snapshot().stateVersion;
          if (existing) queue.last = { outcome: await existing, joined: true };
          else await this.readOnce(read => { queue.last = read; });
          const floor = BigInt(this.commands.snapshot().stateVersion);
          if (source === this.options.access() && (BigInt(minimum) >= floor || BigInt(this.currentVersion ?? "0") >= floor)) break;
        }
        return queue.last;
      })().finally(() => { if (this.queuedRead === queue) this.queuedRead = null; this.settlePause(); });
      this.queuedRead = queue;
      return this.awaitQueue(queue, false, settled);
    }
    this.readingSource = this.options.access();
    this.readingMinimumVersion = this.commands.snapshot().stateVersion;
    // A read only pauses the countdown: the same result received again continues it, any other state starts afresh (П02).
    this.timer.pause(); this.pausingReads++; this.problem = null;
    // Only the session GET sets it; a failure of any other step leaves it as that GET ended.
    let outcome: StudyReadOutcome = "not_read";
    const task = (async () => {
      await this.commands.refresh(); if (!this.live() || this.is("closed")) return;
      const state = this.commands.snapshot(), pending = state.primary.pendingIntent;
      this.sessionId ??= this.recoveredSession(state);
      if (this.sessionId === null) { this.phase = "idle"; return; }
      let read: SessionRead;
      try { read = await this.commands.readSession(this.sessionId); } catch (error) { outcome = "failed"; throw error; }
      if (!this.live() || this.is("closed", "stopping") || this.commands.snapshot().stop.pending) { outcome = "ignored"; return; }
      outcome = this.capture(read.current, read.state_version) ? "applied" : "ignored";
      if (this.is("closed")) return;
      const ended = endedRecovery(state) !== null;
      if (pending?.kind === "answer.submit" && !ended) {
        this.draftAssignmentId = pending.assignment_id!;
        this.draft = pending.payload && "text" in pending.payload ? pending.payload.text as string : "";
        const assignment = this.activeAssignment();
        this.question = assignment?.id === pending.assignment_id ? structuredClone(assignment) : null;
        this.phase = "unknown"; return;
      }
      if (this.consume()) return;
      if (await this.recoverAcceptedResult()) return;
      if (this.commands.snapshot().primary.pending && !ended) {
        const assignment = this.activeAssignment();
        // A present intent always names its assignment.
        if (pending?.kind === "assignment.present" && assignment?.id === pending.assignment_id!) {
          this.setQuestion(assignment); this.phase = "visible_unconfirmed";
        } else this.phase = "unknown";
        return;
      }
      if (this.answer?.result) {
        await this.refreshAnswer();
        if (this.answer?.result && this.is("stale", "unknown", "changing_result")) this.phase = this.resultPhase(this.answer.result.grade);
      }
      if (!this.is("previous_result", "result_correct", "result_wrong") && !(this.rules.keepClosedAfterRead && this.is("closed"))) {
        this.chooseCurrent();
      }
    })().catch(() => { if (this.live() && !this.is("closed", "stopping")) { this.phase = "stale"; this.problem = "load"; } })
      .then(() => outcome)
      .finally(() => { if (this.reading === task) this.reading = null; this.emit(); });
    this.reading = task; known({ outcome: await task, joined: false });
    try {
      await this.afterRead();
      await this.continueView();
    } finally { this.pausingReads--; this.settlePause(); }
    return { outcome, joined: false };
  }
  /** The read a queue last awaited; joined also when this call joined another caller's queue. */
  private async awaitQueue(queue: ReadQueue, joined: boolean, settled?: (read: StudyRead) => void): Promise<StudyRead> {
    const mark = (read: StudyRead): StudyRead => ({ ...read, joined: joined || read.joined });
    try { return mark(await queue.task); } finally { if (queue.last) settled?.(mark(queue.last)); }
  }
  /** The pause is forgotten only when no read is left that could arm the same result again. */
  private settlePause(): void {
    if (this.pausingReads === 0 && !this.reading && !this.queuedRead) this.timer.discardPause();
  }
  protected chooseCurrent(): void {
    if (!this.current) { this.phase = "stale"; return; }
    if (this.current.status === "closed") { this.close(this.current.session_id, this.current.close_reason); return; }
    if (this.current.status === "summary") { this.phase = "summary"; return; }
    if (this.chooseOther(this.current)) return;
    const assignment = this.current.assignment;
    if (!assignment) { this.phase = "stale"; return; }
    this.setQuestion(assignment); this.phase = assignment.status === "prefetched" ? "loading" : "question";
  }
  private async refreshAnswer(): Promise<void> {
    if (!this.answer?.result || !this.sessionId) return;
    const read = await this.commands.readResult({ session_id: this.sessionId, assignment_id: this.answer.result.assignment_id,
      result_id: this.answer.result.result_id });
    if (!this.live() || this.is("closed", "stopping")) return;
    this.capture(read.step, read.state_version);
    if (!this.is("closed")) this.setAnswer(read);
  }
  protected async showQuestion(): Promise<void> {
    const assignment = this.activeAssignment();
    if (!this.live() || !this.interactive() || !assignment || !this.sessionId) return;
    this.cancelTimer(); this.previous = false; this.pendingGradeAdvance = null; this.waitNext = false;
    const state = this.commands.snapshot();
    const pending = state.primary.pendingIntent;
    const ownPresent = pending?.kind === "assignment.present" && sameId(pending.assignment_id, assignment.id);
    if (!state.canBegin && !ownPresent) return;
    this.setQuestion(assignment);
    if (assignment.status === "presented" && !ownPresent) {
      this.phase = "question"; if (this.answer?.result) await this.refreshAnswer(); this.emit(); return;
    }
    // One client transition shows B, raises the barrier and creates exactly one present.
    this.phase = "visible_unconfirmed";
    if (ownPresent) { this.emit(); return; }
    const work = this.begin({ kind: "assignment.present", session_id: this.sessionId, assignment_id: assignment.id, payload: {} });
    this.emit(); await work;
    if (!this.live() || this.is("closed", "stopping")) return;
    const after = this.commands.snapshot(); this.capture(after.primary.current, after.primary.stateVersion);
    const shown = this.activeAssignment();
    if (after.primary.outcome === "accepted" && shown?.id === assignment.id && shown.status === "presented") {
      this.question = structuredClone(shown);
      if (!this.is("previous_result")) this.phase = "question";
      if (this.answer?.result) await this.refreshAnswer();
    } else if (!after.primary.pending) { this.phase = "stale"; this.problem = after.primary.rejectionCode ?? "presentation"; }
    this.emit();
  }
  setDraft(text: string): void {
    if (!this.view().fields.canEditDraft) return;
    this.draft = text; this.emit();
  }
  /** IME composition is filtered by the input component (study/WrittenAnswerInput), as in the other study modules. */
  submit(options: { forgot?: boolean } = {}): Promise<void> {
    const view = this.view().fields;
    if (!(options.forgot ? view.canForget : view.canSubmit) || !this.question || !this.sessionId) return Promise.resolve();
    // Capture the assignment and text now: exactly one command_id belongs to this intent.
    const action = { kind: "answer.submit", session_id: this.sessionId, assignment_id: this.question.id,
      payload: options.forgot ? { forgot: true } : { text: this.draft } };
    return this.run(async () => {
      this.cancelTimer(); this.phase = "submitting"; this.problem = null;
      await this.begin(action); if (this.live()) this.consume();
    }).then(() => { if (this.live()) this.armTimer(); });
  }
  previousResult(): void {
    if (!this.view().fields.canPrevious) return;
    this.cancelTimer(); this.previous = true; this.pendingGradeAdvance = null; this.phase = "previous_result"; this.emit();
  }
  next(): Promise<void> {
    if (!this.canNext()) return Promise.resolve();
    this.cancelTimer(); this.pendingGradeAdvance = null;
    if (this.is("previous_result") && this.commands.snapshot().primary.pendingIntent?.kind === "assignment.present") {
      this.previous = false; this.phase = "visible_unconfirmed"; this.emit(); return Promise.resolve();
    }
    if (this.current?.status === "summary") { this.previous = false; this.phase = "summary"; this.emit(); return Promise.resolve(); }
    return this.run(() => this.showQuestion());
  }
  /** Change the saved grade of a correct answer. */
  grade(grade: 3 | 4 | 5): Promise<void> { return this.revise(grade); }
  /** One tap accepts an error as 4 without text or re-check (К05-050…054); 3/5 follow from the new right. */
  correct(): Promise<void> { return this.revise(null); }
  private revise(grade: 3 | 4 | 5 | null): Promise<void> {
    // Both rights wait for a confirmed present of a visible B (canBegin): a revision never overtakes it (CT:107).
    const view = this.view().fields;
    if (grade === null ? !view.canCorrect : !view.grades.includes(grade)) return Promise.resolve();
    const target = grade === null ? this.answer!.capabilities.correct_target! : this.answer!.capabilities.grades!;
    const address = { session_id: target.session_id, assignment_id: target.assignment_id,
      result_id: target.result_id, expected_result_version: target.expected_result_version };
    const action = grade === null ? { kind: "result.correct", ...address, payload: {} }
      : { kind: "result.grade", ...address, payload: { grade } };
    const previous = this.is("previous_result");
    return this.run(async () => {
      // A pending change stops the old timer: it can neither confirm 4 nor show the next card (TA:111, CT:111).
      this.cancelTimer(); this.previous = previous; this.phase = "changing_result"; this.problem = null;
      await this.begin(action); if (this.live()) this.consume();
    }).then(async () => {
      if (!this.live() || this.commands.snapshot().primary.outcome !== "accepted") return;
      if (!previous) await this.continueView();
    });
  }
  /** «Шаг назад»: one undo of the answer on screen, built only from the server's current undo_target (CT 2.3). */
  undo(): Promise<void> {
    if (!this.view().fields.canUndo) return Promise.resolve();
    const from = this.phase, action = undoAction(this.answer!.capabilities.undo_target!);
    return this.run(async () => {
      // A pending undo stops the old timer: it can neither advance nor confirm the result it removes (TA:111).
      this.cancelTimer(); this.pendingGradeAdvance = null; this.undoFrom = from; this.phase = "undoing"; this.problem = null;
      await this.begin(action); if (this.live()) this.consume();
    }).then(async () => {
      if (!this.live()) return;
      const outcome = this.commands.snapshot().primary.outcome;
      // Accepted: show the new issue of the card. Refused: the right is gone or changed, read the actual state (CT 2.2).
      if (outcome === "accepted") await this.continueView();
      else if (outcome === "rejected") await this.refresh();
    });
  }
  /**
   * «Продолжить» (owner answer S07 of 08.10.2026): the server confirmed the action and only its local record was left.
   * Only that cleanup is repeated: no send, no check, no read before it. A repeated refusal keeps the real state on
   * screen. Once the record is gone the view continues as after the confirmation itself; only a view without a usable
   * step reads the session again, and a failure of that read stays a read problem: the record is already gone, so it
   * can neither bring back the failed cleanup nor grant a send of the saved action.
   */
  cleanup(): Promise<void> {
    let cleared = false;
    return this.run(async () => {
      await this.commands.clearSettled();
      cleared = this.live() && !this.commands.snapshot().primary.pending;
    }).then(async () => {
      if (!cleared || !this.live()) return;
      if (this.is("stale")) await this.refresh();
      else await this.continueView();
    });
  }
  retry(lane: DocumentLane = "primary"): Promise<void> {
    if (lane === "stop") {
      if (!this.live() || !this.commands.snapshot().stop.canRetry) return this.stopping ?? Promise.resolve();
      return this.runStop(() => this.commands.retry("stop"));
    }
    if (!this.view().fields.canRetryPrimary) return Promise.resolve();
    return this.run(async () => {
      await this.commands.retry("primary"); if (this.live()) this.consume();
      if (this.is("visible_unconfirmed") && !this.commands.snapshot().primary.pending) await this.showQuestion();
    }).then(async () => { if (this.live()) await this.continueView(); });
  }
  dispose(): void {
    this.cancelTimer(); this.pendingGradeAdvance = null; this.disposed = true; this.commands.dispose(); this.question = null; this.answer = null;
    this.draft = ""; this.draftAssignmentId = null;
  }
}
