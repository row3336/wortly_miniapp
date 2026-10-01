import { describe, expect, it, vi } from "vitest";
import type { PracticeResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { createPracticeApi, validPractice, type PracticeWeek } from "./practiceApi";

function body(week: PracticeWeek = "current"): PracticeResponse {
  const first = week === "current" ? "2026-03-23" : "2026-03-16";
  return { state_version: "9007199254740993", local_date: "2026-03-29", pair: "ru-de", time_zone: "Europe/Berlin",
    starts_at: week === "current" ? "2026-03-22T23:00:00Z" : "2026-03-15T23:00:00Z",
    ends_at: week === "current" ? "2026-03-29T22:00:00Z" : "2026-03-22T23:00:00Z",
    days: Array.from({ length: 7 }, (_, index) => {
      const date = new Date(`${first}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + index);
      return { local_date: date.toISOString().slice(0, 10), directions: { "l1-de": index, "de-l1": 0 } };
    }) };
}
function setup(value: unknown = body(), status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(status === 204 ? null : JSON.stringify(value), { status }));
  return { fetcher, api: createPracticeApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000 }) };
}

describe("practice aggregate HTTP", () => {
  it.each(["current", "previous"] as const)("requests %s explicitly and retains a local DST week and bigint version", async week => {
    const expected = body(week), { api, fetcher } = setup(expected);
    expect(await api.get("synthetic-token", week)).toEqual(expected);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/v1/statistics/practice?week=${week}`,
      expect.objectContaining({ method: "GET", cache: "no-store", headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }) }));
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
  });
  it("uses the server date at a year boundary and never supplies a device-date range", async () => {
    const value = body(); value.local_date = "2027-01-01"; value.starts_at = "2026-12-28T00:00:00Z";
    value.ends_at = "2027-01-04T00:00:00Z"; value.time_zone = "UTC";
    value.days.forEach((day, i) => { const d = new Date(value.starts_at); d.setUTCDate(d.getUTCDate() + i); day.local_date = d.toISOString().slice(0, 10); });
    expect(await setup(value).api.get("synthetic-token", "current")).toEqual(value);
  });
  it.each([201, 202, 204, 206])("rejects success-shaped HTTP %s", async status => {
    await expect(setup(body(), status).api.get("synthetic-token", "current")).rejects.toBeInstanceOf(ApiError);
  });
  it.each([401, 403, 409, 503])("preserves HTTP %s as failure without presenting counters", async status => {
    await expect(setup({ error: { code: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" } }, status).api.get("synthetic-token", "current"))
      .rejects.toMatchObject({ status });
  });
  it("rejects wrong requested week and contradictory error even with valid counters", async () => {
    await expect(setup(body("previous")).api.get("synthetic-token", "current")).rejects.toMatchObject({ kind: "invalid_response" });
    await expect(setup({ ...body(), error: { code: "FORBIDDEN" } }).api.get("synthetic-token", "current"))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });
  it("requires a token and an explicit supported week before any request", async () => {
    const { api, fetcher } = setup();
    await expect(api.get("", "current")).rejects.toThrow();
    await expect(api.get("synthetic-token", undefined as unknown as PracticeWeek)).rejects.toThrow();
    await expect(api.get("synthetic-token", "next" as PracticeWeek)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("strict practice facts", () => {
  it.each([
    ["version", (v: any) => { v.state_version = 1; }],
    ["oversized version", (v: any) => { v.state_version = "9223372036854775808"; }],
    ["pair", (v: any) => { v.pair = "de-ru"; }],
    ["date", (v: any) => { v.local_date = "2026-02-30"; }],
    ["zone", (v: any) => { v.time_zone = " "; }],
    ["naive range", (v: any) => { v.starts_at = "2026-03-22T23:00:00"; }],
    ["reversed range", (v: any) => { v.starts_at = v.ends_at; }],
    ["missing day", (v: any) => { v.days.pop(); }],
    ["extra day", (v: any) => { v.days.push(v.days[0]); }],
    ["sparse day", (v: any) => { delete v.days[1]; }],
    ["reordered day", (v: any) => { [v.days[0], v.days[1]] = [v.days[1], v.days[0]]; }],
    ["duplicate day", (v: any) => { v.days[1].local_date = v.days[0].local_date; }],
    ["missing direction", (v: any) => { delete v.days[0].directions["de-l1"]; }],
    ["extra direction", (v: any) => { v.days[0].directions.other = 1; }],
    ["negative count", (v: any) => { v.days[0].directions["l1-de"] = -1; }],
    ["fraction count", (v: any) => { v.days[0].directions["l1-de"] = 0.5; }],
    ["boolean count", (v: any) => { v.days[0].directions["l1-de"] = false; }],
    ["string count", (v: any) => { v.days[0].directions["l1-de"] = "1"; }],
    ["unsafe count", (v: any) => { v.days[0].directions["l1-de"] = Number.MAX_SAFE_INTEGER + 1; }],
    ["unknown root", (v: any) => { v.profile_id = "private"; }],
    ["unknown day", (v: any) => { v.days[0].results = []; }],
  ])("rejects malformed %s", (_, mutate) => {
    const value = body(); (mutate as (v: PracticeResponse) => void)(value);
    expect(validPractice(value, "current")).toBe(false);
  });
});
