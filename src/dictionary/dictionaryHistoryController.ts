import type { CardTranslations, DictionaryCardResponse, DictionaryHistoryResponse, DictionaryReferenceCard } from "../api/generated";
import { oneOf, version } from "../api/wireValidation";
import { validDictionaryCard } from "./cardApi";
import { validDictionaryHistory } from "./historyApi";

type Pair = "ru-de" | "uk-de" | "en-de";
type Problem = "load" | "pair_changed" | "stale_response";
const pairs = ["ru-de", "uk-de", "en-de"];

/** One opened card of the history with the text of its current card (the history DTO carries only the address). */
export type DictionaryHistoryEntry = Pick<DictionaryReferenceCard, "lemma" | "type" | "cefr"> & {
  card_id: string;
  opened_at: string;
  translation: CardTranslations;
};
export type DictionaryHistorySnapshot = {
  phase: "idle" | "loading" | "ready" | "failed" | "disposed";
  /** Newest first, as the server ordered them. Kept while a refresh reads, replaced at once. */
  items: DictionaryHistoryEntry[];
  /** Pair of the shown card texts; null before the first accepted read and while another pair is current. */
  pair: Pair | null;
  problem: Problem | null;
};
export type DictionaryHistoryActions = {
  /** K11-013: entry, a return from a card (its opening is an own change of the history). */
  refresh(): void;
  retry(): void;
  /** Drop the cached text of one card, or of every card; call it right before `refresh`. */
  forget(cardId?: string): void;
};
/** Reads for one opened access. `current` turns false once the read is obsolete. */
export type DictionaryHistoryIo = {
  live(): boolean;
  history(current: () => boolean): Promise<DictionaryHistoryResponse>;
  /** The card route that records no opening (C-HIST: only /view writes the history). */
  card(cardId: string, current: () => boolean): Promise<DictionaryCardResponse>;
};
export type DictionaryHistoryCommit = {
  /** A new object is a new opened access (e.g. foreground) and rereads the history. */
  access: object;
  pair: Pair;
  /** Floor scope: the same object while the document identity and transport stay the same. */
  scope: object;
  floor: string;
  /** Null while reads are not allowed: disabled, hidden, revoked or not admitted. */
  io: DictionaryHistoryIo | null;
};
export type DictionaryHistoryObserved = { access: object; pair: Pair; open: boolean };
/** The text of one card for its history row; null for a card that is no longer available. */
type CardText = Omit<DictionaryHistoryEntry, "card_id" | "opened_at"> | null;
/** Card texts by lower-case card ID, for one opened access. */
type Texts = Map<string, CardText>;
type Read = { entries: DictionaryHistoryEntry[]; version: string; fresh: Texts } | Problem | null;

/**
 * The account's history for the whole life of one dictionary document. Actions only owe a read;
 * `commit` is the single place that sends, so a refresh and an access change of one commit make one read.
 * Any late reply of an earlier read is dropped by its sequence number.
 */
export class DictionaryHistoryController implements DictionaryHistoryActions {
  private phase: Exclude<DictionaryHistorySnapshot["phase"], "disposed"> = "idle";
  private items: DictionaryHistoryEntry[] = [];
  private pair: Pair | null = null;
  private problem: Problem | null = null;
  private owed = false;
  private flight: DictionaryHistoryIo | null = null;
  private sequence = 0;
  private io: DictionaryHistoryIo | null = null;
  private seen: object | null = null;
  // root decision, pending owner: В1 — card texts (and «no longer available») are kept per opened access, so a later
  // showing reads only cards that are new in the list. A new access (foreground, another pair) starts with an empty
  // cache; the host drops the card a return comes from and the whole cache on an entry (К11-013: own edits show up).
  private texts: Texts = new Map();
  private scope: object | null = null;
  private floor = "1";
  private listener: (() => void) | null = null;

  attach(listener: () => void): void { this.listener = listener; }

  /** Unmount or StrictMode cleanup: the read in flight becomes inert and is owed again. */
  detach(): void {
    this.listener = null;
    this.inert();
    this.io = null;
  }

  refresh(): void {
    this.abandon();
    this.owed = true;
    this.phase = "loading";
    this.problem = null;
    this.emit();
  }

  /** Only after a failure: the same read again. */
  retry(): void {
    if (this.phase === "failed") this.refresh();
  }

  forget(cardId?: string): void {
    if (cardId === undefined) {
      // A new map: a read still in flight cannot put old texts back into it.
      this.texts = new Map();
      return;
    }
    if (typeof cardId !== "string") throw new Error("card ID must be a string");
    this.texts.delete(cardId.toLowerCase());
  }

