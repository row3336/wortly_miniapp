/**
 * A small IndexedDB double for tests (jsdom has none, and no new dependency is installed: D-CP5 RD 7.9). It covers what
 * the send budget adapter uses: open with an upgrade, one object store with an inline key, get / getAll / add / put /
 * delete, readwrite and readonly transactions, auto-commit, complete / error / abort events.
 *
 * Deliberately strict where the adapter's guarantees live:
 * - transactions of a database run strictly one after another, in creation order, across all connections;
 * - writes go to a copy that becomes visible only at commit, an abort discards it;
 * - a transaction is active only while it is being created and inside its request callbacks: a request placed after an
 *   await throws TransactionInactiveError, as a browser does once control has gone back to the event loop;
 * - every transaction is logged (mode, durability, requests, outcome).
 *
 * It proves only the adapter's use of the API, not the behaviour of a real WebView (D-CP5 2.4, 5.5: devices Д1–Д13).
 * Everything runs on microtasks, so tests on fake timers drive only the adapter's own limits.
 */

export type FakeTransactionEntry = {
  id: number;
  mode: IDBTransactionMode;
  durability: string;
  requests: string[];
  outcome: "pending" | "complete" | "abort";
};
/** What the next transaction does instead of a normal commit. */
export type FakeTransactionFault = "abort_on_commit" | "hang" | "throw_on_create";
export type FakeOpenBehaviour = "normal" | "hang" | "error" | "throw";

type FakeEvent = {
  type: string;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  oldVersion?: number;
  newVersion?: number;
};
type Handler = ((event: FakeEvent) => void) | null;

function event(type: string, extra: Partial<FakeEvent> = {}): FakeEvent {
  const value: FakeEvent = {
    type, defaultPrevented: false,
    preventDefault() { value.defaultPrevented = true; },
    stopPropagation() { /* nothing above the transaction listens in these tests */ },
    ...extra,
  };
  return value;
}
function domError(name: string): DOMException {
  return new DOMException(name, name);
}
const tick = () => Promise.resolve();

/** Keys the double accepts: strings and numbers, ordered as IndexedDB does (numbers before strings). */
type FakeKey = string | number;
type StoreData = { keyPath: string; rows: Map<FakeKey, unknown> };
function compareKeys(left: FakeKey, right: FakeKey): number {
  if (typeof left !== typeof right) return typeof left === "number" ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
type DatabaseData = { version: number; stores: Map<string, StoreData> };

function cloneStores(stores: Map<string, StoreData>): Map<string, StoreData> {
  return new Map([...stores].map(([name, store]) => [name, { keyPath: store.keyPath, rows: new Map(store.rows) }]));
}

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
}

type Pending = { request: FakeRequest; label: string; run: (stores: Map<string, StoreData>) => unknown };

class FakeObjectStore {
  constructor(private readonly transaction: FakeTransaction, private readonly name: string) {}

  private place(label: string, run: (store: StoreData) => unknown): FakeRequest {
    return this.transaction.place(label, stores => run(stores.get(this.name)!));
  }
  private key(store: StoreData, value: unknown): FakeKey {
    const key = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[store.keyPath] : undefined;
    if (typeof key !== "string" && !(typeof key === "number" && Number.isFinite(key))) throw domError("DataError");
    return key;
  }
  get(key: FakeKey): FakeRequest {
    return this.place("get", store => structuredClone(store.rows.get(key)));
  }
  getAllKeys(): FakeRequest {
    return this.place("getAllKeys", store => [...store.rows.keys()].sort(compareKeys));
  }
  getAll(): FakeRequest {
    return this.place("getAll", store => [...store.rows.keys()].sort(compareKeys).map(key => structuredClone(store.rows.get(key))));
  }
  add(value: unknown): FakeRequest {
    const copy = structuredClone(value);
    return this.place("add", store => {
      const key = this.key(store, copy);
      if (store.rows.has(key)) throw domError("ConstraintError");
      store.rows.set(key, copy);
      return key;
    });
  }
  put(value: unknown): FakeRequest {
    const copy = structuredClone(value);
    return this.place("put", store => {
      const key = this.key(store, copy);
      store.rows.set(key, copy);
      return key;
    });
  }
  delete(key: FakeKey): FakeRequest {
    return this.place("delete", store => { store.rows.delete(key); return undefined; });
  }
}

class FakeTransaction {
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  active = true;
  state: "queued" | "running" | "done" = "queued";
  readonly requests: Pending[] = [];
  staging: Map<string, StoreData> | null = null;

  constructor(
    readonly owner: FakeIndexedDb,
    readonly database: string,
    readonly entry: FakeTransactionEntry,
    readonly storeNames: string[],
    readonly fault: FakeTransactionFault | undefined,
  ) {}

