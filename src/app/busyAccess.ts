import type { Profile, TodayResponse } from "../api/generated";
import { ApiError } from "../api/http";
import type { TodayApi } from "../today/todayApi";
import { ClosedAccessError } from "./openedAccess";

/** Aggregate reads only; never grants a document or exposes transport credentials. */
export interface BusyAccess {
  readonly key: string;
  readonly profile: Profile;
  isLive(): boolean;
  readToday(): Promise<TodayResponse>;
}

export function createBusyAccess(options: {
  key: string; profile: Profile; token: string; api: TodayApi;
  minimumVersion?: string | null; onRead?(version: string): void;
  isLive(): boolean; onDenied(error: ApiError): void;
}): BusyAccess {
  const profile = structuredClone(options.profile);
  let floor = BigInt(profile.state_version);
  if (options.minimumVersion && BigInt(options.minimumVersion) > floor) floor = BigInt(options.minimumVersion);
  const requireLive = () => { if (!options.isLive()) throw new ClosedAccessError(); };
  return Object.freeze({
    key: options.key,
    get profile() { return structuredClone(profile); },
    isLive: options.isLive,
    async readToday() {
      requireLive();
      try {
        const data = await options.api.get(options.token);
        requireLive();
        if (data.pair !== `${profile.dictionary_language}-de`
          || BigInt(data.state_version) < floor) throw new ApiError("invalid_response");
        floor = BigInt(data.state_version);
        options.onRead?.(data.state_version);
        return data;
      } catch (error) {
        requireLive();
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) options.onDenied(error);
        throw error;
      }
    },
  });
}
