import { describe, expect, it, vi } from "vitest";
import { browserStorage } from "../platform/storage";
import type { AsyncStorage } from "../platform/storage";
import { browserDocumentLock } from "./documentLock";
import { newerVersion, readInstallation, writeInstallation } from "./installation";
import type { Installation } from "./installation";
import { installationKey } from "./installationStore";
import { browserInstallationStore, installationLockName, parseInstallation } from "./installationStoreLs.test-support";
import type { InstallationDecision, InstallationStore } from "./installationStore";
import { sharedStorage, testLocks } from "./webLocks.test-support";

const P = "profile-1";
const KEY = installationKey(P);
const LOCK = installationLockName(P);

function record(clientInstanceId: string, more: Partial<Installation> = {}): Installation {
  return { profileId: P, clientInstanceId, registrationId: `reg-${clientInstanceId}`, proof: null, proofVersion: null,
    activated: false, ...more };
}

/** Two windows of one browser profile: one localStorage, one lock manager, each window its own adapter and context. */
function browser() {
  const s = sharedStorage();
  const locks = testLocks();
  const window = (name: string): InstallationStore => browserInstallationStore(s.storage, locks.context(name));
  return { ...s, locks, window, stored: () => parseInstallation(s.map.get(KEY) ?? null, P), put: (value: Installation) => {
    s.map.set(installationKey(value.profileId), JSON.stringify(value));
  } };
}

/** The live context of a writer as Entry holds it; the guard reads all of it at the moment it is called. */
function context() {
  const live = { generation: 1, expected: 1, disposed: false, closed: false, replaced: false, profileId: P };
  return { live, guard: () => live.generation === live.expected && !live.disposed && !live.closed && !live.replaced
    && live.profileId === P };
}

// Model reducers of the four writers (C405) — only to show that the capability carries their rules over the ACTUAL
// record. The product reducers are written by the integration (C163 author) in entryController, not here.
const prepareA = (fresh: Installation) => (current: Installation | null): InstallationDecision<"reused" | "created"> =>
  current?.proof && current.proofVersion ? { keep: true, result: "reused" } : { write: fresh, result: "created" };
const prepareB = (expectedA: Installation, fresh: Installation) =>
  (current: Installation | null): InstallationDecision<"created", "foreign" | "newer"> => {
    if (current && JSON.stringify(current) !== JSON.stringify(expectedA)) {
      return { conflict: current.clientInstanceId === expectedA.clientInstanceId ? "newer" : "foreign" };
    }
    return { write: fresh, result: "created" };
  };
const registerResult = (sent: { clientInstanceId: string; registrationId: string }, proof: string, version: string) =>
  (current: Installation | null): InstallationDecision<"older" | "same" | "stored", "other-installation" | "proof-mismatch"> => {
    if (!current || current.clientInstanceId !== sent.clientInstanceId || current.registrationId !== sent.registrationId) {
      return { conflict: "other-installation" };
    }
    if (current.proofVersion && newerVersion(current.proofVersion, version)) return { keep: true, result: "older" };
    if (current.proofVersion === version) return current.proof === proof ? { keep: true, result: "same" } : { conflict: "proof-mismatch" };
    return { write: { ...current, proof, proofVersion: version }, result: "stored" };
  };
const activated = (clientInstanceId: string, proofVersion: string) =>
  (current: Installation | null): InstallationDecision<"activated", "other-installation"> => {
    if (!current || current.clientInstanceId !== clientInstanceId || current.proofVersion !== proofVersion) {
      return { conflict: "other-installation" };
    }
    return current.activated ? { keep: true, result: "activated" } : { write: { ...current, activated: true }, result: "activated" };
  };

