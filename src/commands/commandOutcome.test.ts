import { describe, expect, it } from "vitest";
import { ApiError } from "../api/http";
import { commandOutcomeUnknown } from "./commandOutcome";

describe("the outcome of a sent command (CON:149)", () => {
  it("only an HTTP refusal below 500 proves that nothing was applied", () => {
    expect(commandOutcomeUnknown(new ApiError("http", 403, "FORBIDDEN"))).toBe(false);
    expect(commandOutcomeUnknown(new ApiError("http", 409, "CLIENT_INCOMPATIBLE"))).toBe(false);
    expect(commandOutcomeUnknown(new ApiError("http", 503, "MAINTENANCE"))).toBe(true);
    expect(commandOutcomeUnknown(new ApiError("network"))).toBe(true);
    expect(commandOutcomeUnknown(new ApiError("invalid_response"))).toBe(true);
    expect(commandOutcomeUnknown(new Error("closed_access"))).toBe(true);
    expect(commandOutcomeUnknown(new TypeError("network"))).toBe(true);
  });
});
