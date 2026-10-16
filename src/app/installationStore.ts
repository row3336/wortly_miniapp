import type { Installation } from "./installation";

/**
 * The installation record capability (C405, P2-5B): one atomic path for every writer of `wortly.installation:<profile>`
 * among the windows of this protocol. An arbitrary AsyncStorage is not atomic by assumption, and a re-read before an
 * async set leaves the last gap between windows open; this capability is the only writer path of the record.
 */

/** A writer's synchronous, pure decision over the ACTUAL record read under the lock. No await, no Promise inside. */
export type InstallationDecision<R, C extends string = string> =
  | { write: Installation; result: R }
  | { keep: true; result: R }
  | { conflict: C };

export type MutateOutcome<R, C extends string = string> =
  /** setItem ran: record is what was written. The caller still checks its own context before using it. */
  | { kind: "applied"; record: Installation; result: R }
  /** The reducer kept the actual record (null: there is none); nothing was written. */
  | { kind: "current"; record: Installation | null; result: R }
  /**
   * Nothing was written: the reducer refused the actual record, or "invalid" — the stored value is no valid record of
   * this profile (readInstallation throws for it; the reducer is not called, record is null).
   */
  | { kind: "conflict"; record: Installation | null; reason: C | "invalid" }
  /**
   * The context ended; nothing was written. before-lock: before the request or while waiting for the lock (IndexedDB:
   * while the transaction was queued); after-lock: as soon as the lock was granted (IndexedDB: the read was answered);
   * before-write: after the reducer, right before the write; before-commit (IndexedDB only): the transaction was
   * aborted after the write was placed and before it committed — the abort is definite, the write is discarded.
   */
  | { kind: "cancelled"; at: "before-lock" | "after-lock" | "before-write" | "before-commit" }
  /**
   * IndexedDB only: the write COMMITTED, but this context ended before the commit was reported (dispose, another
   * generation, an abort that came too late). The record is a fact for every window; this context acts on nothing.
   */
  | { kind: "late"; record: Installation; result: R }
  /** IndexedDB only: the transaction aborted or failed (commit error, quota, closed connection): nothing was written. */
  | { kind: "failed" }
  /** IndexedDB only: no answer within the limit. The write may or may not commit later: nothing is known. */
  | { kind: "unknown" }
  /**
   * IndexedDB only: the database did not open this time (no answer within the limit, an open error, or the IndexedDB
   * getter itself threw: "api-error"). A temporary state, NOT a platform without the capability: this operation wrote
   * nothing, an earlier record may well exist, and it allows no read-only fallback to the legacy record — the caller
   * fails closed (no register/open) and tries again later.
   */
  | { kind: "unavailable"; reason: "open-timeout" | "open-failed" | "api-error" }
  /**
   * The platform lacks the capability: no Web Locks, the lock request failed, the storage threw (localStorage
   * prototype); the IndexedDB API is reliably absent (no property, or undefined/null). Nothing was written. Only this
   * outcome opens the narrow read-only path of project_installation_store.md §5 (readLegacy).
   */
  | { kind: "unsupported"; reason: "no-web-locks" | "lock-failed" | "storage-read" | "storage-write" | "no-indexeddb" };

/**
 * invalid is explicit and fail-closed: never "current null", never a new A over a damaged record. unavailable
 * (IndexedDB only): this read did not complete (open or read timed out or failed) — temporary, fail-closed, never
 * "unsupported" and never a reason to read the legacy record instead.
 */
export type InstallationRead =
  | { kind: "current"; record: Installation | null }
  | { kind: "invalid" }
  | { kind: "unavailable"; reason: "open-timeout" | "open-failed" | "api-error" | "read-timeout" | "read-failed" }
  | { kind: "unsupported" };

/**
 * forget (project_installation_store.md §6): the profile's record in both spellings of its key, in one transaction of the
 * same order as the writers. Only "removed" means removed (count: how many keys held a value, 0 — none). failed and
 * unavailable: this operation removed nothing; unknown: it may or may not have removed; unsupported: no capability.
 */
export type ForgetOutcome =
  | { kind: "removed"; count: number }
  | { kind: "failed" }
  | { kind: "unknown" }
  | { kind: "unavailable"; reason: "open-timeout" | "open-failed" | "api-error" }
  | { kind: "unsupported" };

export interface InstallationStore {
  /**
   * One mutation of the profile's record, atomic among the writers of this protocol.
   * guardCurrent (the caller's live context: generation, disposed, closed, replaced, profile, operation) runs before the
   * lock request, as soon as the lock is granted and, last, right before setItem: nothing is awaited between that last
   * guard and setItem. The reducer is synchronous and pure; a thenable from it is an error. A throwing guard or reducer,
   * or a written record of another profile or of an invalid form, rejects the promise (a programming error, never
   * "unsupported"); nothing is written then. IndexedDB: a guard that throws once the write committed cannot confirm the
   * context, so that outcome is "late" (the write is a fact), never a pending promise and never a rejection; the same
   * for a diagnostic report that throws. signal ends the wait for the lock; once granted, an aborted signal also cancels. "unsupported" never writes and never throws.
   */
  mutate<R, C extends string = string>(profileId: string, guardCurrent: () => boolean,
    reducer: (current: Installation | null) => InstallationDecision<R, C>,
    options?: { signal?: AbortSignal }): Promise<MutateOutcome<R, C>>;
  /** A read without the lock and without a write. */
  read(profileId: string): Promise<InstallationRead>;
  /** Removes the record of profileId in both spellings of its key (P04 cleanup). Never a guess: see ForgetOutcome. */
  forget(profileId: string): Promise<ForgetOutcome>;
}

/** The six fields of the record (project_installation_store.md §2): exactly these, nothing more or less. */
export const INSTALLATION_FIELDS: readonly (keyof Installation)[] = Object.freeze(
  ["profileId", "clientInstanceId", "registrationId", "proof", "proofVersion", "activated"]);

/**
 * The strict check of §2: an object with exactly the six fields of allowed types and record.profileId === profileId.
 * Returns a fresh object of those six fields (never the input), or "invalid". Extras are never copied or dropped.
 */
export function strictInstallation(value: unknown, profileId: string): Installation | "invalid" {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item);
  if (keys.length !== INSTALLATION_FIELDS.length || !INSTALLATION_FIELDS.every(field => Object.prototype.hasOwnProperty.call(item, field))) {
    return "invalid";
  }
  if (item.profileId !== profileId || typeof item.clientInstanceId !== "string" || typeof item.registrationId !== "string"
    || typeof item.activated !== "boolean" || !(item.proof === null || typeof item.proof === "string")
    || !(item.proofVersion === null || typeof item.proofVersion === "string" && /^[1-9][0-9]{0,18}$/.test(item.proofVersion))) {
    return "invalid";
  }
  return { profileId: item.profileId, clientInstanceId: item.clientInstanceId, registrationId: item.registrationId,
    proof: item.proof as string | null, proofVersion: item.proofVersion as string | null, activated: item.activated };
}

/** The invalid marker of §2: exactly { profileId, invalid: true } — no copy of the raw legacy value (it may hold a proof). */
export type InvalidMarker = { profileId: string; invalid: true };
export function invalidMarker(profileId: string): InvalidMarker {
  return { profileId, invalid: true };
}
export function isInvalidMarker(value: unknown, profileId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 2 && item.profileId === profileId && item.invalid === true;
}

/** The storage key of the record; the same as app/installation.ts (no migration, no new namespace). */
export function installationKey(profileId: string): string {
  return `wortly.installation:${profileId}`;
}