describe("installation store: the lock and the record", () => {
  it("takes a short exclusive lock of the profile: never steal, never ifAvailable, not the document lock's name", async () => {
    const b = browser();
    const result = await b.window("w1").mutate(P, () => true, prepareA(record("a")));
    expect(result).toEqual({ kind: "applied", record: record("a"), result: "created" });
    expect(b.locks.requests).toEqual([{ context: "w1", name: "wortly-installation-store:profile-1", options: { mode: "exclusive" } }]);
    expect(LOCK.startsWith("wortly-document:")).toBe(false);
    expect(b.locks.holder(LOCK)).toBeNull(); // released right after the synchronous section
  });

  it("writes under the record's existing key: the 79 reader reads the same record, the store reads a 79 record", async () => {
    const b = browser();
    await b.window("w1").mutate(P, () => true, prepareA(record("a", { proof: "p", proofVersion: "3" })));
    expect(await readInstallation(browserStorage(b.storage), P)).toEqual(record("a", { proof: "p", proofVersion: "3" }));
    await writeInstallation(browserStorage(b.storage), record("old", { activated: true, proof: "q", proofVersion: "9" }));
    expect(await b.window("w2").read(P)).toEqual({ kind: "current", record: record("old", { activated: true, proof: "q", proofVersion: "9" }) });
  });

  it("parses exactly what readInstallation accepts", async () => {
    const values: (string | null)[] = [null, "", "{", "null", "1", "[]", "\"x\"", JSON.stringify(record("a")),
      JSON.stringify({ ...record("a"), profileId: "other" }), JSON.stringify({ ...record("a"), proofVersion: "0" }),
      JSON.stringify({ ...record("a"), proofVersion: "01" }), JSON.stringify({ ...record("a"), proofVersion: "1".repeat(20) }),
      JSON.stringify({ ...record("a"), proof: "p", proofVersion: "1".repeat(19) }), JSON.stringify({ ...record("a"), activated: "true" }),
      JSON.stringify({ ...record("a"), proof: 5 }), JSON.stringify({ ...record("a"), registrationId: null }),
      JSON.stringify({ ...record("a"), clientInstanceId: 1 }), JSON.stringify({ ...record("a"), extra: "kept" })];
    for (const raw of values) {
      const storage: AsyncStorage = { get: async () => raw, set: async () => {}, remove: async () => {} };
      const old = await readInstallation(storage, P).then(value => value, () => "invalid" as const);
      expect(parseInstallation(raw, P)).toEqual(old);
    }
  });

  it("keep and conflict write nothing; an invalid stored record is a conflict \"invalid\": no reducer, not overwritten", async () => {
    const b = browser();
    b.put(record("a", { proof: "p", proofVersion: "1" }));
    expect(await b.window("w1").mutate(P, () => true, () => ({ keep: true, result: 1 }))).toEqual({ kind: "current", record: record("a", { proof: "p", proofVersion: "1" }), result: 1 });
    expect(await b.window("w1").mutate(P, () => true, () => ({ conflict: "x" })))
      .toEqual({ kind: "conflict", reason: "x", record: record("a", { proof: "p", proofVersion: "1" }) });
    b.map.set(KEY, "{not json");
    const reducer = vi.fn(() => ({ write: record("b"), result: 0 }) as const);
    expect(await b.window("w1").mutate(P, () => true, reducer)).toEqual({ kind: "conflict", record: null, reason: "invalid" });
    expect(reducer).not.toHaveBeenCalled();
    expect(b.log.filter(line => line.startsWith("set"))).toEqual([]);
    expect(b.map.get(KEY)).toBe("{not json");
  });

  it("read needs no lock and writes nothing: current (also null), invalid, unsupported", async () => {
    const s = sharedStorage();
    const store = browserInstallationStore(s.storage, undefined);
    expect(await store.read(P)).toEqual({ kind: "current", record: null });
    s.map.set(KEY, JSON.stringify(record("a")));
    expect(await store.read(P)).toEqual({ kind: "current", record: record("a") });
    s.map.set(KEY, JSON.stringify({ ...record("a"), profileId: "other" }));
    expect(await store.read(P)).toEqual({ kind: "invalid" });
    s.faults.get = new DOMException("blocked", "SecurityError");
    expect(await store.read(P)).toEqual({ kind: "unsupported" });
    expect(s.log.filter(line => !line.startsWith("get"))).toEqual([]);
  });
});

