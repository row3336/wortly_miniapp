import type { AsyncStorage } from "../platform/storage";
import type { ForgetOutcome, InstallationStore } from "../app/installationStore";
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

/**
 * The IndexedDB stores of the page and their class for a deleted profile (store §6). forget — the installation record of
 * X is removed by store.forget (both spellings); revoke — the journal buffer goes by journal.revoke(true); kept — the send
 * budget (Е01/Е02: the count of an unconfirmed action stays until its outcome; no writer in the product). «the inventory of
 * local keys» in profileWipe.test.ts fails when a database or store name appears in the code without a class here.
 */
export const IDB_STORES: Readonly<Record<string, "forget" | "revoke" | "kept">> = Object.freeze({
  "wortly_installation/installations": "forget",
  "wortly_journal/buffers": "revoke",
  "wortly/send_budget": "kept",
});

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

/**
 * The outcome per store (project_installation_store.md ред.1.5 §6): installation — what `forget` of the IndexedDB
 * record answered ("no-store": none was given); local — the localStorage keys and slots. wiped («стёрто») holds only when
 * forget answered "removed" AND no local key failed: failed / unknown / unavailable / unsupported of the store, or any
 * local failure, is never a clean profile — the cleanup is repeated while the page knows X is deleted
 * (deletedProfileCleanup.ts).
 */
export type WipeResult = {
  installation: ForgetOutcome | { kind: "no-store" };
  local: { removed: number; failed: number };
  wiped: boolean;
};

/**
 * Removes the records of profileId: first the installation record in IndexedDB (store.forget — both spellings of the key,
 * in the writers' order; its first open imports the legacy record before, §3, so N12 ends with no X), then the
 * localStorage keys and slots as before. Never throws: an unwritable storage keeps them (accepted residual of (A), §3.7 —
 * the key is the old profile_id, which a new profile never reads); the failures are only counted.
 *
 * Not closed here (store §6, separate canon project_pending_profile_slots.md ред.1.1): the shared pending slots below are
 * read and then removed — a valid pending of ANOTHER profile written by another window between the two steps is lost
 * (C422/C424, P2). This step does not fix that race.
 */
export async function wipeProfileRecords(storage: AsyncStorage, profileId: string, store?: InstallationStore): Promise<WipeResult> {
  const local = { removed: 0, failed: 0 };
  if (!validId(profileId)) return { installation: { kind: "no-store" }, local, wiped: false };
  let installation: WipeResult["installation"] = { kind: "no-store" };
  if (store) {
    // A throwing forget is no answer: it may or may not have removed anything.
    try { installation = await store.forget(profileId); } catch { installation = { kind: "unknown" }; }
  }
  const result = { installation, local };
  const spellings = [...new Set([profileId, profileId.toLowerCase()])];
  const keys = new Set<string>();
  for (const id of spellings) for (const key of PROFILE_KEYED) {
    try { keys.add(key(id)); } catch { /* an ID the slot does not accept has no such key */ }
  }
  for (const key of keys) {
    try {
      if (await storage.get(key) === null) continue;
      await storage.remove(key);
      local.removed++;
    } catch { local.failed++; }
  }
  for (const key of SHARED_SLOTS) {
    try {
      if (!namesProfile(await storage.get(key), profileId)) continue;
      await storage.remove(key);
      local.removed++;
    } catch { local.failed++; }
  }
  return { ...result, wiped: installation.kind === "removed" && local.failed === 0 };
}
