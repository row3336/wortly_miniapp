// The auto-advance timer of a result (M-REFAC-CMD): a cancel or a newer arm silences every older callback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResultTimer } from "./resultTimer";

describe("result timer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("fires once after its duration and names the shown result and its generation", () => {
    const timer = new ResultTimer(), fire = vi.fn();
    timer.start("s:r:1", 3000, { live: () => true, due: () => true }, fire);
    expect(timer.view()).toEqual({ key: "s:r:1:0", durationMs: 3000 });
    vi.advanceTimersByTime(2999); expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fire).toHaveBeenCalledOnce(); expect(timer.view()).toBeNull();
  });
  it("a cancel (background, a new question, a revision) starts a new generation", () => {
    const timer = new ResultTimer(), fire = vi.fn();
    timer.start("s:r:1", 2000, { live: () => true, due: () => true }, fire);
    timer.cancel(); expect(timer.view()).toBeNull();
    timer.start("s:r:1", 2000, { live: () => true, due: () => true }, fire);
    expect(timer.view()!.key).toBe("s:r:1:1");
    vi.advanceTimersByTime(2000); expect(fire).toHaveBeenCalledOnce();
  });
  it("a dead owner or a view that can no longer advance keeps the timer silent", () => {
    const timer = new ResultTimer(), fire = vi.fn();
    let live = false, due = true;
    timer.start("a", 1000, { live: () => live, due: () => due }, fire);
    vi.advanceTimersByTime(1000); expect(fire).not.toHaveBeenCalled();
    live = true; due = false;
    timer.start("b", 1000, { live: () => live, due: () => due }, fire);
    vi.advanceTimersByTime(1000); expect(fire).not.toHaveBeenCalled();
    // The silent callback leaves its own view: only a cancel or a fire clears it.
    expect(timer.view()).toEqual({ key: "b:0", durationMs: 1000 });
  });
  it("the guard is asked live first and due last, after the generation check", () => {
    const timer = new ResultTimer(), calls: string[] = [];
    timer.start("a", 1000, { live: () => { calls.push("live"); return true; }, due: () => { calls.push("due"); return true; } }, () => calls.push("fire"));
    vi.advanceTimersByTime(1000); expect(calls).toEqual(["live", "due", "fire"]);
    calls.length = 0;
    timer.start("b", 1000, { live: () => { calls.push("live"); return true; }, due: () => { calls.push("due"); return true; } }, () => calls.push("fire"));
    const stale = vi.getTimerCount(); timer.cancel(); expect(vi.getTimerCount()).toBe(stale - 1);
  });
});
