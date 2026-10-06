import { ApiError, type HttpOptions } from "../api/http";
import { version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import type { ClosedSessionBoundary } from "../api/generated";
import type { Pair } from "./commandLane";

export type DocumentLane = "primary" | "stop";
export type Credentials = Parameters<Parameters<OpenedAccess["run"]>[0]>[0];
export type ResultAddress = { session_id: string; assignment_id: string; result_id: string };
type Step = { status: string; session_id?: string };
/** The fields of a lane snapshot this owner reads; each mode's controller exposes more. */
type LaneState = {
  pending: boolean;
  phase: string;
  outcome: string | null;
  sessionId: string | null;
  resolved: { kind: string; sessionId: string } | null;
  current: Step | null;
  closedSession: ClosedSessionBoundary | null;
  stateVersion: string | null;
};
type Lane<C, T> = { snapshot(): C; refresh(): Promise<void>; begin(action: T): Promise<void>; retry(): Promise<void>; dispose(): void };
export type DocumentLanesSnapshot<C> = {
  live: boolean;
  stateVersion: string;
  primary: C;
  stop: C;
  /** Lane readiness only; the screen also needs the current target's server capabilities. */
  canBegin: boolean;
  canStop: boolean;
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
        // new handle; only an explicit retry may send it there.
        if (!this.live() || !source?.isLive() || source !== options.access()) return Promise.reject(new ClosedAccessError());
        return source.run(operation);
      },
      onUpdate: state => this.observe(state),
    }, reads);
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
    const primary = this.controllers.primary.snapshot(), stop = this.controllers.stop.snapshot();
    return { live, stateVersion, primary, stop,
      canBegin: live && !this.refreshing && !this.work.primary && !this.work.stop && ready(primary) && ready(stop),
      canStop: live && !this.work.stop && ready(stop) };
  }

  private track(lane: DocumentLane, operation: () => Promise<void>): Promise<void> {
    if (this.work[lane]) return this.work[lane];
    const task = operation();
    this.work[lane] = task;
    const finish = () => {
      if (this.work[lane] === task) { this.work[lane] = null; this.sendSources[lane] = null; }
      this.reconcileClosedPrimary();
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
    const task = Promise.all([refreshLane("primary"), refreshLane("stop")]).then(() => undefined).finally(() => {
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
    this.sendSources[lane] = this.options.access();
    return this.track(lane, () => this.controllers[lane].begin(action));
  }
  retry(lane: DocumentLane): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.work[lane]) return this.work[lane];
    const state = this.snapshot(), sessionId = state[lane].sessionId?.toLowerCase();
    if (sessionId && this.closed.has(sessionId)) return Promise.resolve();
    if (lane === "primary" && (this.work.stop || !ready(state.stop))) return Promise.resolve();
    this.sendSources[lane] = this.options.access();
    return this.track(lane, () => this.controllers[lane].retry());
  }
  dispose(): void {
    this.disposed = true;
    this.sendSources.primary = this.sendSources.stop = null;
    this.controllers.primary.dispose();
    this.controllers.stop.dispose();
  }
}
