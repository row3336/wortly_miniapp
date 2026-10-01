import { ApiError, type HttpOptions } from "../api/http";
import { version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { LearningCommandController, type LearningCommandSnapshot, type LearningTransition } from "./learningCommandController";
import { createLearningResultApi, type LearningResultAddress, type LearningResultRead } from "./learningAnswerApi";
import { createLearningSessionApi, type LearningSessionRead } from "./learningSessionApi";
import { LearningSessionPendingStore, LearningStopPendingStore } from "./learningSessionPending";

type Lane = "primary" | "stop";
type ResultAddress = Pick<LearningResultAddress, "session_id" | "assignment_id" | "result_id">;
export type LearningDocumentSnapshot = {
  live: boolean;
  stateVersion: string;
  primary: LearningCommandSnapshot;
  stop: LearningCommandSnapshot;
  /** Lane readiness only; the screen also needs the current target's server capabilities. */
  canBegin: boolean;
  canStop: boolean;
};
type Options = {
  access(): OpenedAccess;
  transport: HttpOptions;
  storage: AsyncStorage;
  newId(): string;
  /** Highest confirmed profile version observed elsewhere in this same opened document. */
  minimumStateVersion?(): string | null;
  onUpdate(snapshot: LearningDocumentSnapshot): void;
};
const ready = (state: LearningCommandSnapshot) => !state.pending && ["idle", "settled"].includes(state.phase);

/** Own both durable command lanes for one opened document, without owning its views or drafts. */
export class LearningDocumentCommands {
  private readonly key: string;
  private readonly profileId: string;
  private readonly clientInstanceId: string;
  private readonly pair: "ru-de" | "uk-de" | "en-de";
  private readonly controllers: Record<Lane, LearningCommandController>;
  private readonly loadSession: (sessionId: string) => Promise<LearningSessionRead>;
  private readonly loadResult: (address: ResultAddress) => Promise<LearningResultRead>;
  private readonly work: Record<Lane, Promise<void> | null> = { primary: null, stop: null };
  private readonly sendSources: Record<Lane, OpenedAccess | null> = { primary: null, stop: null };
  private readonly closed = new Set<string>();
  private readonly reconciledClosed = new Set<string>();
  private floor: string;
  private disposed = false;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly options: Options) {
    const access = options.access();
    if (!access.isLive() || access.profile.access.status !== "admitted") throw new ClosedAccessError();
    this.key = access.key;
    this.profileId = access.profile.profile_id;
    this.clientInstanceId = access.document.clientInstanceId;
    this.pair = `${access.profile.dictionary_language}-de`;
    this.floor = access.profile.state_version;
    const sessions = createLearningSessionApi(options.transport), results = createLearningResultApi(options.transport);
    type Credentials = Parameters<Parameters<OpenedAccess["run"]>[0]>[0];
    const run = <T>(operation: (credentials: Credentials) => Promise<T>) => {
      if (!this.live()) return Promise.reject(new ClosedAccessError());
      return options.access().run(operation);
    };
    const origin = (credentials: Credentials) => ({ client_instance_id: credentials.clientInstanceId,
      document_id: credentials.documentId });
    this.loadSession = sessionId => run(credentials => sessions.read(credentials.token, credentials.proof,
      { session_id: sessionId, ...origin(credentials) }));
    this.loadResult = address => run(credentials => results.read(credentials.token, credentials.proof,
      { session_id: address.session_id, assignment_id: address.assignment_id, result_id: address.result_id, ...origin(credentials) }));
    const controller = (lane: Lane) => new LearningCommandController({
      profileId: this.profileId, clientInstanceId: access.document.clientInstanceId, pair: this.pair,
      stateVersion: this.floor, minimumStateVersion: () => this.minimumVersion(),
      isLive: () => this.live(), newId: options.newId,
      pendingStore: lane === "primary" ? new LearningSessionPendingStore(options.storage) : new LearningStopPendingStore(options.storage),
      send: intent => {
        const source = this.sendSources[lane];
        // A saved intent may outlive this tap's open handle. Recover it by GET
        // under the new handle; only an explicit retry may send it there.
        if (!this.live() || !source?.isLive() || source !== options.access()) return Promise.reject(new ClosedAccessError());
        return source.run(async credentials => {
          const address = origin(credentials);
          return intent.kind === "answer.submit" || intent.kind === "result.grade" || intent.kind === "result.correct"
            ? results.send(credentials.token, credentials.proof, { ...intent, ...address })
            : sessions.send(credentials.token, credentials.proof, { ...intent, ...address });
        });
      },
      check: intent => run(async credentials => {
        const address = origin(credentials);
        return intent.kind === "answer.submit" || intent.kind === "result.grade" || intent.kind === "result.correct"
          ? results.status(credentials.token, credentials.proof, { ...intent, ...address })
          : sessions.status(credentials.token, credentials.proof, { ...intent, ...address });
      }),
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
      if (external !== null && !version(external)) throw new Error("invalid shared Learning version");
      if (external !== null && BigInt(external) > BigInt(this.floor)) this.floor = external;
    }
    return this.floor;
  }
  private observe(state: LearningCommandSnapshot): void {
    if (!this.live()) return;
    if (state.stateVersion !== null && BigInt(state.stateVersion) > BigInt(this.floor)) this.floor = state.stateVersion;
    if (state.closedSession) this.closed.add(state.closedSession.session_id.toLowerCase());
    if (state.current) this.rememberClosed(state.current);
    if (state.outcome === "accepted" && state.resolved?.kind === "session.stop") {
      this.closed.add(state.resolved.sessionId.toLowerCase());
    }
    this.emit();
  }
  private rememberClosed(step: LearningResultRead["step"]): void {
    if (step.status === "closed" && "session_id" in step) this.closed.add(step.session_id.toLowerCase());
  }
  private acceptRead<T extends { state_version: string }>(reply: T, step: LearningResultRead["step"]): T {
    if (!this.live()) throw new ClosedAccessError();
    if (BigInt(reply.state_version) < BigInt(this.minimumVersion())) throw new ApiError("invalid_response");
    this.floor = reply.state_version;
    this.rememberClosed(step);
    this.reconcileClosedPrimary();
    this.emit();
    return reply;
  }
  /** Screen reads share the same clock as mutations; an old reply cannot reopen a question. */
  async readSession(sessionId: string): Promise<LearningSessionRead> {
    const reply = await this.loadSession(sessionId);
    return this.acceptRead(reply, reply.current);
  }
  async readResult(address: ResultAddress): Promise<LearningResultRead> {
    const reply = await this.loadResult(address);
    return this.acceptRead(reply, reply.step);
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }
  snapshot(): LearningDocumentSnapshot {
    const stateVersion = this.minimumVersion(), live = this.live();
    const primary = this.controllers.primary.snapshot(), stop = this.controllers.stop.snapshot();
    return { live, stateVersion, primary, stop,
      canBegin: live && !this.refreshing && !this.work.primary && !this.work.stop && ready(primary) && ready(stop),
      canStop: live && !this.work.stop && ready(stop) };
  }

  private track(lane: Lane, operation: () => Promise<void>): Promise<void> {
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
    // Stop does not prove whether a concurrent answer committed. Ask once; never replay.
    this.reconciledClosed.add(sessionId);
    void this.track("primary", () => this.controllers.primary.refresh());
  }

  refresh(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    const refreshLane = async (lane: Lane) => {
      const joined = this.work[lane];
      await this.track(lane, () => this.controllers[lane].refresh());
      const state = this.controllers[lane].snapshot();
      if (joined && this.live() && state.pending && state.outcome === null) {
        // A foreground read may join a POST sent through an older access handle.
        // Once it settles, resolve that exact receipt once using current access.
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
  begin(action: LearningTransition): Promise<void> {
    if (!this.live()) return Promise.resolve();
    const lane = action.kind === "session.stop" ? "stop" : "primary";
    if (this.work[lane]) return this.work[lane];
    if (this.closed.has(action.session_id.toLowerCase())) return Promise.resolve();
    const state = this.snapshot();
    if (!(lane === "stop" ? state.canStop : state.canBegin)) return Promise.resolve();
    this.sendSources[lane] = this.options.access();
    return this.track(lane, () => this.controllers[lane].begin(action));
  }
  retry(lane: Lane): Promise<void> {
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
