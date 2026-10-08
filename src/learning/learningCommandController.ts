import type { ClosedSessionBoundary, LearningAnswerResponse, LearningSessionProjection, UnavailableCurrent } from "../api/generated";
import { oneOf, sameId, uuid, version } from "../api/wireValidation";
import { LaneCore, missingProblem, retryStep, type CommandProblem, type LaneResolved, type LaneSnapshot,
  type MissingStatus, type WithoutId } from "../commands/commandLane";
import type { PendingSlot } from "../commands/pendingSlot";
import { revisionRetryProblem } from "../commands/resultRevision";
import type { LearningSessionRead, LearningSessionReply, LearningSessionStatus } from "./learningSessionApi";
import { copyLearningCommandIntent, copyLearningResultIntent, isLearningResultIntent, validLearningCommandIntent,
  type LearningCommandIntent, type LearningResultIntent } from "./learningCommandIntent";
import type { LearningAnswerReply, LearningAnswerStatus, LearningResultRead } from "./learningAnswerApi";
import type { LearningSessionPending } from "./learningSessionPending";

export type LearningTransition = WithoutId<LearningCommandIntent>;
type Current = LearningSessionRead["current"] | UnavailableCurrent;
type Answer = Pick<LearningAnswerResponse, "action" | "result" | "capabilities">;
type Reply = LearningSessionReply | LearningAnswerReply;
type Status = LearningSessionStatus | LearningAnswerStatus;
type Settled = Reply | Extract<Status, { outcome: "accepted" }>;
type Resolved = LaneResolved<LearningCommandIntent["kind"]> & { assignmentId?: string; resultId?: string };
export type LearningCommandSnapshot = LaneSnapshot<LearningCommandIntent, Current, Resolved> & { answer: Answer | null };
type Options = {
  profileId: string;
  clientInstanceId: string;
  pair: LearningSessionProjection["pair"];
  stateVersion?: string;
  minimumStateVersion?(): string | null;
  pendingStore: PendingSlot<LearningSessionPending>;
  isLive(): boolean;
  newId(): string;
  /** transmitted, when given, is called right before the request starts (automatic recovery, CT §6.1 п. 4). */
  send(intent: LearningCommandIntent, transmitted?: () => void): Promise<Reply>;
  check(intent: LearningCommandIntent): Promise<Status>;
  read(sessionId: string): Promise<LearningSessionRead>;
  readResult(intent: LearningResultIntent): Promise<LearningResultRead>;
  onUpdate(snapshot: LearningCommandSnapshot): void;
};

/**
 * Reconcile one command. A host owns the document, screens and the independent Stop lane. Learning keeps its own
 * lane algorithm (no lane check, retry without a second check, no shared-floor memory): only the identical checks are shared.
 * Its study results are retried only by automatic recovery (resend after the machine's own check, M-RECOV-AUTO CP2).
 */
export class LearningCommandController extends LaneCore<LearningCommandIntent, LearningCommandSnapshot> {
  private resolved: LearningCommandSnapshot["resolved"] = null;
  private rejectionCode: string | null = null;
  private current: Current | null = null;
  private answer: Answer | null = null;
  private closedSession: ClosedSessionBoundary | null = null;
  private floor: string | null;

