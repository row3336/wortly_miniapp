import { describe, expect, it } from "vitest";
import type { ConjugationAssignment, ConjugationSessionProjection } from "../api/generated";
import { validConjugationCurrent } from "./conjugationProjection";
import { conjugationQuestion, conjugationWrittenQuestion } from "./conjugationQuestion";

const ids = { session: "3d1c7a5e-0b2f-4c8e-9a61-2f4e8b7c1d03", assignment: "a5e10c42-7d3b-4f19-8e26-9b0c4d7f2e15",
  card: "c8a2f4d6-1e3b-4a5c-9d7e-0f2b4c6d8e09", cycle: "e9f1a3b5-c7d9-4e1f-a3b5-c7d9e1f3a519",
  display: "d4b6c8e0-f2a4-4b6c-8d0e-f2a4b6c8d018" };
const translations = { ru: "приходить", uk: "приходити", en: "to arrive" } as const;

function current(language: "ru" | "uk" | "en", tense: "present" | "preterite"): ConjugationSessionProjection {
  return { session_id: ids.session, status: "active", mode: "conjugation", pair: `${language}-de`, direction: "conjugation",
    local_date: "2026-10-01", close_reason: null, progress: { total: 6, completed: 2, correct: 2, wrong: 0 },
    assignment: { id: ids.assignment, card_id: ids.card, status: "presented", kind: "conjugation", cycle_id: ids.cycle,
      slot_id: { cycle_id: ids.cycle, pronoun_group: "er_sie_es" }, base_verb_id: ids.card, display_verb_id: ids.display,
      tense, pronoun_group: "er_sie_es",
      prompt: { verb: "ankommen", translation: translations[language], language, pronoun: "er/sie/es", tense },
      answer_spec: { kind: "forms", labels: ["er/sie/es"], part_count: 1, case_sensitive: false } }, summary: null,
    capabilities: { answer_target: ids.assignment, correct_target: null, grades: null, undo_target: null, stop: true, summary_home: false } };
}
function decoded(language: "ru" | "uk" | "en", tense: "present" | "preterite"): ConjugationAssignment {
  const value = current(language, tense);
  expect(validConjugationCurrent(value, ids.session)).toBe(true);
  return value.assignment!;
}

describe("conjugation question from a decoded assignment", () => {
  it.each([
    ["ru", "present"], ["uk", "preterite"], ["en", "present"],
  ] as const)("%s %s keeps what the learner is asked: shown verb, its translation, tense and one pronoun", (language, tense) => {
    expect(conjugationQuestion(decoded(language, tense))).toEqual({ assignmentId: ids.assignment, verb: "ankommen",
      translation: translations[language], translationLanguage: language, tense, pronoun: "er/sie/es",
      answerSpec: { kind: "forms", labels: ["er/sie/es"], part_count: 1 } });
  });
  it("keeps the server answer shape without its case rule, which stays with the server check", () => {
    const assignment = decoded("ru", "preterite"), question = conjugationQuestion(assignment);
    const spec = assignment.answer_spec;
    expect(question.answerSpec).toStrictEqual({ kind: spec.kind, labels: spec.labels, part_count: spec.part_count }); expect(Object.keys(question.answerSpec)).not.toContain("case_sensitive");
  });
  it("feeds the shared answer field exactly the question id and server shape, with no text prompt", () => {
    const question = conjugationQuestion(decoded("uk", "present")), input = conjugationWrittenQuestion(question);
    expect(input).toStrictEqual({ id: ids.assignment, answer_spec: question.answerSpec, prompt: null });
    expect(input.answer_spec.labels).not.toBe(question.answerSpec.labels);
  });
  it("leaves card, cycle and verb identities behind, so the view cannot render them", () => {
    const question = conjugationQuestion(decoded("ru", "present")), text = JSON.stringify(question);
    for (const hidden of [ids.card, ids.cycle, ids.display, ids.session]) expect(text).not.toContain(hidden);
    expect(text.match(/[0-9a-f]{8}-[0-9a-f]{4}-/gi)).toEqual([ids.assignment.slice(0, 14)]);
  });
  it("is a copy: a later change of the source assignment does not alter the question already shown", () => {
    const assignment = decoded("en", "preterite"), question = conjugationQuestion(assignment);
    assignment.prompt.verb = "kommen"; assignment.prompt.translation = "to come";
    assignment.answer_spec.labels.push("wir"); assignment.answer_spec.labels[0] = "ich";
    expect(question.verb).toBe("ankommen"); expect(question.translation).toBe("to arrive");
    expect(question.answerSpec.labels).toEqual(["er/sie/es"]);
  });
});
