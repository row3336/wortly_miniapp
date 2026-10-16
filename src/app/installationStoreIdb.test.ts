import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import type { AsyncStorage } from "../platform/storage";
import { newerVersion, readInstallation, writeInstallation } from "./installation";
import type { Installation } from "./installation";
import { committingRefusesAbort, upgradeWrites } from "./installationIdb.test-support";
import { sharedStorage } from "./webLocks.test-support";
import type { InstallationDecision, MutateOutcome } from "./installationStore";
import { idbInstallationStore, INSTALLATION_DATABASE, INSTALLATION_DATABASE_VERSION, INSTALLATION_STORE } from "./installationStoreIdb";

/**
 * The IndexedDB prototype of the installation store (C410) on the double of commands/idbFake.test-support.ts:
 * transactions strictly one after another across connections, writes visible only at commit. This checks how the
 * prototype uses the API and what it reports; it does not prove a Telegram WebView (that stays DEV-38, on devices).
 */

const P = "profile-1";
function record(clientInstanceId: string, more: Partial<Installation> = {}): Installation {
  return { profileId: P, clientInstanceId, registrationId: `reg-${clientInstanceId}`, proof: null, proofVersion: null,
    activated: false, ...more };
}
async function drain(): Promise<void> {
  for (let round = 0; round < 300; round++) await Promise.resolve();
}
function track<T>(promise: Promise<T>): { settled: boolean; value?: T } {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then(value => { state.settled = true; state.value = value; }, () => { state.settled = true; });
  return state;
}
/** A localStorage without legacy records (the import finds nothing). */
const emptyLegacy = () => sharedStorage().storage;
async function browser(seed?: unknown, strict = false) {
  const fake = new FakeIndexedDb();
  const factory = strict ? committingRefusesAbort(upgradeWrites(fake)) : upgradeWrites(fake);
  const window = () => idbInstallationStore(factory, emptyLegacy);
  await window().read(P); // creates the database
  if (seed !== undefined) fake.seed(INSTALLATION_DATABASE, INSTALLATION_STORE, P, seed);
  const log0 = fake.log.length;
  return { fake, window, row: () => fake.rows(INSTALLATION_DATABASE, INSTALLATION_STORE).get(P),
    log: () => fake.log.slice(log0).map(({ mode, durability, requests, outcome }) => ({ mode, durability, requests, outcome })) };
}
function context() {
  const live = { generation: 1, disposed: false };
  return { live, guard: () => live.generation === 1 && !live.disposed };
}

// Model reducers of the four writers (C405 rules); the product reducers are the integration's (C163 author).
const prepareA = (fresh: Installation) => (current: Installation | null): InstallationDecision<"reused" | "created"> =>
  current?.proof && current.proofVersion ? { keep: true, result: "reused" } : { write: fresh, result: "created" };
const prepareB = (expectedA: Installation, fresh: Installation) =>
  (current: Installation | null): InstallationDecision<"created", "foreign" | "newer"> =>
    current && JSON.stringify(current) !== JSON.stringify(expectedA)
      ? { conflict: current.clientInstanceId === expectedA.clientInstanceId ? "newer" : "foreign" }
      : { write: fresh, result: "created" };
const registerResult = (sent: Installation, proof: string, version: string) =>
  (current: Installation | null): InstallationDecision<"older" | "same" | "stored", "other-installation" | "proof-mismatch"> => {
    if (!current || current.clientInstanceId !== sent.clientInstanceId || current.registrationId !== sent.registrationId) {
      return { conflict: "other-installation" };
    }
    if (current.proofVersion && newerVersion(current.proofVersion, version)) return { keep: true, result: "older" };
    if (current.proofVersion === version) return current.proof === proof ? { keep: true, result: "same" } : { conflict: "proof-mismatch" };
    return { write: { ...current, proof, proofVersion: version }, result: "stored" };
  };
const activated = (clientInstanceId: string) => (current: Installation | null): InstallationDecision<"activated", "other-installation"> =>
  !current || current.clientInstanceId !== clientInstanceId ? { conflict: "other-installation" }
    : current.activated ? { keep: true, result: "activated" } : { write: { ...current, activated: true }, result: "activated" };

afterEach(() => { vi.useRealTimers(); });

