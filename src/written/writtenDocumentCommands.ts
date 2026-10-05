import { ApiError, type HttpOptions } from "../api/http";
import { version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { createWrittenApi, type WrittenResultAddress, type WrittenResultRead, type WrittenSessionRead } from "./writtenApi";
import { WrittenCommandController, type WrittenCommandSnapshot, type WrittenTransition } from "./writtenCommandController";
import { writtenStores, type WrittenLane } from "./writtenPending";

type ResultAddress = Pick<WrittenResultAddress, "session_id" | "assignment_id" | "result_id">;
type Credentials = Parameters<Parameters<OpenedAccess["run"]>[0]>[0];
export type WrittenDocumentSnapshot = {
  live: boolean;
  stateVersion: string;
  primary: WrittenCommandSnapshot;
  stop: WrittenCommandSnapshot;
  /** Lane readiness only; the screen also needs the current target's server capabilities. */
  canBegin: boolean;
  canStop: boolean;
};
export type WrittenDocumentOptions = {
  access(): OpenedAccess;
  transport: HttpOptions;
  storage: AsyncStorage;
  newId(): string;
  /** Highest confirmed profile version observed elsewhere in this same opened document. */
  minimumStateVersion?(): string | null;
  onUpdate(snapshot: WrittenDocumentSnapshot): void;
};
const ready = (state: WrittenCommandSnapshot) => !state.pending && ["idle", "settled"].includes(state.phase);

/** Both durable command lanes of one opened document; views and drafts belong to the caller. */
export class WrittenDocumentCommands {
  private readonly key: string;
  private readonly profileId: string;
  private readonly clientInstanceId: string;
  private readonly pair: "ru-de" | "uk-de" | "en-de";
  private readonly controllers: Record<WrittenLane, WrittenCommandController>;
  private readonly loadSession: (sessionId: string) => Promise<WrittenSessionRead>;
  private readonly loadResult: (address: ResultAddress) => Promise<WrittenResultRead>;
  private readonly work: Record<WrittenLane, Promise<void> | null> = { primary: null, stop: null };
  private readonly sendSources: Record<WrittenLane, OpenedAccess | null> = { primary: null, stop: null };
  private readonly closed = new Set<string>();
  private readonly reconciledClosed = new Set<string>();
  private floor: string;
  private disposed = false;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: WrittenDocumentOptions) {
    const access = options.access();
    if (!access.isLive() || access.profile.access.status !== "admitted") throw new ClosedAccessError();
    this.key = access.key;
    this.profileId = access.profile.profile_id;
    this.clientInstanceId = access.document.clientInstanceId;
    this.pair = `${access.profile.dictionary_language}-de`;
    this.floor = access.profile.state_version;
    const api = createWrittenApi(options.transport), stores = writtenStores(options.storage);
    const run = <T>(operation: (credentials: Credentials) => Promise<T>) => {
      if (!this.live()) return Promise.reject(new ClosedAccessError());
      return options.access().run(operation);
    };
    const origin = (credentials: Credentials) => ({ client_instance_id: credentials.clientInstanceId, document_id: credentials.documentId });
    this.loadSession = sessionId => run(credentials => api.read(credentials.token, credentials.proof,
      { session_id: sessionId, ...origin(credentials) }));
    this.loadResult = address => run(credentials => api.readResult(credentials.token, credentials.proof,
      { session_id: address.session_id, assignment_id: address.assignment_id, result_id: address.result_id, ...origin(credentials) }));
    const controller = (lane: WrittenLane) => new WrittenCommandController({
      profileId: this.profileId, clientInstanceId: this.clientInstanceId, pair: this.pair, lane,
      pendingStore: stores[lane], stateVersion: this.floor, minimumStateVersion: () => this.minimumVersion(),
      isLive: () => this.live(), newId: options.newId,
      send: intent => {
        const source = this.sendSources[lane];
        // A saved intent may outlive this tap's open handle. Recover it by GET under the
        // new handle; only an explicit retry may send it there.
        if (!this.live() || !source?.isLive() || source !== options.access()) return Promise.reject(new ClosedAccessError());
        return source.run(credentials => api.send(credentials.token, credentials.proof, { ...intent, ...origin(credentials) }));
      },
      check: intent => run(credentials => api.status(credentials.token, credentials.proof, { ...intent, ...origin(credentials) })),
      read: sessionId => this.loadSession(sessionId),
      readResult: intent => this.loadResult(intent),
      onUpdate: state => this.observe(state),
    });
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
      if (external !== null && !version(external)) throw new Error("invalid shared written version");
      if (external !== null && BigInt(external) > BigInt(this.floor)) this.floor = external;
    }
    return this.floor;
  }
  private observe(state: WrittenCommandSnapshot): void {
    if (!this.live()) return;
    if (state.stateVersion !== null && BigInt(state.stateVersion) > BigInt(this.floor)) this.floor = state.stateVersion;
    if (state.closedSession) this.closed.add(state.closedSession.session_id.toLowerCase());
    if (state.current) this.rememberClosed(state.current);
    if (state.outcome === "accepted" && state.resolved?.kind === "session.stop") this.closed.add(state.resolved.sessionId.toLowerCase());
    this.emit();
  }
  private rememberClosed(step: { status: string; session_id?: string }): void {
    if (step.status === "closed" && step.session_id) this.closed.add(step.session_id.toLowerCase());
  }
  private acceptRead<T extends { state_version: string }>(reply: T, step: { status: string; session_id?: string }): T {
    if (!this.live()) throw new ClosedAccessError();
    if (BigInt(reply.state_version) < BigInt(this.minimumVersion())) throw new ApiError("invalid_response");
    this.floor = reply.state_version;
    this.rememberClosed(step);
    this.reconcileClosedPrimary();
    this.emit();
    return reply;
  }
  /** Screen reads share the clock of mutations; an older reply cannot reopen a question. */
  async readSession(sessionId: string): Promise<WrittenSessionRead> {
    const reply = await this.loadSession(sessionId);
    return this.acceptRead(reply, reply.current);
  }
  async readResult(address: ResultAddress): Promise<WrittenResultRead> {
    const reply = await this.loadResult(address);
    return this.acceptRead(reply, reply.step);
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  snapshot(): WrittenDocumentSnapshot {
    const stateVersion = this.minimumVersion(), live = this.live();
    const primary = this.controllers.primary.snapshot(), stop = this.controllers.stop.snapshot();
    return { live, stateVersion, primary, stop,
      canBegin: live && !this.refreshing && !this.work.primary && !this.work.stop && ready(primary) && ready(stop),
      canStop: live && !this.work.stop && ready(stop) };
  }
  isClosed(sessionId: string): boolean { return this.closed.has(sessionId.toLowerCase()); }

  private track(lane: WrittenLane, operation: () => Promise<void>): Promise<void> {
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
    const refreshLane = async (lane: WrittenLane) => {
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
  begin(action: WrittenTransition): Promise<void> {
    if (!this.live()) return Promise.resolve();
    const lane: WrittenLane = action.kind === "session.stop" ? "stop" : "primary";
    if (this.work[lane]) return this.work[lane];
    if (this.closed.has(action.session_id.toLowerCase())) return Promise.resolve();
    const state = this.snapshot();
    if (!(lane === "stop" ? state.canStop : state.canBegin)) return Promise.resolve();
    this.sendSources[lane] = this.options.access();
    return this.track(lane, () => this.controllers[lane].begin(action));
  }
  retry(lane: WrittenLane): Promise<void> {
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
