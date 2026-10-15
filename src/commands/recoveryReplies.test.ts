// The classes of failed exchanges for automatic recovery (DESIGN D-RECOV table 2).
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/http";
import { ClosedAccessError } from "../app/openedAccess";
import { checkFailure, sendFailure } from "./recoveryReplies";

describe("recovery reply classes", () => {
  it("a POST failure names only the refusals the server proves; anything else is a lost reply", () => {
    // P03 M-P03-7: 401 asks for a new sign-in (reauth); 403 ends the access.
    expect(sendFailure(new ApiError("http", 401))).toEqual({ kind: "terminated", reason: "reauth" });
    expect(sendFailure(new ApiError("http", 403, "FORBIDDEN"))).toEqual({ kind: "terminated", reason: "access_lost" });
    expect(sendFailure(new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"))).toEqual({ kind: "mismatch" });
    expect(sendFailure(new ApiError("http", 409, "DOCUMENT_STALE"))).toEqual({ kind: "window_stale" });
    expect(sendFailure(new ApiError("http", 409, "CLIENT_INCOMPATIBLE"))).toEqual({ kind: "incompatible" });
    expect(sendFailure(new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 90 }))).toEqual({ kind: "maintenance", waitSeconds: 90 });
    expect(sendFailure(new ApiError("http", 503, "MAINTENANCE"))).toEqual({ kind: "maintenance", waitSeconds: null });
    expect(sendFailure(new ApiError("http", 503, "WRITE_UNAVAILABLE"))).toEqual({ kind: "lost", cause: "write_unavailable" });
    // Definite refusals (root decision, pending owner) and a client refusal before the network.
    expect(sendFailure(new ApiError("http", 422, "VALIDATION_FAILED"))).toEqual({ kind: "refused", code: "VALIDATION_FAILED" });
    expect(sendFailure(new ApiError("http", 409, "VERSION_CONFLICT"))).toEqual({ kind: "refused", code: "VERSION_CONFLICT" });
    expect(sendFailure(new ClosedAccessError())).toEqual({ kind: "not_sent" });
    for (const error of [new ApiError("network"), new ApiError("invalid_response"), new ApiError("http", 500),
      new ApiError("http", 503), new ApiError("http", 409, "OTHER"), new ApiError("http", 422, "OTHER"), new Error("boom"), "x"]) {
      expect(sendFailure(error)).toEqual({ kind: "lost", cause: "network" });
    }
  });
  it("a failed check never proves absence: anything unnamed is unreachable", () => {
    expect(checkFailure(new ApiError("http", 401))).toEqual({ kind: "terminated", reason: "reauth" });
    expect(checkFailure(new ApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH"))).toEqual({ kind: "mismatch" });
    expect(checkFailure(new ApiError("http", 409, "DOCUMENT_STALE"))).toEqual({ kind: "window_stale" });
    expect(checkFailure(new ApiError("http", 503, "MAINTENANCE", { waitSeconds: 30 }))).toEqual({ kind: "unreachable", pauseSeconds: 30 });
    for (const error of [new ApiError("network"), new ApiError("http", 503, "WRITE_UNAVAILABLE"), new ApiError("http", 404),
      new ApiError("http", 409, "CLIENT_INCOMPATIBLE"), new ApiError("http", 422, "VALIDATION_FAILED"), new ClosedAccessError(),
      new Error("boom")]) {
      expect(checkFailure(error)).toEqual({ kind: "unreachable" });
    }
  });
});
