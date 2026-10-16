import { ApiError } from "../api/http";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import { GatePending, pausedBeforeSend } from "../commands/gatePending";
import { PendingStoreError, validId, type LostEnvelope } from "../commands/pendingSlot";
import type { WriteGate } from "../commands/writeGate";
import { blankText, overFeedbackLimit, validFeedbackIntent, type FeedbackApi, type FeedbackIntent, type FeedbackSendReply } from "./feedbackApi";
import type { FeedbackPending, FeedbackPendingStore } from "./feedbackPending";

/**
 * paused: the write gate kept the request on the client (PAUSED_BEFORE_SEND, P03 §4.2): nothing left, the text stays.
 * lost_envelope: a sent message of this profile whose text was deleted on this device (Е02) and whose command the
 * server does not know (not_found): it is never sent again and gives no right to a new message (Q27, C458 п.4).
 */
export type FeedbackProblem = "network" | "not_sent" | "storage" | "invalid_pending" | "pending_changed" | "expired" | "forbidden"
  | "paused" | "lost_envelope";
export type FeedbackSnapshot = {
  phase: "loading" | "idle" | "sending" | "checking" | "unresolved" | "blocked" | "disposed";
  /** The field: the unsent text, or the text of the sent intent while its outcome is unknown. */
  text: string;
  /** Only the server's answer sets it (an applied fact or a status of the same command); the next edit clears it. */
  confirmed: boolean;
  /** A definite refusal: nothing was written, the text stays in the field. */
  refusal: { code: string | null } | null;
  problem: FeedbackProblem | null;
  canEdit: boolean;
  canSend: boolean;
  canRetry: boolean;
};
type Options = {
  api: FeedbackApi;
  pendingStore: FeedbackPendingStore;
  /** A complaint about this card attaches it (К07-051); a general message has none (К07-099). */
  cardId?: string;
  access(): OpenedAccess | null;
  newId(): string;
  onUpdate(snapshot: FeedbackSnapshot): void;
  /** The write gate of the page (P03 M-P03-8): readback registry, status reads by ticket, the send button (I9). */
  gate: WriteGate;
};

/**
 * One message form of one opened document. One command_id per sent text, kept through a timeout, a reload and a manual
 * retry; a reload checks the original ID and never sends by itself. Success is shown only from the server's answer.
 */
