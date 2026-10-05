import type { PublicAssignment, SessionProjection, WrittenStep, WrittenSummary } from "../api/generated";
import { sameId } from "../api/wireValidation";
import type { WrittenAnswer, WrittenResultRead } from "./writtenApi";
import type { WrittenCommandSnapshot, WrittenTransition } from "./writtenCommandController";
import { WrittenDocumentCommands, type WrittenDocumentOptions, type WrittenDocumentSnapshot } from "./writtenDocumentCommands";

type Phase = "loading" | "idle" | "question" | "visible_unconfirmed" | "submitting" | "unknown"
  | "result_correct" | "result_wrong" | "changing_result" | "previous_result" | "summary" | "stopping" | "closed" | "stale" | "disposed";
type Current = SessionProjection | WrittenStep;
type Step = WrittenCommandSnapshot["current"];
/** Server facts of a closed session of this owner. summaryRead describes their acquisition only; it grants nothing. */
export type WrittenClosed = {
  sessionId: string;
  reason: "stop" | "summary_home" | "other" | null;
  summary: WrittenSummary | null;
  summaryRead: "pending" | "reading" | "failed" | "known";
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
  timer: { key: string; durationMs: number } | null;
  /** Material of the current or last requested session; a refused start has no projection of its own. */
  bucket: "words" | "phrases" | null;
  /** The confirmed natural summary of the current session (Д02 «completed»). */
  summary: WrittenSummary | null;
  closed: WrittenClosed | null;
  canStart: boolean;
  canSubmit: boolean;
  canEditDraft: boolean;
  canForget: boolean;
  canNext: boolean;
  canPrevious: boolean;
  grades: (3 | 4 | 5)[];
  canStop: boolean;
  canSummaryHome: boolean;
  canRetryPrimary: boolean;
};
const closeReason = (value: string | null | undefined): WrittenClosed["reason"] =>
  value === "stop" || value === "summary_home" ? value : value ? "other" : null;

/** Presentation is local; only document commands can establish a saved answer, presentation or closure. */
export class WrittenViewController {
  private readonly commands: WrittenDocumentCommands;
  private readonly pair: string;
  private sessionId: string | null;
  private phase: Phase = "loading";
  private current: Current | null = null;
  private currentVersion: string | null = null;
  private summary: { value: WrittenSummary; version: string } | null = null;
  private requestedBucket: "words" | "phrases" | null = null;
  private closedFacts: WrittenClosed | null = null;
  private question: PublicAssignment | null = null;
  private draft = "";
  private draftAssignmentId: string | null = null;
  private answer: WrittenAnswer | null = null;
  private answerVersion: string | null = null;
  private problem: string | null = null;
  private lastResolved: string | null = null;
  private previous = false;
  /** After background or an explicit return the result waits for «Далее» (К05-152, DC 2.19). */
  private waitNext = false;
  private generation = 0;
  private timer: WrittenViewSnapshot["timer"] = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private operation: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  private readingSource: ReturnType<Options["access"]> | null = null;
  private readingMinimumVersion = "0";
  private queuedRead: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private summaryReading: Promise<void> | null = null;
  private disposed = false;
  private active = true;
  private activationGeneration = 0;
  private pendingGradeAdvance: string | null = null;

