import { describe, expect, it, vi } from "vitest";
import type { DictionarySearchResponse } from "../api/generated";
import { createDictionarySearchApi, validSearchPage, type SearchRequest } from "./searchApi";

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (): SearchRequest => ({ query: " <Ü & + % /?>\n", mode: "phrases", limit: 2, cursor_token: null });
function page(): DictionarySearchResponse {
  return { state_version: "9007199254740993", query: request().query, pair: "ru-de", mode: "phrases",
    next_cursor: "opaque_Cursor-1", items: [1, 2].map(n => ({ card_id: id(n), revision: "1", lemma: "Mädchen",
      type: "phrase", cefr: null, match_kind: "exact",
      translation: { common: ["общий", "<b>не HTML</b>\nвторой"], personal: { value: "мой\nперевод", version: "7" } } })),
    similar: [] };
}
const similarCard = (n: number, type: DictionarySearchResponse["items"][number]["type"] = "phrase") => ({
  card_id: id(n), revision: "2", lemma: "Ich gehe nach Hause", type, cefr: "A1" as const,
  translation: { common: ["я иду домой"], personal: null } });
function fixture(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  return { fetcher, api: createDictionarySearchApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000 }) };
}

describe("ordinary dictionary transport", () => {
  it("preserves raw query and all translations, encoding punctuation once", async () => {
    const body = page(), f = fixture(body);
    expect(await f.api.get("synthetic-token", request())).toEqual(body);
    const [url, options] = f.fetcher.mock.calls[0];
    const params = new URL(String(url), "https://synthetic.invalid").searchParams;
    expect(params.get("query")).toBe(request().query);
    expect(params.get("mode")).toBe("phrases");
    expect(params.has("include_phrases")).toBe(false);
    expect(params.get("limit")).toBe("2");
    expect(params.has("cursor_token")).toBe(false);
    expect(options).toMatchObject({ method: "GET", cache: "no-store", headers: { Authorization: "Bearer synthetic-token" } });
    expect(options!.body).toBeUndefined();
  });

  it("carries the cursor unchanged and accepts a real last page without caching", async () => {
    const body = page(); body.next_cursor = null; body.items = body.items.slice(1); body.similar = null;
    const f = fixture(body), req = { ...request(), cursor_token: "previous_token" };
    expect(await f.api.get("synthetic", req)).toEqual(body);
    expect(new URL(String(f.fetcher.mock.calls[0][0]), "https://synthetic.invalid").searchParams.get("cursor_token")).toBe("previous_token");
    await f.api.get("synthetic", req);
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("captures input before an asynchronous response", async () => {
    const f = fixture(page()), req = request();
    const pending = f.api.get("synthetic", req);
    req.query = "new query"; req.mode = "words"; req.limit = 1;
    expect(await pending).toEqual(page());
  });

  it("accepts empty results and missing common/personal without inventing data", async () => {
    const body = page(); body.next_cursor = null; body.items = [];
    expect(await fixture(body).api.get("synthetic", request())).toEqual(body);
    body.items = [page().items[0]];
    body.items[0].translation = { common: [], personal: null };
    expect(await fixture(body).api.get("synthetic", request())).toEqual(body);
  });

  const malformed: Array<[string, (x: DictionarySearchResponse) => void]> = [
    ["wrong query", x => { x.query = "trimmed"; }],
    ["wrong mode", x => { x.mode = "words"; }],
    ["word in phrases mode", x => { x.items[0].type = "noun"; }],
    ["legacy phrase flag", x => Object.assign(x, { include_phrases: true })],
    ["missing similar", x => { Reflect.deleteProperty(x, "similar"); }],
    ["null similar on first page", x => { x.similar = null; }],
    ["six similar", x => { x.similar = [1, 2, 3, 4, 5, 6].map(n => similarCard(10 + n)); }],
    ["duplicate similar", x => { x.similar = [similarCard(10), { ...similarCard(10), card_id: id(10).toUpperCase() }]; }],
    ["similar of the other mode", x => { x.similar = [similarCard(10, "noun")]; }],
    ["similar with rank", x => { x.similar = [{ ...similarCard(10), match_kind: "exact" } as never]; }],
    ["similar bad UUID", x => { x.similar = [{ ...similarCard(10), card_id: "card" }]; }],
    ["wrong pair", x => Object.assign(x, { pair: "de-ru" })],
    ["numeric version", x => Object.assign(x, { state_version: 1 })],
    ["overflow version", x => { x.state_version = "9223372036854775808"; }],
    ["extra error", x => Object.assign(x, { error: {} })],
    ["missing cursor", x => { Reflect.deleteProperty(x, "next_cursor"); }],
    ["blank cursor", x => { x.next_cursor = ""; }],
    ["invalid cursor", x => { x.next_cursor = "a+b"; }],
    ["cursor on empty page", x => { x.items = []; }],
    ["cursor on partial page", x => { x.items.pop(); }],
    ["too many items", x => { x.items.push({ ...x.items[1], card_id: id(3) }); }],
    ["duplicate ID", x => { x.items[1].card_id = x.items[0].card_id.toUpperCase(); }],
    ["reverse same-tier UUIDs", x => { x.items.reverse(); }],
    ["reverse tiers", x => { x.items[0].match_kind = "substring"; }],
    ["unknown tier", x => Object.assign(x.items[0], { match_kind: "similar" })],
    ["bad UUID", x => { x.items[0].card_id = "card"; }],
    ["bad revision", x => { x.items[0].revision = "0"; }],
    ["unknown type", x => Object.assign(x.items[0], { type: "invented" })],
    ["missing cefr", x => { Reflect.deleteProperty(x.items[0], "cefr"); }],
    ["object common", x => Object.assign(x.items[0].translation, { common: [{}] })],
    ["missing personal", x => { Reflect.deleteProperty(x.items[0].translation, "personal"); }],
    ["null personal text", x => Object.assign(x.items[0].translation.personal!, { value: null })],
    ["numeric personal version", x => Object.assign(x.items[0].translation.personal!, { version: 1 })],
    ["extra private field", x => Object.assign(x.items[0].translation, { hint: "hidden" })],
    ["sparse items", x => { delete x.items[0]; }],
    ["sparse translations", x => { delete x.items[0].translation.common[0]; }],
  ];
  it.each(malformed)("refuses %s without silently dropping a result", async (_name, mutate) => {
    const body = page(); mutate(body);
    expect(validSearchPage(body, request())).toBe(false);
    const f = fixture(body);
    await expect(f.api.get("synthetic", request())).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("accepts up to five similar cards beside ordinary items on the first page", async () => {
    const body = page(); body.similar = [1, 2, 3, 4, 5].map(n => similarCard(10 + n));
    expect(await fixture(body).api.get("synthetic", request())).toEqual(body);
    const words = { ...page(), mode: "words" as const, items: [], next_cursor: null, similar: [similarCard(20, "noun")] };
    expect(validSearchPage(words, { ...request(), mode: "words" })).toBe(true);
  });

  it("refuses similar cards on a continuation page", () => {
    const body = page(); body.next_cursor = null; body.items = body.items.slice(1);
    expect(validSearchPage({ ...body, similar: [] }, { ...request(), cursor_token: "previous_token" })).toBe(false);
  });

  it("refuses phrases on the explicit words request and a repeated cursor", () => {
    expect(validSearchPage({ ...page(), mode: "words" }, { ...request(), mode: "words" })).toBe(false);
    expect(validSearchPage(page(), { ...request(), cursor_token: page().next_cursor })).toBe(false);
  });

  it.each([401, 403, 409, 422, 503])("preserves refusal %s and never resets or retries a cursor", async status => {
    const f = fixture({ error: { code: "SEARCH_CURSOR_STALE" } }, status);
    await expect(f.api.get("synthetic", { ...request(), cursor_token: "old_cursor" }))
      .rejects.toMatchObject({ kind: "http", status, code: "SEARCH_CURSOR_STALE" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("requires exact status 200", async () => {
    await expect(fixture(page(), 201).api.get("synthetic", request())).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("does not retry after a network failure", async () => {
    const f = fixture(page()); f.fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(f.api.get("synthetic", request())).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([{ query: "" }, { query: "\ud800" }, { mode: "all" }, { mode: "Words" }, { mode: true }, { mode: undefined },
    { limit: true }, { limit: 0 },
    { limit: 1.5 }, { limit: Number.MAX_SAFE_INTEGER + 1 }, { cursor_token: "" }, { cursor_token: "a=b" }])
  ("does not dispatch invalid request %j", async changed => {
    const f = fixture(page());
    await expect(f.api.get("synthetic", { ...request(), ...changed } as SearchRequest)).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const f = fixture(page()); await expect(f.api.get("", request())).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
