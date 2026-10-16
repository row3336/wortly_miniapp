// fix5 (QA r7 Y11): the «На Сегодня» of a refusal screen names a П01 episode only for a session.start refused SESSION_BUSY.
import { describe, expect, it } from "vitest";
import { startRefusalIntent } from "./startRefusal";

const ID = "00000000-0000-4000-8000-000000000123";
const lane = (outcome: string | null, kind: string, rejectionCode: string | null) =>
  ({ outcome, rejectionCode, resolved: { kind, commandId: ID } });

describe("startRefusalIntent", () => {
  it("names the command of a session.start refused SESSION_BUSY", () => {
    expect(startRefusalIntent(lane("rejected", "session.start", "SESSION_BUSY"))).toEqual({ startRefused: ID });
  });
  it.each([
    ["another refusal code of the start", lane("rejected", "session.start", "SESSION_NOT_ACTIVE")],
    ["a refusal without a code", lane("rejected", "session.start", null)],
    ["SESSION_BUSY of another command", lane("rejected", "session.stop", "SESSION_BUSY")],
    ["an accepted start", lane("accepted", "session.start", "SESSION_BUSY")],
    ["no outcome yet", lane(null, "session.start", "SESSION_BUSY")],
    ["no lane", null],
  ])("gives nothing for %s", (_name, primary) => {
    expect(startRefusalIntent(primary)).toBeUndefined();
  });
});
