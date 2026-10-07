import { describe, expect, it } from "vitest";
import { validDictionaryViewContent, validReferenceCardContent } from "./referenceCardContent";
import { validLearningPreviewContent } from "../learning/learningPreviewContent";

const cardId = "a0000000-0000-4000-8000-000000000001";
type Content = Record<string, unknown>;

function content(): Content {
  return {
    pair: "ru-de", card: { id: cardId, revision: "9007199254740993", lemma: "gehen", type: "verb", cefr: null },
    translations: { common: ["идти", "ходить"], personal: { value: "своё", version: "4" } }, grammar: null,
    reference_conjugations: [], examples: { common: [], personal: null }, association: null,
  };
}
const versions = () => ({ translation: "4", example: "1", association: "9007199254740993" });
const viewContent = (): Content => ({ ...content(), field_versions: versions() });

const legacyHint: [string, (x: Content) => void][] = [
  ["legacy hint", x => { x.hint = null; }],
  ["legacy hint value", x => { x.hint = { value: "подсказка", version: "1" }; }],
];

describe("card read and Learning content: no hint, no editor versions", () => {
  it("accepts the plain contract shape", () => {
    expect(validReferenceCardContent(content(), cardId, "ru-de")).toBe(true);
    expect(validLearningPreviewContent(content(), cardId, "ru-de")).toBe(true);
  });

  it.each([...legacyHint, ["editor versions", (x: Content) => { x.field_versions = versions(); }]] as [string, (x: Content) => void][])(
    "rejects %s", (_name, change) => {
      const value = content(); change(value);
      expect(validReferenceCardContent(value, cardId, "ru-de")).toBe(false);
      expect(validLearningPreviewContent(value, cardId, "ru-de")).toBe(false);
    });
});

describe("card view content: required exact field versions", () => {
  it("accepts every own field's version, also without personal values", () => {
    expect(validDictionaryViewContent(viewContent(), cardId, "ru-de")).toBe(true);
  });

  it.each([
    ...legacyHint,
    ["missing field versions", x => { delete x.field_versions; }],
    ["null field versions", x => { x.field_versions = null; }],
    ["field versions missing a field", x => { x.field_versions = { translation: "1", example: "1" }; }],
    ["field versions with hint", x => { x.field_versions = { ...versions(), hint: "1" }; }],
    ["numeric field version", x => { x.field_versions = { ...versions(), translation: 1 }; }],
    ["zero field version", x => { x.field_versions = { ...versions(), example: "0" }; }],
    ["other card", x => { (x.card as Content).id = "a0000000-0000-4000-8000-000000000002"; }],
  ] as [string, (x: Content) => void][])("rejects %s", (_name, change) => {
    const value = viewContent(); change(value);
    expect(validDictionaryViewContent(value, cardId, "ru-de")).toBe(false);
  });
});

