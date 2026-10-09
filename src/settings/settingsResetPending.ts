import type { AsyncStorage } from "../platform/storage";
import { PendingSlot, PendingStoreError, validId } from "../commands/pendingSlot";
import { validSettingsResetIntent, type SettingsResetIntent } from "./settingsApi";

/** The sent reset whose outcome is not confirmed yet. It holds no setting values: the server owns them. */
export type SettingsResetPending = {
  schemaVersion: 1;
  profileId: string;
  clientInstanceId: string;
  intent: SettingsResetIntent;
  /** A minimal status fact cannot prove this intent after an ID/content mismatch. */
  mismatch?: true;
};

export function validSettingsResetPending(value: unknown): value is SettingsResetPending {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<SettingsResetPending>;
  const fields = ["schemaVersion", "profileId", "clientInstanceId", "intent",
    ...(Object.hasOwn(item, "mismatch") ? ["mismatch"] : [])];
  return Object.keys(item).length === fields.length && fields.every(key => Object.hasOwn(item, key))
    && item.schemaVersion === 1 && validId(item.profileId) && validId(item.clientInstanceId)
    && (!Object.hasOwn(item, "mismatch") || item.mismatch === true) && validSettingsResetIntent(item.intent);
}

function copy(value: unknown): SettingsResetPending {
  if (!validSettingsResetPending(value)) throw new PendingStoreError("invalid");
  // A fixed property order gives the slot an exact comparison.
  return { schemaVersion: 1, profileId: value.profileId, clientInstanceId: value.clientInstanceId,
    ...(value.mismatch ? { mismatch: true } : {}),
    intent: { command_id: value.intent.command_id, kind: "settings.reset", payload: {} } };
}

/**
 * A slot of its own beside `wortly.pending.setting` (D-SET-RESET 4.3.2): an older build rolled back onto this
 * device would read a reset in the shared slot as invalid and block every change; it never reads this key.
 * The settings controller keeps at most one of the two slots filled.
 */
export const SETTINGS_RESET_SLOT = "wortly.pending.settings-reset";

/** Instantiate once per application storage, like the settings slot it sits beside. */
export class SettingsResetPendingStore extends PendingSlot<SettingsResetPending> {
  constructor(storage: AsyncStorage) { super(storage, SETTINGS_RESET_SLOT, copy); }
}
