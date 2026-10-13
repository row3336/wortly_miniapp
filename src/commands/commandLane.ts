import { ApiError } from "../api/http";
import type { ClosedSessionBoundary, Profile } from "../api/generated";
import { exactKeys, oneOf, record, sameId, uuid, version } from "../api/wireValidation";
import { sendableIntent } from "./closeIntent";
import { PendingStoreError, refusedUnsent, type PendingSlot } from "./pendingSlot";

export type CommandPhase = "loading" | "idle" | "checking" | "sending" | "unresolved" | "blocked" | "settled" | "disposed";
export type CommandProblem = "network" | "storage" | "invalid_pending" | "pending_changed" | "mismatch" | "not_found"
  | "expired" | "forbidden" | "profile_changed" | "client_changed" | "pair_changed" | "step_changed"
  | "closed" | "stale_response"
  // Known refusals of a write that is not a lost reply: a planned pause (503 MAINTENANCE, К14-021) and an outdated
  // client (409 CLIENT_INCOMPATIBLE, К10-059). Both leave the intent unknown and checkable like "network".
  | "maintenance" | "incompatible"
  // 409 DOCUMENT_STALE: a newer window of this installation owns the document. Not a lost reply (the write was refused
  // before it began) and not a refusal of the intent: the record stays for a live window to check (C091 §1).
  | "window_stale";
export type CommandOutcome = "accepted" | "rejected" | "not_applied";
export type Pair = "ru-de" | "uk-de" | "en-de";
export type LaneIntent = { command_id: string; kind: string; session_id: string };
export type WithoutId<T> = T extends unknown ? Omit<T, "command_id"> : never;
/** The durable record of one intent: the owner, the client and the pair it was created for. */
export type LanePending<I extends LaneIntent> = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  pair: Pair;
  intent: I;
  mismatch?: true;
};
/** The exact envelope of a durable record whose intent validIntent accepts. */
export function validLanePending<I extends LaneIntent>(value: unknown, validIntent: (intent: unknown) => intent is I): value is LanePending<I> {
  return record(value) && exactKeys(value, ["schemaVersion", "profileId", "clientInstanceId", "pair", "intent",
    ...(Object.hasOwn(value, "mismatch") ? ["mismatch"] : [])])
    && value.schemaVersion === 1 && uuid(value.profileId) && uuid(value.clientInstanceId)
    && oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    && (!Object.hasOwn(value, "mismatch") || value.mismatch === true)
    && validIntent(value.intent);
}
/** A canonical copy of a valid record: a stable field order gives the shared slot an exact comparison. */
export function copyLanePending<I extends LaneIntent>(value: LanePending<I>, copyIntent: (intent: I) => I): LanePending<I> {
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId, pair: value.pair,
    intent: copyIntent(value.intent), ...(value.mismatch ? { mismatch: true } : {}) };
}
export type LaneResolved<K extends string> = {
  commandId: string; kind: K; sessionId: string;
  /**
   * The outcome is an old one: the first status check of this owner found it already on the server for an intent an
   * earlier owner left in the durable slot (a reload, a re-entry), and this owner never sent it. Its result was never
   * shown (decisions 20.1-А, 22.1-А). A request this owner started, even of the same intent, makes the outcome a live
   * one; a send stopped before its request (a failed save, a closed handle) does not.
   */
  restored?: true;
};
/** A not_found status of the same ID: the locked profile observation and, at most, the final closure of its session. */
export type MissingStatus = { outcome: "not_found"; state_version: string; current: Profile; closed_session?: ClosedSessionBoundary };
type Refused = { outcome: "rejected" | "mismatch"; error: { code: string } };

/** What every lane snapshot exposes; a mode adds its own projections (e.g. the written answer). */
export type LaneSnapshot<I extends LaneIntent, C, R> = {
  phase: CommandPhase;
  pending: boolean;
  kind: I["kind"] | null;
  sessionId: string | null;
  pendingIntent: I | null;
  outcome: CommandOutcome | null;
  resolved: R | null;
  rejectionCode: string | null;
  problem: CommandProblem | null;
  /** Seconds the server estimates for a planned pause (problem "maintenance"); 0 once the estimate has passed. */
  pauseSeconds?: number | null;
  canRetry: boolean;
  /**
   * The record carries the conflict mark of Я17 in memory. The stored copy may lack it when its write failed (then the
   * problem reads "storage"), so this, not the problem, says that the record is a conflict.
   */
  conflict?: boolean;
  current: C | null;
  closedSession: ClosedSessionBoundary | null;
  stateVersion: string | null;
};

