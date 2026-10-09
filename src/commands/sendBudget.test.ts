import { describe, expect, it } from "vitest";
import { WORTLY_DATABASE, SEND_BUDGET_STORE } from "../platform/indexedDb";
import { FakeIndexedDb } from "./idbFake.test-support";
import {
  budgetVerdict, MemorySendBudget, releaseKey, SendBudgetError, validBudgetRecord,
  type BudgetBinding, type BudgetIdentity, type SendBudgetStore, type SlotClaim,
} from "./sendBudget";
import { IdbSendBudget } from "./sendBudgetIdb";

const COMMAND = "00000000-0000-4000-8000-000000000001";
const OTHER_COMMAND = "00000000-0000-4000-8000-000000000002";
const PROFILE = "00000000-0000-4000-8000-0000000000a1";
const OTHER_PROFILE = "00000000-0000-4000-8000-0000000000a2";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const SESSION = "00000000-0000-4000-8000-0000000000e1";
const OTHER_SESSION = "00000000-0000-4000-8000-0000000000e2";
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000f1";
const HASH = "a".repeat(64);
const attempt = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const NEW_SESSION = "00000000-0000-4000-8000-0000000000e3";
const START = "00000000-0000-4000-8000-000000000009";
const DAMAGED = "00000000-0000-4000-8000-00000000000d";
const SECOND_DAMAGED = "00000000-0000-4000-8000-00000000000e";
const START2 = "00000000-0000-4000-8000-00000000000a";

const identity: BudgetIdentity = {
  commandId: COMMAND, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", sessionId: SESSION,
  kind: "assignment.answer", intentHash: HASH,
};
const binding: BudgetBinding = { ...identity, family: "primary", target: { field: "assignment_id", id: ASSIGNMENT } };
const other = (commandId: string, profileId: string, sessionId = SESSION): BudgetBinding =>
  ({ ...binding, commandId, profileId, sessionId });

type Subject = { store: SendBudgetStore; seed(commandId: string, value: unknown): void; peek(commandId: string): unknown };
const SUBJECTS: Array<[string, () => Promise<Subject>]> = [
  ["MemorySendBudget", async () => {
    const store = new MemorySendBudget();
    return { store, seed: (id, value) => store.seed(id, value), peek: id => store.peek(id) };
  }],
  ["IdbSendBudget on the fake", async () => {
    const fake = new FakeIndexedDb();
    const store = await IdbSendBudget.open(fake.factory);
    return {
      store,
      seed: (id, value) => fake.seed(WORTLY_DATABASE, SEND_BUDGET_STORE, id, value),
      peek: id => fake.rows(WORTLY_DATABASE, SEND_BUDGET_STORE).get(id),
    };
  }],
];

/** Takes the next slot and walks it to the given state; returns its claim. Earlier slots must be retryable. */
async function walk(store: SendBudgetStore, n: number, to: "reserved" | "sending" | "transmitted" | "retryable"): Promise<SlotClaim> {
  const result = n === 1 ? await store.createAndReserve(binding, attempt(n), 1_000) : await store.reserve(identity, attempt(n));
  if (result.outcome !== "reserved") throw new Error(`no slot for attempt ${n}: ${result.outcome}`);
  if (to !== "reserved") expect(await store.beginSending(identity, result.claim)).toBe(true);
  if (to === "transmitted" || to === "retryable") expect(await store.markTransmitted(identity, result.claim)).toBe(true);
  if (to === "retryable") expect(await store.markRetryable(identity, result.claim)).toBe(true);
  return result.claim;
}
const slot = (state: string, n?: number) => n === undefined ? { state } : { state, attempt: attempt(n) };

/** A valid record with two transmitted slots and one reserved, used as the base of every corruption. */
function baseRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1, commandId: COMMAND, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", sessionId: SESSION,
    kind: "assignment.answer", intentHash: HASH, family: "primary", target: { field: "assignment_id", id: ASSIGNMENT },
    slots: [
      { state: "transmitted", attempt: attempt(1) }, { state: "transmitted", attempt: attempt(2) },
      { state: "reserved", attempt: attempt(3) }, { state: "empty" }, { state: "released" }, { state: "empty" },
    ],
    createdAt: 1_000,
  };
}
const damagedValue: Record<string, unknown> = {
  schemaVersion: 1, commandId: DAMAGED, profileId: PROFILE, clientInstanceId: CLIENT, pair: "ru-de", sessionId: SESSION,
  kind: "assignment.answer", intentHash: HASH, family: "primary", target: { field: "assignment_id", id: ASSIGNMENT },
  slots: [{ state: "transmitted", attempt: attempt(90) }, { state: "lost" }], createdAt: 1_000,
};
const startOf = (sessionId: string, commandId = START, profileId = PROFILE): BudgetBinding =>
  ({ ...binding, commandId, profileId, sessionId, kind: "session.start", target: { field: "session_id", id: sessionId } });
const release = (profileId: string, session: string, keys: string[]) =>
  ({ commandId: releaseKey(profileId, session), schemaVersion: 1, profileId, session, keys });
