import type { ClientEvent } from "./events";

/**
 * Where the buffer of the client journal outlives the page: its own IndexedDB database, apart from the installation
 * database of the send budget (platform/indexedDb.ts), so the journal never needs a schema change there and a failure
 * here never touches a command. One record per admitted profile: its events, oldest first, and the count of events the
 * buffer removed since its last accepted batch.
 */
export const JOURNAL_DATABASE = "wortly_journal";
export const JOURNAL_DATABASE_VERSION = 1;
export const JOURNAL_STORE = "buffers";
/** Bound of one open or one transaction: the journal never waits on a WebView that does not answer. */
export const JOURNAL_STORE_TIMEOUT_MS = 5_000;

export type StoredBuffer = { profileId: string; events: ClientEvent[]; lost: number };

export interface JournalStore {
  load(profileId: string): Promise<StoredBuffer | null>;
  save(buffer: StoredBuffer): Promise<void>;
  /** Removes the buffer of every profile but this one (null: of all profiles). */
  keepOnly(profileId: string | null): Promise<void>;
}

export class JournalStoreError extends Error {
  constructor(public readonly reason: "missing" | "failed" | "timeout") { super(reason); }
}

function openDatabase(factory: IDBFactory | undefined, timeoutMs: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new JournalStoreError("missing")); return; }
    let settled = false;
    const fail = (reason: "failed" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new JournalStoreError(reason));
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    let request: IDBOpenDBRequest;
    try { request = factory.open(JOURNAL_DATABASE, JOURNAL_DATABASE_VERSION); } catch { fail("failed"); return; }
    request.onupgradeneeded = (event) => {
      try {
        if (event.oldVersion < 1) request.result.createObjectStore(JOURNAL_STORE, { keyPath: "profileId" });
      } catch { request.transaction?.abort(); }
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true;
      clearTimeout(timer);
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => fail("failed");
  });
}

/** The IndexedDB store; every operation is one transaction, bounded in time, and rejects on any failure. */
export class IdbJournalStore implements JournalStore {
  private constructor(private readonly db: IDBDatabase, private readonly timeoutMs: number) {}

  static async open(factory: IDBFactory | undefined = globalThis.indexedDB,
    timeoutMs: number = JOURNAL_STORE_TIMEOUT_MS): Promise<IdbJournalStore> {
    return new IdbJournalStore(await openDatabase(factory, timeoutMs), timeoutMs);
  }

  private transact<R>(mode: IDBTransactionMode, body: (store: IDBObjectStore, finish: (value: R) => void) => void): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      let transaction: IDBTransaction | undefined;
      let outcome: { value: R } | null = null;
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => settle(() => {
        try { transaction?.abort(); } catch { /* already finished */ }
        reject(new JournalStoreError("timeout"));
      }), this.timeoutMs);
      try {
        transaction = this.db.transaction(JOURNAL_STORE, mode);
        transaction.oncomplete = () => settle(() => outcome ? resolve(outcome.value) : reject(new JournalStoreError("failed")));
        transaction.onabort = () => settle(() => reject(new JournalStoreError("failed")));
        body(transaction.objectStore(JOURNAL_STORE), value => { outcome = { value }; });
      } catch {
        try { transaction?.abort(); } catch { /* not started or already finished */ }
        settle(() => reject(new JournalStoreError("failed")));
      }
    });
  }

  load(profileId: string): Promise<StoredBuffer | null> {
    return this.transact<StoredBuffer | null>("readonly", (store, finish) => {
      const request = store.get(profileId);
      request.onsuccess = () => finish(storedBuffer(request.result, profileId));
    });
  }
  save(buffer: StoredBuffer): Promise<void> {
    const copy: StoredBuffer = { profileId: buffer.profileId, events: buffer.events.map(event => ({ ...event })), lost: buffer.lost };
    return this.transact<void>("readwrite", (store, finish) => {
      const request = store.put(copy);
      request.onsuccess = () => finish(undefined);
    });
  }
  keepOnly(profileId: string | null): Promise<void> {
    return this.transact<void>("readwrite", (store, finish) => {
      const request = store.getAllKeys();
      request.onsuccess = () => {
        for (const key of request.result) if (key !== profileId) store.delete(key);
        finish(undefined);
      };
    });
  }
}

/** A stored record read back: anything that is not a buffer of this profile is no buffer at all. */
function storedBuffer(value: unknown, profileId: string): StoredBuffer | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.profileId !== profileId || !Array.isArray(record.events)) return null;
  const lost = typeof record.lost === "number" && Number.isSafeInteger(record.lost) && record.lost >= 0 ? record.lost : 0;
  return { profileId, events: record.events as ClientEvent[], lost };
}
