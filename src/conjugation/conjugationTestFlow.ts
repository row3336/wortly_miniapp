import type { ConjugationSummary, WrittenResult } from "../api/generated";
import { sameId } from "../api/wireValidation";
import type { OpenedAccess } from "../app/openedAccess";
import type { CloseReason, ConjugationDocumentActions, ConjugationDocumentSnapshot, ConjugationLane,
  ConjugationPresentationTicket, ConjugationStepTicket } from "./conjugationDocumentController";
import { conjugationQuestion, type ConjugationQuestion } from "./conjugationQuestion";

export type FlowSource = Readonly<{ tuple: string; access: OpenedAccess }>;
export type FlowInput = Readonly<{ source: FlowSource; state: ConjugationDocumentSnapshot | null;
  transitionMode: "normal" | "accelerated" | null; active: boolean }>;
export type FlowOptions = Readonly<{
  actions: ConjugationDocumentActions;
  schedule(delayMs: 2000 | 3000, run: () => void): () => void;
  /** D1 is open: the host must choose; there is deliberately no default. */
  timerResume: "rearm" | "none";
  onToday(): void;
  /** Synchronously, once, at the end of an intent that changed memory visible in `project` without a controller action
   * (an accepted, different draft). Never from constructor, project, commit, dispose, or after dispose. */
  onChange(): void;
}>;
type Common = { canStop: boolean; stopping: boolean; problem: string | null; canRetry: Record<ConjugationLane, boolean> };
export type ConjugationView = Common & (
  | { screen: "loading" } | { screen: "recovery" } | { screen: "stale" }
  | { screen: "question"; question: ConjugationQuestion; draft: string; editable: boolean; canSubmit: boolean; canForget: boolean;
      status: "presenting" | "submitting" | "unknown" | null; pendingForgot: boolean; canPrevious: boolean;
      presentationTicket: ConjugationPresentationTicket | null }
  | { screen: "result"; result: WrittenResult; mode: "answer" | "previous"; grades: readonly (3 | 4 | 5)[];
      canCorrect: boolean; pending: "changing" | "unknown" | null; barrier: boolean; canNext: boolean;
      timer: { key: string; durationMs: 2000 | 3000 } | null }
  | { screen: "summary"; summary: ConjugationSummary; canHome: boolean }
  | { screen: "closed"; reason: CloseReason | null; summary: ConjugationSummary | null });

/** Flow memory of one identity (tuple, sessionId). Replaced copy-on-write, so `project` can derive it without writing. */
type Memory = Readonly<{
  key: string;
  draft: Readonly<{ assignmentId: string; text: string }> | null;
  question: ConjugationQuestion | null;
  lastResult: WrittenResult | null;
  lastDisplay: "step" | "result" | null;
  resultMode: Readonly<{ resultId: string; mode: "answer" | "previous" }> | null;
  seenAnswers: readonly string[];
  terminal: boolean;
  /** Bookkeeping of a terminal session; not part of the memory that terminal erases. */
  homeRequested: boolean;
  todayDone: boolean;
}>;
type Timer = { key: string; resultKey: string; durationMs: 2000 | 3000; ticket: ConjugationStepTicket; cancel: () => void };
/** Row 11 holds; `durationMs` is what a new arming would use now (null = this mode never arms). */
type Eligible = { resultKey: string; durationMs: 2000 | 3000 | null; ticket: ConjugationStepTicket };

const busy = ["checking", "sending"];
const noRetry = (): Record<ConjugationLane, boolean> => ({ study: false, stop: false });
const loading = (): ConjugationView => ({ screen: "loading", canStop: false, stopping: false, problem: null, canRetry: noRetry() });