/** Types of one mode's lane; the controller logic below is identical for all of them. */
export type LaneSpec = {
  intent: LaneIntent;
  lane: string;
  current: object;
  resolved: LaneResolved<string>;
  reply: { outcome: "accepted" | "rejected" | "mismatch"; state_version: string; error?: { code: string } };
  status: { outcome: "accepted"; state_version: string } | MissingStatus;
  read: { state_version: string; current: object };
  snapshot: LaneSnapshot<LaneIntent, object, LaneResolved<string>>;
};
export type LaneSettled<S extends LaneSpec> = S["reply"] | Extract<S["status"], { outcome: "accepted" }>;
export type LaneOptions<S extends LaneSpec> = {
  profileId: string;
  clientInstanceId: string;
  pair: Pair;
  lane: S["lane"];
  pendingStore: PendingSlot<LanePending<S["intent"]>>;
  isLive(): boolean;
  newId(): string;
  /**
   * transmitted, when given, must be called right before the request starts (automatic recovery counts it as a send
   * that may have gone out, CT §6.1 п. 4); a refusal before that point means nothing went out.
   */
  send(intent: S["intent"], transmitted?: () => void): Promise<S["reply"]>;
  /** Verifies the server fingerprint of the full intent; a different payload under this ID is an HTTP 409. */
  check(intent: S["intent"]): Promise<S["status"]>;
  read(sessionId: string): Promise<S["read"]>;
  onUpdate(snapshot: S["snapshot"]): void;
  /**
   * Called once when a NEW intent met another record in the shared slot before anything was sent (the proof: its save was
   * refused and the transport was never called). The record of the other window (X) is not this lane's: the owner that
   * wires this seam may check X by its own ID (decision 14.8.8.1 А, C117); the new intent is already dropped and never checked.
   * Unwired by this patch; PLAN_A connects it.
   */
  slotConflict?(): void;
  stateVersion?: string;
  minimumStateVersion?(): string | null;
};
/** Constant facts of a mode: its name in errors, its two lane names (the second is always Stop) and its canonical copy. */
export type LaneMode<S extends LaneSpec> = {
  label: string;
  lanes: readonly [S["lane"], S["lane"]];
  copy(intent: S["intent"]): S["intent"];
};

/** A failed exchange keeps its intent. Only a local store failure or a denial is named; anything else is a lost reply. */
export function failureProblem(error: unknown): CommandProblem {
  if (error instanceof PendingStoreError) return error.kind === "invalid" ? "invalid_pending"
    : error.kind === "changed" ? "pending_changed" : "storage";
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return error.status === 401 ? "expired" : "forbidden";
  if (error instanceof ApiError && error.kind === "http") {
    if (error.status === 503 && error.code === "MAINTENANCE") return "maintenance";
    if (error.status === 409 && error.code === "CLIENT_INCOMPATIBLE") return "incompatible";
    if (error.status === 409 && error.code === "DOCUMENT_STALE") return "window_stale";
  }
  return "network";
}

/**
 * A successful check that found its command absent on the same open step ("not_found", retryVerified) is a fact about the
 * command, not a failed refresh. It may hide the generic «could not refresh» line only when it is the ONLY current cause:
 * every lane problem is a not_found or none, at least one lane holds it, no lane carries a refusal, and nothing else
 * (a failed session read, a busy refusal, a foreign receipt: otherCause) is set. An older not_found of one lane never
 * hides a lost connection, a failed read or a stale answer found by the other.
 */
export function onlyCheckedAbsent(lanes: readonly { problem: string | null; rejectionCode: string | null }[], otherCause: string | null): boolean {
  return otherCause === null && lanes.some(lane => lane.problem === "not_found")
    && lanes.every(lane => (lane.problem === null || lane.problem === "not_found") && lane.rejectionCode === null);
}

