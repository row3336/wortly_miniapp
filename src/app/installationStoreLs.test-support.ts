// The localStorage + Web Locks prototype of the installation store (C405 step 1). Its cross-process atomicity is not
// proven (C410: localStorage gives no locking guarantee between processes), so it is NOT a product backend
// (project_installation_store.md §1): it lives here, for the tests of the store contract only, and no product module
// may import it.
import type { Installation } from "./installation";
import { installationKey } from "./installationStore";
import type { ForgetOutcome, InstallationDecision, InstallationStore, MutateOutcome } from "./installationStore";

/** The Web Lock of the record's critical section; another name than the lifetime document lock `wortly-document:*`. */
export function installationLockName(profileId: string): string {
  return `wortly-installation-store:${profileId}`;
}

const VERSION = /^[1-9][0-9]{0,18}$/;

/** The same check as readInstallation (app/installation.ts), synchronous; "invalid" where that one throws. */
export function parseInstallation(raw: string | null, profileId: string): Installation | null | "invalid" {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return "invalid"; }
  if (typeof value !== "object" || value === null) return "invalid";
  const item = value as Record<string, unknown>;
  if (item.profileId !== profileId || typeof item.clientInstanceId !== "string"
    || typeof item.registrationId !== "string" || typeof item.activated !== "boolean"
    || !(item.proof === null || typeof item.proof === "string")
    || !(item.proofVersion === null || typeof item.proofVersion === "string" && VERSION.test(item.proofVersion))) {
    return "invalid";
  }
  return item as Installation;
}

type Section<R, C extends string> = MutateOutcome<R, C> | { kind: "thrown"; error: unknown };

function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

/**
 * The browser adapter: a short exclusive Web Lock per profile (never steal, never ifAvailable), and under it, in one
 * synchronous run: getItem → parse/validate → guard → reducer(actual) → guard → setItem. The lock orders only the
 * writers that take it: an old page (79) or another script that sets the key directly is not held back by it, and
 * localStorage alone is no compare-and-set between windows.
 */
export function browserInstallationStore(storage: Storage, locks: LockManager | undefined): InstallationStore {
  return {
    async mutate<R, C extends string = string>(profileId: string, guardCurrent: () => boolean,
      reducer: (current: Installation | null) => InstallationDecision<R, C>,
      options: { signal?: AbortSignal } = {}): Promise<MutateOutcome<R, C>> {
      const { signal } = options;
      if (!locks) return { kind: "unsupported", reason: "no-web-locks" };
      if (signal?.aborted || !guardCurrent()) return { kind: "cancelled", at: "before-lock" };
      const key = installationKey(profileId);
      const alive = () => !signal?.aborted && guardCurrent();
      // The whole section is one synchronous call: the lock is released right after it returns.
      const section = (): Section<R, C> => {
        try {
          if (!alive()) return { kind: "cancelled", at: "after-lock" };
          let raw: string | null;
          try { raw = storage.getItem(key); } catch { return { kind: "unsupported", reason: "storage-read" }; }
          const current = parseInstallation(raw, profileId);
          if (current === "invalid") return { kind: "conflict", record: null, reason: "invalid" };
          const decision: unknown = reducer(current);
          if (isThenable(decision)) throw new TypeError("The installation reducer must be synchronous");
          const made = decision as Record<string, unknown>;
          if (typeof made !== "object" || made === null) throw new TypeError("Unknown installation decision");
          if ("conflict" in made) return { kind: "conflict", record: current, reason: made.conflict as C };
          if (made.keep === true) return { kind: "current", record: current, result: made.result as R };
          if (!("write" in made)) throw new TypeError("Unknown installation decision");
          const text = JSON.stringify(made.write);
          const written = parseInstallation(text ?? null, profileId);
          if (written === null || written === "invalid") throw new Error("Invalid installation");
          if (!alive()) return { kind: "cancelled", at: "before-write" };
          try { storage.setItem(key, text); } catch { return { kind: "unsupported", reason: "storage-write" }; }
          return { kind: "applied", record: written, result: made.result as R };
        } catch (error) {
          return { kind: "thrown", error };
        }
      };
      let outcome: Section<R, C>;
      try {
        outcome = await locks.request(installationLockName(profileId), { mode: "exclusive", ...(signal ? { signal } : {}) },
          () => section());
      } catch {
        // Only a request that never reached the section ends here (the section itself never throws).
        return signal?.aborted ? { kind: "cancelled", at: "before-lock" } : { kind: "unsupported", reason: "lock-failed" };
      }
      if (outcome.kind === "thrown") throw outcome.error;
      return outcome;
    },
    async forget(profileId) {
      // The localStorage prototype (not the product path): both spellings under the profile's lock, synchronously.
      if (!locks) return { kind: "unsupported" };
      const ids = [...new Set([profileId, profileId.toLowerCase()])];
      try {
        return await locks.request(installationLockName(profileId), { mode: "exclusive" }, (): ForgetOutcome => {
          let count = 0;
          try {
            for (const id of ids) {
              const key = installationKey(id);
              if (storage.getItem(key) === null) continue;
              storage.removeItem(key);
              count += 1;
            }
          } catch { return { kind: "failed" }; }
          return { kind: "removed", count };
        });
      } catch { return { kind: "failed" }; }
    },
    async read(profileId) {
      let raw: string | null;
      try { raw = storage.getItem(installationKey(profileId)); } catch { return { kind: "unsupported" }; }
      const record = parseInstallation(raw, profileId);
      return record === "invalid" ? { kind: "invalid" } : { kind: "current", record };
    },
  };
}
