import { ApiError } from "../api/http";
import type { ClosedSessionBoundary, ConjugationCatalog, ConjugationSessionProjection, UnavailableCurrent } from "../api/generated";
import { oneOf, sameId, uuid, version } from "../api/wireValidation";
import { PendingStoreError, type PendingSlot } from "../commands/pendingSlot";
import type { ConjugationCatalogRead, ConjugationSessionRead, ConjugationResultRead, ConjugationReply, ConjugationStatus } from "./conjugationApi";
import { validConjugationIntent, type ConjugationIntent } from "./conjugationIntent";
import { canonicalConjugationIntent, conjugationLane, type ConjugationCommandLane, type ConjugationPending } from "./conjugationPending";
import { conjugationResultCurrent, validConjugationCatalog, validConjugationCurrent, type ConjugationResultCurrent } from "./conjugationProjection";

type WithoutId<T> = T extends unknown ? Omit<T, "command_id"> : never;
export type ConjugationTransition = WithoutId<ConjugationIntent>;
export type ConjugationRead = ConjugationCatalogRead | ConjugationSessionRead | ConjugationResultRead;
export type ConjugationCommandView =
  | { kind: "catalog"; current: ConjugationCatalog | UnavailableCurrent }
  | { kind: "session"; current: ConjugationSessionRead["current"] | UnavailableCurrent }
  | ({ kind: "result" } & ConjugationResultCurrent);
export type ConjugationCommandSnapshot = {
  phase: "loading" | "idle" | "checking" | "sending" | "unresolved" | "blocked" | "settled" | "disposed";
  pending: boolean;
  kind: ConjugationIntent["kind"] | null;
  sessionId: string | null;
  pendingIntent: ConjugationIntent | null;
  outcome: "accepted" | "rejected" | "not_applied" | null;
  resolved: { commandId: string; kind: ConjugationIntent["kind"]; sessionId: string | null;
    assignmentId?: string; actionId?: string; resultId?: string; objectVersion?: string | null } | null;
  rejectionCode: string | null;
  problem: "network" | "invalid_response" | "storage" | "invalid_pending" | "pending_changed" | "mismatch" | "not_found"
    | "expired" | "forbidden" | "profile_changed" | "client_changed" | "pair_changed" | "step_changed"
    | "closed" | "stale_response" | null;
  canRetry: boolean;
  stateVersion: string | null;
  closedSession: ClosedSessionBoundary | null;
  view: ConjugationCommandView | null;
};
export type ConjugationCommandOptions = {
  profileId: string;
  clientInstanceId: string;
  pair: ConjugationSessionProjection["pair"];
  lane: ConjugationCommandLane;
  pendingStore: PendingSlot<ConjugationPending>;
  isLive(): boolean;
  newId(): string;
  send(intent: ConjugationIntent): Promise<ConjugationReply>;
  /** Must use the proof-validating createConjugationApi.status. */
  check(intent: ConjugationIntent): Promise<ConjugationStatus>;
  /** schedule -> catalog; revisions -> original session/assignment/result;
   * start/present/unknown answer/stop -> original session. Never infer an answer result ID. */
  read(intent: ConjugationIntent): Promise<ConjugationRead>;
  onUpdate(snapshot: ConjugationCommandSnapshot): void;
  stateVersion?: string;
  minimumStateVersion?(): string | null;
};

/** Owns one durable intent, never screen navigation. Dependencies are copied once.
 * All callbacks capture one immutable document lifetime. Inside access.run they
 * must check this owner's isLive after transport await, BEFORE returning or
 * rethrowing a denial; shared OpenedAccess alone cannot guard a disposed owner.
 * This Module does not create access, screens, transport, or storage instances. */
