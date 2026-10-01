import { ApiError } from "../api/http";
import type { ClosedSessionBoundary, LearningAnswerResponse, LearningSessionProjection, UnavailableCurrent } from "../api/generated";
import { oneOf, sameId, uuid, version } from "../api/wireValidation";
import { PendingSlot, PendingStoreError } from "../commands/pendingSlot";
import type { LearningSessionRead, LearningSessionReply, LearningSessionStatus } from "./learningSessionApi";
import { copyLearningCommandIntent, validLearningCommandIntent, type LearningCommandIntent } from "./learningCommandIntent";
import type { LearningAnswerReply, LearningAnswerStatus, LearningResultRead } from "./learningAnswerApi";
import { copyLearningRevisionIntent, type LearningRevisionIntent } from "./learningRevisionIntent";
import type { LearningSessionPending } from "./learningSessionPending";

type WithoutId<T> = T extends unknown ? Omit<T, "command_id"> : never;
export type LearningTransition = WithoutId<LearningCommandIntent>;
type Current = LearningSessionRead["current"] | UnavailableCurrent;
type Answer = Pick<LearningAnswerResponse, "action" | "result" | "capabilities">;
type Reply = LearningSessionReply | LearningAnswerReply;
type Status = LearningSessionStatus | LearningAnswerStatus;
type Settled = Reply | Extract<Status, { outcome: "accepted" }>;
export type LearningCommandSnapshot = {
  phase: "loading" | "idle" | "checking" | "sending" | "unresolved" | "blocked" | "settled" | "disposed";
  pending: boolean;
  kind: LearningCommandIntent["kind"] | null;
  sessionId: string | null;
  outcome: "accepted" | "rejected" | "not_applied" | null;
  resolved: { commandId: string; kind: LearningCommandIntent["kind"]; sessionId: string;
    assignmentId?: string; resultId?: string } | null;
  pendingIntent: LearningCommandIntent | null;
  rejectionCode: string | null;
  problem: "network" | "storage" | "invalid_pending" | "pending_changed" | "mismatch" | "not_found"
    | "expired" | "forbidden" | "profile_changed" | "client_changed" | "pair_changed" | "step_changed"
    | "closed" | "stale_response" | null;
  canRetry: boolean;
  current: Current | null;
  answer: Answer | null;
  closedSession: ClosedSessionBoundary | null;
  stateVersion: string | null;
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
  send(intent: LearningCommandIntent): Promise<Reply>;
  check(intent: LearningCommandIntent): Promise<Status>;
  read(sessionId: string): Promise<LearningSessionRead>;
  readResult(intent: LearningRevisionIntent): Promise<LearningResultRead>;
  onUpdate(snapshot: LearningCommandSnapshot): void;
};

/** Reconcile one command. A host owns the document, screens and the independent Stop lane. */
export class LearningCommandController {
  private readonly lifetime = new AbortController();
  private phase: LearningCommandSnapshot["phase"] = "loading";
  private problem: LearningCommandSnapshot["problem"] = null;
  private pending: LearningSessionPending | null = null;
  private outcome: LearningCommandSnapshot["outcome"] = null;
  private resolved: LearningCommandSnapshot["resolved"] = null;
  private rejectionCode: string | null = null;
  private current: Current | null = null;
  private answer: Answer | null = null;
  private closedSession: ClosedSessionBoundary | null = null;
  private floor: string | null;
  private loaded = false;
  private running: Promise<void> | null = null;
  private retryVerified = false;

