import type { AsyncStorage } from "../platform/storage";
import { PendingSlot, PendingStoreError, validId } from "../commands/pendingSlot";
import { resetFinalCodes, resetHeldCodes, validSettingsResetIntent, type ResetFinalCode, type ResetHeldCode,
  type SettingsResetIntent } from "./settingsApi";

/**
 * Where the client stands with its sent reset (P02-R I.11.1, R16-01 variant 1):
 * - none: sent, its outcome not known to the client yet (it is read by its ID);
 * - `refused`: the server stored an explicit refusal of it (F2, R8-05/R8-06 variant 1) — held until the user's
 *   «Отменить прежний сброс», never cancelled by itself;
 * - `cancel`: the cancel with this new ID was stored before it was sent (`explicit`: by that button; otherwise by the client
 *   itself after the canonical not_found of the reset's status, CON:301).
 */
export type SettingsResetState = { refused: ResetHeldCode } | { cancel: string; explicit: boolean };

/**
 * «Отказан» (P02-R I.11.1, I.11.3a): a reset the server closed for good with F1 (RESET_EPOCH_STALE / RESET_CANCELLED). It is
 * kept with the profile's record until the server applies the next settings command of the profile (a reset or a field save),
 * or the profile is deleted; a refused or unknown new command does not lift it. X is never sent, cancelled or read again.
 */
export type SettingsResetFinal = { command_id: string; code: ResetFinalCode };