  /** Called once per committed render, after every layout effect of that commit. */
  commit(input: DictionaryHistoryCommit): void {
    if (this.listener === null) return;
    if (!input.access || typeof input.access !== "object" || !input.scope || typeof input.scope !== "object"
      || !oneOf(input.pair, pairs) || !version(input.floor)) throw new Error("dictionary history binding is invalid");
    if (input.scope !== this.scope) {
      this.scope = input.scope;
      this.floor = input.floor;
    } else if (BigInt(input.floor) > BigInt(this.floor)) this.floor = input.floor;
    let changed = false;
    if (this.flight && this.flight !== input.io) {
      this.inert();
      changed = true;
    }
    this.io = input.io;
    if (input.access !== this.seen) {
      this.seen = input.access;
      this.texts = new Map();
      this.owed = true;
      if (this.pair !== null && this.pair !== input.pair) {
        // Card texts belong to the pair they were read for.
        this.items = [];
        this.pair = null;
      }
      this.phase = "loading";
      this.problem = null;
      changed = true;
    }
    if (this.io && !this.flight && this.owed) {
      this.dispatch(this.io, input.pair);
      changed = true;
    }
    if (changed) this.emit();
  }

  view(observed: DictionaryHistoryObserved): DictionaryHistorySnapshot {
    if (!observed.open) return { phase: "disposed", items: [], pair: null, problem: null };
    const otherPair = this.pair !== null && this.pair !== observed.pair;
    const pending = observed.access !== this.seen;
    const phase = (otherPair || pending) && this.phase !== "failed" ? "loading" : this.phase;
    return structuredClone<DictionaryHistorySnapshot>({ phase, items: otherPair ? [] : this.items,
      pair: otherPair ? null : this.pair, problem: this.problem });
  }

  private emit(): void { this.listener?.(); }

  private abandon(): void {
    this.sequence += 1;
    this.flight = null;
  }

  private inert(): void {
    const owed = this.flight !== null;
    this.abandon();
    if (owed) this.owed = true;
  }

  private current(sequence: number, io: DictionaryHistoryIo): boolean {
    return this.listener !== null && sequence === this.sequence && this.io === io && io.live();
  }

  private dispatch(io: DictionaryHistoryIo, pair: Pair): void {
    this.owed = false;
    const sequence = ++this.sequence;
    this.flight = io;
    const texts = this.texts;
    void this.read(io, pair, texts, () => this.current(sequence, io)).then(outcome => {
      if (outcome === null || !this.current(sequence, io)) return;
      this.flight = null;
      if (typeof outcome === "string") {
        this.phase = "failed";
        this.problem = outcome;
        this.items = [];
        this.pair = null;
      } else {
        this.phase = "ready";
        this.problem = null;
        this.items = outcome.entries;
        this.pair = pair;
        this.floor = outcome.version;
        // Texts read for an access that has since been replaced never enter the new cache.
        if (texts === this.texts) for (const [id, text] of outcome.fresh) texts.set(id, text);
      }
      this.emit();
    });
  }

  /** The list and the text of every listed card, accepted together or not at all. Cached texts are not read again. */
  private async read(io: DictionaryHistoryIo, pair: Pair, texts: Texts, current: () => boolean): Promise<Read> {
    // Parallel reads may be answered at different versions: each is checked against the floor at the start,
    // and the new floor is the highest version accepted.
    const start = BigInt(this.floor);
    let floor = this.floor;
    const accept = (stateVersion: string) => {
      if (BigInt(stateVersion) < start) return false;
      if (BigInt(stateVersion) > BigInt(floor)) floor = stateVersion;
      return true;
    };
    let list: unknown;
    try { list = structuredClone(await io.history(current)); }
    catch { return current() ? "load" : null; }
    if (!current()) return null;
    if (!validDictionaryHistory(list)) return "load";
    if (!accept(list.state_version)) return "stale_response";
    const ids = list.items.map(item => item.card_id).filter(id => !texts.has(id.toLowerCase()));
    let cards: unknown[];
    try { cards = structuredClone(await Promise.all(ids.map(id => io.card(id, current)))); }
    catch { return current() ? "load" : null; }
    if (!current()) return null;
    const fresh: Texts = new Map();
    for (const [index, id] of ids.entries()) {
      const card = cards[index];
      if (!validDictionaryCard(card, id)) return "load";
      if (!accept(card.state_version)) return "stale_response";
      if (!("pair" in card.current)) { fresh.set(id.toLowerCase(), null); continue; }
      const content = card.current;
      if (content.pair !== pair) return "pair_changed";
      fresh.set(id.toLowerCase(), { lemma: content.card.lemma, type: content.card.type, cefr: content.card.cefr,
        translation: content.translations });
    }
    const entries: DictionaryHistoryEntry[] = [];
    for (const item of list.items) {
      const key = item.card_id.toLowerCase(), text = fresh.has(key) ? fresh.get(key)! : texts.get(key)!;
      // root decision, pending owner: В2 — a card that is no longer available has no text to show, so its entry is left out.
      if (text !== null) entries.push({ card_id: item.card_id, opened_at: item.opened_at, ...structuredClone(text) });
    }
    return { entries, version: floor, fresh };
  }
}
