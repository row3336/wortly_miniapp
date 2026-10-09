import { afterEach, describe, expect, it, vi } from "vitest";
import { SEND_BUDGET_STORE, WORTLY_DATABASE, WORTLY_DATABASE_VERSION } from "../platform/indexedDb";
import { FakeIndexedDb } from "./idbFake.test-support";
import { budgetVerdict, releaseKey, SendBudgetError, type BudgetBinding, type BudgetIdentity, type SlotClaim } from "./sendBudget";
import { IdbSendBudget, SEND_BUDGET_TIMEOUT_MS } from "./sendBudgetIdb";

/**
 * The IndexedDB adapter on the double of idbFake.test-support.ts (D-CP5 5.3.11–5.3.12). This checks how the adapter uses
 * the API — one transaction per operation, results on complete, strict durability, limits, no fallback. It does not
 * prove the behaviour of IndexedDB in a Telegram WebView: that is only proved on devices (D-CP5 5.5, Д1–Д13).
 */

const COMMAND = "00000000-0000-4000-8000-000000000001";
const PROFILE = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "00000000-0000-4000-8000-0000000000e1";
const identity: BudgetIdentity = {
  commandId: COMMAND, profileId: PROFILE, clientInstanceId: "00000000-0000-4000-8000-0000000000c1", pair: "ru-de",
  sessionId: SESSION, kind: "assignment.answer", intentHash: "a".repeat(64),
};
const binding: BudgetBinding = { ...identity, family: "primary", target: { field: "assignment_id", id: "00000000-0000-4000-8000-0000000000f1" } };
const attempt = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

async function drain(): Promise<void> {
  for (let round = 0; round < 300; round++) await Promise.resolve();
}
function track<T>(promise: Promise<T>): { settled: boolean; value?: T; error?: unknown } {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(value => { state.settled = true; state.value = value; }, error => { state.settled = true; state.error = error; });
  return state;
}
async function reason(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(SendBudgetError);
  return (error as SendBudgetError).reason;
}
const rows = (fake: FakeIndexedDb) => fake.rows(WORTLY_DATABASE, SEND_BUDGET_STORE);

afterEach(() => { vi.useRealTimers(); });

