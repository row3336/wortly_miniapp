import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import { newerVersion } from "./installation";
import type { Installation } from "./installation";
import { upgradeWrites } from "./installationIdb.test-support";
import type { InstallationDecision } from "./installationStore";
import { idbInstallationStore, INSTALLATION_DATABASE, INSTALLATION_STORE, probeIndexedDb } from "./installationStoreIdb";

/**
 * The code step of project_installation_store.md ред.1 at level U (the IndexedDB double): the upgrade import (§3), the
 * strict six fields and the invalid marker (§2), forget (§6), no rejection after a known commit (§4, T3) and the narrow
 * read-only path when IndexedDB is reliably absent (§5). It proves the use of the API on the double, not a WebView (G2/G3).
 */

const KEY = "wortly.installation:";
function record(profileId: string, clientInstanceId: string, more: Partial<Installation> = {}): Installation {
  return { profileId, clientInstanceId, registrationId: `reg-${clientInstanceId}`, proof: null, proofVersion: null, activated: false, ...more };
}
const activatedA = (profileId: string) => record(profileId, "a", { proof: "pa", proofVersion: "1", activated: true });

type Faults = { length?: boolean; key?: number; getItem?: string; vanish?: string; getter?: boolean;
  /** Another process changing localStorage while this page enumerates it: runs inside key(index). */
  onKey?: (index: number, map: Map<string, string>) => void };
/** The page's localStorage with legacy values; it counts every call and can throw where the test says. */
function legacyStorage(entries: Record<string, string>, faults: Faults = {}) {
  const map = new Map(Object.entries(entries));
  const calls = { length: 0, key: 0, get: 0, set: 0, remove: 0 };
  const storage = {
    get length() { calls.length += 1; if (faults.length) throw new DOMException("blocked", "SecurityError"); return map.size; },
    key(index: number) {
      calls.key += 1;
      if (faults.key === index) throw new DOMException("blocked", "SecurityError");
      faults.onKey?.(index, map);
      return [...map.keys()][index] ?? null;
    },
    getItem(key: string) {
      calls.get += 1;
      if (faults.getItem === key) throw new DOMException("blocked", "SecurityError");
      if (faults.vanish === key) return null;
      return map.get(key) ?? null;
    },
    setItem(key: string, value: string) { calls.set += 1; map.set(key, value); },
    removeItem(key: string) { calls.remove += 1; map.delete(key); },
    clear() { map.clear(); },
  } as unknown as Storage;
  const getter = () => { if (faults.getter) throw new DOMException("denied", "SecurityError"); return storage; };
  return { storage, map, calls, faults, getter };
}
function device(entries: Record<string, string> = {}, faults: Faults = {}) {
  const legacy = legacyStorage(entries, faults);
  const fake = new FakeIndexedDb();
  const puts: unknown[] = [];
  const factory = upgradeWrites(fake, puts);
  const window = () => idbInstallationStore(factory, legacy.getter);
  const rows = () => fake.rows(INSTALLATION_DATABASE, INSTALLATION_STORE);
  return { legacy, fake, puts, factory, window, rows };
}
const json = (value: unknown) => JSON.stringify(value);
async function drain(): Promise<void> {
  for (let round = 0; round < 300; round++) await Promise.resolve();
}
function track<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  void promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
const prepareA = (fresh: Installation) => (current: Installation | null): InstallationDecision<Installation> =>
  current?.proof && current.proofVersion ? { keep: true, result: current } : { write: fresh, result: fresh };
const registerResult = (sent: Installation, proof: string, version: string) =>
  (current: Installation | null): InstallationDecision<Installation, "replaced" | "inconsistent"> => {
    if (!current || current.clientInstanceId !== sent.clientInstanceId || current.registrationId !== sent.registrationId) return { conflict: "replaced" };
    if (current.proofVersion && newerVersion(current.proofVersion, version)) return { keep: true, result: current };
    if (current.proofVersion === version) return current.proof === proof ? { keep: true, result: current } : { conflict: "inconsistent" };
    const updated: Installation = { profileId: current.profileId, clientInstanceId: current.clientInstanceId,
      registrationId: current.registrationId, proof, proofVersion: version, activated: current.activated };
    return { write: updated, result: updated };
  };

