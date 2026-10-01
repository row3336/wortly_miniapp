import { useId, type ReactNode } from "react";
import type { CardExamples, DictionaryCardContent, LearningPreviewContent } from "../api/generated";
import type { Language } from "../i18n/language";
import { CardDescription } from "./CardDescription";
import { ReferenceConjugations } from "./ReferenceConjugations";
import "./referenceCard.css";

type Props = {
  content: LearningPreviewContent | DictionaryCardContent;
  language: Language;
  /** Required until the caller has selected the approved example policy for its context. */
  renderExamples(examples: CardExamples): ReactNode;
};
const copy = {
  ru: { association: "Ассоциация", missing: "Не заполнено" },
  uk: { association: "Асоціація", missing: "Не заповнено" },
  en: { association: "Association", missing: "Not filled in" },
} as const;

/** Read-only reference body. Rights, study state and example selection belong to their owners. */
export function ReferenceCardBody({ content, language, renderExamples }: Props) {
  const name = useId(), t = copy[language];
  return <section className="reference-card" aria-labelledby={`${name}-word`}>
    <CardDescription content={content} language={language} headingId={`${name}-word`} />
    {content.card.type === "verb" && <ReferenceConjugations tables={content.reference_conjugations} language={language} />}
    {renderExamples(content.examples)}
    <section className="reference-association" aria-label={t.association}>
      <h3>{t.association}</h3><p>{content.association?.value.trim() ? content.association.value
        : <span className="reference-missing" lang={language}>{t.missing}</span>}</p>
    </section>
  </section>;
}
