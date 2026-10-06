import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardContent, LearningPreviewContent, ReferenceAdjective, ReferenceNoun, ReferenceVerb } from "../api/generated";
import { previewContent } from "../learning/learningPreview.test-support";
import { validLearningPreviewContent } from "../learning/learningPreviewContent";
import { ReferenceCardBody } from "./ReferenceCardBody";

afterEach(cleanup);
const id = "00000000-0000-4000-8000-000000000007";
function content(kind: LearningPreviewContent["card"]["type"] = "noun"): LearningPreviewContent {
  const value = previewContent(id); value.card.type = kind;
  value.card.lemma = { noun: "Haus", verb: "gehen", adjective: "groß", preposition: "in", conjunction: "weil",
    pronoun: "ich", adverb: "heute", particle: "doch", phrase: "Guten Tag" }[kind];
  value.translations = { common: ["общий перевод", "второй перевод"], personal: null };
  value.association = { value: "моя ассоциация", version: "1" };
  if (kind === "noun") value.grammar = { gender: "neuter", gender_status: "applicable", singular: "Haus", singular_status: "applicable",
    plural: "Häuser", plural_status: "applicable", article_status: "applicable" };
  if (kind === "verb") value.grammar = { infinitive: "gehen", infinitive_status: "applicable", preterite: "ging", preterite_status: "applicable",
    participle_ii: "gegangen", participle_ii_status: "applicable", auxiliary: "sein", auxiliary_status: "applicable", separability: "inseparable" };
  if (kind === "adjective") value.grammar = { positive: "groß", positive_status: "applicable", comparative: "größer", comparative_status: "applicable",
    superlative: "am größten", superlative_status: "applicable" };
  if (kind === "preposition") value.grammar = { category: { id, name: "Wechselpräposition" }, cases: [{ id, name: "Dativ" }, { id, name: "Akkusativ" }] };
  if (kind === "conjunction") value.grammar = { meaning_category: { id, name: "kausal" }, verb_position: { id, name: "Verb am Ende" } };
  expect(validLearningPreviewContent(value, id, "ru-de")).toBe(true);
  return value;
}
function show(value: LearningPreviewContent, language: "ru" | "uk" | "en" = "ru") {
  const examples = vi.fn(() => <p data-testid="examples">Beispiel.</p>);
  const result = render(<ReferenceCardBody content={value} language={language} renderExamples={examples} />);
  return { ...result, examples };
}
const heading = () => screen.getByRole("heading", { level: 2 }).textContent?.replaceAll("\u00a0", " ");

