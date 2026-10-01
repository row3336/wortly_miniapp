import { describe, expect, it } from "vitest";
import { entryReducer } from "./entryState";

describe("entry state machine", () => {
  it("keeps admitted access in opening until real bootstrap arrives", () => {
    expect(entryReducer({ kind: "checking" }, { type: "ACCESS_ADMITTED" })).toEqual({ kind: "opening" });
  });

  it("does not reapply on reopening a rejected profile", () => {
    const rejected = { kind: "rejected" as const, reason: "Access review" };
    expect(entryReducer(rejected, { type: "ACCESS_ADMITTED" })).toEqual(rejected);
    expect(entryReducer(rejected, { type: "REAPPLY_STARTED" })).toEqual({ kind: "reapplying", reason: "Access review" });
  });

  it("shows pending only after reapply is confirmed", () => {
    const reapplying = entryReducer({ kind: "rejected" }, { type: "REAPPLY_STARTED" });
    expect(reapplying.kind).toBe("reapplying");
    expect(entryReducer(reapplying, { type: "REAPPLY_FAILED" }).kind).toBe("rejected");
    expect(entryReducer(reapplying, { type: "REAPPLY_CONFIRMED" }).kind).toBe("pending");
  });

  it("separates unavailable from a confirmed pending state", () => {
    expect(entryReducer({ kind: "checking" }, { type: "ACCESS_UNAVAILABLE" })).toEqual({ kind: "unavailable" });
    expect(entryReducer({ kind: "pending" }, { type: "ACCESS_UNAVAILABLE" })).toEqual({ kind: "pending" });
    expect(entryReducer({ kind: "unavailable" }, { type: "RETRY_AUTH" })).toEqual({ kind: "checking" });
  });
});
