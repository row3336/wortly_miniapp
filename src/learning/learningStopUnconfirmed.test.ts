// C229: which SESSION_CLOSED refusal of Stop may say «Занятие завершено.»: only one carrying the closed projection of its session.
import { describe, expect, it } from "vitest";
import { unconfirmedStopRefusal } from "./LearningScreen";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type State = Parameters<typeof unconfirmedStopRefusal>[0];
const state = (stop: Record<string, unknown>): State => ({ commands: { stop } } as unknown as State);
const refused = (current: unknown, extra: Record<string, unknown> = {}) => state({ outcome: "rejected", rejectionCode: "SESSION_CLOSED",
  resolved: { commandId: id(4), kind: "session.stop", sessionId: id(3) }, current, ...extra });

describe("unconfirmedStopRefusal", () => {
  it("a refusal for a session the core never had, or without any projection, proves no closure", () => {
    expect(unconfirmedStopRefusal(refused({ session_id: id(3), status: "not_found" }))).toBe(true);
    expect(unconfirmedStopRefusal(refused(null))).toBe(true);
  });
  it("only the closed projection of this very session confirms it (ids compared without case)", () => {
    expect(unconfirmedStopRefusal(refused({ session_id: id(3).toUpperCase(), status: "closed" }))).toBe(false);
    expect(unconfirmedStopRefusal(refused({ session_id: id(9), status: "closed" }))).toBe(true);
    expect(unconfirmedStopRefusal(refused({ session_id: id(3), status: "active" }))).toBe(true);
  });
  it("other outcomes and codes are not this case: the screen keeps its earlier texts", () => {
    expect(unconfirmedStopRefusal(refused({ session_id: id(3), status: "not_found" }, { outcome: "accepted" }))).toBe(false);
    expect(unconfirmedStopRefusal(refused({ session_id: id(3), status: "not_found" }, { rejectionCode: "SESSION_BUSY" }))).toBe(false);
    expect(unconfirmedStopRefusal(state({ outcome: null, rejectionCode: null, resolved: null, current: null }))).toBe(false);
  });
});