describe("IdbSendBudget — transactions (D-CP5 5.3.11)", () => {
  it("creates the version 1 store keyed by commandId on first open", async () => {
    const fake = new FakeIndexedDb();
    await IdbSendBudget.open(fake.factory);
    const database = fake.database(WORTLY_DATABASE);
    expect(database.version).toBe(WORTLY_DATABASE_VERSION);
    expect(database.stores.get(SEND_BUDGET_STORE)?.keyPath).toBe("commandId");
    expect(fake.log).toEqual([]);
  });

  it("runs every operation as exactly one transaction: read and write together, strict durability for writes", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    let claim: SlotClaim = { slot: 0, attempt: attempt(1) };
    const operations: Array<[string, () => Promise<unknown>, IDBTransactionMode, string[]]> = [
      ["createAndReserve", () => store.createAndReserve(binding, attempt(1), 1_000), "readwrite", ["getAllKeys", "getAll", "add"]],
      ["beginSending", () => store.beginSending(identity, claim), "readwrite", ["get", "put"]],
      ["markTransmitted", () => store.markTransmitted(identity, claim), "readwrite", ["get", "put"]],
      ["markRetryable", () => store.markRetryable(identity, claim), "readwrite", ["get", "put"]],
      ["reserve", async () => { const result = await store.reserve(identity, attempt(2)); if (result.outcome === "reserved") claim = result.claim; }, "readwrite", ["get", "put"]],
      ["release", () => store.release(identity, claim), "readwrite", ["get", "put"]],
      ["setMaintenance", () => store.setMaintenance(identity, true), "readwrite", ["get", "put"]],
      ["setLoss", () => store.setLoss(identity, { server: 9_000, next: 2, device: 8_000 }), "readwrite", ["get", "put"]],
      ["forbidSends", () => store.forbidSends(identity), "readwrite", ["get", "put"]],
      ["load", () => store.load(identity), "readonly", ["get"]],
      ["listOrphans", () => store.listOrphans(PROFILE, SESSION), "readonly", ["getAllKeys", "getAll"]],
      ["forgetHashOfOtherProfiles", () => store.forgetHashOfOtherProfiles("00000000-0000-4000-8000-0000000000a2"), "readwrite", ["getAll", "put"]],
      ["clear", () => store.clear(COMMAND, PROFILE), "readwrite", ["getAllKeys", "getAll", "delete"]],
      ["clearDamaged", () => store.clearDamaged(COMMAND), "readwrite", ["getAllKeys", "getAll"]],
    ];
    for (const [name, run, mode, requests] of operations) {
      const before = fake.log.length;
      await run();
      expect(fake.log.length, name).toBe(before + 1);
      expect(fake.log[before], name).toEqual({ id: before + 1, mode, durability: mode === "readwrite" ? "strict" : "default",
        requests, outcome: "complete" });
    }
    expect(rows(fake).size).toBe(0);
  });

  it("reports a result only after complete; until then nothing is visible to others", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    const resume = fake.holdCommits();
    const created = track(store.createAndReserve(binding, attempt(1), 1_000));
    await drain();
    expect(created.settled).toBe(false);
    expect(fake.log[0].outcome).toBe("pending");
    expect(rows(fake).size).toBe(0);
    resume();
    await drain();
    expect(created.value).toEqual({ outcome: "reserved", claim: { slot: 0, attempt: attempt(1) } });
    expect(rows(fake).size).toBe(1);
  });

  it("the gate before the request resolves only once sending is committed", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    await store.createAndReserve(binding, attempt(1), 1_000);
    const resume = fake.holdCommits();
    const gate = track(store.beginSending(identity, { slot: 0, attempt: attempt(1) }));
    await drain();
    expect(gate.settled).toBe(false);
    expect((rows(fake).get(COMMAND) as { slots: unknown[] }).slots[0]).toEqual({ state: "reserved", attempt: attempt(1) });
    resume();
    await drain();
    expect(gate.value).toBe(true);
  });

  it("an aborted transaction is an error and writes nothing", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    await store.createAndReserve(binding, attempt(1), 1_000);
    const before = rows(fake).get(COMMAND);
    fake.failNext("abort_on_commit");
    expect(await reason(store.reserve(identity, attempt(2)))).toBe("failed");
    expect(rows(fake).get(COMMAND)).toEqual(before);
    fake.failNext("abort_on_commit");
    expect(await reason(store.createAndReserve({ ...binding, commandId: "00000000-0000-4000-8000-000000000002" }, attempt(3), 1_000))).toBe("failed");
    expect(rows(fake).size).toBe(1);
    expect(fake.log.slice(-2).map(entry => entry.outcome)).toEqual(["abort", "abort"]);
  });

  it("a transaction that cannot be created is an error", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    fake.failNext("throw_on_create");
    expect(await reason(store.load(identity))).toBe("failed");
  });

  it("two windows on one database racing for the next send: exactly one reservation wins", async () => {
    const fake = new FakeIndexedDb();
    const first = await IdbSendBudget.open(fake.factory);
    const second = await IdbSendBudget.open(fake.factory);
    const claim = { slot: 0, attempt: attempt(1) };
    await first.createAndReserve(binding, claim.attempt, 1_000);
    await first.beginSending(identity, claim);
    await first.markTransmitted(identity, claim);
    await first.markRetryable(identity, claim);
    const results = await Promise.all([2, 3, 4, 5, 6, 7].map(n => (n % 2 ? first : second).reserve(identity, attempt(n))));
    expect(results.filter(result => result.outcome === "reserved")).toEqual([{ outcome: "reserved", claim: { slot: 1, attempt: attempt(2) } }]);
    expect(results.filter(result => result.outcome === "unsettled")).toHaveLength(5);
    expect(await second.load(identity)).toMatchObject({ occupied: 2, transmitted: 1, unsettled: 1 });
  });

  it("two windows creating the same command at once: one reserves, the other finds it", async () => {
    const fake = new FakeIndexedDb();
    const first = await IdbSendBudget.open(fake.factory);
    const second = await IdbSendBudget.open(fake.factory);
    const outcomes = await Promise.all([first.createAndReserve(binding, attempt(1), 1_000), second.createAndReserve(binding, attempt(2), 1_001)]);
    expect(outcomes).toEqual([{ outcome: "reserved", claim: { slot: 0, attempt: attempt(1) } }, { outcome: "exists" }]);
    expect(await second.load(identity)).toMatchObject({ occupied: 1 });
  });

  it("another window continues the count the first one left (2.5.1)", async () => {
    const fake = new FakeIndexedDb();
    const first = await IdbSendBudget.open(fake.factory);
    const claim = { slot: 0, attempt: attempt(1) };
    await first.createAndReserve(binding, claim.attempt, 1_000);
    await first.beginSending(identity, claim);
    await first.markTransmitted(identity, claim);
    await first.markRetryable(identity, claim);
    const second = await IdbSendBudget.open(fake.factory);
    expect(await second.load(identity)).toMatchObject({ occupied: 1, transmitted: 1, unsettled: 0 });
    expect(await second.reserve(identity, attempt(2))).toEqual({ outcome: "reserved", claim: { slot: 1, attempt: attempt(2) } });
  });
});