  constructor(private readonly options: Options) {
    if (!uuid(options.profileId) || !uuid(options.clientInstanceId) || !oneOf(options.pair, ["ru-de", "uk-de", "en-de"])
      || options.stateVersion !== undefined && !version(options.stateVersion)) throw new Error("invalid Learning context");
    this.floor = options.stateVersion ?? null;
  }
  private live(): boolean { return !this.lifetime.signal.aborted && this.options.isLive(); }
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
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    const task = Promise.resolve().then(() => { if (this.live()) return action(); }).catch((error: unknown) => {
      if (!this.live()) return;
      this.retryVerified = false;
      // A failed local cleanup must not erase an already confirmed result.
      if (!this.outcome) this.clearCurrent();
      if (error instanceof PendingStoreError) this.problem = error.kind === "invalid" ? "invalid_pending"
        : error.kind === "changed" ? "pending_changed" : "storage";
      else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.problem = error.status === 401 ? "expired" : "forbidden";
      } else this.problem = "network";
      this.phase = this.pending ? "unresolved" : "blocked";
    }).finally(() => { if (this.running === task) this.running = null; this.emit(); });
    this.running = task;
    return task;
  }
  private clearCurrent(): void { this.current = null; this.answer = null; this.closedSession = null; }
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
      if (outcome === "accepted" && ["answer.submit", "result.correct", "result.grade"].includes(intent.kind)
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
      if (!this.live()) return;
      if (!this.loaded) {
        this.pending = await this.options.pendingStore.load(this.options.profileId, this.lifetime.signal);
        if (!this.live()) return;
        this.loaded = true;
      }
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
      if (!this.observe(reply.state_version)) this.problem = "stale_response";
      else if (!sameId(reply.current.profile_id, this.options.profileId)) this.problem = "profile_changed";
      else if (reply.current.access.status !== "admitted") this.problem = "forbidden";
      else if (reply.closed_session !== undefined) {
        if (!sameId(reply.closed_session.session_id, pending.intent.session_id)) this.problem = "step_changed";
        else {
          // Only one locked server observation of absence plus final closure
          // resolves this intent. A later closed-session read alone cannot.
          this.outcome = "not_applied";
          this.closedSession = structuredClone(reply.closed_session);
          await this.clearSettled(); return;
        }
      }
      else if (pending.clientInstanceId !== this.options.clientInstanceId) this.problem = "client_changed";
      else if (pending.pair !== this.options.pair || `${reply.current.dictionary_language}-de` !== pending.pair) this.problem = "pair_changed";
      else if (pending.intent.kind === "result.grade" || pending.intent.kind === "result.correct") {
        const read = await this.options.readResult(copyLearningRevisionIntent(pending.intent));
        if (!this.live()) return;
        if (!this.observe(read.state_version, read.step)) this.problem = "stale_response";
        else {
          this.answer = this.current !== null && "pair" in this.current
            ? structuredClone({ action: read.action, result: read.result, capabilities: read.capabilities }) : null;
          this.problem = revisionRetryProblem(pending.intent, read, pending.pair);
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

  private async sendPending(): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.live()) return;
    this.phase = "sending"; this.problem = null; this.retryVerified = false; this.clearCurrent(); this.emit();
    if (!this.live()) return;
    await this.options.pendingStore.save(pending, this.lifetime.signal);
    if (!this.live()) return;
    const reply = await this.options.send(copyLearningCommandIntent(pending.intent));
    if (!this.live()) return;
    if (reply.outcome === "mismatch") {
      this.observe(reply.state_version);
      this.pending = { ...pending, mismatch: true }; this.problem = "mismatch"; this.phase = "unresolved";
      await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
    } else await this.settle(reply.outcome, reply);
  }
  begin(action: LearningTransition): Promise<void> {
    if (!this.live() || this.running || !this.loaded || this.pending || !["idle", "settled"].includes(this.phase)) {
      return this.running ?? Promise.resolve();
    }
    const intent = { ...action, command_id: this.options.newId() };
    if (!validLearningCommandIntent(intent)) return Promise.reject(new Error("invalid Learning action"));
    const pending: LearningSessionPending = { schemaVersion: 1, profileId: this.options.profileId,
      clientInstanceId: this.options.clientInstanceId, pair: this.options.pair, intent: copyLearningCommandIntent(intent) };
    return this.run(async () => {
      this.outcome = null; this.resolved = null; this.rejectionCode = null; this.pending = pending; await this.sendPending();
    });
  }
  retry(): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(() => this.sendPending());
  }
  dispose(): void { this.lifetime.abort(); this.clearCurrent(); this.phase = "disposed"; }
}

/** A missing acceptance fact authorizes no effect; retry only the same still-valid target. */
function retryProblem(intent: Exclude<LearningCommandIntent, LearningRevisionIntent>, current: LearningSessionRead["current"], pair: string): LearningCommandSnapshot["problem"] {
  if (!sameId(current.session_id, intent.session_id)) return "step_changed";
  if (current.status === "closed") return "closed";
  if (current.status === "unavailable") return "forbidden";
  if (current.status === "not_found") return intent.kind === "session.start" ? "not_found" : "step_changed";
  if (!("pair" in current)) return "forbidden";
  if (current.pair !== pair) return "pair_changed";
  switch (intent.kind) {
    case "session.start": return "step_changed";
    case "session.stop": return intent.payload.reason === "stop" || current.status === "summary" ? "not_found" : "step_changed";
    case "assignment.present": return current.status === "active" && current.assignment?.status === "prefetched"
      && sameId(current.assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "answer.submit": return current.status === "active" && current.assignment?.status === "presented"
      && sameId(current.assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "learning.preview_next": case "learning.known": return current.status === "active"
      && current.preview !== null && sameId(current.preview.id, intent.preview_id) ? "not_found" : "step_changed";
  }
}

function revisionRetryProblem(intent: LearningRevisionIntent, read: LearningResultRead, pair: string): LearningCommandSnapshot["problem"] {
  const step = read.step;
  if (step.status === "unavailable") return "forbidden";
  if (!("session_id" in step) || !sameId(step.session_id, intent.session_id)) return "step_changed";
  if (step.status === "closed") return "closed";
  if (step.status === "not_found") return "step_changed";
  if (!("pair" in step)) return "forbidden";
  if (step.pair !== pair) return "pair_changed";
  const { result, action, capabilities } = read;
  if (result === null || action === null || result.status !== "active" || action.status !== "active"
    || !sameId(result.result_id, intent.result_id) || !sameId(result.assignment_id, intent.assignment_id)
    || result.version !== intent.expected_result_version || action.version !== result.version) return "step_changed";
  const target = intent.kind === "result.correct" ? capabilities.correct_target : capabilities.grades;
  if (target === null || !sameId(target.session_id, intent.session_id) || !sameId(target.assignment_id, intent.assignment_id)
    || !sameId(target.result_id, intent.result_id) || target.expected_result_version !== intent.expected_result_version) return "step_changed";
  if (intent.kind === "result.grade" && !capabilities.grades?.values.includes(intent.payload.grade as 3 | 4 | 5)) return "step_changed";
  return "not_found";
}
