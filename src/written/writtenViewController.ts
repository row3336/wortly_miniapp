import type { ClosedSessionBoundary, PublicAssignment, SessionProjection, WrittenPractice, WrittenStep, WrittenSummary } from "../api/generated";
import { CLOSE_REASONS, sameId } from "../api/wireValidation";
import type { ResultTimerView } from "../commands/resultTimer";
import { StudyView, type EmptyStop, type StudyLanes, type StudyPhase } from "../commands/studyView";
import type { WrittenAnswer } from "./writtenApi";
import type { WrittenCommandSnapshot } from "./writtenCommandController";
import { WrittenDocumentCommands, type WrittenDocumentOptions, type WrittenDocumentSnapshot } from "./writtenDocumentCommands";

/** The written quiz has no Learning preview step. */
type Phase = Exclude<StudyPhase, "preview">;
type Current = SessionProjection | WrittenStep;
type Step = WrittenCommandSnapshot["current"];
/** Server facts of a closed session of this owner. summaryRead describes their acquisition only; it grants nothing. */
export type WrittenClosed = {
  sessionId: string;
  /** The server's close reason as observed; null while unknown (Q27-А shows it on an interrupted summary). */
  reason: ClosedSessionBoundary["close_reason"] | null;
  summary: WrittenSummary | null;
  summaryRead: "pending" | "reading" | "failed" | "known";
  /**
   * The server had ended this session naturally before it was closed (F1, C081, C088): a server summary projection
   * of it with consistent counts, not withdrawn since by an active or inconsistent closed projection or an accepted
   * undo. true keeps the completed summary without a reason; false is an interruption (Q27-А); null is not known
   * yet: «Шаг назад» from that summary was sent and its outcome is unresolved, so neither summary is shown.
   */
  natural: boolean | null;
  /** The closure answered this owner's own «На Сегодня» (summary_home met by SESSION_CLOSED): navigation only. */
  homeRequested: boolean;
};
type Options = Omit<WrittenDocumentOptions, "onUpdate"> & {
  sessionId: string | null;
  transitionMode(): "normal" | "accelerated" | null;
  /** Route/configuration gate; independent of Stop and read-only pending recovery. */
  enabled?(): boolean;
  onUpdate(snapshot: WrittenViewSnapshot): void;
};
export type WrittenViewSnapshot = {
  phase: Phase;
  sessionId: string | null;
  current: Current | null;
  question: PublicAssignment | null;
  draft: string;
  answer: WrittenAnswer | null;
  submittedText: string | null;
  problem: string | null;
  commands: WrittenDocumentSnapshot;
  timer: ResultTimerView | null;
  /** Material of the current or last requested session; a refused start has no projection of its own. */
  bucket: "words" | "phrases" | null;
  /**
   * The daily practice count (2.31б) of the last server step that carried it. Only answer replies carry the step, so
   * it is null until the first answer of the session and then survives the plain session projections that follow.
   */
  practice: WrittenPractice | null;
  /** The confirmed natural summary of the current session (Д02 «completed»). */
  summary: WrittenSummary | null;
  closed: WrittenClosed | null;
  canStart: boolean;
  canSubmit: boolean;
  canEditDraft: boolean;
  canForget: boolean;
  canNext: boolean;
  canPrevious: boolean;
  /** Only the server's correct_target of this exact result grants the one-tap correction, never the error itself. */
  canCorrect: boolean;
  grades: (3 | 4 | 5)[];
  /** «Шаг назад»: only the server's undo_target of the answer on screen (its result view or the summary). */
  canUndo: boolean;
  canStop: boolean;
  canSummaryHome: boolean;
  canRetryPrimary: boolean;
  /** The last Stop of this session that sent nothing: internal facts, nothing of it is shown (EmptyStop). */
  emptyStop: EmptyStop | null;
  /** A prefetched question waits for the host to be enabled (confirmed settings); until then the view cannot leave "loading". */
  waitingForSettings: boolean;
  /**
   * The card of the answer on screen (К05-080 «Уточнить» for an answered card): only on the current result, whose
   * assignment is still the shown question. root decision, pending owner (M-ACTIONS Р9): not on a previous result.
   */
  resultCardId: string | null;
};
/**
 * Real, consistent counts of a finished step: its summary repeats its progress and the whole queue is done. Core
 * enters summary only once the queue is exhausted, 0 of 0 when every card was excluded (K07-071).
 */