  constructor(private readonly options: Options) {
    super(options);
    if (!uuid(options.profileId) || !uuid(options.clientInstanceId) || !oneOf(options.pair, ["ru-de", "uk-de", "en-de"])
      || options.stateVersion !== undefined && !version(options.stateVersion)) throw new Error("invalid Learning context");
    this.floor = options.stateVersion ?? null;
  }
  private minimumVersion(): string | null {
    const external = this.options.minimumStateVersion?.() ?? null;
    if (external !== null && !version(external)) throw new Error("invalid shared Learning version");
    return external !== null && (this.floor === null || BigInt(external) > BigInt(this.floor)) ? external : this.floor;
  }
  snapshot(): LearningCommandSnapshot {
    const live = this.live();
    const minimum = this.minimumVersion();
    const fresh = minimum === null || this.floor !== null && BigInt(this.floor) >= BigInt(minimum);
    const ownPending = live && this.pending?.clientInstanceId === this.options.clientInstanceId && this.pending.pair === this.options.pair
      && !["profile_changed", "client_changed", "pair_changed", "forbidden", "expired"].includes(this.problem ?? "");
    return { phase: live ? this.phase : "disposed", pending: this.pending !== null,
      kind: this.pending?.intent.kind ?? null, sessionId: this.pending?.intent.session_id ?? null,
      outcome: this.outcome, resolved: live && this.resolved ? { ...this.resolved } : null,
      pendingIntent: ownPending ? copyLearningCommandIntent(this.pending!.intent) : null,
      rejectionCode: live ? this.rejectionCode : null,
      problem: this.problem, current: live && fresh ? structuredClone(this.current) : null,
      answer: live && fresh ? structuredClone(this.answer) : null, stateVersion: this.floor,
      closedSession: live && fresh ? structuredClone(this.closedSession) : null,
      canRetry: live && fresh && !this.running && this.retryVerified && this.pending !== null && !this.pending.mismatch
        && this.outcome === null && this.pending.clientInstanceId === this.options.clientInstanceId
        && this.pending.pair === this.options.pair };
  }
  protected clearCurrent(): void { this.current = null; this.answer = null; this.closedSession = null; }
  private observe(stateVersion: string, current?: Current): boolean {
    const minimum = this.minimumVersion();
    if (minimum !== null && BigInt(stateVersion) < BigInt(minimum)) return false;
    this.floor = stateVersion;
    if (current !== undefined) {
      this.current = "pair" in current && current.pair !== this.options.pair ? null : structuredClone(current);
    }
    return true;
  }
  private async clearSettled(): Promise<void> {
    if (!this.outcome) return;
    if (this.pending && this.resolved?.commandId !== this.pending.intent.command_id) this.resolved = { commandId: this.pending.intent.command_id,
      kind: this.pending.intent.kind, sessionId: this.pending.intent.session_id };
    if (this.pending) await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null; this.problem = null; this.retryVerified = false; this.phase = "settled";
  }
  private async settle(outcome: "accepted" | "rejected", reply: Settled): Promise<void> {
    this.outcome = outcome;
    const intent = this.pending?.intent;
    if (intent) {
      this.resolved = { commandId: intent.command_id, kind: intent.kind, sessionId: intent.session_id };
      // The exact accepted address is immutable evidence, even when the attached
      // result projection is older than a confirmed Settings observation.
      if (outcome === "accepted" && ["answer.submit", "result.correct", "result.grade", "result.undo"].includes(intent.kind)
        && "assignment_id" in intent && "result_id" in reply.command && uuid(reply.command.result_id)) {
        this.resolved.assignmentId = intent.assignment_id; this.resolved.resultId = reply.command.result_id;
      }
    }
    this.rejectionCode = outcome === "rejected" && "error" in reply ? reply.error.code : null;
    const current = "step" in reply ? reply.step : reply.current;
    if (!this.observe(reply.state_version, current)) this.clearCurrent();
    else this.answer = this.current !== null && "pair" in this.current && "step" in reply
      ? structuredClone({ action: reply.action, result: reply.result, capabilities: reply.capabilities }) : null;
    await this.clearSettled();
  }

  /** Reload checks the original ID. No missing fact can itself trigger a POST. */
  refresh(): Promise<void> {
    return this.run(async () => {
      this.phase = "checking"; this.problem = null; this.retryVerified = false;
      if (!this.outcome) this.clearCurrent();
      this.emit();
      if (!this.live() || !await this.loadPending()) return;
      if (this.outcome) { await this.clearSettled(); return; }
      if (!this.pending) { this.phase = "idle"; return; }
      if (this.pending.mismatch) {
        await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
        if (!this.live()) return;
        this.problem = "mismatch"; this.phase = "unresolved"; return;
      }
      const pending = this.pending;
      const reply = await this.options.check(copyLearningCommandIntent(pending.intent));
      if (!this.live()) return;
      if (reply.outcome === "accepted") { await this.settle("accepted", reply); return; }
      const missing: MissingStatus = reply, problem = missingProblem(missing, pending, this.options);
      if (!this.observe(reply.state_version)) this.problem = "stale_response";
      else if (problem === "not_applied") {
        // Only one locked server observation of absence plus final closure
        // resolves this intent. A later closed-session read alone cannot.
        this.outcome = "not_applied";
        this.closedSession = structuredClone(missing.closed_session!);
        await this.clearSettled(); return;
      }
      else if (problem !== null) this.problem = problem;
      else if (isLearningResultIntent(pending.intent)) {
        // A revision or an undo is retried only while the server still grants exactly its right (CT 2.3).
        const read = await this.options.readResult(copyLearningResultIntent(pending.intent));
        if (!this.live()) return;
        if (!this.observe(read.state_version, read.step)) this.problem = "stale_response";
        else {
          this.answer = this.current !== null && "pair" in this.current
            ? structuredClone({ action: read.action, result: read.result, capabilities: read.capabilities }) : null;
          this.problem = revisionRetryProblem(pending.intent, read, pending.pair, true);
          this.retryVerified = this.problem === "not_found";
        }
      }
      else {
        const read = await this.options.read(pending.intent.session_id);
        if (!this.live()) return;
        if (!this.observe(read.state_version, read.current)) this.problem = "stale_response";
        else {
          this.problem = retryProblem(pending.intent, read.current, pending.pair);
          this.retryVerified = this.problem === "not_found";
        }
      }
      this.phase = "unresolved";
    });
  }

