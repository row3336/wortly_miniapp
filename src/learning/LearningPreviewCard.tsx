import { useId, type ReactNode } from "react";
import type { CardExamples, LearningPreviewContent } from "../api/generated";
import type { Language } from "../i18n/language";
import { AssociationBlock } from "../study/AssociationBlock";
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
    {/* R12-08: the learner's own association is part of the introduction. The invitation is a line only: the introduction has no way into М12 (R13-07, variant 1). */}
    <AssociationBlock association={content.association} language={language} textLanguage={content.pair.split("-")[0]} invite="text" />
  </section>;
}
