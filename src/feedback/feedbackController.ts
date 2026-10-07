import { ApiError } from "../api/http";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import { PendingStoreError, validId } from "../commands/pendingSlot";
import { blankText, validFeedbackIntent, type FeedbackApi, type FeedbackIntent, type FeedbackSendReply } from "./feedbackApi";
import type { FeedbackPending, FeedbackPendingStore } from "./feedbackPending";

export type FeedbackProblem = "network" | "not_sent" | "storage" | "invalid_pending" | "pending_changed" | "expired" | "forbidden";
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
  private loaded = false;
  /** The server confirmed the pending intent; only the local cleanup of its record remains. */
  private settled = false;
  private running: Promise<void> | null = null;

  constructor(private readonly options: Options) {
    const access = options.access();
    if (!access?.isLive() || !validId(access.profile.profile_id)) throw new Error("invalid feedback access");
    this.scope = { key: access.key, profileId: access.profile.profile_id };
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
    const idle = available && this.loaded && !this.pending && !this.running;
    const retryable = this.pending ? this.settled || ["network", "not_sent", "storage"].includes(this.problem ?? "")
      : !this.loaded && this.problem === "storage";
    return { phase: available ? this.phase : "disposed", text: this.text, confirmed: this.confirmed,
      refusal: this.refusal ? { ...this.refusal } : null, problem: this.problem,
      canEdit: idle, canSend: idle && !blankText(this.text), canRetry: available && !this.running && retryable };
  }
  private emit(): void { if (this.live()) this.options.onUpdate(this.snapshot()); }

  private run(action: () => Promise<void>): Promise<void> {
    if (!this.live()) return Promise.resolve();
    if (this.running) return this.running;
    const task = Promise.resolve().then(action).catch((error: unknown) => {
      if (!this.live()) return;
      if (error instanceof PendingStoreError) {
        this.problem = error.kind === "invalid" ? "invalid_pending" : error.kind === "changed" ? "pending_changed" : "storage";
      } else if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        this.problem = error.status === 401 ? "expired" : "forbidden";
      } else this.problem = "network"; // a lost reply or a closed handle: the outcome stays unknown, never a new command
      this.phase = this.pending ? "unresolved" : "blocked";
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
    await this.options.pendingStore.clear(this.pending, this.lifetime.signal);
    if (!this.live()) return;
    this.pending = null;
    this.refusal = refusal;
    this.problem = problem;
    this.phase = "idle";
  }

  /** Reads the durable intent once, then asks the server about the same command_id. */
  private async reconcile(): Promise<void> {
    this.phase = "checking";
    this.problem = null;
    this.emit();
    if (!this.loaded) {
      this.pending = await this.options.pendingStore.load(this.scope.profileId, this.lifetime.signal);
      if (!this.live()) return;
      this.access();
      this.loaded = true;
      if (this.pending) this.text = this.pending.intent.payload.text;
    }
    if (this.settled) { await this.clearSettled(); return; }
    const pending = this.pending;
    if (!pending) { this.phase = "idle"; return; }
    const reply = await this.access().run(({ token }) => this.options.api.status(token, this.scope.profileId, pending.intent));
    if (!this.live()) return;
    this.access();
    if (reply.outcome === "accepted") { await this.settle(); return; }
    this.problem = "not_sent";
    this.phase = "unresolved";
  }
  /** Nothing to resolve once the stored intent is loaded and absent: a foreground must not lock the field for nothing. */
  refresh(): Promise<void> {
    if (this.loaded && !this.pending) return this.running ?? Promise.resolve();
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
    if (reply.outcome === "accepted") await this.settle();
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
    this.lifetime.abort();
    this.phase = "disposed";
    this.text = "";
  }
}
