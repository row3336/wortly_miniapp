import type { FakeIndexedDb } from "../commands/idbFake.test-support";

// A stricter view of the IndexedDB double (commands/idbFake.test-support.ts) for the installation store prototype.
// The double lets abort() end a transaction until the very moment of its commit; the spec does not: once the last
// request's success callback has returned and nothing new was placed, the transaction is committing and abort() throws
// InvalidStateError. This view refuses abort() from that moment, so a test can show the late commit that no abort can
// stop any more. Everything else goes to the double unchanged.

export function committingRefusesAbort(factory: IDBFactory): IDBFactory {
  const wrapTransaction = (tx: IDBTransaction): IDBTransaction => {
    let pending = 0;
    let committing = false;
    const track = (request: IDBRequest): IDBRequest => {
      pending += 1;
      let inner: ((event: Event) => unknown) | null = null;
      // The double calls request.onsuccess?.(event): the caller's handler runs, then the transaction is committing
      // if that was its last request and the handler placed no new one.
      Object.defineProperty(request, "onsuccess", {
        configurable: true,
        get: () => (event: Event) => {
          inner?.call(request, event);
          pending -= 1;
          if (pending === 0) committing = true;
        },
        set: (handler) => { inner = handler; },
      });
      return request;
    };
    const wrapStore = (store: IDBObjectStore): IDBObjectStore => new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "get" || property === "put" || property === "add" || property === "delete") {
          return (...args: unknown[]) => track((value as (...a: unknown[]) => IDBRequest).apply(target, args));
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return new Proxy(tx, {
      get(target, property) {
        if (property === "abort") {
          return () => {
            if (committing) throw new DOMException("The transaction is committing", "InvalidStateError");
            target.abort();
          };
        }
        if (property === "objectStore") return (name: string) => wrapStore(target.objectStore(name));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value) { return Reflect.set(target, property, value); },
    });
  };
  const wrapDatabase = (db: IDBDatabase): IDBDatabase => new Proxy(db, {
    get(target, property) {
      if (property === "transaction") {
        return (...args: Parameters<IDBDatabase["transaction"]>) => wrapTransaction(target.transaction(...args));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) { return Reflect.set(target, property, value); },
  });
  return {
    open(name: string, version?: number) {
      const request = factory.open(name, version);
      return new Proxy(request, {
        get(target, property) {
          if (property === "result") {
            const db = Reflect.get(target, property) as IDBDatabase | undefined;
            return db ? wrapDatabase(db) : db;
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, property, value) { return Reflect.set(target, property, value); },
      });
    },
  } as IDBFactory;
}


/**
 * The double's upgrade creates a store but returns nothing to write with, and has no requests in the versionchange
 * transaction. This view gives createObjectStore a store whose put writes the row straight into the database being
 * upgraded: the double restores the stores of before the upgrade when it aborts, so an aborted upgrade keeps no row —
 * as the versionchange transaction of a browser. putLog records what the upgrade put. A put of a value without its key
 * throws DataError, as a browser rejects it.
 */
export function upgradeWrites(fake: FakeIndexedDb, putLog: unknown[] = []): IDBFactory {
  return {
    open(name: string, version?: number) {
      const request = fake.factory.open(name, version);
      const wrapDb = (db: IDBDatabase): IDBDatabase => new Proxy(db, {
        get(target, property) {
          if (property === "createObjectStore") {
            return (store: string, options: { keyPath: string }) => {
              (target.createObjectStore as unknown as (n: string, o: { keyPath: string }) => void).call(target, store, options);
              return {
                put(value: Record<string, unknown>) {
                  const key = value?.[options.keyPath];
                  if (typeof key !== "string" && typeof key !== "number") throw new DOMException("DataError", "DataError");
                  putLog.push(structuredClone(value));
                  fake.seed(name, store, key, value);
                  return {};
                },
              };
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, property, value) { return Reflect.set(target, property, value); },
      });
      return new Proxy(request, {
        get(target, property) {
          if (property === "result") {
            const db = Reflect.get(target, property) as IDBDatabase | undefined;
            return db ? wrapDb(db) : db;
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, property, value) { return Reflect.set(target, property, value); },
      });
    },
  } as IDBFactory;
}
