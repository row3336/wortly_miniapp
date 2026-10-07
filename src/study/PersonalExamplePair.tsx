import type { PersonalExamplePair as Pair } from "./answerExample";
import { GermanExample } from "./GermanExample";
import "./personalExamplePair.css";

/** The full own pair of a two-case preposition with its case labels (TA:122, К07-121), Akkusativ first.
 * Shared by М07, the written result and М12. */
export function PersonalExamplePair({ pair }: { pair: Pair }) {
  return <dl className="personal-example-pair">
    <div><dt lang="de">Akkusativ</dt><dd><GermanExample text={pair.akkusativ.value} highlightedParts={[]} /></dd></div>
    <div><dt lang="de">Dativ</dt><dd><GermanExample text={pair.dativ.value} highlightedParts={[]} /></dd></div>
  </dl>;
}
