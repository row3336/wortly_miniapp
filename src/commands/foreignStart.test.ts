import { describe, expect, it } from "vitest";
import { acceptedForeignStart } from "./foreignStart";

const S = "AAAAAAAA-0000-4000-8000-000000000001", T = "aaaaaaaa-0000-4000-8000-000000000002";
const lane = (over: Partial<Parameters<typeof acceptedForeignStart>[0] & object> = {}) => ({
  outcome: "accepted", resolved: { kind: "session.start", sessionId: S }, ...over });
/** Every mode owner (guard v3, C178): the proved mismatch is a fact field, never the shown problem. */
const mismatch = (id: string | null) => ({ pairMismatch: id });

describe("acceptedForeignStart (answer 17.1-А)", () => {
  it("names the session of an accepted start when the owner proved exactly that session open in another pair", () => {
    expect(acceptedForeignStart(lane(), mismatch(S.toLowerCase()))).toBe(S.toLowerCase());
    expect(acceptedForeignStart(lane(), mismatch(S))).toBe(S.toLowerCase());
  });
  it.each([
    ["an unknown start (lost reply, not checked)", lane({ outcome: null })],
    ["a rejected start", lane({ outcome: "rejected" })],
    ["a not applied start", lane({ outcome: "not_applied" })],
    ["another accepted command", lane({ resolved: { kind: "answer.submit", sessionId: S } })],
    ["no resolved command", lane({ resolved: null })],
  ])("names nothing for %s, even with the session proved in another pair", (_, value) => {
    expect(acceptedForeignStart(value, mismatch(S))).toBeNull();
  });
  it("names nothing for a start of the own pair (no proof), whatever the lane's or the owner's reason", () => {
    expect(acceptedForeignStart(lane(), mismatch(null))).toBeNull();
    // Neither the lane's reason nor a shown problem is the owner's proof about that session (guard v3, C178).
    const named = { ...lane(), problem: "pair_changed" } as ReturnType<typeof lane>;
    expect(acceptedForeignStart(named, mismatch(null))).toBeNull();
    expect(acceptedForeignStart(lane(), { pairMismatch: null, problem: "pair_changed", sessionId: S } as ReturnType<typeof mismatch>)).toBeNull();
  });
  it("names nothing when the proof is about another session", () => {
    expect(acceptedForeignStart(lane(), mismatch(T))).toBeNull();
  });
  it("names nothing without a lane or a view", () => {
    expect(acceptedForeignStart(null, mismatch(S))).toBeNull();
    expect(acceptedForeignStart(undefined, mismatch(S))).toBeNull();
    expect(acceptedForeignStart(lane(), null)).toBeNull();
  });
});
