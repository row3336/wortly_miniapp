import type { AsyncStorage } from "../platform/storage";
import { validId } from "../commands/pendingSlot";
import { startCancelKey, type StartCancelMode } from "../commands/startCancelPending";
import { SETTINGS_SLOT, settingsSlotOf } from "../settings/settingsPending";
import { SETTINGS_RESET_SLOT, settingsResetSlotOf } from "../settings/settingsResetPending";
import { writtenPrimaryKey, writtenStopKey } from "../written/writtenPending";

/**
 * The local records of a deleted profile X (P04 ред.14 §8, §3.7 (A); CON §7.3 п.2; TZA:291): once the core said the
 * profile is deleted (applied / already_applied / PROFILE_DELETED, or the PD-28 conclusion after an explicit sign-in),
 * this device keeps nothing of X — its installation key (client_instance_id and proof), its reapply intent, its
 * profile records of settings and of the P02 reset, and every shared slot whose record names X. A shared slot holding
 * another profile's record is left as it is. The journal buffer is cleared by the journal itself (revoke(true)).
 *
 * The keys are listed here on purpose (AsyncStorage enumerates nothing); «the inventory of local keys» in
 * profileWipe.test.ts fails when a new `wortly.` key appears in the code without being classified here.
 *
 * Not X's record: `wortly.uiLanguage` (the device's language preference, used to show the result itself).
 */
export const PROFILE_KEYED: readonly ((profileId: string) => string)[] = Object.freeze([
  (id: string) => `wortly.installation:${id}`,
  (id: string) => `wortly.reapply:${id}`,
  settingsSlotOf,
  settingsResetSlotOf,
]);

const START_CANCEL_MODES: readonly StartCancelMode[] = ["written", "learning", "oral", "conjugation"];

/** Shared slots of one record each; a record names its profile in `profileId`. */
export const SHARED_SLOTS: readonly string[] = Object.freeze([
  SETTINGS_SLOT, SETTINGS_RESET_SLOT,
  "wortly.pending.feedback", "wortly.pending.remote_stop", "wortly.pending.manual",
  "wortly.pending.learning_session", "wortly.pending.learning_stop",
  "wortly.pending.oral_session", "wortly.pending.oral_stop",
  writtenPrimaryKey, writtenStopKey,
  "wortly.pending.conjugation_catalog", "wortly.pending.conjugation_session", "wortly.pending.conjugation_stop",
  ...START_CANCEL_MODES.map(startCancelKey),
]);

/** Keys of this module that are deliberately kept: device data, not records of a profile. */
export const NOT_PROFILE_RECORDS: readonly string[] = Object.freeze(["wortly.uiLanguage"]);

function namesProfile(raw: string | null, profileId: string): boolean {
  if (raw === null) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && typeof (value as { profileId?: unknown }).profileId === "string"
      && (value as { profileId: string }).profileId.toLowerCase() === profileId.toLowerCase();
  } catch { return false; }
}

export type WipeResult = { removed: number; failed: number };

/**
 * Removes the local records of profileId. Never throws: an unwritable storage keeps them (accepted residual of (A),
 * §3.7 — the key is the old profile_id, which a new profile never reads); the failures are only counted.
 */
export async function wipeProfileRecords(storage: AsyncStorage, profileId: string): Promise<WipeResult> {
  const result: WipeResult = { removed: 0, failed: 0 };
  if (!validId(profileId)) return result;
  const spellings = [...new Set([profileId, profileId.toLowerCase()])];
  const keys = new Set<string>();
  for (const id of spellings) for (const key of PROFILE_KEYED) {
    try { keys.add(key(id)); } catch { /* an ID the slot does not accept has no such key */ }
  }
  for (const key of keys) {
    try {
      if (await storage.get(key) === null) continue;
      await storage.remove(key);
      result.removed++;
    } catch { result.failed++; }
  }
  for (const key of SHARED_SLOTS) {
    try {
      if (!namesProfile(await storage.get(key), profileId)) continue;
      await storage.remove(key);
      result.removed++;
    } catch { result.failed++; }
  }
  return result;
}
