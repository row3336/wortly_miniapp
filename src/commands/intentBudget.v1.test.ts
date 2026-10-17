// V-1 cleanup of the durable budget (stage 1 table of section 3, A-V1-REFUSALS table 1.1, root notes C083/C090; CP5b
// stage 3): only a pair «mode + kind + code» final by every branch of the core removes the record of a refused action;
// any other refusal keeps it with the ban. SESSION_CLOSED is final everywhere.
import { describe, expect, it } from "vitest";
import { finalRefusals, recordOutcome } from "./intentBudget";
import { seedMarks, storedMarks, testBudget } from "./budget.test-support";
import { MemorySendBudget, SendBudgetError } from "./sendBudget";

const X = { command_id: "11111111-1111-4111-8111-111111111111", kind: "result.grade", session_id: "22222222-2222-4222-8222-222222222222",
  assignment_id: "33333333-3333-4333-8333-333333333333", result_id: "44444444-4444-4444-8444-444444444444", payload: { grade: 4 } };

describe("the final refusals of the V-1 table", () => {
  it("names the pairs final by every branch, per mode; leaves out the ones the table keeps", () => {
    expect(finalRefusals("written", "result.grade")("VERSION_CONFLICT")).toBe(true);
    expect(finalRefusals("written", "result.correct")("FORBIDDEN")).toBe(true);
    expect(finalRefusals("written", "result.undo")("CAPABILITY_EXPIRED")).toBe(true);
    expect(finalRefusals("Learning", "result.undo")("ASSIGNMENT_STALE")).toBe(true);
    expect(finalRefusals("Learning", "learning.preview_next")("ASSIGNMENT_STALE")).toBe(true);
    expect(finalRefusals("written", "assignment.present")("ASSIGNMENT_STALE")).toBe(true);
    // Kept: one branch final only behind the client barrier (Q25), the unproven Learning branch, other codes, oral (M1d).
    expect(finalRefusals("written", "answer.submit")("ASSIGNMENT_STALE")).toBe(false);
    expect(finalRefusals("Learning", "result.grade")("ASSIGNMENT_STALE")).toBe(false);
    expect(finalRefusals("Learning", "result.grade")("VERSION_CONFLICT")).toBe(false);
    expect(finalRefusals("written", "result.grade")("DOCUMENT_STALE")).toBe(false);
    expect(finalRefusals("written", "result.grade")(null)).toBe(false);
    expect(finalRefusals("oral", "oral.grade")("ASSIGNMENT_STALE")).toBe(false);
  });
  it("recordOutcome removes the record for a final pair and SESSION_CLOSED, keeps it banned otherwise", async () => {
    for (const [code, kept] of [["VERSION_CONFLICT", false], ["SESSION_CLOSED", false], ["ASSIGNMENT_STALE", true], [null, true]] as const) {
      const store = new MemorySendBudget();
      await seedMarks(store, X, { reserved: 1, transmitted: 1 });
      const budget = testBudget(X, { store, finalRefusal: finalRefusals("written", X.kind) });
      await recordOutcome(budget, "rejected", code);
      expect(await storedMarks(store, X.command_id)).toEqual(kept ? { reserved: 1, transmitted: 1, forbidden: true } : null);
    }
  });
});

describe("C567/C568: one more try only for a store closed before its transaction", () => {
  const binding = async () => (await import("./intentBudget")).budgetBinding(X, { profileId: "0000000a-0000-4000-8000-00000000000a",
    clientInstanceId: "0000000b-0000-4000-8000-00000000000b", pair: "ru-de" }, "primary");
  const store = (reason: "unavailable" | "failed" | "timeout" | null, calls: string[], name: string) => new Proxy({}, {
    get: (_target, prop) => prop === "then" ? undefined : prop === "isOpen" ? () => reason !== "unavailable" : async () => {
      calls.push(`${name}.${String(prop)}`);
      if (reason) throw new SendBudgetError(reason);
      return { occupied: 0, transmitted: 0, unsettled: 0, manualUnsettled: false, lastMaintenance: false, loss: null, forbidden: false };
    },
  }) as never;
  it("closed before the transaction ('unavailable'): the same operation once more on the store opened anew", async () => {
    const { recoveryBudget } = await import("./intentBudget");
    const calls: string[] = []; const stores = [store("unavailable", calls, "old"), store(null, calls, "new")];
    let failed = 0;
    const budget = recoveryBudget({ store: async () => stores[Math.min(failed, 1)], failed: () => { failed++; } }, binding);
    expect(await budget.load()).toMatchObject({ occupied: 0 });
    expect(calls).toEqual(["old.load", "new.load"]);
  });
  it("a timeout, an abort or a failed commit is never repeated: the failure stands", async () => {
    const { recoveryBudget } = await import("./intentBudget");
    for (const reason of ["timeout", "failed"] as const) {
      const calls: string[] = []; const stores = [store(reason, calls, "old"), store(null, calls, "new")];
      let failed = 0;
      const budget = recoveryBudget({ store: async () => stores[Math.min(failed, 1)], failed: () => { failed++; } }, binding);
      expect(await budget.beginSending({ slot: 0, attempt: "9a000000-0000-4000-8000-000000000001" })).toBe(false);
      expect(await budget.load()).toBeNull();
      expect(calls).toEqual(["old.beginSending", "old.load"]);
    }
  });
  it("two closed stores in a row: one more try only, then the failure", async () => {
    const { recoveryBudget } = await import("./intentBudget");
    const calls: string[] = []; let opened = 0;
    const budget = recoveryBudget({ store: async () => store("unavailable", calls, `s${opened++}`) }, binding);
    expect(await budget.reserve("9a000000-0000-4000-8000-000000000002")).toBeNull();
    expect(calls).toEqual(["s0.reserve", "s1.reserve"]);
  });
});
