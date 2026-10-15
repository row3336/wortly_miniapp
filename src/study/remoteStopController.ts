import { ApiError } from "../api/http";
import { GatePending, pausedBeforeSend } from "../commands/gatePending";
import { PendingStoreError, validId } from "../commands/pendingSlot";
import type { ReadbackTicket, WriteGate } from "../commands/writeGate";
import type { RemoteStopIntent, RemoteStopReply, RemoteStopStatus } from "./remoteSessionApi";
import { RemoteStopPendingStore, type RemoteStopPending } from "./remoteStopPending";

export type RemoteStopSnapshot = {
  phase: "loading" | "idle" | "checking" | "sending" | "unresolved" | "blocked" | "settled" | "disposed";
  targetId: string | null;
  pending: boolean;
  outcome: "accepted" | "rejected" | null;
  problem: "network" | "storage" | "invalid_pending" | "pending_changed" | "not_found" | "mismatch"
    | "client_changed" | "profile_changed" | "expired" | "forbidden"
    /** PAUSED_BEFORE_SEND (P03 §4.2): the write gate kept the request on the client; the ID and the record stay. */
    | "paused" | null;
  canRetry: boolean;
  stateVersion: string | null;
};

type Options = {
  profileId: string;
  clientInstanceId: string;
  pendingStore: RemoteStopPendingStore;
  newId(): string;
  send(intent: RemoteStopIntent): Promise<RemoteStopReply>;
  /** The status read by ID; the ticket comes from the write gate (R6). */
  check(intent: RemoteStopIntent, ticket: ReadbackTicket): Promise<RemoteStopStatus>;
  onUpdate(snapshot: RemoteStopSnapshot): void;
  /** The write gate of the page (P03 M-P03-8): readback registry, status reads by ticket, the retry button (I9). */
  gate: WriteGate;
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
  private readonly registry: GatePending;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: Options) {
    if (!validId(options.profileId) || !validId(options.clientInstanceId)) throw new Error("invalid remote context");
    this.registry = new GatePending(options.gate, "stop_remote");
    this.unsubscribe = options.gate.subscribe(() => this.emit());
  }
  private live(): boolean { return !this.lifetime.signal.aborted; }

  snapshot(): RemoteStopSnapshot {
    return { phase: this.phase, targetId: this.pending?.intent.session_id ?? null, stateVersion: this.stateVersion,
      pending: this.pending !== null, outcome: this.outcome, problem: this.problem,
      canRetry: this.live() && !this.running && this.outcome === null && this.pending !== null
        && !this.pending.mismatch && this.pending.clientInstanceId === this.options.clientInstanceId
        && this.problem !== null && ["network", "storage", "not_found", "paused"].includes(this.problem)
        && this.registry.writable(this.pending.intent.command_id) };
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
      } else if (pausedBeforeSend(error)) {
        this.problem = "paused";
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
    this.registry.release();
    this.problem = null;
    this.phase = "settled";
  }

  private async settle(outcome: "accepted" | "rejected"): Promise<void> {
    this.outcome = outcome;
    this.registry.settled(outcome === "accepted" ? "recorded" : "rejected");
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
        if (this.pending) this.registry.hold(this.pending.intent.command_id);
      }
      if (this.outcome) { await this.clearSettled(); return; }
      if (!this.pending) { this.phase = "idle"; return; }
      if (this.pending.mismatch) {
        await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
        if (!this.live()) return;
        this.problem = "mismatch";
      } else {
        // R6: the status of this ID is read only with the gate's ticket.
        const intent = structuredClone(this.pending.intent);
        const reply = await this.registry.read(intent.command_id, ticket => this.options.check(intent, ticket));
        if (!this.live()) return;
        this.stateVersion = reply.state_version;
        if (reply.outcome === "accepted") { await this.settle("accepted"); return; }
        this.registry.settled("not_recorded");
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
    this.registry.hold(pending.intent.command_id);
    await this.options.pendingStore.save(pending, this.lifetime.signal);
    if (!this.live()) return;
    const reply = await this.options.send(structuredClone(pending.intent));
    if (!this.live()) return;
    this.stateVersion = reply.state_version;
    if (reply.outcome === "mismatch") {
      this.registry.settled("mismatch");
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
    // R3: an ID without a definite answer stays locked to itself in the gate until a later owner reads it.
    // Unsubscribed first: the release below changes the gate, and a disposed owner repaints nothing.
    this.unsubscribe();
    this.registry.release();
    this.lifetime.abort();
    this.phase = "disposed";
  }
}
