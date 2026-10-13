import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CardExamples, LearningPreviewContent } from "../api/generated";
import { previewContent } from "./learningPreview.test-support";
import { LearningPreviewCard } from "./LearningPreviewCard";

afterEach(cleanup);
const id = "00000000-0000-4000-8000-000000000007";
function content(): LearningPreviewContent {
  return { ...previewContent(id), card: { id, revision: "9", lemma: "gehen", type: "verb", cefr: "A2" },
    grammar: { infinitive: "gehen", infinitive_status: "applicable", preterite: "ging", preterite_status: "applicable",
      participle_ii: "gegangen", participle_ii_status: "applicable", auxiliary: "sein", auxiliary_status: "applicable", separability: "inseparable" },
    translations: { common: ["идти", "ходить"], personal: null },
    association: { value: "reference-only association", version: "3" },
    reference_conjugations: [{ tense: "present", forms: (["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"] as const).map(pronoun_group =>
      ({ pronoun_group, value: "reference-only conjugation", status: "applicable" })) }],
    examples: { common: [1, 2, 3, 4].map(index => ({ id: id.replace(/7$/, String(index)), text: `Satz ${index}.`,
      role: "general", highlighted_parts: [] })), personal: { value: "Mein Satz.", version: "2" } } };
}
const examples = () => <p>Supplied example presentation.</p>;

