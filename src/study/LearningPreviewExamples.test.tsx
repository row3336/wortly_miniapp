import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CardExample, CardExamples, DictionaryCardContent, LearningPreviewContent } from "../api/generated";
import { LearningPreviewCard } from "../learning/LearningPreviewCard";
import { previewContent } from "../learning/learningPreview.test-support";
import { LearningPreviewExamples, renderLearningPreviewExamples } from "./LearningPreviewExamples";
import { validCardExamples } from "./referenceCardContent";
import { ReferenceCardBody } from "./ReferenceCardBody";

afterEach(cleanup);
const cardId = "00000000-0000-4000-8000-0000000000a1";
const exampleId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const common = (index: number, text: string, role: CardExample["role"] = "general",
  highlighted_parts: CardExample["highlighted_parts"] = []): CardExample => ({ id: exampleId(index), text, role, highlighted_parts });
const personal = (value: string) => ({ value, version: "5" });

function preview(examples: CardExamples, type: LearningPreviewContent["card"]["type"] = "particle", lemma = "doch"): LearningPreviewContent {
  expect(validCardExamples(examples)).toBe(true);
  const value = previewContent(cardId); value.card = { ...value.card, type, lemma };
  return { ...value, translations: { common: ["ведь"], personal: null }, examples };
}
function showPreview(examples: CardExamples, type?: LearningPreviewContent["card"]["type"], lemma?: string) {
  return render(<LearningPreviewCard content={preview(examples, type, lemma)} language="ru"
    renderExamples={renderLearningPreviewExamples} />);
}
const sentences = (root: ParentNode) => Array.from(root.querySelectorAll("p.german-example"), node => node.textContent);
const strongTexts = (root: ParentNode) => Array.from(root.querySelectorAll("p.german-example strong"), node => node.textContent);
const threeCommon = [common(1, "Ich gehe in die Schule.", "wechsel_direction", [{ start: 9, end: 11 }]),
  common(2, "Ich bin in der Schule.", "wechsel_location", [{ start: 8, end: 10 }]), common(3, "Gemeinsamer Satz.")];
const plainCommon = [common(1, "Erster Satz."), common(2, "Zweiter Satz.", null), common(3, "Dritter Satz.")];

function expectNoCommonAnywhere(container: HTMLElement, items: readonly CardExample[]) {
  for (const item of items) {
    expect(container.textContent).not.toContain(item.text);
    expect(container.innerHTML).not.toContain(item.text);
  }
}

