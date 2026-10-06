import { describe, expect, it, vi } from "vitest";
import type { StatisticsOverviewResponse } from "../api/generated";
import { ApiError } from "../api/http";
import type { PracticeWeek } from "./practiceApi";
import { StatisticsController, type StatisticsSnapshot, type StatisticsSource } from "./statisticsController";

function data(state_version = "1", pair: StatisticsOverviewResponse["pair"] = "ru-de"): StatisticsOverviewResponse {
  return { state_version, pair, local_date: "2026-09-30", time_zone: "UTC",
    base: { total: 0, words: 0, phrases: 0, by_type: { noun: 0, verb: 0, phrase: 0, adjective: 0,
      pronoun: 0, adverb: 0, preposition: 0, conjunction: 0, particle: 0 } },
    ready: { words: { "l1-de": 0, "de-l1": 0 }, phrases: { "l1-de": 0, "de-l1": 0 } },
    practice: { state_version, pair, local_date: "2026-09-30", time_zone: "UTC",
      starts_at: "2026-09-28T00:00:00Z", ends_at: "2026-10-05T00:00:00Z",
      days: Array.from({ length: 7 }, (_, index) => ({ local_date: index < 3 ? `2026-09-${28 + index}` : `2026-10-0${index - 2}`,
        words: 0, phrases: 0 })) } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let live = true, minimum: string | null = null;
  const updates: StatisticsSnapshot[] = [];
  const controller = new StatisticsController({ isLive: () => live, minimumStateVersion: () => minimum,
    onUpdate: state => { updates.push(state); } });
  const get = vi.fn<StatisticsSource["get"]>(async () => data());
  const source = { identity: {}, get };
  return { controller, source, get, updates, close: () => { live = false; }, floor: (value: string | null) => { minimum = value; } };
}

describe("statistics read ownership", () => {
  it("waits for an explicit source, pair and week and keeps access out of snapshots", async () => {
    const f = fixture();
    expect(f.controller.snapshot().phase).toBe("idle"); expect(f.get).not.toHaveBeenCalled();
    await f.controller.load(f.source, "ru-de", "previous");
    expect(f.get).toHaveBeenCalledExactlyOnceWith("previous");
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pair: "ru-de", week: "previous", data: data() });
    expect(JSON.stringify(f.updates)).not.toMatch(/token|proof|identity|document/);
  });

  it.each(["success", "denial"])("ignores late %s from the older week", async outcome => {
    const f = fixture(), old = deferred<StatisticsOverviewResponse>(), fresh = deferred<StatisticsOverviewResponse>();
    f.get.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = f.controller.load(f.source, "ru-de", "current");
    const second = f.controller.load(f.source, "ru-de", "previous");
    fresh.resolve(data("4")); await second;
    const before = f.controller.snapshot(), events = f.updates.length;
    if (outcome === "success") old.resolve(data("9")); else old.reject(new ApiError("http", 401));
    await first;
    expect(f.controller.snapshot()).toEqual(before); expect(f.updates).toHaveLength(events);
  });

  it("clears the old document's values and version floor on source replacement", async () => {
    const f = fixture(); f.get.mockResolvedValueOnce(data("9007199254740993"));
    await f.controller.load(f.source, "ru-de", "current");
    const pending = deferred<StatisticsOverviewResponse>();
    const next: StatisticsSource = { identity: {}, get: vi.fn(() => pending.promise) };
    const loading = f.controller.load(next, "uk-de", "current");
    expect(f.controller.snapshot()).toMatchObject({ phase: "loading", data: null, pair: "uk-de" });
    pending.resolve(data("1", "uk-de")); await loading;
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", data: { state_version: "1", pair: "uk-de" } });
  });

  it("does not publish a late response from the replaced document", async () => {
    const f = fixture(), old = deferred<StatisticsOverviewResponse>(); f.get.mockReturnValueOnce(old.promise);
    const first = f.controller.load(f.source, "ru-de", "current");
    await f.controller.load({ identity: {}, get: async () => data("1", "en-de") }, "en-de", "current");
    old.resolve(data("9223372036854775807")); await first;
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", data: { pair: "en-de", state_version: "1" } });
  });

  it("rejects a response for another pair without exposing its counts", async () => {
    const f = fixture(); f.get.mockResolvedValueOnce(data("2", "en-de"));
    await f.controller.load(f.source, "ru-de", "current");
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "pair_changed" });
  });

  it("compares versions exactly, retains a source floor across weeks and accepts equal-version fresh data", async () => {
    const f = fixture(); f.get.mockResolvedValueOnce(data("9007199254740993"));
    await f.controller.load(f.source, "ru-de", "current");
    f.get.mockResolvedValueOnce(data("9007199254740992"));
    await f.controller.load(f.source, "ru-de", "previous");
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    const changed = data("9007199254740993"); changed.local_date = "2026-10-01";
    f.get.mockResolvedValueOnce(changed); await f.controller.load(f.source, "ru-de", "current");
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", data: { local_date: "2026-10-01" } });
  });

  it("honors a shared floor both while waiting and after a response has been published", async () => {
    const f = fixture(), pending = deferred<StatisticsOverviewResponse>(); f.get.mockReturnValueOnce(pending.promise);
    const reading = f.controller.load(f.source, "ru-de", "current");
    f.floor("7"); pending.resolve(data("6")); await reading;
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    f.get.mockResolvedValueOnce(data("7")); await f.controller.load(f.source, "ru-de", "current");
    expect(f.controller.snapshot().phase).toBe("ready"); f.floor("8");
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    for (const fallback of [null, "7"]) {
      f.floor(fallback);
      expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    }
    f.floor(null); f.get.mockResolvedValueOnce(data("7"));
    await f.controller.load(f.source, "ru-de", "previous");
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    f.get.mockResolvedValueOnce(data("8")); await f.controller.load(f.source, "ru-de", "current");
    expect(f.controller.snapshot().phase).toBe("ready");
    await f.controller.load({ identity: {}, get: async () => data("1") }, "ru-de", "current");
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", data: { state_version: "1" } });
  });

  it.each([[401, "expired"], [403, "forbidden"], [409, "load"], [503, "load"]] as const)(
    "maps HTTP %s, removes old data, and does not retry", async (status, problem) => {
      const f = fixture(); await f.controller.load(f.source, "ru-de", "current");
      f.get.mockRejectedValueOnce(new ApiError("http", status, "SYNTHETIC"));
      await f.controller.load(f.source, "ru-de", "current");
      expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem });
      expect(f.get).toHaveBeenCalledTimes(2);
    });

  it("allows explicit recovery after network failure with no timer or hidden retry", async () => {
    const f = fixture(); f.get.mockRejectedValueOnce(new ApiError("network"));
    await f.controller.load(f.source, "ru-de", "current");
    expect(f.controller.snapshot().problem).toBe("load"); expect(f.get).toHaveBeenCalledTimes(1);
    await f.controller.load(f.source, "ru-de", "current");
    expect(f.controller.snapshot().phase).toBe("ready"); expect(f.get).toHaveBeenCalledTimes(2);
  });

  it("detaches source responses, observer values and snapshots", async () => {
    const f = fixture(), response = data("3"); f.get.mockResolvedValueOnce(response);
    await f.controller.load(f.source, "ru-de", "current");
    response.base.total = 42; f.updates.at(-1)!.data!.base.total = 99;
    const snapshot = f.controller.snapshot(); snapshot.data!.base.total = 24;
    expect(f.controller.snapshot().data!.base.total).toBe(0);
  });

  it.each(["dispose", "lease"])("silences an in-flight response after %s ends the owner", async reason => {
    const f = fixture(), pending = deferred<StatisticsOverviewResponse>(); f.get.mockReturnValueOnce(pending.promise);
    const read = f.controller.load(f.source, "ru-de", "current"), count = f.updates.length;
    if (reason === "dispose") f.controller.dispose(); else f.close();
    pending.resolve(data()); await read;
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", data: null });
    expect(f.updates).toHaveLength(count);
    await f.controller.load(f.source, "ru-de", "previous"); expect(f.get).toHaveBeenCalledTimes(1);
  });

  it("a reentrant loading observer may dispose before fetch", async () => {
    const get = vi.fn(async () => data());
    const controller = new StatisticsController({ isLive: () => true, onUpdate: () => controller.dispose() });
    await controller.load({ identity: {}, get }, "ru-de", "current"); expect(get).not.toHaveBeenCalled();
  });

  it("a reentrant loading observer may replace the requested period before fetch", async () => {
    const source = { identity: {}, get: vi.fn(async () => data()) };
    let replacement: Promise<void> | undefined;
    const controller = new StatisticsController({ isLive: () => true, onUpdate: state => {
      if (state.phase === "loading" && state.week === "current") replacement = controller.load(source, "ru-de", "previous");
    } });
    await controller.load(source, "ru-de", "current"); await replacement;
    expect(source.get).toHaveBeenCalledExactlyOnceWith("previous");
    expect(controller.snapshot()).toMatchObject({ phase: "ready", week: "previous" });
  });

  it("rejects missing period or invalid pair before changing state or fetching", async () => {
    const f = fixture();
    await expect(f.controller.load(f.source, "ru-de", undefined as unknown as PracticeWeek)).rejects.toThrow();
    await expect(f.controller.load(f.source, "de-ru" as "ru-de", "current")).rejects.toThrow();
    expect(f.get).not.toHaveBeenCalled(); expect(f.controller.snapshot().phase).toBe("idle");
  });
});