describe("two-case preposition pair (К05-127, К07-121): strict, never a mix", () => {
  const location = { id: "b0000000-0000-4000-8000-000000000001", text: "Ich bin in der Stadt.", role: "wechsel_location", highlighted_parts: [] };
  const direction = { id: "b0000000-0000-4000-8000-000000000002", text: "Ich gehe in die Stadt.", role: "wechsel_direction", highlighted_parts: [] };
  const editor = (akk: string | null = null, dat: string | null = null) => ({
    akkusativ: { value: akk, version: akk === null ? "1" : "2" }, dativ: { value: dat, version: dat === null ? "1" : "2" } });
  const commonPair = (akk: string | null = null, dat: string | null = null) => ({
    editor: editor(akk, dat), effective: { source: "common", akkusativ: direction, dativ: location } });
  const personalPair = () => ({ editor: editor("A.", "D."), effective: {
    source: "personal", akkusativ: { value: "A.", version: "2" }, dativ: { value: "D.", version: "2" } } });
  function preposition(pair?: unknown): Content {
    const value = content();
    value.card = { ...(value.card as Content), type: "preposition" };
    value.examples = { common: [location, direction], personal: null, ...(pair === undefined ? {} : { preposition_pair: pair }) };
    return value;
  }
  const view = (pair?: unknown): Content => ({ ...preposition(pair), field_versions: versions() });

  it.each([["none", commonPair()], ["one own role", commonPair("A.")], ["full own pair", personalPair()]] as [string, unknown][])(
    "accepts the pair with %s in every place", (_name, pair) => {
      expect(validReferenceCardContent(preposition(pair), cardId, "ru-de")).toBe(true);
      expect(validLearningPreviewContent(preposition(pair), cardId, "ru-de")).toBe(true);
      expect(validDictionaryViewContent(view(pair), cardId, "ru-de")).toBe(true);
    });

  it("lets a frozen read omit the pair but requires it in the current view", () => {
    expect(validReferenceCardContent(preposition(), cardId, "ru-de")).toBe(true);
    expect(validLearningPreviewContent(preposition(), cardId, "ru-de")).toBe(true);
    expect(validDictionaryViewContent(view(), cardId, "ru-de")).toBe(false);
  });

  it.each([
    ["mixed own and common", () => ({ ...commonPair("A."), effective: { source: "common", akkusativ: { value: "A.", version: "2" }, dativ: location } })],
    ["personal with one own role", () => ({ editor: editor("A."), effective: { source: "personal", akkusativ: { value: "A.", version: "2" }, dativ: { value: null, version: "1" } } })],
    ["common although the own pair is full", () => commonPair("A.", "D.")],
    ["swapped common roles", () => ({ ...commonPair(), effective: { source: "common", akkusativ: location, dativ: direction } })],
    ["personal text differs from editor", () => ({ ...personalPair(), effective: { ...personalPair().effective, dativ: { value: "X.", version: "2" } } })],
    ["duplicate role key spelled differently", () => ({ ...commonPair(), editor: { akkusativ: editor().akkusativ, Dativ: editor().dativ } })],
    ["unknown source", () => ({ ...commonPair(), effective: { ...commonPair().effective, source: "mixed" } })],
    ["extra key", () => ({ ...commonPair(), chosen: "akkusativ" })],
    ["zero version", () => ({ ...commonPair(), editor: { ...editor(), dativ: { value: null, version: "0" } } })],
    ["null pair", () => null],
  ] as [string, () => unknown][])("rejects %s", (_name, pair) => {
    expect(validReferenceCardContent(preposition(pair()), cardId, "ru-de")).toBe(false);
    expect(validDictionaryViewContent(view(pair()), cardId, "ru-de")).toBe(false);
  });

  it.each([["empty", ""], ["blank", "  "]])("rejects a full pair with an %s own role in every place", (_name, blank) => {
    const pair = { editor: { akkusativ: { value: "A.", version: "2" }, dativ: { value: blank, version: "2" } }, effective: {
      source: "personal", akkusativ: { value: "A.", version: "2" }, dativ: { value: blank, version: "2" } } };
    expect(validReferenceCardContent(preposition(pair), cardId, "ru-de")).toBe(false);
    expect(validLearningPreviewContent(preposition(pair), cardId, "ru-de")).toBe(false);
    expect(validDictionaryViewContent(view(pair), cardId, "ru-de")).toBe(false);
  });

  it("compares the pair by fields, not by key order", () => {
    const highlighted = { ...direction, highlighted_parts: [{ start: 0, end: 3 }] };
    const reordered = { highlighted_parts: [{ end: 3, start: 0 }], role: "wechsel_direction", text: direction.text, id: direction.id };
    const common = preposition({ editor: editor(), effective: { dativ: { ...location }, akkusativ: reordered, source: "common" } });
    (common.examples as Content).common = [location, highlighted];
    expect(validReferenceCardContent(common, cardId, "ru-de")).toBe(true);
    const own = preposition({ effective: { source: "personal", dativ: { version: "2", value: "D." }, akkusativ: { version: "2", value: "A." } },
      editor: { dativ: { version: "2", value: "D." }, akkusativ: { value: "A.", version: "2" } } });
    expect(validReferenceCardContent(own, cardId, "ru-de")).toBe(true);
  });

  it("rejects a full own pair when a common wechsel example is missing (frozen reads)", () => {
    for (const kept of [[location], [direction], []]) {
      const value = preposition(personalPair());
      (value.examples as Content).common = kept;
      expect(validReferenceCardContent(value, cardId, "ru-de")).toBe(false);
      expect(validLearningPreviewContent(value, cardId, "ru-de")).toBe(false);
    }
  });

  it("rejects a pair on a non-preposition or without both common wechsel examples", () => {
    const other = preposition(commonPair());
    other.card = { ...(other.card as Content), type: "adverb" };
    expect(validReferenceCardContent(other, cardId, "ru-de")).toBe(false);
    const single = preposition(commonPair());
    (single.examples as Content).common = [location];
    expect(validReferenceCardContent(single, cardId, "ru-de")).toBe(false);
    const plainView = view();
    (plainView.examples as Content).common = [location];
    expect(validDictionaryViewContent(plainView, cardId, "ru-de")).toBe(true);
  });
});