const finished = (step: Current | Step | null): boolean => {
  if (!step || !("summary" in step) || !step.summary || !("progress" in step)) return false;
  // The wire decoder already holds the summary to the progress counts (study/sessionProjection).
  return step.progress.completed === step.progress.total;
};
const closeReason = (value: string | null | undefined): WrittenClosed["reason"] =>
  value && CLOSE_REASONS.includes(value) ? value as ClosedSessionBoundary["close_reason"] : null;

/** Presentation is local; only document commands can establish a saved answer, presentation or closure. */
export class WrittenViewController extends StudyView<WrittenDocumentCommands, Current, WrittenAnswer, WrittenViewSnapshot> {
  private summary: { value: WrittenSummary; version: string } | null = null;
  private practice: { value: WrittenPractice; version: string } | null = null;
  private requestedBucket: "words" | "phrases" | null = null;
  private closedFacts: WrittenClosed | null = null;
  /** The session whose server summary projection proves a natural end; an undo back to active withdraws it. */
  private naturalEnd: string | null = null;
  /** That proof while «Шаг назад» from the summary is unresolved: only the undo's own outcome settles it. */
  private naturalSuspended: string | null = null;
  private summaryReading: Promise<void> | null = null;

  constructor(options: Options) {
    super(options, { ignoreUnboundUnavailable: true, keepClosedAfterRead: true },
      onUpdate => new WrittenDocumentCommands({ ...options, onUpdate }));
  }
  protected close(sessionId: string, reason: string | null): void {
    this.cancelTimer(); this.phase = "closed"; this.question = null; this.draft = ""; this.draftAssignmentId = null;
    this.pendingGradeAdvance = null; this.previous = false;
    if (!this.closedFacts || !sameId(this.closedFacts.sessionId, sessionId)) {
      this.closedFacts = { sessionId, reason: null, summary: null, summaryRead: "pending", natural: null, homeRequested: false };
    }
    this.syncNatural();
    // The first known reason wins; a later observation only fills an unknown one.
    this.closedFacts.reason ??= closeReason(reason);
    // A closure met by a refused command reads no session by itself: its summary is read outside this update (Q27-А).
    void Promise.resolve().then(() => this.readClosedSummary());
  }
  protected captured(step: Current, version: string): void {
    // Not a local phase nor equal counts alone: a server summary step of this session with its summary present.
    if (step.status === "summary" && finished(step)) { this.naturalEnd = step.session_id; this.naturalSuspended = null; }
    // An active step withdraws the proof. A closed step never creates or restores it: its counts are checked once, by
    // knowClosedSummary, whichever way the closure became known (a projection or a boundary).
    else if (step.status !== "closed") this.withdrawNatural();
    if ("practice" in step && (!this.practice || BigInt(version) >= BigInt(this.practice.version))) {
      this.practice = { value: structuredClone(step.practice), version };
    }
    if ("summary" in step && step.summary && (!this.summary || BigInt(version) >= BigInt(this.summary.version))) {
      this.summary = { value: structuredClone(step.summary), version };
    }
  }
  protected closure(state: StudyLanes): { reason: string | null } | null {
    this.trackUndo(state);
    const boundary = state.primary.closedSession ?? state.stop.closedSession;
    if (state.stop.outcome === "accepted" && state.stop.resolved?.kind === "session.stop" && this.sessionId
      && sameId(state.stop.resolved.sessionId, this.sessionId)) return { reason: null };
    return boundary && this.sessionId && sameId(boundary.session_id, this.sessionId) ? { reason: boundary.close_reason } : null;
  }
  protected recoveredSession(state: StudyLanes): string | null {
    const resolved = state.primary.resolved;
    // A refused start created no session; any other resolved command addresses an existing one.
    const resolvedSession = resolved && !(resolved.kind === "session.start" && state.primary.outcome !== "accepted") ? resolved.sessionId : null;
    return state.primary.pendingIntent?.session_id ?? resolvedSession ?? state.stop.pendingIntent?.session_id ?? null;
  }
  protected activeAssignment(): PublicAssignment | null { return this.current?.status === "active" ? this.current.assignment : null; }
  protected refused(kind: string): boolean {
    // A refused start leaves no session of this owner: the reason stays visible and Today stays reachable.
    if (kind !== "session.start") return false;
    this.sessionId = null; this.current = null; this.phase = "idle";
    return true;
  }
  protected async afterRead(): Promise<void> { if (this.is("closed")) await this.readClosedSummary(); }
  snapshot(): WrittenViewSnapshot {
    const { fields, live, interactive } = this.view(), commands = fields.commands, pending = commands.primary.pendingIntent;
    const closing = live && commands.canStop && this.sessionId !== null && !this.stopping && !this.is("closed", "idle", "disposed");
    return { phase: live ? this.phase as Phase : "disposed", ...fields,
      bucket: live ? this.current?.bucket ?? this.requestedBucket ?? (pending?.kind === "session.start" ? pending.payload.bucket : null) : null,
      practice: live && this.practice ? structuredClone(this.practice.value) : null,
      summary: live && this.summary ? structuredClone(this.summary.value) : null,
      closed: live && this.is("closed") && this.closedFacts ? structuredClone(this.closedFacts) : null,
      canStart: live && interactive && commands.canBegin && !this.operation && !this.reading && !this.stopping && this.is("idle", "closed"),
      canStop: closing && !this.is("summary"), canSummaryHome: closing && this.is("summary"),
      waitingForSettings: live && this.is("loading") && this.question?.status === "prefetched" && !this.enabled(),
      resultCardId: live && this.is("result_correct", "result_wrong") && this.question !== null && this.answer?.result
        && sameId(this.answer.result.assignment_id, this.question.id) ? this.question.card_id : null };
  }
  /**
   * The summary of an interrupted session (the own Stop or any closure not chosen here, Q27-А) is the closed session
   * projection itself (C-WSUM): the server counted every answer committed before the closure, so neither a result
   * address nor an unknown receipt is needed. Without that projection at hand the session is read once. summary_home
   * leaves the summary it already showed. Data only; it restores no right.
   */
  private readClosedSummary(): Promise<void> {
    const facts = this.closedFacts;
    // A natural end is read too: only its closed projection can confirm that the session was not reopened (D1).
    if (!facts || facts.reason === "summary_home" || facts.summaryRead === "known" || !this.live()) return Promise.resolve();
    if (this.knowClosedSummary(facts, this.current)) { this.emit(); return Promise.resolve(); }
    if (this.summaryReading) return this.summaryReading;
    const task = (async () => {
      facts.summaryRead = "reading"; this.emit();
      const read = await this.commands.readSession(facts.sessionId);
      if (!this.live() || this.closedFacts !== facts) return;
      if (!this.knowClosedSummary(facts, read.current)) facts.summaryRead = "failed";
    })().catch(() => { if (this.closedFacts === facts) facts.summaryRead = "failed"; })
      .finally(() => { if (this.summaryReading === task) this.summaryReading = null; this.emit(); });
    this.summaryReading = task;
    return task;
  }
  /** «Шаг назад» from a proven summary suspends the proof until its own outcome is known (C088). */
  private trackUndo(state: StudyLanes): void {
    const lane = state.primary;
    if (this.naturalEnd && lane.pending && lane.outcome === null && lane.pendingIntent?.kind === "result.undo"
      && sameId(lane.pendingIntent.session_id, this.naturalEnd)) {
      this.naturalSuspended = this.naturalEnd; this.naturalEnd = null;
    } else if (this.naturalSuspended && lane.resolved?.kind === "result.undo" && lane.outcome !== null
      && sameId(lane.resolved.sessionId, this.naturalSuspended)) {
      // Not applied or refused: the summary stood. Accepted: the session was reopened.
      if (lane.outcome === "accepted") this.naturalSuspended = null;
      else { this.naturalEnd = this.naturalSuspended; this.naturalSuspended = null; }
    }
    this.syncNatural();
  }
  private withdrawNatural(): void {
    this.naturalEnd = null; this.naturalSuspended = null;
    if (this.closedFacts) this.closedFacts.natural = false;
  }
  /**
   * Closed facts follow the proof. An interruption is final: withdrawNatural clears the proof itself, and a closed
   * session issues no summary step that could prove it again.
   */
  private syncNatural(): void {
    const facts = this.closedFacts;
    if (!facts) return;
    const own = (id: string | null) => id !== null && sameId(id, facts.sessionId);
    facts.natural = own(this.naturalEnd) ? true : own(this.naturalSuspended) ? null : false;
  }
  private knowClosedSummary(facts: WrittenClosed, step: Step | Current | null): boolean {
    if (!step || !("summary" in step) || step.status !== "closed" || !step.summary || !sameId(step.session_id, facts.sessionId)) return false;
    facts.summary = structuredClone(step.summary); facts.summaryRead = "known";
    if (!finished(step)) this.withdrawNatural();
    // A closure met without its reason (a refused command) learns it from the closed projection.
    facts.reason ??= closeReason(step.close_reason);
    return true;
  }
  start(bucket: "words" | "phrases"): Promise<void> {
    if (bucket !== "words" && bucket !== "phrases") return Promise.reject(new Error("written bucket required"));
    if (!this.snapshot().canStart) return Promise.resolve();
    this.sessionId = this.options.newId(); this.current = null; this.currentVersion = null; this.summary = null; this.practice = null; this.closedFacts = null;
    this.naturalEnd = null; this.naturalSuspended = null;
    this.requestedBucket = bucket;
    this.question = null; this.answer = null; this.answerVersion = null; this.draft = ""; this.draftAssignmentId = null;
    this.previous = false; this.pendingGradeAdvance = null; this.waitNext = false;
    return this.run(async () => {
      this.phase = "loading"; this.problem = null;
      await this.commands.begin({ kind: "session.start", session_id: this.sessionId!, payload: { mode: "written", bucket } });
      if (!this.live() || this.is("closed", "stopping")) return;
      this.consume();
      if (this.commands.snapshot().primary.outcome === "accepted") {
        this.chooseCurrent();
        if (this.current?.status === "active" && this.current.assignment) await this.showQuestion();
      }
    });
  }
  stop(reason: "stop" | "summary_home" = "stop"): Promise<void> {
    const view = this.snapshot();
    if (!(reason === "stop" ? view.canStop : view.canSummaryHome) || !this.sessionId) return this.stopping ?? Promise.resolve();
    const sessionId = this.sessionId;
    return this.runStop(() => this.commands.begin({ kind: "session.stop", session_id: sessionId, payload: { reason } }), reason);
  }
  /** Stop and its exact retry never queue behind a stalled answer request. */
  protected runStop(send: () => Promise<void>, reason?: "stop" | "summary_home"): Promise<void> {
    if (this.stopping) return this.stopping;
    const tap = this.tapStop(), sessionId = this.sessionId;
    const task = send().then(async () => {
      if (!this.live() || !sessionId || await this.unsentStop(tap)) return;
      const state = this.commands.snapshot().stop;
      const own = state.resolved?.kind === "session.stop" && sameId(state.resolved.sessionId, sessionId);
      if (own && state.outcome === "accepted") {
        this.close(sessionId, reason ?? (this.current?.status === "closed" ? this.current.close_reason : null));
        // The summary may first wait for an in-flight answer to settle; Stop itself is already confirmed.
        void this.readClosedSummary();
      } else if (own && state.outcome === "not_applied") this.close(sessionId, state.closedSession?.close_reason ?? null);
      // root decision, pending owner (M-WRITTEN-CLOSED F3): a session already closed elsewhere is that closure, not a
      // failed Stop; its summary is read at once and shows the actual reason, no manual check.
      else if (state.outcome === "rejected" && state.rejectionCode === "SESSION_CLOSED") {
        this.close(sessionId, state.closedSession?.close_reason ?? null);
        if (reason === "summary_home" && this.closedFacts && sameId(this.closedFacts.sessionId, sessionId)) this.closedFacts.homeRequested = true;
      } else if (state.outcome === "rejected") { this.phase = "stale"; this.problem = state.rejectionCode ?? "stop_rejected"; }
    }, async (error: unknown) => {
      // A Stop refused before any request (its intent) shows no waiting either; the refusal itself still surfaces.
      if (this.live() && sessionId) await this.unsentStop(tap);
      throw error;
    }).finally(() => { if (this.stopping === task) this.stopping = null; this.emit(); });
    this.stopping = task; this.emit(); return task;
  }
}