  get mode(): IDBTransactionMode { return this.entry.mode; }
  get durability(): string { return this.entry.durability; }

  objectStore(name: string): FakeObjectStore {
    if (this.state === "done") throw domError("InvalidStateError");
    if (!this.storeNames.includes(name)) throw domError("NotFoundError");
    return new FakeObjectStore(this, name);
  }
  place(label: string, run: (stores: Map<string, StoreData>) => unknown): FakeRequest {
    if (!this.active || this.state === "done") throw domError("TransactionInactiveError");
    if (this.mode === "readonly" && label !== "get" && label !== "getAll" && label !== "getAllKeys") throw domError("ReadOnlyError");
    const request = new FakeRequest();
    this.entry.requests.push(label);
    this.requests.push({ request, label, run });
    return request;
  }
  abort(): void {
    if (this.state === "done") throw domError("InvalidStateError");
    this.finishAbort(null);
  }
  finishAbort(error: DOMException | null): void {
    if (this.state === "done") return;
    const wasRunning = this.state === "running";
    this.state = "done";
    this.staging = null;
    this.error = error;
    this.entry.outcome = "abort";
    this.owner.settled(this, wasRunning);
    void tick().then(() => {
      if (error) this.onerror?.(event("error"));
      this.onabort?.(event("abort"));
    });
  }
}

class FakeDatabase {
  onversionchange: Handler = null;
  onclose: Handler = null;
  closed = false;
  upgrading = false;

  constructor(private readonly owner: FakeIndexedDb, readonly name: string, readonly version: number) {}

  get objectStoreNames(): { contains(name: string): boolean } {
    const stores = this.owner.database(this.name).stores;
    return { contains: (name: string) => stores.has(name) };
  }
  createObjectStore(name: string, options: { keyPath: string }): void {
    if (!this.upgrading) throw domError("InvalidStateError");
    this.owner.database(this.name).stores.set(name, { keyPath: options.keyPath, rows: new Map() });
  }
  transaction(names: string | string[], mode: IDBTransactionMode = "readonly",
    options?: { durability?: string }): FakeTransaction {
    if (this.closed) throw domError("InvalidStateError");
    return this.owner.createTransaction(this.name, typeof names === "string" ? [names] : names, mode,
      options?.durability ?? "default");
  }
  close(): void {
    this.closed = true;
  }
}

/** The double: pass `factory` where an IDBFactory is expected. */
export class FakeIndexedDb {
  readonly log: FakeTransactionEntry[] = [];
  readonly connections: FakeDatabase[] = [];
  openBehaviour: FakeOpenBehaviour = "normal";
  private readonly databases = new Map<string, DatabaseData>();
  private readonly queue: FakeTransaction[] = [];
  private running: FakeTransaction | null = null;
  private readonly faults: FakeTransactionFault[] = [];
  private gate: Promise<void> | null = null;
  private readonly hungOpens: Array<() => void> = [];
  private nextId = 1;

  readonly factory: IDBFactory = { open: (name: string, version?: number) => this.open(name, version ?? 1) } as unknown as IDBFactory;

  database(name: string): DatabaseData {
    let data = this.databases.get(name);
    if (!data) { data = { version: 0, stores: new Map() }; this.databases.set(name, data); }
    return data;
  }

  /** The next transactions, in order, fail this way instead of committing normally. */
  failNext(...faults: FakeTransactionFault[]): void {
    this.faults.push(...faults);
  }
  /** Commits wait until the returned function is called: a result before it would not be backed by complete. */
  holdCommits(): () => void {
    let release!: () => void;
    this.gate = new Promise(resolve => { release = resolve; });
    return () => { this.gate = null; release(); };
  }
  /** Lets opens that were left hanging (openBehaviour "hang") go on as normal opens. */
  finishHungOpens(): void {
    this.openBehaviour = "normal";
    this.hungOpens.splice(0).forEach(resume => resume());
  }
  /** A newer window asks for a new version: every open connection receives versionchange. */
  requestVersionChange(): void {
    this.connections.filter(db => !db.closed).forEach(db => db.onversionchange?.(event("versionchange")));
  }
  /** The browser closes the connections on its own (storage cleared, quota). */
  closeByBrowser(): void {
    this.connections.filter(db => !db.closed).forEach(db => { db.closed = true; db.onclose?.(event("close")); });
  }
  /** Test access to committed rows. */
  rows(database: string, store: string): Map<FakeKey, unknown> {
    return new Map([...(this.database(database).stores.get(store)?.rows ?? new Map())].map(([key, value]) => [key, structuredClone(value)]));
  }
  seed(database: string, store: string, key: FakeKey, value: unknown): void {
    this.database(database).stores.get(store)!.rows.set(key, structuredClone(value));
  }