afterEach(() => { vi.useRealTimers(); });

describe("§3 upgrade import: only a new database instance, one row per exact key, never a guess", () => {
  it("N2/N7: two profiles, both spellings, an invalid value, extras, a missing field, another profile's value: rows of exact keys", async () => {
    const d = device({
      [`${KEY}p1`]: json(activatedA("p1")),
      [`${KEY}P2`]: json(record("P2", "b")),
      [`${KEY}p2`]: "{not json",
      [`${KEY}p3`]: json({ ...record("p3", "c"), extra: "kept?" }),
      [`${KEY}p4`]: json({ profileId: "p4", clientInstanceId: "d", registrationId: "reg-d", proof: null, proofVersion: null }),
      [`${KEY}p5`]: json(record("other", "e")),
      "wortly.pending.manual": json({ profileId: "p1" }),
      "wortly.reapply:p1": "x",
    });
    const before = new Map(d.legacy.map);
    const w = d.window();
    expect(await w.read("p1")).toEqual({ kind: "current", record: activatedA("p1") });
    expect(Object.fromEntries(d.rows())).toEqual({
      p1: activatedA("p1"), P2: record("P2", "b"),
      p2: { profileId: "p2", invalid: true }, p3: { profileId: "p3", invalid: true },
      p4: { profileId: "p4", invalid: true }, p5: { profileId: "p5", invalid: true },
    });
    expect(Object.keys(d.rows().get("p1") as object).sort()).toEqual(["activated", "clientInstanceId", "profileId", "proof", "proofVersion", "registrationId"]);
    expect(await w.read("p2")).toEqual({ kind: "invalid" });
    expect(await w.read("P2")).toEqual({ kind: "current", record: record("P2", "b") });
    expect(await w.read("P1")).toEqual({ kind: "current", record: null }); // no case folding on a read
    const reducer = vi.fn(prepareA(record("p3", "new")));
    expect(await w.mutate("p3", () => true, reducer)).toEqual({ kind: "conflict", record: null, reason: "invalid" });
    expect(reducer).not.toHaveBeenCalled();
    expect(d.legacy.map).toEqual(before);
    expect(d.legacy.calls.set + d.legacy.calls.remove).toBe(0);
  });

  for (const [name, faults] of [["length", { length: true }], ["key()", { key: 1 }], ["getItem", { getItem: `${KEY}p2` }],
    ["the localStorage getter", { getter: true }]] as const) {
    it(`N3: ${name} throws → the upgrade aborts: no database, unavailable, 0 A, the legacy untouched; later a full import`, async () => {
      const d = device({ [`${KEY}p1`]: json(activatedA("p1")), [`${KEY}p2`]: json(record("p2", "b")) }, { ...faults });
      const w = d.window();
      expect(await w.mutate("p1", () => true, prepareA(record("p1", "new")))).toEqual({ kind: "unavailable", reason: "open-failed" });
      expect(await w.read("p1")).toEqual({ kind: "unavailable", reason: "open-failed" });
      expect(d.fake.database(INSTALLATION_DATABASE).version).toBe(0);
      expect(d.fake.database(INSTALLATION_DATABASE).stores.size).toBe(0);
      expect(d.legacy.calls.set + d.legacy.calls.remove).toBe(0);
      for (const key of Object.keys(d.legacy.faults) as (keyof Faults)[]) delete d.legacy.faults[key];
      expect(await w.read("p1")).toEqual({ kind: "current", record: activatedA("p1") });
      expect(await w.read("p2")).toEqual({ kind: "current", record: record("p2", "b") });
    });
  }

  it("N4: a key gone between key() and getItem() is skipped, the others are imported", async () => {
    const d = device({ [`${KEY}p1`]: json(activatedA("p1")), [`${KEY}p2`]: json(record("p2", "b")) }, { vanish: `${KEY}p1` });
    expect(await d.window().read("p2")).toEqual({ kind: "current", record: record("p2", "b") });
    expect([...d.rows().keys()]).toEqual(["p2"]);
  });

  it("fix1 (QA QC1e): a key removed by another process WHILE key() enumerates shifts the indices: p1 is still imported", async () => {
    let removed = false;
    const d = device({ "a.other": "1", [`${KEY}p1`]: json(activatedA("p1")), [`${KEY}p2`]: json(activatedA("p2")) },
      { onKey: (index, map) => { if (index === 1 && !removed) { removed = true; map.delete("a.other"); } } });
    expect(await d.window().read("p1")).toEqual({ kind: "current", record: activatedA("p1") });
    expect([...d.rows().keys()].sort()).toEqual(["p1", "p2"]);
  });

  it("fix1: a removal and an addition in one pass keep its length but shift p1 away: the next passes differ, p1 is imported", async () => {
    let changed = false;
    const d = device({ "a.other": "1", [`${KEY}p1`]: json(activatedA("p1")), [`${KEY}p2`]: json(activatedA("p2")) },
      { onKey: (index, map) => { if (index === 1 && !changed) { changed = true; map.delete("a.other"); map.set("z.new", "1"); } } });
    expect(await d.window().read("p1")).toEqual({ kind: "current", record: activatedA("p1") });
    expect([...d.rows().keys()].sort()).toEqual(["p1", "p2"]);
  });

  it("fix1: a key list that never settles aborts the upgrade: unavailable, no database, no A; later a full import", async () => {
    const d = device({ [`${KEY}p1`]: json(activatedA("p1")) },
      { onKey: (index, map) => { if (index === 0) { if (map.has("a.flip")) map.delete("a.flip"); else map.set("a.flip", "1"); } } });
    const w = d.window();
    expect(await w.mutate("p1", () => true, prepareA(record("p1", "new")))).toEqual({ kind: "unavailable", reason: "open-failed" });
    expect(d.fake.database(INSTALLATION_DATABASE).version).toBe(0);
    expect(d.rows().size).toBe(0);
    expect(d.legacy.map.get(`${KEY}p1`)).toBe(json(activatedA("p1")));
    expect(d.legacy.calls.set + d.legacy.calls.remove).toBe(0);
    d.legacy.faults.onKey = undefined;
    expect(await w.mutate("p1", () => true, prepareA(record("p1", "new")))).toEqual({ kind: "current", record: activatedA("p1"), result: activatedA("p1") });
  });

  it("N5b/N5c: an open that timed out while its upgrade went on: the import commits once, the next open imports nothing", async () => {
    vi.useFakeTimers();
    const d = device({ [`${KEY}p1`]: json(activatedA("p1")) });
    d.fake.openBehaviour = "hang";
    const w = d.window();
    const first = track(w.mutate("p1", () => true, prepareA(record("p1", "new"))));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.value).toEqual({ kind: "unavailable", reason: "open-timeout" }); // not «no record», no A
    d.fake.finishHungOpens(); // the upgrade goes on without this page's continuation
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await drain();
    expect(d.fake.database(INSTALLATION_DATABASE).version).toBe(1);
    const gets = d.legacy.calls.get;
    expect(await w.read("p1")).toEqual({ kind: "current", record: activatedA("p1") });
    expect(d.legacy.calls.get).toBe(gets); // the actual database decides: version 1, no second import
    expect(d.puts.length).toBe(1);
  });

  it("N6: two windows open the new database at once: one upgrade, one import", async () => {
    const d = device({ [`${KEY}p1`]: json(activatedA("p1")), [`${KEY}p2`]: json(record("p2", "b")) });
    const [one, two] = await Promise.all([d.window().read("p1"), d.window().read("p2")]);
    expect(one).toEqual({ kind: "current", record: activatedA("p1") });
    expect(two).toEqual({ kind: "current", record: record("p2", "b") });
    expect(d.puts.length).toBe(2);
  });

  it("after the import the installation never reads localStorage again; a database that exists imports nothing", async () => {
    const d = device({ [`${KEY}p1`]: json(record("p1", "a")) });
    const w = d.window();
    await w.read("p1");
    const calls = { ...d.legacy.calls };
    d.legacy.map.set(`${KEY}p1`, json(activatedA("p1"))); // an old tab writes the legacy key later
    d.legacy.map.set(`${KEY}p9`, json(activatedA("p9")));
    expect(await w.read("p1")).toEqual({ kind: "current", record: record("p1", "a") });
    expect(await d.window().read("p9")).toEqual({ kind: "current", record: null });
    expect(await w.mutate("p1", () => true, prepareA(record("p1", "new")))).toMatchObject({ kind: "applied" });
    expect(d.legacy.calls).toEqual(calls);
  });

  it("N1: a separate eviction of IndexedDB with localStorage alive is a new instance: the residue comes back, forget removes it again", async () => {
    const legacy = { [`${KEY}x`]: json(activatedA("x")), [`${KEY}y`]: json(activatedA("y")) };
    const d = device(legacy);
    await d.window().read("x");
    expect(await d.window().forget("x")).toEqual({ kind: "removed", count: 1 }); // LS removal failed elsewhere: (A) residue
    // The browser evicts only IndexedDB: a new database instance on the same localStorage.
    const evicted = new FakeIndexedDb();
    const again = idbInstallationStore(upgradeWrites(evicted), d.legacy.getter);
    expect(await again.read("x")).toEqual({ kind: "current", record: activatedA("x") }); // oldVersion 0 proves only a new instance
    expect(await again.forget("x")).toEqual({ kind: "removed", count: 1 }); // checked again, no «x is clean» flag
    expect(await again.read("y")).toEqual({ kind: "current", record: activatedA("y") });
  });
});