describe("IndexedDB installation store: schema and transactions", () => {
  it("has its own database and never opens or upgrades the send budget database `wortly`", async () => {
    const b = await browser();
    expect(b.fake.database(INSTALLATION_DATABASE).version).toBe(INSTALLATION_DATABASE_VERSION);
    expect(b.fake.database(INSTALLATION_DATABASE).stores.get(INSTALLATION_STORE)?.keyPath).toBe("profileId");
    expect(b.fake.database("wortly").version).toBe(0);
  });

  it("one mutation is one readwrite transaction with strict durability; keep and conflict place no put; read is readonly", async () => {
    const b = await browser();
    const w = b.window();
    expect(await w.mutate(P, () => true, prepareA(record("a", { proof: "p", proofVersion: "1" }))))
      .toEqual({ kind: "applied", record: record("a", { proof: "p", proofVersion: "1" }), result: "created" });
    expect(await w.mutate(P, () => true, prepareA(record("x")))).toMatchObject({ kind: "current", result: "reused" });
    expect(await w.mutate(P, () => true, () => ({ conflict: "no" }))).toMatchObject({ kind: "conflict", reason: "no" });
    expect(await w.read(P)).toEqual({ kind: "current", record: record("a", { proof: "p", proofVersion: "1" }) });
    expect(b.log()).toEqual([
      { mode: "readwrite", durability: "strict", requests: ["get", "put"], outcome: "complete" },
      { mode: "readwrite", durability: "strict", requests: ["get"], outcome: "complete" },
      { mode: "readwrite", durability: "strict", requests: ["get"], outcome: "complete" },
      { mode: "readonly", durability: "default", requests: ["get"], outcome: "complete" },
    ]);
  });

  it("applied is reported only on complete, not when the put was placed", async () => {
    const b = await browser();
    const release = b.fake.holdCommits();
    const state = track(b.window().mutate(P, () => true, prepareA(record("a"))));
    await drain();
    expect(state.settled).toBe(false);
    expect(b.row()).toBeUndefined();
    release();
    await drain();
    expect(state.value).toMatchObject({ kind: "applied" });
    expect(b.row()).toEqual(record("a"));
  });
});

describe("IndexedDB installation store: four writers of four windows read-modify-write at once", () => {
  const initial = record("a", { proof: "p1", proofVersion: "1" });
  type Writer = { name: string; reducer: (current: Installation | null) => InstallationDecision<string, string> };
  const writers: Writer[] = [
    { name: "A", reducer: prepareA(record("a9")) },
    { name: "B", reducer: prepareB(initial, record("b")) },
    { name: "register", reducer: registerResult(initial, "p2", "2") },
    { name: "activated", reducer: activated("a") },
  ];
  const permutations = <T,>(items: T[]): T[][] => items.length <= 1 ? [items]
    : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));

  it("every order of 24 is linearizable: the final record and every outcome equal the replay in commit order", async () => {
    for (const order of permutations(writers)) {
      const b = await browser(initial);
      const ran: string[] = [];
      const outcomes = await Promise.all(order.map(writer => b.window().mutate(P, () => true, current => {
        ran.push(writer.name);
        return writer.reducer(current);
      })));
      // Replay the reducers one after another in the order the transactions ran.
      let state: Installation | null = initial;
      const expected = new Map<string, string>();
      for (const name of ran) {
        const decision = writers.find(writer => writer.name === name)!.reducer(state);
        if ("write" in decision) { state = decision.write; expected.set(name, "applied"); }
        else expected.set(name, "keep" in decision ? "current" : "conflict");
      }
      expect(b.row(), order.map(writer => writer.name).join(">")).toEqual(state);
      order.forEach((writer, index) => expect(outcomes[index].kind, writer.name).toBe(expected.get(writer.name)));
      if (state?.clientInstanceId === "a") expect(state).toEqual(record("a", { proof: "p2", proofVersion: "2", activated: true }));
    }
  });

  it("the 79 snapshot writes lose an update in the same race: register and activated of one installation", async () => {
    const map = new Map<string, string>();
    const storage: AsyncStorage = { get: async key => map.get(key) ?? null, set: async (key, value) => { map.set(key, value); },
      remove: async key => { map.delete(key); } };
    await writeInstallation(storage, initial);
    const snapshot = async (change: (value: Installation) => Installation) => {
      const value = await readInstallation(storage, P);
      await writeInstallation(storage, change(value!));
    };
    await Promise.all([snapshot(value => ({ ...value, proof: "p2", proofVersion: "2" })), snapshot(value => ({ ...value, activated: true }))]);
    expect(await readInstallation(storage, P)).toEqual(record("a", { proof: "p1", proofVersion: "1", activated: true })); // p2 lost
  });

  it("B of the second window against the first window's B: conflict foreign, the first B stays", async () => {
    const b = await browser(initial);
    const [one, two] = await Promise.all([
      b.window().mutate(P, () => true, prepareB(initial, record("b1"))),
      b.window().mutate(P, () => true, prepareB(initial, record("b2"))),
    ]);
    expect(one).toMatchObject({ kind: "applied", record: record("b1") });
    expect(two).toEqual({ kind: "conflict", reason: "foreign", record: record("b1") });
    expect(b.row()).toEqual(record("b1"));
  });
});