  private async sendPending(transmitted?: () => void): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.live()) return;
    this.phase = "sending"; this.problem = null; this.retryVerified = false; this.clearCurrent(); this.emit();
    if (!this.live()) return;
    await this.options.pendingStore.save(pending, this.lifetime.signal);
    if (!this.live()) return;
    // A manual send passes no hook: its exchange stays exactly what it was before automatic recovery.
    const intent = copyLearningCommandIntent(pending.intent);
    const reply = await (transmitted ? this.options.send(intent, transmitted) : this.options.send(intent));
    if (!this.live()) return;
    if (reply.outcome === "mismatch") {
      this.observe(reply.state_version);
      this.pending = { ...pending, mismatch: true }; this.problem = "mismatch"; this.phase = "unresolved";
      await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
    } else await this.settle(reply.outcome, reply);
  }
  begin(action: LearningTransition): Promise<void> {
    if (this.busy()) return this.running ?? Promise.resolve();
    const intent = this.prepare(action);
    if (intent instanceof Error) return Promise.reject(intent);
    return this.start(intent);
  }
  /** The intent of an action with its new command_id, not yet sent: automatic recovery counts its sends (CP2). */
  prepare(action: LearningTransition): LearningCommandIntent | Error {
    const intent = { ...action, command_id: this.options.newId() };
    return validLearningCommandIntent(intent) ? copyLearningCommandIntent(intent) : new Error("invalid Learning action");
  }
  /** Send a prepared intent once, as begin does; transmitted is told right before its request starts. */
  start(intent: LearningCommandIntent, transmitted?: () => void): Promise<void> {
    if (this.busy()) return this.running ?? Promise.resolve();
    const pending: LearningSessionPending = { schemaVersion: 1, profileId: this.options.profileId,
      clientInstanceId: this.options.clientInstanceId, pair: this.options.pair, intent: copyLearningCommandIntent(intent) };
    return this.run(async () => {
      this.outcome = null; this.resolved = null; this.rejectionCode = null; this.pending = pending; await this.sendPending(transmitted);
    });
  }
  /**
   * The automatic retry: the retained intent, only while the check that just ran still grants it (canRetry needs
   * retryVerified). The recovery machine checks right before every call (Я15.6), unlike the manual retry below.
   */
  resend(transmitted?: () => void): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(() => this.sendPending(transmitted));
  }
  retry(): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(() => this.sendPending());
  }
}

/** A missing acceptance fact authorizes no effect; retry only the same still-valid target. */
function retryProblem(intent: Exclude<LearningCommandIntent, LearningResultIntent>, current: LearningSessionRead["current"], pair: string): CommandProblem {
  const step = retryStep(current, intent, pair);
  if (typeof step === "string") return step;
  switch (intent.kind) {
    case "session.start": return "step_changed";
    case "session.stop": return intent.payload.reason === "stop" || step.status === "summary" ? "not_found" : "step_changed";
    case "assignment.present": return step.status === "active" && step.assignment?.status === "prefetched"
      && sameId(step.assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "answer.submit": return step.status === "active" && step.assignment?.status === "presented"
      && sameId(step.assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "learning.preview_next": case "learning.known": return step.status === "active"
      && step.preview !== null && sameId(step.preview.id, intent.preview_id) ? "not_found" : "step_changed";
  }
}
