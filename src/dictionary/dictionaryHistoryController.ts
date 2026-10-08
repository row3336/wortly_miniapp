import type { DictionaryHistoryItem, DictionaryHistoryResponse } from "../api/generated";
import { oneOf, version } from "../api/wireValidation";
import { validDictionaryHistory } from "./historyApi";

type Pair = "ru-de" | "uk-de" | "en-de";
type Problem = "load" | "pair_changed" | "stale_response";
const pairs = ["ru-de", "uk-de", "en-de"];

/** One opened card of the history with its list row as the server sent it (P18: no translation). */
export type DictionaryHistoryEntry = DictionaryHistoryItem;
export type DictionaryHistorySnapshot = {
  phase: "idle" | "loading" | "ready" | "failed" | "disposed";
  /** Newest first, as the server ordered them. Kept while a refresh reads, replaced at once. */
  items: DictionaryHistoryEntry[];
  /** Pair the shown rows were filtered for; null before the first accepted read and while another pair is current. */
  pair: Pair | null;
  problem: Problem | null;
};
export type DictionaryHistoryActions = {
  /** K11-013: entry, a return from a card (its opening is an own change of the history). */
  refresh(): void;
  retry(): void;
};
/** Reads for one opened access. `current` turns false once the read is obsolete. */
export type DictionaryHistoryIo = {
  live(): boolean;
  /** The one list read: its rows already carry their text (P19), so no card is read to show the list. */
  history(current: () => boolean): Promise<DictionaryHistoryResponse>;
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
type Read = { entries: DictionaryHistoryEntry[]; version: string } | Problem | null;

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
      this.owed = true;
      if (this.pair !== null && this.pair !== input.pair) {
        // Rows belong to the pair they were filtered for.
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
    void this.read(io, pair, () => this.current(sequence, io)).then(outcome => {
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
        if (BigInt(outcome.version) > BigInt(this.floor)) this.floor = outcome.version;
      }
      this.emit();
    });
  }

  /**
   * The one list read. A row the server could not build or hides in this pair is absent from the answer (P20, Ya14):
   * the rest is shown as sent, with no partial-failure message. Only a failed or broken answer fails the list.
   */
  private async read(io: DictionaryHistoryIo, pair: Pair, current: () => boolean): Promise<Read> {
    // The floor the read started from; a later commit may raise it while the answer is on its way.
    const start = BigInt(this.floor);
    let list: unknown;
    try { list = structuredClone(await io.history(current)); }
    catch { return current() ? "load" : null; }
    if (!current()) return null;
    if (!validDictionaryHistory(list)) return "load";
    if (BigInt(list.state_version) < start) return "stale_response";
    if (list.pair !== pair) return "pair_changed";
    return { entries: list.items, version: list.state_version };
  }
}
