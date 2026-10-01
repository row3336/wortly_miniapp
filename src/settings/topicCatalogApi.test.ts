import { describe, expect, it, vi } from "vitest";
import type { TopicCatalogResponse } from "../api/generated";
import { createTopicCatalogApi } from "./topicCatalogApi";

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
function catalog(): TopicCatalogResponse {
  return { state_version: "9007199254740995", topics: Array.from({ length: 32 }, (_, n) => ({
    id: id(n), number: n + 1, german_name: `Über Größen ${n + 1}`,
    description: "Äpfel, Öl, Häuser, Straße.\n<em>Wörtlich</em> — кириллица 🇩🇪\n".repeat(60),
  })) };
}
function fixture(body: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
  return { fetcher, api: createTopicCatalogApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 500000 }) };
}

describe("topic catalog reader", () => {
  it("reads more than the demo's 18 topics with full German and multiline text", async () => {
    const expected = catalog(), f = fixture(expected);
    expect(await f.api.get("synthetic-token")).toEqual(expected);
    expect(f.fetcher).toHaveBeenCalledExactlyOnceWith("/api/v1/settings/topics", expect.objectContaining({
      method: "GET", body: undefined, headers: { Authorization: "Bearer synthetic-token" }, cache: "no-store",
    }));
  });

  it("accepts a real empty catalog without synthesizing topics", async () => {
    const body = { ...catalog(), topics: [] };
    expect(await fixture(body).api.get("synthetic")).toEqual(body);
  });

  it("fetches again even when the profile version is unchanged", async () => {
    const f = fixture(catalog()); await f.api.get("synthetic");
    const changed = catalog(); changed.topics[0].description = "New actual content";
    f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify(changed)));
    expect(await f.api.get("synthetic")).toEqual(changed); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  const bad: Array<[string, (value: TopicCatalogResponse) => void]> = [
    ["numeric version", x => Object.assign(x, { state_version: 4 })],
    ["padded version", x => { x.state_version = "01"; }],
    ["overflow version", x => { x.state_version = "9223372036854775808"; }],
    ["missing topics", x => { Reflect.deleteProperty(x, "topics"); }],
    ["null topics", x => Object.assign(x, { topics: null })],
    ["missing id", x => { Reflect.deleteProperty(x.topics[0], "id"); }],
    ["invalid id", x => { x.topics[0].id = "topic"; }],
    ["duplicate UUID ignoring case", x => { x.topics[1].id = x.topics[0].id.toUpperCase(); }],
    ["zero number", x => { x.topics[0].number = 0; }],
    ["fraction number", x => { x.topics[0].number = 0.5; }],
    ["oversize number", x => { x.topics.at(-1)!.number = 2147483648; }],
    ["string number", x => Object.assign(x.topics[0], { number: "1" })],
    ["duplicate number", x => { x.topics[1].number = x.topics[0].number; }],
    ["unordered catalog", x => { x.topics.reverse(); }],
    ["blank name", x => { x.topics[0].german_name = "  "; }],
    ["missing description", x => { Reflect.deleteProperty(x.topics[0], "description"); }],
    ["null description", x => Object.assign(x.topics[0], { description: null })],
    ["empty description", x => { x.topics[0].description = ""; }],
    ["sparse list", x => { delete x.topics[1]; }],
    ["success with error", x => Object.assign(x, { error: { code: "WRITE_UNAVAILABLE" } })],
  ];
  it.each(bad)("rejects %s as a failed read, without dropping records or substituting an empty list", async (_name, mutate) => {
    const body = catalog(); mutate(body); const f = fixture(body);
    await expect(f.api.get("synthetic")).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 503])("preserves HTTP %s and its stable code without retrying", async status => {
    const f = fixture({ error: { code: "SYNTHETIC_REFUSAL" } }, status);
    await expect(f.api.get("synthetic")).rejects.toMatchObject({ kind: "http", status, code: "SYNTHETIC_REFUSAL" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("does not fall back to demo data after a network failure", async () => {
    const f = fixture(catalog()); f.fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(f.api.get("synthetic")).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("does not issue an unauthenticated catalog request", async () => {
    const f = fixture(catalog()); await expect(f.api.get("")).rejects.toThrow("token is required");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
