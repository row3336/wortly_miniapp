import type { DictionaryCardViewResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { oneOf, uuid, version } from "../api/wireValidation";
import { validDictionaryView } from "./viewApi";

type Pair = "ru-de" | "uk-de" | "en-de";
export type DictionaryCardSource = {
  /** Identity and callback belong to one opened document and must not be retargeted. */
  identity: object;
  read(cardId: string): Promise<DictionaryCardViewResponse>;
};
export type DictionaryCardSnapshot = {
  phase: "idle" | "loading" | "ready" | "unavailable" | "failed" | "disposed";
  cardId: string | null;
  pair: Pair | null;
  /** Present only for ready, and for unavailable without any card content. */
  data: DictionaryCardViewResponse | null;
  problem: "load" | "expired" | "forbidden" | "pair_changed" | "stale_response" | null;
};
type Options = {
  isLive(): boolean;
  minimumStateVersion?(): string | null;
  onUpdate(state: DictionaryCardSnapshot): void;
};

/** Own one opened card. No response can replace a newer card, pair or document. */
export class DictionaryCardController {
  private state: DictionaryCardSnapshot = { phase: "idle", cardId: null, pair: null, data: null, problem: null };
  private identity: object | null = null;
  private floor: string | null = null;
  private request = 0;
  private disposed = false;

  constructor(private readonly options: Options) {}

  private live(): boolean { return !this.disposed && this.options.isLive(); }
  private minimum(): string | null {
    const shared = this.options.minimumStateVersion?.() ?? null;
    if (shared !== null && !version(shared)) throw new Error("invalid dictionary state version");
    // A publisher disappearing cannot invalidate a version already observed in this document.
    if (shared !== null && (this.floor === null || BigInt(shared) > BigInt(this.floor))) this.floor = shared;
    return this.floor;
  }
  snapshot(): DictionaryCardSnapshot {
    if (!this.live()) return { ...this.state, phase: "disposed", data: null, problem: null };
    const minimum = this.minimum();
    if (this.state.data !== null && minimum !== null && BigInt(this.state.data.state_version) < BigInt(minimum)) {
      return { ...this.state, phase: "failed", data: null, problem: "stale_response" };
    }
    return structuredClone(this.state);
  }
  private publish(state: DictionaryCardSnapshot): void {
    if (!this.live()) return;
    this.state = state;
    this.options.onUpdate(this.snapshot());
  }

  /** Invalid input throws synchronously, before any state change or read. */
  load(source: DictionaryCardSource, pair: Pair, cardId: string): Promise<void> {
    if (!source || !source.identity || typeof source.identity !== "object" || typeof source.read !== "function"
      || !oneOf(pair, ["ru-de", "uk-de", "en-de"]) || !uuid(cardId)) {
      throw new Error("dictionary document, pair and card ID are required");
    }
    return this.open(source, pair, cardId);
  }

  private async open(source: DictionaryCardSource, pair: Pair, cardId: string): Promise<void> {
    if (!this.live()) return;
    const request = ++this.request;
    const read = source.read.bind(source);
    if (source.identity !== this.identity) {
      this.identity = source.identity;
      this.floor = null;
    }
    const pending: DictionaryCardSnapshot = { phase: "loading", cardId, pair, data: null, problem: null };
    this.publish(pending);
    // An update listener may close the document or start a newer read.
    if (!this.live() || request !== this.request) return;
    try {
      const reply = await read(cardId);
      if (!this.live() || request !== this.request) return;
      // Validate the detached copy, so a source cannot substitute another card after the check.
      const data = structuredClone(reply);
      if (!validDictionaryView(data, cardId)) {
        this.publish({ ...pending, phase: "failed", problem: "load" });
        return;
      }
      if (data.current.status === "available" && data.current.content.pair !== pair) {
        this.publish({ ...pending, phase: "failed", problem: "pair_changed" });
        return;
      }
      const minimum = this.minimum();
      if (minimum !== null && BigInt(data.state_version) < BigInt(minimum)) {
        this.publish({ ...pending, phase: "failed", problem: "stale_response" });
        return;
      }
      this.floor = data.state_version;
      this.publish({ ...pending, phase: data.current.status === "available" ? "ready" : "unavailable", data });
    } catch (error) {
      if (!this.live() || request !== this.request) return;
      const problem = error instanceof ApiError && error.status === 401 ? "expired"
        : error instanceof ApiError && error.status === 403 ? "forbidden" : "load";
      this.publish({ ...pending, phase: "failed", problem });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.request += 1;
    this.identity = null;
    this.floor = null;
    this.state = { phase: "disposed", cardId: null, pair: null, data: null, problem: null };
  }
}
