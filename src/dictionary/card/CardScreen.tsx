import { type ReactNode } from "react";
import type { DictionaryCardView } from "../../api/generated";
import type { Language } from "../../i18n/language";
import { navigationText } from "../../i18n/messages";
import { ReferenceCardBody } from "../../study/ReferenceCardBody";
import type { DictionaryCardSnapshot } from "../dictionaryCardController";
import { CardExamplesBlock } from "./CardExamplesBlock";
import { cardText } from "./cardCopy";
import type { CardOrigin } from "./cardOrigin";
import { CardStudyBlock, type ManualControl } from "./CardStudyBlock";
import "./card.css";

export type CardScreenProps = {
  language: Language;
  phase: DictionaryCardSnapshot["phase"];
  problem: DictionaryCardSnapshot["problem"];
  /** The card shown: the current read, or the previous one of the same card and pair while it is read again. */
  view: DictionaryCardView | null;
  origin: CardOrigin;
  manual: ManualControl;
  /** M-ACTIONS connection point (exclude/return/relearn, «Что не так?»), under the study block. */
  actions?: ReactNode;
  /** M-INTV connection point, under the review directions. */
  interval?: ReactNode;
  onBack(): void;
  onRetry(): void;
};

const retryable = new Set<DictionaryCardSnapshot["problem"]>(["load", "stale_response", "pair_changed"]);

/**
 * The full card М12 (TA §4, §7; RA 6.1.9–6.1.11, 6.1.14). Content, study facts and rights are the server's.
 * root decision, pending owner (M-CARD Р6): no bottom navigation, the only exit is Back to the source.
 * root decision, pending owner (M-CARD Р1): no exclude/return/relearn or report buttons until M-ACTIONS.
 * root decision, pending owner (M-CARD Р2, Q24): the two tense tables stay side by side in two columns at every width
 * (ReferenceConjugations; only font and gap shrink below 360px), no tense is hidden (RA:241).
 */
export function CardScreen(props: CardScreenProps) {
  const t = cardText(props.language), view = props.view;
  const busy = props.phase === "loading" && view !== null;
  let body: ReactNode = null;
  if (props.phase === "failed") {
    body = <div className="card-problem">
      <p role="alert">{t.failed}</p>
      {retryable.has(props.problem) && <button type="button" className="card-action" onClick={props.onRetry}>{t.retry}</button>}
    </div>;
  } else if (props.phase === "unavailable") body = <p className="card-status">{t.unavailable}</p>;
  else if (view !== null && (props.phase === "ready" || busy)) {
    body = <>
      <ReferenceCardBody content={view.content} language={props.language}
        renderExamples={examples => <CardExamplesBlock examples={examples} language={props.language} />} />
      <CardStudyBlock study={view.study} origin={props.origin} language={props.language}
        manual={busy ? { ...props.manual, enabled: false } : props.manual} interval={props.interval} />
      {props.actions}
    </>;
  } else if (props.phase === "loading") body = <p className="card-status" role="status">{t.loading}</p>;
  return <main className="card-screen" aria-label={t.screen} aria-busy={busy}>
    <header className="card-header">
      <button type="button" className="card-back" onClick={props.onBack}>{navigationText(props.language).back}</button>
    </header>
    {body}
  </main>;
}