/** `state:null`, `phase:"disposed"` and host gap are a mask, not an identity (DESIGN_V3 §3.2). */
function unmasked(state: ConjugationDocumentSnapshot | null): ConjugationDocumentSnapshot | null {
  return state !== null && state.phase !== "disposed" ? state : null;
}
function identityKey(input: FlowInput, state: ConjugationDocumentSnapshot): string {
  return JSON.stringify([input.source.tuple, state.sessionId?.toLowerCase() ?? null]);
}
function freshMemory(key: string): Memory {
  return { key, draft: null, question: null, lastResult: null, lastDisplay: null, resultMode: null,
    seenAnswers: [], terminal: false, homeRequested: false, todayDone: false };
}
function terminalOf(state: ConjugationDocumentSnapshot): boolean {
  const id = state.sessionId;
  return id !== null && (state.terminalSessionIds.some(item => sameId(item, id)) || !!state.closed && sameId(state.closed.sessionId, id));
}
function stepAssignment(state: ConjugationDocumentSnapshot) {
  const step = state.currentStep?.step;
  return step?.status === "active" ? step.assignment : null;
}
/** A's result; the type admits null, which is treated as no A. */
function resultOf(state: ConjugationDocumentSnapshot): WrittenResult | null {
  return state.resultA?.result ?? null;
}
function pendingAnswer(state: ConjugationDocumentSnapshot) {
  const study = state.commands.study, intent = study.pendingIntent;
  return study.pending && study.outcome === null && intent?.kind === "answer.submit" ? intent : null;
}

/** Pure: the memory this input implies for its identity. Never calls actions or mutates `memory`. */
function reconcile(memory: Memory, input: FlowInput, state: ConjugationDocumentSnapshot): Memory {
  const key = identityKey(input, state);
  let next: Memory = memory.key === key ? memory : freshMemory(key);
  if (terminalOf(state)) {
    return next.terminal ? next : { ...next, terminal: true, draft: null, question: null, lastResult: null, lastDisplay: null, resultMode: null };
  }
  const study = state.commands.study, resolved = study.resolved;
  // A new accepted answer opens its A in "answer" mode once; the draft of that assignment is consumed.
  if (study.outcome === "accepted" && resolved?.kind === "answer.submit" && resolved.resultId
    && !next.seenAnswers.includes(resolved.commandId)) {
    const assignmentId = resolved.assignmentId ?? null;
    next = { ...next, seenAnswers: [...next.seenAnswers, resolved.commandId], lastDisplay: "result",
      resultMode: { resultId: resolved.resultId.toLowerCase(), mode: "answer" },
      draft: next.draft && assignmentId && sameId(next.draft.assignmentId, assignmentId) ? null : next.draft };
  }
  if (next.draft && state.acceptedAddress && sameId(state.acceptedAddress.assignment_id, next.draft.assignmentId)) next = { ...next, draft: null };
  // A fresh step without this B (replaced, summary) drops its draft; an absent step (refresh, stale) keeps it.
  const assignment = stepAssignment(state);
  if (next.draft && state.currentStep && !(assignment && sameId(assignment.id, next.draft.assignmentId))) next = { ...next, draft: null };
  if (state.display.kind === "step" && assignment && !(next.question && sameId(next.question.assignmentId, assignment.id))) {
    next = { ...next, question: conjugationQuestion(assignment) };
  }
  if (state.display.kind === "step" && next.lastDisplay !== "step") next = { ...next, lastDisplay: "step" };
  if (state.display.kind === "result" && next.lastDisplay !== "result") next = { ...next, lastDisplay: "result" };
  const result = resultOf(state);
  if (result && next.lastResult !== result && !(next.lastResult && next.lastResult.result_id === result.result_id
    && next.lastResult.version === result.version)) next = { ...next, lastResult: structuredClone(result) };
  return next;
}

/** Deep Module of the conjugation test (М16/М17 rows of DESIGN_V3 §4/§5) without React.
 * Rights come only from the last committed Snapshot; memory (draft, last question, mode, timer) only from identity. */
export class ConjugationTestFlow {
  private readonly options: FlowOptions;
  private memory: Memory = freshMemory("");
  private input: FlowInput | null = null;
  private generation = 0;
  private timer: Timer | null = null;
  /** Timer history per `session:result:version` of the current identity. */
  private timerHistory = new Map<string, "interrupted" | "done">();
  private readonly shownTickets = new WeakSet<ConjugationPresentationTicket>();
  private readonly autoTickets = new WeakSet<ConjugationStepTicket>();
  private autoResult: string | null = null;
  private gradeRequest: { resultId: string; version: string; grade: 3 | 4 | 5 } | null = null;
  private enterDown = false;
  private disposed = false;

