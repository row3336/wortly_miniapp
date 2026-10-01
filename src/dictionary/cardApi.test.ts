import { describe, expect, it, vi } from "vitest";
import type { DictionaryCardContent, DictionaryCardResponse } from "../api/generated";
import { validLearningPreviewContent } from "../learning/learningPreviewContent";
import { previewContent } from "../learning/learningPreview.test-support";
import { createDictionaryCardApi, validDictionaryCard } from "./cardApi";

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, "0")}`;
function content(): DictionaryCardContent {
  const value: DictionaryCardContent = previewContent(id(1));
  value.card.type = "phrase";
  value.card.revision = "9007199254740993";
  value.card.lemma = "<script>plain text</script>\n Auf Wiedersehen!";
  value.translations = { common: ["до свидания", "до встречи"], personal: { value: " мой перевод\n", version: "7" } };
  value.examples = { common: [null, "general", "wechsel_location", "wechsel_direction"].map((role, index) => ({
    id: id(index + 2), text: "<b>Wenn</b> er kommt.", role: role as null | "general" | "wechsel_location" | "wechsel_direction",
    highlighted_parts: ["Wenn", [0, 4], { legacy: [null, true, 1] }] })), personal: { value: "Mein Beispiel.", version: "8" } };
  value.association = { value: "моя ассоциация", version: "9" };
  value.hint = { value: "моя подсказка", version: "10" };
  return value;
}
const body = (): DictionaryCardResponse => ({ state_version: "9007199254740993", current: content() });
function fixture(value: unknown = body(), status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status }));
  return { fetcher, api: createDictionaryCardApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000 }) };
}

describe("dictionary card read", () => {
  it.each(["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"] as const)(
    "accepts %s with missing legacy grammar and all distinct candidates", async kind => {
      const current = content(); current.card.type = kind;
      const value = { state_version: "7", current }, f = fixture(value);
      expect(await f.api.read("synthetic", id(1))).toEqual(value);
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.fetcher.mock.calls[0][0]).toBe(`/api/v1/dictionary/cards/${id(1)}`);
      expect(f.fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store",
        headers: { Authorization: "Bearer synthetic" } });
      expect(f.fetcher.mock.calls[0][1]!.body).toBeUndefined();
      expect(f.fetcher.mock.calls[0][1]!.headers).not.toHaveProperty("X-Origin-Proof");
    });

  it("keeps Learning's narrower type boundary after extracting common validation", () => {
    const current = content();
    expect(validDictionaryCard({ state_version: "1", current }, id(1))).toBe(true);
    expect(validLearningPreviewContent(current, id(1), "ru-de")).toBe(false);
    current.card.type = "particle";
    expect(validLearningPreviewContent(current, id(1), "ru-de")).toBe(true);
  });

  it.each(["ru-de", "uk-de", "en-de"] as const)("takes the current %s pair from the server", async pair => {
    const current = content(); current.pair = pair;
    const value = { state_version: "9223372036854775807", current };
    expect(await fixture(value).api.read("synthetic", id(1).toUpperCase())).toEqual(value);
  });

  it("reads again without a cache and accepts unavailable without inventing a field version", async () => {
    const unavailable = { state_version: "4", current: { status: "unavailable" } }, f = fixture(unavailable);
    expect(await f.api.read("synthetic", id(1))).toEqual(unavailable);
    await f.api.read("synthetic", id(1));
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    const current = content(); current.translations.personal = null; current.translations.common = [];
    expect(await fixture({ state_version: "5", current }).api.read("synthetic", id(1)))
      .toMatchObject({ current: { translations: { common: [], personal: null } } });
  });

  const malformed: Array<[string, (x: Record<string, any>) => void]> = [
    ["numeric state version", x => { x.state_version = 1; }],
    ["version overflow", x => { x.state_version = "9223372036854775808"; }],
    ["version leading zero", x => { x.state_version = "01"; }],
    ["extra top-level error", x => { x.error = { code: "FORBIDDEN" }; }],
    ["missing current", x => { delete x.current; }],
    ["different card", x => { x.current.card.id = id(99); }],
    ["wrong pair", x => { x.current.pair = "de-ru"; }],
    ["numeric revision", x => { x.current.card.revision = 1; }],
    ["unknown type", x => { x.current.card.type = "unknown"; }],
    ["unknown CEFR", x => { x.current.card.cefr = "C3"; }],
    ["private card property", x => { x.current.card.profile_id = id(99); }],
    ["invented training permission", x => { x.current.actions = ["learn"]; }],
    ["common values containing nontext", x => { x.current.translations.common = [3]; }],
    ["personal missing version", x => { delete x.current.translations.personal.version; }],
    ["personal internal metadata", x => { x.current.examples.personal.profile_id = id(99); }],
    ["missing examples", x => { delete x.current.examples; }],
    ["example HTML property", x => { x.current.examples.common[0].innerHTML = "<b>bad</b>"; }],
    ["invalid highlighted parts", x => { x.current.examples.common[0].highlighted_parts = {}; }],
    ["unknown example role", x => { x.current.examples.common[0].role = "invented"; }],
    ["phrase with unrelated grammar", x => { x.current.grammar = { category: { id: id(9), name: "Wechsel" }, cases: [] }; }],
    ["phrase with conjugations", x => { x.current.reference_conjugations = [{ tense: "present", forms: [] }]; }],
    ["unversioned association", x => { x.current.association = { value: "text" }; }],
    ["missing hint", x => { delete x.current.hint; }],
    ["unavailable leaks a pair", x => { x.current = { status: "unavailable", pair: "ru-de" }; }],
    ["unavailable leaks an ID", x => { x.current = { status: "unavailable", card_id: id(1) }; }],
    ["unavailable with content", x => { x.current.status = "unavailable"; }],
  ];
  it.each(malformed)("rejects %s without a retry", async (_name, mutate) => {
    const value = body(); mutate(value);
    expect(validDictionaryCard(value, id(1))).toBe(false);
    const f = fixture(value);
    await expect(f.api.read("synthetic", id(1))).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("rejects nonfinite metadata from real JSON parsing", async () => {
    const text = JSON.stringify(body()).replace('"highlighted_parts":[', '"highlighted_parts":[1e400,');
    const fetcher = vi.fn<typeof fetch>(async () => new Response(text));
    const api = createDictionaryCardApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000 });
    await expect(api.read("synthetic", id(1))).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 409, 422, 503])("preserves refusal %s without content or automatic retry", async status => {
    const f = fixture({ error: { code: "WRITE_UNAVAILABLE" } }, status);
    await expect(f.api.read("synthetic", id(1))).rejects.toMatchObject({ kind: "http", status, code: "WRITE_UNAVAILABLE" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it("requires exact 200 and does not replace network errors with unavailable", async () => {
    await expect(fixture(body(), 201).api.read("synthetic", id(1))).rejects.toMatchObject({ kind: "invalid_response" });
    const f = fixture(); f.fetcher.mockRejectedValueOnce(new Error("offline"));
    await expect(f.api.read("synthetic", id(1))).rejects.toMatchObject({ kind: "network" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });

  it.each(["", "not-a-card", `${id(1)}?profile_id=foreign`, `../${id(1)}`, null, 1])(
    "rejects malformed address %j before dispatch", async address => {
      const f = fixture();
      await expect(f.api.read("synthetic", address as string)).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    });

  it("requires authentication before dispatch", async () => {
    const f = fixture(); await expect(f.api.read("", id(1))).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
