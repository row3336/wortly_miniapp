import type { LearningSessionProjection, PublicAssignment } from "../api/generated";
import type { LearningCommandSnapshot, LearningTransition } from "./learningCommandController";
import { LearningDocumentCommands, type LearningDocumentSnapshot } from "./learningDocumentCommands";
import type { LearningResultRead } from "./learningAnswerApi";
import { sameId } from "../api/wireValidation";

type Phase = "loading" | "idle" | "preview" | "question" | "visible_unconfirmed" | "submitting" | "unknown"
  | "result_correct" | "result_wrong" | "changing_result" | "previous_result" | "summary" | "stopping" | "closed" | "stale" | "disposed";
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
  phase: Phase;
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
  canStop: boolean;
  canAdvancePreview: boolean;
  canRetryPrimary: boolean;
};

/** Presentation is local; only document commands can establish a saved answer or presentation. */
export class LearningViewController {
  private readonly commands: LearningDocumentCommands;
  private readonly pair: string;
  private sessionId: string | null;
  private phase: Phase = "loading";
  private current: LearningSessionProjection | null = null;
  private currentVersion: string | null = null;
  private question: PublicAssignment | null = null;
  private draft = "";
  private draftAssignmentId: string | null = null;
  private answer: Answer | null = null;
  private answerVersion: string | null = null;
  private problem: string | null = null;
  private lastResolved: string | null = null;
  private previous = false;
  private generation = 0;
  private timer: LearningViewSnapshot["timer"] = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private operation: Promise<void> | null = null;
  private reading: Promise<void> | null = null;
  private readingSource: ReturnType<Options["access"]> | null = null;
  private readingMinimumVersion = "0";
  private queuedRead: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private disposed = false;
  private active = true;
  private activationGeneration = 0;
  private pendingGradeAdvance: string | null = null;