export class FeedbackController {
  private readonly scope: { key: string; profileId: string };
  private readonly lifetime = new AbortController();
  private phase: FeedbackSnapshot["phase"] = "loading";
  private text = "";
  private confirmed = false;
  private refusal: FeedbackSnapshot["refusal"] = null;
  private problem: FeedbackProblem | null = null;
  private pending: FeedbackPending | null = null;
  /**
   * Q27: the stored service data of a sent message whose text is gone (Е02). Only the status of its own ID is read;
   * nothing is sent, the field stays closed until the server proves its outcome.
   */
  private lost: LostEnvelope | null = null;
  private loaded = false;
  /** The server confirmed the pending intent; only the local cleanup of its record remains. */
  private settled = false;
  private running: Promise<void> | null = null;
  private readonly registry: GatePending;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: Options) {
    const access = options.access();
    if (!access?.isLive() || !validId(access.profile.profile_id)) throw new Error("invalid feedback access");
    this.scope = { key: access.key, profileId: access.profile.profile_id };
    this.registry = new GatePending(options.gate, "feedback");
    // The buttons follow the gate (M01): a change of net, hold or locks repaints them.
    this.unsubscribe = options.gate.subscribe(() => this.emit());
  }

  private live(): boolean { return !this.lifetime.signal.aborted; }
  private currentAccess(): OpenedAccess | null {
    if (!this.live()) return null;
    const access = this.options.access();
    return access?.isLive() && access.key === this.scope.key && access.profile.profile_id === this.scope.profileId ? access : null;
  }
  private access(): OpenedAccess {
    const access = this.currentAccess();
    if (!access) throw new ClosedAccessError();
    return access;
  }

  snapshot(): FeedbackSnapshot {
    const available = !!this.currentAccess();
    const idle = available && this.loaded && !this.pending && !this.lost && !this.running;
    // A lost envelope: «Проверить снова» reads the same ID again; it never sends.
    const retryable = this.lost ? ["network", "storage", "paused", "lost_envelope"].includes(this.problem ?? "")
      : this.pending ? this.settled || ["network", "not_sent", "storage", "paused"].includes(this.problem ?? "")
        : !this.loaded && this.problem === "storage";
    // I9/M01: while the gate does not let a write through, the send button waits (nothing is queued). «Повторить» reads
    // the same ID first and sends only after not_recorded, so it follows the narrower check predicate (C335): a family
    // lock of this ID (R3) never keeps it — that read is what lifts the lock (R5); the send itself still passes L2.
    const writable = this.registry.writable();
    return { phase: available ? this.phase : "disposed", text: this.text, confirmed: this.confirmed,
      refusal: this.refusal ? { ...this.refusal } : null, problem: this.problem,
      canEdit: idle, canSend: idle && writable && !blankText(this.text) && !overFeedbackLimit(this.text),
      canRetry: available && !this.running && retryable && (this.settled || this.registry.checkable()) };
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }

  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    const task = Promise.resolve().then(action).catch((error: unknown) => {
      if (!this.live()) return;
      if (error instanceof PendingStoreError && error.kind === "lost_envelope" && error.lost) {
        // The stored message of this profile lost its text (Е02) while the form was open: a new intent was refused
        // before anything was written; only the status of the old ID is read from now on.
        if (this.pending && this.pending.intent.command_id !== error.lost.commandId) this.pending = null;
        this.adoptLost(error.lost, true);
        this.problem = "lost_envelope";
      } else if (error instanceof PendingStoreError) {
        this.problem = error.kind === "invalid" ? "invalid_pending" : error.kind === "changed" ? "pending_changed" : "storage";
      } else if (pausedBeforeSend(error)) {
        // Nothing left the client (a send) or nothing was read (a readback the gate holds or cancelled): not a lost reply.
        this.problem = "paused";
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.problem = error.status === 401 ? "expired" : "forbidden";
      } else this.problem = "network"; // a lost reply or a closed handle: the outcome stays unknown, never a new command
      // The outcome of the lost message stays unknown: its own status, never «the text is kept, send again».
      if (this.lost && (this.problem === "network" || this.problem === "storage")) this.problem = "lost_envelope";
      this.phase = this.pending || this.lost ? "unresolved" : "blocked";
    }).finally(() => {
      if (this.running === task) this.running = null;
      this.emit();
    });
    this.running = task;
    return task;
  }

  edit(text: string): void {
    if (!this.snapshot().canEdit) return;
    this.text = text;
    this.confirmed = false;
    this.refusal = null;
    this.problem = null;
    this.emit();
  }

  /** A confirmed message empties the field; the record of the intent is removed afterwards and may fail on its own. */
  private async settle(): Promise<void> {
    this.settled = true;
    this.refusal = null;
    await this.clearSettled();
  }
  private async clearSettled(): Promise<void> {
    if (!this.pending || !this.settled) return;
    await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null;
    this.registry.release();
    this.settled = false;
    // Only a cleared record shows the success: a failed cleanup must not say "accepted" and "storage error" at once.
    this.confirmed = true;
    this.text = "";
    this.problem = null;
    this.phase = "idle";
  }
  /**
   * A definite refusal wrote nothing: the intent is dropped, the text stays, the next send is a new command.
   * A denial (401/403) carries only a problem; the "send again" refusal text would be false for it.
   */
  private async refuse(refusal: { code: string | null } | null, problem: FeedbackProblem | null = null): Promise<void> {
    if (!this.pending) return;
    this.registry.settled("rejected");
    await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null;
    this.registry.release();
    this.refusal = refusal;
    this.problem = problem;
    this.phase = "idle";
  }

  private adoptLost(lost: LostEnvelope, keepText = false): void {
    this.lost = lost;
    this.loaded = true;
    // The text of the lost message is gone; nothing of it is guessed or restored. A new unsent text typed here stays.
    if (!keepText) this.text = "";
    this.registry.hold(lost.commandId);
  }

  /**
   * Q27 for a message: the status of exactly the stored command_id, by its stored profile and card, with the strict
   * checks of status (feedbackApi.statusById). accepted — the message was recorded: the pointer is removed after this
   * proof only; not_found — it stays closed (no new message, no resend); anything else stays unknown.
   */
  private async reconcileLost(lost: LostEnvelope): Promise<void> {
    const payload = (lost.record.intent as { payload?: { card_id?: unknown } } | undefined)?.payload;
    const cardId = typeof payload?.card_id === "string" ? payload.card_id : null;
    if (lost.kind !== "feedback.send" || lost.profileId.toLowerCase() !== this.scope.profileId.toLowerCase()) {
      throw new PendingStoreError("invalid");
    }
    const reply = await this.registry.read(lost.commandId, ticket =>
      this.access().run(({ token }) => this.options.api.statusById(token, this.scope.profileId, { commandId: lost.commandId, cardId }, ticket)));
    if (!this.live()) return;
    this.access();
    if (reply.outcome === "accepted") {
      this.registry.settled("recorded");
      await this.options.pendingStore.clearLost(lost, this.lifetime.signal);
      if (!this.live()) return;
      this.lost = null;
      this.registry.release();
      this.confirmed = true;
      this.text = "";
      this.problem = null;
      this.phase = "idle";
      return;
    }
    this.registry.settled("not_recorded");
    this.problem = "lost_envelope";
    this.phase = "unresolved";
  }

  /** Reads the durable intent once, then asks the server about the same command_id. */
  private async reconcile(): Promise<void> {
    this.phase = "checking";
    this.problem = null;
    this.emit();
    if (!this.loaded) {
      let lost: LostEnvelope | null = null;
      try {
        this.pending = await this.options.pendingStore.load(this.scope.profileId, this.lifetime.signal);
      } catch (error) {
        if (!(error instanceof PendingStoreError && error.kind === "lost_envelope" && error.lost)) throw error;
        lost = error.lost;
      }
      if (!this.live()) return;
      this.access();
      this.loaded = true;
      if (lost) this.adoptLost(lost);
      if (this.pending) { this.text = this.pending.intent.payload.text; this.registry.hold(this.pending.intent.command_id); }
    }
    if (this.lost) { await this.reconcileLost(this.lost); return; }
    if (this.settled) { await this.clearSettled(); return; }
    const pending = this.pending;
    if (!pending) { this.phase = "idle"; return; }
    // R6: the status of this ID is read only with the gate's ticket (after the identity check, if one is due).
    const reply = await this.registry.read(pending.intent.command_id, ticket =>
      this.access().run(({ token }) => this.options.api.status(token, this.scope.profileId, pending.intent, ticket)));
    if (!this.live()) return;
    this.access();
    if (reply.outcome === "accepted") { this.registry.settled("recorded"); await this.settle(); return; }
    this.registry.settled("not_recorded");
    this.problem = "not_sent";
    this.phase = "unresolved";
  }
  /** Nothing to resolve once the stored intent is loaded and absent: a foreground must not lock the field for nothing. */
  refresh(): Promise<void> {
    if (this.loaded && !this.pending && !this.lost) return this.running ?? Promise.resolve();
    return this.run(() => this.reconcile());
  }

  private async sendPending(source: OpenedAccess): Promise<void> {
    const pending = this.pending;
    if (!pending || !this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    this.phase = "sending";
    this.problem = null;
    this.refusal = null;
    this.emit();
    // From now on a request of this ID may leave: its outcome is unknown until a definite answer (R1).
    this.registry.hold(pending.intent.command_id);
    await this.options.pendingStore.save(pending, this.lifetime.signal);
    if (!this.live()) return;
    // A foreground replaced the handle: finishing a storage write cannot move a send onto the new one.
    if (this.access() !== source) throw new ClosedAccessError();
    let reply: FeedbackSendReply;
    try {
      reply = await source.run(({ token, proof, clientInstanceId, documentId }) =>
        this.options.api.send(token, proof, { clientInstanceId, documentId }, pending.intent));
    } catch (error) {
      // 401/403 are answered before anything is written, so the intent is not unknown.
      if (this.live() && error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        await this.refuse(null, error.status === 401 ? "expired" : "forbidden");
        return;
      }
      throw error;
    }
    if (!this.live()) return;
    if (this.access() !== source) throw new ClosedAccessError();
    if (reply.outcome === "accepted") { this.registry.settled("recorded"); await this.settle(); }
    else await this.refuse({ code: reply.code });
  }

  send(): Promise<void> {
    if (!this.snapshot().canSend) return this.running ?? Promise.resolve();
    const source = this.access();
    const cardId = this.options.cardId;
    const intent: FeedbackIntent = { command_id: this.options.newId(), kind: "feedback.send",
      payload: { text: this.text, ...(cardId === undefined ? {} : { card_id: cardId.toLowerCase() }) } };
    if (!validFeedbackIntent(intent)) throw new Error("invalid feedback intent");
    return this.run(async () => {
      this.confirmed = false;
      this.pending = { schemaVersion: 1, profileId: this.scope.profileId, intent };
      await this.sendPending(source);
    });
  }
  /** Checks the same command_id first; only a missing command is sent again, and exactly the retained intent. */
  retry(): Promise<void> {
    if (!this.snapshot().canRetry) return this.running ?? Promise.resolve();
    return this.run(async () => {
      await this.reconcile();
      if (this.live() && this.pending && !this.settled && this.problem === "not_sent") await this.sendPending(this.access());
    });
  }
  dispose(): void {
    // R3: an ID without a definite answer stays locked to itself in the gate until a later owner reads it.
    // Unsubscribed first: the release below changes the gate, and a disposed owner repaints nothing.
    this.unsubscribe();
    this.registry.release();
    this.lifetime.abort();
    this.phase = "disposed";
    this.text = "";
  }
}