describe("IdbSendBudget — the sixth send refused, its ban not written (QA Н1, C081)", () => {
  /** Five sends with a retryable outcome, then a sixth that the server refused. */
  async function sixthRefused(fake: FakeIndexedDb): Promise<IdbSendBudget> {
    const store = await IdbSendBudget.open(fake.factory);
    for (let n = 1; n <= 6; n++) {
      const reserved = n === 1 ? await store.createAndReserve(binding, attempt(n), 1_000) : await store.reserve(identity, attempt(n));
      if (reserved.outcome !== "reserved") throw new Error(`send ${n}: ${reserved.outcome}`);
      expect(await store.beginSending(identity, reserved.claim)).toBe(true);
      expect(await store.markTransmitted(identity, reserved.claim)).toBe(true);
      if (n < 6) expect(await store.markRetryable(identity, reserved.claim)).toBe(true);
    }
    return store;
  }
  async function noDerivedSend(fake: FakeIndexedDb): Promise<void> {
    const reopened = await IdbSendBudget.open(fake.factory);
    const summary = await reopened.load(identity);
    expect(summary).toMatchObject({ occupied: 6, transmitted: 6, unsettled: 1, forbidden: false });
    // Not exhausted: no closing C and no cancel of a start may be derived; no seventh send of X either.
    expect(budgetVerdict(summary)).toBe("unconfirmed");
    expect(await reopened.reserve(identity, attempt(7))).toEqual({ outcome: "no_slots" });
  }

  it.each(["abort_on_commit", "throw_on_create"] as const)("the ban fails (%s), a new instance: not exhausted, nothing sent", async (fault) => {
    const fake = new FakeIndexedDb();
    const store = await sixthRefused(fake);
    fake.failNext(fault);
    expect(await reason(store.forbidSends(identity))).toBe("failed");
    await noDerivedSend(fake);
  });

  it("the ban hangs past the limit, a new instance: not exhausted, nothing sent", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeIndexedDb();
    const store = await sixthRefused(fake);
    fake.failNext("hang");
    const banning = track(store.forbidSends(identity));
    await vi.advanceTimersByTimeAsync(SEND_BUDGET_TIMEOUT_MS);
    await drain();
    expect((banning.error as SendBudgetError).reason).toBe("timeout");
    await noDerivedSend(fake);
  });

  it("positive control: six sends with retryable outcomes are exhausted in a new instance", async () => {
    const fake = new FakeIndexedDb();
    const store = await sixthRefused(fake);
    expect(await store.markRetryable(identity, { slot: 5, attempt: attempt(6) })).toBe(true);
    const reopened = await IdbSendBudget.open(fake.factory);
    expect(budgetVerdict(await reopened.load(identity))).toBe("exhausted");
  });
});

