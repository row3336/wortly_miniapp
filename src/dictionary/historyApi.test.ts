import { describe, expect, it, vi } from "vitest";
import type { DictionaryHistoryResponse } from "../api/generated";
import { createDictionaryHistoryApi, HISTORY_LIMIT, validDictionaryHistory } from "./historyApi";
import { testGate } from "../commands/testGate.test-support";

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minute: number) => `2026-10-06T10:${String(minute).padStart(2, "0")}:00Z`;
function body(count = 2): DictionaryHistoryResponse {
  return { state_version: "9007199254740993", pair: "ru-de", items: Array.from({ length: count }, (_, n) =>
    ({ card_id: id(n + 1), opened_at: at(59 - n), lemma: `Wort${n + 1}`, type: "noun", cefr: n % 2 ? null : "B1" })) };
}
function fixture(value: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  return { fetcher, api: createDictionaryHistoryApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() }) };
}

describe("dictionary history read", () => {
  it("K07-094/P19: one authenticated GET without parameters returns the server list with its rows unchanged", async () => {
    const value = body(HISTORY_LIMIT), f = fixture(value);
    expect(await f.api.read("synthetic")).toEqual(value);
    expect(f.fetcher).toHaveBeenCalledOnce();
    const [url, init] = f.fetcher.mock.calls[0];
    expect(url).toBe("/api/v1/dictionary/history");
    expect(init).toMatchObject({ method: "GET", cache: "no-store", headers: { Authorization: "Bearer synthetic" } });
    expect(init!.body).toBeUndefined();
  });

  it("accepts an empty history and equal or earlier clock times in server order", () => {
    expect(validDictionaryHistory({ state_version: "1", pair: "uk-de", items: [] })).toBe(true);
    const value = body(3);
    value.items[1].opened_at = value.items[0].opened_at;
    value.items[2].opened_at = "2026-10-06T11:00:00.123456+00:00";
    expect(validDictionaryHistory(value)).toBe(true);
  });

  it.each<[string, (value: DictionaryHistoryResponse) => void]>([
    ["21 entries", value => { value.items.push(...body(HISTORY_LIMIT + 1).items.slice(2)); }],
    ["a repeated card in another case", value => { value.items[1].card_id = id(1).toUpperCase(); }],
    ["a bad card ID", value => { value.items[0].card_id = "card"; }],
    ["a local time", value => { value.items[0].opened_at = "2026-10-06T10:00:00"; }],
    ["a translation in the row (P18)", value => { Object.assign(value.items[0], { translation: { common: ["дом"], personal: null } }); }],
    ["a missing lemma", value => { Reflect.deleteProperty(value.items[0], "lemma"); }],
    ["an empty lemma", value => { value.items[0].lemma = ""; }],
    ["an unknown card type", value => { Object.assign(value.items[0], { type: "article" }); }],
    ["an unknown level", value => { Object.assign(value.items[0], { cefr: "D1" }); }],
    ["a missing level", value => { Reflect.deleteProperty(value.items[0], "cefr"); }],
    ["a missing pair", value => { Reflect.deleteProperty(value, "pair"); }],
    ["an unknown pair", value => { Object.assign(value, { pair: "de-de" }); }],
    ["a missing state version", value => { Reflect.deleteProperty(value, "state_version"); }],
    ["a zero state version", value => { value.state_version = "0"; }],
    ["an extra top-level field", value => { Object.assign(value, { next_cursor: null }); }],
  ])("refuses %s", async (_name, mutate) => {
    const value = body(); mutate(value);
    expect(validDictionaryHistory(value)).toBe(false);
    await expect(fixture(value).api.read("synthetic")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("reports server refusals and requires a token before any request", async () => {
    const denied = fixture({ error: { code: "ACCESS_DENIED" } }, 403);
    await expect(denied.api.read("synthetic")).rejects.toMatchObject({ status: 403 });
    const f = fixture(body());
    await expect(f.api.read("")).rejects.toThrow("token is required");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