  constructor(options: FlowOptions) {
    if (options.timerResume !== "rearm" && options.timerResume !== "none") throw new Error("conjugation flow requires timerResume");
    if (typeof options.onChange !== "function") throw new Error("conjugation flow requires onChange");
    this.options = { ...options };
  }

  /** Pure during render: a foreign identity's memory is masked, never changed. */
  project(input: FlowInput): ConjugationView {
    const state = unmasked(input.state);
    if (this.disposed || !state) return loading();
    const memory = reconcile(this.memory, input, state);
    const generation = this.generation + (this.accessChanged(input) || memory.key !== this.memory.key ? 1 : 0);
    return this.viewOf(memory, input, state, generation, this.memory.key === memory.key ? this.timerHistory : new Map());
  }

  /** Layout effect: identity change, timer, automatic local transitions and the one onToday. */
  commit(input: FlowInput): void {
    if (this.disposed) return;
    const state = unmasked(input.state);
    const accessChanged = this.accessChanged(input);
    if (!state) {
      this.interrupt(); this.input = input;
      if (accessChanged) this.generation++;
      return;
    }
    const memory = reconcile(this.memory, input, state);
    if (memory.key !== this.memory.key) {
      this.cancelTimer(); this.timerHistory = new Map(); this.autoResult = null; this.gradeRequest = null;
      this.generation++;
    } else if (accessChanged) { this.interrupt(); this.generation++; }
    this.memory = memory; this.input = input;
    if (memory.terminal) { this.cancelTimer(); this.gradeRequest = null; }
    this.runTimer(memory, input, state);
    this.automate(memory, input, state);
  }

  setDraft(text: string): void {
    const state = this.state();
    if (!state || typeof text !== "string") return;
    const view = this.view(state);
    // A refused or unchanged text changes nothing and notifies nobody.
    if (view.screen !== "question" || !view.editable || view.draft === text) return;
    this.memory = { ...this.memory, draft: { assignmentId: view.question.assignmentId, text } };
    this.options.onChange();
  }
  submit(): void {
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    // Verbatim: the server checks the text; only an empty field is not an answer.
    if (view.screen === "question" && view.canSubmit) void this.options.actions.submit({ text: view.draft });
  }
  forget(): void {
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    if (view.screen === "question" && view.canForget) void this.options.actions.submit({ forgot: true });
  }
  grade(value: 3 | 4 | 5): void {
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    if (view.screen !== "result" || !view.grades.includes(value)) return;
    this.cancelTimer(true);
    this.gradeRequest = { resultId: view.result.result_id.toLowerCase(), version: view.result.version, grade: value };
    void this.options.actions.grade(value);
  }
  correct(): void {
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    if (view.screen !== "result" || !view.canCorrect) return;
    this.cancelTimer(true); this.gradeRequest = null;
    void this.options.actions.correct();
  }
  next(): void {
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    if (view.screen !== "result" || !view.canNext || !state.stepTicket) return;
    this.cancelTimer(true);
    this.options.actions.openStep(state.stepTicket);
  }
  previous(): void {
    const state = this.active(), result = state && resultOf(state);
    if (!state || !result) return;
    const view = this.view(state);
    if (view.screen !== "question" || !view.canPrevious) return;
    this.cancelTimer(true);
    const resultId = result.result_id.toLowerCase();
    this.memory = { ...this.memory, resultMode: { resultId, mode: "previous" } };
    this.options.actions.openResult();
  }
  /** Renderer: after the visible commit of the question that carries this ticket. */
  committed(ticket: ConjugationPresentationTicket): void {
    const state = this.active();
    if (!state || !ticket || ticket !== state.presentationTicket || this.shownTickets.has(ticket)) return;
    const view = this.view(state);
    if (view.screen !== "question" || view.presentationTicket !== ticket) return;
    this.shownTickets.add(ticket);
    void this.options.actions.shown(ticket);
  }
  enter(key: { repeat: boolean; composing: boolean }): void {
    const held = this.enterDown;
    this.enterDown = true;
    if (key.repeat || key.composing || held) return;
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    if (view.screen === "result" && view.mode === "answer" && view.result.correct && !view.barrier && view.pending === null) this.next();
  }
  enterReleased(): void { this.enterDown = false; }
  stop(): void {
    const state = this.active();
    if (state?.canStop) void this.options.actions.stop("stop");
  }
  home(): void {
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    if (view.screen !== "summary" || !view.canHome) return;
    this.memory = { ...this.memory, homeRequested: true };
    void this.options.actions.stop("summary_home");
  }
  today(): void {
    const state = this.state();
    if (!state || this.view(state).screen !== "closed" || this.memory.todayDone) return;
    this.memory = { ...this.memory, todayDone: true };
    this.options.onToday();
  }
  retry(lane: ConjugationLane): void {
    const state = this.active();
    if (state && (lane === "study" || lane === "stop") && state.canRetry[lane]) void this.options.actions.retry(lane);
  }
  /** Manual GET only: stale, or a confirmed closed session whose frozen summary is still unknown (T2 C2). */
  refresh(): void {
    const state = this.active();
    if (!state) return;
    const view = this.view(state);
    if (view.screen === "stale" || view.screen === "closed" && view.summary === null) void this.options.actions.refresh();
  }
  dispose(): void {
    this.cancelTimer(); this.disposed = true; this.input = null;
  }

