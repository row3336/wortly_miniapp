import { ApiError } from "../api/http";
import type { ClosedSessionBoundary, SessionProjection, UnavailableCurrent } from "../api/generated";
import { oneOf, sameId, uuid, version } from "../api/wireValidation";
import { PendingStoreError, type PendingSlot } from "../commands/pendingSlot";
import type { WrittenAnswer, WrittenCurrent, WrittenReply, WrittenResultRead, WrittenSessionRead, WrittenStatus } from "./writtenApi";
import { copyWrittenIntent, isAnswerKind, validWrittenIntent, type WrittenIntent, type WrittenRevisionIntent } from "./writtenIntent";
import type { WrittenLane, WrittenPending } from "./writtenPending";

type WithoutId<T> = T extends unknown ? Omit<T, "command_id"> : never;
export type WrittenTransition = WithoutId<WrittenIntent>;
type Current = WrittenCurrent | UnavailableCurrent;
type Settled = WrittenReply | Extract<WrittenStatus, { outcome: "accepted" }>;
export type WrittenCommandSnapshot = {
  phase: "loading" | "idle" | "checking" | "sending" | "unresolved" | "blocked" | "settled" | "disposed";
  pending: boolean;
  kind: WrittenIntent["kind"] | null;
  sessionId: string | null;
  pendingIntent: WrittenIntent | null;
  outcome: "accepted" | "rejected" | "not_applied" | null;
  resolved: { commandId: string; kind: WrittenIntent["kind"]; sessionId: string; assignmentId?: string; resultId?: string } | null;
  rejectionCode: string | null;
  problem: "network" | "storage" | "invalid_pending" | "pending_changed" | "mismatch" | "not_found"
    | "expired" | "forbidden" | "profile_changed" | "client_changed" | "pair_changed" | "step_changed"
    | "closed" | "stale_response" | null;
  canRetry: boolean;
  current: Current | null;
  answer: WrittenAnswer | null;
  closedSession: ClosedSessionBoundary | null;
  stateVersion: string | null;
};
type Options = {
  profileId: string;
  clientInstanceId: string;
  pair: SessionProjection["pair"];
  lane: WrittenLane;
  pendingStore: PendingSlot<WrittenPending>;
  isLive(): boolean;
  newId(): string;
  send(intent: WrittenIntent): Promise<WrittenReply>;
  /** Verifies the server fingerprint of the full intent; a different payload under this ID is an HTTP 409. */
  check(intent: WrittenIntent): Promise<WrittenStatus>;
  read(sessionId: string): Promise<WrittenSessionRead>;
  readResult(intent: WrittenRevisionIntent): Promise<WrittenResultRead>;
  onUpdate(snapshot: WrittenCommandSnapshot): void;
  stateVersion?: string;
  minimumStateVersion?(): string | null;
};

/** Own one addressed intent of one lane: one command_id per intent, kept through timeout, reload and manual retry. */
export class WrittenCommandController {
  private readonly options: Readonly<Options>;
  private readonly lifetime = new AbortController();
  private phase: WrittenCommandSnapshot["phase"] = "loading";
  private problem: WrittenCommandSnapshot["problem"] = null;
  private pending: WrittenPending | null = null;
  private outcome: WrittenCommandSnapshot["outcome"] = null;
  private resolved: WrittenCommandSnapshot["resolved"] = null;
  private rejectionCode: string | null = null;
  private current: Current | null = null;
  private answer: WrittenAnswer | null = null;
  private closedSession: ClosedSessionBoundary | null = null;
  private floor: string | null;
  private sharedFloor: string | null = null;
  private loaded = false;
  private running: Promise<void> | null = null;
  private retryVerified = false;

