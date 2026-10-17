import type { ClosedSessionBoundary, LearningAnswerResponse, LearningSessionProjection, UnavailableCurrent } from "../api/generated";
import { oneOf, sameId, uuid, version } from "../api/wireValidation";
import { LaneCore, lostIntent, missingProblem, retryStep, type CommandProblem, type LaneResolved, type LaneSnapshot,
  type MissingStatus, type WithoutId } from "../commands/commandLane";
import { lostMissingProblem, type LostCommand, type LostMissing } from "../commands/lostEnvelope";
import { sendableIntent } from "../commands/closeIntent";
import { refusedUnsent, type PendingSlot } from "../commands/pendingSlot";
import { revisionRetryProblem } from "../commands/resultRevision";
import type { LearningSessionRead, LearningSessionReply, LearningSessionStatus } from "./learningSessionApi";
import { copyLearningCommandIntent, copyLearningResultIntent, isLearningResultIntent, validLearningCommandIntent,
  type LearningCommandIntent, type LearningResultIntent } from "./learningCommandIntent";
import type { LearningAnswerReply, LearningAnswerStatus, LearningResultRead } from "./learningAnswerApi";
import type { LearningSessionPending } from "./learningSessionPending";
import { documentLearningStarts, type LearningPageStarts } from "./learningPageStarts";
import type { WriteGate } from "../commands/writeGate";