describe("installation store: two windows on one storage and one lock manager", () => {
  it("prepare A in two windows at once ends with ONE installation: the second reads the first one's record", async () => {
    const b = browser();
    const proofA = record("a1", { proof: "p1", proofVersion: "1" });
    const [one, two] = await Promise.all([
      b.window("w1").mutate(P, () => true, prepareA(proofA)),
      b.window("w2").mutate(P, () => true, prepareA(record("a2"))),
    ]);
    expect(one).toEqual({ kind: "applied", record: proofA, result: "created" });
    expect(two).toEqual({ kind: "current", record: proofA, result: "reused" });
    expect(b.stored()).toEqual(proofA);
  });

  it("the old read → await set of 79 lets the second window overwrite the first one (the defect this replaces)", async () => {
    const b = browser();
    const old = browserStorage(b.storage);
    const prepare = async (fresh: Installation) => {
      const stored = await readInstallation(old, P);
      if (stored?.proof && stored.proofVersion) return stored;
      await writeInstallation(old, fresh);
      return fresh;
    };
    b.put(record("pending"));
    const [one, two] = await Promise.all([prepare(record("a1")), prepare(record("a2"))]);
    expect(one.clientInstanceId).toBe("a1");
    expect(two.clientInstanceId).toBe("a2");
    expect(b.stored()).toEqual(record("a2")); // window 1 goes on with a1, which is no longer stored
  });

  it("B against a foreign B of another window: conflict, the foreign B stays, nothing for register/open", async () => {
    const b = browser();
    const a = record("a", { proof: "pa", proofVersion: "1", activated: true });
    b.put(a);
    expect(await b.window("w1").mutate(P, () => true, prepareB(a, record("b1")))).toEqual({ kind: "applied", record: record("b1"), result: "created" });
    const late = await b.window("w2").mutate(P, () => true, prepareB(a, record("b2")));
    expect(late).toEqual({ kind: "conflict", reason: "foreign", record: record("b1") });
    expect(b.stored()).toEqual(record("b1"));
  });

  it("B against a newer A of the same installation (its register stored v2 meanwhile): conflict, A v2 stays", async () => {
    const b = browser();
    const a1 = record("a", { proof: "pa1", proofVersion: "1" });
    b.put(a1);
    const lock = await b.locks.hold("w2", LOCK); // window 2 is inside its register-result section
    const late = b.window("w1").mutate(P, () => true, prepareB(a1, record("b1")));
    await Promise.resolve();
    b.put(record("a", { proof: "pa2", proofVersion: "2" }));
    lock.release();
    expect(await late).toEqual({ kind: "conflict", reason: "newer", record: record("a", { proof: "pa2", proofVersion: "2" }) });
    expect(b.stored()).toEqual(record("a", { proof: "pa2", proofVersion: "2" }));
  });

  it("register results: late A after B, reversed versions, equal version with another proof, no activated downgrade", async () => {
    const b = browser();
    const w1 = b.window("w1");
    const sentA = { clientInstanceId: "a", registrationId: "reg-a" };
    b.put(record("b"));
    expect(await w1.mutate(P, () => true, registerResult(sentA, "pa", "1"))).toMatchObject({ kind: "conflict", reason: "other-installation" });
    expect(b.stored()).toEqual(record("b"));

    b.put(record("a", { activated: true, proof: "p5", proofVersion: "5" }));
    expect(await w1.mutate(P, () => true, registerResult(sentA, "p4", "4"))).toMatchObject({ kind: "current" });
    expect(await w1.mutate(P, () => true, registerResult(sentA, "other", "5"))).toMatchObject({ kind: "conflict", reason: "proof-mismatch" });
    expect(await w1.mutate(P, () => true, registerResult(sentA, "p6", "6")))
      .toEqual({ kind: "applied", record: record("a", { activated: true, proof: "p6", proofVersion: "6" }), result: "stored" });
  });

  it("a late activated changes only the flag of the matching installation and keeps a newer proof", async () => {
    const b = browser();
    b.put(record("a", { proof: "p2", proofVersion: "2" }));
    expect(await b.window("w1").mutate(P, () => true, activated("a", "1"))).toMatchObject({ kind: "conflict" });
    expect(b.stored()).toEqual(record("a", { proof: "p2", proofVersion: "2" }));
    expect(await b.window("w2").mutate(P, () => true, activated("a", "2")))
      .toEqual({ kind: "applied", record: record("a", { proof: "p2", proofVersion: "2", activated: true }), result: "activated" });
  });

  it("another profile has its own lock: it is written while the first profile's lock is held", async () => {
    const b = browser();
    const lock = await b.locks.hold("w2", LOCK);
    const other = { ...record("x"), profileId: "profile-2" };
    expect(await b.window("w1").mutate("profile-2", () => true, () => ({ write: other, result: null })))
      .toEqual({ kind: "applied", record: other, result: null });
    expect(b.locks.waiting(LOCK)).toEqual([]);
    lock.release();
  });

  it("the document lock's steal does not touch the store's lock", async () => {
    const b = browser();
    const doc = browserDocumentLock({ locks: b.locks.context("w2") } as unknown as Navigator);
    const lost = vi.fn();
    await doc.acquire(`${P}:a`, lost);
    const lock = await b.locks.hold("w2", LOCK);
    const waiting = b.window("w1").mutate(P, () => true, prepareA(record("a1")));
    await browserDocumentLock({ locks: b.locks.context("w1") } as unknown as Navigator).acquire(`${P}:a`, vi.fn());
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
    expect(b.locks.holder(LOCK)).toBe("w2"); // no steal reached the store's lock
    expect(b.locks.waiting(LOCK)).toEqual(["w1"]);
    lock.release();
    expect(await waiting).toMatchObject({ kind: "applied" });
  });

  it("a crashed holder window releases the lock: the waiter goes on; the crashed window's queued write never runs", async () => {
    const b = browser();
    const lock = await b.locks.hold("w2", LOCK);
    const crashedWrite = b.window("w2").mutate(P, () => true, prepareA(record("from-crashed")));
    const waiter = b.window("w1").mutate(P, () => true, prepareA(record("a1")));
    await Promise.resolve();
    expect(b.locks.waiting(LOCK)).toEqual(["w2", "w1"]);
    b.locks.destroy("w2");
    expect(await waiter).toEqual({ kind: "applied", record: record("a1"), result: "created" });
    expect(b.stored()).toEqual(record("a1"));
    let settled = false;
    void crashedWrite.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    lock.release();
  });

  it("an old page (79) that sets the key without the lock is not held back: the limit, not a protection", async () => {
    const b = browser();
    b.put(record("pending"));
    b.watchers.afterGet.push(key => { if (key === KEY) b.map.set(KEY, JSON.stringify(record("old-page"))); });
    expect(await b.window("w1").mutate(P, () => true, prepareA(record("a1")))).toMatchObject({ kind: "applied" });
    expect(b.stored()).toEqual(record("a1")); // the old page's own record was overwritten: no CAS without the lock
  });
});

