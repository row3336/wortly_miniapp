import type { DictionaryCardActions } from "../../api/generated";
import { version } from "../../api/wireValidation";
import { commandOutcomeUnknown } from "../../commands/commandOutcome";
import {
  copyCardActionIntent,
  type CardActionCommand, type CardActionIntent, type CardActionKind, type CardActionOrigin, type CardActionReply,
  type CardActionStatus,
} from "./cardActionApi";

/** Credentials stay behind the port; origin is the live document's at each exchange (CT 2.1: a retry keeps the intent). */
export type CardActionsPort = {
  origin(): CardActionOrigin | null;
  send(command: CardActionCommand): Promise<CardActionReply>;
  status(command: CardActionCommand): Promise<CardActionStatus>;
};

/** What the shown card read says: the server's hint of allowed actions and the version exclude/return compare against. */
export type CardActionsCard = {
  cardId: string;
  stateVersion: string;
  exclusionVersion: string | null;
  actions: DictionaryCardActions;
};
export type CardActionsProblem = {
  /** unknown: no reply, the same command can be repeated; refused: proven not applied; mismatch: this ID holds other content. */
  reason: "unknown" | "refused" | "mismatch";
  code?: string;
};
export type CardActionsSnapshot = {
  status: "idle" | "sending" | "unknown" | "refused" | "applied";
  /** The command in flight or unresolved, or the one the status describes. */
  kind: CardActionKind | null;
  /** «Изучить заново» waits for its separate confirmation (К07-077); nothing is sent yet. */
  confirming: boolean;
  /** A status request of the unresolved command is under way. */
  checking: boolean;
  problem: CardActionsProblem | null;
  /** The buttons that may be offered now: the card's own hint while no command is unresolved and the card is current. */
  offered: DictionaryCardActions;
  canRetry: boolean;
  disposed: boolean;
};
export type CardActionApplied = { kind: CardActionKind; cardId: string; stateVersion: string };

type Options = {
  port: CardActionsPort;
  newId(): string;
  onUpdate(snapshot: CardActionsSnapshot): void;
  /** Accepted by the server (applied or already applied): the host reads the card again and performs the transition. */
  onApplied(event: CardActionApplied): void;
  /** A definite refusal may mean the shown card is outdated: the host reads it again, the client never guesses (К07-074). */
  onRefused(code: string): void;
};
/** The one command of this card in flight or unresolved; its intent never changes until it settles. */
type Entry = { intent: CardActionIntent; status: "sending" | "unknown"; busy: boolean; notFound: boolean };

const none: DictionaryCardActions = { exclude: false, return: false, relearn: false };
const newer = (left: string, right: string) => BigInt(left) > BigInt(right);
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/**
 * «Не повторять», «Вернуть в повторы» and «Изучить заново» of one open card М12 (TA §7, CT 2.1). The server performs
 * every transition after its commit; the client shows only what an accepted fact or a new card read says (TA:153).
 * root decision, pending owner (M-ACTIONS Р2, Р3): one command at a time; memory only, like the card's editors and its
 * interval context — an unknown outcome is checked once by the same ID and repeated only as the same command (CON:149).
 */
export class CardActionsController {
  private card: CardActionsCard | null = null;
  private entry: Entry | null = null;
  private status: CardActionsSnapshot["status"] = "idle";
  private kind: CardActionKind | null = null;
  private problem: CardActionsProblem | null = null;
  private confirming = false;
  /** After an accepted command the buttons wait for a card read at least this new: the old hint is spent. */
  private appliedVersion: string | null = null;
  private disposed = false;

  constructor(private readonly options: Options) {}

  /** A card read; another card starts over, an older read of the same card adds nothing. */
  setCard(card: CardActionsCard): void {
    if (this.disposed) return;
    if (!version(card.stateVersion)) throw new Error("invalid card state version");
    const previous = this.card;
    if (previous && !same(previous.cardId, card.cardId)) this.reset();
    else if (previous && newer(previous.stateVersion, card.stateVersion)) return;
    this.card = structuredClone(card);
    this.notify();
  }

  /** A new access handle of the same document: an unresolved command is checked by status, never re-sent. */
  async resume(): Promise<void> {
    const entry = this.entry;
    if (!this.disposed && entry && entry.status === "unknown" && !entry.busy && !entry.notFound) await this.check(entry);
  }

  dispose(): void {
    this.disposed = true;
    this.entry = null;
    this.confirming = false;
  }

  snapshot(): CardActionsSnapshot {
    const entry = this.entry, card = this.card;
    const current = card !== null && (this.appliedVersion === null || !newer(this.appliedVersion, card.stateVersion));
    const offered = !this.disposed && entry === null && !this.confirming && current ? { ...card.actions } : { ...none };
    return { status: this.status, kind: this.kind, confirming: this.confirming && !this.disposed,
      checking: entry?.busy === true && entry.status === "unknown", problem: this.problem ? { ...this.problem } : null,
      offered, canRetry: !this.disposed && entry !== null && entry.status === "unknown" && !entry.busy, disposed: this.disposed };
  }