describe("Learning preview card content", () => {
  it("keeps German forms, level and translation together without reference-only blocks or duplicate study controls", () => {
    const { container } = render(<LearningPreviewCard content={content()} language="ru" renderExamples={examples} />);
    expect(screen.getByRole("region", { name: /gehen.*ging.*ist\s+gegangen/ })).toBeTruthy();
    expect(screen.getByText("Глагол")).toBeTruthy(); expect(screen.getByTitle("Уровень").textContent).toBe("A2");
    expect(screen.getByRole("region", { name: "Перевод" }).textContent).toBe("идтиходить");
    expect(container.textContent).not.toContain("reference-only conjugation"); expect(container.textContent).not.toContain("private hint");
    expect(screen.queryByRole("table")).toBeNull(); expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText("Примеры")).toBeNull();
    // R12-08: the introduction shows the learner's own association (the card of the pair carries it as before).
    expect(within(screen.getByRole("region", { name: "Ассоциация" })).getByText("reference-only association")).toBeTruthy();
  });
  it("passes every frozen example source intact to the required renderer after translation", () => {
    const value = content(), before = structuredClone(value);
    const renderExamples = vi.fn((_: CardExamples) => <p data-testid="examples">Provided.</p>);
    render(<LearningPreviewCard content={value} language="ru" renderExamples={renderExamples} />);
    expect(renderExamples).toHaveBeenCalledExactlyOnceWith(value.examples); expect(value).toEqual(before);
    expect(screen.getByRole("region", { name: "Перевод" }).compareDocumentPosition(screen.getByTestId("examples"))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("shows a personal translation instead of common alternatives without changing example policy", () => {
    const value = content(); value.translations.personal = { value: "двигаться пешком", version: "4" };
    const renderer = vi.fn(examples);
    render(<LearningPreviewCard content={value} language="ru" renderExamples={renderer} />);
    expect(screen.getByRole("region", { name: "Перевод" }).textContent).toBe("Личный переводдвигаться пешком");
    expect(screen.queryByText("идти")).toBeNull(); expect(renderer).toHaveBeenCalledWith(value.examples);
  });
  it("preserves the conjunction category and verb position before its translation", () => {
    const value = content(); value.card = { ...value.card, lemma: "weil", type: "conjunction" };
    value.reference_conjugations = [];
    value.grammar = { meaning_category: { id, name: "kausal" }, verb_position: { id, name: "Verb am Ende" } };
    render(<LearningPreviewCard content={value} language="ru" renderExamples={examples} />);
    expect(screen.getByRole("heading", { name: "weil" })).toBeTruthy();
    expect(screen.getByText("kausal")).toBeTruthy();
    expect(screen.getByText("Verb am Ende").compareDocumentPosition(screen.getByRole("region", { name: "Перевод" }))
      & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it.each(["ru", "uk", "en"] as const)("%s keeps interface labels and dictionary text languages separate", language => {
    const value = previewContent(id, "uk-de"); value.card.cefr = null; value.translations.common = [];
    const { container } = render(<LearningPreviewCard content={value} language={language} renderExamples={() => null} />);
    const missing = { ru: "Не заполнено", uk: "Не заповнено", en: "Not filled in" }[language];
    expect(screen.getAllByText(missing)).toHaveLength(2);
    expect(container.querySelector(".reference-translation")?.getAttribute("lang")).toBe("uk");
    expect(screen.getByRole("heading", { level: 2 }).getAttribute("lang")).toBe("de");
    for (const node of screen.getAllByText(missing)) expect(node.getAttribute("lang")).toBe(language);
  });
  it("replaces all visible card data from the next addressed preview without retaining the previous content", () => {
    const first = content(), next = previewContent(id.replace(/7$/, "8")); next.card.lemma = "morgen";
    const renderer = vi.fn(examples);
    const view = render(<LearningPreviewCard content={first} language="ru" renderExamples={renderer} />);
    view.rerender(<LearningPreviewCard content={next} language="en" renderExamples={renderer} />);
    expect(screen.getByRole("heading", { name: "morgen" })).toBeTruthy(); expect(screen.queryByText("ging")).toBeNull();
    expect(screen.queryByText("ходить")).toBeNull(); expect(renderer).toHaveBeenLastCalledWith(next.examples);
  });
  it("treats stored markup as text and gives separate cards unique accessible names", () => {
    const value = previewContent(id); value.card.lemma = "<script>lemma</script>";
    value.translations.common = ["<img src=x onerror=bad()>"];
    const { container } = render(<><LearningPreviewCard content={value} language="ru" renderExamples={() => null} />
      <LearningPreviewCard content={previewContent(id)} language="ru" renderExamples={() => null} /></>);
    expect(container.querySelectorAll("script,img")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "<script>lemma</script>" })).toBeTruthy();
    expect(screen.getByText("<img src=x onerror=bad()>")).toBeTruthy();
    expect(new Set(screen.getAllByRole("heading", { level: 2 }).map(node => node.id)).size).toBe(2);
  });
});

// R12-08: the introduction (М07) shows the learner's own association; R12-07: an empty one is an invitation line (no button: R13-07).
describe("Learning introduction: the learner's association", () => {
  const invite = { ru: "Своей ассоциации пока нет. Добавь её — так слово легче вспомнить.",
    uk: "Своєї асоціації поки немає. Додай її — так слово легше згадати.",
    en: "You have no association of your own yet. Add one to make the word easier to recall." };
  const title = { ru: "Ассоциация", uk: "Асоціація", en: "Association" };
  it("shows the own text after the examples, in the language of the pair", () => {
    const value = previewContent(id, "uk-de"); value.association = { value: "Hallo — як «халоу»", version: "2" };
    const { container } = render(<LearningPreviewCard content={value} language="ru" renderExamples={() => <p data-testid="examples">Beispiele.</p>} />);
    const block = screen.getByRole("region", { name: "Ассоциация" });
    expect(within(block).getByText("Hallo — як «халоу»").getAttribute("lang")).toBe("uk");
    expect(screen.getByTestId("examples").compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("button")).toBeNull();
  });
  it.each(["ru", "uk", "en"] as const)("%s: none of their own is an invitation line without a button", language => {
    const value = previewContent(id); value.association = null;
    render(<LearningPreviewCard content={value} language={language} renderExamples={() => null} />);
    expect(within(screen.getByRole("region", { name: title[language] })).getByText(invite[language])).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("a blank text counts as none", () => {
    const value = previewContent(id); value.association = { value: "  \n ", version: "2" };
    render(<LearningPreviewCard content={value} language="ru" renderExamples={() => null} />);
    expect(screen.getByText(invite.ru)).toBeTruthy();
  });
});