describe("Learning preview examples (current CardExamples shape)", () => {
  it.each([0, 1, 3])("X1 shows only the personal example when %i common examples exist", count => {
    const items = plainCommon.slice(0, count);
    const { container } = showPreview({ common: items, personal: personal("Mein eigener Satz.") });
    expect(sentences(container)).toEqual(["Mein eigener Satz."]);
    expect(screen.getByText("Mein eigener Satz.").getAttribute("lang")).toBe("de");
    expect(strongTexts(container)).toEqual([]);
    expectNoCommonAnywhere(container, items);
  });

  // К05-127 (04.10) replaces the former X1 Wechsel expectation: a single personal example no longer hides the pair.
  it("К05-127 a single personal example does not replace both wechsel examples", () => {
    const own = "Ich laufe in den Park.";
    const { container } = showPreview({ common: threeCommon.slice(0, 2), personal: personal(own) }, "preposition", "in");
    expect(sentences(container)).toEqual(["Ich gehe in die Schule.", "Ich bin in der Schule."]);
    expect(strongTexts(container)).toEqual(["in", "in"]);
    expect(container.textContent).not.toContain(own);
  });

  it("К05-127 the pair marker is the two roles, not the card type, and every common example stays visible", () => {
    const { container } = showPreview({ common: threeCommon, personal: personal("Mein Satz.") }, "particle", "doch");
    expect(sentences(container)).toEqual(threeCommon.map(item => item.text));
    expect(container.textContent).not.toContain("Mein Satz.");
  });

  // Data precondition К05-110: a learning card never has only one wechsel role; this only pins the marker.
  it("a single wechsel role is not the pair marker", () => {
    const { container } = showPreview({ common: [threeCommon[0], threeCommon[2]], personal: personal("Mein Satz.") },
      "preposition", "in");
    expect(sentences(container)).toEqual(["Mein Satz."]);
  });

  it("X2 without a personal example shows every common example in source order, regardless of role", () => {
    const items = [common(5, "Fünfter."), ...threeCommon, common(4, "Vierter.", null)];
    const first = showPreview({ common: items, personal: null });
    expect(sentences(first.container)).toEqual(["Fünfter.", "Ich gehe in die Schule.", "Ich bin in der Schule.",
      "Gemeinsamer Satz.", "Vierter."]);
    first.unmount();
    const second = showPreview({ common: items, personal: null });
    expect(sentences(second.container)).toEqual(items.map(item => item.text));
  });

  it("X2 renders nothing for empty common and null personal, never a heading or translation", () => {
    const { container } = showPreview({ common: [], personal: null });
    expect(sentences(container)).toEqual([]);
    expect(screen.queryByText(/Примеры|Examples|Приклади/)).toBeNull();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "Перевод" }).textContent).toBe("ведь");
  });

  it("X3 removing the personal example restores all common examples on the next preview", () => {
    // Non-pair commons since К05-127: with both wechsel roles the personal example would not be shown at all.
    const items = [common(1, "Ich gehe in die Schule.", "general", [{ start: 9, end: 11 }]), common(3, "Gemeinsamer Satz.")];
    const view = showPreview({ common: items, personal: personal("Mein Satz.") });
    expect(sentences(view.container)).toEqual(["Mein Satz."]);
    view.rerender(<LearningPreviewCard content={preview({ common: items, personal: null })} language="ru"
      renderExamples={renderLearningPreviewExamples} />);
    expect(sentences(view.container)).toEqual(items.map(item => item.text));
    expect(view.container.textContent).not.toContain("Mein Satz.");
    expect(strongTexts(view.container)).toEqual(["in"]);
  });

  it("X4 keeps personal markup as literal text without highlights", () => {
    const text = '<script>alert(1)</script> <img src=x onerror="alert(1)"> **geht**';
    const { container } = showPreview({ common: [common(1, "Gemeinsam.", "general", [{ start: 0, end: 4 }])],
      personal: personal(text) });
    expect(sentences(container)).toEqual([text]);
    expect(container.querySelector("script, img, b, [onerror]")).toBeNull();
    expect(strongTexts(container)).toEqual([]);
  });

  it("X4 highlights only explicit code-point ranges of common examples, as in the conjunction preview", () => {
    const { container } = showPreview({ common: [
      common(1, "Ich bleibe zu Hause, weil es regnet.", "general",
        [{ start: 21, end: 25 }, { start: 29, end: 35 }, { start: "21", end: 25 }, { html: "<b>weil</b>" }]),
      common(2, "😀 <b>weil</b> du da bist.", "general", [{ start: 2, end: 13 }]),
    ], personal: null }, "conjunction", "weil");
    expect(sentences(container)).toEqual(["Ich bleibe zu Hause, weil es regnet.", "😀 <b>weil</b> du da bist."]);
    expect(strongTexts(container)).toEqual(["weil", "regnet", "<b>weil</b>"]);
    expect(container.querySelector("p.german-example b")).toBeNull();
  });

  it("X4 the same callback stays type-agnostic in a dictionary phrase context", () => {
    const value: DictionaryCardContent = preview({ common: [common(1, "Auf Wiedersehen, bis morgen!")],
      personal: personal("Tschüss, bis bald!") }, "particle", "x");
    value.card = { ...value.card, type: "phrase", lemma: "Auf Wiedersehen!" };
    const { container } = render(<ReferenceCardBody content={value} language="ru" renderExamples={renderLearningPreviewExamples} />);
    expect(sentences(container)).toEqual(["Tschüss, bis bald!"]);
    expect(container.textContent).not.toContain("bis morgen");
  });

  it("does not mutate frozen examples and keeps the strict decoder as the only gate for unknown data", () => {
    const examples: CardExamples = { common: threeCommon.map(item => Object.freeze({ ...item })), personal: null };
    const before = structuredClone(examples);
    Object.freeze(examples.common); Object.freeze(examples);
    const { container } = render(<LearningPreviewExamples examples={examples} />);
    expect(sentences(container)).toHaveLength(3);
    expect(examples).toEqual(before);
    expect(validCardExamples({ common: threeCommon })).toBe(false);
    expect(validCardExamples({ common: threeCommon, personal: undefined })).toBe(false);
    expect(validCardExamples({ common: threeCommon, personal: { value: "Satz." } })).toBe(false);
  });

  it("rejects a duplicate wechsel role as a corrupted snapshot (examples_one_wechsel_role_idx)", () => {
    const [direction, location] = threeCommon;
    const again = common(4, "Ich bin im Garten.", "wechsel_location");
    expect(validCardExamples({ common: [direction, location], personal: null })).toBe(true);
    expect(validCardExamples({ common: [direction, location, again], personal: null })).toBe(false);
    expect(validCardExamples({ common: [direction, common(5, "Noch einmal.", "wechsel_direction"), location], personal: null })).toBe(false);
  });
});