  private accessChanged(input: FlowInput): boolean {
    return !!this.input && this.input.source.access !== input.source.access && this.input.source.tuple === input.source.tuple;
  }
  private state(): ConjugationDocumentSnapshot | null {
    return this.disposed ? null : unmasked(this.input?.state ?? null);
  }
  private active(): ConjugationDocumentSnapshot | null {
    return this.input?.active ? this.state() : null;
  }
  private view(state: ConjugationDocumentSnapshot): ConjugationView {
    return this.viewOf(this.memory, this.input!, state, this.generation, this.timerHistory);
  }

  private viewOf(memory: Memory, input: FlowInput, state: ConjugationDocumentSnapshot, generation: number,
    history: ReadonlyMap<string, "interrupted" | "done">): ConjugationView {
    const active = input.active;
    const common: Common = { canStop: active && state.canStop, stopping: state.phase === "stopping", problem: state.problem,
      canRetry: { study: active && state.canRetry.study, stop: active && state.canRetry.stop } };
    if (memory.terminal || state.phase === "closed") {
      return { ...common, screen: "closed", reason: state.closed?.reason ?? null,
        summary: state.closed?.summary ? structuredClone(state.closed.summary) : null };
    }
    if (state.phase === "loading" || state.phase === "idle") return { ...common, screen: "loading" };
    if (state.phase === "stale") return { ...common, screen: "stale" };
    if (state.phase === "unknown") {
      // Row 10: the last question of the same assignment with the exact pending text, read-only.
      const answer = pendingAnswer(state);
      if (answer && memory.question && sameId(memory.question.assignmentId, answer.assignment_id)) {
        const payload = answer.payload;
        return { ...common, screen: "question", question: memory.question, draft: "text" in payload ? payload.text : "",
          editable: false, canSubmit: false, canForget: false, status: "unknown", pendingForgot: "forgot" in payload, canPrevious: false, presentationTicket: null };
      }
      const study = state.commands.study, revision = study.pendingIntent;
      if (study.pending && study.outcome === null && (revision?.kind === "result.grade" || revision?.kind === "result.correct")
        && memory.lastResult && sameId(memory.lastResult.result_id, revision.result_id)) {
        return { ...common, screen: "result", result: memory.lastResult, mode: "previous", grades: [], canCorrect: false,
          pending: "unknown", barrier: false, canNext: false, timer: null };
      }
      return { ...common, screen: "recovery" };
    }
    const display = state.display, study = state.commands.study;
    const presenting = state.phase === "visible_unconfirmed";
    if (display.kind === "step") {
      const assignment = stepAssignment(state);
      const question = memory.question && assignment && sameId(memory.question.assignmentId, assignment.id) ? memory.question : null;
      if (!question) return { ...common, screen: "loading" };
      const submitting = study.kind === "answer.submit" && busy.includes(study.phase);
      // The answer right; "I forgot" needs nothing else, a text answer also a non-blank draft (sent verbatim).
      const canForget = active && state.canSubmit;
      const draft = memory.draft && sameId(memory.draft.assignmentId, question.assignmentId) ? memory.draft.text : "";
      // Typing is local memory: open while B is being presented, closed whenever rights or activity are.
      const editable = active && !submitting && !common.stopping && (canForget || presenting || state.phase === "prefetched");
      return { ...common, screen: "question", question, draft,
        editable, canSubmit: canForget && draft.trim() !== "", canForget, status: presenting ? "presenting" : submitting ? "submitting" : null, pendingForgot: false,
        canPrevious: active && !common.stopping && !submitting && resultOf(state) !== null,
        presentationTicket: active ? state.presentationTicket : null };
    }
    const shownResult = resultOf(state);
    if (display.kind === "result" && shownResult) {
      const result = shownResult;
      const mode = presenting ? "previous"
        : memory.resultMode && sameId(memory.resultMode.resultId, result.result_id) ? memory.resultMode.mode : "previous";
      const pending = (study.kind === "result.grade" || study.kind === "result.correct") && study.pending
        ? busy.includes(study.phase) ? "changing" as const : "unknown" as const : null;
      const canNext = active && state.stepTicket !== null && pending === null;
      const eligible = this.eligible(input, state, mode, pending, canNext);
      const generationKey = eligible ? `${eligible.resultKey}:${generation}` : null;
      // An armed timer shows its armed duration; a settings change after arming neither re-arms nor redraws it.
      const armed = this.timer && this.timer.key === generationKey ? this.timer : null;
      const timer = armed ? { key: armed.key, durationMs: armed.durationMs }
        : eligible && eligible.durationMs !== null && this.mayArm(eligible.resultKey, history)
          ? { key: generationKey!, durationMs: eligible.durationMs } : null;
      return { ...common, screen: "result", result, mode, grades: active ? [...state.allowedGrades] : [],
        canCorrect: active && state.canCorrect, pending, barrier: presenting, canNext, timer };
    }
    if (display.kind === "summary" && state.currentStep?.step.summary) {
      return { ...common, screen: "summary", summary: structuredClone(state.currentStep.step.summary), canHome: active && state.canSummaryHome };
    }
    return { ...common, screen: state.problem ? "stale" : "loading" };
  }