const validRelease = () => release(PROFILE, NEW_SESSION, [DAMAGED]) as Record<string, unknown>;
const DAMAGED_RELEASES: Array<[string, unknown]> = [
  ["an extra key", { ...validRelease(), note: "x" }],
  ["a missing key", Object.fromEntries(Object.entries(validRelease()).filter(([name]) => name !== "schemaVersion"))],
  ["another schema version", { ...validRelease(), schemaVersion: 2 }],
  ["no keys", { ...validRelease(), keys: [] }],
  ["keys not a list", { ...validRelease(), keys: DAMAGED }],
  ["a repeated key", { ...validRelease(), keys: [DAMAGED, DAMAGED] }],
  ["a sparse key list", { ...validRelease(), keys: (() => { const sparse: unknown[] = new Array(2); sparse[1] = DAMAGED; return sparse; })() }],
  ["a release key among the keys", { ...validRelease(), keys: [DAMAGED, releaseKey(PROFILE, OTHER_SESSION)] }],
  ["a session that is not a UUID", { ...validRelease(), session: "N" }],
  ["an upper-case profile", { ...validRelease(), profileId: PROFILE.toUpperCase() }],
  ["a commandId other than its key", { ...validRelease(), commandId: releaseKey(PROFILE, OTHER_SESSION) }],
  ["another session inside", { ...validRelease(), session: OTHER_SESSION }],
  ["another profile inside", { ...validRelease(), profileId: OTHER_PROFILE }],
  ["null", null],
];
const slotsWith = (index: number, slot: unknown) => {
  const slots = baseRecord().slots as unknown[];
  slots[index] = slot;
  return slots;
};
const CORRUPT: Array<[string, unknown]> = [
  ["an extra key", { ...baseRecord(), answer: "Tisch" }],
  ["a missing key", (({ createdAt: _omitted, ...rest }) => rest)(baseRecord())],
  ["five slots", { ...baseRecord(), slots: (baseRecord().slots as unknown[]).slice(0, 5) }],
  ["seven slots", { ...baseRecord(), slots: [...(baseRecord().slots as unknown[]), { state: "empty" }] }],
  ["an unknown slot state", { ...baseRecord(), slots: slotsWith(3, { state: "lost" }) }],
  ["an attempt on an empty slot", { ...baseRecord(), slots: slotsWith(3, { state: "empty", attempt: attempt(9) }) }],
  ["a held slot without attempt", { ...baseRecord(), slots: slotsWith(2, { state: "reserved" }) }],
  ["an attempt that is not a UUID", { ...baseRecord(), slots: slotsWith(2, { state: "reserved", attempt: "3" }) }],
  ["an upper-case attempt", { ...baseRecord(), slots: slotsWith(2, { state: "reserved", attempt: "ABCDEF00-0000-4000-8000-000000000003" }) }],
  ["one attempt in two slots", { ...baseRecord(), slots: slotsWith(3, { state: "sending", attempt: attempt(3) }) }],
  ["another schema version", { ...baseRecord(), schemaVersion: 2 }],
  ["another profile", { ...baseRecord(), profileId: OTHER_PROFILE }],
  ["another content hash", { ...baseRecord(), intentHash: "b".repeat(64) }],
  ["no content hash (forgotten for another profile)", (({ intentHash: _omitted, ...rest }) => rest)(baseRecord())],
  ["another client instance", { ...baseRecord(), clientInstanceId: "00000000-0000-4000-8000-0000000000c2" }],
  ["another pair", { ...baseRecord(), pair: "uk-de" }],
  ["another session", { ...baseRecord(), sessionId: OTHER_SESSION }],
  ["another kind", { ...baseRecord(), kind: "assignment.present" }],
  ["another command_id inside", { ...baseRecord(), commandId: OTHER_COMMAND }],
  ["lastMaintenance false", { ...baseRecord(), lastMaintenance: false }],
  ["sendBan false", { ...baseRecord(), sendBan: false }],
  ["sendBan as text", { ...baseRecord(), sendBan: "yes" }],
  ["a loss before send 2", { ...baseRecord(), loss: { server: 5, next: 1, device: 5 } }],
  ["a loss with an extra key", { ...baseRecord(), loss: { server: 5, next: 2, device: 5, at: 1 } }],
  ["an unknown family", { ...baseRecord(), family: "oral" }],
  ["a target with an extra key", { ...baseRecord(), target: { field: "assignment_id", id: ASSIGNMENT, text: "x" } }],
  ["a negative createdAt", { ...baseRecord(), createdAt: -1 }],
  ["a slot list that is an object", { ...baseRecord(), slots: { length: 6 } }],
  // QA Н4: six places, but holes in them — every() alone would skip the holes.
  ["a sparse slot list", { ...baseRecord(), slots: (() => {
    const sparse: unknown[] = new Array(6);
    sparse[0] = slot("transmitted", 1);
    sparse[5] = slot("empty");
    return sparse;
  })() }],
  ["null", null],
  ["a string", "6"],
  ["an array", [baseRecord()]],
];

