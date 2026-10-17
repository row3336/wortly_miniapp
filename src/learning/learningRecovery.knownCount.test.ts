// Decision 2.3 А with a known send count (S11, C153): a Learning record of another window or of the page before a reload
// is only checked, never sent, even when the count of its sends is known. The count is put into the very store of the page
// the document lanes read (the place a durable count of CP5 would answer from), and its read is asserted, so the guard,
// not an unknown count, is what keeps the POST away.
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageMarks, testBudgetLog } from "../commands/budget.test-support";
import { noteCreatedHere } from "../commands/pageOrigin";
import { tick } from "../commands/recoveryTime.test-support";
import { action, current, fixture, missing, original, primaryKey, response, resultRead } from "./learningFixtures.test-support";
import { hasPending } from "../commands/pendingSeed.test-support";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** An owner over a saved record X whose count says k sends went out; the server knows nothing of X. */
async function resumeKnownCount(kind: "answer.submit" | "result.correct", k: number, createdHere: boolean) {
  vi.useFakeTimers();
  const command = original(action(kind)), f = fixture({ primary: command });
  // CP5b: the count is put into the store of the page (materialized under the owner's identity on its first read).
  testBudgetLog.seeds.set(command.command_id.toLowerCase(), { reserved: k, transmitted: k });
  if (createdHere) noteCreatedHere(f.storage, command.command_id);
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "POST") return response(missing(command));
    const path = String(url);
    if (path.includes("/commands/")) return response(missing(command));
    if (path.includes("result_id=")) return response(resultRead("1", 2));
    return response({ current: current(), state_version: "3" });
  });
  await f.owner.refresh(); await tick();
  for (let spent = 0; spent < 90_000; spent += 5_000) await tick(5_000);
  const posts = f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length;
  const checks = f.fetcher.mock.calls.filter(([url, init]) => init?.method !== "POST" && String(url).includes(`/commands/${command.command_id}`)).length;
  const read = testBudgetLog.loads.filter(entry => entry.commandId === command.command_id.toLowerCase()).map(entry => entry.transmitted);
  const snapshot = f.owner.snapshot();
  const states = new Set(f.onUpdate.mock.calls.map(([update]) => update.recovery?.state.name).filter(Boolean));
  f.owner.dispose();
  return { posts, checks, read, snapshot, states, kept: hasPending(f.values, primaryKey),
    marks: await pageMarks(f.storage, command.command_id) };
}

describe("a Learning record not created on this page, with a known count", () => {
  for (const kind of ["answer.submit", "result.correct"] as const) for (const k of [1, 2, 5]) {
    it(`${kind}, ${k} sends counted: the count is read, X is checked and never sent`, async () => {
      const r = await resumeKnownCount(kind, k, false);
      // Every read of the durable count (the resume, the fresh one before the decision) answers the seeded k.
      expect(r.read.length).toBeGreaterThan(0);
      expect(new Set(r.read)).toEqual(new Set([k]));
      expect(r.posts).toBe(0);
      expect(r.checks).toBeGreaterThan(0);
      expect(r.snapshot.recovery?.state.name).toBe("origin_elsewhere");
      // Stopped at the check that found the count, not later at the send: no pause is waited out for it either.
      expect([...r.states].filter(name => name === "sending" || name === "retry_wait" || name === "pre_send_check")).toEqual([]);
      expect(r.snapshot.primary.canRetry).toBe(false);
      // Nothing of X is spent or dropped: the record and its count stay for the window that made it.
      expect(r.marks).toEqual({ reserved: k, transmitted: k });
      expect(r.kept).toBe(true);
    });
  }
  it("the same count of a record created here is sent again after its pause (the check above is not vacuous)", async () => {
    const r = await resumeKnownCount("answer.submit", 2, true);
    expect(r.read[0]).toBe(2);
    expect(r.posts).toBeGreaterThan(0);
    expect(r.states.has("retry_wait")).toBe(true);
  });
});
