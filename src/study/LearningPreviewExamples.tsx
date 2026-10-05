import type { ReactNode } from "react";
import type { CardExample, CardExamples, PersonalCardText } from "../api/generated";
import { hasWechselRoles } from "./answerExample";
import { GermanExample } from "./GermanExample";

/** What M07 shows from the current CardExamples shape. Common examples stay in the underlying data. */
export type PreviewExamples =
  | { kind: "personal"; personal: PersonalCardText }
  | { kind: "common"; common: readonly CardExample[] };

/** К07-104: an existing personal example replaces every common one.
 * К05-127: not for a card whose common examples carry both wechsel roles; a single personal example
 * stays stored but all common examples are shown, as without it. A full personal pair is not
 * representable in the current shape. Without a personal example all common examples are shown in
 * source order: no random choice, no limit (К05-115).
 * Input is already accepted by validCardExamples; this does not decode or repair data. */
export function selectPreviewExamples(examples: CardExamples): PreviewExamples {
  return examples.personal === null || hasWechselRoles(examples.common)
    ? { kind: "common", common: examples.common }
    : { kind: "personal", personal: examples.personal };
}

/** German sentences only: no "Examples" heading and no sentence translations. */
export function LearningPreviewExamples({ examples }: { examples: CardExamples }) {
  const visible = selectPreviewExamples(examples);
  if (visible.kind === "personal") return <GermanExample text={visible.personal.value} highlightedParts={[]} />;
  return <>{visible.common.map(example =>
    <GermanExample key={example.id} text={example.text} highlightedParts={example.highlighted_parts} />)}</>;
}

/** renderExamples callback for LearningPreviewCard. */
export function renderLearningPreviewExamples(examples: CardExamples): ReactNode {
  return <LearningPreviewExamples examples={examples} />;
}