describe.each(SUBJECTS)("send budget protocol (D-CP5 2.3) — %s", (_name, make) => {
  it("5.3.1: a second create+reserve of the same command_id is refused and does not reset the record", async () => {
    const { store, peek } = await make();
    await walk(store, 1, "transmitted");
    const before = peek(COMMAND);
    expect(await store.createAndReserve(binding, attempt(2), 2_000)).toEqual({ outcome: "exists" });
    expect(peek(COMMAND)).toEqual(before);
    expect(await store.load(identity)).toEqual({ occupied: 1, transmitted: 1, unsettled: 1, lastMaintenance: false, loss: null, forbidden: false });
  });

  it("5.3.1: create+reserve over a corrupt record is refused and leaves it as it was", async () => {
    const { store, seed, peek } = await make();
    seed(COMMAND, { garbage: true, commandId: COMMAND });
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toEqual({ outcome: "exists" });
    expect(peek(COMMAND)).toEqual({ garbage: true, commandId: COMMAND });
  });

  it("5.3.2: six reservations take slots 1–6 in order, the seventh finds no slot", async () => {
    const { store, peek } = await make();
    for (let n = 1; n <= 6; n++) expect(await walk(store, n, "retryable")).toEqual({ slot: n - 1, attempt: attempt(n) });
    const full = peek(COMMAND);
    expect(await store.reserve(identity, attempt(7))).toEqual({ outcome: "no_slots" });
    expect(peek(COMMAND)).toEqual(full);
    expect(await store.load(identity)).toMatchObject({ occupied: 6, transmitted: 6, unsettled: 0 });
  });

  it("5.3.2: a released slot is the lowest free one and is taken again", async () => {
    const { store } = await make();
    await walk(store, 1, "retryable");
    await walk(store, 2, "retryable");
    const third = await walk(store, 3, "reserved");
    expect(await store.release(identity, third)).toBe(true);
    expect(await store.reserve(identity, attempt(4))).toEqual({ outcome: "reserved", claim: { slot: 2, attempt: attempt(4) } });
  });

  it.each(["reserved", "sending", "transmitted"] as const)(
    "C060: no new reservation while a taken slot is %s — its outcome is not written as retryable", async (state) => {
      const { store, peek } = await make();
      await walk(store, 1, "retryable");
      const open = await walk(store, 2, state);
      const before = peek(COMMAND);
      expect(await store.reserve(identity, attempt(3))).toEqual({ outcome: "unsettled" });
      expect(peek(COMMAND)).toEqual(before);
      expect(budgetVerdict(await store.load(identity))).toBe("unsettled");
      if (state === "transmitted") {
        expect(await store.markRetryable(identity, open)).toBe(true);
        expect(await store.markRetryable(identity, open)).toBe(true);
        expect(await store.reserve(identity, attempt(3))).toEqual({ outcome: "reserved", claim: { slot: 2, attempt: attempt(3) } });
      }
    });

  it("QA Q32: marking again succeeds only for the attempt that holds the sent slot", async () => {
    const { store, peek } = await make();
    await walk(store, 1, "transmitted");
    const before = peek(COMMAND);
    expect(await store.markTransmitted(identity, { slot: 0, attempt: attempt(99) })).toBe(false);
    expect(await store.markRetryable(identity, { slot: 0, attempt: attempt(99) })).toBe(false);
    expect(peek(COMMAND)).toEqual(before);
  });

  it("C060: markRetryable needs transmitted(P) of the same attempt; markTransmitted again after it changes nothing", async () => {
    const { store, peek } = await make();
    const claim = await walk(store, 1, "sending");
    expect(await store.markRetryable(identity, claim)).toBe(false);
    expect(await store.markTransmitted(identity, claim)).toBe(true);
    expect(await store.markRetryable(identity, { slot: 0, attempt: attempt(99) })).toBe(false);
    expect(await store.markRetryable(identity, claim)).toBe(true);
    const settled = peek(COMMAND);
    expect(await store.markTransmitted(identity, claim)).toBe(true);
    expect(peek(COMMAND)).toEqual(settled);
    expect((settled as { slots: unknown[] }).slots[0]).toEqual(slot("retryable", 1));
  });

  it("5.3.3: release after beginSending is refused, the slot stays sending", async () => {
    const { store, peek } = await make();
    const claim = await walk(store, 1, "sending");
    expect(await store.release(identity, claim)).toBe(false);
    expect((peek(COMMAND) as { slots: unknown[] }).slots[0]).toEqual({ state: "sending", attempt: attempt(1) });
    expect(await store.load(identity)).toMatchObject({ occupied: 1, transmitted: 0 });
  });

  it("5.3.3: release after markTransmitted is refused too", async () => {
    const { store } = await make();
    const claim = await walk(store, 1, "transmitted");
    expect(await store.release(identity, claim)).toBe(false);
    expect(await store.load(identity)).toMatchObject({ occupied: 1, transmitted: 1 });
  });

  it("5.3.4: release with another attempt of the same slot changes nothing", async () => {
    const { store, peek } = await make();
    const claim = await walk(store, 1, "reserved");
    expect(await store.release(identity, { slot: claim.slot, attempt: attempt(99) })).toBe(false);
    expect((peek(COMMAND) as { slots: unknown[] }).slots[0]).toEqual({ state: "reserved", attempt: attempt(1) });
  });

  it("5.3.4: a late release of an old attempt does not free the slot a newer attempt took", async () => {
    const { store, peek } = await make();
    const old = await walk(store, 1, "reserved");
    expect(await store.release(identity, old)).toBe(true);
    const newer = await store.reserve(identity, attempt(2));
    expect(newer).toEqual({ outcome: "reserved", claim: { slot: 0, attempt: attempt(2) } });
    expect(await store.release(identity, old)).toBe(false);
    expect(await store.beginSending(identity, old)).toBe(false);
    expect(await store.markTransmitted(identity, old)).toBe(false);
    expect((peek(COMMAND) as { slots: unknown[] }).slots[0]).toEqual({ state: "reserved", attempt: attempt(2) });
  });

  it("5.3.5: markTransmitted from reserved (no gate) does not make the slot transmitted", async () => {
    const { store, peek } = await make();
    const claim = await walk(store, 1, "reserved");
    expect(await store.markTransmitted(identity, claim)).toBe(false);
    expect((peek(COMMAND) as { slots: unknown[] }).slots[0]).toEqual({ state: "reserved", attempt: attempt(1) });
    expect(await store.load(identity)).toMatchObject({ transmitted: 0 });
  });

  it("5.3.5: marking again on the server answer succeeds without changing the record", async () => {
    const { store, peek } = await make();
    const claim = await walk(store, 1, "transmitted");
    const before = peek(COMMAND);
    expect(await store.markTransmitted(identity, claim)).toBe(true);
    expect(peek(COMMAND)).toEqual(before);
  });

  it("5.3.6: beginSending after clear is refused and nothing is re-created", async () => {
    const { store, peek } = await make();
    const claim = await walk(store, 1, "reserved");
    expect(await store.clear(COMMAND, PROFILE)).toBe(true);
    expect(await store.beginSending(identity, claim)).toBe(false);
    expect(peek(COMMAND)).toBeUndefined();
    expect(await store.reserve(identity, attempt(2))).toEqual({ outcome: "unknown" });
    expect(await store.load(identity)).toBeNull();
  });

  it("5.3.7: 4 transmitted, 1 sending, 1 reserved — occupied 6, transmitted 4: unconfirmed, not exhausted", async () => {
    const { store, seed } = await make();
    // Not reachable through the protocol any more (one unsettled slot at a time), kept as a stored state: windows of an
    // older build or a crash may leave it.
    seed(COMMAND, { ...baseRecord(), slots: [slot("transmitted", 1), slot("transmitted", 2), slot("transmitted", 3),
      slot("transmitted", 4), slot("sending", 5), slot("reserved", 6)] });
    const summary = await store.load(identity);
    expect(summary).toEqual({ occupied: 6, transmitted: 4, unsettled: 6, lastMaintenance: false, loss: null, forbidden: false });
    expect(budgetVerdict(summary)).toBe("unconfirmed");
    expect(await store.reserve(identity, attempt(7))).toEqual({ outcome: "no_slots" });
  });

  it("5.3.7: the verdicts — below six can send, six retryable sends are exhausted, no record is unknown", async () => {
    const { store } = await make();
    for (let n = 1; n <= 5; n++) await walk(store, n, "retryable");
    expect(budgetVerdict(await store.load(identity))).toBe("can_send");
    const sixth = await walk(store, 6, "transmitted");
    // QA Н1: the sixth outcome is not written yet — it may be a refusal; not exhausted.
    expect(budgetVerdict(await store.load(identity))).toBe("unconfirmed");
    expect(await store.markRetryable(identity, sixth)).toBe(true);
    expect(budgetVerdict(await store.load(identity))).toBe("exhausted");
    expect(await store.reserve(identity, attempt(7))).toEqual({ outcome: "no_slots" });
    expect(budgetVerdict(await store.load({ ...identity, commandId: OTHER_COMMAND }))).toBe("unknown");
  });

  it("QA Н1: six sent with an outcome not written is unconfirmed, never exhausted", async () => {
    const { store, seed } = await make();
    seed(COMMAND, { ...baseRecord(), slots: [slot("retryable", 1), slot("retryable", 2), slot("retryable", 3),
      slot("retryable", 4), slot("transmitted", 5), slot("retryable", 6)] });
    expect(await store.load(identity)).toMatchObject({ occupied: 6, transmitted: 6, unsettled: 1 });
    expect(budgetVerdict(await store.load(identity))).toBe("unconfirmed");
    seed(COMMAND, { ...baseRecord(), slots: [slot("retryable", 1), slot("retryable", 2), slot("retryable", 3),
      slot("retryable", 4), slot("retryable", 5), slot("sending", 6)] });
    expect(budgetVerdict(await store.load(identity))).toBe("unconfirmed");
  });

  it.each(CORRUPT)("5.3.8: %s — the count is unknown and the record is not overwritten", async (_label, value) => {
    const { store, seed, peek } = await make();
    seed(COMMAND, value);
    const claim = { slot: 2, attempt: attempt(3) };
    expect(await store.load(identity)).toBeNull();
    expect(await store.reserve(identity, attempt(7))).toEqual({ outcome: "unknown" });
    expect(await store.beginSending(identity, claim)).toBe(false);
    expect(await store.markTransmitted(identity, claim)).toBe(false);
    expect(await store.release(identity, claim)).toBe(false);
    expect(await store.setMaintenance(identity, true)).toBe(false);
    expect(await store.setLoss(identity, { server: 10, next: 2, device: 10 })).toBe(false);
    expect(await store.forbidSends(identity)).toBe(false);
    expect(await store.createAndReserve(binding, attempt(8), 2_000)).toEqual({ outcome: "exists" });
    expect(peek(COMMAND)).toEqual(value);
  });

  it("5.3.8: the base of the corruptions is itself a valid record of this envelope", async () => {
    const { store, seed } = await make();
    expect(validBudgetRecord(baseRecord())).toBe(true);
    seed(COMMAND, baseRecord());
    expect(await store.load(identity)).toEqual({ occupied: 3, transmitted: 2, unsettled: 3, lastMaintenance: false, loss: null, forbidden: false });
  });

  it("keeps the maintenance flag and the loss across operations", async () => {
    const { store } = await make();
    await walk(store, 1, "retryable");
    expect(await store.setMaintenance(identity, true)).toBe(true);
    expect(await store.setLoss(identity, { server: 50_000, next: 2, device: 49_000 })).toBe(true);
    await walk(store, 2, "reserved");
    expect(await store.load(identity)).toEqual({ occupied: 2, transmitted: 1, unsettled: 1, lastMaintenance: true,
      loss: { server: 50_000, next: 2, device: 49_000 }, forbidden: false });
    expect(await store.setMaintenance(identity, false)).toBe(true);
    expect(await store.load(identity)).toMatchObject({ lastMaintenance: false });
    expect(() => store.setLoss(identity, { server: 1, next: 7, device: 1 })).toThrow(SendBudgetError);
  });

  it("stores identifiers and slots only — no answer text, no command payload (Е01)", async () => {
    const { store, peek } = await make();
    await walk(store, 1, "reserved");
    expect(Object.keys(peek(COMMAND) as object).sort()).toEqual(["clientInstanceId", "commandId", "createdAt", "family",
      "intentHash", "kind", "pair", "profileId", "schemaVersion", "sessionId", "slots", "target"]);
  });

  it("clear removes only a valid record of the same profile", async () => {
    const { store, seed, peek } = await make();
    await walk(store, 1, "transmitted");
    expect(await store.clear(COMMAND, OTHER_PROFILE)).toBe(false);
    expect(peek(COMMAND)).toBeDefined();
    seed(OTHER_COMMAND, { garbage: true });
    expect(await store.clear(OTHER_COMMAND, PROFILE)).toBe(false);
    expect(peek(OTHER_COMMAND)).toEqual({ garbage: true });
    expect(await store.clear(COMMAND, PROFILE)).toBe(true);
    expect(peek(COMMAND)).toBeUndefined();
  });

  it("forgetHashOfOtherProfiles drops the fingerprint of other profiles only and deletes nothing (Е02, 10.6.2)", async () => {
    const { store, seed, peek } = await make();
    const mine = other(OTHER_COMMAND, OTHER_PROFILE);
    await walk(store, 1, "transmitted");
    expect(await store.createAndReserve(mine, attempt(20), 1_000)).toMatchObject({ outcome: "reserved" });
    seed("00000000-0000-4000-8000-000000000003", { garbage: true, commandId: "00000000-0000-4000-8000-000000000003", profileId: PROFILE, intentHash: HASH });
    const previous = peek(COMMAND) as Record<string, unknown>;

    expect(await store.forgetHashOfOtherProfiles(OTHER_PROFILE)).toBe(2);
    const forgotten = peek(COMMAND) as Record<string, unknown>;
    expect(Object.hasOwn(forgotten, "intentHash")).toBe(false);
    expect({ ...forgotten, intentHash: HASH }).toEqual(previous);
    expect(validBudgetRecord(forgotten)).toBe(true);
    expect(peek(OTHER_COMMAND)).toMatchObject({ intentHash: HASH });
    expect(peek("00000000-0000-4000-8000-000000000003")).toEqual({ garbage: true, commandId: "00000000-0000-4000-8000-000000000003", profileId: PROFILE, damaged: true });
    // The returning profile cannot use it as the budget of its envelope: only the guard of a lost envelope sees it.
    expect(await store.load(identity)).toBeNull();
    expect(await store.forgetHashOfOtherProfiles(OTHER_PROFILE)).toBe(0);
  });

  it("listOrphans lists valid records of the profile and session, with whether a request may have left", async () => {
    const { store, seed } = await make();
    await walk(store, 1, "sending");
    const quiet = other(OTHER_COMMAND, PROFILE);
    expect(await store.createAndReserve({ ...quiet, kind: "assignment.present" }, attempt(30), 1_000)).toMatchObject({ outcome: "reserved" });
    expect(await store.createAndReserve(other("00000000-0000-4000-8000-000000000004", OTHER_PROFILE), attempt(40), 1_000))
      .toMatchObject({ outcome: "reserved" });
    expect(await store.createAndReserve(other("00000000-0000-4000-8000-000000000005", PROFILE, OTHER_SESSION), attempt(50), 1_000))
      .toMatchObject({ outcome: "reserved" });
    seed("00000000-0000-4000-8000-000000000006", { ...baseRecord(), commandId: "00000000-0000-4000-8000-000000000006", slots: [] });

    seed("00000000-0000-4000-8000-000000000007", { slots: [], profileId: "garbage", sessionId: SESSION });

    const orphans = await store.listOrphans(PROFILE, SESSION);
    expect(orphans).toEqual([
      { commandId: COMMAND, damaged: false, kind: "assignment.answer", family: "primary",
        target: { field: "assignment_id", id: ASSIGNMENT }, intentHash: HASH, started: true, forbidden: false, occupied: 1, transmitted: 0 },
      { commandId: OTHER_COMMAND, damaged: false, kind: "assignment.present", family: "primary",
        target: { field: "assignment_id", id: ASSIGNMENT }, intentHash: HASH, started: false, forbidden: false, occupied: 1, transmitted: 0 },
      // QA Н3: a damaged record of this profile and session takes part in the guard, as started and forbidden.
      { commandId: "00000000-0000-4000-8000-000000000006", damaged: true, kind: "assignment.answer", family: "primary",
        target: { field: "assignment_id", id: ASSIGNMENT }, intentHash: HASH, started: true, forbidden: true, occupied: null, transmitted: null },
    ]);
  });

  it("rejects malformed input as a programming error, not as an unknown count", async () => {
    const { store } = await make();
    expect(() => store.reserve(identity, "not-a-uuid")).toThrow(SendBudgetError);
    expect(() => store.load({ ...identity, intentHash: "short" })).toThrow(SendBudgetError);
    expect(() => store.release(identity, { slot: 6, attempt: attempt(1) })).toThrow(SendBudgetError);
  });

  it("C053: the ban stops new reservations and the gate, the count stays known and outranked", async () => {
    const { store, peek } = await make();
    await walk(store, 1, "retryable");
    const leaving = await walk(store, 2, "sending");
    expect(await store.forbidSends(identity)).toBe(true);
    expect(peek(COMMAND)).toMatchObject({ sendBan: true });
    expect(await store.reserve(identity, attempt(4))).toEqual({ outcome: "forbidden" });
    expect(await store.createAndReserve(binding, attempt(5), 2_000)).toEqual({ outcome: "forbidden" });
    // Nothing reaches "transmitted" or "retryable" after the ban: the slot keeps bounding the count as "sending".
    expect(await store.markTransmitted(identity, leaving)).toBe(false);
    expect(await store.markRetryable(identity, leaving)).toBe(false);
    expect((peek(COMMAND) as { slots: unknown[] }).slots[1]).toEqual(slot("sending", 2));
    const summary = await store.load(identity);
    expect(summary).toEqual({ occupied: 2, transmitted: 1, unsettled: 1, lastMaintenance: false, loss: null, forbidden: true });
    expect(budgetVerdict(summary)).toBe("forbidden");
  });

  it("C053: the ban closes the gate for a reservation made before it; freeing that reservation stays allowed", async () => {
    const { store } = await make();
    await walk(store, 1, "retryable");
    const waiting = await walk(store, 2, "reserved");
    expect(await store.forbidSends(identity)).toBe(true);
    expect(await store.beginSending(identity, waiting)).toBe(false);
    expect(await store.release(identity, waiting)).toBe(true);
    expect(await store.load(identity)).toMatchObject({ occupied: 1, forbidden: true });
  });

  it("C053: forbidSends is idempotent and is refused without a record of this envelope", async () => {
    const { store, peek } = await make();
    expect(await store.forbidSends(identity)).toBe(false);
    expect(peek(COMMAND)).toBeUndefined();
    await walk(store, 1, "reserved");
    expect(await store.forbidSends(identity)).toBe(true);
    const banned = peek(COMMAND);
    expect(await store.forbidSends(identity)).toBe(true);
    expect(peek(COMMAND)).toEqual(banned);
    expect(await store.forbidSends({ ...identity, intentHash: "b".repeat(64) })).toBe(false);
    expect(validBudgetRecord(banned)).toBe(true);
  });

  it("C053: six transmitted with the ban is forbidden, not exhausted", async () => {
    const { store } = await make();
    for (let n = 1; n <= 5; n++) await walk(store, n, "retryable");
    await walk(store, 6, "transmitted");
    expect(await store.forbidSends(identity)).toBe(true);
    expect(budgetVerdict(await store.load(identity))).toBe("forbidden");
  });

  it("C053: ban, then another profile signs in and the first returns — the ban stays, no new budget", async () => {
    const { store, peek } = await make();
    await walk(store, 1, "transmitted");
    expect(await store.forbidSends(identity)).toBe(true);
    expect(await store.forgetHashOfOtherProfiles(OTHER_PROFILE)).toBe(1);
    expect(peek(COMMAND)).toMatchObject({ sendBan: true });
    expect(Object.hasOwn(peek(COMMAND) as object, "intentHash")).toBe(false);
    // Back under the first profile: the envelope is gone (Е02), so only the guard of CP5c sees the record.
    expect(await store.listOrphans(PROFILE, SESSION)).toEqual([expect.objectContaining({ commandId: COMMAND, forbidden: true, started: true })]);
    expect(budgetVerdict(await store.load(identity))).toBe("unknown");
    expect(await store.reserve(identity, attempt(2))).toEqual({ outcome: "unknown" });
    expect(await store.createAndReserve(binding, attempt(3), 3_000)).toEqual({ outcome: "exists" });
    expect(peek(COMMAND)).toMatchObject({ sendBan: true });
  });

  it("C060 п. 3: another profile's damaged record loses its fingerprint, nothing else of it changes", async () => {
    const { store, seed, peek } = await make();
    const without = (value: Record<string, unknown>, field: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));
    const damaged: Record<string, unknown> = { ...baseRecord(), profileId: OTHER_PROFILE, sendBan: true, slots: [slot("transmitted", 1), slot("lost", 2)] };
    const anonymous = without({ ...baseRecord(), commandId: OTHER_COMMAND, slots: 5 }, "profileId");
    const mineDamaged = { ...baseRecord(), commandId: "00000000-0000-4000-8000-000000000007", slots: "x" };
    seed(COMMAND, damaged);
    seed(OTHER_COMMAND, anonymous);
    seed("00000000-0000-4000-8000-000000000007", mineDamaged);
    expect(await store.forgetHashOfOtherProfiles(PROFILE)).toBe(2);
    expect(peek(COMMAND)).toEqual({ ...without(damaged, "intentHash"), damaged: true });
    expect(peek(OTHER_COMMAND)).toEqual({ ...without(anonymous, "intentHash"), damaged: true });
    // This profile's own damaged record keeps its fingerprint: its count stays unknown, not forgotten.
    expect(peek("00000000-0000-4000-8000-000000000007")).toEqual(mineDamaged);
    expect(await store.forgetHashOfOtherProfiles(PROFILE)).toBe(0);
  });

  it("C060 п. 2 / C069: a damaged record stays after its session closed; only the release of a new start N frees N", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    expect(await store.clear(DAMAGED, PROFILE)).toBe(false);
    expect(await store.listOrphans(PROFILE, SESSION)).toEqual([expect.objectContaining({ commandId: DAMAGED, damaged: true })]);
    // Before the explicit start of N: nothing new, in any session.
    expect(await store.createAndReserve(other(OTHER_COMMAND, PROFILE, OTHER_SESSION), attempt(10), 5_000)).toEqual({ outcome: "blocked_by_damage" });
    expect(peek(OTHER_COMMAND)).toBeUndefined();
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(11), 5_000)).toEqual({ outcome: "blocked_by_damage" });
    // The explicit start of N carries the release.
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(12), 5_000, [DAMAGED]))
      .toEqual({ outcome: "reserved", claim: { slot: 0, attempt: attempt(12) } });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toEqual(release(PROFILE, NEW_SESSION, [DAMAGED]));
    const inN = other(OTHER_COMMAND, PROFILE, NEW_SESSION);
    expect(await store.createAndReserve(inN, attempt(13), 5_000)).toEqual({ outcome: "reserved", claim: { slot: 0, attempt: attempt(13) } });
    expect(budgetVerdict(await store.load(inN))).toBe("unsettled");
    expect(peek(DAMAGED)).toEqual(damagedValue);
  });

  it("accepts upper-case IDs from the caller and keeps them in lower case", async () => {
    const { store, peek } = await make();
    const upper = { ...identity, commandId: COMMAND.toUpperCase(), profileId: PROFILE.toUpperCase() };
    expect(await store.createAndReserve({ ...binding, ...upper }, attempt(1).toUpperCase(), 1_000))
      .toEqual({ outcome: "reserved", claim: { slot: 0, attempt: attempt(1) } });
    expect(peek(COMMAND)).toMatchObject({ commandId: COMMAND, profileId: PROFILE });
    expect(await store.load(upper)).toMatchObject({ occupied: 1 });
  });
});

