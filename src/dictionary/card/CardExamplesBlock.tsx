import type { CardExamples, PrepositionCardExamples } from "../../api/generated";
import type { Language } from "../../i18n/language";
import { selectReferenceExamples } from "../../study/answerExample";
import { GermanExample } from "../../study/GermanExample";
import { PersonalExamplePair } from "../../study/PersonalExamplePair";
import { cardText } from "./cardCopy";

/**
 * The examples block of М12 (TA §6, §7, К07-104, К05-127, Т16, Т85). root decision, pending owner (M-CARD Р3):
 * a visible heading; an own example carries the personal mark; the full own pair is labelled with its cases.
 * A two-case preposition otherwise shows only its two common wechsel examples (selectReferenceExamples).
 */
export function CardExamplesBlock({ examples, language }: { examples: CardExamples | PrepositionCardExamples; language: Language }) {
  const t = cardText(language), shown = selectReferenceExamples(examples);
  let body;
  if (shown.kind === "personal_pair") {
    body = <>
      <p className="card-personal-mark">{t.personalExample}</p>
      <PersonalExamplePair pair={shown} />
    </>;
  } else if (shown.kind === "personal") {
    body = <><p className="card-personal-mark">{t.personalExample}</p>
      <GermanExample text={shown.personal.value} highlightedParts={[]} /></>;
  } else if (shown.common.length > 0) {
    body = shown.common.map(example => <GermanExample key={example.id} text={example.text} highlightedParts={example.highlighted_parts} />);
  } else body = <p><span className="reference-missing" lang={language}>{t.missing}</span></p>;
  return <section className="card-examples" aria-label={t.examples}>
    <h3>{t.examples}</h3>
    {body}
  </section>;
}
