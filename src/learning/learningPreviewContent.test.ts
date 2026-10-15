import { describe, expect, it, vi } from "vitest";
import type { LearningPreviewContent } from "../api/generated";
import { createSessionReadApi } from "../study/sessionReadApi";
import { createLearningSessionApi } from "./learningSessionApi";
import { previewContent } from "./learningPreview.test-support";
import { validLearningPreviewContent } from "./learningPreviewContent";
import { testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pronouns = ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"] as const;
function content(kind: LearningPreviewContent["card"]["type"] = "verb"): LearningPreviewContent {
  const value = previewContent(id(7)); value.card.type = kind;
  value.translations.personal = { value: "мой перевод", version: "9007199254740993" };
  value.examples = { common: [{ id: id(8), text: "<b>Wenn</b> er käme.", role: null,
    highlighted_parts: ["Wenn", { legacy: [0, "käme", null, true] }] }], personal: { value: "Mein Beispiel.", version: "1" } };
  if (kind === "noun") value.grammar = { gender: "neuter", gender_status: "applicable", singular: "Haus", singular_status: "applicable",
    plural: "Häuser", plural_status: "applicable", article_status: "applicable" };
  if (kind === "verb") {
    value.grammar = { infinitive: "gehen", infinitive_status: "applicable", preterite: null, preterite_status: "unknown",
      participle_ii: "gegangen", participle_ii_status: "applicable", auxiliary: "sein", auxiliary_status: "applicable", separability: "inseparable" };
    value.reference_conjugations = ["present", "preterite"].map(tense => ({ tense: tense as "present" | "preterite",
      forms: pronouns.map(pronoun_group => ({ pronoun_group, value: null, status: "unknown" })) }));
  }
  if (kind === "adjective") value.grammar = { positive: "gut", positive_status: "applicable", comparative: "besser",
    comparative_status: "applicable", superlative: "am besten", superlative_status: "applicable" };
  if (kind === "preposition") value.grammar = { category: { id: id(9), name: "Wechsel" }, cases: [{ id: id(10), name: "Dativ" }] };
  if (kind === "conjunction") value.grammar = { meaning_category: { id: id(9), name: "konditional" }, verb_position: { id: id(10), name: "Verb am Ende" } };
  return value;
}

describe("Learning preview reference data", () => {
  it.each(["noun", "verb", "adjective", "preposition", "conjunction", "particle", "adverb", "pronoun", "phrase"] as const)(
    "accepts %s reference shape without selecting examples or granting practice", async kind => {
      const value = content(kind), current = { session_id: id(3), mode: "learning", status: "active", pair: "ru-de",
        local_date: "2026-09-30", close_reason: null, group: { id: id(20), status: "assembling", version: "1", total: 1, preview_position: 0 },
        preview: { id: id(21), card_id: id(7), position: 1, total: 1, content: value }, assignment: null };
      const response = { current, state_version: "3" }, fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response)));
      const options = { fetcher, timeoutMs: 100, maxResponseBytes: 20000, gate: testGate() };
      const address = { session_id: id(3), client_instance_id: id(1), document_id: id(2) };
      expect(await createSessionReadApi(options).read("token", "proof", address)).toEqual(response);
      expect(await createLearningSessionApi(options).read("token", "proof", address)).toEqual(response);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(current.preview.content.examples.personal!.value).toBe("Mein Beispiel.");
      expect(current.preview.content.examples.common).toHaveLength(1);
    });
  it.each(["ru-de", "uk-de", "en-de"] as const)("binds content to %s and the exact delivered card", pair => {
    const value = content(); value.pair = pair;
    expect(validLearningPreviewContent(value, id(7), pair)).toBe(true);
    expect(validLearningPreviewContent(value, id(99), pair)).toBe(false);
    expect(validLearningPreviewContent(value, id(7), pair === "ru-de" ? "uk-de" : "ru-de")).toBe(false);
  });
  it.each(["noun", "verb", "adjective", "preposition", "conjunction"] as const)("preserves absent legacy %s grammar", kind => {
    const value = content(kind); value.grammar = null;
    expect(validLearningPreviewContent(value, id(7), "ru-de")).toBe(true);
  });
  it.each(["unknown", "applicable", "not_applicable"] as const)("preserves null value with %s status, without guessing completeness", status => {
    const value = content(); Object.assign(value.grammar!, { preterite: null, preterite_status: status });
    value.reference_conjugations[0].forms[0] = { pronoun_group: "ich", value: null, status };
    expect(validLearningPreviewContent(value, id(7), "ru-de")).toBe(true);
  });
  const malformed: [string, (value: Record<string, any>) => void][] = [
    ["internal root field", x => { x.schema_version = 1; }],
    ["wrong pair", x => { x.pair = "uk-de"; }],
    ["different card", x => { x.card.id = id(9); }],
    ["hidden card field", x => { x.card.answer = "hidden"; }],
    ["numeric revision", x => { x.card.revision = 1; }],
    ["out-of-range revision", x => { x.card.revision = "9223372036854775808"; }],
    ["unrecognized card type", x => { x.card.type = "idiom"; }],
    ["phrase with verb grammar", x => { x.card.type = "phrase"; }],
    ["unknown CEFR", x => { x.card.cefr = "C3"; }],
    ["absent grammar field", x => { delete x.grammar.preterite_status; }],
    ["wrong grammar", x => { x.card.type = "noun"; }],
    ["unexpected grammar field", x => { x.grammar.answers = []; }],
    ["unsupported auxiliary", x => { x.grammar.auxiliary = "ist"; }],
    ["unsupported separability", x => { x.grammar.separability = "sometimes"; }],
    ["false applicability", x => { x.grammar.infinitive_status = "not_applicable"; }],
    ["unknown status", x => { x.grammar.preterite_status = "missing"; }],
    ["number as form", x => { x.grammar.preterite = 2; }],
    ["numeric translation", x => { x.translations.common = [2]; }],
    ["bad personal version", x => { x.translations.personal.version = "0"; }],
    ["extra personal field", x => { x.translations.personal.owner = id(99); }],
    ["personal example as list", x => { x.examples.personal = ["Beispiel"]; }],
    ["opaque example wrapper", x => { x.examples.common = [{ content: "hidden" }]; }],
    ["unknown example role", x => { x.examples.common[0].role = "new"; }],
    ["HTML property", x => { x.examples.common[0].innerHTML = "<b>bad</b>"; }],
    ["nonarray highlights", x => { x.examples.common[0].highlighted_parts = {}; }],
    ["non-JSON highlight", x => { x.examples.common[0].highlighted_parts = [undefined]; }],
    ["nonfinite highlight", x => { x.examples.common[0].highlighted_parts = [Infinity]; }],
    ["duplicated tense", x => { x.reference_conjugations[1].tense = "present"; }],
    ["unsupported tense", x => { x.reference_conjugations[0].tense = "future"; }],
    ["missing pronoun", x => { x.reference_conjugations[0].forms.pop(); }],
    ["duplicate pronoun", x => { x.reference_conjugations[0].forms[0].pronoun_group = "du"; }],
    ["invented training rights", x => { x.reference_conjugations[0].openable = true; }],
    ["inapplicable form with value", x => { x.reference_conjugations[0].forms[0] = { pronoun_group: "ich", value: "gehe", status: "not_applicable" }; }],
    ["reference tables for particle", x => { x.card.type = "particle"; x.grammar = null; }],
    ["missing association", x => { delete x.association; }],
    ["legacy hint", x => { x.hint = null; }],
  ];
  it.each(malformed)("rejects unsafe or inconsistent content: %s", (_name, change) => {
    const value = content(); change(value);
    expect(validLearningPreviewContent(value, id(7), "ru-de")).toBe(false);
  });
  it("requires the correct taxonomy shape without inventing category names", () => {
    const value = content("preposition"); Object.assign(value.grammar!, { category: { id: "bad", name: "Wechsel" } });
    expect(validLearningPreviewContent(value, id(7), "ru-de")).toBe(false);
    const conjunction = content("conjunction"); Object.assign(conjunction.grammar!, { cases: [] });
    expect(validLearningPreviewContent(conjunction, id(7), "ru-de")).toBe(false);
  });
  it("handles a broad JSON metadata array without expanding it into function arguments", () => {
    const value = content(); value.examples.common[0].highlighted_parts = Array.from({ length: 150000 }, () => null);
    expect(validLearningPreviewContent(value, id(7), "ru-de")).toBe(true);
  });
});