  constructor(options: Options) {
    if (!uuid(options.profileId) || !uuid(options.clientInstanceId) || !oneOf(options.pair, ["ru-de", "uk-de", "en-de"])
      || !oneOf(options.lane, ["primary", "stop"])
      || options.stateVersion !== undefined && !version(options.stateVersion)) throw new Error("invalid written context");
    this.options = { ...options };
    this.floor = options.stateVersion ?? null;
  }
  private live(): boolean { return !this.lifetime.signal.aborted && this.options.isLive(); }
  private minimumVersion(): string | null {
    const external = this.options.minimumStateVersion?.() ?? null;
    if (external !== null && !version(external)) throw new Error("invalid shared written version");
    if (external !== null && (this.sharedFloor === null || BigInt(external) > BigInt(this.sharedFloor))) this.sharedFloor = external;
    return this.sharedFloor !== null && (this.floor === null || BigInt(this.sharedFloor) > BigInt(this.floor)) ? this.sharedFloor : this.floor;
  }
  private fresh(): boolean {
    const minimum = this.minimumVersion();
    return minimum === null || this.floor !== null && BigInt(this.floor) >= BigInt(minimum);
  }
  snapshot(): WrittenCommandSnapshot {
    const live = this.live(), fresh = live && this.fresh();
    const own = this.pending !== null && this.pending.clientInstanceId === this.options.clientInstanceId && this.pending.pair === this.options.pair;
    const ownPending = live && own && !["profile_changed", "client_changed", "pair_changed", "forbidden", "expired"].includes(this.problem ?? "");
    return { phase: live ? this.phase : "disposed", pending: this.pending !== null,
      kind: this.pending?.intent.kind ?? null, sessionId: this.pending?.intent.session_id ?? null,
      pendingIntent: ownPending ? copyWrittenIntent(this.pending!.intent) : null,
      outcome: this.outcome, resolved: live && this.resolved ? { ...this.resolved } : null,
      rejectionCode: live ? this.rejectionCode : null, problem: this.problem,
      canRetry: live && fresh && !this.running && this.retryVerified && own && !this.pending!.mismatch && this.outcome === null,
      current: live && fresh ? structuredClone(this.current) : null, answer: live && fresh ? structuredClone(this.answer) : null,
      closedSession: live && fresh ? structuredClone(this.closedSession) : null, stateVersion: this.floor };
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
      // A timeout keeps the same intent: it becomes unknown, never a new command.
      this.phase = this.pending ? "unresolved" : "blocked";
    }).finally(() => { if (this.running === task) this.running = null; this.emit(); });
    this.running = task;
    return task;
  }
  private clearCurrent(): void { this.current = null; this.answer = null; this.closedSession = null; }
  private observe(stateVersion: string, current?: Current): boolean {
    const minimum = this.minimumVersion();
    if (!version(stateVersion) || minimum !== null && BigInt(stateVersion) < BigInt(minimum)) return false;
    this.floor = stateVersion;
    if (current !== undefined) this.current = "pair" in current && current.pair !== this.options.pair ? null : structuredClone(current);
    return true;
  }
  private async clearSettled(): Promise<void> {
    if (!this.outcome || !this.live()) return;
    if (this.pending && !this.resolved) this.resolved = { commandId: this.pending.intent.command_id,
      kind: this.pending.intent.kind, sessionId: this.pending.intent.session_id };
    if (this.pending) await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null; this.problem = null; this.retryVerified = false; this.phase = "settled";
  }
  private async settle(reply: Settled): Promise<void> {
    const intent = this.pending!.intent;
    this.outcome = reply.outcome === "accepted" ? "accepted" : "rejected";
    this.resolved = { commandId: intent.command_id, kind: intent.kind, sessionId: intent.session_id };
    // The exact accepted address is immutable evidence, even if its attached projection is stale.
    if (reply.outcome === "accepted" && isAnswerKind(intent.kind) && "assignment_id" in intent && uuid(reply.command.result_id)) {
      this.resolved.assignmentId = intent.assignment_id; this.resolved.resultId = reply.command.result_id;
    }
    this.rejectionCode = reply.outcome === "accepted" ? null : reply.error.code;
    const answer = "step" in reply;
    if (!this.observe(reply.state_version, answer ? reply.step : reply.current)) this.clearCurrent();
    else this.answer = answer && this.current !== null && "pair" in this.current
      ? structuredClone({ action: reply.action, result: reply.result, capabilities: reply.capabilities }) : null;
    await this.clearSettled();
  }
  private async markMismatch(pending: WrittenPending): Promise<void> {
    if (!this.live()) return;
    // Remember in memory first: a failed marker write must never allow this owner to retry another payload.
    this.pending = { ...pending, mismatch: true };
    this.retryVerified = false; this.outcome = null; this.resolved = null; this.rejectionCode = null;
    this.clearCurrent(); this.problem = "mismatch"; this.phase = "unresolved";
    await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
  }
  private async reconcile(): Promise<void> {
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
    const pending = this.pending;
    if (!pending) { this.phase = "idle"; return; }
    if ((pending.intent.kind === "session.stop") !== (this.options.lane === "stop")) throw new PendingStoreError("invalid");
    if (pending.mismatch) { await this.markMismatch(pending); return; }
    let reply: WrittenStatus;
    try { reply = await this.options.check(copyWrittenIntent(pending.intent)); }
    catch (error: unknown) {
      if (!this.live()) return;
      if (error instanceof ApiError && error.kind === "http" && error.status === 409 && error.code === "COMMAND_PAYLOAD_MISMATCH") {
        await this.markMismatch(pending); return;
      }
      throw error;
    }
    if (!this.live()) return;
    if (reply.outcome === "accepted") { await this.settle(reply); return; }
    if (!this.observe(reply.state_version)) this.problem = "stale_response";
    else if (!sameId(reply.current.profile_id, this.options.profileId)) this.problem = "profile_changed";
    else if (reply.current.access.status !== "admitted") this.problem = "forbidden";
    else if (reply.closed_session !== undefined) {
      if (!sameId(reply.closed_session.session_id, pending.intent.session_id)) this.problem = "step_changed";
      else {
        // Only one locked observation of absence plus final closure proves non-application.
        this.outcome = "not_applied"; this.closedSession = structuredClone(reply.closed_session);
        await this.clearSettled(); return;
      }
    } else if (pending.clientInstanceId !== this.options.clientInstanceId) this.problem = "client_changed";
    else if (pending.pair !== this.options.pair || `${reply.current.dictionary_language}-de` !== pending.pair) this.problem = "pair_changed";
    else if (pending.intent.kind === "result.grade") {
      const read = await this.options.readResult(pending.intent);
      if (!this.live()) return;
      if (!this.observe(read.state_version, read.step)) this.problem = "stale_response";
      else {
        this.answer = this.current !== null && "pair" in this.current
          ? structuredClone({ action: read.action, result: read.result, capabilities: read.capabilities }) : null;
        this.problem = revisionRetryProblem(pending.intent, read, pending.pair);
        this.retryVerified = this.problem === "not_found";
      }
    } else {
      const read = await this.options.read(pending.intent.session_id);
      if (!this.live()) return;
      if (!this.observe(read.state_version, read.current)) this.problem = "stale_response";
      else {
        this.problem = retryProblem(pending.intent, read.current, pending.pair);
        this.retryVerified = this.problem === "not_found";
      }
    }
    this.phase = "unresolved";
  }
  /** Reload checks the original ID and never sends a command automatically. */
  refresh(): Promise<void> { return this.run(() => this.reconcile()); }

  private retryFresh(): boolean {
    if (this.fresh()) return true;
    this.retryVerified = false; this.problem = "stale_response"; this.phase = "unresolved";
    return false;
  }
  private async sendPending(retry = false): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.live()) return;
    if (retry && (!this.retryVerified || !this.retryFresh())) return;
    this.phase = "sending"; this.problem = null; this.retryVerified = false; this.clearCurrent(); this.emit();
    if (!this.live() || retry && !this.retryFresh()) return;
    await this.options.pendingStore.save(pending, this.lifetime.signal);
    if (!this.live() || retry && !this.retryFresh()) return;
    const reply = await this.options.send(copyWrittenIntent(pending.intent));
    if (!this.live()) return;
    if (reply.outcome === "mismatch") {
      this.observe(reply.state_version);
      await this.markMismatch(pending);
    } else await this.settle(reply);
  }
  begin(action: WrittenTransition): Promise<void> {
    if (!this.live() || this.running || !this.loaded || this.pending || !["idle", "settled"].includes(this.phase)) {
      return this.running ?? Promise.resolve();
    }
    if (Object.hasOwn(action, "command_id")) return Promise.reject(new Error("invalid written action"));
    const intent = { ...action, command_id: this.options.newId() } as WrittenIntent;
    if (!validWrittenIntent(intent) || (intent.kind === "session.stop") !== (this.options.lane === "stop")) {
      return Promise.reject(new Error("invalid written action"));
    }
    const pending: WrittenPending = { schemaVersion: 1, profileId: this.options.profileId,
      clientInstanceId: this.options.clientInstanceId, pair: this.options.pair, intent: copyWrittenIntent(intent) };
    return this.run(async () => {
      this.outcome = null; this.resolved = null; this.rejectionCode = null; this.pending = pending;
      await this.sendPending();
    });
  }
  /** A manual retry checks the same ID again, then sends exactly the retained intent. */
  retry(): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(async () => {
      await this.reconcile();
      if (!this.live()) return;
      if (this.retryVerified && this.pending && !this.pending.mismatch && !this.outcome) await this.sendPending(true);
    });
  }
  dispose(): void { this.lifetime.abort(); this.clearCurrent(); this.phase = "disposed"; }
}