describe("forgetHashOfOtherProfiles on a damaged value without a string commandId (QA Н5) — MemorySendBudget", () => {
  it("drops the fingerprint and keeps the value under its store key", async () => {
    const store = new MemorySendBudget();
    const key = "00000000-0000-4000-8000-000000000008";
    store.seed(key, { commandId: 42, profileId: OTHER_PROFILE, intentHash: HASH, slots: [] });
    expect(await store.forgetHashOfOtherProfiles(PROFILE)).toBe(1);
    expect(store.peek(key)).toEqual({ commandId: 42, profileId: OTHER_PROFILE, slots: [], damaged: true });
  });
});

describe.each(SUBJECTS)("damaged records and their release (C069, C073, C075 table 4.1) — %s", (_name, make) => {
  it("4.1.1: the release frees N only — the old session and any other session stay blocked", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(1), 1_000, [DAMAGED])).toMatchObject({ outcome: "reserved" });
    for (const sessionId of [SESSION, OTHER_SESSION]) {
      expect(await store.createAndReserve(other(OTHER_COMMAND, PROFILE, sessionId), attempt(2), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    }
    expect(peek(OTHER_COMMAND)).toBeUndefined();
  });

  it("4.1.4: profile B gets nothing from the release of profile A", async () => {
    const { store, seed } = await make();
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(1), 1_000, [DAMAGED])).toMatchObject({ outcome: "reserved" });
    expect(await store.createAndReserve(other(OTHER_COMMAND, OTHER_PROFILE, NEW_SESSION), attempt(2), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    // B goes through its own explicit start.
    expect(await store.createAndReserve(startOf(OTHER_SESSION, OTHER_COMMAND, OTHER_PROFILE), attempt(3), 1_000, [DAMAGED]))
      .toMatchObject({ outcome: "reserved" });
  });

  it("4.1.6: a valid release under its key frees N (sanity of the corruptions below)", async () => {
    const { store, seed } = await make();
    seed(DAMAGED, damagedValue);
    seed(releaseKey(PROFILE, NEW_SESSION), release(PROFILE, NEW_SESSION, [DAMAGED]));
    expect(await store.createAndReserve(other(OTHER_COMMAND, PROFILE, NEW_SESSION), attempt(1), 1_000)).toMatchObject({ outcome: "reserved" });
  });

  it.each(DAMAGED_RELEASES)("4.1.6: a damaged release frees nothing — %s", async (_label, value) => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    seed(releaseKey(PROFILE, NEW_SESSION), value);
    expect(await store.createAndReserve(other(OTHER_COMMAND, PROFILE, NEW_SESSION), attempt(1), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toEqual(value);
  });

  it("4.1.7: the release leaves the damaged record as it is: no repair, no new budget, no new record under its key", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(1), 1_000, [DAMAGED])).toMatchObject({ outcome: "reserved" });
    expect(peek(DAMAGED)).toEqual(damagedValue);
    const old = { ...identity, commandId: DAMAGED };
    expect(await store.reserve(old, attempt(2))).toEqual({ outcome: "unknown" });
    expect(await store.createAndReserve({ ...binding, commandId: DAMAGED, sessionId: NEW_SESSION }, attempt(3), 1_000)).toEqual({ outcome: "exists" });
    expect(budgetVerdict(await store.load(old))).toBe("unknown");
    expect(peek(DAMAGED)).toEqual(damagedValue);
  });

  it("4.1.8: a release comes only with a new explicit start of its own session", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    expect(() => store.createAndReserve(other(OTHER_COMMAND, PROFILE, NEW_SESSION), attempt(1), 1_000, [DAMAGED])).toThrow(SendBudgetError);
    expect(() => store.createAndReserve({ ...startOf(NEW_SESSION), target: { field: "session_id", id: OTHER_SESSION } }, attempt(1), 1_000, [DAMAGED]))
      .toThrow(SendBudgetError);
    // An existing start record of the same command_id: exists, and no release.
    seed(START, { ...baseRecord(), commandId: START, sessionId: NEW_SESSION, kind: "session.start", target: { field: "session_id", id: NEW_SESSION } });
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(2), 1_000, [DAMAGED])).toEqual({ outcome: "exists" });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toBeUndefined();
  });

  it("4.1.8: a release that does not cover every damaged record writes nothing", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    seed(SECOND_DAMAGED, { ...damagedValue, commandId: SECOND_DAMAGED });
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(1), 1_000, [DAMAGED])).toEqual({ outcome: "blocked_by_damage" });
    expect(peek(START)).toBeUndefined();
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toBeUndefined();
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(2), 1_000, [SECOND_DAMAGED, DAMAGED])).toMatchObject({ outcome: "reserved" });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toEqual(release(PROFILE, NEW_SESSION, [DAMAGED, SECOND_DAMAGED]));
  });

  it("4.1.8: without damage a start writes no release; an existing release of the session refuses a second start", async () => {
    const { store, seed, peek } = await make();
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(1), 1_000, [])).toMatchObject({ outcome: "reserved" });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toBeUndefined();
    seed(DAMAGED, damagedValue);
    seed(releaseKey(PROFILE, OTHER_SESSION), release(PROFILE, OTHER_SESSION, [DAMAGED]));
    // Delta QA п. 6: a deterministic outcome, not a failed transaction.
    expect(await store.createAndReserve(startOf(OTHER_SESSION, OTHER_COMMAND), attempt(2), 1_000, [DAMAGED]))
      .toEqual({ outcome: "session_not_new" });
    expect(peek(OTHER_COMMAND)).toBeUndefined();
  });

  it("delta QA п. 6: starting N again after its release, with new damage: session_not_new, the release unchanged", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(1), 1_000, [DAMAGED])).toMatchObject({ outcome: "reserved" });
    seed(SECOND_DAMAGED, { ...damagedValue, commandId: SECOND_DAMAGED });
    expect(await store.createAndReserve(startOf(NEW_SESSION, OTHER_COMMAND), attempt(2), 1_000, [DAMAGED, SECOND_DAMAGED]))
      .toEqual({ outcome: "session_not_new" });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toEqual(release(PROFILE, NEW_SESSION, [DAMAGED]));
    expect(await store.createAndReserve(other(START2, PROFILE, NEW_SESSION), attempt(3), 1_000)).toEqual({ outcome: "blocked_by_damage" });
  });

  it("delta QA P1a: N already has a valid start of this profile — a second start of N cannot release", async () => {
    const { store, seed, peek } = await make();
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(1), 1_000)).toMatchObject({ outcome: "reserved" });
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(NEW_SESSION, START2), attempt(2), 1_000, [DAMAGED])).toEqual({ outcome: "session_not_new" });
    expect(peek(START2)).toBeUndefined();
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toBeUndefined();
  });

  it("delta QA P1b: the damaged record reads as a record of N — no release of N", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, { ...damagedValue, sessionId: NEW_SESSION.toUpperCase(), kind: "session.start", target: { field: "session_id", id: NEW_SESSION } });
    expect(await store.createAndReserve(startOf(NEW_SESSION, START2), attempt(2), 1_000, [DAMAGED])).toEqual({ outcome: "session_not_new" });
    expect(await store.createAndReserve({ ...binding, sessionId: NEW_SESSION }, attempt(3), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toBeUndefined();
  });

  it("delta QA P1c: the old session S has valid records — a start of S cannot release it", async () => {
    const { store, seed, peek } = await make();
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toMatchObject({ outcome: "reserved" });
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(SESSION, START2), attempt(2), 1_000, [DAMAGED])).toEqual({ outcome: "session_not_new" });
    expect(await store.createAndReserve({ ...binding, commandId: OTHER_COMMAND }, attempt(3), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    expect(peek(releaseKey(PROFILE, SESSION))).toBeUndefined();
  });

  it("delta QA P1: another profile's record of N counts against novelty too", async () => {
    const { store, seed } = await make();
    expect(await store.createAndReserve(other(OTHER_COMMAND, OTHER_PROFILE, NEW_SESSION), attempt(1), 1_000)).toMatchObject({ outcome: "reserved" });
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(2), 1_000, [DAMAGED])).toEqual({ outcome: "session_not_new" });
  });

  it("delta QA п. 3 (M3): only session.start releases — session.stop and cancel_start of S do not", async () => {
    const { store, seed } = await make();
    seed(DAMAGED, damagedValue);
    const stop: BudgetBinding = { ...binding, commandId: START2, kind: "session.stop", family: "stop", target: { field: "session_id", id: SESSION } };
    expect(() => store.createAndReserve(stop, attempt(1), 1_000, [DAMAGED])).toThrow(SendBudgetError);
    expect(() => store.createAndReserve({ ...stop, kind: "session.cancel_start", family: "start_cancel" }, attempt(2), 1_000, [DAMAGED]))
      .toThrow(SendBudgetError);
    // The kind alone refuses, whatever the family says.
    for (const kind of ["session.stop", "session.cancel_start", "assignment.present"]) {
      expect(() => store.createAndReserve({ ...stop, kind, family: "primary" }, attempt(3), 1_000, [DAMAGED])).toThrow(SendBudgetError);
    }
  });

  it("delta QA п. 7: a start of another family carries no release", async () => {
    const { store, seed } = await make();
    seed(DAMAGED, damagedValue);
    expect(() => store.createAndReserve({ ...startOf(NEW_SESSION), family: "stop" }, attempt(1), 1_000, [DAMAGED])).toThrow(SendBudgetError);
  });

  it("delta QA п. 4 (M2): the release lists the damaged keys of the moment, not what was offered", async () => {
    const { store, seed, peek } = await make();
    await walk(store, 1, "transmitted");
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(startOf(NEW_SESSION), attempt(2), 1_000, [DAMAGED, COMMAND, START, "00000000-0000-4000-8000-0000000000ff"]))
      .toMatchObject({ outcome: "reserved" });
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toEqual(release(PROFILE, NEW_SESSION, [DAMAGED]));
  });

  it("4.1.9: valid records of another profile or envelope are not damage", async () => {
    const { store } = await make();
    expect(await store.createAndReserve(other(OTHER_COMMAND, OTHER_PROFILE), attempt(1), 1_000)).toMatchObject({ outcome: "reserved" });
    expect(await store.createAndReserve({ ...binding, kind: "assignment.present" }, attempt(2), 1_000)).toMatchObject({ outcome: "reserved" });
    expect(await store.createAndReserve(other(START, PROFILE, OTHER_SESSION), attempt(3), 1_000)).toMatchObject({ outcome: "reserved" });
  });

  it("4.1.5: removing a damaged record on proof takes its key out of every release in the same step", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, damagedValue);
    seed(SECOND_DAMAGED, { ...damagedValue, commandId: SECOND_DAMAGED });
    seed(releaseKey(PROFILE, NEW_SESSION), release(PROFILE, NEW_SESSION, [DAMAGED, SECOND_DAMAGED]));
    seed(releaseKey(OTHER_PROFILE, OTHER_SESSION), release(OTHER_PROFILE, OTHER_SESSION, [DAMAGED]));
    expect(await store.clearDamaged(DAMAGED)).toBe(true);
    expect(peek(DAMAGED)).toBeUndefined();
    expect(peek(releaseKey(PROFILE, NEW_SESSION))).toEqual(release(PROFILE, NEW_SESSION, [SECOND_DAMAGED]));
    expect(peek(releaseKey(OTHER_PROFILE, OTHER_SESSION))).toBeUndefined();
    expect(peek(SECOND_DAMAGED)).toEqual({ ...damagedValue, commandId: SECOND_DAMAGED });
  });

  it("4.1.5: clearDamaged leaves valid records, releases and missing keys alone", async () => {
    const { store, peek } = await make();
    await walk(store, 1, "transmitted");
    expect(await store.clearDamaged(COMMAND)).toBe(false);
    expect(await store.clearDamaged(OTHER_COMMAND)).toBe(false);
    expect(peek(COMMAND)).toBeDefined();
  });

  it("Н3: a damaged record whose identity does not read is not listed, and still blocks", async () => {
    const { store, seed } = await make();
    seed(DAMAGED, { slots: "x" });
    expect(await store.listOrphans(PROFILE, SESSION)).toEqual([]);
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toEqual({ outcome: "blocked_by_damage" });
  });
});