/** The sent reset whose outcome is not confirmed yet. It holds no setting values: the server owns them. */
export type SettingsResetPending = {
  schemaVersion: 2;
  profileId: string;
  clientInstanceId: string;
  intent: SettingsResetIntent;
  state?: SettingsResetState;
  /** A minimal status fact cannot prove this intent after an ID/content mismatch. */
  mismatch?: true;
  /** «Отказан» of an earlier reset, kept while this newer one is not applied (I.11.3a п.5). */
  final?: SettingsResetFinal;
};
/** The record of a profile with no unfinished reset, only «отказан» (I.11.1 third part). */
export type SettingsResetFinalOnly = { schemaVersion: 2; profileId: string; clientInstanceId: string; final: SettingsResetFinal };
/** What the profile's reset slot holds. */
export type SettingsResetRecord = SettingsResetPending | SettingsResetFinalOnly;
export function unfinished(record: SettingsResetRecord | null): record is SettingsResetPending {
  return !!record && Object.hasOwn(record, "intent");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validState(value: unknown, intent: SettingsResetIntent): value is SettingsResetState {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  if (keys === "refused") return (resetHeldCodes as readonly unknown[]).includes(value.refused);
  return keys === "cancel,explicit" && validId(value.cancel) && typeof value.explicit === "boolean"
    && value.cancel.toLowerCase() !== intent.command_id.toLowerCase();
}

function validFinal(value: unknown): value is SettingsResetFinal {
  return record(value) && Object.keys(value).sort().join(",") === "code,command_id" && validId(value.command_id)
    && (resetFinalCodes as readonly unknown[]).includes(value.code);
}

/**
 * A record of this build (schema 2) or of a build before P02-R (schema 1: an empty payload and no state). The earlier one is
 * read as the legacy intent without an epoch that was sent and not resolved; it is rewritten as schema 2 only by its next
 * change of state, never just by being read. Schema 2 also holds «отказан» alone (no intent) or beside a newer reset.
 */
export function validSettingsResetPending(value: unknown): value is SettingsResetRecord {
  if (!record(value)) return false;
  const legacy = value.schemaVersion === 1;
  if (!legacy && !Object.hasOwn(value, "intent")) {
    return Object.keys(value).sort().join(",") === "clientInstanceId,final,profileId,schemaVersion" && value.schemaVersion === 2
      && validId(value.profileId) && validId(value.clientInstanceId) && validFinal(value.final);
  }
  const fields = ["schemaVersion", "profileId", "clientInstanceId", "intent",
    ...(!legacy && Object.hasOwn(value, "state") ? ["state"] : []), ...(Object.hasOwn(value, "mismatch") ? ["mismatch"] : []),
    ...(!legacy && Object.hasOwn(value, "final") ? ["final"] : [])];
  if (Object.keys(value).length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) return false;
  if (!(legacy || value.schemaVersion === 2) || !validId(value.profileId) || !validId(value.clientInstanceId)
    || Object.hasOwn(value, "mismatch") && value.mismatch !== true || !validSettingsResetIntent(value.intent)) return false;
  if (legacy && Object.keys(value.intent.payload).length !== 0) return false;
  if (Object.hasOwn(value, "final") && (!validFinal(value.final)
    || (value.final as SettingsResetFinal).command_id.toLowerCase() === value.intent.command_id.toLowerCase())) return false;
  return !Object.hasOwn(value, "state") || validState(value.state, value.intent);
}

function copy(value: unknown): SettingsResetRecord {
  if (!validSettingsResetPending(value)) throw new PendingStoreError("invalid");
  const final = value.final ? { final: { command_id: value.final.command_id.toLowerCase(), code: value.final.code } } : {};
  if (!unfinished(value)) {
    return { schemaVersion: 2, profileId: value.profileId, clientInstanceId: value.clientInstanceId, final: final.final! };
  }
  const epoch = (value.intent.payload as { expected_reset_epoch?: string }).expected_reset_epoch;
  const state = value.state === undefined ? undefined : "refused" in value.state ? { refused: value.state.refused }
    : { cancel: value.state.cancel.toLowerCase(), explicit: value.state.explicit };
  // A fixed property order gives the slot an exact comparison; schema 1 is read in the form of schema 2.
  return { schemaVersion: 2, profileId: value.profileId, clientInstanceId: value.clientInstanceId,
    ...(value.mismatch ? { mismatch: true } : {}),
    intent: { command_id: value.intent.command_id, kind: "settings.reset",
      payload: epoch === undefined ? {} : { expected_reset_epoch: epoch } },
    ...(state ? { state } : {}), ...final };
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
  private readonly slots = new Map<string, PendingSlot<SettingsResetRecord>>();

  constructor(private readonly storage: AsyncStorage) {}

  private slot(profileId: string): PendingSlot<SettingsResetRecord> {
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

  async load(profileId: string, signal: AbortSignal): Promise<SettingsResetRecord | null> {
    await this.legacyGuard(profileId, signal);
    return this.slot(profileId).load(profileId.toLowerCase(), signal);
  }

  async save(value: SettingsResetRecord, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).save(pending, signal);
  }

  async clear(value: SettingsResetRecord, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).clear(pending, signal);
  }

  async clearMarked(value: SettingsResetRecord, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).clearMarked(pending, signal);
  }

  async markMismatch(value: SettingsResetRecord, signal: AbortSignal): Promise<void> {
    const pending = copy(value);
    await this.legacyGuard(pending.profileId, signal);
    return this.slot(pending.profileId).markMismatch(pending, signal);
  }

  /**
   * The conditional replacement of I.11.1 (ред. 2): `next` is written only while the slot still holds `expected` (the same
   * reset in the same state); a record another window changed meanwhile fails as "changed" and is kept, an absent one is
   * not recreated (it was resolved elsewhere). Both name the same profile; `next` keeps the reset of `expected`, or turns it
   * into «отказан» (F1), or (from «отказан» alone) starts a newer reset that carries it.
   */
  async replace(expected: SettingsResetRecord, next: SettingsResetRecord, signal: AbortSignal): Promise<void> {
    const before = copy(expected), after = copy(next);
    const idOf = (value: SettingsResetRecord) => unfinished(value) ? value.intent.command_id.toLowerCase() : null;
    const sameReset = idOf(before) === idOf(after)
      || unfinished(before) && !unfinished(after) && after.final.command_id === idOf(before)
      || !unfinished(before) && unfinished(after) && after.final?.command_id === before.final.command_id
      || unfinished(before) && !unfinished(after) && !!before.final && after.final.command_id === before.final.command_id;
    if (before.profileId.toLowerCase() !== after.profileId.toLowerCase() || !sameReset) throw new PendingStoreError("invalid");
    await this.legacyGuard(before.profileId, signal);
    return this.slot(before.profileId).replace(before, after, signal);
  }
}