describe("§2 strict six fields and the invalid marker", () => {
  it("a stored value with an extra field, a marker with an extra field, a marker of another profile: invalid; no reducer", async () => {
    const d = device();
    const w = d.window();
    await w.read("p");
    for (const value of [{ ...record("p", "a"), extra: 1 }, { profileId: "p", invalid: true, raw: "x" }, { profileId: "q", invalid: true }]) {
      d.fake.seed(INSTALLATION_DATABASE, INSTALLATION_STORE, "p", value);
      expect(await w.read("p")).toEqual({ kind: "invalid" });
      const reducer = vi.fn(prepareA(record("p", "new")));
      expect(await w.mutate("p", () => true, reducer)).toEqual({ kind: "conflict", record: null, reason: "invalid" });
      expect(reducer).not.toHaveBeenCalled();
      expect(d.rows().get("p")).toEqual(value);
    }
  });

  it("a writer's record with an extra field is a program error: rejected, nothing written", async () => {
    const d = device();
    const w = d.window();
    const extra = { ...record("p", "a"), extra: 1 } as unknown as Installation;
    await expect(w.mutate("p", () => true, () => ({ write: extra, result: 0 }))).rejects.toThrow("Invalid installation");
    const missing = { profileId: "p", clientInstanceId: "a", registrationId: "r", proof: null, proofVersion: null } as unknown as Installation;
    await expect(w.mutate("p", () => true, () => ({ write: missing, result: 0 }))).rejects.toThrow("Invalid installation");
    expect(d.rows().size).toBe(0);
  });
});

