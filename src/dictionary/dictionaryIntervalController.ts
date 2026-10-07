import type {
  DictionaryContextCapabilities, DictionaryContextInterval, DictionaryContextReference, OpenDictionaryContext,
} from "../api/generated";
import { ApiError } from "../api/http";
import { uuid, version } from "../api/wireValidation";
import {
  commandOutcomeUnknown, dictionaryIncreaseIntent, dictionaryUndoIntent, dictionaryUndoOfferIntent,
  type DictionaryCommandReply, type DictionaryCommandStatus, type DictionaryContextAddress, type DictionaryContextCurrent,
  type DictionaryContextRead, type DictionaryIntervalApi, type DictionaryIntervalCommand, type DictionaryIntervalIntent,
  type DictionaryOrigin, type IntervalChoice, type UndoOfferIntent,
} from "./intervalApi";

/**
 * The controller's only dependency: one opened document. Credentials stay behind it;
 * an obsolete document must fail its calls before any refusal can revoke access.
 */
export type DictionaryIntervalPort = {
  readonly origin: DictionaryOrigin;
  send(command: DictionaryIntervalCommand): Promise<DictionaryCommandReply>;
  read(address: DictionaryContextAddress): Promise<DictionaryContextRead>;
  status(command: DictionaryIntervalCommand): Promise<DictionaryCommandStatus>;
};

export function sendDictionaryIntervalCommand(
  api: DictionaryIntervalApi, token: string, proof: string, command: DictionaryIntervalCommand,
): Promise<DictionaryCommandReply> {
  switch (command.kind) {
    case "context.open": return api.openContext(token, proof, command);
    case "context.close": return api.closeContext(token, proof, command);
    case "interval.increase": return api.increase(token, proof, command);
    case "action.undo": return api.undo(token, proof, command);
    case "action.undo_offer.open":
    case "action.undo_offer.close": return api.undoOffer(token, proof, command);
  }
}

/** A port over fixed credentials of one document. */
export function dictionaryIntervalPort(api: DictionaryIntervalApi, token: string, proof: string, origin: DictionaryOrigin): DictionaryIntervalPort {
  const fixed = { client_instance_id: origin.client_instance_id, document_id: origin.document_id };
  return {
    origin: fixed,
    send: command => sendDictionaryIntervalCommand(api, token, proof, command),
    read: address => api.readContext(token, proof, address),
    status: command => api.commandStatus(token, proof, command),
  };
}

export type DictionaryIntervalProblem = {
  reason: "network" | "not_found" | "rejected" | "mismatch" | "setup_required" | "expired" | "forbidden"
    | "invalid" | "load" | "stale_response";
  code?: string;
};
/** CT 2.1.2 p.3, К07-122: the visible window of the one undo offer, counted from the first confirmed open. */
export const UNDO_OFFER_MS = 3000;

/** Monotonic time and timers of the live document (performance.now: a wall-clock change never moves the deadline). */
export type IntervalClock = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};
const systemClock: IntervalClock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** An accepted own increase or undo, with the state version of its reply: the host reads the card again (К07-122). */
export type DictionaryIntervalApplied = { kind: "interval.increase" | "action.undo"; commandId: string; stateVersion: string };

export type DictionaryIntervalSnapshot = {
  phase: "idle" | "opening" | "ready" | "closed" | "unavailable" | "failed" | "disposed";
  cardId: string | null;
  context: DictionaryContextReference | null;
  view: OpenDictionaryContext["view"] | null;
  interval: DictionaryContextInterval | null;
  capabilities: DictionaryContextCapabilities;
  /** The one unresolved intent; it blocks every other intent. busy: its request or its status check is on the way. */
  pending: { kind: DictionaryIntervalIntent["kind"]; commandId: string; status: "sending" | "unknown"; busy: boolean } | null;
  problem: DictionaryIntervalProblem | null;
  /** state_version of the shown context, never lower than an observed one. */
  stateVersion: string | null;
  canIncrease: boolean;
  canUndo: boolean;
  /** Only after an unknown outcome: the same command, by an explicit user action. */
  canRetry: boolean;
  /** «Отменить увеличение» with its draining bar: shown only before the local deadline (CT 2.1.2 p.3–4). */
  undoOffer: { remainingMs: number; durationMs: number } | null;
  /** The last accepted own increase or undo of this controller. */
  applied: DictionaryIntervalApplied | null;
};
/**
 * What a following binding of the same document and card may continue; memory only.
 * contextId is null only while the initial context.open itself is unresolved (CON:149: the same intent continues).
 */
