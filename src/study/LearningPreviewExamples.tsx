import type { ReactNode } from "react";
import type { CardExamples, PrepositionCardExamples } from "../api/generated";
import { selectReferenceExamples } from "./answerExample";
import { GermanExample } from "./GermanExample";
import { PersonalExamplePair } from "./PersonalExamplePair";

/** German sentences only: no "Examples" heading and no sentence translations. The rule is shared with М12
 * (selectReferenceExamples: К07-104, К05-127, К05-115); a full own pair shows both own sentences with their cases, Akkusativ first. */
export function LearningPreviewExamples({ examples }: { examples: CardExamples | PrepositionCardExamples }) {
  const visible = selectReferenceExamples(examples);
  if (visible.kind === "personal_pair") return <PersonalExamplePair pair={visible} />;
  if (visible.kind === "personal") return <GermanExample text={visible.personal.value} highlightedParts={[]} />;
  return <>{visible.common.map(example =>
    <GermanExample key={example.id} text={example.text} highlightedParts={example.highlighted_parts} />)}</>;
}

/** renderExamples callback for LearningPreviewCard. */
export function renderLearningPreviewExamples(examples: CardExamples | PrepositionCardExamples): ReactNode {
  return <LearningPreviewExamples examples={examples} />;
}
