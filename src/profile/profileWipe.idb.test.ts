import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import { upgradeWrites } from "../app/installationIdb.test-support";
import { idbInstallationStore, INSTALLATION_DATABASE, INSTALLATION_STORE } from "../app/installationStoreIdb";
import type { ForgetOutcome, InstallationStore } from "../app/installationStore";
import { decideActivated, decideRegister } from "../app/installationWriters";
import type { AsyncStorage } from "../platform/storage";
import { browserStorage } from "../platform/storage";
import { DeletedProfileCleanup } from "./deletedProfileCleanup";
import { memoryStorage } from "./profileStorage.test-support";
import { wipeProfileRecords } from "./profileWipe";

/**
 * project_installation_store.md ред.1.5 §6, §9 (N8, N9, N11, N12; migration_project_step5.md ред.2): the cleanup of a
 * deleted profile X removes its installation record in IndexedDB first (forget, both spellings), then its localStorage
 * keys; «стёрто» only with forget "removed" and no local failure; the other profile Y is never touched.
 */
const X = "00000000-0000-4000-8000-0000000000AA", x = X.toLowerCase(), Y = "00000000-0000-4000-8000-0000000000bb";
const record = (profileId: string, activated = true) => ({ profileId, clientInstanceId: "11111111-1111-4111-8111-111111111111",
  registrationId: "22222222-2222-4222-8222-222222222222", proof: "proof", proofVersion: "1", activated });

function idb(seed: Record<string, unknown> = {}) {
  const fake = new FakeIndexedDb();
  const store = idbInstallationStore(upgradeWrites(fake), () => window.localStorage, { timeoutMs: 1_000, report: () => undefined });
  const rows = () => fake.rows(INSTALLATION_DATABASE, INSTALLATION_STORE);
  return {
    fake, store, rows,
    /** Opens the database (the upgrade imports localStorage as it is now), then puts the given rows as committed facts. */
    async ready() {
      await store.read(Y);
      for (const [key, value] of Object.entries(seed)) fake.seed(INSTALLATION_DATABASE, INSTALLATION_STORE, key, value);
    },
  };
}
const stub = (...answers: ForgetOutcome[]) => {
  const forget = vi.fn(async (): Promise<ForgetOutcome> => answers.length > 1 ? answers.shift()! : answers[0]);
  const store: InstallationStore = { forget, mutate: vi.fn(), read: vi.fn() } as unknown as InstallationStore;
  return { store, forget };
};

beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { window.localStorage.clear(); });

describe("N8: wipe X — IndexedDB first, then localStorage; «стёрто» only when both are clean", () => {
  it("(IDB ok, LS ok), both spellings: wiped; the rows of X go, the row and the keys of Y stay", async () => {
    const t = idb({ [X]: record(X), [x]: record(x), [Y]: record(Y) });
    await t.ready();
    const { storage, values } = memoryStorage({ [`wortly.installation:${X}`]: "{}", [`wortly.installation:${Y}`]: "{}",
      "wortly.pending.feedback": JSON.stringify({ profileId: Y }) });
    const result = await wipeProfileRecords(storage, X, t.store);
    expect(result).toMatchObject({ installation: { kind: "removed", count: 2 }, local: { failed: 0 }, wiped: true });
    expect(t.rows().has(X)).toBe(false);
    expect(t.rows().has(x)).toBe(false);
    expect(t.rows().get(Y)).toEqual(record(Y));
    expect(values.has(`wortly.installation:${X}`)).toBe(false);
    expect(values.get(`wortly.installation:${Y}`)).toBe("{}");
    expect(JSON.parse(values.get("wortly.pending.feedback")!)).toEqual({ profileId: Y });
  });

  it("(IDB ok, LS refused): the IDB row of X is gone, but it is not «стёрто»", async () => {
    const t = idb({ [X]: record(X) });
    await t.ready();
    const storage: AsyncStorage = { async get() { return "{}"; }, async set() { throw new Error("quota"); },
      async remove() { throw new Error("denied"); } };
    const result = await wipeProfileRecords(storage, X, t.store);
    expect(result.installation).toEqual({ kind: "removed", count: 1 });
    expect(result.local.failed).toBeGreaterThan(0);
    expect(result.wiped).toBe(false);
    expect(t.rows().has(X)).toBe(false);
  });

  it.each([[{ kind: "failed" }], [{ kind: "unknown" }], [{ kind: "unavailable", reason: "open-failed" }], [{ kind: "unsupported" }]] as const)(
    "(IDB %j, LS ok): the localStorage keys still go, never «стёрто» (N11)", async answer => {
      const { store } = stub(answer as ForgetOutcome);
      const { storage, values } = memoryStorage({ [`wortly.installation:${X}`]: "{}" });
      const result = await wipeProfileRecords(storage, X, store);
      expect(result.installation).toEqual(answer);
      expect(result.local).toEqual({ removed: 1, failed: 0 });
      expect(result.wiped).toBe(false);
      expect(values.has(`wortly.installation:${X}`)).toBe(false);
    });

  it("a forget that throws is an unknown answer, never «стёрто»", async () => {
    const store = { forget: vi.fn(async () => { throw new Error("boom"); }) } as unknown as InstallationStore;
    const result = await wipeProfileRecords(memoryStorage().storage, X, store);
    expect(result).toMatchObject({ installation: { kind: "unknown" }, wiped: false });
  });

  it("forget runs before any localStorage step (store §6 order)", async () => {
    const order: string[] = [];
    const store = { forget: vi.fn(async (): Promise<ForgetOutcome> => { order.push("forget"); return { kind: "removed", count: 0 }; }) } as unknown as InstallationStore;
    const inner = memoryStorage({ [`wortly.installation:${X}`]: "{}" }).storage;
    const storage: AsyncStorage = { get: key => { order.push("get"); return inner.get(key); }, set: inner.set,
      remove: key => { order.push("remove"); return inner.remove(key); } };
    await wipeProfileRecords(storage, X, store);
    expect(order[0]).toBe("forget");
    expect(order.filter(step => step === "forget")).toHaveLength(1);
  });
});