  // ---- user actions ----

  exclude(): Promise<void> { return this.changeState("card.exclude"); }
  /** «Вернуть в повторы» never inserts the card into a running quiz (К07-085); that is the server's rule. */
  restore(): Promise<void> { return this.changeState("card.return"); }

  /** Opens the separate confirmation; a cancel sends nothing (К07-082). */
  askRelearn(): void {
    if (!this.snapshot().offered.relearn) return;
    this.confirming = true;
    this.notify();
  }
  cancelRelearn(): void {
    if (!this.confirming) return;
    this.confirming = false;
    this.notify();
  }
  confirmRelearn(): Promise<void> {
    const card = this.card;
    if (this.disposed || !this.confirming || this.entry !== null || !card?.actions.relearn) return Promise.resolve();
    this.confirming = false;
    return this.start({ kind: "card.relearn", command_id: this.options.newId(), card_id: card.cardId, confirmed: true });
  }

  /** Unknown outcome: checks the same ID first; only a missing command is sent again, exactly as before. */
  async retry(): Promise<void> {
    const entry = this.entry;
    if (this.disposed || !entry || entry.status !== "unknown" || entry.busy) return;
    if (entry.notFound) { await this.execute(entry); return; }
    await this.check(entry);
    if (this.entry === entry && entry.notFound) await this.execute(entry);
  }

  private changeState(kind: "card.exclude" | "card.return"): Promise<void> {
    const card = this.card, offered = this.snapshot().offered;
    if (!card || !(kind === "card.exclude" ? offered.exclude : offered.return)) return Promise.resolve();
    return this.start({ kind, command_id: this.options.newId(), card_id: card.cardId,
      expected_card_state_version: card.exclusionVersion });
  }

  // ---- exchange ----

  private notify(): void {
    if (!this.disposed) this.options.onUpdate(this.snapshot());
  }

  private reset(): void {
    this.entry = null; this.status = "idle"; this.kind = null; this.problem = null; this.confirming = false;
    this.appliedVersion = null;
  }

  private start(intent: CardActionIntent): Promise<void> {
    const entry: Entry = { intent: copyCardActionIntent(intent), status: "sending", busy: false, notFound: false };
    this.entry = entry;
    this.kind = intent.kind;
    this.problem = null;
    return this.execute(entry);
  }

  private command(entry: Entry): CardActionCommand | null {
    const origin = this.options.port.origin();
    return origin ? { ...copyCardActionIntent(entry.intent), ...origin } : null;
  }

  private async execute(entry: Entry): Promise<void> {
    entry.status = "sending"; entry.busy = true; entry.notFound = false;
    this.status = "sending";
    this.notify();
    let reply: CardActionReply;
    try {
      const command = this.command(entry);
      if (!command) throw new Error("no live document");
      reply = await this.options.port.send(command);
    } catch (error) {
      if (this.disposed || this.entry !== entry) return;
      entry.busy = false;
      if (commandOutcomeUnknown(error)) {
        entry.status = "unknown";
        this.status = "unknown";
        this.problem = { reason: "unknown" };
        this.notify();
        await this.check(entry);
        return;
      }
      // An HTTP refusal without a fact: nothing was applied.
      const code = (error as { code?: string }).code;
      this.refused({ reason: "refused", ...(code ? { code } : {}) });
      return;
    }
    if (this.disposed || this.entry !== entry) return;
    if (reply.outcome === "accepted") this.accepted(entry, reply.state_version);
    else this.refused({ reason: reply.outcome === "mismatch" ? "mismatch" : "refused", code: reply.error.code });
  }

  /** One status request for an unknown outcome: accepted settles, not_found allows the same command again. */
  private async check(entry: Entry): Promise<void> {
    if (entry.busy || this.disposed) return;
    entry.busy = true;
    this.notify();
    let status: CardActionStatus;
    try {
      const command = this.command(entry);
      if (!command) throw new Error("no live document");
      status = await this.options.port.status(command);
    } catch {
      if (this.disposed || this.entry !== entry) return;
      entry.busy = false;
      this.notify();
      return;
    }
    if (this.disposed || this.entry !== entry) return;
    entry.busy = false;
    if (status.outcome === "accepted") { this.accepted(entry, status.state_version); return; }
    if (status.outcome === "not_found") { entry.notFound = true; this.notify(); return; }
    // Another payload under this ID: this intent can never be confirmed; a new tap is a new command.
    this.refused({ reason: "mismatch", code: "COMMAND_PAYLOAD_MISMATCH" });
  }

  private accepted(entry: Entry, stateVersion: string): void {
    this.entry = null;
    this.status = "applied";
    this.problem = null;
    this.appliedVersion = stateVersion;
    this.notify();
    this.options.onApplied({ kind: entry.intent.kind, cardId: entry.intent.card_id, stateVersion });
  }

  private refused(problem: CardActionsProblem): void {
    this.entry = null;
    this.status = "refused";
    this.problem = problem;
    this.notify();
    if (problem.code) this.options.onRefused(problem.code);
  }
}
