import type { LearningCurrentProjection, LearningCurrentResponse, ManualSelectionCommand } from "../api/generated";
import { ApiError } from "../api/http";
import { GatePending, pausedBeforeSend } from "../commands/gatePending";
import type { WriteGate } from "../commands/writeGate";
import type { LearningApi, ManualCommandReply } from "./learningApi";
import { ManualPendingStore, PendingStoreError, validId, type ManualPending } from "./manualPending";

/** Obtained from a successfully opened Entry document, not from local pending data. */
export type ManualContext = {
  profileId: string;
  clientInstanceId: string;
  documentId: string;
  pair: LearningCurrentProjection["pair"];
  token: string;
  proof: string;
};

type Problem = {
  reason: "network" | "storage" | "invalid_pending" | "pending_changed" | "expired" | "forbidden"
    | "pair_changed" | "client_changed" | "profile_changed" | "mismatch" | "not_found"
    /** PAUSED_BEFORE_SEND (P03 §4.2): the write gate kept the request on the client; the ID and the record stay. */
    | "paused";
  code?: string;
};
type Outcome = { commandId: string; status: "accepted" | "rejected"; code?: string };
export type ManualSelectionSnapshot = {
  phase: "loading" | "ready" | "sending" | "checking" | "unresolved" | "blocked" | "disposed";
  data: LearningCurrentResponse | null;
  pending: ManualPending | null;
  outcome: Outcome | null;
  problem: Problem | null;
  canChange: boolean;
  canRetry: boolean;
};

type Options = {
  api: LearningApi;
  pendingStore: ManualPendingStore;
  context: ManualContext;
  newId(): string;
  onUpdate(snapshot: ManualSelectionSnapshot): void;
  /** The write gate of the page (P03 M-P03-8): readback registry, status reads by ticket, the buttons (I9). */
  gate: WriteGate;
};

