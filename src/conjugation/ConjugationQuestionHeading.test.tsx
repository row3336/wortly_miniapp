import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConjugationAssignment } from "../api/generated";
import { WrittenAnswerInput } from "../study/WrittenAnswerInput";
import { conjugationQuestion, conjugationWrittenQuestion } from "./conjugationQuestion";
import { ConjugationQuestionHeading } from "./ConjugationQuestionHeading";

afterEach(cleanup);
const ids = { assignment: "5b7d9f1a-3c5e-4a7b-9d1f-3a5c7e9b1d27", card: "7f9b1d3e-5a7c-4e9f-8b1d-3e5a7c9f1b33",
  cycle: "1a3c5e7f-9b1d-4f3a-a5c7-e9f1b3d5a742", display: "2b4d6f8a-0c2e-4a4b-8c6d-8e0a2c4e6b51" };
const translations = { ru: "уходить", uk: "виходити", en: "to go out" } as const;
function assignment(language: "ru" | "uk" | "en", tense: "present" | "preterite"): ConjugationAssignment {
  return { id: ids.assignment, card_id: ids.card, status: "presented", kind: "conjugation", cycle_id: ids.cycle,
    slot_id: { cycle_id: ids.cycle, pronoun_group: "wir" }, base_verb_id: ids.card, display_verb_id: ids.display, tense,
    pronoun_group: "wir", prompt: { verb: "ausgehen", translation: translations[language], language, pronoun: "wir", tense },
    answer_spec: { kind: "forms", labels: ["wir"], part_count: 1, case_sensitive: false } };
}
function show(source: ConjugationAssignment, language: "ru" | "uk" | "en" = source.prompt.language) {
  const question = conjugationQuestion(source);
  return render(<WrittenAnswerInput assignment={conjugationWrittenQuestion(question)}
    heading={<ConjugationQuestionHeading question={question} />} language={language} value=""
    readOnly={false} canSubmit canForget submitOnEnter onChange={vi.fn()} onSubmit={vi.fn()} onForget={vi.fn()} />);
}

describe("conjugation question heading", () => {
  it.each([
    ["ru", "present", "Präsens"], ["uk", "preterite", "Präteritum"], ["en", "present", "Präsens"],
  ] as const)("%s shows the German tense and shown verb with the %s translation in its own language", (language, tense, label) => {
    show(assignment(language, tense));
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe(`${label}: ausgehen — ${translations[language]}`);
    expect(screen.getByText(label).lang).toBe("de"); expect(screen.getByText("ausgehen").lang).toBe("de");
    expect(screen.getByText(translations[language]).lang).toBe(language);
    expect(heading.contains(screen.getByText(translations[language]))).toBe(true);
  });
  it("keeps the translation language of the question when the interface language differs", () => {
    show(assignment("uk", "preterite"), "en");
    expect(screen.getByText("виходити").lang).toBe("uk"); expect(screen.getByText("Präteritum").lang).toBe("de");
    expect(screen.getByRole("textbox", { name: "Your answer" })).toBeTruthy();
  });
  it("names the requested pronoun once, as the German answer part, not in the heading", () => {
    show(assignment("ru", "present"));
    const part = screen.getByText("wir");
    expect(part.lang).toBe("de"); expect(screen.getByRole("heading").textContent).not.toContain("wir");
    expect(screen.getByRole("textbox").getAttribute("aria-describedby")?.split(" ")).toContain(part.id);
  });
  it("puts no card, cycle, verb or assignment identity into the page", () => {
    const { container } = show(assignment("en", "preterite"));
    const html = document.body.innerHTML;
    for (const id of Object.values(ids)) expect(html.toLowerCase()).not.toContain(id.toLowerCase());
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(container.textContent).toContain("ausgehen");
  });
});
