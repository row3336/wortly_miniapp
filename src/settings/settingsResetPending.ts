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
 * Slots of their own beside `wortly.pending.setting` (D-SET-RESET 4.3.2): an older build rolled back onto this
 * device would read a reset in the shared slot as invalid and block every change; it never reads these keys.
 * The settings controller keeps at most one of the two slots filled.
 */
export const SETTINGS_RESET_SLOT = "wortly.pending.settings-reset";

/**
 * The record of one confirmed profile (R3-02): another profile can neither see, replace nor delete it.
 * Profile IDs are confirmed UUIDs, so the key is deterministic and holds no setting values or credentials.
 */
export function settingsResetSlotOf(profileId: string): string {
  if (!validId(profileId)) throw new PendingStoreError("invalid");
  return `${SETTINGS_RESET_SLOT}:profile:${profileId.toLowerCase()}`;
}

/**
 * Instantiate once per application storage, like the settings slot it sits beside. Each profile gets its own
 * serialized `PendingSlot`; the generic slot and its single-record rules stay as they are.
 *
 * The legacy global key `SETTINGS_RESET_SLOT` is only read, never written, removed or migrated (P02 owns that:
 * profile barrier and initialization marker). A legacy record naming this profile may be an unresolved reset
 * that cannot be proven, so every operation for that profile fails closed as "invalid"; a record of another
 * profile is ignored. A legacy record that cannot be read as a reset has no known owner and blocks everyone,
 * as the single slot did before.
 */
export class SettingsResetPendingStore {
  private readonly slots = new Map<string, PendingSlot<SettingsResetPending>>();

  constructor(private readonly storage: AsyncStorage) {}

  private slot(profileId: string): PendingSlot<SettingsResetPending> {
    const key = settingsResetSlotOf(profileId);
    let slot = this.slots.get(key);
    if (!slot) {
      // A record under this key that names another profile is damaged: reject it rather than let `load` delete it.
      const owner = profileId.toLowerCase();
      slot = new PendingSlot(this.storage, key, value => {
        const checked = copy(value);
        if (checked.profileId.toLowerCase() !== owner) throw new PendingStoreError("invalid");
        // The generic `load` compares profile IDs case-sensitively and deletes on a difference: keep one spelling.
        return { ...checked, profileId: owner };
      });
      this.slots.set(key, slot);
    }
    return slot;
  }

  private async legacyGuard(profileId: string, signal: AbortSignal): Promise<void> {
    if (!validId(profileId)) throw new PendingStoreError("invalid");
    let raw: string | null;
    try { raw = await this.storage.get(SETTINGS_RESET_SLOT); } catch { throw new PendingStoreError("unavailable"); }
    if (signal.aborted) throw new PendingStoreError("cancelled");
    if (raw === null) return;
    let owner: string;
    try { owner = copy(JSON.parse(raw)).profileId; } catch { throw new PendingStoreError("invalid"); }
    if (owner.toLowerCase() === profileId.toLowerCase()) throw new PendingStoreError("invalid");
  }

  async load(profileId: string, signal: AbortSignal): Promise<SettingsResetPending | null> {
    await this.legacyGuard(profileId, signal);
    return this.slot(profileId).load(profileId.toLowerCase(), signal);
  }

  async save(value: SettingsResetPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).save(pending, signal);
  }

  async clear(value: SettingsResetPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).clear(pending, signal);
  }

  async clearMarked(value: SettingsResetPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).clearMarked(pending, signal);
  }

  async markMismatch(value: SettingsResetPending, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).markMismatch(pending, signal);
  }
}