describe("IndexedDB installation store: guard before put, the commit, and a late commit are told apart", () => {
  it("a context already ended creates no transaction", async () => {
    const b = await browser();
    expect(await b.window().mutate(P, () => false, prepareA(record("a")))).toEqual({ kind: "cancelled", at: "before-lock" });
    expect(b.log()).toEqual([]);
  });

  it("an abort while the transaction waits behind another window's: cancelled before-lock, aborted, nothing written", async () => {
    const b = await browser();
    const release = b.fake.holdCommits();
    const first = b.window().mutate(P, () => true, prepareA(record("a1")));
    const abort = new AbortController();
    const second = track(b.window().mutate(P, () => true, prepareA(record("a2")), { signal: abort.signal }));
    await drain();
    abort.abort();
    await drain();
    expect(second.value).toEqual({ kind: "cancelled", at: "before-lock" });
    release();
    expect(await first).toMatchObject({ kind: "applied" });
    expect(b.row()).toEqual(record("a1"));
    expect(b.log().map(entry => [entry.requests, entry.outcome])).toEqual([[["get", "put"], "complete"], [["get"], "abort"]]);
  });

  it("disposed or another generation while queued: the answered read sees it, the transaction aborts without a put", async () => {
    for (const end of [(live: { generation: number; disposed: boolean }) => { live.disposed = true; },
      (live: { generation: number; disposed: boolean }) => { live.generation += 1; }]) {
      const b = await browser(record("old", { proof: "p", proofVersion: "1" }));
      const release = b.fake.holdCommits();
      const first = b.window().mutate(P, () => true, () => ({ keep: true, result: 0 }));
      const ctx = context();
      const reducer = vi.fn(prepareB(record("x"), record("b")));
      const second = b.window().mutate(P, ctx.guard, reducer);
      await drain();
      end(ctx.live);
      release();
      await first;
      expect(await second).toEqual({ kind: "cancelled", at: "after-lock" });
      expect(reducer).not.toHaveBeenCalled();
      expect(b.log()[1]).toMatchObject({ requests: ["get"], outcome: "abort" });
      expect(b.row()).toEqual(record("old", { proof: "p", proofVersion: "1" }));
    }
  });

  it("a context that ends in the reducer: cancelled before-write, no put placed", async () => {
    const b = await browser();
    const ctx = context();
    expect(await b.window().mutate(P, ctx.guard, current => { ctx.live.disposed = true; return prepareA(record("a"))(current); }))
      .toEqual({ kind: "cancelled", at: "before-write" });
    expect(b.log()).toEqual([{ mode: "readwrite", durability: "strict", requests: ["get"], outcome: "abort" }]);
    expect(b.row()).toBeUndefined();
  });

  it("an abort after the put was placed and before its success: the abort is still possible, the write is discarded", async () => {
    const b = await browser(undefined, true);
    const abort = new AbortController();
    let guards = 0;
    const guard = () => { guards += 1; if (guards === 4) queueMicrotask(() => abort.abort()); return true; };
    expect(await b.window().mutate(P, guard, prepareA(record("a")), { signal: abort.signal }))
      .toEqual({ kind: "cancelled", at: "before-commit" });
    expect(b.log()).toEqual([{ mode: "readwrite", durability: "strict", requests: ["get", "put"], outcome: "abort" }]);
    expect(b.row()).toBeUndefined();
  });

  it("an abort once the transaction is committing is refused: the commit happens and is reported late, not applied", async () => {
    const b = await browser(undefined, true);
    const release = b.fake.holdCommits();
    const abort = new AbortController();
    const state = track(b.window().mutate(P, () => true, prepareA(record("a")), { signal: abort.signal }));
    await drain();
    abort.abort(); // dispose: abort() throws InvalidStateError, the transaction commits anyway
    release();
    await drain();
    expect(state.value).toEqual({ kind: "late", record: record("a"), result: "created" });
    expect(b.row()).toEqual(record("a"));
  });

  it("another generation before the commit without a signal: the commit is late, the record stays a fact", async () => {
    const b = await browser();
    const release = b.fake.holdCommits();
    const ctx = context();
    const state = track(b.window().mutate(P, ctx.guard, prepareA(record("a"))));
    await drain();
    ctx.live.generation += 1;
    release();
    await drain();
    expect(state.value).toMatchObject({ kind: "late" });
    expect(b.row()).toEqual(record("a"));
  });

  it("the outcome follows the transaction's event: where the browser still accepts the abort, it is cancelled", async () => {
    const b = await browser(); // the plain double accepts abort() until the very commit
    const release = b.fake.holdCommits();
    const abort = new AbortController();
    const state = track(b.window().mutate(P, () => true, prepareA(record("a")), { signal: abort.signal }));
    await drain();
    abort.abort();
    release();
    await drain();
    expect(state.value).toEqual({ kind: "cancelled", at: "before-commit" });
    expect(b.row()).toBeUndefined();
  });
});