export type DictionaryIntervalHandoff = {
  cardId: string; contextId: string | null; pending: DictionaryIntervalCommand | null;
  /** The undo offer of an own increase in this same document: its deadline is never extended by a new handle. */
  offer?: DictionaryUndoOfferHandoff | null;
};
type OfferPhase = "opening" | "shown" | "undo" | "closing" | "done";
type ServiceEntry = { command: DictionaryIntervalCommand<UndoOfferIntent>; status: "sending" | "unknown"; busy: boolean; resent: boolean };
/**
 * CT 2.1.2: the one offer of an own increase. opening → (first confirmed open) shown → a click before the deadline
 * (undo, through the ordinary pending) or the deadline (closing, a hidden close). done: nothing more is sent or shown.
 */
type Offer = { actionId: string; phase: OfferPhase; deadline: number | null; open: ServiceEntry | null; close: ServiceEntry | null };
export type DictionaryUndoOfferHandoff = {
  actionId: string; phase: "opening" | "shown" | "closing"; deadline: number | null;
  open: DictionaryIntervalCommand<UndoOfferIntent> | null; close: DictionaryIntervalCommand<UndoOfferIntent> | null;
};

type Options = {
  port: DictionaryIntervalPort;
  isLive(): boolean;
  newId(): string;
  /** A confirmed version observed elsewhere in this document; it only raises the floor. */
  minimumStateVersion?(): string | null;
  onUpdate(snapshot: DictionaryIntervalSnapshot): void;
  clock?: IntervalClock;
};
type Entry = { command: DictionaryIntervalCommand; status: "sending" | "unknown"; busy: boolean };
type Closing = Entry & { contextId: string; done: boolean };

const none: DictionaryContextCapabilities = { interval_increase: null, undo_offer: null, undo_target: null };
const same = (left: string | null, right: string | null) => left !== null && right !== null && left.toLowerCase() === right.toLowerCase();

function refusal(error: unknown): DictionaryIntervalProblem {
  if (error instanceof ApiError && error.status === 401) return { reason: "expired", code: error.code };
  if (error instanceof ApiError && error.status === 403) return { reason: "forbidden", code: error.code };
  return { reason: "invalid", ...(error instanceof ApiError && error.code ? { code: error.code } : {}) };
}
function readProblem(error: unknown): DictionaryIntervalProblem {
  return error instanceof ApiError && (error.status === 401 || error.status === 403) ? refusal(error) : { reason: "load" };
}

/**
 * One dictionary context of one card in one live document (IT §B.1). Validation of choices
 * happens synchronously before any request; outcomes never repeat a command by themselves.
 */
export class DictionaryIntervalController {
  private cardId: string | null = null;
  private contextId: string | null = null;
  private current: DictionaryContextCurrent | null = null;
  private currentVersion: string | null = null;
  private floor: string | null = null;
  private pending: Entry | null = null;
  private closing: Closing | null = null;
  private closeRequested = false;
  private undoDropped = false;
  private setupMissing = false;
  private problem: DictionaryIntervalProblem | null = null;
  private reads = 0;
  private disposed = false;
  /** The action of the last accepted own increase: only its offer is opened (CT 2.1.2 p.2). */
  private own: string | null = null;
  private undoOffer: Offer | null = null;
  private timer: { handle: unknown } | null = null;
  private applied: DictionaryIntervalApplied | null = null;
  private readonly clock: IntervalClock;

  constructor(private readonly options: Options) {
    this.clock = options.clock ?? systemClock;
  }

  private live(): boolean { return !this.disposed && this.options.isLive(); }

