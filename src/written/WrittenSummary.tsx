import type { WrittenSummary as Summary } from "../api/generated";
import { StepBackButton } from "../commands/StepBackButton";
import type { Language } from "../i18n/language";
import type { WrittenClosed } from "./writtenViewController";
import { NoticeShown } from "../notices/NoticeShown";

export type WrittenSummaryProps = {
  summary: Summary;
  /** completed: the queue ran out; interrupted: the user stopped the session or it was closed without them. */
  outcome: "completed" | "interrupted";
  language: Language;
  /**
   * The server reason of a closure not chosen in this window (Q27-А, TA:205, CT:144); null = closed for an unknown
   * reason. Omitted for a natural end and for the own Stop: they show no reason line.
   */
  closedReason?: ShownReason | null;
  canToday: boolean;
  onToday(): void;
  /** Present only while the server grants «Шаг назад» on the summary of an open session (RA Д02, К10-127). */
  onUndo?(): void;
  /**
   * answer_loss of this closed session in the open window (project notices §6): its lines (9.2.7 / R2-05) stand in place
   * of the closed status and reason lines.
   */
  noticeLines?: string[] | null;
  /** The notice whose lines these are: named in c.screen(notice_shown) once drawn. */
  noticeId?: string | null;
};
const copy = {
  ru: { title: "Итог занятия", completed: "Занятие завершено.", interrupted: "Занятие прервано.", done: "Пройдено", right: "Верно",
    errors: "Ошибки", percent: "Процент", today: "На Сегодня" },
  uk: { title: "Підсумок заняття", completed: "Заняття завершено.", interrupted: "Заняття перервано.", done: "Пройдено", right: "Правильно",
    errors: "Помилки", percent: "Відсоток", today: "На Сьогодні" },
  en: { title: "Session summary", completed: "The session is complete.", interrupted: "The session was interrupted.", done: "Completed",
    right: "Correct", errors: "Errors", percent: "Percentage", today: "Return to Today" },
} as const;
type ShownReason = Exclude<WrittenClosed["reason"], "stop" | "summary_home" | null>;
// working text, not approved (6.1.O5): the reason lines repeat the conjugation summary working copy.
// Until N4.4 / CP4b: save_failed has no own text yet; it falls back to the generic closed line.
const reasons: Record<Language, Partial<Record<ShownReason, string>> & { unknown: string }> = {
  ru: { remote_stop: "Занятие завершено на другом устройстве", midnight: "Занятие закрыто: начался новый день",
    timezone_date_changed: "Занятие закрыто: сменилась дата", pair_changed: "Занятие закрыто: изменилась языковая пара",
    unknown: "Занятие закрыто" },
  uk: { remote_stop: "Заняття завершено на іншому пристрої", midnight: "Заняття закрито: почався новий день",
    timezone_date_changed: "Заняття закрито: змінилася дата", pair_changed: "Заняття закрито: змінилася мовна пара",
    unknown: "Заняття закрито" },
  en: { remote_stop: "The session was ended on another device", midnight: "The session was closed: a new day began",
    timezone_date_changed: "The session was closed: the date changed", pair_changed: "The session was closed: the language pair changed",
    unknown: "The session was closed" },
};
const locales = { ru: "ru-RU", uk: "uk-UA", en: "en-US" } as const;

/** Д02 renders only confirmed server numbers: no answers is «—», never 0 % (В06.3); drills never add cards. */
export function WrittenSummary({ summary, outcome, language, closedReason, canToday, onToday, onUndo, noticeLines, noticeId }: WrittenSummaryProps) {
  const t = copy[language], ratio = summary.ratio;
  const percent = ratio === null || ratio.denominator === 0 ? "—"
    : new Intl.NumberFormat(locales[language], { style: "percent", maximumFractionDigits: 0 }).format(ratio.numerator / ratio.denominator);
  return <section className="written-summary" aria-label={t.title}>
    <h2>{t.title}</h2>
    {noticeId && <NoticeShown noticeId={noticeId} />}
    {noticeLines && noticeLines.length > 0
      ? noticeLines.map((line, index) => <p key={index} role={index === 0 ? "status" : undefined}>{line}</p>)
      : <>
        <p role="status">{outcome === "completed" ? t.completed : t.interrupted}</p>
        {closedReason !== undefined && <p>{(closedReason === null ? undefined : reasons[language][closedReason]) ?? reasons[language].unknown}</p>}
      </>}
    <dl>
      <div><dt>{t.done}</dt><dd>{summary.completed}</dd></div>
      <div><dt>{t.right}</dt><dd>{summary.correct}</dd></div>
      <div><dt>{t.errors}</dt><dd>{summary.wrong}</dd></div>
      <div><dt>{t.percent}</dt><dd>{percent}</dd></div>
    </dl>
    <div className="written-summary-actions">
      <button type="button" disabled={!canToday} onClick={() => { if (canToday) onToday(); }}>{t.today}</button>
      {onUndo && <StepBackButton className="written-step-back" language={language} onUndo={onUndo} />}
    </div>
  </section>;
}

/**
 * The same working copy for the other summaries of a closed session (project notices ed.2.4 §6; Q32): the notice screen
 * and the oral summary reuse these lines as they are, so no new text appears. The reason lines are working text, not
 * approved (6.1.O5, above).
 */
export { copy as summaryCopy, reasons as closedReasonLines };
export type { ShownReason };
