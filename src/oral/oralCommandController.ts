import { ApiError } from "../api/http";
import type { ClosedSessionBoundary, OralSessionProjection, UnavailableCurrent } from "../api/generated";
import { oneOf, sameId, uuid, version } from "../api/wireValidation";
import { PendingStoreError, type PendingSlot } from "../commands/pendingSlot";
import type { OralRead, OralReply, OralStatus } from "./oralApi";
import { copyOralIntent, validOralIntent, type OralIntent } from "./oralIntent";
import type { OralCommandLane, OralPending } from "./oralPending";

type WithoutId<T> = T extends unknown ? Omit<T, "command_id"> : never;
export type OralTransition = WithoutId<OralIntent>;
type Current = OralRead["current"] | UnavailableCurrent;
export type OralCommandSnapshot = {
  phase: "loading" | "idle" | "checking" | "sending" | "unresolved" | "blocked" | "settled" | "disposed";
  pending: boolean;
  kind: OralIntent["kind"] | null;
  sessionId: string | null;
  pendingIntent: OralIntent | null;
  outcome: "accepted" | "rejected" | "not_applied" | null;
  resolved: { commandId: string; kind: OralIntent["kind"]; sessionId: string;
    assignmentId?: string; actionId?: string; resultId?: string } | null;
  rejectionCode: string | null;
  problem: "network" | "storage" | "invalid_pending" | "pending_changed" | "mismatch" | "not_found"
    | "expired" | "forbidden" | "profile_changed" | "client_changed" | "pair_changed" | "step_changed"
    | "closed" | "stale_response" | null;
  canRetry: boolean;
  current: Current | null;
  closedSession: ClosedSessionBoundary | null;
  stateVersion: string | null;
};
type Options = {
  profileId: string;
  clientInstanceId: string;
  pair: OralSessionProjection["pair"];
  lane: OralCommandLane;
  pendingStore: PendingSlot<OralPending>;
  isLive(): boolean;
  newId(): string;
  send(intent: OralIntent): Promise<OralReply>;
  /** Verify the full intent against the persisted server hash before returning
   * accepted, as createOralApi.status does. A mismatch throws ApiError HTTP 409. */
  check(intent: OralIntent): Promise<OralStatus>;
  read(sessionId: string): Promise<OralRead>;
  onUpdate(snapshot: OralCommandSnapshot): void;
  stateVersion?: string;
  minimumStateVersion?(): string | null;
};

/** Own one addressed intent. Access callbacks belong to one immutable document lifetime. */
export class OralCommandController {
  private readonly options: Readonly<Options>;
  private readonly lifetime = new AbortController();
  private phase: OralCommandSnapshot["phase"] = "loading";
  private problem: OralCommandSnapshot["problem"] = null;
  private pending: OralPending | null = null;
  private outcome: OralCommandSnapshot["outcome"] = null;
  private resolved: OralCommandSnapshot["resolved"] = null;
  private rejectionCode: string | null = null;
  private current: Current | null = null;
  private closedSession: ClosedSessionBoundary | null = null;
  private floor: string | null;
  private sharedFloor: string | null = null;
  private loaded = false;
  private running: Promise<void> | null = null;
  private retryVerified = false;

