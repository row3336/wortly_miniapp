import type { DictionarySearchResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { exactKeys, oneOf, record, version } from "../api/wireValidation";
import { validSearchPage, type SearchMaterial, type SearchRequest } from "./searchApi";

type Pair = DictionarySearchResponse["pair"];
type Item = DictionarySearchResponse["items"][number];
/** `cursor_stale`: the server refused to continue the shown list (409 SEARCH_CURSOR_STALE). */
type Problem = "load" | "pair_changed" | "stale_response" | "cursor_stale";
/** A refusal of the access itself: never kept beside shown results. */
type Outcome = DictionarySearchResponse | Problem | "denied" | null;
const pairs = ["ru-de", "uk-de", "en-de"];

/** Positive integers chosen by the host. There are deliberately no defaults. */
export type SearchLimits = { suggest: number; page: number };
export type DictionarySearchSnapshot = {
  phase: "idle" | "loading" | "ready" | "failed" | "disposed";
  mode: "suggest" | "full";
  query: string;
  /** K07-093: words or phrases, never both. */
  material: SearchMaterial;
  /** Pair of the last settled read; null before any read and when the current access has another pair. */
  pair: Pair | null;
  items: Item[];
  /** Always null for suggestions: they cannot be paged. Null while a failed append waits for retry. */
  nextCursor: string | null;
  loadingMore: boolean;
  pagesLoaded: number;
  /** The shown list is final for this access; the host may restore scroll once. */
  restoreReady: boolean;
  problem: Problem | null;
  focusRequest: number;
};
export type DictionarySearchActions = {
  setQuery(query: string): void;
  setMaterial(material: SearchMaterial): void;
  submit(): void;
  loadMore(): void;
  retry(): void;
  /** K07-100: a new entry from another section always clears the query and selects words. */
  enterFromSection(): void;
};
/** Reads for one opened access. A different object is a different binding. */
export type DictionarySearchIo = {
  live(): boolean;
  /** `current` turns false once the read is obsolete; the binding must then discard any outcome. */
  read(request: SearchRequest, current: () => boolean): Promise<DictionarySearchResponse>;
};
/** What one committed render observed. */
export type DictionarySearchCommit = {
  /** A new object is a new opened access and rereads the shown list. */
  access: object;
  pair: Pair;
  /** Floor scope: the same object while the document identity and transport stay the same. */
  scope: object;
  floor: string;
  limits: SearchLimits;
  /** Null while reads are not allowed: disabled, hidden, revoked or not admitted. */
  io: DictionarySearchIo | null;
};
export type DictionarySearchObserved = { access: object; pair: Pair; open: boolean };

type Intent = { kind: "pages"; count: number } | { kind: "more" };

export function searchLimits(value: unknown): SearchLimits {
  const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
  if (!record(value) || !exactKeys(value, ["suggest", "page"]) || !positive(value.suggest) || !positive(value.page)) {
    throw new Error("search limits must be explicit positive integers");
  }
  return { suggest: value.suggest as number, page: value.page as number };
}

/**
 * Search input and results for the whole life of one search document.
 * Actions only change state and record the read they owe; `commit` is the single
 * place that sends, so an action and an access change of the same commit make one read.
 */
export class DictionarySearchController implements DictionarySearchActions {
  private query = "";
  private material: SearchMaterial = "words";
  private mode: DictionarySearchSnapshot["mode"] = "suggest";
  private phase: Exclude<DictionarySearchSnapshot["phase"], "disposed"> = "idle";
  private problem: Problem | null = null;
  private items: Item[] = [];
  private cursor: string | null = null;
  private pages = 0;
  private listLimit = 0;
  private pair: Pair | null = null;
  private focusRequest = 0;
  private retryPages = 0;
  private owed: Intent | null = null;
  private flight: { io: DictionarySearchIo; intent: Intent } | null = null;
  private sequence = 0;
  private io: DictionarySearchIo | null = null;
  private limits: SearchLimits | null = null;
  private currentPair: Pair | null = null;
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

  setQuery(query: string): void {
    if (typeof query !== "string") throw new Error("search query must be a string");
    this.query = query;
    this.mode = "suggest";
    this.restart();
  }

  setMaterial(material: SearchMaterial): void {
    if (!oneOf(material, ["words", "phrases"])) throw new Error("search mode must be words or phrases");
    this.material = material;
    this.restart();
  }

  submit(): void {
    if (!this.content()) return;
    this.mode = "full";
    this.restart();
  }

  loadMore(): void {
    // Suggestions never page: their count is the host's open limit, not a cursor walk.
    // After a failed append only retry recovers, so a refused cursor is never sent again.
    if (this.mode !== "full" || this.phase !== "ready" || this.cursor === null || this.problem !== null
      || this.flight || this.owed) return;
    this.owed = { kind: "more" };
    this.emit();
  }

  /** Only explicit: the same failed attempt, or the current state when the server refused to continue. */
  retry(): void {
    if (this.phase === "ready" && this.problem === "load") {
      // The shown pages stay; the same GET with the same cursor is sent again.
      this.problem = null;
      this.owed = { kind: "more" };
    } else if (this.phase === "ready" && this.problem === "cursor_stale") {
      // Reread the requested N+1 pages from the first one; the shown pages stay until they are replaced at once.
      this.abandon();
      this.owed = { kind: "pages", count: this.pages + 1 };
      this.cursor = null;
      this.phase = "loading";
      this.problem = null;
    } else if (this.phase === "failed") {
      this.abandon();
      this.owed = { kind: "pages", count: this.retryPages };
      this.phase = "loading";
      this.problem = null;
    } else return;
    this.emit();
  }

  enterFromSection(...unexpected: never[]): void {
    // K07-100: there is no entry policy; a former policy argument is refused, not ignored.
    if (unexpected.length !== 0) throw new Error("entry from another section takes no options");
    this.query = "";
    this.mode = "suggest";
    this.material = "words";
    this.focusRequest += 1;
    this.restart();
  }

  /** Called once per committed render, after every layout effect of that commit. */
  commit(input: DictionarySearchCommit): void {
    if (this.listener === null) return;
    const limits = searchLimits(input.limits);
    if (!input.access || typeof input.access !== "object" || !input.scope || typeof input.scope !== "object"
      || !oneOf(input.pair, pairs) || !version(input.floor)) throw new Error("dictionary search binding is invalid");
    this.limits = limits;
    this.currentPair = input.pair;
    if (input.scope !== this.scope) {
      this.scope = input.scope;
      this.floor = input.floor;
    } else if (BigInt(input.floor) > BigInt(this.floor)) this.floor = input.floor;
    let changed = false;
    if (this.flight && this.flight.io !== input.io) {
      this.inert();
      changed = true;
    }
    this.io = input.io;
    if (input.access !== this.seen) {
      this.seen = input.access;
      if (this.content()) {
        // N is taken at the access event; a pending user read already starts from the first page.
        if (this.owed?.kind !== "pages") this.owed = { kind: "pages", count: this.rereadPages() };
        if (this.pair !== null && this.pair !== input.pair) {
          this.items = [];
          this.cursor = null;
          this.pages = 0;
          this.pair = null;
        }
        this.phase = "loading";
        this.problem = null;
        changed = true;
      }
    }
    if (this.io && !this.flight && this.owed) {
      this.dispatch(this.io, this.owed);
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Detached snapshot for one render, including what that render already observed. */
  view(observed: DictionarySearchObserved): DictionarySearchSnapshot {
    const base = { mode: this.mode, query: this.query, material: this.material, focusRequest: this.focusRequest };
    if (!observed.open) {
      return structuredClone<DictionarySearchSnapshot>({ ...base, phase: "disposed", pair: null, items: [], nextCursor: null,
        loadingMore: false, pagesLoaded: 0, restoreReady: false, problem: null });
    }
    // Same render as the access change: hide another pair and do not offer a restore yet.
    const otherPair = this.pair !== null && this.pair !== observed.pair;
    const pending = this.content() && observed.access !== this.seen;
    const phase = otherPair && this.phase === "ready" ? "loading" : this.phase;
    return structuredClone<DictionarySearchSnapshot>({
      ...base, phase,
      pair: otherPair ? null : this.pair,
      items: otherPair ? [] : this.items,
      nextCursor: this.mode === "full" && phase === "ready" && !pending && this.problem === null ? this.cursor : null,
      loadingMore: this.flight?.intent.kind === "more" || this.owed?.kind === "more",
      pagesLoaded: otherPair ? 0 : this.pages,
      restoreReady: (phase === "ready" || phase === "idle") && !pending && !otherPair,
      problem: this.problem,
    });
  }

  private content(): boolean { return this.query.trim() !== ""; }

  private emit(): void { this.listener?.(); }

  private abandon(): void {
    this.sequence += 1;
    this.flight = null;
  }

  private inert(): void {
    const flight = this.flight;
    this.abandon();
    // A page sequence is still owed to the user; a page append is replaced by the reread.
    if (flight?.intent.kind === "pages" && this.owed === null) this.owed = flight.intent;
  }

  private restart(): void {
    this.abandon();
    this.items = [];
    this.cursor = null;
    this.pages = 0;
    this.problem = null;
    const content = this.content();
    this.owed = content ? { kind: "pages", count: 1 } : null;
    this.phase = content ? "loading" : "idle";
    this.emit();
  }

  private rereadPages(): number {
    if (this.phase === "failed") return Math.max(1, this.retryPages);
    return this.mode === "suggest" ? 1 : Math.max(1, this.pages);
  }

  private current(sequence: number, io: DictionarySearchIo): boolean {
    return this.listener !== null && sequence === this.sequence && this.io === io && io.live();
  }

  private dispatch(io: DictionarySearchIo, intent: Intent): void {
    this.owed = null;
    const sequence = ++this.sequence, pair = this.currentPair!, limits = this.limits!;
    if (intent.kind === "more") {
      if (this.cursor === null || this.mode !== "full" || this.phase !== "ready") return;
      this.flight = { io, intent };
      void this.readMore(sequence, io, pair, { query: this.query, mode: this.material,
        limit: this.listLimit, cursor_token: this.cursor });
      return;
    }
    this.flight = { io, intent };
    void this.readPages(sequence, io, pair, intent.count, { query: this.query, mode: this.material,
      limit: this.mode === "full" ? limits.page : limits.suggest });
  }

  /** Read N pages from the first one and publish them together, or nothing. */
  private async readPages(sequence: number, io: DictionarySearchIo, pair: Pair, count: number,
    base: Omit<SearchRequest, "cursor_token">): Promise<void> {
    const current = () => this.current(sequence, io);
    const read: DictionarySearchResponse[] = [];
    let cursor: string | null = null;
    while (read.length < count) {
      const outcome = await this.page(io, { ...base, cursor_token: cursor }, pair, current);
      if (outcome === null) return;
      // Any failure of a page sequence discards it whole; retry repeats all N pages.
      if (typeof outcome === "string") return this.fail(outcome === "denied" ? "load" : outcome, count, pair);
      read.push(outcome);
      if (outcome.next_cursor === null) break;
      cursor = outcome.next_cursor;
    }
    this.flight = null;
    this.items = read.flatMap(page => page.items);
    this.cursor = read.at(-1)!.next_cursor;
    this.pages = read.length;
    this.listLimit = base.limit;
    this.pair = pair;
    this.phase = "ready";
    this.problem = null;
    this.retryPages = 0;
    this.emit();
  }

  private async readMore(sequence: number, io: DictionarySearchIo, pair: Pair, request: SearchRequest): Promise<void> {
    const outcome = await this.page(io, request, pair, () => this.current(sequence, io));
    if (outcome === null) return;
    if (outcome === "load" || outcome === "cursor_stale") {
      // A failed append keeps the shown pages and cursor; nothing is retried automatically.
      this.flight = null;
      this.problem = outcome;
      this.emit();
      return;
    }
    // Another pair, an older state or a refused access never stays beside shown results.
    if (typeof outcome === "string") return this.fail(outcome === "denied" ? "load" : outcome, this.pages + 1, pair);
    this.flight = null;
    this.items = [...this.items, ...outcome.items];
    this.cursor = outcome.next_cursor;
    this.pages += 1;
    this.emit();
  }

  /** One accepted page, a problem, or null when the read became obsolete. */
  private async page(io: DictionarySearchIo, request: SearchRequest, pair: Pair, current: () => boolean): Promise<Outcome> {
    let reply: unknown;
    try { reply = await io.read({ ...request }, current); }
    catch (error) {
      if (!current()) return null;
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return "denied";
      return error instanceof ApiError && error.status === 409 && error.code === "SEARCH_CURSOR_STALE" ? "cursor_stale" : "load";
    }
    if (!current()) return null;
    let page: unknown;
    // Validate a detached copy, so the binding cannot change the page after the check.
    try { page = structuredClone(reply); }
    catch { return "load"; }
    if (!validSearchPage(page, request)) return "load";
    if (page.pair !== pair) return "pair_changed";
    if (BigInt(page.state_version) < BigInt(this.floor)) return "stale_response";
    this.floor = page.state_version;
    return page;
  }

  private fail(problem: Problem, retryPages: number, pair: Pair): void {
    this.flight = null;
    this.phase = "failed";
    this.problem = problem;
    this.items = [];
    this.cursor = null;
    this.pages = 0;
    this.pair = pair;
    this.retryPages = retryPages;
    this.emit();
  }
}
