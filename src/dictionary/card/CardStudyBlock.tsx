import type { ReactNode } from "react";
import type { DictionaryCardStudy } from "../../api/generated";
import type { Language } from "../../i18n/language";
import { directionLabel } from "../../i18n/messages";
import { cardText, directionFallback } from "./cardCopy";
import type { CardOrigin } from "./cardOrigin";
import { cardStudyState, formatStudyDate, type CardStudyRow } from "./cardStudy";

/** The manual Learning choice of this card as the host's manual-selection document reports it. */
export type ManualControl = {
  /** sending: this card's command is on the way; unknown: its outcome is not confirmed (retry is the same command);
   * failed: refused or unresolvable. */
  status: "idle" | "sending" | "unknown" | "failed";
  /** The document may change now and the card's facts are current. */
  enabled: boolean;
  onChange(selected: boolean): void;
  onRetry(): void;
};

type Props = {
  study: DictionaryCardStudy;
  origin: CardOrigin;
  language: Language;
  manual: ManualControl;
  /** M-INTV connection point, shown under the review directions. */
  interval?: ReactNode;
};

function Row({ row, study, language }: { row: CardStudyRow; study: DictionaryCardStudy; language: Language }) {
  const t = cardText(language);
  const label = directionLabel(language, study.pair, row.direction) ?? directionFallback(t, row.direction);
  return <div className="card-study-row">
    <dt>{label}</dt>
    {row.writtenOff ? <dd>{t.writtenOff}</dd> : row.schedule && <>
      <dd className="card-study-term">{t.interval}: {t.days(row.schedule.interval_days)}</dd>
      <dd className="card-study-term">{t.next}: {formatStudyDate(row.schedule.next_due_date, language)}</dd>
      {row.limitReached && <dd className="card-study-term">{t.limit}</dd>}
    </>}
  </div>;
}

/** Server facts only: no interval, date or right is derived on the client (TA §7, RA 6.1.10). */
export function CardStudyBlock({ study, origin, language, manual, interval }: Props) {
  const t = cardText(language), state = cardStudyState(study, origin);
  const manualAction = (label: string, selected: boolean) => <div className="card-study-manual">
    {manual.status === "unknown"
      ? <button type="button" className="card-action" onClick={manual.onRetry}>{t.retry}</button>
      : <button type="button" className="card-action" disabled={!manual.enabled || manual.status === "sending"}
        onClick={() => manual.onChange(selected)}>{manual.status === "sending" ? t.saving : label}</button>}
    {manual.status === "unknown" && <p role="alert">{t.manualUnknown}</p>}
    {manual.status === "failed" && <p role="alert">{t.manualFailed}</p>}
  </div>;
  let body: ReactNode;
  if (state.kind === "learning") body = <p className="card-study-status">{t.learning}</p>;
  else if (state.kind === "manual") body = <><p className="card-study-status">{t.manual}</p>{manualAction(t.remove, false)}</>;
  else if (state.kind === "not_selected") body = <><p className="card-study-status">{t.queued}</p>{manualAction(t.add, true)}</>;
  else body = <>
    {state.rows.length > 0 && <dl className="card-study-rows">
      {state.rows.map(row => <Row key={row.direction} row={row} study={study} language={language} />)}
    </dl>}
    {interval}
  </>;
  return <section className="card-study" aria-label={t.study}>{body}</section>;
}
