import { useId, type ReactNode } from "react";
import type { CardExamples, LearningPreviewContent } from "../api/generated";
import type { Language } from "../i18n/language";
import { CardDescription } from "../study/CardDescription";
import "../study/referenceCard.css";

type Props = {
  content: LearningPreviewContent;
  language: Language;
  /** The caller supplies the approved example policy; this card never selects or truncates candidates. */
  renderExamples(examples: CardExamples): ReactNode;
};

/** M07 content only. Position and study actions remain in LearningScreen. */
export function LearningPreviewCard({ content, language, renderExamples }: Props) {
  const name = useId();
  return <section className="reference-card learning-preview-card" aria-labelledby={`${name}-word`}>
    <CardDescription content={content} language={language} headingId={`${name}-word`} />
    {renderExamples(content.examples)}
  </section>;
}
