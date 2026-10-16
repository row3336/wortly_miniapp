// The Web Locks of ONE browser profile, shared by several windows (jsdom has no navigator.locks). Each window takes
// its own view (context(name)); every view queues on the same names, as windows of one origin do. Exclusive locks are
// granted in request order, one holder per name, the callback runs asynchronously after the grant (as in a browser),
// and the lock is held until the callback's result settles. signal, ifAvailable and steal follow the Web Locks spec;
// shared mode is not modelled (no writer of this app asks for it). destroy() ends a window: its held locks are released
// and its queued requests dropped, as when a page is closed or crashes.

type Waiter = {
  context: string;
  name: string;
  callback: LockGrantedCallback<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};
type Held = { context: string; waiter: Waiter; lost: boolean };

export type TestLocks = {
  /** navigator.locks of the window `context`. */
  context(context: string): LockManager;
  /** Closes the window `context` (page gone): its locks are released, its waiters never granted. */
  destroy(context: string): void;
  /** Holds `name` for the window `context` until release() — another window's critical section in progress. */
  hold(context: string, name: string): Promise<{ release(): void }>;
  holder(name: string): string | null;
  waiting(name: string): string[];
  /** Every request as it was made, for checks of names and options. */
  requests: { context: string; name: string; options: LockOptions }[];
};

function abortError(): DOMException {
  return new DOMException("The request was aborted", "AbortError");
}

export function testLocks(): TestLocks {
  const held = new Map<string, Held>();
  const queues = new Map<string, Waiter[]>();
  const destroyed = new Set<string>();
  const requests: TestLocks["requests"] = [];

  const queue = (name: string) => {
    let list = queues.get(name);
    if (!list) { list = []; queues.set(name, list); }
    return list;
  };

  const run = (waiter: Waiter) => {
    const entry: Held = { context: waiter.context, waiter, lost: false };
    held.set(waiter.name, entry);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    // The browser runs the callback in a later task, not inside request().
    void Promise.resolve().then(async () => {
      if (entry.lost) return;
      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
      try {
        outcome = { ok: true, value: await waiter.callback({ name: waiter.name, mode: "exclusive" } as Lock) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      if (entry.lost) return; // stolen or the window is gone: its promise was already settled
      if (held.get(waiter.name) === entry) held.delete(waiter.name);
      if (outcome.ok) waiter.resolve(outcome.value); else waiter.reject(outcome.error);
      grant(waiter.name);
    });
  };

  const grant = (name: string) => {
    if (held.has(name)) return;
    const next = queue(name).shift();
    if (next) run(next);
  };

  const manager = (context: string): LockManager => ({
    request(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<unknown>, maybeCallback?: LockGrantedCallback<unknown>) {
      const options: LockOptions = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
      const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback)!;
      requests.push({ context, name, options });
      return new Promise<unknown>((resolve, reject) => {
        if (destroyed.has(context)) { reject(new DOMException("The document is not fully active", "InvalidStateError")); return; }
        if ((options.mode ?? "exclusive") !== "exclusive") { reject(new DOMException("shared mode is not modelled", "NotSupportedError")); return; }
        if (options.signal?.aborted) { reject(abortError()); return; }
        const waiter: Waiter = { context, name, callback, resolve, reject, signal: options.signal };
        if (options.steal) {
          const current = held.get(name);
          if (current) { current.lost = true; held.delete(name); current.waiter.reject(abortError()); }
          run(waiter);
          return;
        }
        if (options.ifAvailable && (held.has(name) || queue(name).length > 0)) {
          void Promise.resolve().then(async () => {
            try { resolve(await callback(null)); } catch (error) { reject(error); }
          });
          return;
        }
        if (options.signal) {
          waiter.onAbort = () => {
            const list = queue(name), index = list.indexOf(waiter);
            if (index >= 0) { list.splice(index, 1); reject(abortError()); }
          };
          options.signal.addEventListener("abort", waiter.onAbort);
        }
        queue(name).push(waiter);
        grant(name);
      }) as never;
    },
    async query() {
      return {
        held: [...held.entries()].map(([name, entry]) => ({ name, mode: "exclusive" as LockMode, clientId: entry.context })),
        pending: [...queues.entries()].flatMap(([name, list]) =>
          list.map(waiter => ({ name, mode: "exclusive" as LockMode, clientId: waiter.context }))),
      };
    },
  } as LockManager);

  return {
    context: manager,
    destroy(context) {
      destroyed.add(context);
      for (const [name, list] of queues) queues.set(name, list.filter(waiter => waiter.context !== context));
      for (const [name, entry] of [...held.entries()]) {
        if (entry.context !== context) continue;
        entry.lost = true;
        held.delete(name);
        grant(name);
      }
    },
    async hold(context, name) {
      let release!: () => void;
      const done = new Promise<void>(resolve => { release = resolve; });
      let granted!: () => void;
      const ready = new Promise<void>(resolve => { granted = resolve; });
      void manager(context).request(name, { mode: "exclusive" }, async () => { granted(); await done; }).catch(() => {});
      await ready;
      return { release };
    },
    holder: name => held.get(name)?.context ?? null,
    waiting: name => queue(name).map(waiter => waiter.context),
    requests,
  };
}

/** A Storage of one origin shared by the windows (localStorage), with hooks to make its calls fail or watch them. */
export function sharedStorage() {
  const map = new Map<string, string>();
  const log: string[] = [];
  const faults = { get: null as Error | null, set: null as Error | null };
  // afterGet runs inside getItem, after the value was taken: another process (an old page that ignores the lock)
  // writing between this window's read and its write.
  const watchers: { set: ((key: string, value: string) => void)[]; afterGet: ((key: string) => void)[] } = { set: [], afterGet: [] };
  const storage: Storage = {
    getItem(key) {
      log.push(`get ${key}`);
      if (faults.get) throw faults.get;
      const value = map.has(key) ? map.get(key)! : null;
      for (const watch of watchers.afterGet) watch(key);
      return value;
    },
    setItem(key, value) {
      log.push(`set ${key}`);
      if (faults.set) throw faults.set;
      map.set(key, String(value));
      for (const watch of watchers.set) watch(key, String(value));
    },
    removeItem(key) { log.push(`remove ${key}`); map.delete(key); },
    clear() { map.clear(); },
    key(index) { return [...map.keys()][index] ?? null; },
    get length() { return map.size; },
  };
  return { storage, map, log, faults, watchers };
}
