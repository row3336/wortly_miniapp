import type { ConjugationAssignment } from "../api/generated";
import type { WrittenAnswerQuestion } from "../study/WrittenAnswerInput";

export type ConjugationQuestion = Readonly<{ assignmentId: string; verb: string; translation: string;
  translationLanguage: "ru" | "uk" | "en"; tense: "present" | "preterite"; pronoun: string;
  answerSpec: Readonly<{ kind: "forms"; labels: readonly string[]; part_count: number }> }>;

/** Copies the shown prompt and answer shape of one decoded assignment. Card, cycle and verb ids stay behind;
 * the id only addresses the draft. Case sensitivity stays with the server check. */
export function conjugationQuestion(assignment: ConjugationAssignment): ConjugationQuestion {
  const prompt = assignment.prompt, spec = assignment.answer_spec;
  return { assignmentId: assignment.id, verb: prompt.verb, translation: prompt.translation,
    translationLanguage: prompt.language, tense: prompt.tense, pronoun: prompt.pronoun,
    answerSpec: { kind: spec.kind, labels: [...spec.labels], part_count: spec.part_count } };
}

/** The only input of the shared written answer field for a conjugation question. */
export function conjugationWrittenQuestion(question: ConjugationQuestion): WrittenAnswerQuestion["assignment"] {
  const spec = question.answerSpec;
  return { id: question.assignmentId, answer_spec: { kind: spec.kind, labels: [...spec.labels], part_count: spec.part_count }, prompt: null };
}