export class ConjugationCommandController {
  private readonly options: Readonly<ConjugationCommandOptions>;
  private readonly lifetime = new AbortController();
  private phase: ConjugationCommandSnapshot["phase"] = "loading";
  private problem: ConjugationCommandSnapshot["problem"] = null;
  private pending: ConjugationPending | null = null;
  private outcome: ConjugationCommandSnapshot["outcome"] = null;
  private resolved: ConjugationCommandSnapshot["resolved"] = null;
  private rejectionCode: string | null = null;
  private view: ConjugationCommandView | null = null;
  private closedSession: ClosedSessionBoundary | null = null;
  private floor: string | null;
  private sharedFloor: string | null = null;
  private loaded = false;
  private running: Promise<void> | null = null;
  private retryVerified = false;
  private ownIdentity = true;
  private changedSlot = false;

  constructor(options: ConjugationCommandOptions) {
    if (!uuid(options.profileId) || !uuid(options.clientInstanceId) || !oneOf(options.pair, ["ru-de", "uk-de", "en-de"])
      || !oneOf(options.lane, ["catalog", "study", "stop"])
      || options.stateVersion !== undefined && !version(options.stateVersion)) throw new Error("invalid conjugation context");
    this.options = { ...options, profileId: options.profileId.toLowerCase(), clientInstanceId: options.clientInstanceId.toLowerCase() };
    this.floor = options.stateVersion ?? null;
  }
  private live(): boolean {
    if (this.lifetime.signal.aborted) return false;
    if (!this.options.isLive()) { this.lifetime.abort(); return false; }
    return true;
  }
  private minimumVersion(): string | null {
    const external = this.options.minimumStateVersion?.() ?? null;
    if (external !== null && !version(external)) throw new Error("invalid shared conjugation version");
    if (external !== null && (this.sharedFloor === null || BigInt(external) > BigInt(this.sharedFloor))) this.sharedFloor = external;
    return this.sharedFloor !== null && (this.floor === null || BigInt(this.sharedFloor) > BigInt(this.floor)) ? this.sharedFloor : this.floor;
  }
  private fresh(): boolean {
    const minimum = this.minimumVersion();
    return minimum === null || this.floor !== null && BigInt(this.floor) >= BigInt(minimum);
  }
  snapshot(): ConjugationCommandSnapshot {
    const live = this.live(), fresh = live && this.fresh();
    const visible = live && this.ownIdentity && !["profile_changed", "client_changed", "pair_changed", "expired", "forbidden"].includes(this.problem ?? "");
    return { phase: live ? this.phase : "disposed", pending: this.pending !== null,
      kind: visible ? this.pending?.intent.kind ?? null : null,
      sessionId: visible && this.pending && "session_id" in this.pending.intent ? this.pending.intent.session_id : null,
      pendingIntent: visible && fresh && this.pending ? canonicalConjugationIntent(this.pending.intent) : null,
      outcome: live ? this.outcome : null, resolved: visible && this.resolved ? { ...this.resolved } : null,
      rejectionCode: visible ? this.rejectionCode : null, problem: this.problem,
      canRetry: visible && fresh && !this.running && this.retryVerified && this.pending !== null && !this.pending.mismatch && this.outcome === null,
      stateVersion: this.floor, closedSession: visible && fresh ? structuredClone(this.closedSession) : null,
      view: visible && fresh ? structuredClone(this.view) : null };
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    const task = Promise.resolve().then(() => { if (this.live()) return action(); }).catch((error: unknown) => {
      if (!this.live()) return;
      this.retryVerified = false;
      if (!this.outcome) this.clearView();
      if (error instanceof PendingStoreError) {
        this.problem = error.kind === "invalid" ? "invalid_pending" : error.kind === "changed" ? "pending_changed" : "storage";
        if (error.kind === "changed") this.changedSlot = true;
      } else if (error instanceof ApiError && [401, 403].includes(error.status ?? 0)) this.problem = error.status === 401 ? "expired" : "forbidden";
      // A reply that failed strict parsing leaves the outcome unknown like a lost one, but it is not a lost connection.
      else if (error instanceof ApiError && error.kind === "invalid_response") this.problem = "invalid_response";
      else this.problem = "network";
      this.phase = this.pending ? "unresolved" : "blocked";
    }).finally(() => { if (this.running === task) this.running = null; this.emit(); });
    this.running = task;
    return task;
  }
  private clearView(): void { this.view = null; this.closedSession = null; }
  private observe(stateVersion: string): boolean {
    const minimum = this.minimumVersion();
    if (!version(stateVersion) || minimum !== null && BigInt(stateVersion) < BigInt(minimum)) return false;
    this.floor = stateVersion;
    return true;
  }
  private addressedView(intent: ConjugationIntent, read: ConjugationRead | ConjugationReply | Extract<ConjugationStatus, { outcome: "accepted" }>, result = false): ConjugationCommandView | null {
    if (intent.kind === "conjugation.schedule" && "current" in read) {
      const current = read.current;
      return validConjugationCatalog(current) && current.pair === this.options.pair ? { kind: "catalog", current: structuredClone(current) }
        : "status" in current && current.status === "unavailable" ? { kind: "catalog", current: { status: "unavailable" } } : null;
    }
    if (intent.kind === "conjugation.schedule") return null;
    if (result && "step" in read && "assignment_id" in intent) {
      const view = conjugationResultCurrent(read as unknown as Record<string, unknown>, intent);
      if (!view || "pair" in view.step && view.step.pair !== this.options.pair) return null;
      return { kind: "result", ...structuredClone(view) };
    }
    if (!("current" in read)) return null;
    const current = read.current;
    if (validConjugationCurrent(current, intent.session_id)) {
      return "pair" in current && current.pair !== this.options.pair ? null : { kind: "session", current: structuredClone(current) };
    }
    return "status" in current && current.status === "unavailable" && !("session_id" in current)
      ? { kind: "session", current: { status: "unavailable" } } : null;
  }
  private async clearSettled(): Promise<void> {
    if (!this.outcome || !this.live()) return;
    if (this.pending) await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null; this.problem = null; this.retryVerified = false; this.phase = "settled";
  }
  private address(intent: ConjugationIntent): NonNullable<ConjugationCommandSnapshot["resolved"]> {
    return { commandId: intent.command_id, kind: intent.kind, sessionId: "session_id" in intent ? intent.session_id : null,
      ...("assignment_id" in intent ? { assignmentId: intent.assignment_id } : {}) };
  }
  private async settle(reply: Exclude<ConjugationReply, { outcome: "mismatch" }> | Extract<ConjugationStatus, { outcome: "accepted" }>): Promise<void> {
    if (!this.live() || !this.pending) return;
    const intent = this.pending.intent;
    this.outcome = reply.outcome === "accepted" ? "accepted" : "rejected";
    this.resolved = this.address(intent);
    if (reply.outcome === "accepted") {
      this.resolved.objectVersion = reply.command.object_version;
      if (uuid(reply.command.action_id)) this.resolved.actionId = reply.command.action_id;
      if (uuid(reply.command.result_id)) this.resolved.resultId = reply.command.result_id;
    }
    this.rejectionCode = reply.outcome === "rejected" && "error" in reply ? reply.error.code : null;
    if (this.observe(reply.state_version) && this.ownIdentity) this.view = this.addressedView(intent, reply, "step" in reply);
    else this.clearView();
    await this.clearSettled();
  }
  private async markMismatch(pending: ConjugationPending): Promise<void> {
    if (!this.live()) return;
    this.pending = { ...pending, mismatch: true };
    this.retryVerified = false; this.outcome = null; this.resolved = null; this.rejectionCode = null;
    this.clearView(); this.problem = "mismatch"; this.phase = "unresolved";
    await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
    if (!this.live()) return;
  }
  private async reconcile(): Promise<void> {
    if (this.changedSlot) { this.problem = "pending_changed"; this.retryVerified = false; return; }
    this.phase = "checking"; this.problem = null; this.retryVerified = false;
    if (!this.outcome) this.clearView();
    this.emit();
    if (!this.live()) return;
    if (!this.loaded) {
      const pending = await this.options.pendingStore.load(this.options.profileId, this.lifetime.signal);
      if (!this.live()) return;
      this.pending = pending; this.loaded = true;
      this.ownIdentity = !pending || sameId(pending.clientInstanceId, this.options.clientInstanceId) && pending.pair === this.options.pair;
    }
    if (this.outcome) { await this.clearSettled(); return; }
    const pending = this.pending;
    if (!pending) { this.phase = "idle"; return; }
    if (conjugationLane(pending.intent) !== this.options.lane) throw new PendingStoreError("invalid");
    if (pending.mismatch) { await this.markMismatch(pending); return; }
    let reply: ConjugationStatus;
    try { reply = await this.options.check(canonicalConjugationIntent(pending.intent)); }
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
    else if (!sameId(pending.clientInstanceId, this.options.clientInstanceId)) this.problem = "client_changed";
    else if (pending.pair !== this.options.pair || `${reply.current.dictionary_language}-de` !== pending.pair) this.problem = "pair_changed";
    else if (reply.closed_session !== undefined) {
      if (pending.intent.kind === "conjugation.schedule" || !sameId(reply.closed_session.session_id, pending.intent.session_id)) this.problem = "step_changed";
      else {
        this.outcome = "not_applied"; this.resolved = this.address(pending.intent);
        this.closedSession = structuredClone(reply.closed_session);
        await this.clearSettled(); return;
      }
    } else {
      const read = await this.options.read(canonicalConjugationIntent(pending.intent));
      if (!this.live()) return;
      if (!this.observe(read.state_version)) this.problem = "stale_response";
      else {
        this.view = this.addressedView(pending.intent, read, resultAddressed(pending.intent));
        this.problem = retryProblem(pending.intent, this.view, pending.pair);
        this.retryVerified = this.problem === "not_found";
      }
    }
    this.phase = "unresolved";
  }
  /** Hydration and recovery are GET-only. */
  refresh(): Promise<void> { return this.run(() => this.reconcile()); }
  private freshForSend(): boolean {
    if (this.fresh()) return true;
    this.retryVerified = false; this.problem = "stale_response"; this.phase = "unresolved";
    return false;
  }
  private async sendPending(retry = false): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.live() || !this.freshForSend() || retry && !this.retryVerified) return;
    this.phase = "sending"; this.problem = null; this.retryVerified = false; this.clearView(); this.emit();
    if (!this.live() || !this.freshForSend()) return;
    await this.options.pendingStore.save(pending, this.lifetime.signal);
    if (!this.live() || !this.freshForSend()) return;
    let reply: ConjugationReply;
    try { reply = await this.options.send(canonicalConjugationIntent(pending.intent)); }
    catch (error: unknown) {
      if (!this.live()) return;
      if (error instanceof ApiError && error.kind === "http" && error.status === 409 && error.code === "COMMAND_PAYLOAD_MISMATCH") {
        await this.markMismatch(pending); return;
      }
      throw error;
    }
    if (!this.live()) return;
    if (reply.outcome === "mismatch") { this.observe(reply.state_version); await this.markMismatch(pending); }
    else await this.settle(reply);
  }
  begin(action: ConjugationTransition): Promise<void> {
    if (!this.live() || this.running || !this.loaded || this.pending || !["idle", "settled"].includes(this.phase)) return this.running ?? Promise.resolve();
    const candidate = { ...action, command_id: this.options.clientInstanceId };
    if (Object.hasOwn(action, "command_id") || !validConjugationIntent(candidate) || conjugationLane(candidate) !== this.options.lane) return Promise.reject(new Error("invalid conjugation action"));
    let intent: ConjugationIntent;
    try { intent = canonicalConjugationIntent(candidate); }
    catch (error: unknown) { return Promise.reject(error); }
    intent.command_id = this.options.newId();
    if (!validConjugationIntent(intent)) return Promise.reject(new Error("invalid conjugation command ID"));
    const pending: ConjugationPending = { schemaVersion: 1, profileId: this.options.profileId,
      clientInstanceId: this.options.clientInstanceId, pair: this.options.pair, intent: canonicalConjugationIntent(intent) };
    return this.run(async () => {
      this.outcome = null; this.resolved = null; this.rejectionCode = null; this.ownIdentity = true; this.pending = pending;
      await this.sendPending();
    });
  }
  /** Fresh addressed check/read precedes every manual resend of the SAME UUID and payload. */
  retry(): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(async () => {
      await this.reconcile();
      if (!this.live()) return;
      if (this.retryVerified && this.pending && !this.pending.mismatch && !this.outcome) await this.sendPending(true);
    });
  }
  dispose(): void { this.lifetime.abort(); this.clearView(); this.phase = "disposed"; }
}

