// C556 В1: the manual attempt of a closure C after its six automatic sends (Q30 of 08.10, CON §6.1 п.8) in the store of
// CP5a — both implementations. The six automatic slots never change, no automatic send can take the manual cell, one
// press holds one attempt P, and a late handler of an older P touches nothing.
import { describe, expect, it } from "vitest";
import { WORTLY_DATABASE, SEND_BUDGET_STORE } from "../platform/indexedDb";
import { FakeIndexedDb } from "./idbFake.test-support";
import {
  budgetVerdict, copyBudgetRecord, MANUAL_SLOT, MemorySendBudget, SendBudgetError, validBudgetRecord,
  type BudgetBinding, type BudgetIdentity, type SendBudgetRecord, type SendBudgetStore, type SlotClaim, type StoreKey,
} from "./sendBudget";
import { IdbSendBudget } from "./sendBudgetIdb";

const C = "00000000-0000-4000-8000-0000000000c0";
const PROFILE = "00000000-0000-4000-8000-0000000000a1";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const SESSION = "00000000-0000-4000-8000-0000000000e1";
const HASH = "c".repeat(64);
const attempt = (n: number) => `20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const identity: BudgetIdentity = { commandId: C, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", sessionId: SESSION,
  kind: "session.stop", intentHash: HASH };
const closure: BudgetBinding = { ...identity, family: "stop", target: { field: "session_id", id: SESSION } };

type Subject = { store: SendBudgetStore; seed(commandId: StoreKey, value: unknown): void; peek(commandId: StoreKey): unknown };
const SUBJECTS: Array<[string, () => Promise<Subject>]> = [
  ["MemorySendBudget", async () => {
    const store = new MemorySendBudget();
    return { store, seed: (id, value) => store.seed(id, value), peek: id => store.peek(id) };
  }],
  ["IdbSendBudget on the fake", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    return { store, seed: (id, value) => fake.seed(WORTLY_DATABASE, SEND_BUDGET_STORE, id, value),
      peek: id => fake.rows(WORTLY_DATABASE, SEND_BUDGET_STORE).get(id) };
  }],
];

/** The six automatic sends of C, each sent and written retryable (or the last one only transmitted). */
async function spend(store: SendBudgetStore, binding: BudgetBinding = closure, lastRetryable = true): Promise<void> {
  const own: BudgetIdentity = { ...binding };
  for (let n = 1; n <= 6; n++) {
    const result = n === 1 ? await store.createAndReserve(binding, attempt(n), 1_000) : await store.reserve(own, attempt(n));
    if (result.outcome !== "reserved") throw new Error(`no slot ${n}: ${result.outcome}`);
    expect(await store.beginSending(own, result.claim)).toBe(true);
    expect(await store.markTransmitted(own, result.claim)).toBe(true);
    if (n < 6 || lastRetryable) expect(await store.markRetryable(own, result.claim)).toBe(true);
  }
}
async function walkManual(store: SendBudgetStore, claim: SlotClaim, to: "sending" | "transmitted" | "retryable"): Promise<void> {
  expect(await store.beginSending(identity, claim)).toBe(true);
  if (to !== "sending") expect(await store.markTransmitted(identity, claim)).toBe(true);
  if (to === "retryable") expect(await store.markRetryable(identity, claim)).toBe(true);
}
const slotsOf = (value: unknown) => structuredClone((value as SendBudgetRecord).slots);

describe.each(SUBJECTS)("the manual attempt of a closure C (C556 В1) — %s", (_name, make) => {
  it("is refused before the six automatic sends are provably spent", async () => {
    const { store } = await make();
    expect(await store.reserveManual(identity, attempt(9))).toEqual({ outcome: "unknown" });
    expect(await store.createAndReserve(closure, attempt(1), 1_000)).toMatchObject({ outcome: "reserved" });
    expect(await store.reserveManual(identity, attempt(9))).toEqual({ outcome: "unsettled" });
    const second = await make();
    await spend(second.store, closure, false);
    // Six taken, the last one sent but its outcome not written: not exhausted, so no manual press either.
    expect(budgetVerdict(await second.store.load(identity))).toBe("unconfirmed");
    expect(await second.store.reserveManual(identity, attempt(9))).toEqual({ outcome: "unsettled" });
  });

  it("after the spent budget takes its own cell; the six automatic slots stay exactly as they were", async () => {
    const { store, peek } = await make();
    await spend(store);
    expect(budgetVerdict(await store.load(identity))).toBe("exhausted");
    const before = slotsOf(peek(C));
    const reserved = await store.reserveManual(identity, attempt(9));
    expect(reserved).toEqual({ outcome: "reserved", claim: { slot: MANUAL_SLOT, attempt: attempt(9) } });
    expect(slotsOf(peek(C))).toEqual(before);
    expect((peek(C) as SendBudgetRecord).manual).toEqual({ state: "reserved", attempt: attempt(9) });
    const summary = await store.load(identity);
    expect(summary).toMatchObject({ occupied: 6, transmitted: 6, unsettled: 0, manualUnsettled: true });
    // While the press is under way the outcome is unknown again: no exhaustion (no second press), only checks.
    expect(budgetVerdict(summary)).toBe("unconfirmed");
    // No automatic send can take anything: the six are spent, the manual cell is no seventh slot.
    expect(await store.reserve(identity, attempt(10))).toEqual({ outcome: "no_slots" });
    if (reserved.outcome !== "reserved") throw new Error("not reserved");
    await walkManual(store, reserved.claim, "retryable");
    expect(slotsOf(peek(C))).toEqual(before);
    expect(budgetVerdict(await store.load(identity))).toBe("exhausted");
  });

  it("one press at a time: a manual attempt under way refuses the next; a retryable one is replaced by the new P", async () => {
    const { store, peek } = await make();
    await spend(store);
    const first = await store.reserveManual(identity, attempt(9));
    if (first.outcome !== "reserved") throw new Error("not reserved");
    for (const to of ["sending", "transmitted"] as const) {
      if (to === "sending") expect(await store.beginSending(identity, first.claim)).toBe(true);
      else expect(await store.markTransmitted(identity, first.claim)).toBe(true);
      expect(await store.reserveManual(identity, attempt(10))).toEqual({ outcome: "unsettled" });
    }
    expect(await store.markRetryable(identity, first.claim)).toBe(true);
    const second = await store.reserveManual(identity, attempt(10));
    expect(second).toEqual({ outcome: "reserved", claim: { slot: MANUAL_SLOT, attempt: attempt(10) } });
    // A late handler of the older P finds no cell of its own: nothing moves.
    for (const move of [store.beginSending, store.markTransmitted, store.markRetryable, store.release] as const) {
      expect(await move.call(store, identity, first.claim)).toBe(false);
    }
    expect((peek(C) as SendBudgetRecord).manual).toEqual({ state: "reserved", attempt: attempt(10) });
    // The same P twice is never a new press.
    if (second.outcome !== "reserved") throw new Error("not reserved");
    await walkManual(store, second.claim, "retryable");
    expect(await store.reserveManual(identity, attempt(10))).toEqual({ outcome: "unsettled" });
    expect(await store.reserveManual(identity, attempt(3))).toEqual({ outcome: "unsettled" });
  });

  it("release gives back only a reserved manual P; after sending it stays", async () => {
    const { store, peek } = await make();
    await spend(store);
    const press = await store.reserveManual(identity, attempt(9));
    if (press.outcome !== "reserved") throw new Error("not reserved");
    expect(await store.release(identity, press.claim)).toBe(true);
    expect((peek(C) as SendBudgetRecord).manual).toEqual({ state: "released" });
    expect(budgetVerdict(await store.load(identity))).toBe("exhausted");
    const again = await store.reserveManual(identity, attempt(11));
    if (again.outcome !== "reserved") throw new Error("not reserved");
    expect(await store.beginSending(identity, again.claim)).toBe(true);
    expect(await store.release(identity, again.claim)).toBe(false);
    expect((peek(C) as SendBudgetRecord).manual).toEqual({ state: "sending", attempt: attempt(11) });
  });

  it("the ban outranks the press, and only the closure of the same envelope may press", async () => {
    const { store } = await make();
    await spend(store);
    const press = await store.reserveManual(identity, attempt(9));
    if (press.outcome !== "reserved") throw new Error("not reserved");
    expect(await store.forbidSends(identity)).toBe(true);
    expect(await store.beginSending(identity, press.claim)).toBe(false);
    expect(await store.reserveManual(identity, attempt(12))).toEqual({ outcome: "forbidden" });
    const other = await make();
    const answer: BudgetBinding = { ...closure, kind: "answer.submit", family: "primary", target: { field: "assignment_id", id: SESSION } };
    await spend(other.store, answer);
    expect(budgetVerdict(await other.store.load({ ...answer }))).toBe("exhausted");
    // A study action has no manual send (Я15): its spent budget never opens a manual cell.
    expect(await other.store.reserveManual({ ...answer }, attempt(9))).toEqual({ outcome: "unknown" });
    expect(await other.store.reserveManual({ ...identity, intentHash: "d".repeat(64) }, attempt(9))).toEqual({ outcome: "unknown" });
  });

  it("a claim beyond the manual cell is a programming error", async () => {
    const { store } = await make();
    expect(() => store.beginSending(identity, { slot: MANUAL_SLOT + 1, attempt: attempt(1) })).toThrow(SendBudgetError);
  });

  it("the guard of a lost envelope sees a manual send that may have left", async () => {
    const { store } = await make();
    await spend(store);
    const press = await store.reserveManual(identity, attempt(9));
    if (press.outcome !== "reserved") throw new Error("not reserved");
    expect(await store.beginSending(identity, press.claim)).toBe(true);
    expect(await store.listOrphans(PROFILE, SESSION)).toMatchObject([{ commandId: C, started: true, occupied: 6, transmitted: 6 }]);
  });
});

describe("the format of the manual cell (D-CP5 2.2 + C556 В1)", () => {
  const record = (manual?: unknown): Record<string, unknown> => ({
    schemaVersion: 1, commandId: C, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", sessionId: SESSION,
    kind: "session.stop", intentHash: HASH, family: "stop", target: { field: "session_id", id: SESSION },
    slots: Array.from({ length: 6 }, (_, n) => ({ state: "retryable", attempt: attempt(n + 1) })), createdAt: 1_000,
    ...(manual === undefined ? {} : { manual }),
  });
  it("accepts one cell of the known states; refuses another state, a repeated attempt or a malformed one", () => {
    for (const manual of [undefined, { state: "released" }, { state: "reserved", attempt: attempt(9) },
      { state: "sending", attempt: attempt(9) }, { state: "transmitted", attempt: attempt(9) }, { state: "retryable", attempt: attempt(9) }]) {
      expect(validBudgetRecord(record(manual))).toBe(true);
    }
    for (const manual of [{ state: "lost" }, { state: "reserved" }, { state: "empty", attempt: attempt(9) },
      { state: "reserved", attempt: attempt(1) }, { state: "reserved", attempt: "9" }, null, "reserved", [{ state: "released" }]]) {
      expect(validBudgetRecord(record(manual))).toBe(false);
    }
  });
  it("copies stably with and without the cell", () => {
    for (const manual of [undefined, { state: "transmitted", attempt: attempt(9) }]) {
      const value = record(manual) as SendBudgetRecord;
      expect(copyBudgetRecord(value)).toEqual(value);
      expect(JSON.stringify(copyBudgetRecord(copyBudgetRecord(value)))).toBe(JSON.stringify(copyBudgetRecord(value)));
    }
  });
  it("a Learning preview is a step of its own (target preview_id)", () => {
    expect(validBudgetRecord({ ...record(), kind: "learning.preview_next", family: "primary",
      target: { field: "preview_id", id: SESSION } })).toBe(true);
  });
});