describe("installation store: a context that ended while it waited for the lock", () => {
  const ends: [string, (live: ReturnType<typeof context>["live"]) => void][] = [
    ["disposed", live => { live.disposed = true; }],
    ["another generation", live => { live.generation += 1; }],
    ["closed", live => { live.closed = true; }],
    ["replaced", live => { live.replaced = true; }],
    ["another profile", live => { live.profileId = "profile-2"; }],
  ];
  for (const [name, end] of ends) {
    it(`${name}: after the grant it neither reads for a decision nor writes`, async () => {
      const b = browser();
      b.put(record("a", { proof: "p", proofVersion: "1" }));
      const ctx = context();
      const lock = await b.locks.hold("w2", LOCK);
      const reducer = vi.fn(() => ({ write: record("b"), result: 0 }) as const);
      const waiting = b.window("w1").mutate(P, ctx.guard, reducer);
      await Promise.resolve();
      expect(b.locks.waiting(LOCK)).toEqual(["w1"]);
      end(ctx.live);
      b.log.length = 0;
      lock.release();
      expect(await waiting).toEqual({ kind: "cancelled", at: "after-lock" });
      expect(reducer).not.toHaveBeenCalled();
      expect(b.log).toEqual([]);
      expect(b.stored()).toEqual(record("a", { proof: "p", proofVersion: "1" }));
    });
  }

  it("an aborted signal ends the wait at once: the request leaves the queue, the lock is never granted to it", async () => {
    const b = browser();
    const lock = await b.locks.hold("w2", LOCK);
    const abort = new AbortController();
    const waiting = b.window("w1").mutate(P, () => true, prepareA(record("a1")), { signal: abort.signal });
    await Promise.resolve();
    abort.abort();
    expect(await waiting).toEqual({ kind: "cancelled", at: "before-lock" });
    expect(b.locks.waiting(LOCK)).toEqual([]);
    lock.release();
    expect(b.log).toEqual([]);
  });

  it("a context already ended asks for no lock", async () => {
    const b = browser();
    const abort = new AbortController();
    abort.abort();
    expect(await b.window("w1").mutate(P, () => false, prepareA(record("a1")))).toEqual({ kind: "cancelled", at: "before-lock" });
    expect(await b.window("w1").mutate(P, () => true, prepareA(record("a1")), { signal: abort.signal }))
      .toEqual({ kind: "cancelled", at: "before-lock" });
    expect(b.locks.requests).toEqual([]);
  });

  it("a context that ends during the reducer is not written for", async () => {
    const b = browser();
    const ctx = context();
    const result = await b.window("w1").mutate(P, ctx.guard, () => { ctx.live.disposed = true; return { write: record("a1"), result: 0 }; });
    expect(result).toEqual({ kind: "cancelled", at: "before-write" });
    expect(b.log).toEqual([`get ${KEY}`]);
  });
});