describe("read-only reference card body", () => {
  it.each([["ru", "Фраза"], ["uk", "Фраза"], ["en", "Phrase"]] as const)(
    "renders a dictionary phrase in %s without grammar, training actions or example selection", (language, label) => {
      const value: DictionaryCardContent = previewContent(id);
      value.card.type = "phrase"; value.card.lemma = "<b>Auf Wiedersehen!</b>";
      value.translations.common = ["до свидания", "до встречи"];
      value.examples.personal = { value: "Personal.", version: "7" };
      const examples = vi.fn(() => <p>Examples supplied by caller.</p>);
      const { container } = render(<ReferenceCardBody content={value} language={language} renderExamples={examples} />);
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.getByRole("heading", { level: 2, name: "<b>Auf Wiedersehen!</b>" })).toBeTruthy();
      expect(screen.getByText("до свидания")).toBeTruthy(); expect(screen.getByText("до встречи")).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull(); expect(screen.queryByRole("button")).toBeNull();
      expect(container.querySelector("b")).toBeNull();
      expect(examples).toHaveBeenCalledWith(value.examples);
      // K04-105: the same phrase content is also a valid Learning introduction.
      expect(validLearningPreviewContent(value, id, "ru-de")).toBe(true);
    });
  it.each([["noun", /das\s+Haus/], ["verb", /gehen.*ging.*ist\s+gegangen/], ["adjective", /groß.*größer.*am größten/]] as const)(
    "%s exposes the actual German forms as the heading's accessible name", (kind, name) => {
      show(content(kind)); expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
    });
  it.each(["noun", "verb", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"] as const)(
    "%s renders its type and level without adding study or edit rights", kind => {
      const value = content(kind); show(value);
      expect(screen.getByText({ noun: "Существительное", verb: "Глагол", adjective: "Прилагательное", pronoun: "Местоимение",
        adverb: "Наречие", preposition: "Предлог", conjunction: "Союз", particle: "Частица" }[kind])).toBeTruthy();
      expect(screen.getByTitle("Уровень").textContent).toBe("A1");
      expect(screen.queryByRole("button")).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
    });
  it.each([["masculine", "der"], ["feminine", "die"], ["neuter", "das"]] as const)("noun article follows the stored %s gender", (gender, article) => {
    const value = content(); (value.grammar as ReferenceNoun).gender = gender;
    const { container } = show(value); expect(heading()).toBe(`${article} Haus`);
    expect(screen.getByTitle("Artikel").getAttribute("data-article")).toBe(article);
    expect(screen.getByTitle("Singular").hasAttribute("data-article")).toBe(false);
    expect(screen.getByTitle("Plural").hasAttribute("data-article")).toBe(false);
    expect(screen.getByTitle("Plural").textContent).toBe("Häuser");
    expect(container.querySelector(".reference-plural")?.nextElementSibling).toBeNull();
    expect(container.querySelector(".reference-word")!.compareDocumentPosition(screen.getByRole("region", { name: "Перевод" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("a plural-only noun never invents a singular or article", () => {
    const value = content(), noun = value.grammar as ReferenceNoun;
    value.card.lemma = "Eltern"; Object.assign(noun, { gender: null, gender_status: "not_applicable", article_status: "not_applicable",
      singular: null, singular_status: "not_applicable", plural: "Eltern" });
    show(value); expect(heading()).toBe("Eltern"); expect(screen.queryByTitle("Singular")).toBeNull();
    expect(screen.queryByTitle("Artikel")).toBeNull(); expect(screen.getByTitle("Plural").textContent).toBe("Eltern");
  });
  it("a missing plural on a plural-only legacy noun preserves the lemma and reports the missing field", () => {
    const value = content(), noun = value.grammar as ReferenceNoun;
    Object.assign(noun, { singular: null, singular_status: "not_applicable", plural: null, plural_status: "unknown" });
    show(value); expect(heading()).toContain("Haus"); expect(screen.getByTitle("Plural").textContent).toBe("Не заполнено");
    expect(screen.queryByTitle("Singular")).toBeNull();
  });
  it("missing article and singular are not inferred from the noun lemma", () => {
    const value = content(), noun = value.grammar as ReferenceNoun;
    Object.assign(noun, { gender: null, gender_status: "unknown", singular: null, singular_status: "unknown" });
    show(value); expect(heading()).toContain("Haus");
    expect(screen.getByTitle("Singular").textContent).toBe("Не заполнено"); expect(screen.getByTitle("Artikel").textContent).toBe("Не заполнено");
  });
  it.each([["haben", "hat"], ["sein", "ist"]] as const)("verb keeps %s and Partizip II together after Präteritum", (auxiliary, visible) => {
    const value = content("verb"); (value.grammar as ReferenceVerb).auxiliary = auxiliary;
    const { container } = show(value); expect(heading()).toBe(`gehen / ging / ${visible} gegangen`);
    expect(container.querySelector(".reference-compound")?.textContent).toBe(`${visible}\u00a0gegangen`);
    expect(screen.getAllByRole("table")).toHaveLength(2); expect(screen.getByRole("table", { name: "Präteritum" })).toBeTruthy();
    const blocks = Array.from(container.querySelector(".reference-card")!.children);
    expect(blocks.indexOf(container.querySelector(".reference-translation")!)).toBeLessThan(blocks.indexOf(container.querySelector(".reference-conjugations")!));
    expect(blocks.indexOf(container.querySelector(".reference-conjugations")!)).toBeLessThan(blocks.indexOf(screen.getByTestId("examples")));
  });
  it("adjective shows all stored degrees in order on the same form line", () => {
    show(content("adjective")); expect(heading()).toBe("groß / größer / am größten");
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("inapplicable adjective degrees are hidden while unknown applicable degrees stay visible", () => {
    const value = content("adjective"), adjective = value.grammar as ReferenceAdjective;
    Object.assign(adjective, { comparative: null, comparative_status: "unknown", superlative: null, superlative_status: "not_applicable" });
    show(value); expect(screen.getByTitle("Komparativ").textContent).toBe("Не заполнено");
    expect(screen.queryByTitle("Superlativ")).toBeNull();
  });
  it.each(["noun", "verb", "adjective", "preposition", "conjunction"] as const)("legacy absent %s grammar stays missing, never excluded or invented", kind => {
    const value = content(kind); value.grammar = null; const { container } = show(value);
    expect(heading()).toContain(value.card.lemma); expect(container.textContent).toContain("Не заполнено");
    if (kind === "verb") { expect(screen.getByTitle("Infinitiv").textContent).toBe("Не заполнено"); expect(screen.getAllByRole("table")).toHaveLength(2); }
    if (kind === "adjective") expect(screen.getByTitle("Positiv").textContent).toBe("Не заполнено");
  });
  it("preposition retains its stored category and both cases before the translation", () => {
    const { container } = show(content("preposition")); expect(screen.getByText("Wechselpräposition")).toBeTruthy();
    expect(screen.getByText("Dativ / Akkusativ")).toBeTruthy();
    expect(container.querySelector(".reference-taxonomy")!.compareDocumentPosition(screen.getByRole("region", { name: "Перевод" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("conjunction retains category and verb position without changing their server values", () => {
    show(content("conjunction")); expect(screen.getByText("kausal")).toBeTruthy(); expect(screen.getByText("Verb am Ende")).toBeTruthy();
  });
  it("personal translation replaces every common alternative and has a personal marker", () => {
    const value = content(); value.translations.personal = { value: "моё значение", version: "3" }; show(value);
    expect(screen.getByText("Личный перевод")).toBeTruthy(); expect(screen.getByText("моё значение")).toBeTruthy();
    expect(screen.queryByText("общий перевод")).toBeNull(); expect(screen.queryByText("второй перевод")).toBeNull();
  });
  it("without a personal translation every common alternative is preserved in order", () => {
    show(content()); expect(screen.getByRole("region", { name: "Перевод" }).textContent).toBe("общий переводвторой перевод");
    expect(screen.queryByText("Личный перевод")).toBeNull();
  });
  it("an empty personal value stays explicitly missing without silently substituting common data", () => {
    const value = content(); value.translations.personal = { value: "  ", version: "2" }; show(value);
    expect(screen.getByRole("region", { name: "Перевод" }).textContent).toBe("Личный переводНе заполнено");
    expect(screen.queryByText("общий перевод")).toBeNull();
  });
  it.each(["ru", "uk", "en"] as const)("%s localizes missing fields independently of dictionary language", language => {
    const value = content("particle"); value.pair = "uk-de"; value.card.cefr = null; value.translations.common = []; value.association = null;
    const { container } = show(value, language); const labels = { ru: "Не заполнено", uk: "Не заповнено", en: "Not filled in" };
    expect(screen.getAllByText(labels[language])).toHaveLength(3);
    expect(container.querySelector(".reference-translation")?.getAttribute("lang")).toBe("uk");
    expect(container.querySelector(".reference-missing")?.getAttribute("lang")).toBe(language);
  });
  it("passes both example sources intact to the required renderer and puts association after it", () => {
    const value = content("particle"); value.examples.common = [1, 2, 3].map(index => ({ id, text: `Common ${index}.`, role: "general", highlighted_parts: [] }));
    value.examples.personal = { value: "Personal.", version: "1" }; const before = structuredClone(value);
    const { examples } = show(value); expect(examples).toHaveBeenCalledWith(value.examples); expect(value).toEqual(before);
    expect(screen.queryByText("Примеры")).toBeNull();
    expect(screen.getByTestId("examples").compareDocumentPosition(screen.getByRole("region", { name: "Ассоциация" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("renders stored markup only as text and never turns metadata into UI properties", () => {
    const value = content("conjunction"); value.card.lemma = "<script>bad()</script>";
    value.translations.personal = { value: "<img src=x onerror=bad()>", version: "1" }; value.association!.value = "<a href=x>text</a>";
    value.examples.common = [{ id, text: "plain", role: null, highlighted_parts: [{ dangerouslySetInnerHTML: { __html: "<script>bad()</script>" } }] }];
    const { container } = show(value); expect(container.querySelectorAll("script,img,a")).toHaveLength(0);
    expect(container.textContent).toContain("<script>bad()</script>"); expect(container.textContent).toContain("<img src=x onerror=bad()>");
  });
});
