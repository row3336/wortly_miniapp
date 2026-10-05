import type { ConjugationQuestion } from "./conjugationQuestion";

// Part names stay German in every interface language (table 6.1.7).
const tenses = { present: "Präsens", preterite: "Präteritum" } as const;

/** Content of the written answer heading: tense, shown verb and its translation. The pronoun is the answer part label. */
export function ConjugationQuestionHeading({ question }: { question: ConjugationQuestion }) {
  return <>
    <span lang="de">{tenses[question.tense]}</span>{": "}
    <span lang="de">{question.verb}</span>{" — "}
    <span lang={question.translationLanguage}>{question.translation}</span>
  </>;
}