/**
 * The context checks of a not_found status, before the target itself is read. "not_applied" needs one locked
 * observation of absence plus the final closure of exactly this session; null means the target must be verified.
 */
export function missingProblem(reply: MissingStatus, pending: LanePending<LaneIntent>,
  own: { profileId: string; clientInstanceId: string; pair: Pair }): CommandProblem | "not_applied" | null {
  if (!sameId(reply.current.profile_id, own.profileId)) return "profile_changed";
  if (reply.current.access.status !== "admitted") return "forbidden";
  if (reply.closed_session !== undefined) return sameId(reply.closed_session.session_id, pending.intent.session_id) ? "not_applied" : "step_changed";
  if (pending.clientInstanceId !== own.clientInstanceId) return "client_changed";
  if (pending.pair !== own.pair || `${reply.current.dictionary_language}-de` !== pending.pair) return "pair_changed";
  return null;
}

/** The shared prefix of every retry check: the same session, still open, of this pair; the mode then checks its target. */
export function retryStep<C extends { session_id: string; status: string }>(current: C, intent: LaneIntent,
  pair: string): CommandProblem | Extract<C, { pair: string }> {
  if (!sameId(current.session_id, intent.session_id)) return "step_changed";
  if (current.status === "closed") return "closed";
  if (current.status === "unavailable") return "forbidden";
  if (current.status === "not_found") return intent.kind === "session.start" ? "not_found" : "step_changed";
  if (!("pair" in current)) return "forbidden";
  if (current.pair !== pair) return "pair_changed";
  return current as Extract<C, { pair: string }>;
}

/**
 * What every lane shares literally: one step at a time, a failed step leaves its intent unknown (never a new command),
 * the durable intent is loaded once per owner. CommandLane adds the written/oral algorithm; Learning keeps its own.
 */
export abstract class LaneCore<I extends LaneIntent, Snapshot> {
  protected readonly lifetime = new AbortController();
  protected phase: CommandPhase = "loading";
  protected problem: CommandProblem | null = null;
  protected pauseSeconds: number | null = null;
  protected pending: LanePending<I> | null = null;
  protected outcome: CommandOutcome | null = null;
  protected loaded = false;
  protected running: Promise<void> | null = null;
  protected retryVerified = false;
  /** The pending intent came from the durable slot at this owner's first load and no request of it started here since. */
  protected inherited = false;
  /** The raw error of the last step that failed, for automatic recovery to classify (CP2); null after a clean step. */
  private failure: unknown = null;