describe("IdbSendBudget — release of damaged records (C075 table 4.1)", () => {
  const NEW_SESSION = "00000000-0000-4000-8000-0000000000e3";
  const START = "00000000-0000-4000-8000-000000000009";
  const DAMAGED = "00000000-0000-4000-8000-00000000000d";
  const start: BudgetBinding = { ...binding, commandId: START, sessionId: NEW_SESSION, kind: "session.start",
    target: { field: "session_id", id: NEW_SESSION } };
  const releaseAt = releaseKey(PROFILE, NEW_SESSION);
  const damage = (fake: FakeIndexedDb) => fake.seed(WORTLY_DATABASE, SEND_BUDGET_STORE, DAMAGED, { commandId: DAMAGED, slots: "x" });

  it("4.1.2: the start of N and its release are one transaction", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    damage(fake);
    const before = fake.log.length;
    expect(await store.createAndReserve(start, attempt(1), 1_000, [DAMAGED])).toMatchObject({ outcome: "reserved" });
    expect(fake.log.slice(before)).toEqual([expect.objectContaining({ mode: "readwrite", durability: "strict",
      requests: ["getAllKeys", "getAll", "add", "add"], outcome: "complete" })]);
    expect(rows(fake).get(releaseAt)).toMatchObject({ keys: [DAMAGED] });
  });

  it.each(["abort_on_commit", "throw_on_create"] as const)(
    "4.1.2: the start with its release fails (%s): neither is written, and the gate stays shut", async (fault) => {
      const fake = new FakeIndexedDb();
      const store = await IdbSendBudget.open(fake.factory);
      damage(fake);
      fake.failNext(fault);
      expect(await reason(store.createAndReserve(start, attempt(1), 1_000, [DAMAGED]))).toBe("failed");
      expect(rows(fake).has(START)).toBe(false);
      expect(rows(fake).has(releaseAt)).toBe(false);
      expect(await store.beginSending(start, { slot: 0, attempt: attempt(1) })).toBe(false);
      expect(await store.createAndReserve({ ...binding, sessionId: NEW_SESSION }, attempt(2), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    });

  it("4.1.2: the start with its release hangs past the limit: neither is written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    damage(fake);
    fake.failNext("hang");
    const starting = track(store.createAndReserve(start, attempt(1), 1_000, [DAMAGED]));
    await vi.advanceTimersByTimeAsync(SEND_BUDGET_TIMEOUT_MS);
    await drain();
    expect((starting.error as SendBudgetError).reason).toBe("timeout");
    expect(rows(fake).has(START)).toBe(false);
    expect(rows(fake).has(releaseAt)).toBe(false);
  });

  it("4.1.3: another window checks the ban in the same transaction as its create", async () => {
    const fake = new FakeIndexedDb();
    const first = await IdbSendBudget.open(fake.factory);
    const second = await IdbSendBudget.open(fake.factory);
    damage(fake);
    const inN = { ...binding, sessionId: NEW_SESSION };
    // The second window's transaction is queued before the start's.
    const [early, started] = await Promise.all([second.createAndReserve(inN, attempt(2), 1_000),
      first.createAndReserve(start, attempt(1), 1_000, [DAMAGED])]);
    expect(started).toMatchObject({ outcome: "reserved" });
    // Queued before the start's transaction: still blocked, and nothing was written for it.
    expect(early).toEqual({ outcome: "blocked_by_damage" });
    expect(rows(fake).has(COMMAND)).toBe(false);
    expect(await second.createAndReserve(inN, attempt(3), 1_000)).toMatchObject({ outcome: "reserved" });
    expect(await second.createAndReserve({ ...binding, commandId: "00000000-0000-4000-8000-000000000005" }, attempt(4), 1_000))
      .toEqual({ outcome: "blocked_by_damage" });
  });

  it("4.1.5: clearDamaged deletes the record and rewrites the release in one transaction", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    damage(fake);
    expect(await store.createAndReserve(start, attempt(1), 1_000, [DAMAGED])).toMatchObject({ outcome: "reserved" });
    const before = fake.log.length;
    expect(await store.clearDamaged(DAMAGED)).toBe(true);
    expect(fake.log.slice(before)).toEqual([expect.objectContaining({ requests: ["getAllKeys", "getAll", "delete", "delete"], outcome: "complete" })]);
    expect(rows(fake).has(DAMAGED)).toBe(false);
    expect(rows(fake).has(releaseAt)).toBe(false);
  });

  it("4.1.5: a failed clearDamaged changes neither the record nor the release", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    damage(fake);
    expect(await store.createAndReserve(start, attempt(1), 1_000, [DAMAGED])).toMatchObject({ outcome: "reserved" });
    fake.failNext("abort_on_commit");
    expect(await reason(store.clearDamaged(DAMAGED))).toBe("failed");
    expect(rows(fake).has(DAMAGED)).toBe(true);
    expect(rows(fake).get(releaseAt)).toMatchObject({ keys: [DAMAGED] });
  });

  it("Н3: listOrphans takes a damaged record's key from the store", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    fake.seed(WORTLY_DATABASE, SEND_BUDGET_STORE, DAMAGED, { commandId: COMMAND, profileId: PROFILE, sessionId: SESSION, slots: [] });
    expect(await store.listOrphans(PROFILE, SESSION)).toEqual([{ commandId: DAMAGED, damaged: true, kind: null, family: null,
      target: null, intentHash: null, started: true, forbidden: true, occupied: null, transmitted: null }]);
  });
});