  private raise(observed: string | null | undefined): void {
    if (observed === null || observed === undefined) return;
    if (!version(observed)) throw new Error("invalid dictionary state version");
    if (this.floor === null || BigInt(observed) > BigInt(this.floor)) this.floor = observed;
  }
  private minimum(): string | null {
    this.raise(this.options.minimumStateVersion?.() ?? null);
    return this.floor;
  }
  private stale(): boolean {
    const floor = this.minimum();
    return this.currentVersion !== null && floor !== null && BigInt(this.currentVersion) < BigInt(floor);
  }

  /** The offer the user may act on now; hidden while closing, stale or busy-dropped. */
  private offer(): DictionaryContextCurrent {
    const current = this.current;
    if (this.closeRequested || current?.status !== "open" || this.stale()) return { status: "unavailable" };
    return { ...current,
      interval: this.setupMissing ? null : current.interval,
      capabilities: {
        interval_increase: this.setupMissing ? null : current.capabilities.interval_increase,
        // The undo offer (core C-INTV-OFFER) is hidden together with its undo; M-INTV sends open/close.
        undo_offer: this.undoDropped ? null : current.capabilities.undo_offer,
        undo_target: this.undoDropped ? null : current.capabilities.undo_target,
      } };
  }

  snapshot(): DictionaryIntervalSnapshot {
    const pending = this.pending;
    if (!this.live()) {
      const disposed: DictionaryIntervalSnapshot = { phase: "disposed", cardId: this.cardId, context: null, view: null,
        interval: null, capabilities: none, pending: null, problem: null, stateVersion: null,
        canIncrease: false, canUndo: false, canRetry: false, undoOffer: null, applied: null };
      return structuredClone(disposed);
    }
    const current = this.current, stale = this.stale();
    let phase: DictionaryIntervalSnapshot["phase"];
    if (this.closeRequested) phase = "closed";
    else if (current === null) phase = this.cardId === null ? "idle" : pending?.command.kind === "context.open" || !this.problem ? "opening" : "failed";
    else if (current.status === "open") phase = current.view.status === "available" ? "ready" : "unavailable";
    else phase = current.status;
    const offer = this.offer();
    const open = offer.status === "open" ? offer : null;
    const shown = current !== null && current.status !== "unavailable" ? current : null;
    const free = pending === null && phase === "ready";
    const strip = this.visibleOffer();
    const snapshot: DictionaryIntervalSnapshot = {
      phase, cardId: this.cardId,
      context: shown ? shown.context : null,
      view: current?.status === "open" && !this.closeRequested ? current.view : null,
      interval: open ? open.interval : null,
      capabilities: open ? open.capabilities : none,
      pending: pending ? { kind: pending.command.kind, commandId: pending.command.command_id,
        status: pending.status === "sending" && pending.busy ? "sending" : "unknown", busy: pending.busy } : null,
      problem: this.problem ?? (stale ? { reason: "stale_response" } : null),
      stateVersion: this.currentVersion,
      canIncrease: free && open !== null && open.interval !== null && open.capabilities.interval_increase !== null,
      canUndo: free && strip !== null,
      canRetry: pending !== null && pending.status === "unknown" && !pending.busy && !this.closeRequested,
      undoOffer: strip,
      applied: this.applied,
    };
    return structuredClone(snapshot);
  }

  private notify(): void {
    if (this.live()) this.options.onUpdate(this.snapshot());
  }

  /**
   * Adopt a validated projection of this controller's own context. An older state_version than one
   * already observed, another context or another card never replaces what is shown (K10-097).
   */
  private adopt(reply: DictionaryContextRead): boolean {
    const floor = this.minimum();
    if (floor !== null && BigInt(reply.state_version) < BigInt(floor)) return false;
    const current = reply.current;
    if (current.status !== "unavailable" && (!same(current.context.id, this.contextId) || !same(current.context.card_id, this.cardId))) {
      this.raise(reply.state_version);
      return false;
    }
    this.raise(reply.state_version);
    // After close the context shows no offer again, whatever a late reply carries.
    if (this.closeRequested && current.status === "open") return false;
    this.current = structuredClone(current);
    this.currentVersion = reply.state_version;
    this.undoDropped = false;
    this.setupMissing = false;
    this.syncOffer();
    return true;
  }

