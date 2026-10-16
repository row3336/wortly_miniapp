import type { Installation } from "./installation";
import { installationKey, invalidMarker, isInvalidMarker, strictInstallation } from "./installationStore";
import type { ForgetOutcome, InstallationDecision, InstallationRead, InstallationStore, MutateOutcome } from "./installationStore";

/**
 * The installation record in IndexedDB (project_installation_store.md ред.1, P2-5B; stand code, not wired by App yet).
 * Its own database, apart from the send budget database `wortly` (platform/indexedDb.ts) as the journal does
 * (journal/journalStore.ts): a new store in `wortly` would need version 2, whose versionchange closes the send budget
 * connection of every open older page, and a rollback (open of version 1 over version 2) would leave its send budget
 * unavailable.
 *
 * One mutation is ONE readwrite transaction (durability "strict"): get(profile) → guard → reducer(actual) → guard → put.
 * Readwrite transactions of overlapping scope run one after another across all connections of the origin (IndexedDB
 * §2.7.2, G1), so the reducer always sees the record as the previous writer committed it. The outcome is decided by the
 * transaction's own event, never by the guard alone: "applied" only after complete with a live context; a commit after
 * the context ended (or whose context cannot be confirmed) is "late"; an abort is "cancelled" only if this store asked
 * for it, otherwise "failed"; no answer within the limit is "unknown".
 *
 * The legacy record `wortly.installation:<profile>` (localStorage) is imported once, in the upgrade of a NEW database
 * instance (actual oldVersion 0, §3), and never read again for the installation — except the read-only path of §5
 * (readLegacy), allowed only when the IndexedDB API is reliably absent.
 */
export const INSTALLATION_DATABASE = "wortly_installation";
export const INSTALLATION_DATABASE_VERSION = 1;
export const INSTALLATION_STORE = "installations";
/** A parameter of the prototype (§4), not an approved deadline. */
export const INSTALLATION_STORE_TIMEOUT_MS = 5_000;
/** The legacy key of every profile starts with the key of the empty ID (no new key literal: profileWipe inventory). */
const LEGACY_PREFIX = installationKey("");

/**
 * Whether this page has the IndexedDB API (§5). "absent" only when it is reliably not there: no `indexedDB` property, or
 * the property is undefined or null. A getter that throws, or a value that is no factory, is "error": never "absent".
 */
export type IndexedDbProbe = { kind: "present"; factory: IDBFactory } | { kind: "absent" } | { kind: "error" };
export function probeIndexedDb(scope: object): IndexedDbProbe {
  let value: unknown;
  try {
    if (!("indexedDB" in scope)) return { kind: "absent" };
    value = (scope as { indexedDB?: unknown }).indexedDB;
  } catch {
    return { kind: "error" };
  }
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value !== "object" || typeof (value as { open?: unknown }).open !== "function") return { kind: "error" };
  return { kind: "present", factory: value as IDBFactory };
}

/** The strict read-only legacy read of §5. openable: an activated record with a proof and its version. */
export type LegacyRead =
  | { kind: "found"; record: Installation; openable: boolean }
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "error" }
  | { kind: "not-allowed" };

export interface IdbInstallationStore extends InstallationStore {
  /**
   * §5 only: when the IndexedDB API is reliably absent, one strict read of the profile's legacy record — no import, no
   * write, no mirror. With the API present (or its getter failing) always "not-allowed": never a fallback.
   */
  readLegacy(profileId: string): Promise<LegacyRead>;
}

type Connection = IDBDatabase | "missing" | "failed" | "timeout" | "api-error";

/** The legacy value of one key as the record or the invalid marker to put (§2, §3). */
function importedValue(raw: string, profileId: string): Installation | ReturnType<typeof invalidMarker> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return invalidMarker(profileId); }
  const record = strictInstallation(value, profileId);
  return record === "invalid" ? invalidMarker(profileId) : record;
}

/** How many full passes over the key list the import makes at most before it gives up (abort → unavailable). */
const KEY_LIST_PASSES = 5;

/**
 * The list of every localStorage key, accepted only when it is the same in two consecutive full passes: the same
 * length before and after each pass, and the same keys in the same order. Otherwise — after KEY_LIST_PASSES passes —
 * it throws, and the upgrade aborts (the open is "unavailable", no new A, the legacy untouched; the next open tries
 * again).
 *
 * The guarantee this method needs, and what it does not give: storage.key(i) is positional, so a key removed or added
 * WHILE a pass runs shifts the indices and can hide a valid key (QA QC1e). Such a change, if this page sees it, makes
 * two consecutive passes differ (or the length move) and is caught. Two equal passes are NOT a cross-process guarantee:
 * a change this page does not observe during the passes (a renderer's cached copy of localStorage), or one that hits
 * both passes identically, is not detected. Whether engines keep localStorage stable for a synchronous run is not
 * proven here (no assumption about the Chromium/WebKit cache): that stays gate G2.
 */
