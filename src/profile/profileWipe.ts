import type { AsyncStorage } from "../platform/storage";
import type { ForgetOutcome, InstallationStore } from "../app/installationStore";
import { PAYLOAD_PREFIX, pointerKeyOf, validId } from "../commands/pendingSlot";
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

const START_CANCEL_MODES: readonly StartCancelMode[] = ["written", "learning", "oral", "conjugation"];

/**
 * The base keys of the 16 kinds that used to share one slot (project_pending_profile_slots.md ред.1.1 §2): each now has a
 * pointer per profile `<base>:profile:<pid>` and, for a user's input, payloads `wortly.payload.<L>:<pid>:<command_id>`.
 */
export const LANE_KEYS: readonly string[] = Object.freeze([
  "wortly.pending.feedback", "wortly.pending.remote_stop", "wortly.pending.manual",
  "wortly.pending.learning_session", "wortly.pending.learning_stop",
  "wortly.pending.oral_session", "wortly.pending.oral_stop",
  writtenPrimaryKey, writtenStopKey,
  "wortly.pending.conjugation_catalog", "wortly.pending.conjugation_session", "wortly.pending.conjugation_stop",
  ...START_CANCEL_MODES.map(startCancelKey),
]);

/**
 * The 18 legacy shared keys (§4): the 16 bases and the two legacy settings keys. They are only READ (the preflight of a
 * new intent); no wipe, Е02 or other operation writes or removes them.
 */
export const LEGACY_KEYS: readonly string[] = Object.freeze([...LANE_KEYS, SETTINGS_SLOT, SETTINGS_RESET_SLOT]);

export const PROFILE_KEYED: readonly ((profileId: string) => string)[] = Object.freeze([
  (id: string) => `wortly.installation:${id}`,
  (id: string) => `wortly.reapply:${id}`,
  settingsSlotOf,
  settingsResetSlotOf,
  ...LANE_KEYS.map(base => (id: string) => pointerKeyOf(base, id)),
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
 * Pending (project_pending_profile_slots.md ред.1.1 §3.3): only the exact keys of X — its pointers and its payloads
 * `wortly.payload.*:<x>:*` — are removed; no key of another profile and no legacy shared key is read for removal or
 * removed, so a pending of Y written at any moment stays (C422/C424). A storage that cannot list its keys leaves the
 * payloads of X (counted as a failure: residual (A)), and the cleanup is repeated by knowledge (deletedProfileCleanup).
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
  // Exactly the payloads of X: `wortly.payload.<L>:<x>:<command_id>` with X in the profile place (§3.3).
  const mine = profileId.toLowerCase();
  try {
    if (!storage.keys) throw new Error("no listing");
    for (const key of await storage.keys(PAYLOAD_PREFIX)) {
      const parts = key.slice(PAYLOAD_PREFIX.length).split(":");
      if (parts.length !== 3 || parts[1] !== mine) continue;
      try { await storage.remove(key); local.removed++; } catch { local.failed++; }
    }
  } catch { local.failed++; }
  return { ...result, wiped: installation.kind === "removed" && local.failed === 0 };
}

/**
 * Е02 (tz_app.md:179): on the admission of profileId the text and envelope of another account's unconfirmed commands go —
 * its payloads `wortly.payload.*:<other>:*`; its pointers (service IDs, marks) and its budget stay until the outcome, so
 * that account, back again, checks by ID (lost_envelope, Q27). Never throws; returns how many were removed and failed.
 * Not closed: two live accounts on two windows — the payload of a live one is removed as well (§5).
 */
export async function dropForeignPayloads(storage: AsyncStorage, profileId: string): Promise<{ removed: number; failed: number }> {
  const result = { removed: 0, failed: 0 };
  if (!validId(profileId)) return result;
  const mine = profileId.toLowerCase();
  try {
    if (!storage.keys) throw new Error("no listing");
    for (const key of await storage.keys(PAYLOAD_PREFIX)) {
      const parts = key.slice(PAYLOAD_PREFIX.length).split(":");
      if (parts.length !== 3 || parts[1] === mine) continue;
      try { await storage.remove(key); result.removed++; } catch { result.failed++; }
    }
  } catch { result.failed++; }
  return result;
}