  constructor(options: Options) {
    if (!uuid(options.profileId) || !uuid(options.clientInstanceId) || !oneOf(options.pair, ["ru-de", "uk-de", "en-de"])
      || !oneOf(options.lane, ["study", "stop"])
      || options.stateVersion !== undefined && !version(options.stateVersion)) throw new Error("invalid oral context");
    this.options = { ...options };
    this.floor = options.stateVersion ?? null;
  }
  private live(): boolean { return !this.lifetime.signal.aborted && this.options.isLive(); }
  private minimumVersion(): string | null {
    const external = this.options.minimumStateVersion?.() ?? null;
    if (external !== null && !version(external)) throw new Error("invalid shared oral version");
    // Remember the shared floor even if its publisher subsequently disappears.
    if (external !== null && (this.sharedFloor === null || BigInt(external) > BigInt(this.sharedFloor))) this.sharedFloor = external;
    return this.sharedFloor !== null && (this.floor === null || BigInt(this.sharedFloor) > BigInt(this.floor))
      ? this.sharedFloor : this.floor;
  }
  private fresh(): boolean {
    const minimum = this.minimumVersion();
    return minimum === null || this.floor !== null && BigInt(this.floor) >= BigInt(minimum);
  }
  snapshot(): OralCommandSnapshot {
    const live = this.live(), fresh = live && this.fresh();
    const ownPending = live && this.pending?.clientInstanceId === this.options.clientInstanceId
      && this.pending.pair === this.options.pair
      && !["profile_changed", "client_changed", "pair_changed", "forbidden", "expired"].includes(this.problem ?? "");
    return { phase: live ? this.phase : "disposed", pending: this.pending !== null,
      kind: this.pending?.intent.kind ?? null, sessionId: this.pending?.intent.session_id ?? null,
      pendingIntent: ownPending ? copyOralIntent(this.pending!.intent) : null,
      outcome: this.outcome, resolved: live && this.resolved ? { ...this.resolved } : null,
      rejectionCode: live ? this.rejectionCode : null, problem: this.problem,
      canRetry: live && fresh && !this.running && this.retryVerified && this.pending !== null && !this.pending.mismatch
        && this.outcome === null && this.pending.clientInstanceId === this.options.clientInstanceId
        && this.pending.pair === this.options.pair,
      current: live && fresh ? structuredClone(this.current) : null,
      closedSession: live && fresh ? structuredClone(this.closedSession) : null, stateVersion: this.floor };
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    const task = Promise.resolve().then(() => { if (this.live()) return action(); }).catch((error: unknown) => {
      if (!this.live()) return;
      this.retryVerified = false;
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
  private clearCurrent(): void { this.current = null; this.closedSession = null; }
  private observe(stateVersion: string, current?: Current): boolean {
    const minimum = this.minimumVersion();
    if (!version(stateVersion) || minimum !== null && BigInt(stateVersion) < BigInt(minimum)) return false;
    this.floor = stateVersion;
    if (current !== undefined) this.current = "pair" in current && current.pair !== this.options.pair
      ? null : structuredClone(current);
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
  private async settle(reply: OralReply | Extract<OralStatus, { outcome: "accepted" }>): Promise<void> {
    this.outcome = reply.outcome === "accepted" ? "accepted" : "rejected";
    const intent = this.pending!.intent;
    this.resolved = { commandId: intent.command_id, kind: intent.kind, sessionId: intent.session_id };
    if (reply.outcome === "accepted" && intent.kind === "oral.grade") {
      this.resolved.assignmentId = intent.assignment_id;
      if (uuid(reply.command.action_id)) this.resolved.actionId = reply.command.action_id;
      if (uuid(reply.command.result_id)) this.resolved.resultId = reply.command.result_id;
    }
    this.rejectionCode = reply.outcome === "rejected" ? reply.error.code : null;
    if (!this.observe(reply.state_version, reply.current)) this.clearCurrent();
    await this.clearSettled();
  }

  private async markMismatch(pending: OralPending): Promise<void> {
    if (!this.live()) return;
    // Keep knowledge in memory before storage: a failed marker must never permit
    // this owner to query another payload's accepted fact or retry its POST.
    this.pending = { ...pending, mismatch: true };
    this.retryVerified = false; this.outcome = null; this.resolved = null; this.rejectionCode = null;
    this.clearCurrent(); this.problem = "mismatch"; this.phase = "unresolved";
    await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
    if (!this.live()) return;
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
    let reply: OralStatus;
    try { reply = await this.options.check(copyOralIntent(pending.intent)); }
    catch (error: unknown) {
      if (!this.live()) return;
      if (error instanceof ApiError && error.kind === "http" && error.status === 409
        && error.code === "COMMAND_PAYLOAD_MISMATCH") {
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
        // Only an atomic absence + closure observation proves non-application.
        this.outcome = "not_applied"; this.closedSession = structuredClone(reply.closed_session);
        await this.clearSettled(); return;
      }
    } else if (pending.clientInstanceId !== this.options.clientInstanceId) this.problem = "client_changed";
    else if (pending.pair !== this.options.pair || `${reply.current.dictionary_language}-de` !== pending.pair) this.problem = "pair_changed";
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
  }
  /** Reload checks the original UUID and never sends a command automatically. */
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
    const reply = await this.options.send(copyOralIntent(pending.intent));
    if (!this.live()) return;
    if (reply.outcome === "mismatch") {
      this.observe(reply.state_version);
      await this.markMismatch(pending);
    } else await this.settle(reply);
  }
  begin(action: OralTransition): Promise<void> {
    if (!this.live() || this.running || !this.loaded || this.pending || !["idle", "settled"].includes(this.phase)) {
      return this.running ?? Promise.resolve();
    }
    const candidate = { ...action, command_id: this.options.clientInstanceId };
    if (Object.hasOwn(action, "command_id") || !validOralIntent(candidate) || (candidate.kind === "session.stop") !== (this.options.lane === "stop")) {
      return Promise.reject(new Error("invalid oral action"));
    }
    const intent = copyOralIntent(candidate);
    intent.command_id = this.options.newId();
    if (!validOralIntent(intent)) return Promise.reject(new Error("invalid oral command ID"));
    const pending: OralPending = { schemaVersion: 1, profileId: this.options.profileId,
      clientInstanceId: this.options.clientInstanceId, pair: this.options.pair, intent };
    return this.run(async () => {
      this.outcome = null; this.resolved = null; this.rejectionCode = null; this.pending = pending;
      await this.sendPending();
    });
  }
  /** A manual retry obtains new proof, then sends exactly the retained intent. */
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

function retryProblem(intent: OralIntent, current: OralRead["current"], pair: string): OralCommandSnapshot["problem"] {
  if (!sameId(current.session_id, intent.session_id)) return "step_changed";
  if (current.status === "closed") return "closed";
  if (current.status === "unavailable") return "forbidden";
  if (current.status === "not_found") return intent.kind === "session.start" ? "not_found" : "step_changed";
  if (!("pair" in current)) return "forbidden";
  if (current.pair !== pair) return "pair_changed";
  const assignment = current.assignment, capabilities = current.capabilities;
  switch (intent.kind) {
    case "session.start": return "step_changed";
    case "session.stop": return intent.payload.reason === "stop" ? capabilities.stop ? "not_found" : "step_changed"
      : current.status === "summary" && capabilities.summary_home ? "not_found" : "step_changed";
    case "assignment.present": return current.status === "active" && assignment?.status === "prefetched"
      && sameId(assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "oral.reveal": return current.status === "active" && assignment?.status === "presented" && !assignment.revealed
      && sameId(assignment.id, intent.assignment_id) && sameId(capabilities.reveal_target, intent.assignment_id) ? "not_found" : "step_changed";
    case "oral.grade": return current.status === "active" && assignment?.status === "presented" && assignment.revealed
      && sameId(assignment.id, intent.assignment_id) && sameId(capabilities.grade_target, intent.assignment_id) ? "not_found" : "step_changed";
  }
}