  constructor(private readonly core: { profileId: string; pendingStore: PendingSlot<LanePending<I>>; isLive(): boolean;
    onUpdate(snapshot: Snapshot): void }) {}
  abstract snapshot(): Snapshot;
  protected abstract clearCurrent(): void;
  protected live(): boolean { return !this.lifetime.signal.aborted && this.core.isLive(); }
  protected emit(): void { if (this.live()) this.core.onUpdate(this.snapshot()); }
  protected run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    this.failure = null;
    const task = Promise.resolve().then(() => { if (this.live()) return action(); }).catch((error: unknown) => {
      if (!this.live()) return;
      this.failure = error;
      this.retryVerified = false;
      // A failed local cleanup must not erase an already confirmed result.
      if (!this.outcome) this.clearCurrent();
      this.problem = failureProblem(error);
      this.pauseSeconds = this.problem === "maintenance" && error instanceof ApiError ? error.pause?.waitSeconds ?? null : null;
      // A timeout keeps the same intent: it becomes unknown, never a new command.
      this.phase = this.pending ? "unresolved" : "blocked";
    }).finally(() => { if (this.running === task) this.running = null; this.emit(); });
    this.running = task;
    return task;
  }
  /** The first reconcile of this owner reads the durable intent; false when the owner died meanwhile. */
  protected async loadPending(): Promise<boolean> {
    if (!this.loaded) {
      this.pending = await this.core.pendingStore.load(this.core.profileId, this.lifetime.signal);
      if (!this.live()) return false;
      this.loaded = true; this.inherited = this.pending !== null;
    }
    return true;
  }
  /** A new intent needs a live, loaded and idle owner with no running step. */
  protected busy(): boolean {
    return !this.live() || !!this.running || !this.loaded || !!this.pending || !["idle", "settled"].includes(this.phase);
  }
  /**
   * The host tells this from the transport once the request of the current send is built, right before fetch: from now
   * on its outcome may come from this owner's own request (LaneResolved.restored).
   */
  sendStarted(): void { this.inherited = false; }
  /** A new intent of this page (decision 2.3 А): a record loaded from storage without this mark came from elsewhere. */
  protected noteCreated(commandId: string): void { this.core.pendingStore.noteCreated(commandId); }
  /** The error of the last step if it failed (a lost reply, a refusal, a closed handle); null otherwise. */
  lastFailure(): unknown { return this.failure; }
  /**
   * Automatic recovery proved that this intent will never apply (a definite refusal, a changed step: CT §6.1 п. 7): its
   * durable record is cleared as after a settled outcome, and the lane is free for the next action. A conflict
   * (mismatch) is never released here: its record waits for the confirmed closure (Я17).
   */
  release(commandId: string): Promise<void> {
    return this.run(async () => {
      const pending = this.pending;
      if (!pending || pending.mismatch || pending.intent.command_id !== commandId || this.outcome) return;
      await this.core.pendingStore.clear(pending, this.lifetime.signal);
      if (!this.live()) return;
      this.pending = null; this.problem = null; this.retryVerified = false; this.phase = "idle";
    });
  }
  /**
   * Я17 after the closure (CT §6.1 п. 10, D-CP4 3.1.1): the record of a conflict waits for the confirmed closure of its
   * own session and is then cleared, so a new session can start on this device. The caller passes only a conflict
   * (the lane's mark or the recovery machine's conflict) of a session the server confirmed closed; the stored copy may
   * lack the mark, so the slot compares the record without it. A record of another session stays.
   */
  releaseClosed(sessionId: string): Promise<void> {
    return this.run(async () => {
      const pending = this.pending;
      if (!pending || this.outcome || !sameId(pending.intent.session_id, sessionId)) return;
      await this.core.pendingStore.clearMarked(pending, this.lifetime.signal);
      if (!this.live()) return;
      this.pending = null; this.problem = null; this.retryVerified = false; this.phase = "idle";
    });
  }
  dispose(): void { this.lifetime.abort(); this.clearCurrent(); this.phase = "disposed"; }
}

/**
 * Own one addressed intent of one lane: one command_id per intent, kept through timeout, reload and manual retry.
 * A reload checks the original ID and never sends a command automatically; a manual retry checks the same ID again,
 * then sends exactly the retained intent. Modes supply only their intent rules, accepted address and target checks.
 */
export abstract class CommandLane<S extends LaneSpec, O extends LaneOptions<S> = LaneOptions<S>> extends LaneCore<S["intent"], S["snapshot"]> {
  protected readonly options: Readonly<O>;
  private readonly mode: LaneMode<S>;
  private resolved: S["resolved"] | null = null;
  private rejectionCode: string | null = null;
  protected current: S["current"] | null = null;
  private closedSession: ClosedSessionBoundary | null = null;
  private floor: string | null;
  private sharedFloor: string | null = null;

  constructor(options: O, mode: LaneMode<S>) {
    super(options);
    if (!uuid(options.profileId) || !uuid(options.clientInstanceId) || !oneOf(options.pair, ["ru-de", "uk-de", "en-de"])
      || !oneOf(options.lane, [...mode.lanes])
      || options.stateVersion !== undefined && !version(options.stateVersion)) throw new Error(`invalid ${mode.label} context`);
    this.options = { ...options };
    this.mode = mode;
    this.floor = options.stateVersion ?? null;
  }
  /** The intent of this action with a new command_id, already canonical, or the error that rejects it. */
  protected abstract intent(action: WithoutId<S["intent"]>): S["intent"] | Error;
  /** Server addresses that an accepted reply proves for this intent (e.g. its result). */
  protected abstract accept(intent: S["intent"], reply: LaneSettled<S> & { outcome: "accepted" }, resolved: S["resolved"]): void;
  /** Read the target of a pending intent with an unknown outcome; false when this owner died meanwhile. */
  protected abstract verify(pending: LanePending<S["intent"]>): Promise<boolean>;
  /** The projection a settled reply carries. */
  protected abstract settledCurrent(reply: LaneSettled<S>): object;
  /** Keep further facts of a settled reply whose projection was accepted. */
  protected settledView(_reply: LaneSettled<S>): void {}
  /** Add mode projections to the snapshot; visible says whether this owner may show server facts now. */
  protected extend(snapshot: LaneSnapshot<S["intent"], S["current"], S["resolved"]>, _visible: boolean): S["snapshot"] {
    return snapshot as S["snapshot"];
  }