  /** Row 11 (§5): the only state in which the transition timer may run. */
  private eligible(input: FlowInput, state: ConjugationDocumentSnapshot, mode: "answer" | "previous",
    pending: "changing" | "unknown" | null, canNext: boolean, ignoreActive = false): Eligible | null {
    const result = resultOf(state), ticket = state.stepTicket;
    if (!result || !ticket || mode !== "answer" || pending !== null || state.phase !== "result") return null;
    if (!ignoreActive && (!input.active || !canNext)) return null;
    const correct = result.correct;
    const durationMs = input.transitionMode === "accelerated" ? 2000 : input.transitionMode === "normal" && correct ? 3000 : null;
    return { resultKey: `${state.sessionId}:${result.result_id.toLowerCase()}:${result.version}`, durationMs, ticket };
  }
  private mayArm(resultKey: string, history: ReadonlyMap<string, "interrupted" | "done">): boolean {
    const past = history.get(resultKey);
    return past === undefined || past === "interrupted" && this.options.timerResume === "rearm";
  }
  private runTimer(memory: Memory, input: FlowInput, state: ConjugationDocumentSnapshot): void {
    const view = this.viewOf(memory, input, state, this.generation, this.timerHistory);
    const eligible = view.screen === "result" ? this.eligible(input, state, view.mode, view.pending, view.canNext) : null;
    const key = eligible ? `${eligible.resultKey}:${this.generation}` : null;
    if (this.timer && this.timer.key !== key) {
      // The same row 11 paused by inactivity is an interruption (D1 decides its return); anything else ends it.
      const paused = view.screen === "result" && !input.active
        && this.eligible(input, state, view.mode, view.pending, true, true)?.resultKey === this.timer.resultKey;
      this.cancelTimer(!paused);
    }
    // An armed timer of the same key keeps running whatever the mode is now (the mode is read at arming only).
    if (!eligible || this.timer || eligible.durationMs === null) return;
    if (!this.mayArm(eligible.resultKey, this.timerHistory)) {
      if (this.timerHistory.get(eligible.resultKey) === "interrupted") this.timerHistory.set(eligible.resultKey, "done");
      return;
    }
    const generation = this.generation, resultKey = eligible.resultKey, ticket = eligible.ticket, durationMs = eligible.durationMs;
    this.timerHistory.delete(resultKey);
    const timer: Timer = { key: key!, resultKey, durationMs, ticket, cancel: () => undefined };
    this.timer = timer;
    timer.cancel = this.options.schedule(durationMs, () => {
      if (this.disposed || this.timer !== timer || this.generation !== generation) return;
      const current = this.input;
      if (!current?.active || unmasked(current.state)?.stepTicket !== ticket) return;
      this.timer = null; this.timerHistory.set(resultKey, "done");
      this.options.actions.openStep(ticket);
    });
  }
  /** Ends the running timer: `done` forbids a return; otherwise the pause stays an interruption for D1. */
  private cancelTimer(done = true): void {
    const timer = this.timer;
    if (!timer) return;
    this.timer = null;
    this.timerHistory.set(timer.resultKey, done ? "done" : "interrupted");
    timer.cancel();
  }
  private interrupt(): void { this.cancelTimer(false); }