describe("installation store: the last guard and setItem are one synchronous run", () => {
  it("no task or microtask runs between the read, the last guard and setItem", async () => {
    const b = browser();
    const order: string[] = [];
    let guards = 0;
    const guard = () => {
      guards += 1;
      order.push(`guard ${guards}`);
      if (guards === 2) { // granted: anything scheduled from here would run before an awaited set
        queueMicrotask(() => order.push("microtask"));
        void Promise.resolve().then(() => order.push("then"));
        setTimeout(() => order.push("task"), 0);
      }
      return true;
    };
    b.watchers.set.push(() => order.push("set"));
    const result = await b.window("w1").mutate(P, guard, current => { order.push(`reducer ${current === null}`); return prepareA(record("a1"))(current); });
    expect(result).toMatchObject({ kind: "applied" });
    expect(order.slice(0, 5)).toEqual(["guard 1", "guard 2", "reducer true", "guard 3", "set"]);
    expect(order.indexOf("microtask")).toBeGreaterThan(order.indexOf("set"));
    expect(order.indexOf("then")).toBeGreaterThan(order.indexOf("set"));
  });

  it("the old async set shows the limit: a dispose after the guard still writes later", async () => {
    const b = browser();
    let finish!: () => void;
    const deferred: AsyncStorage = {
      get: async key => b.storage.getItem(key),
      set: (key, value) => new Promise<void>(resolve => { finish = () => { b.storage.setItem(key, value); resolve(); }; }),
      remove: async key => b.storage.removeItem(key),
    };
    const ctx = context();
    const writing = (async () => {
      if (!ctx.guard()) return;
      await writeInstallation(deferred, record("a1"));
    })();
    await Promise.resolve();
    ctx.live.disposed = true; // the guard was true; the write is already on its way
    finish();
    await writing;
    expect(b.stored()).toEqual(record("a1"));
  });

  it("a reducer returning a Promise is refused before any write", async () => {
    const b = browser();
    const reducer = (() => Promise.resolve({ write: record("a1"), result: 0 })) as unknown as () => InstallationDecision<number>;
    await expect(b.window("w1").mutate(P, () => true, reducer)).rejects.toThrow(TypeError);
    expect(b.map.has(KEY)).toBe(false);
  });
});

