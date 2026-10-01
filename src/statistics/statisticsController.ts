import type { StatisticsOverviewResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { oneOf, version } from "../api/wireValidation";
import type { PracticeWeek } from "./practiceApi";

type Pair = StatisticsOverviewResponse["pair"];
export type StatisticsSource = {
  /** Identity and callback belong to one opened document and must not be retargeted. */
  identity: object;
  get(week: PracticeWeek): Promise<StatisticsOverviewResponse>;
};
export type StatisticsSnapshot = {
  phase: "idle" | "loading" | "ready" | "failed" | "disposed";
  pair: Pair | null;
  week: PracticeWeek | null;
  data: StatisticsOverviewResponse | null;
  problem: "load" | "expired" | "forbidden" | "pair_changed" | "stale_response" | null;
};
type Options = {
  isLive(): boolean;
  minimumStateVersion?(): string | null;
  onUpdate(state: StatisticsSnapshot): void;
};

/** Own one visible read. No response can replace a newer period or document. */
export class StatisticsController {
  private state: StatisticsSnapshot = { phase: "idle", pair: null, week: null, data: null, problem: null };
  private identity: object | null = null;
  private floor: string | null = null;
  private request = 0;
  private disposed = false;

  constructor(private readonly options: Options) {}

  private live(): boolean { return !this.disposed && this.options.isLive(); }
  private minimum(): string | null {
    const shared = this.options.minimumStateVersion?.() ?? null;
    if (shared !== null && !version(shared)) throw new Error("invalid statistics state version");
    // A publisher disappearing cannot invalidate a version already observed in this document.
    if (shared !== null && (this.floor === null || BigInt(shared) > BigInt(this.floor))) this.floor = shared;
    return this.floor;
  }
  snapshot(): StatisticsSnapshot {
    if (!this.live()) return { ...this.state, phase: "disposed", data: null, problem: null };
    const minimum = this.minimum();
    if (this.state.data !== null && minimum !== null && BigInt(this.state.data.state_version) < BigInt(minimum)) {
      return { ...this.state, phase: "failed", data: null, problem: "stale_response" };
    }
    return structuredClone(this.state);
  }
  private publish(state: StatisticsSnapshot): void {
    if (!this.live()) return;
    this.state = state;
    this.options.onUpdate(this.snapshot());
  }

  /** The caller explicitly chooses the week; changing it never changes the server's current base. */
  async load(source: StatisticsSource, pair: Pair, week: PracticeWeek): Promise<void> {
    if (!source || !source.identity || typeof source.identity !== "object" || typeof source.get !== "function"
      || !oneOf(pair, ["ru-de", "uk-de", "en-de"]) || !oneOf(week, ["current", "previous"])) {
      throw new Error("statistics document, pair and explicit week are required");
    }
    if (!this.live()) return;
    const request = ++this.request;
    const get = source.get.bind(source);
    if (source.identity !== this.identity) {
      this.identity = source.identity;
      this.floor = null;
    }
    const pending: StatisticsSnapshot = { phase: "loading", pair, week, data: null, problem: null };
    this.publish(pending);
    // An update listener may close the document or start a newer read.
    if (!this.live() || request !== this.request) return;
    try {
      const data = await get(week);
      if (!this.live() || request !== this.request) return;
      if (data.pair !== pair) {
        this.publish({ ...pending, phase: "failed", problem: "pair_changed" });
        return;
      }
      const minimum = this.minimum();
      if (minimum !== null && BigInt(data.state_version) < BigInt(minimum)) {
        this.publish({ ...pending, phase: "failed", problem: "stale_response" });
        return;
      }
      this.floor = data.state_version;
      this.publish({ ...pending, phase: "ready", data: structuredClone(data) });
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
    this.state = { phase: "disposed", pair: null, week: null, data: null, problem: null };
  }
}
