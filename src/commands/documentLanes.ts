import { ApiError, type HttpOptions } from "../api/http";
import { version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import type { ClosedSessionBoundary } from "../api/generated";
import type { Pair } from "./commandLane";
import { LaneRecovery, pageSendCounter, type RecoveryIntent, type RecoveryView } from "./laneRecovery";
import { systemRecoveryClock } from "./recoveryClock";

export type DocumentLane = "primary" | "stop";
export type Credentials = Parameters<Parameters<OpenedAccess["run"]>[0]>[0];
export type ResultAddress = { session_id: string; assignment_id: string; result_id: string };
type Step = { status: string; session_id?: string };
/** The fields of a lane snapshot this owner reads; each mode's controller exposes more. */
type LaneState = {
  pending: boolean;
  phase: string;
  kind: string | null;
  outcome: string | null;
  sessionId: string | null;
  pendingIntent: RecoveryIntent | null;
  resolved: { commandId: string; kind: string; sessionId: string } | null;
  problem: string | null;
  canRetry: boolean;
  conflict?: boolean;
  current: Step | null;
  closedSession: ClosedSessionBoundary | null;
  stateVersion: string | null;
};
type Lane<C, T> = {
  snapshot(): C; refresh(): Promise<void>; begin(action: T): Promise<void>; retry(): Promise<void>; dispose(): void;
  /** Automatic recovery (CP2): an intent with its new ID, its first send, a send after the machine's check, the last error. */
  prepare(action: T): RecoveryIntent | Error;
  start(intent: RecoveryIntent, transmitted?: () => void): Promise<void>;
  resend(transmitted?: () => void): Promise<void>;
  lastFailure(): unknown;
  release(commandId: string): Promise<void>;
  /** Я17: clear a conflict's record once its own session is confirmed closed (Н2). */
  releaseClosed(sessionId: string): Promise<void>;
};
/**
 * The automatic study action whose record outlived the confirmed closure of its session (D-CP4 3.1.4, Н6): checking
 * while its record waits for a definite answer; saved when that answer is its acceptance after a Stop this document
 * sent (9.2.8); ended otherwise (not applied, refused, a conflict cleared after the closure).
 */
export type ClosedAction = { sessionId: string; commandId: string; state: "checking" | "saved" | "ended" };
export type DocumentLanesSnapshot<C> = {
  live: boolean;
  stateVersion: string;
  primary: C;
  stop: C;
  /** Lane readiness only; the screen also needs the current target's server capabilities. */
  canBegin: boolean;
  canStop: boolean;
  /** Automatic recovery of the primary study action (CT §6.1); null when none was needed in this document. */
  recovery: RecoveryView | null;
  /** The primary lane holds a study result: it is recovered automatically, never by a manual check or retry. */
  automaticPrimary: boolean;
  closedAction: ClosedAction | null;
};
export type DocumentLanesOptions<C> = {
  access(): OpenedAccess;
  transport: HttpOptions;
  storage: AsyncStorage;
  newId(): string;
  /** Highest confirmed profile version observed elsewhere in this same opened document. */
  minimumStateVersion?(): string | null;
  onUpdate(snapshot: DocumentLanesSnapshot<C>): void;
};
/** What a mode's lane controller is given by the document: its identity, the shared clock and the access guards. */
export type LaneWiring<C> = {
  lane: DocumentLane;
  profileId: string;
  clientInstanceId: string;
  pair: Pair;
  stateVersion: string;
  minimumStateVersion(): string;
  isLive(): boolean;
  newId(): string;
  /** A send only through the open handle of the tap that started it. */
  send<R>(operation: (credentials: Credentials) => Promise<R>): Promise<R>;
  /** Any read or status check through the current open handle. */
  run<R>(operation: (credentials: Credentials) => Promise<R>): Promise<R>;
  origin(credentials: Credentials): { client_instance_id: string; document_id: string };
  onUpdate(state: C): void;
};
/** One mode's API and controllers; the document owns everything else. */
export type DocumentLanesMode<C, T, SR, RR> = {
  label: string;
  readSession(credentials: Credentials, sessionId: string, origin: LaneWiring<C>["origin"]): Promise<SR>;
  readResult(credentials: Credentials, address: ResultAddress, origin: LaneWiring<C>["origin"]): Promise<RR>;
  controller(wiring: LaneWiring<C>, reads: { read(sessionId: string): Promise<SR>; readResult(address: ResultAddress): Promise<RR> }): Lane<C, T>;
  /**
   * The primary kinds that pass the result of a study step: they recover automatically, without manual buttons
   * (CT §6.1 п. 1–2). Every other kind keeps its manual check and retry.
   */
  automatic: readonly string[];
};
const ready = (state: LaneState) => !state.pending && ["idle", "settled"].includes(state.phase);

/** Both durable command lanes of one opened document; views and drafts belong to the caller. */
export class DocumentLanes<C extends LaneState, T extends { kind: string; session_id: string },
  SR extends { state_version: string; current: Step }, RR extends { state_version: string; step: Step }> {
  private readonly key: string;
  private readonly profileId: string;
  private readonly clientInstanceId: string;
  private readonly pair: Pair;
  private readonly label: string;
  private readonly controllers: Record<DocumentLane, Lane<C, T>>;
  private readonly loadSession: (sessionId: string) => Promise<SR>;
  private readonly loadResult: (address: ResultAddress) => Promise<RR>;
  private readonly work: Record<DocumentLane, Promise<void> | null> = { primary: null, stop: null };
  private readonly sendSources: Record<DocumentLane, OpenedAccess | null> = { primary: null, stop: null };
  protected readonly closed = new Set<string>();
  /** session:command pairs whose record this document already began to resolve after their closure. */
  private readonly reconciledClosed = new Set<string>();
  /** session:command pairs of a conflict whose record this document tried to clear after the closure; a refresh retries. */
  private readonly closedReleases = new Set<string>();
  /** Sessions this document sent its own (voluntary) Stop for. */
  private readonly ownStops = new Set<string>();
  private closedAction: { sessionId: string; commandId: string } | null = null;
  private floor: string;
  private disposed = false;
  private refreshing: Promise<void> | null = null;
  private readonly automatic: ReadonlySet<string>;
  private readonly recovery: LaneRecovery;

  constructor(private readonly options: DocumentLanesOptions<C>, mode: DocumentLanesMode<C, T, SR, RR>) {
    const access = options.access();
    if (!access.isLive() || access.profile.access.status !== "admitted") throw new ClosedAccessError();
    this.key = access.key;
    this.profileId = access.profile.profile_id;
    this.clientInstanceId = access.document.clientInstanceId;
    this.pair = `${access.profile.dictionary_language}-de`;
    this.floor = access.profile.state_version;
    this.label = mode.label;
    const run = <R>(operation: (credentials: Credentials) => Promise<R>) => {
      if (!this.live()) return Promise.reject(new ClosedAccessError());
      return options.access().run(operation);
    };
    const origin = (credentials: Credentials) => ({ client_instance_id: credentials.clientInstanceId, document_id: credentials.documentId });
    this.loadSession = sessionId => run(credentials => mode.readSession(credentials, sessionId, origin));
    this.loadResult = address => run(credentials => mode.readResult(credentials, address, origin));
    const reads = { read: (sessionId: string) => this.loadSession(sessionId), readResult: (address: ResultAddress) => this.loadResult(address) };
    const controller = (lane: DocumentLane) => mode.controller({
      lane, profileId: this.profileId, clientInstanceId: this.clientInstanceId, pair: this.pair,
      stateVersion: this.floor, minimumStateVersion: () => this.minimumVersion(),
      isLive: () => this.live(), newId: options.newId, run, origin,
      send: operation => {
        const source = this.sendSources[lane];
        // A saved intent may outlive this tap's open handle. Recover it by GET under the
        // new handle; only an explicit retry or the recovery machine may send it there.
        if (!this.live() || !source?.isLive() || source !== options.access()) return Promise.reject(new ClosedAccessError());
        return source.run(operation);
      },
      onUpdate: state => this.observe(state),
    }, reads);
    this.automatic = new Set(mode.automatic);
    // Created before the lanes: a lane update reads the snapshot, which includes the recovery view.
    this.recovery = new LaneRecovery({
      automatic: kind => this.automatic.has(kind),
      primary: () => this.controllers.primary.snapshot(),
      failure: () => this.controllers.primary.lastFailure(),
      send: (intent, first, transmitted) => this.recoverySend(intent, first, transmitted),
      check: () => this.live() ? this.track("primary", () => this.controllers.primary.refresh()) : Promise.resolve(),
      release: commandId => this.live() ? this.track("primary", () => this.controllers.primary.release(commandId)) : Promise.resolve(),
      isLive: () => this.live(),
      onUpdate: () => this.emit(),
    }, pageSendCounter(options.storage), systemRecoveryClock);
    this.controllers = { primary: controller("primary"), stop: controller("stop") };
  }

  private live(): boolean {
    const access = this.options.access();
    return !this.disposed && access.isLive() && access.key === this.key
      && access.document.clientInstanceId === this.clientInstanceId
      && access.profile.profile_id === this.profileId && access.profile.access.status === "admitted"
      && `${access.profile.dictionary_language}-de` === this.pair;
  }
  private minimumVersion(): string {
    if (this.live()) {
      const current = this.options.access().profile.state_version;
      if (BigInt(current) > BigInt(this.floor)) this.floor = current;
      const external = this.options.minimumStateVersion?.() ?? null;
      if (external !== null && !version(external)) throw new Error(`invalid shared ${this.label} version`);
      if (external !== null && BigInt(external) > BigInt(this.floor)) this.floor = external;
    }
    return this.floor;
  }
  private observe(state: C): void {
    if (!this.live()) return;
    if (state.stateVersion !== null && BigInt(state.stateVersion) > BigInt(this.floor)) this.floor = state.stateVersion;
    if (state.closedSession) this.closed.add(state.closedSession.session_id.toLowerCase());
    if (state.current) this.rememberClosed(state.current);
    if (state.outcome === "accepted" && state.resolved?.kind === "session.stop") this.closed.add(state.resolved.sessionId.toLowerCase());
    this.emit();
  }
  /** Only a closed projection of a session closes it here; an unavailable step without a session names none. */
  private rememberClosed(step: Step): void {
    if (step.status === "closed" && step.session_id) this.closed.add(step.session_id.toLowerCase());
  }
  private acceptRead<R extends { state_version: string }>(reply: R, step: Step): R {
    if (!this.live()) throw new ClosedAccessError();
    if (BigInt(reply.state_version) < BigInt(this.minimumVersion())) throw new ApiError("invalid_response");
    this.floor = reply.state_version;
    this.rememberClosed(step);
    this.reconcileClosedPrimary();
    this.emit();
    return reply;
  }
  /**
   * These lanes saw this session closed under the current document: a closed projection or a closed boundary at or
   * above the version floor, or an accepted Stop of it (a real closure whatever the version of its reply). Stop and
   * actions of it are refused locally. Only that fact: no reason is kept, and readiness or work in flight never count.
   */
  knowsClosed(sessionId: string): boolean { return this.live() && this.closed.has(sessionId.toLowerCase()); }
  /** Screen reads share the clock of mutations; an older reply cannot reopen a question. */
  async readSession(sessionId: string): Promise<SR> {
    const reply = await this.loadSession(sessionId);
    return this.acceptRead(reply, reply.current);
  }
  async readResult(address: ResultAddress): Promise<RR> {
    const reply = await this.loadResult(address);
    return this.acceptRead(reply, reply.step);
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  snapshot(): DocumentLanesSnapshot<C> {
    const stateVersion = this.minimumVersion(), live = this.live();
    const lane = this.controllers.primary.snapshot(), stop = this.controllers.stop.snapshot();
    // A study result has no manual retry (Я15): only the machine resends it. Once its outcome is known, a record kept only
    // by a failed local cleanup is no recovery any more: its manual check of the device data stays.
    const automaticPrimary = lane.pending && lane.outcome === null && this.automatic.has(lane.kind ?? "");
    const primary = automaticPrimary ? { ...lane, canRetry: false } : lane;
    return { live, stateVersion, primary, stop,
      canBegin: live && !this.refreshing && !this.work.primary && !this.work.stop && ready(primary) && ready(stop) && !this.recovery.busy(),
      canStop: live && !this.work.stop && ready(stop), recovery: live ? this.recovery.view() : null, automaticPrimary,
      closedAction: live ? this.closedActionView(lane, stop) : null };
  }
  private closedActionView(primary: C, stop: C): ClosedAction | null {
    const action = this.closedAction;
    if (!action) return null;
    const same = (id: string | undefined) => id !== undefined && id.toLowerCase() === action.commandId;
    if (primary.pending && primary.outcome === null && same(primary.pendingIntent?.command_id ?? action.commandId)) return { ...action, state: "checking" };
    // 9.2.8 needs both facts: the server accepted this action, and the closure is this document's own confirmed Stop.
    const ownStop = this.ownStops.has(action.sessionId) && stop.outcome === "accepted" && stop.resolved?.kind === "session.stop"
      && stop.resolved.sessionId.toLowerCase() === action.sessionId;
    const saved = primary.outcome === "accepted" && same(primary.resolved?.commandId) && ownStop;
    return { ...action, state: saved ? "saved" : "ended" };
  }

  private track(lane: DocumentLane, operation: () => Promise<void>): Promise<void> {
    if (this.work[lane]) return this.work[lane];
    const task = operation();
    this.work[lane] = task;
    const finish = () => {
      if (this.work[lane] === task) { this.work[lane] = null; this.sendSources[lane] = null; }
      this.reconcileClosedPrimary();
      // A check may have found an automatic intent this owner does not drive yet (reload, another owner).
      if (lane === "primary" && this.live() && !this.work.primary) this.recovery.sync();
      this.emit();
    };
    void task.then(finish, finish);
    return task;
  }
  /**
   * A record of the primary lane in a session confirmed closed. Stop does not prove whether a concurrent action
   * committed: it is asked by its ID, never replayed. A conflict is cleared (Н2). An automatic action is checked until
   * the answer is definite (Н4): a busy machine goes on by itself after this one check; otherwise a machine is resumed
   * that only checks. Any other kind keeps one check and its manual check button.
   */
  private reconcileClosedPrimary(): void {
    if (!this.live() || this.work.primary) return;
    const primary = this.controllers.primary.snapshot(), sessionId = primary.sessionId?.toLowerCase();
    if (!primary.pending || !sessionId || !this.closed.has(sessionId)) return;
    const intent = primary.pendingIntent, key = `${sessionId}:${intent?.command_id.toLowerCase() ?? ""}`;
    const recovery = this.recovery.view();
    // The lane's own mark (also when only its stored copy lacks it) or the machine's conflict on this very intent.
    const conflict = primary.conflict === true || primary.problem === "mismatch" || !!intent && recovery?.state.name === "conflict"
      && recovery.commandId.toLowerCase() === intent.command_id.toLowerCase();
    if (conflict && primary.outcome === null) {
      // One try per event: a failed clear waits for the next refresh, never loops on a failing storage.
      if (this.closedReleases.has(key)) return;
      this.closedReleases.add(key);
      const lane = this.controllers.primary;
      void this.track("primary", () => lane.releaseClosed(sessionId).then(() => {
        // A machine that still waits on the cleared conflict (it met only the failed mark write) has nothing left.
        if (intent && !lane.snapshot().pending) this.recovery.forget(intent.command_id);
      }));
      return;
    }
    if (this.reconciledClosed.has(key)) return;
    this.reconciledClosed.add(key);
    if (intent && primary.outcome === null && this.automatic.has(intent.kind)) {
      this.closedAction = { sessionId, commandId: intent.command_id.toLowerCase() };
      if (!this.recovery.drives(intent.command_id)) { this.recovery.recheck(intent); return; }
    }
    void this.track("primary", () => this.controllers.primary.refresh());
  }
  refresh(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.closedReleases.clear();
    const refreshLane = async (lane: DocumentLane) => {
      const joined = this.work[lane];
      await this.track(lane, () => this.controllers[lane].refresh());
      const state = this.controllers[lane].snapshot();
      if (joined && this.live() && state.pending && state.outcome === null) {
        // A foreground read may join a POST sent through an older handle; resolve that exact receipt once.
        await this.track(lane, () => this.controllers[lane].refresh());
      }
    };
    // While the machine recovers the primary action, it alone checks it: a refresh only waits for its exchange in
    // flight (a reply may still settle it), and Stop keeps its own check. A record that will never apply and whose
    // cleanup failed is only cleared again (Н3).
    const release = this.recovery.busy() ? null : this.recovery.retryRelease();
    const primary = this.recovery.busy() ? (this.work.primary ?? Promise.resolve()).then(() => undefined, () => undefined)
      : release ?? refreshLane("primary");
    const task = Promise.all([primary, refreshLane("stop")]).then(() => undefined).finally(() => {
      if (this.refreshing === task) this.refreshing = null;
      this.emit();
    });
    this.refreshing = task;
    return task;
  }
  begin(action: T): Promise<void> {
    if (!this.live()) return Promise.resolve();
    const lane: DocumentLane = action.kind === "session.stop" ? "stop" : "primary";
    if (this.work[lane]) return this.work[lane];
    if (this.closed.has(action.session_id.toLowerCase())) return Promise.resolve();
    const state = this.snapshot();
    if (!(lane === "stop" ? state.canStop : state.canBegin)) return Promise.resolve();
    if (lane === "stop") this.ownStops.add(action.session_id.toLowerCase());
    if (lane === "primary" && this.automatic.has(action.kind)) {
      const intent = this.controllers.primary.prepare(action);
      return intent instanceof Error ? Promise.reject(intent) : this.recovery.begin(intent);
    }
    this.sendSources[lane] = this.options.access();
    return this.track(lane, () => this.controllers[lane].begin(action));
  }
  /**
   * One send of the recovery machine. Like a retry it goes through the current open handle (DESIGN 5.8) and never
   * overtakes Stop; a refusal here starts no request, which the machine counts as nothing sent.
   */
  private recoverySend(intent: RecoveryIntent, first: boolean, transmitted: () => void): Promise<void> {
    if (!this.live() || this.work.primary || this.work.stop || !ready(this.controllers.stop.snapshot())
      || this.closed.has(intent.session_id.toLowerCase())) return Promise.resolve();
    this.sendSources.primary = this.options.access();
    const lane = this.controllers.primary;
    return this.track("primary", () => first ? lane.start(intent, transmitted) : lane.resend(transmitted));
  }
  /**
   * S07 «Продолжить»: the server confirmed the primary action and only its local record is left. The lane repeats exactly
   * that cleanup — a reconcile with a known outcome clears the record and requests nothing — with no check, send or read.
   */
  clearSettled(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.work.primary) return this.work.primary;
    const lane = this.controllers.primary.snapshot();
    if (!lane.pending || lane.outcome !== "accepted") return Promise.resolve();
    return this.track("primary", () => this.controllers.primary.refresh());
  }
  /** The study view's activity (visible, fresh handle, study route on): the machine requests nothing otherwise. */
  setRecoveryActive(active: boolean): void { this.recovery.setActive(active); }
  retry(lane: DocumentLane): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.work[lane]) return this.work[lane];
    const state = this.snapshot(), sessionId = state[lane].sessionId?.toLowerCase();
    if (sessionId && this.closed.has(sessionId)) return Promise.resolve();
    if (lane === "primary" && this.automatic.has(state.primary.kind ?? "")) return Promise.resolve();
    if (lane === "primary" && (this.work.stop || !ready(state.stop))) return Promise.resolve();
    this.sendSources[lane] = this.options.access();
    return this.track(lane, () => this.controllers[lane].retry());
  }
  dispose(): void {
    this.disposed = true;
    this.sendSources.primary = this.sendSources.stop = null;
    this.recovery.dispose();
    this.controllers.primary.dispose();
    this.controllers.stop.dispose();
  }
}