export type LearningTransition = WithoutId<LearningCommandIntent>;
type Current = LearningSessionRead["current"] | UnavailableCurrent;
type Answer = Pick<LearningAnswerResponse, "action" | "result" | "capabilities">;
type Reply = LearningSessionReply | LearningAnswerReply;
type Status = LearningSessionStatus | LearningAnswerStatus;
type Settled = Reply | Extract<Status, { outcome: "accepted" | "rejected" }>;
type Resolved = LaneResolved<LearningCommandIntent["kind"]> & { assignmentId?: string; resultId?: string };
export type LearningCommandSnapshot = LaneSnapshot<LearningCommandIntent, Current, Resolved> & {
  answer: Answer | null;
  /**
   * A new session.start is being stored on this device and its request has not started yet (owner decision 21.1-А,
   * C156): no session of its ID exists, so the view offers no Stop for it. The end of the save proves no server commit;
   * only requestStarted() (or the end of this send) ends it.
   */
  preparingStart: boolean;
  /**
   * The retained session.start was stored by its first send in this window, but no request of it has started: a new open
   * handle of the same document replaced the one it was tapped under (its send was refused before the transport). Its
   * own outcome, never one of a transmitted start whose reply is unknown. Owner decision 33.1-А (C194): no Stop of it is
   * offered; after the check under the current handle the same intent is sent once (DocumentLanes).
   */
  startNotSent: boolean;
};
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
  /** Q27 (C458/C467): the status of a lost answer or grade by its ID only; without it a lost command stays unresolved. */
  checkLost?(lost: LostCommand): Promise<Extract<LearningAnswerStatus, { outcome: "accepted" }> | LostMissing>;
  read(sessionId: string): Promise<LearningSessionRead>;
  readResult(intent: LearningResultIntent): Promise<LearningResultRead>;
  onUpdate(snapshot: LearningCommandSnapshot): void;
  /** The starts this page created (35.1-А); the page of this JS document unless a test models another one. */
  page?: LearningPageStarts;
  /** The write gate of the page and this lane's family in its readback registry (P03 R1, M-P03-8). */
  gate?: WriteGate;
  family?: string;
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
  private preparingStart = false;
  /** command_id of a start stored by its first send whose request has not started yet (memory only: not after a reload). */
  private storedUnsent: string | null = null;
  private readonly page: LearningPageStarts;

  constructor(private readonly options: Options) {
    super(options);
    this.page = options.page ?? documentLearningStarts;
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
    return { phase: live ? this.phase : "disposed", pending: this.pending !== null || this.lost !== null,
      kind: this.pending?.intent.kind ?? this.lost?.kind as LearningCommandIntent["kind"] | undefined ?? null,
      sessionId: this.pending?.intent.session_id ?? this.lost?.sessionId ?? null,
      outcome: this.outcome, resolved: live && this.resolved ? { ...this.resolved } : null,
      pendingIntent: ownPending ? copyLearningCommandIntent(this.pending!.intent) : null,
      rejectionCode: live ? this.rejectionCode : null,
      problem: this.problem, current: live && fresh ? structuredClone(this.current) : null,
      answer: live && fresh ? structuredClone(this.answer) : null, preparingStart: live && this.preparingStart,
      startNotSent: live && this.outcome === null && this.pending !== null && this.storedUnsent === this.pending.intent.command_id,
      stateVersion: this.floor,
      closedSession: live && fresh ? structuredClone(this.closedSession) : null,
      canRetry: live && fresh && !this.running && this.retryVerified && this.pending !== null && !this.pending.mismatch
        && this.outcome === null && this.pending.clientInstanceId === this.options.clientInstanceId
        && this.pending.pair === this.options.pair && sendableIntent(this.pending.intent)
        // 35.1-А: a start of another page (a reload, another window) is only checked by its ID, never sent again.
        && (this.pending.intent.kind !== "session.start" || this.page.owns(this.pending)),
      conflict: this.pending?.mismatch === true || this.lost?.mismatch === true, lost: this.lostView() };
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
    if (!this.pending && this.lost && this.resolved?.commandId !== this.lost.commandId) this.resolved = { commandId: this.lost.commandId,
      kind: this.lost.kind as LearningCommandIntent["kind"], sessionId: this.lost.sessionId };
    const cleared = this.pending;
    if (cleared) await this.options.pendingStore.clear(cleared, this.lifetime.signal);
    else if (this.lost) await this.clearLostRecord();
    // The record of a known outcome is gone from the device: its page mark has nothing left to tell (35.1-А).
    if (cleared) this.page.forget(cleared.intent.command_id);
    if (!this.live()) return;
    this.pending = null; this.problem = null; this.retryVerified = false; this.phase = "settled";
    this.registry?.cleared();
  }
  private async settle(outcome: "accepted" | "rejected", reply: Settled, restored = false): Promise<void> {
    this.outcome = outcome;
    const intent = this.pending?.intent;
    if (intent) {
      this.resolved = { commandId: intent.command_id, kind: intent.kind, sessionId: intent.session_id, ...(restored ? { restored: true } : {}) };
      // The exact accepted address is immutable evidence, even when the attached
      // result projection is older than a confirmed Settings observation.
      if (outcome === "accepted" && ["answer.submit", "result.correct", "result.grade", "result.undo"].includes(intent.kind)
        && "assignment_id" in intent && "result_id" in reply.command && uuid(reply.command.result_id)) {
        this.resolved.assignmentId = intent.assignment_id; this.resolved.resultId = reply.command.result_id;
      }
    }
    this.rejectionCode = outcome === "rejected" && "error" in reply ? reply.error.code : null;
    const current = "step" in reply ? reply.step : reply.current;
    const otherPair = "pair" in current && current.pair !== this.options.pair;
    const observed = this.observe(reply.state_version, current);
    if (!observed) this.clearCurrent();
    else this.answer = this.current !== null && "pair" in this.current && "step" in reply
      ? structuredClone({ action: reply.action, result: reply.result, capabilities: reply.capabilities }) : null;
    await this.clearSettled();
    // As the shared lane (commandLane settle): the accepted fact stays, its session is open in another pair (R1).
    if (observed && otherPair && outcome === "accepted" && this.live() && current.status !== "closed") this.problem = "pair_changed";
  }

  /**
   * Q27 (C458/C467): a lost answer or grade is read by its own ID only — as the shared lane does (commandLane
   * reconcileLost): acceptance is its ordinary recovery (a restored result), the final closure of its session proves it
   * never applies, any other absence leaves it unresolved without a resend; its session is read before Stop is offered.
   */
  private async reconcileLost(lost: LostCommand): Promise<void> {
    if (lost.mismatch) { this.problem = "mismatch"; this.phase = "unresolved"; return; }
    if (!this.options.checkLost) { this.problem = "lost_envelope"; this.phase = "unresolved"; return; }
    const reply = await this.options.checkLost(lost);
    if (!this.live()) return;
    if (reply.outcome === "accepted") {
      this.outcome = "accepted";
      const resolved: NonNullable<LearningCommandSnapshot["resolved"]> = { commandId: lost.commandId,
        kind: lost.kind as LearningCommandIntent["kind"], sessionId: lost.sessionId, restored: true };
      if (uuid(reply.command.result_id)) { resolved.assignmentId = lost.assignmentId; resolved.resultId = reply.command.result_id; }
      this.resolved = resolved;
      this.rejectionCode = null;
      const current = reply.step, otherPair = "pair" in current && current.pair !== this.options.pair;
      const observed = this.observe(reply.state_version, current);
      if (!observed) this.clearCurrent();
      else this.answer = this.current !== null && "pair" in this.current
        ? structuredClone({ action: reply.action, result: reply.result, capabilities: reply.capabilities }) : null;
      await this.clearSettled();
      if (observed && otherPair && this.live() && current.status !== "closed") this.problem = "pair_changed";
      return;
    }
    this.registry?.settled("not_recorded");
    if (!this.observe(reply.state_version)) this.problem = "stale_response";
    else {
      const problem = lostMissingProblem(reply, lost, this.options);
      if (problem === "not_applied") {
        this.outcome = "not_applied"; this.closedSession = structuredClone(reply.closed_session!);
        await this.clearSettled(); return;
      }
      if (problem !== null) this.problem = problem;
      else {
        const read = await this.options.read(lost.sessionId);
        if (!this.live()) return;
        if (!this.observe(read.state_version, read.current)) this.problem = "stale_response";
        else {
          const step = retryStep(read.current, lostIntent(lost), lost.pair);
          this.lostOpen = typeof step !== "string";
          this.problem = typeof step === "string" ? step === "not_found" ? "step_changed" : step : "lost_envelope";
        }
      }
    }
    this.phase = "unresolved";
  }

  /** Reload checks the original ID. No missing fact can itself trigger a POST. */
  refresh(): Promise<void> {
    return this.run(async () => {
      this.phase = "checking"; this.problem = null; this.retryVerified = false;
      if (!this.outcome) this.clearCurrent();
      this.emit();
      if (!this.live() || !await this.loadPending()) return;
      if (this.outcome) { await this.clearSettled(); return; }
      if (this.lost) { await this.reconcileLost(this.lost); return; }
      if (!this.pending) { this.phase = "idle"; return; }
      if (this.pending.mismatch) {
        this.registry?.settled("mismatch");
        await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
        if (!this.live()) return;
        this.problem = "mismatch"; this.phase = "unresolved"; return;
      }
      const pending = this.pending;
      const reply = await this.options.check(copyLearningCommandIntent(pending.intent));
      if (!this.live()) return;
      if (reply.outcome === "accepted") { await this.settle("accepted", reply, this.inherited); return; }
      if (reply.outcome === "rejected") {
        // A stored final refusal of this start (its own ID and intent hash, learningSessionApi): the same outcome as
        // the refusal its POST got, once it is not older than what this lane already knows.
        if (!this.observe(reply.state_version)) { this.problem = "stale_response"; this.phase = "unresolved"; return; }
        await this.settle("rejected", reply); return;
      }
      // The server does not hold this ID: a definite answer about it (R5), whatever the target read says next.
      this.registry?.settled("not_recorded");
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
        const found = pending.intent.kind === "session.start" && this.storedUnsent === pending.intent.command_id
          ? retryStep(read.current, pending.intent, pending.pair) : null;
        if (!this.observe(read.state_version, read.current)) this.problem = "stale_response";
        else if (found !== null && typeof found !== "string") {
          // 33.1-А (F6): the session of this never sent start exists (S): nothing of the start is left to send. Its
          // record is cleared and S is recovered from this read like any open session; Stop follows the rights of S.
          await this.options.pendingStore.clear(pending, this.lifetime.signal);
          // As in clearSettled: the record is gone from the device, so its page mark ends too (35.1-А).
          this.page.forget(pending.intent.command_id);
          if (!this.live()) return;
          this.storedUnsent = null; this.pending = null; this.retryVerified = false; this.phase = "idle";
          this.registry?.cleared();
          return;
        }
        else {
          this.problem = retryProblem(pending.intent, read.current, pending.pair);
          this.retryVerified = this.problem === "not_found";
        }
      }
      this.phase = "unresolved";
    });
  }

  /** first: the new intent of start, never stored or sent before; resend and retry pass a retained one. */
  private async sendPending(transmitted?: () => void, first = false): Promise<void> {
    const pending = this.pending;
    // The closure C goes out like every intent of this lane; its budget and manual retry are the document's (closureRecovery).
    if (!pending || !this.live() || !sendableIntent(pending.intent)) return;
    this.phase = "sending"; this.problem = null; this.retryVerified = false; this.clearCurrent(); this.emit();
    if (!this.live()) return;
    // From now on a request of this ID may leave: its outcome is unknown until a definite answer (R1).
    this.registry?.hold(pending.intent.command_id);
    try { await this.options.pendingStore.save(pending, this.lifetime.signal); }
    catch (error: unknown) {
      // A new intent the shared slot refused (another record, or one it cannot read) was neither stored nor sent: it is no
      // unknown outcome to check or retry, and the record in the slot stays exactly as it is. A retained intent keeps its record.
      if (first && refusedUnsent(error)) { this.pending = null; this.registry?.cleared(); }
      throw error;
    }
    if (!this.live()) return;
    if (this.preparingStart) this.storedUnsent = pending.intent.command_id;
    // A manual send passes no hook: its exchange stays exactly what it was before automatic recovery.
    const intent = copyLearningCommandIntent(pending.intent);
    const reply = await (transmitted ? this.options.send(intent, transmitted) : this.options.send(intent));
    if (!this.live()) return;
    if (reply.outcome === "mismatch") {
      this.observe(reply.state_version);
      this.registry?.settled("mismatch");
      this.pending = { ...pending, mismatch: true }; this.problem = "mismatch"; this.phase = "unresolved";
      await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
    } else {
      // fix3 (П01): the direct reply refused this page's own start as SESSION_BUSY.
      if (reply.outcome === "rejected" && intent.kind === "session.start" && "error" in reply && reply.error.code === "SESSION_BUSY") {
        this.registry?.startRefusedBusy(intent.command_id);
      }
      await this.settle(reply.outcome, reply);
    }
  }
  /**
   * The host tells this right where the request of the current send starts (inside the open handle, after its check):
   * a new start may exist from now on. The update is announced after this synchronous step, so the request has already
   * entered the transport before anyone can see Stop offered again (21.1-А).
   */
  requestStarted(): void {
    this.storedUnsent = null;
    if (!this.preparingStart) return;
    this.preparingStart = false;
    void Promise.resolve().then(() => this.emit());
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
    // Marked before the deferred run and its slot write: a record of this start never exists without its page mark.
    this.page.mark(pending);
    // Set before the deferred run: a Stop in the same tick as the tap on «Начать» already sees it.
    this.preparingStart = intent.kind === "session.start";
    this.noteCreated(pending.intent.command_id);
    return this.run(async () => {
      this.outcome = null; this.resolved = null; this.rejectionCode = null; this.pending = pending;
      // Every end of this send (refused, failed, or a transport that never started a request) ends the preparation.
      try { await this.sendPending(transmitted, true); }
      catch (error: unknown) {
        // A send refused before its request (a handle replaced under this live owner, or a command the API refused
        // locally) keeps «stored, not sent»; a closed or denied owner keeps nothing.
        if (!this.live()) this.storedUnsent = null;
        throw error;
      } finally { this.preparingStart = false; }
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
  release(commandId: string): Promise<void> { return this.forgetCleared(super.release(commandId)); }
  releaseClosed(sessionId: string): Promise<void> { return this.forgetCleared(super.releaseClosed(sessionId)); }
  /** A record cleared by a release ends its page mark too; a failed clear keeps both. */
  private forgetCleared(task: Promise<void>): Promise<void> {
    const pending = this.pending;
    return task.then(() => { if (pending && this.pending === null) this.page.forget(pending.intent.command_id); });
  }
}

/** A missing acceptance fact authorizes no effect; retry only the same still-valid target. */
function retryProblem(intent: Exclude<LearningCommandIntent, LearningResultIntent>, current: LearningSessionRead["current"], pair: string): CommandProblem {
  const step = retryStep(current, intent, pair);
  if (typeof step === "string") return step;
  switch (intent.kind) {
    case "session.start": return "step_changed";
    // A Stop and the closure C (CON §6.1 п.8, Q30) may go again while the session is open at any step; summary_home only
    // from the summary.
    case "session.stop": return intent.payload.reason !== "summary_home" || step.status === "summary" ? "not_found" : "step_changed";
    case "assignment.present": return step.status === "active" && step.assignment?.status === "prefetched"
      && sameId(step.assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "answer.submit": return step.status === "active" && step.assignment?.status === "presented"
      && sameId(step.assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "learning.preview_next": case "learning.known": return step.status === "active"
      && step.preview !== null && sameId(step.preview.id, intent.preview_id) ? "not_found" : "step_changed";
  }
}
