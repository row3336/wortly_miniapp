import { describe, expect, it, vi } from "vitest";
import type { StatisticsOverviewResponse } from "../api/generated";
import type { PracticeWeek } from "./practiceApi";
import { createStatisticsApi, validStatistics } from "./statisticsApi";

function body(week: PracticeWeek = "current", pair: StatisticsOverviewResponse["pair"] = "ru-de"): StatisticsOverviewResponse {
  const first = week === "current" ? "2026-03-23" : "2026-03-16";
  return {
    state_version: "9007199254740993", local_date: "2026-03-29", pair, time_zone: "Europe/Berlin",
    base: { total: 10, words: 8, phrases: 2,
      by_type: { noun: 1, verb: 1, phrase: 2, adjective: 1, pronoun: 1, adverb: 1, preposition: 1, conjunction: 1, particle: 1 } },
    ready: { words: { "l1-de": 8, "de-l1": 3 }, phrases: { "l1-de": 2, "de-l1": 0 } },
    practice: { state_version: "9007199254740993", local_date: "2026-03-29", pair, time_zone: "Europe/Berlin",
      starts_at: week === "current" ? "2026-03-22T23:00:00Z" : "2026-03-15T23:00:00Z",
      ends_at: week === "current" ? "2026-03-29T22:00:00Z" : "2026-03-22T23:00:00Z",
      days: Array.from({ length: 7 }, (_, index) => {
        const day = new Date(`${first}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + index);
        return { local_date: day.toISOString().slice(0, 10), words: index, phrases: 0 };
      }) },
  };
}
function setup(value: unknown = body(), status = 200, maxResponseBytes = 10000) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(status === 204 ? null : JSON.stringify(value), { status }));
  return { fetcher, api: createStatisticsApi({ fetcher, timeoutMs: 1000, maxResponseBytes }) };
}
type Mutation = [string, (value: any) => void];

describe("1. synthetic overview snapshots and exact GET", () => {
  it.each(["ru-de", "uk-de", "en-de"] as const)("accepts %s in both explicit weeks", async pair => {
    for (const week of ["current", "previous"] as const) {
      const expected = body(week, pair), { api, fetcher } = setup(expected);
      expect(await api.get("synthetic-token", week)).toEqual(expected);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/statistics/overview?week=${week}`,
        expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin",
          headers: { Authorization: "Bearer synthetic-token" }, body: undefined }));
    }
  });
  it("accepts an empty current base with daily historical practice outside it", async () => {
    const value = body(); value.base.total = value.base.words = value.base.phrases = 0;
    for (const type of Object.keys(value.base.by_type) as (keyof typeof value.base.by_type)[]) value.base.by_type[type] = 0;
    value.ready = { words: { "l1-de": 0, "de-l1": 0 }, phrases: { "l1-de": 0, "de-l1": 0 } };
    value.practice.days[0].phrases = Number.MAX_SAFE_INTEGER;
    expect(await setup(value).api.get("synthetic-token", "current")).toEqual(value);
    value.practice.days.forEach(day => { day.words = day.phrases = 0; });
    expect(validStatistics(value, "current")).toBe(true);
  });
});

describe("2. exact object keys", () => {
  it.each<Mutation>([
    ["body extra", v => { v.error = {}; }], ["body missing", v => { delete v.ready; }],
    ["base extra", v => { v.base.other = 0; }], ["base missing", v => { delete v.base.words; }],
    ["type extra", v => { v.base.by_type.other = 0; }], ["type missing", v => { delete v.base.by_type.noun; }],
    ["ready extra", v => { v.ready.other = {}; }], ["ready missing", v => { delete v.ready.phrases; }],
    ["direction extra", v => { v.ready.words.other = 0; }], ["direction missing", v => { delete v.ready.phrases["de-l1"]; }],
    ["base array", v => { v.base = []; }], ["ready null", v => { v.ready = null; }],
  ])("rejects %s", (_, mutate) => { const value = body(); mutate(value); expect(validStatistics(value, "current")).toBe(false); });
  it.each([null, [], false, "overview"])("rejects non-object %j", value => expect(validStatistics(value, "current")).toBe(false));
});

describe("3. outer version, calendar and pair", () => {
  it.each<Mutation>([
    ["numeric version", v => { v.state_version = 1; }], ["zero version", v => { v.state_version = "0"; }],
    ["signed64 overflow", v => { v.state_version = "9223372036854775808"; }], ["padded version", v => { v.state_version = "01"; }],
    ["invalid date", v => { v.local_date = "2026-02-30"; }], ["zero year", v => { v.local_date = "0000-03-29"; }],
    ["reversed pair", v => { v.pair = "de-ru"; }], ["empty zone", v => { v.time_zone = " "; }],
  ])("rejects %s", (_, mutate) => { const value = body(); mutate(value); expect(validStatistics(value, "current")).toBe(false); });
  it("retains the maximum signed64 version without numeric coercion", () => {
    const value = body(); value.state_version = value.practice.state_version = "9223372036854775807";
    expect(validStatistics(value, "current")).toBe(true);
  });
});