describe("IdbSendBudget — damaged values (QA Н5)", () => {
  it("forgetHashOfOtherProfiles drops the fingerprint of a value whose key is not a string", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    fake.seed(WORTLY_DATABASE, SEND_BUDGET_STORE, 42, { commandId: 42, profileId: "00000000-0000-4000-8000-0000000000a2", intentHash: "a".repeat(64) });
    expect(await store.forgetHashOfOtherProfiles(PROFILE)).toBe(1);
    expect(rows(fake).get(42)).toEqual({ commandId: 42, profileId: "00000000-0000-4000-8000-0000000000a2", damaged: true });
    expect(rows(fake).size).toBe(1);
  });
});

describe("IdbSendBudget — the ban on new sends (C053)", () => {
  it("ban, then a new instance on the same database (reload, another window): still forbidden", async () => {
    const fake = new FakeIndexedDb();
    const first = await IdbSendBudget.open(fake.factory);
    await first.createAndReserve(binding, attempt(1), 1_000);
    expect(await first.forbidSends(identity)).toBe(true);
    const second = await IdbSendBudget.open(fake.factory);
    expect(await second.load(identity)).toMatchObject({ occupied: 1, forbidden: true });
    expect(await second.reserve(identity, attempt(2))).toEqual({ outcome: "forbidden" });
    expect(await second.beginSending(identity, { slot: 0, attempt: attempt(1) })).toBe(false);
    const before = fake.log.length;
    expect(await second.createAndReserve(binding, attempt(3), 2_000)).toEqual({ outcome: "forbidden" });
    expect(fake.log.slice(before)).toEqual([expect.objectContaining({ mode: "readwrite", requests: ["getAllKeys", "getAll", "add", "get"], outcome: "complete" })]);
  });

  /** A sent command whose POST the server refused: the page now tries to write the ban. */
  async function refusedAfterSend(fake: FakeIndexedDb): Promise<{ store: IdbSendBudget; claim: SlotClaim }> {
    const store = await IdbSendBudget.open(fake.factory);
    const claim = { slot: 0, attempt: attempt(1) };
    await store.createAndReserve(binding, claim.attempt, 1_000);
    expect(await store.beginSending(identity, claim)).toBe(true);
    expect(await store.markTransmitted(identity, claim)).toBe(true);
    return { store, claim };
  }
  /** What another window or the page after a reload sees: a fresh adapter on the same database. */
  async function noSendInAnotherWindow(fake: FakeIndexedDb, claim: SlotClaim): Promise<void> {
    const reopened = await IdbSendBudget.open(fake.factory);
    const summary = await reopened.load(identity);
    expect(summary).toMatchObject({ occupied: 1, transmitted: 1, unsettled: 1, forbidden: false });
    expect(budgetVerdict(summary)).toBe("unsettled");
    expect(await reopened.reserve(identity, attempt(2))).toEqual({ outcome: "unsettled" });
    expect(await reopened.beginSending(identity, claim)).toBe(false);
    expect(await reopened.createAndReserve(binding, attempt(3), 2_000)).toEqual({ outcome: "exists" });
    // No failure path deletes the record: it stays as the proof that a send left (9.2, Е02).
    expect(rows(fake).get(COMMAND)).toMatchObject({ slots: [{ state: "transmitted", attempt: attempt(1) }, ...Array(5).fill({ state: "empty" })] });
  }

  it.each(["abort_on_commit", "throw_on_create"] as const)(
    "C060: POST refused, the ban fails to commit (%s): a new instance on the same database still sends nothing", async (fault) => {
      const fake = new FakeIndexedDb();
      const { store, claim } = await refusedAfterSend(fake);
      fake.failNext(fault);
      expect(await reason(store.forbidSends(identity))).toBe("failed");
      expect(rows(fake).get(COMMAND)).not.toHaveProperty("sendBan");
      expect(await store.reserve(identity, attempt(2))).toEqual({ outcome: "unsettled" });
      await noSendInAnotherWindow(fake, claim);
    });

  it("C060: POST refused, the ban write hangs past the limit: a new instance still sends nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeIndexedDb();
    const { store, claim } = await refusedAfterSend(fake);
    fake.failNext("hang");
    const banning = track(store.forbidSends(identity));
    await vi.advanceTimersByTimeAsync(SEND_BUDGET_TIMEOUT_MS);
    await drain();
    expect((banning.error as SendBudgetError).reason).toBe("timeout");
    await noSendInAnotherWindow(fake, claim);
  });
});