describe("IndexedDB installation store: fix1 regressions (QA a1579f41 K1, K3)", () => {
  it("K1: a guard that throws on the commit settles the promise once, as late; the write stays a fact", async () => {
    const b = await browser();
    let calls = 0;
    // Calls: 1 before the open, 2 after it, 3 when the read is answered, 4 before the put, 5 on complete.
    const guard = () => { calls += 1; if (calls === 5) throw new Error("guard"); return true; };
    const state = track(b.window().mutate(P, guard, prepareA(record("a"))));
    await drain();
    expect(calls).toBe(5);
    expect(state.settled).toBe(true);
    expect(state.value).toEqual({ kind: "late", record: record("a"), result: "created" });
    expect(b.row()).toEqual(record("a"));
  });

  it("K3: an abort raised inside the reducer is cancelled before-write: no put was placed", async () => {
    const b = await browser(undefined, true);
    const abort = new AbortController();
    const outcome = await b.window().mutate(P, () => true, current => { abort.abort(); return prepareA(record("a"))(current); },
      { signal: abort.signal });
    expect(outcome).toEqual({ kind: "cancelled", at: "before-write" });
    expect(b.log()).toEqual([{ mode: "readwrite", durability: "strict", requests: ["get"], outcome: "abort" }]);
    expect(b.row()).toBeUndefined();
  });
});

describe("IndexedDB installation store: fix2 regressions (C418: K4 and the diagnostic of a swallowed guard error)", () => {
  it("K4: an open without an answer is unavailable open-timeout in mutate and in read, not unsupported", async () => {
    vi.useFakeTimers();
    const fake = new FakeIndexedDb();
    fake.openBehaviour = "hang";
    const store = idbInstallationStore(upgradeWrites(fake), emptyLegacy);
    const mutate = track(store.mutate(P, () => true, prepareA(record("a"))));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mutate.value).toEqual({ kind: "unavailable", reason: "open-timeout" });
    const read = track(store.read(P));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read.value).toEqual({ kind: "unavailable", reason: "open-timeout" });
  });

  it("K4: a read without an answer is unavailable read-timeout; an aborted read is unavailable read-failed", async () => {
    const b = await browser(record("a"));
    const w = b.window();
    await w.read(P); // the connection is open
    vi.useFakeTimers();
    b.fake.failNext("hang");
    const hung = track(w.read(P));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hung.value).toEqual({ kind: "unavailable", reason: "read-timeout" });
    vi.useRealTimers();
    // The double's hung transaction holds its queue for good: the failures run on another database of the same seed.
    const c = await browser(record("a"));
    const v = c.window();
    c.fake.failNext("abort_on_commit");
    expect(await v.read(P)).toEqual({ kind: "unavailable", reason: "read-failed" });
    c.fake.failNext("throw_on_create");
    expect(await v.read(P)).toEqual({ kind: "unavailable", reason: "read-failed" });
    expect(await v.read(P)).toEqual({ kind: "current", record: record("a") });
  });

  it("a guard that throws after the commit is reported once with a fixed text without proof or IDs", async () => {
    const b = await browser();
    const report = vi.fn();
    const store = idbInstallationStore(committingRefusesAbort(upgradeWrites(b.fake)), emptyLegacy, { report });
    let calls = 0;
    const guard = () => { calls += 1; if (calls === 5) throw new Error("reg-secret-a proof-secret"); return true; };
    const outcome = await store.mutate(P, guard, prepareA(record("secret-a", { proof: "proof-secret", proofVersion: "1" })));
    expect(outcome).toMatchObject({ kind: "late" });
    expect(report).toHaveBeenCalledOnce();
    const text = String(report.mock.calls[0][0]);
    expect(text).toBe("Wortly installation store: the guard threw after the commit; the outcome is late");
    for (const secret of ["secret", P, "proof"]) expect(text.toLowerCase().includes(secret.toLowerCase())).toBe(false);
  });
});

