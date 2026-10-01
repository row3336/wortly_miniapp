import type { SettingsResponse } from "../api/generated";
import { ApiError, type HttpOptions } from "../api/http";
import { sameId, version } from "../api/wireValidation";
import { ClosedAccessError, type OpenedAccess } from "../app/openedAccess";
import { createSettingsApi } from "./settingsApi";

export type SettingsReadState =
  | { kind: "loading" | "failed" | "disposed" }
  | { kind: "ready"; data: SettingsResponse };
type Options = {
  access(): OpenedAccess;
  transport: HttpOptions;
  minimumStateVersion?(): string;
  onUpdate(state: SettingsReadState): void;
};

/** Confirmed settings for consumers outside the editor. Never supplies defaults or resolves a saved command. */
export class SettingsReadController {
  private readonly key: string;
  private readonly profileId: string;
  private readonly api: ReturnType<typeof createSettingsApi>;
  private state: SettingsReadState = { kind: "loading" };
  private source: OpenedAccess | null = null;
  private floor: string;
  private sequence = 0;
  private disposed = false;
  private running: { source: OpenedAccess; minimum: string; promise: Promise<void> } | null = null;

  constructor(private readonly options: Options) {
    const access = options.access();
    if (!access.isLive() || access.profile.access.status !== "admitted") throw new ClosedAccessError();
    this.key = access.key; this.profileId = access.profile.profile_id;
    this.floor = access.profile.state_version;
    this.api = createSettingsApi(options.transport);
  }
  private live(): boolean {
    const access = this.options.access();
    return !this.disposed && access.isLive() && access.key === this.key
      && sameId(access.profile.profile_id, this.profileId) && access.profile.access.status === "admitted";
  }
  private minimum(): string {
    for (const value of [this.options.access().profile.state_version, this.options.minimumStateVersion?.()]) {
      if (value === undefined) continue;
      if (!version(value)) throw new Error("invalid shared Settings version");
      if (BigInt(value) > BigInt(this.floor)) this.floor = value;
    }
    return this.floor;
  }
  snapshot(): SettingsReadState {
    if (!this.live()) return { kind: "disposed" };
    if (this.source !== this.options.access()) return { kind: "loading" };
    if (this.state.kind === "ready" && BigInt(this.state.data.state_version) < BigInt(this.minimum())) return { kind: "loading" };
    return structuredClone(this.state);
  }
  private publish(state: SettingsReadState): void {
    if (!this.live()) return;
    this.state = state; this.options.onUpdate(this.snapshot());
  }
  refresh(): Promise<void> {
    if (!this.live()) return Promise.resolve();
    const source = this.options.access(), minimum = this.minimum();
    if (this.running?.source === source && (BigInt(this.running.minimum) >= BigInt(minimum)
      || this.state.kind === "ready" && BigInt(this.state.data.state_version) >= BigInt(minimum))) return this.running.promise;
    const sequence = ++this.sequence;
    this.source = source;
    const fresh = () => this.live() && sequence === this.sequence && this.options.access() === source;
    this.state = { kind: "loading" };
    const task = source.run(({ token }) => this.api.get(token)).then(data => {
      if (!fresh()) return;
      if (BigInt(data.state_version) < BigInt(this.minimum())) throw new ApiError("invalid_response");
      this.floor = data.state_version;
      this.publish({ kind: "ready", data });
    }).catch(() => { if (fresh()) this.publish({ kind: "failed" }); }).finally(() => {
      if (this.running?.promise === task) this.running = null;
    });
    this.running = { source, minimum, promise: task };
    this.publish({ kind: "loading" });
    return task;
  }
  dispose(): void {
    this.disposed = true; this.sequence++; this.running = null; this.source = null;
    this.state = { kind: "disposed" };
  }
}