describe("IdbSendBudget — limits and an unavailable store (D-CP5 5.3.12, 9.1)", () => {
  it("an open that does not answer within the limit is an unavailable store; a late connection is closed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeIndexedDb();
    fake.openBehaviour = "hang";
    const opening = track(IdbSendBudget.open(fake.factory));
    await vi.advanceTimersByTimeAsync(SEND_BUDGET_TIMEOUT_MS - 1);
    expect(opening.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect((opening.error as SendBudgetError).reason).toBe("unavailable");
    fake.finishHungOpens();
    await drain();
    expect(fake.connections).toHaveLength(1);
    expect(fake.connections[0].closed).toBe(true);
  });

  it.each([
    ["no IndexedDB at all", undefined],
    ["the open request fails", "error"],
    ["the open call throws", "throw"],
    ["a newer version exists", "newer"],
  ] as const)("%s: unavailable, and no fallback store is given", async (_label, kind) => {
    const fake = new FakeIndexedDb();
    if (kind === "error" || kind === "throw") fake.openBehaviour = kind;
    if (kind === "newer") fake.database(WORTLY_DATABASE).version = WORTLY_DATABASE_VERSION + 1;
    expect(await reason(IdbSendBudget.open(kind === undefined ? undefined : fake.factory))).toBe("unavailable");
  });

  it("the default limit is 5 s (RD 7.5) for opening and for a transaction", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeIndexedDb();
    fake.openBehaviour = "hang";
    const opening = track(IdbSendBudget.open(fake.factory));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(opening.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect((opening.error as SendBudgetError).reason).toBe("unavailable");

    const other = new FakeIndexedDb();
    const store = await IdbSendBudget.open(other.factory);
    other.failNext("hang");
    const stuck = track(store.load(identity));
    await vi.advanceTimersByTimeAsync(4_999);
    await drain();
    expect(stuck.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect((stuck.error as SendBudgetError).reason).toBe("timeout");
  });

  it("jsdom has no IndexedDB: the default open is unavailable", async () => {
    expect(globalThis.indexedDB).toBeUndefined();
    expect(await reason(IdbSendBudget.open())).toBe("unavailable");
  });

  it("a transaction that does not answer within the limit is an unknown result, and the next one goes on", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    await store.createAndReserve(binding, attempt(1), 1_000);
    const before = rows(fake).get(COMMAND);
    fake.failNext("hang");
    const stuck = track(store.reserve(identity, attempt(2)));
    await vi.advanceTimersByTimeAsync(SEND_BUDGET_TIMEOUT_MS - 1);
    await drain();
    expect(stuck.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await drain();
    expect((stuck.error as SendBudgetError).reason).toBe("timeout");
    expect(rows(fake).get(COMMAND)).toEqual(before);
    expect(await store.load(identity)).toMatchObject({ occupied: 1 });
  });

  it("a versionchange from a newer window closes the connection; later operations are unavailable", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    fake.requestVersionChange();
    expect(fake.connections[0].closed).toBe(true);
    expect(await reason(store.load(identity))).toBe("unavailable");
  });

  it("a connection closed by the browser makes later operations unavailable", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    fake.closeByBrowser();
    expect(await reason(store.reserve(identity, attempt(1)))).toBe("unavailable");
  });
});