/** The intents addressed to one saved result: their reply and their retry check are that result's view. */
export function resultAddressed(intent: ConjugationIntent): intent is Extract<ConjugationIntent, { kind: "result.grade" | "result.correct" | "result.undo" }> {
  return intent.kind === "result.grade" || intent.kind === "result.correct" || intent.kind === "result.undo";
}

function retryProblem(intent: ConjugationIntent, view: ConjugationCommandView | null, pair: string): ConjugationCommandSnapshot["problem"] {
  if (!view) return "step_changed";
  if (intent.kind === "conjugation.schedule") {
    if (view.kind !== "catalog" || !("pair" in view.current)) return "forbidden";
    if (view.current.pair !== pair) return "pair_changed";
    return view.current.items.some(item => sameId(item.base_verb_id, intent.payload.base_verb_id)
      && item.tense === intent.payload.tense && item.can_schedule) ? "not_found" : "step_changed";
  }
  const step = view.kind === "result" ? view.step : view.kind === "session" ? view.current : null;
  if (!step || !("session_id" in step) || !sameId(step.session_id, intent.session_id)) return "step_changed";
  if (step.status === "closed") return "closed";
  if (step.status === "unavailable") return "forbidden";
  if (step.status === "not_found") return intent.kind === "session.start" ? "not_found" : "step_changed";
  if (!("pair" in step) || step.mode !== "conjugation" || step.pair !== pair) return "pair_changed";
  if (resultAddressed(intent)) {
    if (view.kind !== "result") return "step_changed";
    const { action, result, capabilities } = view;
    if (!result || !action || result.status !== "active" || action.status !== "active"
      || !sameId(result.result_id, intent.result_id) || !sameId(result.assignment_id, intent.assignment_id)
      || result.version !== intent.expected_result_version || action.version !== result.version) return "step_changed";
    // An undo is resent only while the server still grants exactly this right: a lost one is never created again (CT 2.3).
    // The decoder already ties undo_target.action_id to the action of this view.
    const target = intent.kind === "result.undo" ? capabilities.undo_target
      : intent.kind === "result.correct" ? capabilities.correct_target : capabilities.grades;
    if (!target || !sameId(target.session_id, intent.session_id) || !sameId(target.assignment_id, intent.assignment_id)
      || !sameId(target.result_id, intent.result_id) || target.expected_result_version !== intent.expected_result_version) return "step_changed";
    if (intent.kind === "result.grade" && !capabilities.grades?.values.includes(intent.payload.grade as 3 | 4 | 5)) return "step_changed";
    return "not_found";
  }
  const caps = step.capabilities;
  switch (intent.kind) {
    case "session.start": return "step_changed";
    case "session.stop": return intent.payload.reason === "stop" ? caps.stop ? "not_found" : "step_changed"
      : step.status === "summary" && caps.summary_home ? "not_found" : "step_changed";
    case "assignment.present": return step.status === "active" && step.assignment?.status === "prefetched"
      && sameId(step.assignment.id, intent.assignment_id) ? "not_found" : "step_changed";
    case "answer.submit": return step.status === "active" && step.assignment?.status === "presented"
      && sameId(step.assignment.id, intent.assignment_id) && sameId(caps.answer_target, intent.assignment_id) ? "not_found" : "step_changed";
  }
}
