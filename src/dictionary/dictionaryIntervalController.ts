import type {
  DictionaryContextCapabilities, DictionaryContextInterval, DictionaryContextReference, OpenDictionaryContext,
} from "../api/generated";
import { ApiError } from "../api/http";
import { uuid, version } from "../api/wireValidation";
import {
  commandOutcomeUnknown, dictionaryIncreaseIntent, dictionaryUndoIntent,
  type DictionaryCommandReply, type DictionaryCommandStatus, type DictionaryContextAddress, type DictionaryContextCurrent,
  type DictionaryContextRead, type DictionaryIntervalApi, type DictionaryIntervalCommand, type DictionaryIntervalIntent,
  type DictionaryOrigin, type IntervalChoice,
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
export type DictionaryIntervalSnapshot = {
  phase: "idle" | "opening" | "ready" | "closed" | "unavailable" | "failed" | "disposed";
  cardId: string | null;
  context: DictionaryContextReference | null;
  view: OpenDictionaryContext["view"] | null;
  interval: DictionaryContextInterval | null;
  capabilities: DictionaryContextCapabilities;
  /** The one unresolved intent; it blocks every other intent. */
  pending: { kind: DictionaryIntervalIntent["kind"]; commandId: string; status: "sending" | "unknown" } | null;
  problem: DictionaryIntervalProblem | null;
  /** state_version of the shown context, never lower than an observed one. */
  stateVersion: string | null;
  canIncrease: boolean;
  canUndo: boolean;
  /** Only after an unknown outcome: the same command, by an explicit user action. */
  canRetry: boolean;
};
/**
 * What a following binding of the same document and card may continue; memory only.
 * contextId is null only while the initial context.open itself is unresolved (CON:149: the same intent continues).
 */
export type DictionaryIntervalHandoff = { cardId: string; contextId: string | null; pending: DictionaryIntervalCommand | null };

type Options = {
  port: DictionaryIntervalPort;
  isLive(): boolean;
  newId(): string;
  /** A confirmed version observed elsewhere in this document; it only raises the floor. */
  minimumStateVersion?(): string | null;
  onUpdate(snapshot: DictionaryIntervalSnapshot): void;
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

  constructor(private readonly options: Options) {}

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
        canIncrease: false, canUndo: false, canRetry: false };
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
    const snapshot: DictionaryIntervalSnapshot = {
      phase, cardId: this.cardId,
      context: shown ? shown.context : null,
      view: current?.status === "open" && !this.closeRequested ? current.view : null,
      interval: open ? open.interval : null,
      capabilities: open ? open.capabilities : none,
      pending: pending ? { kind: pending.command.kind, commandId: pending.command.command_id,
        status: pending.status === "sending" && pending.busy ? "sending" : "unknown" } : null,
      problem: this.problem ?? (stale ? { reason: "stale_response" } : null),
      stateVersion: this.currentVersion,
      canIncrease: free && open !== null && open.interval !== null && open.capabilities.interval_increase !== null,
      canUndo: free && open !== null && open.capabilities.undo_target !== null,
      canRetry: pending !== null && pending.status === "unknown" && !pending.busy && !this.closeRequested,
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
    if (handoff.pending) {
      const entry: Entry = { command: structuredClone(handoff.pending), status: "unknown", busy: false };
      this.pending = entry;
      await this.check(entry);
    }
    await this.read();
    const cardId = this.cardId;
    if (this.live() && this.pending === null && this.current?.status === "unavailable" && cardId !== null) await this.open(cardId);
  }

  /** Re-read the context; an unresolved command is checked by status first, never re-sent. */
  async refresh(): Promise<void> {
    const entry = this.pending;
    if (entry && entry.status === "unknown" && !entry.busy) await this.check(entry);
    await this.read();
  }

  /** Only an offered step of the written direction; anything else throws before a request (N26). */
  increase(choice: IntervalChoice): Promise<void> {
    if (!this.live() || this.pending) return Promise.resolve();
    const intent = dictionaryIncreaseIntent(this.offer(), this.options.newId(), choice);
    return this.start({ ...intent, ...this.options.port.origin });
  }

  /** Only the current undo_target of this open context. */
  undo(): Promise<void> {
    if (!this.live() || this.pending) return Promise.resolve();
    const intent = dictionaryUndoIntent(this.offer(), this.options.newId());
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
    return { cardId: this.cardId, contextId: this.contextId, pending };
  }

  /** No request: an open context stays on the server until close or the next open. */
  dispose(): void {
    this.disposed = true;
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
      this.problem = this.unadopted(this.adopt(reply));
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
      this.problem = this.unadopted(this.adopt(status));
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
}