describe.each(SUBJECTS)("delta QA CP5a-2: healing, store keys, existing records — %s", (_name, make) => {
  const sixSlots = [slot("retryable", 1), slot("empty"), slot("empty"), slot("empty"), slot("empty"), slot("empty")];

  it("P2: dropping the fingerprint of a record damaged only in intentHash keeps it damaged and blocking", async () => {
    const { store, seed, peek } = await make();
    seed(DAMAGED, { ...damagedValue, slots: sixSlots, intentHash: "Z".repeat(64) });
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    expect(await store.forgetHashOfOtherProfiles(OTHER_PROFILE)).toBe(1);
    expect(validBudgetRecord(peek(DAMAGED))).toBe(false);
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toEqual({ outcome: "blocked_by_damage" });
    expect(await store.listOrphans(PROFILE, SESSION)).toEqual([expect.objectContaining({ commandId: DAMAGED, damaged: true })]);
  });

  it("P2b: the same for a damaged record of another profile when this profile signs in", async () => {
    const { store, seed } = await make();
    seed(DAMAGED, { ...damagedValue, profileId: OTHER_PROFILE, slots: sixSlots, intentHash: "Z".repeat(64) });
    expect(await store.forgetHashOfOtherProfiles(PROFILE)).toBe(1);
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toEqual({ outcome: "blocked_by_damage" });
  });

  it("п. 8: a damaged record under an upper-case key is listed and removed by its exact key", async () => {
    const { store, seed, peek } = await make();
    const key = "ABCDEF00-0000-4000-8000-00000000000D";
    seed(key, { ...damagedValue, commandId: key });
    expect(await store.listOrphans(PROFILE, SESSION)).toEqual([expect.objectContaining({ commandId: key, damaged: true })]);
    expect(await store.clearDamaged(key)).toBe(true);
    expect(peek(key)).toBeUndefined();
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toMatchObject({ outcome: "reserved" });
  });

  it("M6: a valid record stored under another key counts as damage", async () => {
    const { store, seed } = await make();
    seed(DAMAGED, { ...baseRecord(), commandId: OTHER_COMMAND });
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toEqual({ outcome: "blocked_by_damage" });
  });

  it("M12: a damaged record under a key that is not a UUID is not listed, and still blocks", async () => {
    const { store, seed } = await make();
    seed("not-a-uuid", { ...damagedValue, commandId: "not-a-uuid" });
    expect(await store.listOrphans(PROFILE, SESSION)).toEqual([]);
    expect(await store.createAndReserve(binding, attempt(1), 1_000)).toEqual({ outcome: "blocked_by_damage" });
  });

  it("M14: creating a command that already exists answers exists even while damage blocks new records", async () => {
    const { store, seed } = await make();
    await walk(store, 1, "retryable");
    seed(DAMAGED, damagedValue);
    expect(await store.createAndReserve(binding, attempt(2), 1_000)).toEqual({ outcome: "exists" });
  });
});