  /**
   * Problem after an own accepted outcome. A reply older than an already shown state adds nothing;
   * stale_response stays only while nothing current is shown (the snapshot also derives it from the floor).
   */
  private unadopted(adopted: boolean): DictionaryIntervalProblem | null {
    if (adopted || this.closeRequested) return null;
    const shown = this.current;
    const own = shown !== null && (shown.status === "unavailable" || same(shown.context.id, this.contextId));
    return own && !this.stale() ? null : { reason: "stale_response" };
  }

  /** Start a new context for a card. Invalid input throws before any state change or request. */
  open(cardId: string): Promise<void> {
    if (!uuid(cardId)) throw new Error("dictionary card ID required");
    if (!this.live() || this.pending) return Promise.resolve();
    this.cardId = cardId.toLowerCase();
    this.closeRequested = false;
    this.closing = null;
    return this.start({ kind: "context.open", command_id: this.options.newId(), card_id: this.cardId, ...this.options.port.origin });
  }

  /**
   * Continue a context of the same document after a new access handle (foreground):
   * an unresolved command is checked by status only, then the context is read.
   * An unresolved initial context.open is the same intent: its status decides; not_found waits
   * for an explicit retry with the same ID, never a new open (CON:147, CON:149, B3).
   * A context the document no longer sees is replaced by one new open.
   */
  async resume(handoff: DictionaryIntervalHandoff): Promise<void> {
    const opening = handoff.pending?.kind === "context.open" ? handoff.pending : null;
    if (!uuid(handoff.cardId) || (handoff.contextId === null ? opening === null : !uuid(handoff.contextId))
      || (opening !== null && opening.card_id.toLowerCase() !== handoff.cardId.toLowerCase())) {
      throw new Error("dictionary context required");
    }
    if (!this.live()) return;
    this.cardId = handoff.cardId.toLowerCase();
    // The context being opened is known only from the open's own fact.
    this.contextId = opening ? null : handoff.contextId!.toLowerCase();
    if (handoff.offer && this.contextId !== null) this.restoreOffer(handoff.offer);
    if (handoff.pending) {
      const entry: Entry = { command: structuredClone(handoff.pending), status: "unknown", busy: false };
      this.pending = entry;
      await this.check(entry);
    }
    await this.read();
    await this.continueOffer();
    const cardId = this.cardId;
    if (this.live() && this.pending === null && this.current?.status === "unavailable" && cardId !== null) await this.open(cardId);
  }

  /** Re-read the context; an unresolved command is checked by status first, never re-sent. */
  async refresh(): Promise<void> {
    const entry = this.pending;
    if (entry && entry.status === "unknown" && !entry.busy) await this.check(entry);
    await this.read();
    await this.continueOffer();
  }

  /** Only an offered step of the written direction; anything else throws before a request (N26). */
  increase(choice: IntervalChoice): Promise<void> {
    if (!this.live() || this.pending) return Promise.resolve();
    const intent = dictionaryIncreaseIntent(this.offer(), this.options.newId(), choice);
    return this.start({ ...intent, ...this.options.port.origin });
  }

  /**
   * Only the shown offer, strictly before its deadline (CT 2.1.2 p.4): one action.undo of the current undo_target, and the
   * offer's close is never created. At or after the deadline the click is not taken: the offer hides and closes.
   */
  undo(): Promise<void> {
    if (!this.live() || this.pending) return Promise.resolve();
    const offer = this.undoOffer;
    if (offer === null || offer.phase !== "shown" || offer.deadline === null) return Promise.resolve();
    if (this.clock.now() >= offer.deadline) {
      this.expire();
      return Promise.resolve();
    }
    if (this.visibleOffer() === null) return Promise.resolve();
    const intent = dictionaryUndoIntent(this.offer(), this.options.newId());
    offer.phase = "undo";
    this.cancelTimer();
    return this.start({ ...intent, ...this.options.port.origin });
  }

