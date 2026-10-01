import type { OralSessionProjection } from "../api/generated";
import { exactKeys, oneOf, record, uuid } from "../api/wireValidation";
import { PendingSlot, PendingStoreError } from "../commands/pendingSlot";
import type { AsyncStorage } from "../platform/storage";
import { copyOralIntent, validOralIntent, type OralIntent } from "./oralIntent";

export type OralPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  pair: OralSessionProjection["pair"];
  intent: OralIntent;
  mismatch?: true;
};
export type OralCommandLane = "study" | "stop";

export function validOralPending(value: unknown): value is OralPending {
  return record(value) && exactKeys(value, ["schemaVersion", "profileId", "clientInstanceId", "pair", "intent",
    ...(Object.hasOwn(value, "mismatch") ? ["mismatch"] : [])])
    && value.schemaVersion === 1 && uuid(value.profileId) && uuid(value.clientInstanceId)
    && oneOf(value.pair, ["ru-de", "uk-de", "en-de"])
    && (!Object.hasOwn(value, "mismatch") || value.mismatch === true)
    && validOralIntent(value.intent);
}

function copy(value: unknown, lane: OralCommandLane): OralPending {
  if (!validOralPending(value) || (value.intent.kind === "session.stop") !== (lane === "stop")) {
    throw new PendingStoreError("invalid");
  }
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId, pair: value.pair,
    intent: copyOralIntent(value.intent), ...(value.mismatch ? { mismatch: true } : {}) };
}

/** Share one instance across document owners. This slot holds study commands only. */
export class OralSessionPendingStore extends PendingSlot<OralPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.oral_session", value => copy(value, "study")); }
}

/** Stop has a separate durable slot so an unknown study outcome cannot prevent it. */
export class OralStopPendingStore extends PendingSlot<OralPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.oral_stop", value => copy(value, "stop")); }
}