  private minimumVersion(): string | null {
    const external = this.options.minimumStateVersion?.() ?? null;
    if (external !== null && !version(external)) throw new Error(`invalid shared ${this.mode.label} version`);
    // Remember the shared floor even if its publisher subsequently disappears.
    if (external !== null && (this.sharedFloor === null || BigInt(external) > BigInt(this.sharedFloor))) this.sharedFloor = external;
    return this.sharedFloor !== null && (this.floor === null || BigInt(this.sharedFloor) > BigInt(this.floor)) ? this.sharedFloor : this.floor;
  }
  private fresh(): boolean {
    const minimum = this.minimumVersion();
    return minimum === null || this.floor !== null && BigInt(this.floor) >= BigInt(minimum);
  }
  snapshot(): S["snapshot"] {
    const live = this.live(), fresh = live && this.fresh();
    const own = this.pending !== null && this.pending.clientInstanceId === this.options.clientInstanceId && this.pending.pair === this.options.pair;
    const ownPending = live && own && !["profile_changed", "client_changed", "pair_changed", "forbidden", "expired"].includes(this.problem ?? "");
    return this.extend({ phase: live ? this.phase : "disposed", pending: this.pending !== null,
      kind: this.pending?.intent.kind ?? null, sessionId: this.pending?.intent.session_id ?? null,
      pendingIntent: ownPending ? this.mode.copy(this.pending!.intent) : null,
      outcome: this.outcome, resolved: live && this.resolved ? { ...this.resolved } : null,
      rejectionCode: live ? this.rejectionCode : null, problem: this.problem,
      pauseSeconds: this.problem === "maintenance" ? this.pauseSeconds : null,
      canRetry: live && fresh && !this.running && this.retryVerified && own && !this.pending!.mismatch && this.outcome === null
        && sendableIntent(this.pending!.intent),
      conflict: this.pending?.mismatch === true,
      current: live && fresh ? structuredClone(this.current) : null,
      closedSession: live && fresh ? structuredClone(this.closedSession) : null, stateVersion: this.floor }, live && fresh);
  }
  protected clearCurrent(): void { this.current = null; this.closedSession = null; }
  /**
   * A projection of another pair is not this owner's to show or act on, with one exception: the settled receipt of this
   * owner's own record (its profile, its installation) proves the closure of exactly the session of that record, in the
   * pair the record was made for. Dropping that closure would leave an accepted receipt of the session without its end
   * (CT §6.1 п. 5, п. 7). It stays a closed fact of its own session: never an open step, never numbers of this pair.
   */
  private ownClosureOfOtherPair(pending: LanePending<S["intent"]>, current: object): boolean {
    return "pair" in current && current.pair !== this.options.pair && current.pair === pending.pair
      && "status" in current && current.status === "closed"
      && "session_id" in current && typeof current.session_id === "string" && sameId(current.session_id, pending.intent.session_id)
      && sameId(pending.profileId, this.options.profileId) && sameId(pending.clientInstanceId, this.options.clientInstanceId);
  }
  protected observe(stateVersion: string, current?: object, ownClosure = false): boolean {
    const minimum = this.minimumVersion();
    if (!version(stateVersion) || minimum !== null && BigInt(stateVersion) < BigInt(minimum)) return false;
    this.floor = stateVersion;
    if (current !== undefined) this.current = "pair" in current && current.pair !== this.options.pair && !ownClosure
      ? null : structuredClone(current) as S["current"];
    return true;
  }
  /** Read the session of a pending session command and check that its exact target still accepts a retry. */
  protected async verifySession(pending: LanePending<S["intent"]>,
    problem: (current: S["read"]["current"]) => CommandProblem): Promise<boolean> {
    const read = await this.options.read(pending.intent.session_id);
    if (!this.live()) return false;
    if (!this.observe(read.state_version, read.current)) this.problem = "stale_response";
    else {
      this.problem = problem(read.current);
      this.retryVerified = this.problem === "not_found";
    }
    return true;
  }
  private async clearSettled(): Promise<void> {
    if (!this.outcome || !this.live()) return;
    if (this.pending && !this.resolved) this.resolved = { commandId: this.pending.intent.command_id,
      kind: this.pending.intent.kind, sessionId: this.pending.intent.session_id } as S["resolved"];
    if (this.pending) await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null; this.problem = null; this.retryVerified = false; this.phase = "settled";
  }
  private async settle(reply: LaneSettled<S>, restored = false): Promise<void> {
    const intent = this.pending!.intent;
    this.outcome = reply.outcome === "accepted" ? "accepted" : "rejected";
    this.resolved = { commandId: intent.command_id, kind: intent.kind, sessionId: intent.session_id,
      ...(restored ? { restored: true } : {}) } as S["resolved"];
    // The exact accepted address is immutable evidence, even if its attached projection is stale.
    if (reply.outcome === "accepted") this.accept(intent, reply as LaneSettled<S> & { outcome: "accepted" }, this.resolved);
    this.rejectionCode = reply.outcome === "accepted" ? null : (reply as Refused).error.code;
    const current = this.settledCurrent(reply), ownClosure = this.ownClosureOfOtherPair(this.pending!, current);
    const otherPair = "pair" in current && current.pair !== this.options.pair;
    const observed = this.observe(reply.state_version, current, ownClosure);
    if (!observed) this.clearCurrent();
    // No projection of another pair, closed or open, carries a mode view (an answer, a result) into this pair.
    else if (!otherPair) this.settledView(reply);
    await this.clearSettled();
    // The accepted fact stays (the command applied), but its session is open in another pair: the pair changed
    // elsewhere and the server applied the command there (R1). This is no stale reply and no failed read; the reason is
    // set after the cleanup, which resets it. An own closure in another pair is its closed fact, never this reason.
    if (observed && otherPair && !ownClosure && reply.outcome === "accepted" && this.live()
      && !("status" in current && current.status === "closed")) this.problem = "pair_changed";
  }
  private async markMismatch(pending: LanePending<S["intent"]>): Promise<void> {
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
    if (!this.live() || !await this.loadPending()) return;
    if (this.outcome) { await this.clearSettled(); return; }
    const pending = this.pending;
    if (!pending) { this.phase = "idle"; return; }
    if ((pending.intent.kind === "session.stop") !== (this.options.lane === "stop")) throw new PendingStoreError("invalid");
    if (pending.mismatch) { await this.markMismatch(pending); return; }
    let reply: S["status"];
    try { reply = await this.options.check(this.mode.copy(pending.intent)); }
    catch (error: unknown) {
      if (!this.live()) return;
      if (error instanceof ApiError && error.kind === "http" && error.status === 409 && error.code === "COMMAND_PAYLOAD_MISMATCH") {
        await this.markMismatch(pending); return;
      }
      throw error;
    }
    if (!this.live()) return;
    if (reply.outcome === "accepted") { await this.settle(reply as LaneSettled<S>, this.inherited); return; }
    const missing = reply as MissingStatus;
    if (!this.observe(missing.state_version)) this.problem = "stale_response";
    else {
      const problem = missingProblem(missing, pending, this.options);
      if (problem === "not_applied") {
        // Only one locked observation of absence plus final closure proves non-application.
        this.outcome = "not_applied"; this.closedSession = structuredClone(missing.closed_session!);
        await this.clearSettled(); return;
      }
      if (problem !== null) this.problem = problem;
      else if (!await this.verify(pending)) return;
    }
    this.phase = "unresolved";
  }
  refresh(): Promise<void> { return this.run(() => this.reconcile()); }
  /**
   * Decision 14.8.8.1 А (owner, C117): a new action of this lane met another record in the shared slot and was dropped
   * unsent (slotConflict). Read that record now and check it by its own ID, as a reload would. Whether it may be sent is
   * not decided here (2.3 А: a record this page did not create is never sent). Nothing happens while an intent is held.
   */
  adopt(): Promise<void> {
    return this.run(async () => {
      if (this.pending || this.outcome) return;
      this.loaded = false;
      await this.reconcile();
    });
  }