  private open(name: string, version: number): FakeRequest & { onupgradeneeded: Handler; onblocked: Handler; transaction: { abort(): void } | null } {
    if (this.openBehaviour === "throw") throw domError("SecurityError");
    const request = Object.assign(new FakeRequest(), { onupgradeneeded: null as Handler, onblocked: null as Handler,
      transaction: null as { abort(): void } | null });
    const proceed = () => void tick().then(() => this.answerOpen(request, name, version));
    if (this.openBehaviour === "hang") this.hungOpens.push(proceed);
    else proceed();
    return request;
  }

  private answerOpen(request: FakeRequest & { onupgradeneeded: Handler; transaction: { abort(): void } | null },
    name: string, version: number): void {
    if (this.openBehaviour === "error") {
      request.error = domError("UnknownError");
      request.onerror?.(event("error"));
      return;
    }
    const data = this.database(name);
    if (version < data.version) {
      request.error = domError("VersionError");
      request.onerror?.(event("error"));
      return;
    }
    const db = new FakeDatabase(this, name, version);
    request.result = db;
    if (version > data.version) {
      const before = cloneStores(data.stores);
      let aborted = false;
      request.transaction = { abort: () => { aborted = true; } };
      db.upgrading = true;
      try {
        request.onupgradeneeded?.(event("upgradeneeded", { oldVersion: data.version, newVersion: version }));
      } catch {
        aborted = true;
      }
      db.upgrading = false;
      request.transaction = null;
      if (aborted) {
        data.stores = before;
        request.result = undefined;
        request.error = domError("AbortError");
        request.onerror?.(event("error"));
        return;
      }
      data.version = version;
    }
    this.connections.push(db);
    request.onsuccess?.(event("success"));
  }

  createTransaction(database: string, names: string[], mode: IDBTransactionMode, durability: string): FakeTransaction {
    const stores = this.database(database).stores;
    if (names.some(name => !stores.has(name))) throw domError("NotFoundError");
    const fault = this.faults.shift();
    if (fault === "throw_on_create") throw domError("InvalidStateError");
    const entry: FakeTransactionEntry = { id: this.nextId++, mode, durability, requests: [], outcome: "pending" };
    this.log.push(entry);
    const transaction = new FakeTransaction(this, database, entry, names, fault);
    this.queue.push(transaction);
    // Active for the script that created it; inactive once that script yields.
    queueMicrotask(() => {
      transaction.active = false;
      this.pump();
    });
    return transaction;
  }

  settled(transaction: FakeTransaction, wasRunning: boolean): void {
    const index = this.queue.indexOf(transaction);
    if (index >= 0) this.queue.splice(index, 1);
    if (wasRunning && this.running === transaction) this.running = null;
    void tick().then(() => this.pump());
  }

  private pump(): void {
    if (this.running) return;
    const next = this.queue.find(transaction => transaction.state === "queued");
    if (!next || next.active) return;
    this.running = next;
    next.state = "running";
    next.staging = cloneStores(this.database(next.database).stores);
    void this.drive(next);
  }

  private async drive(transaction: FakeTransaction): Promise<void> {
    while (transaction.state === "running" && transaction.requests.length > 0) {
      const { request, run } = transaction.requests.shift()!;
      await tick();
      if (transaction.state !== "running") return;
      let failure: DOMException | null = null;
      try {
        request.result = run(transaction.staging!);
      } catch (error) {
        failure = error instanceof DOMException ? error : domError("UnknownError");
      }
      transaction.active = true;
      if (failure) {
        request.error = failure;
        const failed = event("error");
        try { request.onerror?.(failed); } finally { transaction.active = false; }
        if (!failed.defaultPrevented) { transaction.finishAbort(failure); return; }
      } else {
        try { request.onsuccess?.(event("success")); } catch { transaction.active = false; transaction.finishAbort(domError("AbortError")); return; }
        transaction.active = false;
      }
    }
    if (transaction.state !== "running") return;
    await this.commit(transaction);
  }

  private async commit(transaction: FakeTransaction): Promise<void> {
    if (transaction.fault === "hang") return;
    while (this.gate) await this.gate;
    await tick();
    if (transaction.state !== "running") return;
    if (transaction.fault === "abort_on_commit") { transaction.finishAbort(domError("UnknownError")); return; }
    this.database(transaction.database).stores = transaction.staging!;
    transaction.state = "done";
    transaction.staging = null;
    transaction.entry.outcome = "complete";
    this.settled(transaction, true);
    transaction.oncomplete?.(event("complete"));
  }
}