/** One document's manual actions. No timers, automatic writes, or offline queue. */
export class ManualSelectionController {
  private readonly context: ManualContext;
  private readonly lifetime = new AbortController();
  private phase: ManualSelectionSnapshot["phase"] = "loading";
  private data: LearningCurrentResponse | null = null;
  private pending: ManualPending | null = null;
  private outcome: Outcome | null = null;
  private problem: Problem | null = null;
  private version: string | null = null;
  private writeBlocked: "expired" | "forbidden" | "profile_changed" | null = null;
  private loaded = false;
  private settled = false;
  private running: Promise<void> | null = null;
  private readonly registry: GatePending;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: Options) {
    const context = options.context;
    if (!validId(context.profileId) || !validId(context.clientInstanceId) || !validId(context.documentId)
      || !["ru-de", "uk-de", "en-de"].includes(context.pair) || !context.token || !context.proof) {
      throw new Error("invalid manual context");
    }
    this.context = { ...context };
    this.registry = new GatePending(options.gate, "manual_selection");
    this.unsubscribe = options.gate.subscribe(() => this.emit());
  }

  private live(): boolean { return !this.lifetime.signal.aborted; }

  private retryAllowed(): boolean {
    return this.live() && !this.running && !this.writeBlocked && !this.settled && this.pending !== null && !this.pending.mismatch
      && this.pending.clientInstanceId === this.context.clientInstanceId
      && this.pending.intent.payload.expected_pair === this.context.pair
      && this.problem !== null && ["network", "storage", "not_found", "paused"].includes(this.problem.reason)
      // After not_found the same ID is sent at once (mayWrite of the ID); otherwise «Повторить» reads it first and sends
      // only after not_recorded, so it follows the check predicate (C335): a family lock of this ID never keeps it.
      && (this.problem.reason === "not_found" ? this.registry.writable(this.pending.intent.command_id) : this.registry.checkable());
  }

  snapshot(): ManualSelectionSnapshot {
    // UI consumers cannot mutate the pending payload or accepted version through a snapshot.
    return structuredClone({ phase: this.phase, data: this.data, pending: this.pending,
      outcome: this.outcome, problem: this.problem,
      canChange: this.live() && !this.running && !this.writeBlocked
        && this.phase === "ready" && this.data !== null && this.pending === null && this.registry.writable(),
      canRetry: this.retryAllowed() });
  }

  private emit(): void {
    if (this.live()) this.options.onUpdate(this.snapshot());
  }

  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    // Install the serialization guard before invoking callbacks or touching storage.
    const task = Promise.resolve().then(action).catch((error: unknown) => {
      if (!this.live()) return;
      if (error instanceof PendingStoreError) {
        this.problem = { reason: error.kind === "invalid" ? "invalid_pending"
          : error.kind === "changed" ? "pending_changed" : "storage" };
      } else if (pausedBeforeSend(error)) {
        this.problem = { reason: "paused" };
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.writeBlocked = error.status === 401 ? "expired" : "forbidden";
        this.data = null;
        this.problem = { reason: this.writeBlocked, code: error.code };
      } else this.problem = { reason: "network", ...(error instanceof ApiError ? { code: error.code } : {}) };
      this.phase = this.pending ? "unresolved" : "blocked";
    }).finally(() => {
      if (this.running === task) this.running = null;
      this.emit();
    });
    this.running = task;
    return task;
  }

  private accept(current: LearningCurrentProjection, stateVersion: string): void {
    if (this.version !== null && BigInt(stateVersion) < BigInt(this.version)) return;
    this.version = stateVersion;
    if (current.pair !== this.context.pair) {
      this.data = null;
      this.problem = { reason: "pair_changed" };
      return;
    }
    this.data = structuredClone({ ...current, state_version: stateVersion });
    this.problem = null;
  }

  private idle(): void {
    if (this.writeBlocked) {
      this.data = null;
      this.problem = { reason: this.writeBlocked };
    }
    this.phase = this.data && !this.problem ? "ready" : "blocked";
  }

  private async readCurrent(): Promise<void> {
    const current = await this.options.api.get(this.context.token);
    if (!this.live()) return;
    this.accept(current, current.state_version);
    if (!this.data && !this.problem) this.problem = { reason: "network" };
  }

  private async clearSettled(): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.settled) return;
    await this.options.pendingStore.clear(pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null;
    this.registry.release();
    this.settled = false;
    this.idle();
  }

  private async resolve(status: Outcome["status"], code?: string): Promise<void> {
    if (!this.pending) return;
    this.outcome = { commandId: this.pending.intent.command_id, status, ...(code ? { code } : {}) };
    this.registry.settled(status === "accepted" ? "recorded" : "rejected");
    this.settled = true;
    await this.clearSettled();
  }

  private async checkPending(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    // R6: the status of this ID is read only with the gate's ticket (after the identity check, if one is due).
    const reply = await this.registry.read(pending.intent.command_id, ticket => this.options.api.status(this.context.token, pending.intent, ticket));
    if (!this.live()) return;
    if (reply.outcome !== "accepted") this.registry.settled("not_recorded");
    if (reply.outcome === "accepted") {
      if ("pair" in reply.current) this.accept(reply.current, reply.state_version);
      else {
        this.writeBlocked = "forbidden";
        this.data = null;
      }
      await this.resolve("accepted");
      return;
    }
    if (reply.current.profile_id !== this.context.profileId) {
      this.writeBlocked = "profile_changed";
      this.data = null;
      this.problem = { reason: "profile_changed" };
      this.phase = "unresolved";
      return;
    }
    if (reply.current.access.status !== "admitted") {
      this.writeBlocked = "forbidden";
      this.data = null;
      this.problem = { reason: "forbidden" };
    } else {
      // The status read may have advanced calendar state; an older subsequent read cannot undo it.
      if (this.version === null || BigInt(reply.state_version) > BigInt(this.version)) {
        this.version = reply.state_version;
        this.data = null;
      }
      await this.readCurrent();
      if (!this.live()) return;
      if (!this.problem) {
        this.problem = { reason: pending.clientInstanceId !== this.context.clientInstanceId ? "client_changed"
          : pending.intent.payload.expected_pair !== this.context.pair ? "pair_changed" : "not_found" };
      }
    }
    this.phase = "unresolved";
  }

  /** Opening, foreground and explicit checks only read the server; never replay automatically. */
  refresh(): Promise<void> {
    return this.run(async () => {
      if (!this.live()) return;
      this.phase = "checking";
      this.problem = null;
      this.emit();
      if (!this.loaded) {
        this.pending = await this.options.pendingStore.load(this.context.profileId, this.lifetime.signal);
        this.loaded = true;
        if (!this.live()) return;
        if (this.pending) this.registry.hold(this.pending.intent.command_id);
      }
      if (this.settled) {
        await this.clearSettled();
        if (!this.live()) return;
      }
      if (this.pending?.mismatch) {
        await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
        if (!this.live()) return;
        await this.readCurrent();
        if (!this.live()) return;
        this.phase = "unresolved";
        this.problem = { reason: "mismatch", code: "COMMAND_PAYLOAD_MISMATCH" };
      } else if (this.pending) await this.checkPending();
      else {
        await this.readCurrent();
        if (this.live()) this.idle();
      }
    });
  }

  private async applyReply(reply: ManualCommandReply): Promise<void> {
    this.accept(reply.current, reply.state_version);
    if (reply.outcome === "mismatch") {
      this.registry.settled("mismatch");
      this.phase = "unresolved";
      this.problem = { reason: "mismatch", code: reply.error.code };
      if (this.pending) {
        this.pending = { ...this.pending, mismatch: true };
        await this.options.pendingStore.markMismatch(this.pending, this.lifetime.signal);
      }
    } else {
      await this.resolve(reply.outcome, reply.outcome === "rejected" ? reply.error.code : undefined);
    }
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
    const request: ManualSelectionCommand = { ...structuredClone(pending.intent),
      client_instance_id: pending.clientInstanceId, document_id: this.context.documentId };
    const reply = await this.options.api.change(this.context.token, this.context.proof, request);
    if (!this.live()) return;
    await this.applyReply(reply);
  }

  change(cardId: string, selected: boolean): Promise<void> {
    if (!this.snapshot().canChange) return this.running ?? Promise.resolve();
    if (!validId(cardId) || typeof selected !== "boolean") return Promise.reject(new Error("invalid manual selection"));
    const current = this.data!;
    return this.run(async () => {
      if (!this.live()) return;
      this.outcome = null;
      this.pending = { schemaVersion: 1, profileId: this.context.profileId, clientInstanceId: this.context.clientInstanceId,
        intent: { command_id: this.options.newId(), kind: selected ? "learning.select" : "learning.unselect",
          expected_selection_version: current.manual_selection_version,
          payload: { card_id: cardId, expected_pair: current.pair } } };
      await this.sendPending();
    });
  }

  /** A user action, not a scheduler. Semantic payload and original client remain unchanged. */
  retry(): Promise<void> {
    if (!this.retryAllowed()) return this.running ?? Promise.resolve();
    return this.run(async () => {
      // I9: the previous ID is sent again only after a readback that found it not recorded.
      const reason = () => this.problem?.reason;
      if (reason() !== "not_found") {
        await this.checkPending();
        if (!this.live() || reason() !== "not_found" || !this.pending) return;
      }
      await this.sendPending();
    });
  }

  dispose(): void {
    // R3: an ID without a definite answer stays locked to itself in the gate until a later owner reads it.
    // Unsubscribed first: the release below changes the gate, and a disposed owner repaints nothing.
    this.unsubscribe();
    this.registry.release();
    this.lifetime.abort();
    this.phase = "disposed";
    this.data = null;
    // The stored intent stays available to the next authenticated document.
  }
}