function settledKeys(storage: Storage): string[] {
  let previous: string[] | null = null;
  for (let pass = 0; pass < KEY_LIST_PASSES; pass++) {
    const length = storage.length;
    const keys: string[] = [];
    for (let index = 0; index < length; index++) {
      const key = storage.key(index);
      if (key !== null) keys.push(key);
    }
    const stable = storage.length === length && keys.length === length;
    if (stable && previous !== null && previous.length === keys.length && previous.every((key, index) => key === keys[index])) {
      return keys;
    }
    previous = stable ? keys : null;
  }
  throw new Error("The legacy key list did not settle");
}

/**
 * Upgrade of a new database instance (actual oldVersion 0, §3): the store, then every legacy key of every profile (from
 * the settled key list, settledKeys), one row per exact key. Any exception of the storage (length, key, getItem) or of a put aborts the whole upgrade: no
 * database, no partial import, the legacy untouched — the open then fails ("unavailable"), never an empty store.
 */
function upgrade(db: IDBDatabase, oldVersion: number, legacy: () => Storage): void {
  if (oldVersion !== 0) return;
  const store = db.createObjectStore(INSTALLATION_STORE, { keyPath: "profileId" });
  const storage = legacy();
  const keys = settledKeys(storage).filter(key => key.startsWith(LEGACY_PREFIX));
  for (const key of keys) {
    const raw = storage.getItem(key);
    if (raw === null) continue; // gone between key() and getItem(): nothing to import
    store.put(importedValue(raw, key.slice(LEGACY_PREFIX.length)));
  }
}

function openDatabase(factory: IDBFactory, timeoutMs: number, legacy: () => Storage, onClosed: () => void): Promise<Connection> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = (reason: "failed" | "timeout" = "failed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    let request: IDBOpenDBRequest;
    try { request = factory.open(INSTALLATION_DATABASE, INSTALLATION_DATABASE_VERSION); } catch { fail(); return; }
    request.onupgradeneeded = (event) => {
      try {
        upgrade(request.result, event.oldVersion, legacy);
      } catch {
        try { request.transaction?.abort(); } catch { /* already finished */ }
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => { db.close(); onClosed(); };
      db.onclose = () => onClosed();
      resolve(db);
    };
    request.onerror = () => fail();
  });
}

/** A stored value as a record of this profile: strict six fields (§2); the marker and any other form are "invalid". */
function storedRecord(value: unknown, profileId: string): Installation | null | "invalid" {
  if (value === undefined) return null;
  if (isInvalidMarker(value, profileId)) return "invalid";
  return strictInstallation(value, profileId);
}

