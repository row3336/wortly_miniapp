/**
 * The installation database of the Mini App (owner answer Е01, C040: IndexedDB holds command IDs and the send budget,
 * never answer text). Version 1 has one store, the send budget records keyed by commandId. A later schema is a new
 * version with its own migration; an open connection closes on versionchange so that a newer window is not blocked.
 */
export const WORTLY_DATABASE = "wortly";
export const WORTLY_DATABASE_VERSION = 1;
export const SEND_BUDGET_STORE = "send_budget";

/** "missing": no IndexedDB in this WebView; "failed": open refused (blocked storage, newer version, upgrade error). */
export class DatabaseOpenError extends Error {
  constructor(public readonly reason: "missing" | "failed" | "timeout") { super(reason); }
}

function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) db.createObjectStore(SEND_BUDGET_STORE, { keyPath: "commandId" });
}

/**
 * Opens the database or rejects with DatabaseOpenError. A WebView may leave the open request unanswered, so it is
 * bounded by timeoutMs; a connection that arrives after the limit is closed at once. onClosed reports that the
 * connection is gone (versionchange or closed by the browser): later transactions must not be attempted on it.
 */
export function openWortlyDatabase(factory: IDBFactory | undefined, timeoutMs: number, onClosed: () => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!factory) { reject(new DatabaseOpenError("missing")); return; }
    let settled = false;
    const fail = (reason: "failed" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new DatabaseOpenError(reason));
    };
    const timer = setTimeout(() => fail("timeout"), timeoutMs);
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(WORTLY_DATABASE, WORTLY_DATABASE_VERSION);
    } catch {
      fail("failed");
      return;
    }
    request.onupgradeneeded = (event) => {
      try {
        upgrade(request.result, event.oldVersion);
      } catch {
        request.transaction?.abort();
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
    request.onerror = () => fail("failed");
  });
}