/** A missing acceptance fact authorizes no effect; retry only the same still-valid target. */
function retryProblem(intent: Exclude<WrittenIntent, WrittenRevisionIntent>, current: WrittenSessionRead["current"], pair: string): WrittenCommandSnapshot["problem"] {
  if (!sameId(current.session_id, intent.session_id)) return "step_changed";
  if (current.status === "closed") return "closed";
  if (current.status === "unavailable") return "forbidden";
  if (current.status === "not_found") return intent.kind === "session.start" ? "not_found" : "step_changed";
  if (!("pair" in current)) return "forbidden";
  if (current.pair !== pair) return "pair_changed";
  const assignment = current.status === "active" ? current.assignment : null;
  switch (intent.kind) {
    case "session.start": return "step_changed";
    case "session.stop": return intent.payload.reason === "stop" || current.status === "summary" ? "not_found" : "step_changed";
    case "assignment.present": return assignment?.status === "prefetched" && sameId(assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "answer.submit": return assignment?.status === "presented" && sameId(assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
  }
}

function revisionRetryProblem(intent: WrittenRevisionIntent, read: WrittenResultRead, pair: string): WrittenCommandSnapshot["problem"] {
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
    || result.version !== intent.expected_result_version) return "step_changed";
  const target = capabilities.grades;
  if (target === null || !sameId(target.session_id, intent.session_id) || !sameId(target.assignment_id, intent.assignment_id)
    || !sameId(target.result_id, intent.result_id) || target.expected_result_version !== intent.expected_result_version
    || !target.values.includes(intent.payload.grade as 3 | 4 | 5)) return "step_changed";
  return "not_found";
}