describe("4. safe counts and exact base sums", () => {
  it.each([-1, 0.5, true, "1", null, Number.MAX_SAFE_INTEGER + 1])("rejects count %j at every count surface", bad => {
    for (const mutate of [
      (v: any) => { v.base.total = bad; }, (v: any) => { v.base.words = bad; }, (v: any) => { v.base.phrases = bad; },
      (v: any) => { v.base.by_type.noun = bad; }, (v: any) => { v.ready.words["l1-de"] = bad; },
      (v: any) => { v.ready.phrases["de-l1"] = bad; }, (v: any) => { v.practice.days[0].words = bad; },
    ]) { const value = body(); mutate(value); expect(validStatistics(value, "current")).toBe(false); }
  });
  it.each<Mutation>([
    ["type sum", v => { v.base.by_type.verb++; }], ["phrase type", v => { v.base.by_type.phrase--; v.base.by_type.noun++; }],
    ["bucket sum", v => { v.base.words--; }],
    ["type sum overflow", v => { v.base.by_type.noun = Number.MAX_SAFE_INTEGER; v.base.total = Number.MAX_SAFE_INTEGER; }],
    ["bucket sum overflow", v => { v.base.words = Number.MAX_SAFE_INTEGER; v.base.total = Number.MAX_SAFE_INTEGER; }],
  ])("rejects %s", (_, mutate) => { const value = body(); mutate(value); expect(validStatistics(value, "current")).toBe(false); });
  it("accepts an exact maximum-safe total", () => {
    const value = body(); value.base.total = Number.MAX_SAFE_INTEGER; value.base.words = Number.MAX_SAFE_INTEGER - 2;
    value.base.by_type.noun = Number.MAX_SAFE_INTEGER - 9;
    expect(validStatistics(value, "current")).toBe(true);
  });
});

describe("5. ready bounds apply per bucket and direction", () => {
  it.each(["words", "phrases"] as const)("rejects excess %s in either direction", bucket => {
    for (const direction of ["l1-de", "de-l1"] as const) {
      const value = body(); value.ready[bucket][direction] = value.base[bucket] + 1;
      expect(validStatistics(value, "current")).toBe(false);
    }
  });
});

describe("6. reuse practice validation and bind its snapshot", () => {
  it.each<Mutation>([
    ["version mismatch", v => { v.practice.state_version = "2"; }],
    ["pair mismatch", v => { v.practice.pair = "uk-de"; }], ["zone mismatch", v => { v.practice.time_zone = "UTC"; }],
    ["date mismatch", v => { v.practice.local_date = "2026-03-28"; }],
    ["practice extra", v => { v.practice.other = 0; }], ["missing day", v => { v.practice.days.pop(); }],
    ["extra day field", v => { v.practice.days[0].other = 0; }], ["wrong day", v => { v.practice.days[0].local_date = "2026-03-24"; }],
    ["legacy practice directions", (v: any) => { v.practice.days[0].directions = { "l1-de": 0, "de-l1": 0 }; }],
    ["naive boundary", v => { v.practice.starts_at = "2026-03-22T23:00:00"; }],
    ["reversed boundary", v => { v.practice.starts_at = v.practice.ends_at; }],
  ])("rejects %s", async (_, mutate) => {
    const value = body(); mutate(value);
    await expect(setup(value).api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("rejects a valid practice snapshot for the other requested week", () => {
    expect(validStatistics(body("previous"), "current")).toBe(false);
    expect(validStatistics(body(), "previous")).toBe(false);
  });
});

describe("7. admission before fetching", () => {
  it("requires token and explicit supported week", async () => {
    const { api, fetcher } = setup();
    await expect(api.get("", "current")).rejects.toThrow();
    for (const week of [undefined, null, "next", "current&other=1"])
      await expect(api.get("synthetic-token", week as PracticeWeek)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("8. single bounded exchange and errors", () => {
  it.each([201, 202, 204, 206])("rejects success-shaped status %s", async status => {
    const { api, fetcher } = setup(body(), status);
    await expect(api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 409, 503])("preserves HTTP %s without retry", async status => {
    const { api, fetcher } = setup({ error: { code: "FORBIDDEN" } }, status);
    await expect(api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "http", status, code: "FORBIDDEN" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("uses the existing transport byte bound", async () => {
    const { api, fetcher } = setup(body(), 200, 16);
    await expect(api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports malformed JSON", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("{", { status: 200 }));
    const api = createStatisticsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000 });
    await expect(api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("reports network failure without retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("synthetic network failure"); });
    const api = createStatisticsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000 });
    await expect(api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "network" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retains the transport deadline for an unresponsive fetch", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
      const api = createStatisticsApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000 });
      const failure = expect(api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "network" });
      await vi.advanceTimersByTimeAsync(1000); await failure;
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
