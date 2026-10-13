import { useId, type ReactNode } from "react";
import type { CardExamples, DictionaryCardContent, LearningPreviewContent } from "../api/generated";
import type { Language } from "../i18n/language";
import { AssociationBlock } from "./AssociationBlock";
import { CardDescription } from "./CardDescription";
import { ReferenceConjugations } from "./ReferenceConjugations";
import "./referenceCard.css";

type Props = {
  content: LearningPreviewContent | DictionaryCardContent;
  language: Language;
  /** Required until the caller has selected the approved example policy for its context. */
  renderExamples(examples: CardExamples): ReactNode;
  /** М12 only: own-field controls placed at the translation and the association (M-EDIT). */
  fieldSlots?: { translation?: ReactNode; association?: ReactNode };
};
/** Read-only reference body. Rights, study state and example selection belong to their owners. */
export function ReferenceCardBody({ content, language, renderExamples, fieldSlots }: Props) {
  const name = useId();
  return <section className="reference-card" aria-labelledby={`${name}-word`}>
    <CardDescription content={content} language={language} headingId={`${name}-word`} translationSlot={fieldSlots?.translation} />
    {content.card.type === "verb" && <ReferenceConjugations tables={content.reference_conjugations} language={language} />}
    {renderExamples(content.examples)}
    {/* R12-07: an empty association invites the learner to add one; the editor's own button stays the slot below it. */}
    <AssociationBlock association={content.association} language={language} textLanguage={content.pair.split("-")[0]} invite="text">
      {fieldSlots?.association}
    </AssociationBlock>
  </section>;
}