describe("installation store: unsupported and errors write nothing and fall back to nothing", () => {
  it("without Web Locks: unsupported, the storage is not touched (no reread, no one-window queue)", async () => {
    const s = sharedStorage();
    const reducer = vi.fn(() => ({ write: record("a1"), result: 0 }) as const);
    expect(await browserInstallationStore(s.storage, undefined).mutate(P, () => true, reducer))
      .toEqual({ kind: "unsupported", reason: "no-web-locks" });
    expect(reducer).not.toHaveBeenCalled();
    expect(s.log).toEqual([]);
  });

  it("a refused lock request: unsupported, the storage is not touched", async () => {
    const s = sharedStorage();
    const request = vi.fn(async () => { throw new DOMException("denied", "SecurityError"); });
    expect(await browserInstallationStore(s.storage, { request } as unknown as LockManager).mutate(P, () => true, prepareA(record("a1"))))
      .toEqual({ kind: "unsupported", reason: "lock-failed" });
    expect(s.log).toEqual([]);
  });

  it("getItem or setItem throwing: unsupported, the record stays, the lock is released for the next writer", async () => {
    const b = browser();
    b.put(record("a"));
    b.faults.get = new DOMException("blocked", "SecurityError");
    expect(await b.window("w1").mutate(P, () => true, prepareA(record("a1")))).toEqual({ kind: "unsupported", reason: "storage-read" });
    b.faults.get = null;
    b.faults.set = new DOMException("full", "QuotaExceededError");
    expect(await b.window("w1").mutate(P, () => true, prepareA(record("a1")))).toEqual({ kind: "unsupported", reason: "storage-write" });
    expect(b.stored()).toEqual(record("a"));
    b.faults.set = null;
    expect(await b.window("w2").mutate(P, () => true, prepareA(record("a2")))).toEqual({ kind: "applied", record: record("a2"), result: "created" });
  });

  it("a throwing reducer or guard, or a record of another profile or form, rejects without a write and frees the lock", async () => {
    const b = browser();
    const w1 = b.window("w1");
    await expect(w1.mutate(P, () => true, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    let calls = 0;
    await expect(w1.mutate(P, () => { calls += 1; if (calls > 1) throw new Error("guard"); return true; }, prepareA(record("a1"))))
      .rejects.toThrow("guard");
    await expect(w1.mutate(P, () => true, () => ({ write: { ...record("a1"), profileId: "profile-2" }, result: 0 })))
      .rejects.toThrow("Invalid installation");
    await expect(w1.mutate(P, () => true, () => ({ write: { ...record("a1"), proofVersion: "0" }, result: 0 })))
      .rejects.toThrow("Invalid installation");
    await expect(w1.mutate(P, () => true, (() => ({ store: record("a1") })) as unknown as () => InstallationDecision<number>))
      .rejects.toThrow(TypeError);
    expect(b.map.has(KEY)).toBe(false);
    expect(await b.window("w2").mutate(P, () => true, prepareA(record("a2")))).toMatchObject({ kind: "applied" });
  });
});