describe("N12: wipe before the installation database exists", () => {
  it("the first open imports the legacy record, then forget removes X: no X in IndexedDB, Y imported and kept", async () => {
    window.localStorage.setItem(`wortly.installation:${X}`, JSON.stringify(record(X)));
    window.localStorage.setItem(`wortly.installation:${Y}`, JSON.stringify(record(Y)));
    const t = idb();
    const result = await wipeProfileRecords(browserStorage(window.localStorage), X, t.store);
    expect(result.installation).toEqual({ kind: "removed", count: 1 });
    expect(result.wiped).toBe(true);
    expect(t.rows().has(X)).toBe(false);
    expect(t.rows().get(Y)).toEqual(record(Y));
    expect(window.localStorage.getItem(`wortly.installation:${X}`)).toBeNull();
    expect(window.localStorage.getItem(`wortly.installation:${Y}`)).not.toBeNull();
  });
});

describe("N9: a late register / activated of X after the wipe", () => {
  it("both are conflict «replaced» and write nothing", async () => {
    const t = idb({ [X]: record(X, false) });
    await t.ready();
    await wipeProfileRecords(memoryStorage().storage, X, t.store);
    const ids = { profileId: X, clientInstanceId: record(X).clientInstanceId, registrationId: record(X).registrationId };
    const register = await t.store.mutate(X, () => true, current => decideRegister(current, ids, { proof: "late", proofVersion: "2" }));
    const activated = await t.store.mutate(X, () => true, current => decideActivated(current, ids));
    expect(register).toMatchObject({ kind: "conflict", reason: "replaced" });
    expect(activated).toMatchObject({ kind: "conflict", reason: "replaced" });
    expect(t.rows().has(X)).toBe(false);
  });
});

describe("the repeat by knowledge (store §6; P04 (A)): unknown ≠ «стёрто» → the next trigger cleans again", () => {
  it("the first forget unknown, the repeat removed: wiped only after the repeat; every repeat checks again", async () => {
    const { store, forget } = stub({ kind: "unknown" }, { kind: "removed", count: 1 }, { kind: "removed", count: 0 });
    const { storage, writes } = memoryStorage({ [`wortly.installation:${X}`]: "{}" });
    const cleanup = new DeletedProfileCleanup(storage, store);
    await cleanup.note(X);
    expect(cleanup.last.get(X)?.wiped).toBe(false);
    await cleanup.retry();
    expect(cleanup.last.get(X)?.wiped).toBe(true);
    // No «X is clean» flag: the next trigger asks again (actual presence each time).
    await cleanup.retry();
    expect(forget).toHaveBeenCalledTimes(3);
    expect(cleanup.last.get(X)?.installation).toEqual({ kind: "removed", count: 0 });
    // No tombstone: the cleanup only ever removes keys.
    expect(writes.filter(key => !key.startsWith("-"))).toEqual([]);
  });

  it("knows nothing it was not told: a new page (a reload) repeats nothing (N11)", async () => {
    const { store, forget } = stub({ kind: "unknown" });
    const fresh = new DeletedProfileCleanup(memoryStorage().storage, store);
    await fresh.retry();
    expect(forget).not.toHaveBeenCalled();
  });

  it("calls during a running round coalesce into one more round, not a parallel one", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const forget = vi.fn(async (): Promise<ForgetOutcome> => { await gate; return { kind: "removed", count: 0 }; });
    const cleanup = new DeletedProfileCleanup(memoryStorage().storage, { forget } as unknown as InstallationStore);
    const first = cleanup.note(X);
    void cleanup.retry(); void cleanup.retry();
    release();
    await first;
    expect(forget).toHaveBeenCalledTimes(2);
  });

  it("only the profiles this page saw deleted: Y is never forgotten", async () => {
    const { store, forget } = stub({ kind: "removed", count: 1 });
    const cleanup = new DeletedProfileCleanup(memoryStorage().storage, store);
    await cleanup.note(X);
    await cleanup.retry();
    expect(forget.mock.calls.every(call => (call as unknown as string[])[0] === X)).toBe(true);
    expect(cleanup.knows(Y)).toBe(false);
  });
});
