import { describe, expect, it } from "vitest";
import { acceptedEvent } from "../journal/events";
import { NOTICE_SHOWN_ACCEPTED } from "./noticeJournal";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cts = "2026-10-17T08:00:00.000Z";

// c.screen(notice_shown) (events ред.3.6.4 §4.5; core 35c3844 ScreenEvent._notice_by_kind): open since M1b.
describe("c.screen(notice_shown) passes exactly as the core accepts it", () => {
  it("the seam is open while the generated contract carries the kind", () => { expect(NOTICE_SHOWN_ACCEPTED).toBe(true); });
  it("names its notice and nothing else", () => {
    expect(acceptedEvent({ cts, ev: "c.screen", kind: "notice_shown", notice: id(101) }))
      .toEqual({ cts, ev: "c.screen", kind: "notice_shown", notice: id(101) });
    expect(acceptedEvent({ cts, ev: "c.screen", kind: "notice_shown" })).toBeNull();
    expect(acceptedEvent({ cts, ev: "c.screen", kind: "notice_shown", notice: "x" })).toBeNull();
    for (const extra of [{ cmd: id(5) }, { code: "NOT_FOUND" }, { grade: "correct" }]) {
      expect(acceptedEvent({ cts, ev: "c.screen", kind: "notice_shown", notice: id(101), ...extra })).toBeNull();
    }
  });
  it("no other kind names a notice", () => {
    expect(acceptedEvent({ cts, ev: "c.screen", kind: "result_shown", cmd: id(5), notice: id(101) })).toBeNull();
    expect(acceptedEvent({ cts, ev: "c.screen", kind: "result_shown", cmd: id(5) })).toEqual({ cts, ev: "c.screen", kind: "result_shown", cmd: id(5) });
  });
});
