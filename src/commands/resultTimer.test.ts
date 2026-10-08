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
  it("a pause keeps the deadline for the same result only; any cancel forgets it", () => {
    const timer = new ResultTimer(), fire = vi.fn(), guard = { live: () => true, due: () => true };
    timer.start("s:r:1", 3000, guard, fire);
    vi.advanceTimersByTime(2000); timer.pause(); expect(timer.view()).toBeNull();
    vi.advanceTimersByTime(500);
    timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()!.durationMs).toBe(500);
    vi.advanceTimersByTime(499); expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fire).toHaveBeenCalledOnce();

    timer.start("s:r:1", 3000, guard, fire);
    vi.advanceTimersByTime(1000); timer.pause(); timer.pause(); timer.start("s:r:2", 3000, guard, fire);
    expect(timer.view()!.durationMs).toBe(3000); // another result (e.g. a corrected grade) starts afresh
    timer.cancel(); timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()!.durationMs).toBe(3000);
    vi.advanceTimersByTime(1000); timer.pause(); timer.discardPause(); timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()!.durationMs).toBe(3000);
  });
  it("a shorter mode caps the remainder; arming the running result again does not restart it", () => {
    const timer = new ResultTimer(), fire = vi.fn(), guard = { live: () => true, due: () => true };
    timer.start("s:r:1", 3000, guard, fire);
    vi.advanceTimersByTime(500); timer.pause(); timer.start("s:r:1", 2000, guard, fire);
    expect(timer.view()!.durationMs).toBe(2000);
    vi.advanceTimersByTime(1500); timer.start("s:r:1", 2000, guard, fire);
    expect(timer.view()!.durationMs).toBe(500);
    vi.advanceTimersByTime(500); expect(fire).toHaveBeenCalledOnce();
  });
  it("a pause forgotten by cancel or by a background (cancel after pause) is not used by the next arm of the same result", () => {
    const timer = new ResultTimer(), fire = vi.fn(), guard = { live: () => true, due: () => true };
    timer.start("s:r:1", 3000, guard, fire);
    vi.advanceTimersByTime(1000); timer.pause(); timer.cancel(); timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()).toEqual({ key: "s:r:1:2", durationMs: 3000 });
    timer.cancel();
    timer.start("s:r:1", 3000, guard, fire);
    vi.advanceTimersByTime(1000); timer.pause(); timer.cancel(); // what suspend() does to a paused timer
    vi.advanceTimersByTime(500); timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()!.durationMs).toBe(3000);
  });
  it("the view tells how much of the original countdown is already spent, only after a pause", () => {
    const timer = new ResultTimer(), fire = vi.fn(), guard = { live: () => true, due: () => true };
    timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()).not.toHaveProperty("elapsedMs");
    vi.advanceTimersByTime(2000); timer.pause(); timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()).toMatchObject({ durationMs: 1000, elapsedMs: 2000 });
    vi.advanceTimersByTime(400); timer.pause(); timer.start("s:r:1", 3000, guard, fire);
    expect(timer.view()).toMatchObject({ durationMs: 600, elapsedMs: 2400 });
  });
  it("arming another result while one runs silences the older callback", () => {
    const timer = new ResultTimer(), old = vi.fn(), fire = vi.fn(), guard = { live: () => true, due: () => true };
    timer.start("s:r:1", 1000, guard, old);
    timer.start("s:r:2", 2000, guard, fire);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2000); expect(old).not.toHaveBeenCalled(); expect(fire).toHaveBeenCalledOnce();
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