  /** Repeat exactly the unresolved command: same ID and payload (K10-054, K10-086). */
  retry(): Promise<void> {
    const entry = this.pending;
    if (!this.live() || !entry || entry.status !== "unknown" || entry.busy || this.closeRequested) return Promise.resolve();
    return this.execute(entry);
  }

  /** Undo and increase disappear at once, even while a command is pending; the context is then closed. */
  close(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    this.closeRequested = true;
    // Leaving the context ends the offer on the server (CT 2.3): no open or close of it follows.
    this.endOffer();
    this.notify();
    return this.sendClose();
  }

  /** What a following binding of the same document may continue; null after close. */
  handoff(): DictionaryIntervalHandoff | null {
    if (this.closeRequested || this.cardId === null) return null;
    const pending = this.pending ? structuredClone(this.pending.command) : null;
    // An unresolved open continues as the same command; its context is not known yet.
    if (pending?.kind === "context.open") return { cardId: this.cardId, contextId: null, pending };
    if (this.contextId === null) return null;
    return { cardId: this.cardId, contextId: this.contextId, pending, offer: this.offerHandoff() };
  }

  /** No request: an open context stays on the server until close or the next open. */
  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    this.reads += 1;
    this.pending = null;
    this.closing = null;
    this.current = null;
  }

  private start(command: DictionaryIntervalCommand): Promise<void> {
    const entry: Entry = { command, status: "sending", busy: false };
    this.pending = entry;
    this.problem = null;
    return this.execute(entry);
  }

  private async execute(entry: Entry): Promise<void> {
    entry.status = "sending";
    entry.busy = true;
    this.problem = null;
    this.notify();
    let reply: DictionaryCommandReply;
    try {
      reply = await this.options.port.send(entry.command);
    } catch (error) {
      if (!this.live() || this.pending !== entry) return;
      entry.busy = false;
      if (commandOutcomeUnknown(error)) {
        entry.status = "unknown";
        this.problem = { reason: "network" };
        this.notify();
        await this.check(entry);
        return;
      }
      // An HTTP refusal without a fact: nothing was saved.
      this.pending = null;
      this.problem = refusal(error);
      this.notify();
      return;
    }
    if (!this.live() || this.pending !== entry) return;
    this.pending = null;
    await this.settle(entry.command, reply);
  }

  private async settle(command: DictionaryIntervalCommand, reply: DictionaryCommandReply): Promise<void> {
    if (reply.outcome === "accepted") {
      if (command.kind === "context.open") this.contextId = reply.command.context_id;
      this.accepted(command, reply.command.action_id, reply.state_version);
      this.problem = this.unadopted(this.adopt(reply));
      // A newer read may already show the offer of this increase: it is opened even when this reply is older.
      this.syncOffer();
      this.notify();
      if (command.kind === "context.open" && this.closeRequested) await this.sendClose();
      return;
    }
    const code = reply.error.code;
    this.problem = reply.outcome === "mismatch" ? { reason: "mismatch", code }
      : code === "SETUP_REQUIRED" ? { reason: "setup_required", code } : { reason: "rejected", code };
    // An open refusal may show an earlier context of another card: only "unavailable" is this card's.
    if (command.kind !== "context.open" || reply.current.status === "unavailable") this.adopt(reply);
    else this.raise(reply.state_version);
    if (code === "SETUP_REQUIRED") this.setupMissing = true;
    if (code === "CAPABILITY_EXPIRED" || code === "DOCUMENT_STALE") this.undoDropped = true;
    this.notify();
    // One fresh read for a changed preview or a lost right; never an automatic command (TZA:145).
    if (code === "VERSION_CONFLICT" || code === "CAPABILITY_EXPIRED" || code === "DOCUMENT_STALE") await this.read();
  }

  /** One status request for an unknown outcome. */
  private async check(entry: Entry): Promise<void> {
    if (entry.busy || !this.live()) return;
    entry.busy = true;
    this.notify();
    let status: DictionaryCommandStatus;
    try {
      status = await this.options.port.status(entry.command);
    } catch (error) {
      if (!this.live() || this.pending !== entry) return;
      entry.busy = false;
      this.problem = error instanceof ApiError && (error.status === 401 || error.status === 403) ? refusal(error) : { reason: "network" };
      this.notify();
      return;
    }
    if (!this.live() || this.pending !== entry) return;
    entry.busy = false;
    if (status.outcome === "accepted") {
      this.pending = null;
      if (entry.command.kind === "context.open") this.contextId = status.command.context_id;
      this.accepted(entry.command, status.command.action_id, status.state_version);
      this.problem = this.unadopted(this.adopt(status));
      // A newer read may already show the offer of this increase: it is opened even when this reply is older.
      this.syncOffer();
      this.notify();
      if (entry.command.kind === "context.open" && this.closeRequested) await this.sendClose();
      return;
    }
    if (status.outcome === "not_found") {
      // Not saved; the current is a profile, not this context. Only retry() repeats the command.
      this.raise(status.state_version);
      this.problem = { reason: "not_found" };
      this.notify();
      return;
    }
    this.pending = null;
    this.problem = { reason: "mismatch", code: status.error.code };
    this.notify();
    await this.read();
  }

  private async read(): Promise<void> {
    if (!this.live() || this.contextId === null || this.cardId === null) return;
    const generation = ++this.reads;
    try {
      const reply = await this.options.port.read({ context_id: this.contextId, card_id: this.cardId, ...this.options.port.origin });
      if (!this.live() || generation !== this.reads) return;
      this.adopt(reply);
      if (this.problem?.reason === "load") this.problem = null;
    } catch (error) {
      if (!this.live() || generation !== this.reads) return;
      if (!this.problem || this.problem.reason === "load") this.problem = readProblem(error);
    }
    this.notify();
  }

  private sendClose(): Promise<void> {
    if (!this.live() || !this.closeRequested || this.contextId === null || this.cardId === null) return Promise.resolve();
    let closing = this.closing;
    if (closing && !same(closing.contextId, this.contextId)) closing = null;
    if (closing && (closing.busy || closing.done)) return Promise.resolve();
    if (!closing) {
      closing = { command: { kind: "context.close", command_id: this.options.newId(), context_id: this.contextId,
        card_id: this.cardId, ...this.options.port.origin }, status: "sending", busy: false, contextId: this.contextId, done: false };
      this.closing = closing;
    }
    return this.executeClose(closing);
  }

  /** A repeated close sends the same command; an unknown outcome is checked once by status. */
  private async executeClose(closing: Closing): Promise<void> {
    closing.busy = true;
    try {
      const reply = await this.options.port.send(closing.command);
      if (!this.live() || this.closing !== closing) return;
      closing.done = true;
      // A refused close (DOCUMENT_STALE) means the context is not open for this document either.
      this.adopt(reply);
    } catch (error) {
      if (!this.live() || this.closing !== closing) return;
      if (!commandOutcomeUnknown(error)) {
        closing.done = true;
      } else {
        try {
          const status = await this.options.port.status(closing.command);
          if (!this.live() || this.closing !== closing) return;
          if (status.outcome === "accepted") { closing.done = true; this.adopt(status); }
          else if (status.outcome === "mismatch") closing.done = true;
        } catch {
          // Still unknown: a later close() repeats the same command.
        }
      }
    } finally {
      closing.busy = false;
    }
    this.notify();
  }

  /** Bookkeeping of an accepted own command before its projection is adopted. */
  private accepted(command: DictionaryIntervalCommand, actionId: string | null, stateVersion: string): void {
    if (command.kind !== "interval.increase" && command.kind !== "action.undo") return;
    // The reply and every status check of an increase name the same offer, never a new one (CT 2.1.2 p.1).
    if (command.kind === "interval.increase" && actionId !== null) this.own = actionId.toLowerCase();
    this.applied = { kind: command.kind, commandId: command.command_id, stateVersion };
  }

  /** The strip the user may press now: the offer this controller opened, still offered by the server, before its deadline. */
  private visibleOffer(): DictionaryIntervalSnapshot["undoOffer"] {
    const offer = this.undoOffer;
    if (!this.live() || offer === null || offer.phase !== "shown" || offer.deadline === null) return null;
    const remaining = offer.deadline - this.clock.now();
    const shown = this.offer();
    if (remaining <= 0 || shown.status !== "open") return null;
    const { undo_offer: live, undo_target: target } = shown.capabilities;
    if (live === null || live.status !== "offered" || !same(live.action_id, offer.actionId)
      || target === null || !same(target.action_id, offer.actionId)) return null;
    return { remainingMs: remaining, durationMs: UNDO_OFFER_MS };
  }

  /**
   * Follow the server's offer after every adopted projection. An offer it no longer names is over (next action, closed
   * context, new document, consumed): nothing is opened or closed for it. A pending offer of the own increase is opened once.
   */
  private syncOffer(): void {
    const current = this.current;
    const live = current?.status === "open" ? current.capabilities.undo_offer : null;
    const offer = this.undoOffer;
    if (offer !== null && offer.phase !== "done" && (live === null || !same(live.action_id, offer.actionId))) this.endOffer();
    if (live === null || live.status !== "pending" || !same(live.action_id, this.own) || this.closeRequested) return;
    if (this.undoOffer !== null && same(this.undoOffer.actionId, live.action_id)) return;
    this.endOffer();
    this.undoOffer = { actionId: live.action_id.toLowerCase(), phase: "opening", deadline: null, open: null, close: null };
    queueMicrotask(() => { void this.continueOffer(); });
  }

  private endOffer(): void {
    if (this.undoOffer !== null && this.undoOffer.phase !== "undo") this.undoOffer.phase = "done";
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer.handle);
    this.timer = null;
  }

  private scheduleExpiry(offer: Offer): void {
    this.cancelTimer();
    if (offer.phase !== "shown" || offer.deadline === null || !this.live()) return;
    const timer = { handle: null as unknown };
    timer.handle = this.clock.setTimeout(() => {
      if (this.timer === timer) this.timer = null;
      this.expire();
    }, Math.max(0, offer.deadline - this.clock.now()));
    this.timer = timer;
  }

  /** At or after the deadline without a click: hide the strip and send the hidden close (CT 2.1.2 p.4). */
  private expire(): void {
    const offer = this.undoOffer;
    if (!this.live() || offer === null || offer.phase !== "shown" || offer.deadline === null) return;
    if (this.clock.now() < offer.deadline) {
      this.scheduleExpiry(offer);
      return;
    }
    offer.phase = "closing";
    this.cancelTimer();
    this.notify();
    void this.continueOffer();
  }

  /**
   * The next step of the offer lane: open or close once, an unknown outcome checked by status of the same ID.
   * Service commands never wait for the ordinary pending and never block it (CT 2.1.2 p.2, p.5).
   */
  private async continueOffer(): Promise<void> {
    const offer = this.undoOffer;
    if (offer === null || !this.live()) return;
    if (offer.phase === "shown") {
      if (offer.deadline !== null && this.clock.now() >= offer.deadline) this.expire();
      else this.scheduleExpiry(offer);
      return;
    }
    if (offer.phase !== "opening" && offer.phase !== "closing") return;
    if (this.closeRequested) { this.endOffer(); return; }
    const opening = offer.phase === "opening";
    let entry = opening ? offer.open : offer.close;
    if (entry === null) {
      let intent: UndoOfferIntent;
      try {
        intent = dictionaryUndoOfferIntent(this.offer(), this.options.newId(),
          opening ? "action.undo_offer.open" : "action.undo_offer.close", offer.actionId);
      } catch {
        // The shown projection names no live offer any more: it is over, nothing to open or close.
        this.endOffer();
        this.notify();
        return;
      }
      entry = { command: { ...intent, ...this.options.port.origin }, status: "sending", busy: false, resent: false };
      if (opening) offer.open = entry; else offer.close = entry;
      await this.sendService(offer, entry);
      return;
    }
    if (entry.busy) return;
    entry.resent = false;
    await this.checkService(offer, entry);
  }

  /** An ended offer (done, or its context closed) sends nothing more: no status, no repeat of open or close (CT 2.3). */
  private serviceLive(offer: Offer, entry: ServiceEntry): boolean {
    return this.live() && !this.closeRequested && this.undoOffer === offer && offer.phase !== "done"
      && (offer.open === entry || offer.close === entry);
  }

  private async sendService(offer: Offer, entry: ServiceEntry): Promise<void> {
    entry.busy = true;
    entry.status = "sending";
    let reply: DictionaryCommandReply;
    try {
      reply = await this.options.port.send(entry.command);
    } catch (error) {
      if (!this.serviceLive(offer, entry)) return;
      entry.busy = false;
      if (commandOutcomeUnknown(error)) {
        entry.status = "unknown";
        await this.checkService(offer, entry);
        return;
      }
      // An HTTP refusal without a fact: this offer is not shown or closed by the client any more.
      this.serviceDone(offer, entry, false);
      return;
    }
    if (!this.serviceLive(offer, entry)) {
      if (this.live()) { this.adopt(reply); this.notify(); }
      return;
    }
    entry.busy = false;
    this.adopt(reply);
    this.serviceDone(offer, entry, reply.outcome === "accepted");
  }

  /** root decision, pending owner (M-INTV Р4): one status of the same ID; not_found sends the same ID once more. */
  private async checkService(offer: Offer, entry: ServiceEntry): Promise<void> {
    if (entry.busy || !this.serviceLive(offer, entry)) return;
    entry.busy = true;
    let status: DictionaryCommandStatus;
    try {
      status = await this.options.port.status(entry.command);
    } catch {
      // Still unknown: the strip stays hidden; the next refresh or a new handle checks the same ID again.
      if (this.serviceLive(offer, entry)) entry.busy = false;
      return;
    }
    if (!this.serviceLive(offer, entry)) return;
    entry.busy = false;
    if (status.outcome === "accepted") {
      this.adopt(status);
      this.serviceDone(offer, entry, true);
      return;
    }
    if (status.outcome === "not_found") {
      this.raise(status.state_version);
      if (entry.resent) return;
      entry.resent = true;
      await this.sendService(offer, entry);
      return;
    }
    this.serviceDone(offer, entry, false);
  }

  /** The first confirmed open sets the deadline once (CT 2.1.2 p.3); anything else ends the offer for this client. */
  private serviceDone(offer: Offer, entry: ServiceEntry, accepted: boolean): void {
    if (entry === offer.open && accepted && offer.phase === "opening") {
      if (offer.deadline === null) offer.deadline = this.clock.now() + UNDO_OFFER_MS;
      offer.phase = "shown";
      this.scheduleExpiry(offer);
    } else if (offer.phase === "opening" || offer.phase === "closing") {
      offer.phase = "done";
    }
    this.notify();
  }

  private offerHandoff(): DictionaryUndoOfferHandoff | null {
    const offer = this.undoOffer;
    if (offer === null || (offer.phase !== "opening" && offer.phase !== "shown" && offer.phase !== "closing")) return null;
    return { actionId: offer.actionId, phase: offer.phase, deadline: offer.deadline,
      open: offer.open ? structuredClone(offer.open.command) : null, close: offer.close ? structuredClone(offer.close.command) : null };
  }

  /** Continue the offer of the same document: a command on the way when the old handle ended is unknown now. */
  private restoreOffer(handoff: DictionaryUndoOfferHandoff): void {
    const entry = (command: DictionaryIntervalCommand<UndoOfferIntent> | null): ServiceEntry | null =>
      command ? { command: structuredClone(command), status: "unknown", busy: false, resent: false } : null;
    this.own = handoff.actionId.toLowerCase();
    this.undoOffer = { actionId: this.own, phase: handoff.phase, deadline: handoff.deadline,
      open: entry(handoff.open), close: entry(handoff.close) };
  }
}
