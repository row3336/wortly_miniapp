import type { AsyncStorage } from "../platform/storage";
import { PendingSlot, PendingStoreError, validId } from "../commands/pendingSlot";
import { validSettingIntent, type SettingIntent } from "./settingsApi";

/** Only the sent intent survives recovery; credentials and unsubmitted editor drafts do not. */
export type SettingsPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  intent: SettingIntent;
  /** A minimal status fact cannot prove this intent after an ID/content mismatch. */
  mismatch?: true;
};

export function validSettingsPending(value: unknown): value is SettingsPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<SettingsPending>;
  const fields = ["schemaVersion", "profileId", "clientInstanceId", "intent",
    ...(Object.hasOwn(item, "mismatch") ? ["mismatch"] : [])];
  return Object.keys(item).length === fields.length && fields.every(key => Object.hasOwn(item, key))
    && item.schemaVersion === 1 && validId(item.profileId) && validId(item.clientInstanceId)
    && (!Object.hasOwn(item, "mismatch") || item.mismatch === true) && validSettingIntent(item.intent);
}

function copy(value: unknown): SettingsPending {
  if (!validSettingsPending(value)) throw new PendingStoreError("invalid");
  const source = value.intent;
  const selected = source.payload.value;
  // Property order is irrelevant for object equality; array order remains semantic.
  const canonical = typeof selected !== "object" || selected === null ? selected
    : Array.isArray(selected) ? [...selected]
    : selected.mode === "level" ? { mode: selected.mode, selected_level: selected.selected_level }
    : { mode: selected.mode, topic_ids: [...selected.topic_ids] };
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId,
    ...(value.mismatch ? { mismatch: true } : {}),
    intent: { command_id: source.command_id, kind: source.kind, expected_field_version: source.expected_field_version,
      payload: { key: source.payload.key, value: canonical } } };
}

/** Instantiate once for the application's document lifetimes, using its existing AsyncStorage. */
export class SettingsPendingStore extends PendingSlot<SettingsPending> {
  constructor(storage: AsyncStorage) { super(storage, "wortly.pending.setting", copy); }
}