  constructor(private readonly options: Options) {
    this.sessionId = options.sessionId;
    this.pair = `${options.access().profile.dictionary_language}-de`;
    this.commands = new WrittenDocumentCommands({ ...options, onUpdate: state => this.observe(state) });
  }
  private is(...phases: Phase[]): boolean { return phases.includes(this.phase); }
  private live(): boolean { return !this.disposed && this.commands.snapshot().live; }
  private enabled(): boolean { return this.options.enabled?.() !== false && this.options.transitionMode() !== null; }
  private interactive(): boolean { return this.active && this.enabled(); }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  private cancelTimer(): void {
    this.generation++;
    if (this.timerHandle !== null) clearTimeout(this.timerHandle);
    this.timerHandle = null; this.timer = null;
  }
  private close(sessionId: string, reason: string | null): void {
    this.cancelTimer(); this.phase = "closed"; this.question = null; this.draft = ""; this.draftAssignmentId = null;
    this.pendingGradeAdvance = null; this.previous = false;
    if (!this.closedFacts || !sameId(this.closedFacts.sessionId, sessionId)) {
      this.closedFacts = { sessionId, reason: null, summary: null, summaryRead: "pending" };
    }
    // The first known reason wins; a later observation only fills an unknown one.
    this.closedFacts.reason ??= closeReason(reason);
  }
  private setQuestion(assignment: PublicAssignment): void {
    // A temporary unavailable projection hides the question, but does not reassign its local input.
    if (!sameId(this.draftAssignmentId ?? "", assignment.id)) this.draft = "";
    this.draftAssignmentId = assignment.id; this.question = structuredClone(assignment);
  }
  private capture(step: Step, version: string | null): void {
    if (!step || !version || BigInt(version) < BigInt(this.commands.snapshot().stateVersion)) return;
    if (!("pair" in step)) {
      // An unavailable projection of no session of this owner (e.g. a refused start) changes nothing here.
      if ("session_id" in step && (!this.sessionId || !sameId(step.session_id, this.sessionId))) return;
      this.current = null; this.currentVersion = version; this.question = null; this.cancelTimer(); this.phase = "stale"; return;
    }
    if (step.pair !== this.pair) return;
    if (this.sessionId !== null && !sameId(step.session_id, this.sessionId)) return;
    this.sessionId = step.session_id; this.current = structuredClone(step); this.currentVersion = version;
    if ("summary" in step && step.summary && (!this.summary || BigInt(version) >= BigInt(this.summary.version))) {
      this.summary = { value: structuredClone(step.summary), version };
    }
    if (step.status === "closed") this.close(step.session_id, step.close_reason);
  }
  private observe(state: WrittenDocumentSnapshot): void {
    if (this.disposed || !state.live) return;
    this.capture(state.primary.current, state.primary.stateVersion);
    this.capture(state.stop.current, state.stop.stateVersion);
    const boundary = state.primary.closedSession ?? state.stop.closedSession;
    if (state.stop.outcome === "accepted" && state.stop.resolved?.kind === "session.stop" && this.sessionId
      && sameId(state.stop.resolved.sessionId, this.sessionId)) this.close(this.sessionId, null);
    else if (boundary && this.sessionId && sameId(boundary.session_id, this.sessionId)) this.close(this.sessionId, boundary.close_reason);
    else if (!this.is("closed")) {
      if (!state.canBegin) this.cancelTimer();
      if (state.stop.pending && state.stop.outcome === null) this.phase = "stopping";
      else if (this.is("stopping") && state.stop.outcome === "rejected") {
        this.phase = "stale"; this.problem = state.stop.rejectionCode ?? "stop_rejected";
      } else if (state.primary.pending && state.primary.outcome === null) {
        const kind = state.primary.kind;
        if (kind === "assignment.present") {
          if (!this.is("previous_result")) this.phase = this.question ? "visible_unconfirmed" : "unknown";
        } else if (kind === "answer.submit") this.phase = state.primary.phase === "sending" ? "submitting" : "unknown";
        else if (kind === "result.grade") {
          this.phase = state.primary.phase === "sending" ? "changing_result" : "unknown";
        } else this.phase = "unknown";
      }
    }
    this.emit();
  }
  snapshot(): WrittenViewSnapshot {
    const commands = this.commands.snapshot(), live = !this.disposed && commands.live;
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
    const closing = live && commands.canStop && this.sessionId !== null && !this.stopping && !this.is("closed", "idle", "disposed");
    return { phase: live ? this.phase : "disposed", sessionId: this.sessionId,
      current: live && fresh ? structuredClone(this.current) : null,
      question: live && visibleQuestion ? structuredClone(this.question) : null, draft: live ? this.draft : "",
      answer: live ? structuredClone(this.answer) : null,
      submittedText: live && pending?.kind === "answer.submit" && "text" in pending.payload ? pending.payload.text : null,
      problem: this.problem ?? commands.primary.rejectionCode ?? commands.primary.problem ?? commands.stop.rejectionCode ?? commands.stop.problem,
      commands, timer: live && ready ? this.timer && { ...this.timer } : null,
      bucket: this.current?.bucket ?? this.requestedBucket ?? (pending?.kind === "session.start" ? pending.payload.bucket : null),
      summary: live && this.summary ? structuredClone(this.summary.value) : null,
      closed: live && this.is("closed") && this.closedFacts ? structuredClone(this.closedFacts) : null,
      canStart: live && interactive && commands.canBegin && !this.operation && !this.reading && !this.stopping && this.is("idle", "closed"),
      canSubmit: ready && activeQuestion && this.draft.trim().length > 0,
      canEditDraft: live && interactive && !this.reading && this.is("question", "visible_unconfirmed") && !!this.question,
      canForget: ready && activeQuestion,
      canNext: live && interactive && !this.reading && fresh && (ready && resultView || this.is("previous_result") && pendingPresent),
      canPrevious: live && interactive && !this.reading && !!this.answer?.result && this.is("question", "visible_unconfirmed"),
      grades: canRevise ? [...this.answer?.capabilities.grades?.values ?? []] : [],
      canStop: closing && !this.is("summary"), canSummaryHome: closing && this.is("summary"),
      canRetryPrimary: live && interactive && !this.operation && !this.reading && !this.stopping
        && commands.primary.canRetry && !commands.stop.pending };
  }
  private armTimer(): void {
    this.cancelTimer();
    if (this.waitNext || !this.is("result_correct", "result_wrong") || !this.answer?.result || !this.snapshot().canNext) return;
    const mode = this.options.transitionMode();
    if (mode === null || mode === "normal" && this.answer.result.grade === 2) return;
    const durationMs = mode === "accelerated" ? 2000 : 3000;
    const generation = this.generation;
    const key = `${this.sessionId}:${this.answer.result.result_id}:${this.answer.result.version}:${generation}`;
    this.timer = { key, durationMs };
    // The timer only changes the view: it never submits, grades or confirms anything (К05-049).
    this.timerHandle = setTimeout(() => {
      if (!this.live() || generation !== this.generation || this.timer?.key !== key || !this.snapshot().canNext) return;
      this.timerHandle = null; this.timer = null;
      void this.next();
    }, durationMs);
    this.emit();
  }
  private setAnswer(read: Pick<WrittenResultRead, "action" | "result" | "capabilities" | "state_version">): void {
    this.answer = structuredClone({ action: read.action, result: read.result, capabilities: read.capabilities });
    this.answerVersion = read.state_version;
  }
  private resultPhase(grade: number): Phase { return this.previous ? "previous_result" : grade === 2 ? "result_wrong" : "result_correct"; }
  private acceptResult(read: Pick<WrittenResultRead, "action" | "result" | "capabilities" | "state_version">,
    kind: WrittenTransition["kind"]): void {
    if (!read.result) return;
    this.setAnswer(read);
    if (kind === "answer.submit") { this.draft = ""; this.previous = false; this.waitNext = false; }
    this.phase = this.resultPhase(read.result.grade);
    if (kind === "result.grade" && !this.previous) this.pendingGradeAdvance = `${read.result.result_id}:${read.result.version}`;
  }
  private consume(): boolean {
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
      // A refused start leaves no session of this owner: the reason stays visible and Today stays reachable.
      if (primary.resolved.kind === "session.start") { this.sessionId = null; this.current = null; this.phase = "idle"; return false; }
      if (primary.resolved.kind === "result.grade" && primary.answer?.result && primary.stateVersion) {
        this.setAnswer({ ...primary.answer, state_version: primary.stateVersion });
        this.phase = this.resultPhase(primary.answer.result.grade);
      } else this.phase = this.question && this.current?.status === "active" && this.current.assignment?.id === this.question.id
        && this.current.assignment.status === "presented" ? "question" : "stale";
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
  private run(action: () => Promise<void>): Promise<void> {
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
  /** Background is not Stop. Keep the draft and receipt, never present unseen work, and let the result wait. */
  suspend(): void {
    if (this.is("result_correct", "result_wrong", "changing_result")) { this.waitNext = true; this.pendingGradeAdvance = null; }
    this.active = false; this.activationGeneration++; this.cancelTimer(); this.emit();
  }
  /** Foreground callers must first supply a fresh open handle; route/config callers retain that boundary. */
  async resume(): Promise<void> {
    this.suspend();
    const generation = this.activationGeneration;
    await this.refresh();
    if (!this.live() || generation !== this.activationGeneration || !this.enabled()) return;
    this.active = true;
    await this.continueView(); this.emit();
  }
  private async continueView(): Promise<void> {
    if (!this.live() || !this.interactive()) return;
    if (this.is("loading") && this.question?.status === "prefetched") { await this.showQuestion(); return; }
    if (!this.is("result_correct", "result_wrong")) return;
    const result = this.answer?.result;
    if (result && this.pendingGradeAdvance === `${result.result_id}:${result.version}`) {
      if (this.snapshot().canNext) { this.pendingGradeAdvance = null; await this.next(); }
      return;
    }
    this.pendingGradeAdvance = null; this.armTimer();
  }
  async refresh(): Promise<void> {
    if (!this.live()) return;
    if (this.reading) {
      if (this.readingSource === this.options.access()
        && BigInt(this.readingMinimumVersion) >= BigInt(this.commands.snapshot().stateVersion)) return this.reading;
      if (!this.queuedRead) {
        // A newer handle or confirmed Settings version can invalidate this read: coalesce, then read again.
        const pending = this.reading;
        const queued = (async () => {
          await pending;
          while (this.live()) {
            const existing = this.reading;
            const source = existing ? this.readingSource : this.options.access();
            const minimum = existing ? this.readingMinimumVersion : this.commands.snapshot().stateVersion;
            if (existing) await existing;
            else await this.refresh();
            const floor = BigInt(this.commands.snapshot().stateVersion);
            if (source === this.options.access() && (BigInt(minimum) >= floor || BigInt(this.currentVersion ?? "0") >= floor)) break;
          }
        })().finally(() => { if (this.queuedRead === queued) this.queuedRead = null; });
        this.queuedRead = queued;
      }
      return this.queuedRead;
    }
    this.readingSource = this.options.access();
    this.readingMinimumVersion = this.commands.snapshot().stateVersion;
    this.cancelTimer(); this.problem = null;
    const task = (async () => {
      await this.commands.refresh(); if (!this.live() || this.is("closed")) return;
      const state = this.commands.snapshot(), pending = state.primary.pendingIntent;
      const resolved = state.primary.resolved;
      // A refused start created no session; any other resolved command addresses an existing one.
      const resolvedSession = resolved && !(resolved.kind === "session.start" && state.primary.outcome !== "accepted") ? resolved.sessionId : null;
      this.sessionId ??= pending?.session_id ?? resolvedSession ?? state.stop.pendingIntent?.session_id ?? null;
      if (this.sessionId === null) { this.phase = "idle"; return; }
      const read = await this.commands.readSession(this.sessionId);
      if (!this.live() || this.is("closed", "stopping") || this.commands.snapshot().stop.pending) return;
      this.capture(read.current, read.state_version);
      if (this.is("closed")) return;
      if (pending?.kind === "answer.submit") {
        this.draftAssignmentId = pending.assignment_id;
        this.draft = "text" in pending.payload ? pending.payload.text : "";
        this.question = this.current?.status === "active" && this.current.assignment?.id === pending.assignment_id
          ? structuredClone(this.current.assignment) : null;
        this.phase = "unknown"; return;
      }
      if (this.consume()) return;
      if (await this.recoverAcceptedResult()) return;
      if (this.commands.snapshot().primary.pending) {
        const assignment = this.current?.status === "active" ? this.current.assignment : null;
        if (pending?.kind === "assignment.present" && assignment?.id === pending.assignment_id) {
          this.setQuestion(assignment); this.phase = "visible_unconfirmed";
        } else this.phase = "unknown";
        return;
      }
      if (this.answer?.result) {
        await this.refreshAnswer();
        if (this.answer?.result && this.is("stale", "unknown", "changing_result")) this.phase = this.resultPhase(this.answer.result.grade);
      }
      if (!this.is("previous_result", "result_correct", "result_wrong", "closed")) this.chooseCurrent();
    })().catch(() => { if (this.live() && !this.is("closed", "stopping")) { this.phase = "stale"; this.problem = "load"; } })
      .finally(() => { if (this.reading === task) this.reading = null; this.emit(); });
    this.reading = task; await task;
    if (this.is("closed")) await this.readClosedSummary();
    await this.continueView();
  }
  private chooseCurrent(): void {
    if (!this.current) { this.phase = "stale"; return; }
    if (this.current.status === "closed") { this.close(this.current.session_id, this.current.close_reason); return; }
    if (this.current.status === "summary") { this.phase = "summary"; return; }
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
  /**
   * The summary of this owner's own Stop: an unknown answer is first resolved by its ID, then the latest
   * confirmed result of the closed session is read. Data only; it restores no right.
   */
  private readClosedSummary(): Promise<void> {
    const facts = this.closedFacts;
    if (!facts || facts.reason !== "stop" || facts.summaryRead === "known" || !this.live()) return Promise.resolve();
    if (this.summaryReading) return this.summaryReading;
    const task = (async () => {
      facts.summaryRead = "reading"; this.emit();
      let primary = this.commands.snapshot().primary;
      if (primary.pending && primary.outcome === null) { await this.commands.refresh(); primary = this.commands.snapshot().primary; }
      if (!this.live() || this.closedFacts !== facts) return;
      if (primary.pending && primary.outcome === null) { facts.summaryRead = "failed"; return; }
      const resolved = primary.outcome === "accepted" && primary.resolved?.assignmentId && primary.resolved.resultId
        && sameId(primary.resolved.sessionId, facts.sessionId) ? primary.resolved : null;
      const address = resolved ? { assignment_id: resolved.assignmentId!, result_id: resolved.resultId! }
        : this.answer?.result ? { assignment_id: this.answer.result.assignment_id, result_id: this.answer.result.result_id } : null;
      if (address === null) {
        // Without any confirmed answer the closed projection itself proves an empty summary (В06.3).
        const known = this.current && sameId(this.current.session_id, facts.sessionId) && this.current.progress.completed === 0;
        facts.summary = known ? { completed: 0, correct: 0, wrong: 0, ratio: null } : null;
        facts.summaryRead = known ? "known" : "failed"; return;
      }
      const read = await this.commands.readResult({ session_id: facts.sessionId, ...address });
      if (!this.live() || this.closedFacts !== facts) return;
      const step = read.step;
      if ("summary" in step && step.status === "closed" && step.summary && sameId(step.session_id, facts.sessionId)) {
        facts.summary = structuredClone(step.summary); facts.summaryRead = "known";
      } else facts.summaryRead = "failed";
    })().catch(() => { if (this.closedFacts === facts) facts.summaryRead = "failed"; })
      .finally(() => { if (this.summaryReading === task) this.summaryReading = null; this.emit(); });
    this.summaryReading = task;
    return task;
  }
  private async showQuestion(): Promise<void> {
    const current = this.current?.status === "active" ? this.current : null;
    if (!this.live() || !this.interactive() || !current?.assignment || !this.sessionId) return;
    this.cancelTimer(); this.previous = false; this.pendingGradeAdvance = null; this.waitNext = false;
    const assignment = current.assignment, state = this.commands.snapshot();
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
    const work = this.commands.begin({ kind: "assignment.present", session_id: this.sessionId, assignment_id: assignment.id, payload: {} });
    this.emit(); await work;
    if (!this.live() || this.is("closed", "stopping")) return;
    const after = this.commands.snapshot(); this.capture(after.primary.current, after.primary.stateVersion);
    const shown = this.current?.status === "active" ? this.current.assignment : null;
    if (after.primary.outcome === "accepted" && shown?.id === assignment.id && shown.status === "presented") {
      this.question = structuredClone(shown);
      if (!this.is("previous_result")) this.phase = "question";
      if (this.answer?.result) await this.refreshAnswer();
    } else if (!after.primary.pending) { this.phase = "stale"; this.problem = after.primary.rejectionCode ?? "presentation"; }
    this.emit();
  }
  setDraft(text: string): void {
    if (!this.snapshot().canEditDraft) return;
    this.draft = text; this.emit();
  }
  start(bucket: "words" | "phrases"): Promise<void> {
    if (bucket !== "words" && bucket !== "phrases") return Promise.reject(new Error("written bucket required"));
    if (!this.snapshot().canStart) return Promise.resolve();
    this.sessionId = this.options.newId(); this.current = null; this.currentVersion = null; this.summary = null; this.closedFacts = null;
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
  /** IME composition is filtered by the input component (study/WrittenAnswerInput), as in the other study modules. */
  submit(options: { forgot?: boolean } = {}): Promise<void> {
    const view = this.snapshot();
    if (!(options.forgot ? view.canForget : view.canSubmit) || !this.question || !this.sessionId) return Promise.resolve();
    // Capture the assignment and text now: exactly one command_id belongs to this intent.
    const action: WrittenTransition = { kind: "answer.submit", session_id: this.sessionId, assignment_id: this.question.id,
      payload: options.forgot ? { forgot: true } : { text: this.draft } };
    return this.run(async () => {
      this.cancelTimer(); this.phase = "submitting"; this.problem = null;
      await this.commands.begin(action); if (this.live()) this.consume();
    }).then(() => { if (this.live()) this.armTimer(); });
  }
  previousResult(): void {
    if (!this.snapshot().canPrevious) return;
    this.cancelTimer(); this.previous = true; this.pendingGradeAdvance = null; this.phase = "previous_result"; this.emit();
  }
  next(): Promise<void> {
    if (!this.snapshot().canNext) return Promise.resolve();
    this.cancelTimer(); this.pendingGradeAdvance = null;
    if (this.is("previous_result") && this.commands.snapshot().primary.pendingIntent?.kind === "assignment.present") {
      this.previous = false; this.phase = "visible_unconfirmed"; this.emit(); return Promise.resolve();
    }
    if (this.current?.status === "summary") { this.previous = false; this.phase = "summary"; this.emit(); return Promise.resolve(); }
    return this.run(() => this.showQuestion());
  }
  /** Change the saved grade of a correct answer; correction of an error waits for a server right (no written correct_target yet). */
  grade(grade: 3 | 4 | 5): Promise<void> {
    if (!this.snapshot().grades.includes(grade)) return Promise.resolve();
    const target = this.answer!.capabilities.grades!;
    const action: WrittenTransition = { kind: "result.grade", session_id: target.session_id, assignment_id: target.assignment_id,
      result_id: target.result_id, expected_result_version: target.expected_result_version, payload: { grade } };
    const previous = this.is("previous_result");
    return this.run(async () => {
      // A pending change stops the old timer: it can neither confirm 4 nor show the next card.
      this.cancelTimer(); this.previous = previous; this.phase = "changing_result"; this.problem = null;
      await this.commands.begin(action); if (this.live()) this.consume();
    }).then(async () => {
      if (!this.live() || this.commands.snapshot().primary.outcome !== "accepted") return;
      if (!previous) await this.continueView();
    });
  }
  retry(lane: "primary" | "stop" = "primary"): Promise<void> {
    if (lane === "stop") {
      if (!this.live() || !this.commands.snapshot().stop.canRetry) return this.stopping ?? Promise.resolve();
      return this.runStop(() => this.commands.retry("stop"));
    }
    if (!this.snapshot().canRetryPrimary) return Promise.resolve();
    return this.run(async () => {
      await this.commands.retry("primary"); if (this.live()) this.consume();
      if (this.is("visible_unconfirmed") && !this.commands.snapshot().primary.pending) await this.showQuestion();
    }).then(async () => { if (this.live()) await this.continueView(); });
  }
  stop(reason: "stop" | "summary_home" = "stop"): Promise<void> {
    const view = this.snapshot();
    if (!(reason === "stop" ? view.canStop : view.canSummaryHome) || !this.sessionId) return this.stopping ?? Promise.resolve();
    const sessionId = this.sessionId;
    return this.runStop(() => this.commands.begin({ kind: "session.stop", session_id: sessionId, payload: { reason } }), reason);
  }
  /** Stop and its exact retry never queue behind a stalled answer request. */
  private runStop(send: () => Promise<void>, reason?: "stop" | "summary_home"): Promise<void> {
    if (this.stopping) return this.stopping;
    // Exit discards unsent study input; recorded answers stay (К05-065).
    this.cancelTimer(); this.pendingGradeAdvance = null; this.draft = ""; this.draftAssignmentId = null; this.phase = "stopping";
    const sessionId = this.sessionId;
    const task = send().then(() => {
      if (!this.live() || !sessionId) return;
      const state = this.commands.snapshot().stop;
      const own = state.resolved?.kind === "session.stop" && sameId(state.resolved.sessionId, sessionId);
      if (own && state.outcome === "accepted") {
        this.close(sessionId, reason ?? (this.current?.status === "closed" ? this.current.close_reason : null));
        // The summary may first wait for an in-flight answer to settle; Stop itself is already confirmed.
        void this.readClosedSummary();
      } else if (own && state.outcome === "not_applied") this.close(sessionId, state.closedSession?.close_reason ?? null);
      else if (state.outcome === "rejected") { this.phase = "stale"; this.problem = state.rejectionCode ?? "stop_rejected"; }
    }).finally(() => { if (this.stopping === task) this.stopping = null; this.emit(); });
    this.stopping = task; this.emit(); return task;
  }
  dispose(): void {
    this.cancelTimer(); this.pendingGradeAdvance = null; this.disposed = true; this.commands.dispose(); this.question = null; this.answer = null;
    this.draft = ""; this.draftAssignmentId = null;
  }
}
