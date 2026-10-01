import type { AsyncStorage } from "../platform/storage";
import { PendingSlot, PendingStoreError, validId } from "../commands/pendingSlot";
import { validRemoteStopIntent, type RemoteStopIntent } from "./remoteSessionApi";

/** A confirmed intent awaiting its outcome; never a document lease or access proof. */
export type RemoteStopPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  intent: RemoteStopIntent;
  mismatch?: true;
};

export function validRemoteStopPending(value: unknown): value is RemoteStopPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<RemoteStopPending>;
  const fields = ["schemaVersion", "profileId", "clientInstanceId", "intent",
    ...(Object.hasOwn(item, "mismatch") ? ["mismatch"] : [])];
  return Object.keys(item).length === fields.length && fields.every(key => Object.hasOwn(item, key))
    && item.schemaVersion === 1 && validId(item.profileId) && validId(item.clientInstanceId)
    && (!Object.hasOwn(item, "mismatch") || item.mismatch === true) && validRemoteStopIntent(item.intent)
    && Object.keys(item.intent).length === 4;
}

function copy(value: unknown): RemoteStopPending {
  if (!validRemoteStopPending(value)) throw new PendingStoreError("invalid");
  const intent = value.intent;
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId,
    ...(value.mismatch ? { mismatch: true } : {}), intent: {
      command_id: intent.command_id, kind: "session.stop_remote", session_id: intent.session_id,
      payload: { confirmed: true },
    } };
}

/** Share one instance across Entry controllers, using the existing application storage. */
export class RemoteStopPendingStore extends PendingSlot<RemoteStopPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.remote_stop", copy); }
}
