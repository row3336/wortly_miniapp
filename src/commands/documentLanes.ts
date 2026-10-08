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
};
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
  private readonly reconciledClosed = new Set<string>();
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
    // A study result has no manual retry (Я15): only the machine resends it.
    const automaticPrimary = lane.pending && this.automatic.has(lane.kind ?? "");
    const primary = automaticPrimary ? { ...lane, canRetry: false } : lane;
    return { live, stateVersion, primary, stop,
      canBegin: live && !this.refreshing && !this.work.primary && !this.work.stop && ready(primary) && ready(stop) && !this.recovery.busy(),
      canStop: live && !this.work.stop && ready(stop), recovery: live ? this.recovery.view() : null, automaticPrimary };
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
  private reconcileClosedPrimary(): void {
    if (!this.live() || this.work.primary) return;
    const primary = this.controllers.primary.snapshot(), sessionId = primary.sessionId?.toLowerCase();
    if (!primary.pending || !sessionId || !this.closed.has(sessionId) || this.reconciledClosed.has(sessionId)) return;
    // Stop does not prove whether a concurrent answer committed: ask once by its ID, never replay it.
    this.reconciledClosed.add(sessionId);
    void this.track("primary", () => this.controllers.primary.refresh());
  }
  refresh(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
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
    // flight (a reply may still settle it), and Stop keeps its own check.
    const primary = this.recovery.busy() ? (this.work.primary ?? Promise.resolve()).then(() => undefined, () => undefined)
      : refreshLane("primary");
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