  /** Only rows 4/4a, the advance after an accepted grade in answer mode, and row 15. */
  private automate(memory: Memory, input: FlowInput, state: ConjugationDocumentSnapshot): void {
    if (memory.terminal) {
      if (memory.homeRequested && !memory.todayDone && state.closed?.reason === "summary_home") {
        this.memory = { ...memory, todayDone: true };
        this.options.onToday();
      }
      return;
    }
    if (!input.active) return;
    const study = state.commands.study;
    if (this.gradeRequest && study.outcome !== null && study.outcome !== "accepted" && study.resolved?.kind === "result.grade") this.gradeRequest = null;
    const request = this.gradeRequest, result = resultOf(state);
    if (request && result && sameId(result.result_id, request.resultId) && BigInt(result.version) > BigInt(request.version)
      && result.grade === request.grade) {
      const mode = memory.resultMode && sameId(memory.resultMode.resultId, request.resultId) ? memory.resultMode.mode : "previous";
      if (mode !== "answer") { this.gradeRequest = null; return; }
      if (state.display.kind === "result" && state.stepTicket && !this.autoTickets.has(state.stepTicket)) {
        this.gradeRequest = null; this.autoTickets.add(state.stepTicket); this.cancelTimer();
        this.options.actions.openStep(state.stepTicket);
      }
      return;
    }
    if (state.display.kind !== "none" || state.phase === "unknown" || state.phase === "stopping") return;
    if (!result) {
      const ticket = state.stepTicket;
      if (ticket && !this.autoTickets.has(ticket)) { this.autoTickets.add(ticket); this.options.actions.openStep(ticket); }
      return;
    }
    // Row 4a: restore the last display this identity chose; local only.
    if (memory.lastDisplay === "step" && state.stepTicket) {
      const ticket = state.stepTicket;
      if (!this.autoTickets.has(ticket)) { this.autoTickets.add(ticket); this.options.actions.openStep(ticket); }
      return;
    }
    const restore = `${result.result_id.toLowerCase()}:${state.resultA?.stateVersion}`;
    if (this.autoResult !== restore) { this.autoResult = restore; this.options.actions.openResult(); }
  }
}
