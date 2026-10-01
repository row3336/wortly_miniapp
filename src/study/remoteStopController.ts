import { ApiError } from "../api/http";
import { PendingStoreError, validId } from "../commands/pendingSlot";
import type { RemoteStopIntent, RemoteStopReply, RemoteStopStatus } from "./remoteSessionApi";
import { RemoteStopPendingStore, type RemoteStopPending } from "./remoteStopPending";

export type RemoteStopSnapshot = {
  phase: "loading" | "idle" | "checking" | "sending" | "unresolved" | "blocked" | "settled" | "disposed";
  targetId: string | null;
  pending: boolean;
  outcome: "accepted" | "rejected" | null;
  problem: "network" | "storage" | "invalid_pending" | "pending_changed" | "not_found" | "mismatch"
    | "client_changed" | "profile_changed" | "expired" | "forbidden" | null;
  canRetry: boolean;
  stateVersion: string | null;
};

type Options = {
  profileId: string;
  clientInstanceId: string;
  pendingStore: RemoteStopPendingStore;
  newId(): string;
  send(intent: RemoteStopIntent): Promise<RemoteStopReply>;
  check(intent: RemoteStopIntent): Promise<RemoteStopStatus>;
  onUpdate(snapshot: RemoteStopSnapshot): void;
};

/** Owns one confirmation's outcome. Entry owns auth, the document lease and reopening. */
export class RemoteStopController {
  private readonly lifetime = new AbortController();
  private phase: RemoteStopSnapshot["phase"] = "loading";
  private problem: RemoteStopSnapshot["problem"] = null;
  private pending: RemoteStopPending | null = null;
  private outcome: RemoteStopSnapshot["outcome"] = null;
  private loaded = false;
  private stateVersion: string | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly options: Options) {
    if (!validId(options.profileId) || !validId(options.clientInstanceId)) throw new Error("invalid remote context");
  }
  private live(): boolean { return !this.lifetime.signal.aborted; }

  snapshot(): RemoteStopSnapshot {
    return { phase: this.phase, targetId: this.pending?.intent.session_id ?? null, stateVersion: this.stateVersion,
      pending: this.pending !== null, outcome: this.outcome, problem: this.problem,
      canRetry: this.live() && !this.running && this.outcome === null && this.pending !== null
        && !this.pending.mismatch && this.pending.clientInstanceId === this.options.clientInstanceId
        && this.problem !== null && ["network", "storage", "not_found"].includes(this.problem) };
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }

  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    const task = Promise.resolve().then(action).catch((error: unknown) => {
      if (!this.live()) return;
      if (error instanceof PendingStoreError) {
        this.problem = error.kind === "invalid" ? "invalid_pending"
          : error.kind === "changed" ? "pending_changed" : "storage";
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.problem = error.status === 401 ? "expired" : "forbidden";
      } else this.problem = "network";
      this.phase = this.pending ? "unresolved" : "blocked";
    }).finally(() => {
      if (this.running === task) this.running = null;
      this.emit();
    });
    this.running = task;
    return task;
  }

  private async clearSettled(): Promise<void> {
    if (!this.outcome) return;
    if (this.pending) await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null;
    this.problem = null;
    this.phase = "settled";
  }

  private async settle(outcome: "accepted" | "rejected"): Promise<void> {
    this.outcome = outcome;
    await this.clearSettled();
  }

  /** Reads only. Not-found is still unresolved, never permission for an automatic resend. */
  refresh(): Promise<void> {
    return this.run(async () => {
      this.phase = "checking";
      this.problem = null;
      this.emit();
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
        this.problem = "mismatch";
      } else {
        const reply = await this.options.check(structuredClone(this.pending.intent));
        if (!this.live()) return;
        this.stateVersion = reply.state_version;
        if (reply.outcome === "accepted") { await this.settle("accepted"); return; }
        if (reply.current.profile_id !== this.options.profileId) this.problem = "profile_changed";
        else if (reply.current.access.status !== "admitted") this.problem = "forbidden";
        else if (this.pending.clientInstanceId !== this.options.clientInstanceId) this.problem = "client_changed";
        else this.problem = "not_found";
      }
      this.phase = "unresolved";
    });
  }

  private async sendPending(): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.live()) return;
    this.phase = "sending";
    this.problem = null;
    this.emit();
    await this.options.pendingStore.save(pending, this.lifetime.signal);
    if (!this.live()) return;
    const reply = await this.options.send(structuredClone(pending.intent));
    if (!this.live()) return;
    this.stateVersion = reply.state_version;
    if (reply.outcome === "mismatch") {
      this.pending = { ...pending, mismatch: true };
      this.problem = "mismatch";
      this.phase = "unresolved";
      await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
    } else await this.settle(reply.outcome);
  }

  /** Entry invokes this only after the user confirms the displayed exact target. */
  confirm(targetId: string): Promise<void> {
    if (!this.live() || this.running || !this.loaded || this.pending || this.phase !== "idle") {
      return this.running ?? Promise.resolve();
    }
    if (!validId(targetId)) return Promise.reject(new Error("invalid remote target"));
    return this.run(async () => {
      this.outcome = null;
      this.pending = { schemaVersion: 1, profileId: this.options.profileId,
        clientInstanceId: this.options.clientInstanceId, intent: {
          command_id: this.options.newId(), kind: "session.stop_remote", session_id: targetId,
          payload: { confirmed: true },
        } };
      await this.sendPending();
    });
  }

  retry(): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(() => this.sendPending());
  }

  dispose(): void {
    this.lifetime.abort();
    this.phase = "disposed";
  }
}