describe("§6 forget: both spellings, one transaction in the writers' order", () => {
  it("removes both spellings and the marker, keeps another profile; one readwrite transaction; idempotent", async () => {
    const d = device({ [`${KEY}ABC`]: json(activatedA("ABC")), [`${KEY}abc`]: "{bad", [`${KEY}other`]: json(activatedA("other")) });
    const w = d.window();
    await w.read("other");
    const log0 = d.fake.log.length;
    expect(await w.forget("ABC")).toEqual({ kind: "removed", count: 2 });
    expect([...d.rows().keys()]).toEqual(["other"]);
    expect(d.fake.log.slice(log0)).toEqual([expect.objectContaining({ mode: "readwrite", durability: "strict",
      requests: ["get", "get", "delete", "delete"], outcome: "complete" })]);
    expect(await w.forget("ABC")).toEqual({ kind: "removed", count: 0 });
    expect(d.legacy.calls.set + d.legacy.calls.remove).toBe(0); // the LS step is P04's, after this one
  });

  it("failed, unknown, unavailable, unsupported are never «removed»", async () => {
    const d = device({ [`${KEY}x`]: json(activatedA("x")) });
    const w = d.window();
    await w.read("x");
    d.fake.failNext("abort_on_commit");
    expect(await w.forget("x")).toEqual({ kind: "failed" });
    d.fake.failNext("throw_on_create");
    expect(await w.forget("x")).toEqual({ kind: "failed" });
    expect(d.rows().has("x")).toBe(true);
    const e = device();
    e.fake.openBehaviour = "error";
    expect(await e.window().forget("x")).toEqual({ kind: "unavailable", reason: "open-failed" });
    expect(await idbInstallationStore(undefined, e.legacy.getter).forget("x")).toEqual({ kind: "unsupported" });
    expect(await idbInstallationStore({ kind: "error" }, e.legacy.getter).forget("x")).toEqual({ kind: "unavailable", reason: "api-error" });
    vi.useFakeTimers();
    d.fake.failNext("hang");
    const hung = track(w.forget("x"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hung.value).toEqual({ kind: "unknown" });
  });

  it("N12: forget before the database exists: the import runs first, then the delete", async () => {
    const d = device({ [`${KEY}x`]: json(activatedA("x")), [`${KEY}y`]: json(activatedA("y")) });
    expect(await d.window().forget("x")).toEqual({ kind: "removed", count: 1 });
    expect([...d.rows().keys()]).toEqual(["y"]);
  });

  it("N9: a late register after forget is a conflict: nothing comes back", async () => {
    const d = device({ [`${KEY}x`]: json(record("x", "a")) });
    const w = d.window();
    await w.read("x");
    expect(await w.forget("x")).toEqual({ kind: "removed", count: 1 });
    expect(await d.window().mutate("x", () => true, registerResult(record("x", "a"), "p2", "2")))
      .toEqual({ kind: "conflict", record: null, reason: "replaced" });
    expect(d.rows().size).toBe(0);
  });

  it("forget and register of two windows in either order: linearizable, the record ends removed", async () => {
    for (const forgetFirst of [true, false]) {
      const d = device({ [`${KEY}x`]: json(record("x", "a")) });
      await d.window().read("x");
      const forget = () => d.window().forget("x");
      const register = () => d.window().mutate("x", () => true, registerResult(record("x", "a"), "p2", "2"));
      const [first, second] = forgetFirst ? await Promise.all([forget(), register()]) : await Promise.all([register(), forget()]);
      if (forgetFirst) {
        expect(first).toEqual({ kind: "removed", count: 1 });
        expect(second).toMatchObject({ kind: "conflict", reason: "replaced" });
      } else {
        expect(first).toMatchObject({ kind: "applied" });
        expect(second).toEqual({ kind: "removed", count: 1 });
      }
      expect(d.rows().size).toBe(0);
    }
  });

  it("N13: import and forget touch only `installations`: no other database, no other localStorage key", async () => {
    const d = device({ [`${KEY}x`]: json(activatedA("x")), "wortly.pending.manual": json({ profileId: "x" }), "wortly.uiLanguage": "uk" });
    const w = d.window();
    await w.forget("x");
    expect(d.fake.database("wortly").version).toBe(0);
    expect(d.fake.database("wortly_journal").version).toBe(0);
    expect(d.legacy.map.get("wortly.pending.manual")).toBe(json({ profileId: "x" }));
    expect(d.legacy.calls.set + d.legacy.calls.remove).toBe(0);
  });
});

describe("§4 T3: after a known commit only applied or late", () => {
  it("a guard AND its report both throwing after the commit: late, settled once, the write stays", async () => {
    const d = device();
    let calls = 0;
    const report = vi.fn(() => { throw new Error("report broke"); });
    const store = idbInstallationStore(d.factory, d.legacy.getter, { report });
    const guard = () => { calls += 1; if (calls === 5) throw new Error("guard"); return true; };
    const state = track(store.mutate("p", guard, prepareA(record("p", "a"))));
    await drain();
    expect(state.error).toBeUndefined();
    expect(state.value).toEqual({ kind: "late", record: record("p", "a"), result: record("p", "a") });
    expect(report).toHaveBeenCalledOnce();
    expect(d.rows().get("p")).toEqual(record("p", "a"));
  });
});

describe("§5 the IndexedDB API reliably absent: a strict read-only legacy read, nothing else", () => {
  it("probe: absent only without the property or with undefined/null; a throwing getter or a non-factory is error", () => {
    expect(probeIndexedDb({})).toEqual({ kind: "absent" });
    expect(probeIndexedDb({ indexedDB: undefined })).toEqual({ kind: "absent" });
    expect(probeIndexedDb({ indexedDB: null })).toEqual({ kind: "absent" });
    expect(probeIndexedDb(Object.defineProperty({}, "indexedDB", { get() { throw new DOMException("denied", "SecurityError"); } })))
      .toEqual({ kind: "error" });
    expect(probeIndexedDb({ indexedDB: 5 })).toEqual({ kind: "error" });
    const factory = { open() { return null; } };
    expect(probeIndexedDb({ indexedDB: factory })).toEqual({ kind: "present", factory });
  });

  it("absent: mutate/read/forget unsupported; readLegacy reads the exact record strictly and writes nothing", async () => {
    const l = legacyStorage({ [`${KEY}p`]: json(activatedA("p")), [`${KEY}q`]: json(record("q", "b")),
      [`${KEY}r`]: json({ ...activatedA("r"), extra: 1 }), [`${KEY}s`]: "{bad", [`${KEY}t`]: json(activatedA("other")),
      [`${KEY}u`]: json(record("u", "c", { proof: "pu", proofVersion: "1" })) });
    const store = idbInstallationStore(probeIndexedDb({}), l.getter);
    expect(await store.mutate("p", () => true, prepareA(record("p", "x")))).toEqual({ kind: "unsupported", reason: "no-indexeddb" });
    expect(await store.read("p")).toEqual({ kind: "unsupported" });
    expect(await store.forget("p")).toEqual({ kind: "unsupported" });
    expect(await store.readLegacy("p")).toEqual({ kind: "found", record: activatedA("p"), openable: true });
    expect(await store.readLegacy("q")).toEqual({ kind: "found", record: record("q", "b"), openable: false }); // pending
    expect(await store.readLegacy("u")).toMatchObject({ kind: "found", openable: false }); // a proof, not activated
    expect(await store.readLegacy("r")).toEqual({ kind: "invalid" });
    expect(await store.readLegacy("s")).toEqual({ kind: "invalid" });
    expect(await store.readLegacy("t")).toEqual({ kind: "invalid" });
    expect(await store.readLegacy("P")).toEqual({ kind: "absent" });
    l.faults.getItem = `${KEY}p`;
    expect(await store.readLegacy("p")).toEqual({ kind: "error" });
    l.faults.getItem = undefined;
    l.faults.getter = true;
    expect(await store.readLegacy("p")).toEqual({ kind: "error" });
    expect(l.calls.set + l.calls.remove).toBe(0);
  });

  it("a present API (even unavailable) or a throwing getter: never a legacy fallback", async () => {
    const d = device({ [`${KEY}p`]: json(activatedA("p")) });
    d.fake.openBehaviour = "error";
    const present = d.window();
    expect(await present.mutate("p", () => true, prepareA(record("p", "x")))).toEqual({ kind: "unavailable", reason: "open-failed" });
    expect(await present.readLegacy("p")).toEqual({ kind: "not-allowed" });
    const broken = idbInstallationStore({ kind: "error" }, d.legacy.getter);
    expect(await broken.mutate("p", () => true, prepareA(record("p", "x")))).toEqual({ kind: "unavailable", reason: "api-error" });
    expect(await broken.read("p")).toEqual({ kind: "unavailable", reason: "api-error" });
    expect(await broken.readLegacy("p")).toEqual({ kind: "not-allowed" });
    expect(d.legacy.calls.get).toBe(0);
  });
});