describe("IndexedDB installation store: failures are never applied", () => {
  it("a commit that aborts: failed, nothing written; a transaction that cannot be created: failed", async () => {
    const b = await browser();
    b.fake.failNext("abort_on_commit");
    expect(await b.window().mutate(P, () => true, prepareA(record("a")))).toEqual({ kind: "failed" });
    expect(b.row()).toBeUndefined();
    b.fake.failNext("throw_on_create");
    expect(await b.window().mutate(P, () => true, prepareA(record("a")))).toEqual({ kind: "failed" });
    expect(b.row()).toBeUndefined();
  });

  it("no answer within the limit: unknown (not applied, not 'nothing written')", async () => {
    const b = await browser();
    vi.useFakeTimers();
    b.fake.failNext("hang");
    const state = track(b.window().mutate(P, () => true, prepareA(record("a"))));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.value).toEqual({ kind: "unknown" });
  });

  it("no IndexedDB: unsupported; an open that fails: unavailable (not unsupported); a later call opens again", async () => {
    expect(await idbInstallationStore(undefined, emptyLegacy).mutate(P, () => true, prepareA(record("a"))))
      .toEqual({ kind: "unsupported", reason: "no-indexeddb" });
    expect(await idbInstallationStore(undefined, emptyLegacy).read(P)).toEqual({ kind: "unsupported" });
    const fake = new FakeIndexedDb();
    const store = idbInstallationStore(upgradeWrites(fake), emptyLegacy);
    fake.openBehaviour = "error";
    expect(await store.mutate(P, () => true, prepareA(record("a")))).toEqual({ kind: "unavailable", reason: "open-failed" });
    expect(await store.read(P)).toEqual({ kind: "unavailable", reason: "open-failed" });
    fake.openBehaviour = "normal";
    expect(await store.mutate(P, () => true, prepareA(record("a")))).toMatchObject({ kind: "applied" });
  });

  it("a closed connection (versionchange) is opened again by the next call", async () => {
    const b = await browser();
    const w = b.window();
    await w.mutate(P, () => true, prepareA(record("a")));
    b.fake.requestVersionChange();
    expect(await w.mutate(P, () => true, activated("a"))).toMatchObject({ kind: "applied" });
    expect(b.fake.connections.filter(db => !db.closed).length).toBeGreaterThan(0);
  });

  it("an invalid stored record is an explicit fail-closed conflict: no reducer, no put; read says invalid", async () => {
    const b = await browser({ profileId: P, clientInstanceId: 5 });
    const reducer = vi.fn(prepareA(record("a")));
    expect(await b.window().mutate(P, () => true, reducer)).toEqual({ kind: "conflict", record: null, reason: "invalid" });
    expect(reducer).not.toHaveBeenCalled();
    expect(await b.window().read(P)).toEqual({ kind: "invalid" });
    expect(b.log()[0]).toMatchObject({ requests: ["get"] });
    expect(b.row()).toEqual({ profileId: P, clientInstanceId: 5 });
  });

  it("a throwing or asynchronous reducer rejects and aborts the transaction: nothing written", async () => {
    const b = await browser();
    await expect(b.window().mutate(P, () => true, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    const async = (() => Promise.resolve({ write: record("a"), result: 0 })) as unknown as () => InstallationDecision<number>;
    await expect(b.window().mutate(P, () => true, async)).rejects.toThrow(TypeError);
    expect(b.log().map(entry => entry.outcome)).toEqual(["abort", "abort"]);
    expect(b.row()).toBeUndefined();
  });

  it("another profile has its own record", async () => {
    const b = await browser(record("a"));
    const other = { ...record("x"), profileId: "profile-2" };
    const outcome: MutateOutcome<number> = await b.window().mutate("profile-2", () => true, () => ({ write: other, result: 1 }));
    expect(outcome).toEqual({ kind: "applied", record: other, result: 1 });
    expect(b.row()).toEqual(record("a"));
  });
});