function isThenable(value: unknown): boolean {
  return (typeof value === "object" || typeof value === "function") && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

type Stage = "queued" | "read" | "placed" | "committing";
type Cancel = "before-lock" | "after-lock" | "before-write" | "before-commit";
const GUARD_AFTER_COMMIT = "Wortly installation store: the guard threw after the commit; the outcome is late";

export type IdbStoreOptions = {
  timeoutMs?: number;
  /**
   * A fixed text for a program error the store cannot return any other way (no proof, no ID, no error text: a guard's
   * message could name them). Default: console.warn, as settingsPending and the page journal do. A report that throws
   * changes no outcome.
   */
  report?: (message: string) => void;
};

/**
 * source: a factory (undefined — absent) or a probe of the page (probeIndexedDb). legacy: the page's localStorage as a
 * getter, read only by the upgrade import (§3) and by readLegacy (§5); a getter or storage that throws there fails closed.
 */
export function idbInstallationStore(source: IDBFactory | undefined | IndexedDbProbe, legacy: () => Storage,
  options: IdbStoreOptions = {}): IdbInstallationStore {
  const timeoutMs = options.timeoutMs ?? INSTALLATION_STORE_TIMEOUT_MS;
  const report = options.report ?? (message => console.warn(message));
  const probe: IndexedDbProbe = source === undefined ? { kind: "absent" }
    : "kind" in source && (source.kind === "present" || source.kind === "absent" || source.kind === "error") ? source as IndexedDbProbe
      : { kind: "present", factory: source as IDBFactory };
  const factory = probe.kind === "present" ? probe.factory : undefined;
  const safeReport = (message: string) => { try { report(message); } catch { /* a diagnostic changes no outcome */ } };

  let connection: Promise<Connection> | null = null;
  const connect = (): Promise<Connection> => {
    if (probe.kind === "absent") return Promise.resolve("missing");
    if (!factory) return Promise.resolve("api-error");
    // A closed connection (versionchange, closed by the browser) or a failed open is opened again by the next call.
    const opening = connection ?? openDatabase(factory, timeoutMs, legacy, () => { if (connection === opening) connection = null; });
    connection = opening;
    void opening.then(db => { if (typeof db !== "object" && connection === opening) connection = null; });
    return opening;
  };
  const notOpen = (db: Connection): { kind: "unsupported" } | { kind: "unavailable"; reason: "open-timeout" | "open-failed" | "api-error" } | null =>
    db === "missing" ? { kind: "unsupported" }
      : db === "api-error" ? { kind: "unavailable", reason: "api-error" }
        : db === "failed" ? { kind: "unavailable", reason: "open-failed" }
          : db === "timeout" ? { kind: "unavailable", reason: "open-timeout" } : null;

  return {
    async mutate<R, C extends string = string>(profileId: string, guardCurrent: () => boolean,
      reducer: (current: Installation | null) => InstallationDecision<R, C>,
      mutateOptions: { signal?: AbortSignal } = {}): Promise<MutateOutcome<R, C>> {
      const { signal } = mutateOptions;
      if (probe.kind === "absent") return { kind: "unsupported", reason: "no-indexeddb" };
      if (signal?.aborted || !guardCurrent()) return { kind: "cancelled", at: "before-lock" };
      const db = await connect();
      const closed = notOpen(db);
      if (closed) return closed.kind === "unsupported" ? { kind: "unsupported", reason: "no-indexeddb" } : closed;
      const open = db as IDBDatabase;
      const alive = () => !signal?.aborted && guardCurrent();
      if (!alive()) return { kind: "cancelled", at: "before-lock" };

      return new Promise<MutateOutcome<R, C>>((resolve, reject) => {
        let transaction: IDBTransaction | undefined;
        let stage: Stage = "queued";
        let cancel: Cancel | null = null;
        let thrown: { error: unknown } | null = null;
        let decided: { kind: "write"; record: Installation; result: R } | MutateOutcome<R, C> | null = null;
        let settled = false;
        // Every outcome settles the promise exactly once: an action that throws rejects instead of leaving it pending.
        // Only paths without a commit of a write may reject (§4: after a known commit only applied or late).
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onSignal);
          try { action(); } catch (error) { reject(error); }
        };
        // After complete the write is a fact: a guard that throws cannot confirm the context, so the commit is late.
        const liveAtCommit = (): boolean => {
          try { return alive(); } catch {
            safeReport(GUARD_AFTER_COMMIT);
            return false;
          }
        };
        // Asks the transaction to end; whether it did is told by its abort or complete event, not by this call.
        const end = (at: Cancel) => {
          try { transaction?.abort(); cancel = at; } catch { /* committing or finished: its event decides */ }
        };
        const onSignal = () => end(stage === "queued" ? "before-lock" : stage === "read" ? "before-write" : "before-commit");
        const timer = setTimeout(() => {
          try { transaction?.abort(); } catch { /* committing or finished */ }
          finish(() => resolve({ kind: "unknown" }));
        }, timeoutMs);
        signal?.addEventListener("abort", onSignal);
        try {
          transaction = open.transaction(INSTALLATION_STORE, "readwrite", { durability: "strict" });
          const tx = transaction;
          tx.oncomplete = () => {
            if (decided?.kind === "write") {
              // The write committed: never a rejection, whatever the guard or the report do.
              const { record, result } = decided;
              const live = liveAtCommit();
              finish(() => resolve(live ? { kind: "applied", record, result } : { kind: "late", record, result }));
              return;
            }
            finish(() => {
              if (thrown) { reject(thrown.error); return; }
              if (!decided) { resolve({ kind: "failed" }); return; }
              resolve(decided as MutateOutcome<R, C>);
            });
          };
          tx.onabort = () => finish(() => {
            if (thrown) reject(thrown.error);
            else resolve(cancel ? { kind: "cancelled", at: cancel } : { kind: "failed" });
          });
          const store = tx.objectStore(INSTALLATION_STORE);
          const read = store.get(profileId);
          read.onsuccess = () => {
            try {
              // The transaction runs: no other readwrite transaction of this store can commit until it ends.
              if (!alive()) { end("after-lock"); return; }
              const current = storedRecord(read.result, profileId);
              // Until a put is placed, an abort ends the transaction before any write (not before a commit of one).
              stage = "read";
              if (current === "invalid") { stage = "committing"; decided = { kind: "conflict", record: null, reason: "invalid" }; return; }
              const decision: unknown = reducer(current);
              if (isThenable(decision)) throw new TypeError("The installation reducer must be synchronous");
              const made = decision as Record<string, unknown>;
              if (typeof made !== "object" || made === null) throw new TypeError("Unknown installation decision");
              if ("conflict" in made) { stage = "committing"; decided = { kind: "conflict", record: current, reason: made.conflict as C }; return; }
              if (made.keep === true) { stage = "committing"; decided = { kind: "current", record: current, result: made.result as R }; return; }
              if (!("write" in made)) throw new TypeError("Unknown installation decision");
              // §2: exactly the six fields; a record with extras or of another profile is a program error, not a write.
              const written = strictInstallation(made.write, profileId);
              if (written === "invalid") throw new Error("Invalid installation");
              if (!alive()) { end("before-write"); return; }
              const put = tx.objectStore(INSTALLATION_STORE).put(written);
              stage = "placed";
              decided = { kind: "write", record: written, result: made.result as R };
              // After its success no request follows: the transaction commits on its own.
              put.onsuccess = () => { stage = "committing"; };
            } catch (error) {
              thrown = { error };
              try { tx.abort(); } catch { /* finished */ }
            }
          };
        } catch {
          try { transaction?.abort(); } catch { /* not started or finished */ }
          finish(() => resolve({ kind: "failed" }));
        }
      });
    },

    async read(profileId: string): Promise<InstallationRead> {
      const db = await connect();
      const closed = notOpen(db);
      if (closed) return closed;
      const open = db as IDBDatabase;
      return new Promise<InstallationRead>((resolve) => {
        let settled = false;
        const finish = (value: InstallationRead) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => finish({ kind: "unavailable", reason: "read-timeout" }), timeoutMs);
        try {
          const tx = open.transaction(INSTALLATION_STORE, "readonly");
          const request = tx.objectStore(INSTALLATION_STORE).get(profileId);
          tx.oncomplete = () => {
            const record = storedRecord(request.result, profileId);
            finish(record === "invalid" ? { kind: "invalid" } : { kind: "current", record });
          };
          tx.onabort = () => finish({ kind: "unavailable", reason: "read-failed" });
        } catch {
          finish({ kind: "unavailable", reason: "read-failed" });
        }
      });
    },

    async forget(profileId: string): Promise<ForgetOutcome> {
      const db = await connect();
      const closed = notOpen(db);
      if (closed) return closed;
      const open = db as IDBDatabase;
      const keys = [...new Set([profileId, profileId.toLowerCase()])];
      return new Promise<ForgetOutcome>((resolve) => {
        let settled = false;
        let transaction: IDBTransaction | undefined;
        let count = 0;
        const finish = (value: ForgetOutcome) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => {
          try { transaction?.abort(); } catch { /* committing or finished */ }
          finish({ kind: "unknown" }); // it may still commit: not "removed", not "nothing removed"
        }, timeoutMs);
        try {
          // The same store and mode as the writers: one place in their order (§6). Never clear(), never deleteDatabase.
          transaction = open.transaction(INSTALLATION_STORE, "readwrite", { durability: "strict" });
          const tx = transaction;
          tx.oncomplete = () => finish({ kind: "removed", count });
          tx.onabort = () => finish({ kind: "failed" });
          const store = tx.objectStore(INSTALLATION_STORE);
          for (const key of keys) {
            const request = store.get(key);
            request.onsuccess = () => {
              if (request.result === undefined) return;
              store.delete(key);
              count += 1;
            };
          }
        } catch {
          try { transaction?.abort(); } catch { /* not started or finished */ }
          finish({ kind: "failed" });
        }
      });
    },

    async readLegacy(profileId: string): Promise<LegacyRead> {
      // §5: only with the IndexedDB API reliably absent; a present API or a failing getter never falls back.
      if (probe.kind !== "absent") return { kind: "not-allowed" };
      let raw: string | null;
      try { raw = legacy().getItem(installationKey(profileId)); } catch { return { kind: "error" }; }
      if (raw === null) return { kind: "absent" };
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return { kind: "invalid" }; }
      const record = strictInstallation(value, profileId);
      if (record === "invalid") return { kind: "invalid" };
      return { kind: "found", record, openable: record.activated && record.proof !== null && record.proofVersion !== null };
    },
  };
}
