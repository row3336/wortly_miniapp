import type { TodayResponse } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { TodayApi } from "./todayApi";

export type TodayState =
  | { kind: "loading" }
  | { kind: "failed"; reason?: "expired" | "load" }
  | { kind: "busy" }
  | { kind: "ready"; data: TodayResponse; refreshing: boolean };

export type TodaySource = { identity: object; get(): Promise<TodayResponse> };

export class TodayController {
  private state: TodayState = { kind: "loading" };
  private requestNumber = 0;
  private disposed = false;
  private accepted: TodayResponse | null = null;
  private lastSource: string | object | null = null;
  private listener: (state: TodayState) => void;

  constructor(private readonly api: TodayApi, listener: (state: TodayState) => void) {
    this.listener = listener;
  }

  snapshot(): TodayState { return this.state; }

  private publish(state: TodayState): void {
    if (this.disposed) return;
    this.state = state;
    this.listener(state);
  }

  /** Call on opening Today, foreground, or an explicit refresh after a related action. */
  load(token: string, expectedPair: TodayResponse["pair"]): Promise<void> {
    return this.read(token, () => this.api.get(token), expectedPair);
  }

  /** An opened-document source can keep its access credentials out of UI state. */
  loadFrom(source: TodaySource, expectedPair: TodayResponse["pair"]): Promise<void> {
    return this.read(source.identity, () => source.get(), expectedPair);
  }

  private async read(identity: string | object, get: () => Promise<TodayResponse>, expectedPair: TodayResponse["pair"]): Promise<void> {
    const currentRequest = ++this.requestNumber;
    if (identity !== this.lastSource) {
      this.accepted = null;
      this.lastSource = identity;
    }
    this.publish({ kind: "loading" });
    try {
      const response = await get();
      if (this.disposed || currentRequest !== this.requestNumber) return;
      if (response.pair !== expectedPair) {
        this.publish({ kind: "failed", reason: "load" });
        return;
      }
      if (!this.accepted || this.accepted.pair !== expectedPair
        || BigInt(response.state_version) >= BigInt(this.accepted.state_version)) {
        this.accepted = response;
      }
      this.publish({ kind: "ready", data: this.accepted, refreshing: false });
    } catch (error) {
      if (this.disposed || currentRequest !== this.requestNumber) return;
      if (error instanceof EntryApiError && error.code === "SESSION_BUSY") this.publish({ kind: "busy" });
      else {
        if (error instanceof EntryApiError && (error.status === 401 || error.status === 403)) {
          this.accepted = null;
          this.publish({ kind: "failed", reason: "expired" });
        } else this.publish({ kind: "failed", reason: "load" });
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.requestNumber += 1;
    this.accepted = null;
    this.lastSource = null;
  }
}