  private retryFresh(): boolean {
    if (this.fresh()) return true;
    this.retryVerified = false; this.problem = "stale_response"; this.phase = "unresolved";
    return false;
  }
  private async sendPending(retry = false, transmitted?: () => void): Promise<void> {
    const pending = this.pending;
    // A stored closure record is only checked by its ID (D-CP4 4.6.1): never sent from here.
    // Open question В-2 (D-STALE-WINDOW 5, Codex C093 п. 5): the record names no document, so a record kept after
    // DOCUMENT_STALE that another document loaded can be sent from here with that document's id after a manual retry, as a
    // record after a reload already is. CT §6.1 п. 5 asks for the same working document; no transfer is added here.
    if (!pending || !this.live() || !sendableIntent(pending.intent)) return;
    if (retry && (!this.retryVerified || !this.retryFresh())) return;
    this.phase = "sending"; this.problem = null; this.retryVerified = false; this.clearCurrent(); this.emit();
    if (!this.live() || retry && !this.retryFresh()) return;
    try { await this.options.pendingStore.save(pending, this.lifetime.signal); }
    catch (error: unknown) {
      // Proof that this NEW intent never left: its save was refused over another record, so the transport below was not
      // reached and nothing can call it later (a lane without a pending intent cannot retry or resend). It is no unknown
      // outcome to check or retry. The record in the slot is not touched. A retained intent (retry) keeps its record: it
      // was stored, and may have been sent, before the slot changed under it.
      if (!retry && refusedUnsent(error)) {
        this.pending = null;
        // Only a record of another window (X) can be checked; an unreadable one names no ID, so there is nothing to look for.
        if (error.kind === "changed") this.options.slotConflict?.();
      }
      throw error;
    }
    if (!this.live() || retry && !this.retryFresh()) return;
    // A manual send passes no hook: its exchange stays exactly what it was before automatic recovery.
    const intent = this.mode.copy(pending.intent);
    const reply = await (transmitted ? this.options.send(intent, transmitted) : this.options.send(intent));
    if (!this.live()) return;
    if (reply.outcome === "mismatch") {
      this.observe(reply.state_version);
      await this.markMismatch(pending);
    } else await this.settle(reply);
  }
  begin(action: WithoutId<S["intent"]>): Promise<void> {
    if (this.busy()) return this.running ?? Promise.resolve();
    const intent = this.intent(action);
    if (intent instanceof Error) return Promise.reject(intent);
    return this.start(intent);
  }
  /** The intent of an action with its new command_id, not yet sent: automatic recovery counts its sends (CP2). */
  prepare(action: WithoutId<S["intent"]>): S["intent"] | Error { return this.intent(action); }
  /** Send a prepared intent once, as begin does; transmitted is told right before its request starts. */
  start(intent: S["intent"], transmitted?: () => void): Promise<void> {
    if (this.busy()) return this.running ?? Promise.resolve();
    const pending: LanePending<S["intent"]> = { schemaVersion: 1, profileId: this.options.profileId,
      clientInstanceId: this.options.clientInstanceId, pair: this.options.pair, intent: this.mode.copy(intent) };
    this.noteCreated(pending.intent.command_id);
    return this.run(async () => {
      this.outcome = null; this.resolved = null; this.rejectionCode = null; this.pending = pending;
      await this.sendPending(false, transmitted);
    });
  }
  /**
   * The automatic retry: exactly the retained intent, only while the check that just ran still grants it (canRetry).
   * Unlike retry it checks nothing itself: the recovery machine has checked right before (Я15.6, CT §6.1 п. 5).
   */
  resend(transmitted?: () => void): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(() => this.sendPending(true, transmitted));
  }
  retry(): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(async () => {
      await this.reconcile();
      if (!this.live()) return;
      if (this.retryVerified && this.pending && !this.pending.mismatch && !this.outcome) await this.sendPending(true);
    });
  }
}
