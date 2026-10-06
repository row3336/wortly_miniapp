import type { OralSessionProjection } from "../api/generated";
import { copyLanePending, validLanePending } from "../commands/commandLane";
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

export function validOralPending(value: unknown): value is OralPending { return validLanePending(value, validOralIntent); }

function copy(value: unknown, lane: OralCommandLane): OralPending {
  if (!validOralPending(value) || (value.intent.kind === "session.stop") !== (lane === "stop")) {
    throw new PendingStoreError("invalid");
  }
  return copyLanePending(value, copyOralIntent);
}

/** Share one instance across document owners. This slot holds study commands only. */
export class OralSessionPendingStore extends PendingSlot<OralPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.oral_session", value => copy(value, "study")); }
}

/** Stop has a separate durable slot so an unknown study outcome cannot prevent it. */
export class OralStopPendingStore extends PendingSlot<OralPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.oral_stop", value => copy(value, "stop")); }
}