  constructor(private readonly options: Options) {
    this.sessionId = options.sessionId;
    this.pair = `${options.access().profile.dictionary_language}-de`;
    this.commands = new LearningDocumentCommands({ ...options, onUpdate: state => this.observe(state) });
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
  private close(): void {
    this.cancelTimer(); this.phase = "closed"; this.question = null; this.draft = ""; this.draftAssignmentId = null;
    this.answer = null; this.answerVersion = null; this.pendingGradeAdvance = null;
  }
  private setQuestion(assignment: PublicAssignment): void {
    // A temporary unavailable projection hides the question, but does not reassign its local input.
    if (!sameId(this.draftAssignmentId ?? "", assignment.id)) this.draft = "";
    this.draftAssignmentId = assignment.id; this.question = structuredClone(assignment);
  }
  private capture(step: LearningCommandSnapshot["current"], version: string | null): void {
    if (!step || !version || BigInt(version) < BigInt(this.commands.snapshot().stateVersion)) return;
    if (!("pair" in step)) {
      if ("session_id" in step && this.sessionId && !sameId(step.session_id, this.sessionId)) return;
      this.current = null; this.currentVersion = version; this.question = null; this.cancelTimer(); this.phase = "stale"; return;
    }
    if (step.pair !== this.pair) return;
    if (this.sessionId !== null && !sameId(step.session_id, this.sessionId)) return;
    this.sessionId = step.session_id; this.current = structuredClone(step); this.currentVersion = version;
    if (step.status === "closed") this.close();
  }
  private observe(state: LearningDocumentSnapshot): void {
    if (this.disposed || !state.live) return;
    this.capture(state.primary.current, state.primary.stateVersion);
    this.capture(state.stop.current, state.stop.stateVersion);
    const closed = state.stop.outcome === "accepted" && state.stop.resolved?.kind === "session.stop"
      ? state.stop.resolved.sessionId : state.primary.closedSession?.session_id ?? state.stop.closedSession?.session_id;
    if (closed && this.sessionId && sameId(closed, this.sessionId)) this.close();
    else if (!this.is("closed")) {
      if (!state.canBegin) this.cancelTimer();
      if (state.stop.pending && state.stop.outcome === null) this.phase = "stopping";
      else if (this.is("stopping") && state.stop.outcome === "rejected") {
        this.phase = "stale"; this.problem = state.stop.rejectionCode ?? "stop_rejected";
      }
      else if (state.primary.pending && state.primary.outcome === null) {
        const kind = state.primary.kind;
        if (kind === "assignment.present") {
          if (!this.is("previous_result")) this.phase = this.question ? "visible_unconfirmed" : "unknown";
        } else if (kind === "answer.submit") this.phase = state.primary.phase === "sending" ? "submitting" : "unknown";
        else if (kind === "result.grade" || kind === "result.correct") {
          this.phase = state.primary.phase === "sending" ? "changing_result" : "unknown";
        } else this.phase = "unknown";
      }
    }
    this.emit();
  }
  snapshot(): LearningViewSnapshot {
    const commands = this.commands.snapshot(), live = !this.disposed && commands.live;
    const fresh = this.currentVersion !== null && BigInt(this.currentVersion) >= BigInt(commands.stateVersion);
    const answerFresh = this.answerVersion !== null && BigInt(this.answerVersion) >= BigInt(commands.stateVersion);
    const interactive = this.interactive();
    const ready = live && interactive && commands.canBegin && !this.operation && !this.reading && !this.stopping && fresh;
    const activeQuestion = this.phase === "question" && this.question?.status === "presented";
    const resultView = ["result_correct", "result_wrong", "previous_result"].includes(this.phase);
    const canRevise = ready && answerFresh && resultView;
    const pending = commands.primary.pendingIntent;
    const pendingPresent = pending?.kind === "assignment.present" && this.question !== null
      && sameId(pending.assignment_id, this.question.id) && sameId(pending.session_id, this.sessionId ?? "");
    const visibleQuestion = this.is("question", "visible_unconfirmed", "submitting") || this.is("unknown") && pending?.kind === "answer.submit";
    return { phase: live ? this.phase : "disposed", sessionId: this.sessionId,
      current: live && fresh ? structuredClone(this.current) : null,
      question: live && visibleQuestion ? structuredClone(this.question) : null, draft: live ? this.draft : "",
      answer: live ? structuredClone(this.answer) : null,
      submittedText: live && pending?.kind === "answer.submit" && "text" in pending.payload ? pending.payload.text : null,
      problem: this.problem ?? commands.primary.rejectionCode ?? commands.primary.problem ?? commands.stop.rejectionCode ?? commands.stop.problem,
      commands, timer: live && ready ? this.timer && { ...this.timer } : null,
      canSubmit: ready && activeQuestion && this.draft.trim().length > 0,
      canEditDraft: live && interactive && !this.reading && this.is("question", "visible_unconfirmed") && !!this.question,
      canForget: ready && activeQuestion,
      canNext: live && interactive && !this.reading && fresh && (ready && resultView || this.is("previous_result") && pendingPresent),
      canPrevious: live && interactive && !this.reading && !!this.answer?.result && ["question", "visible_unconfirmed"].includes(this.phase),
      canCorrect: canRevise && this.answer?.capabilities.correct_target !== null && !!this.answer?.capabilities.correct_target,
      grades: canRevise ? [...this.answer?.capabilities.grades?.values ?? []] : [],
      canAdvancePreview: ready && this.phase === "preview" && !!this.current?.preview,
      canRetryPrimary: live && interactive && !this.operation && !this.reading && !this.stopping
        && commands.primary.canRetry && !commands.stop.pending,
      canStop: live && commands.canStop && this.sessionId !== null && !["closed", "idle"].includes(this.phase) };
  }
  private armTimer(): void {
    this.cancelTimer();
    if (!["result_correct", "result_wrong"].includes(this.phase) || !this.answer?.result || !this.snapshot().canNext) return;
    const mode = this.options.transitionMode();
    if (mode === null) return;
    if (mode === "normal" && this.answer.result.grade === 2) return;
    const durationMs = mode === "accelerated" ? 2000 : 3000;
    const generation = this.generation;
    const key = `${this.sessionId}:${this.answer.result.result_id}:${this.answer.result.version}:${generation}`;
    this.timer = { key, durationMs };
    this.timerHandle = setTimeout(() => {
      if (!this.live() || generation !== this.generation || this.timer?.key !== key || !this.snapshot().canNext) return;
      this.timerHandle = null; this.timer = null;
      void this.next();
    }, durationMs);
    this.emit();
  }
  private setAnswer(read: Pick<LearningResultRead, "action" | "result" | "capabilities" | "state_version">): void {
    this.answer = structuredClone({ action: read.action, result: read.result, capabilities: read.capabilities });
    this.answerVersion = read.state_version;
  }
  private acceptResult(read: Pick<LearningResultRead, "action" | "result" | "capabilities" | "state_version">,
    kind: LearningTransition["kind"]): void {
    if (!read.result) return;
    this.setAnswer(read);
    if (kind === "answer.submit") { this.draft = ""; this.previous = false; }
    this.phase = this.previous ? "previous_result" : read.result.grade === 2 ? "result_wrong" : "result_correct";
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
      const revision = primary.resolved.kind === "result.correct" || primary.resolved.kind === "result.grade";
      if (revision && primary.answer?.result && primary.stateVersion) {
        this.setAnswer({ ...primary.answer, state_version: primary.stateVersion });
        this.phase = this.previous ? "previous_result" : primary.answer.result.grade === 2 ? "result_wrong" : "result_correct";
      } else this.phase = this.question && this.current?.assignment?.id === this.question.id && this.current.assignment.status === "presented" ? "question" : "stale";
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
      if (this.live() && !this.is("closed") && !this.is("stopping")) { this.problem = "load"; this.phase = "stale"; }
    }).finally(() => {
      if (this.operation === task) this.operation = null;
      this.emit();
    });
    this.operation = task;
    return task;
  }
  /** Background is not Stop. Keep the draft and receipt, but never present unseen work. */
  suspend(): void {
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
        // A newer handle or confirmed Settings version can invalidate this read.
        // Coalesce callers, then read against the latest access and version floor.
        const pending = this.reading;
        const queued = (async () => {
          await pending;
          while (this.live()) {
            // A subscriber can already have started a read while the old task
            // was publishing. Await that read directly, never our own queue.
            const existing = this.reading;
            const source = existing ? this.readingSource : this.options.access();
            const minimum = existing ? this.readingMinimumVersion : this.commands.snapshot().stateVersion;
            if (existing) await existing;
            else await this.refresh();
            const floor = BigInt(this.commands.snapshot().stateVersion);
            if (source === this.options.access()
              && (BigInt(minimum) >= floor || BigInt(this.currentVersion ?? "0") >= floor)) break;
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
      this.sessionId ??= pending?.session_id ?? state.primary.resolved?.sessionId ?? null;
      if (this.sessionId === null) { this.phase = "idle"; return; }
      const read = await this.commands.readSession(this.sessionId);
      if (!this.live() || this.is("closed", "stopping") || this.commands.snapshot().stop.pending) return;
      this.capture(read.current, read.state_version);
      if (this.is("closed")) return;
      if (pending?.kind === "answer.submit") {
        this.draftAssignmentId = pending.assignment_id;
        this.draft = "text" in pending.payload ? pending.payload.text : "";
        this.question = this.current?.assignment?.id === pending.assignment_id ? structuredClone(this.current.assignment) : null;
        this.phase = "unknown"; return;
      }
      if (this.consume()) return;
      if (await this.recoverAcceptedResult()) return;
      if (this.commands.snapshot().primary.pending) {
        if (pending?.kind === "assignment.present" && this.current?.assignment?.id === pending.assignment_id) {
          this.setQuestion(this.current.assignment); this.phase = "visible_unconfirmed";
        } else this.phase = "unknown";
        return;
      }
      if (this.answer?.result) {
        await this.refreshAnswer();
        if (this.answer?.result && this.is("stale", "unknown", "changing_result")) {
          this.phase = this.previous ? "previous_result" : this.answer.result.grade === 2 ? "result_wrong" : "result_correct";
        }
      }
      if (!["previous_result", "result_correct", "result_wrong"].includes(this.phase)) this.chooseCurrent();
    })().catch(() => { if (this.live() && !this.is("closed", "stopping")) { this.phase = "stale"; this.problem = "load"; } })
      .finally(() => { if (this.reading === task) this.reading = null; this.emit(); });
    this.reading = task; await task;
    await this.continueView();
  }
  private chooseCurrent(): void {
    if (!this.current) { this.phase = "stale"; return; }
    if (this.current.status === "closed") { this.close(); return; }
    if (this.current.status === "summary") { this.phase = "summary"; return; }
    if (this.current.preview) { this.phase = "preview"; return; }
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
  private async showQuestion(): Promise<void> {
    if (!this.live() || !this.interactive() || !this.current?.assignment || !this.sessionId) return;
    this.cancelTimer(); this.previous = false; this.pendingGradeAdvance = null;
    const assignment = this.current.assignment, state = this.commands.snapshot();
    const pending = state.primary.pendingIntent;
    const ownPresent = pending?.kind === "assignment.present" && sameId(pending.assignment_id, assignment.id);
    if (!state.canBegin && !ownPresent) return;
    this.setQuestion(assignment);
    if (assignment.status === "presented" && !ownPresent) {
      this.phase = "question"; if (this.answer?.result) await this.refreshAnswer(); this.emit(); return;
    }
    this.phase = "visible_unconfirmed";
    if (ownPresent) { this.emit(); return; }
    const command: LearningTransition = { kind: "assignment.present", session_id: this.sessionId, assignment_id: assignment.id, payload: {} };
    const work = this.commands.begin(command); this.emit(); await work;
    if (!this.live() || this.is("closed") || this.is("stopping")) return;
    const after = this.commands.snapshot(); this.capture(after.primary.current, after.primary.stateVersion);
    if (after.primary.outcome === "accepted" && this.current?.assignment?.id === assignment.id && this.current.assignment.status === "presented") {
      this.question = structuredClone(this.current.assignment);
      if (!this.is("previous_result")) this.phase = "question";
      if (this.answer?.result) await this.refreshAnswer();
    } else if (!after.primary.pending) { this.phase = "stale"; this.problem = after.primary.rejectionCode ?? "presentation"; }
    this.emit();
  }
  setDraft(text: string): void {
    if (!this.snapshot().canEditDraft) return;
    this.draft = text; this.emit();
  }
  start(): Promise<void> {
    if (!this.live() || !this.interactive() || !this.commands.snapshot().canBegin || !this.is("idle", "closed")) return Promise.resolve();
    this.sessionId = this.options.newId(); this.current = null; this.currentVersion = null;
    this.question = null; this.answer = null; this.answerVersion = null; this.draft = ""; this.draftAssignmentId = null; this.previous = false; this.pendingGradeAdvance = null;
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
  submit(options: { forgot?: boolean; composing?: boolean } = {}): Promise<void> {
    const view = this.snapshot();
    if (options.composing || !(options.forgot ? view.canForget : view.canSubmit) || !this.question || !this.sessionId) return Promise.resolve();
    const action: LearningTransition = { kind: "answer.submit", session_id: this.sessionId, assignment_id: this.question.id,
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
  grade(grade: 3 | 4 | 5): Promise<void> { return this.revise(grade); }
  correct(): Promise<void> { return this.revise(null); }
  private revise(grade: 3 | 4 | 5 | null): Promise<void> {
    const view = this.snapshot();
    if (grade === null ? !view.canCorrect : !view.grades.includes(grade)) return Promise.resolve();
    const target = grade === null ? this.answer!.capabilities.correct_target! : this.answer!.capabilities.grades!;
    const address = { session_id: target.session_id, assignment_id: target.assignment_id,
      result_id: target.result_id, expected_result_version: target.expected_result_version };
    const action: LearningTransition = grade === null ? { kind: "result.correct", ...address, payload: {} }
      : { kind: "result.grade", ...address, payload: { grade } };
    const previous = this.is("previous_result");
    return this.run(async () => {
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
    if (lane === "primary" && !this.snapshot().canRetryPrimary) return Promise.resolve();
    return this.run(async () => {
      await this.commands.retry(lane); if (this.live()) this.consume();
      if (this.phase === "visible_unconfirmed" && !this.commands.snapshot().primary.pending) await this.showQuestion();
    }).then(async () => {
      if (!this.live()) return;
      await this.continueView();
    });
  }
  stop(reason: "stop" | "summary_home" = "stop"): Promise<void> {
    if (!this.snapshot().canStop || !this.sessionId) return this.stopping ?? Promise.resolve();
    const sessionId = this.sessionId;
    return this.runStop(() => this.commands.begin({ kind: "session.stop", session_id: sessionId, payload: { reason } }));
  }
  /** Stop and its exact retry must never queue behind a stalled answer request. */
  private runStop(send: () => Promise<void>): Promise<void> {
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
  dispose(): void {
    this.cancelTimer(); this.pendingGradeAdvance = null; this.disposed = true; this.commands.dispose(); this.question = null; this.answer = null;
    this.draft = ""; this.draftAssignmentId = null;
  }
}
