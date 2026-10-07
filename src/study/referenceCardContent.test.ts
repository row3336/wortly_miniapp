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
