// D-FALSE-TEXTS part A: when a lane's «not_found» may hide the generic refresh-failure line. Each negative row is an
// older or foreign marker that must NOT hide the real cause found by the other lane or by the session read.
import { describe, expect, it } from "vitest";
import { onlyCheckedAbsent } from "./commandLane";

const lane = (problem: string | null, rejectionCode: string | null = null) => ({ problem, rejectionCode });

describe("onlyCheckedAbsent", () => {
  it.each([
    ["one lane holds not_found, the other is quiet", [lane("not_found"), lane(null)]],
    ["the other lane holds not_found", [lane(null), lane("not_found")]],
    ["both lanes hold not_found", [lane("not_found"), lane("not_found")]],
  ])("hides: %s", (_name, lanes) => { expect(onlyCheckedAbsent(lanes, null)).toBe(true); });

  it.each([
    ["no lane holds it", [lane(null), lane(null)]],
    ["the other lane lost the connection", [lane("not_found"), lane("network")]],
    ["the first lane lost the connection, the second holds an old not_found", [lane("network"), lane("not_found")]],
    ["the other lane got a stale answer", [lane("not_found"), lane("stale_response")]],
    ["the stale answer is the first lane's, the old marker the second's", [lane("stale_response"), lane("not_found")]],
    ["the other lane has a local storage failure", [lane("not_found"), lane("storage")]],
    ["the other lane is blocked by a changed slot", [lane("not_found"), lane("pending_changed")]],
    ["the other lane met a conflict", [lane("not_found"), lane("mismatch")]],
    ["the other lane carries a refusal", [lane("not_found"), lane(null, "SESSION_CLOSED")]],
    ["the lane itself carries a refusal", [lane("not_found", "ASSIGNMENT_STALE"), lane(null)]],
    ["the step changed in the other lane", [lane("not_found"), lane("step_changed")]],
  ])("keeps the line: %s", (_name, lanes) => { expect(onlyCheckedAbsent(lanes, null)).toBe(false); });

  it.each(["network", "load", "stale_response", "SESSION_BUSY", "unconfirmed_session", "not_found"])(
    "keeps the line when the session read or the document reports %s beside a lane's not_found", other => {
      expect(onlyCheckedAbsent([lane("not_found"), lane(null)], other)).toBe(false);
    });
});
