import { PendingSlot, PendingStoreError, validId } from "../commands/pendingSlot";
export { PendingStoreError, validId } from "../commands/pendingSlot";
import type { AsyncStorage } from "../platform/storage";
import { validManualIntent, type ManualIntent } from "./learningApi";

/** Temporary local recovery, never credentials or an offline queue. */
export type ManualPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  intent: ManualIntent;
  /** The server proved this ID belongs to different content; a minimal GET fact cannot settle it. */
  mismatch?: true;
};

const key = "wortly.pending.manual";

function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(name => Object.hasOwn(value, name));
}

export function validManualPending(value: unknown): value is ManualPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<ManualPending>;
  return exactKeys(item, ["schemaVersion", "profileId", "clientInstanceId", "intent",
    ...(Object.hasOwn(item, "mismatch") ? ["mismatch"] : [])])
    && (!Object.hasOwn(item, "mismatch") || item.mismatch === true)
    && item.schemaVersion === 1 && validId(item.profileId) && validId(item.clientInstanceId)
    && validManualIntent(item.intent)
    && exactKeys(item.intent, ["command_id", "kind", "expected_selection_version", "payload"]);
}

function copy(value: unknown): ManualPending {
  if (!validManualPending(value)) throw new PendingStoreError("invalid");
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId,
    ...(value.mismatch ? { mismatch: true } : {}),
    intent: { command_id: value.intent.command_id, kind: value.intent.kind,
      expected_selection_version: value.intent.expected_selection_version,
      payload: { card_id: value.intent.payload.card_id, expected_pair: value.intent.payload.expected_pair } } };
}

/** Compatible adapter over the shared temporary-intent slot. */
export class ManualPendingStore extends PendingSlot<ManualPending> {
  constructor(storage: AsyncStorage) { super(storage, key, copy); }
}
