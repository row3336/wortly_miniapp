import { useEffect } from "react";
import type { NoticeView } from "../api/generated";
import type { Language } from "../i18n/language";
import { iconLabel } from "../i18n/messages";
import { closedReasonLines, summaryCopy, type ShownReason } from "../written/WrittenSummary";
import { noticeLines } from "./noticeCopy";
import { noticeProgress } from "./noticeApi";
import { noticeShown } from "./noticeJournal";
import { OralForcedSummary, oralClosedLine } from "../oral/OralScreen";
import "../written/written.css";

export type NoticeScreenProps = {
  /** The first pending notice only: notices are shown one at a time (CON §7.2 п.4; §6). */
  notice: NoticeView;
  language: Language;
  /** The acknowledgement of this notice is under way: the press waits for its end. */
  acking: boolean;
  /** The explicit press of «Далее» / «На Сегодня» — the only acknowledgement (§5: showing is none). */
  onAcknowledge(): void;
};

type Counts = { completed: number; correct: number; wrong: number };
const whole = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** The numbers of the actual summary (T3) when it has them: written, oral and conjugation do; Learning has none. */
function counts(summary: NoticeView["summary"]): Counts | null {
  if (!summary) return null;
  const { completed, correct, wrong } = summary;
  return whole(completed) && whole(correct) && whole(wrong) ? { completed, correct, wrong } : null;
}
const forcedReasons: readonly string[] = ["midnight", "timezone_date_changed", "pair_changed", "remote_stop"];

/**
 * The summary screen of a closed session with its notice (project notices ed.2.4 §6): without a modal window, in place of
 * Today until it is acknowledged. answer_loss: the summary and its line (9.2.7 for save_failed, R2-05 for the own Stop);
 * oral_forced_close: the oral summary with its reason and «На Сегодня» (Q32, R4-03). defect_class is always null (Д1):
 * no «знаем и работаем».
 */
export function NoticeScreen({ notice, language, acking, onAcknowledge }: NoticeScreenProps) {
  const t = summaryCopy[language], lines = noticeLines[language], numbers = counts(notice.summary);
  useEffect(() => { noticeShown(notice.notice_id); }, [notice.notice_id]);
  const shown: string[] = [];
  if (notice.kind === "answer_loss") {
    if (notice.close_reason === "save_failed") shown.push(lines.saveFailed);
    else if (notice.close_reason === "stop") {
      if (lines.stopClosed !== null) shown.push(lines.stopClosed);
      if (lines.stopLost !== null) shown.push(lines.stopLost);
    }
  } else {
    const reason = forcedReasons.includes(notice.close_reason) ? notice.close_reason as ShownReason : null;
    shown.push((reason === null ? undefined : closedReasonLines[language][reason]) ?? closedReasonLines[language].unknown);
  }
  if (notice.kind === "oral_forced_close") {
    // Д4, R4-03: the same screen as the open window shows for this closure (OralScreen → OralForcedSummary).
    // «Осталось» once the core sends the progress of the closed session (M1b dependency; Codex C525); until then absent.
    const progress = noticeProgress((notice as { progress?: unknown }).progress);
    return <OralForcedSummary language={language} status={oralClosedLine(language)} reasonLine={shown[0]} counts={numbers}
      remaining={numbers && progress ? progress.total - progress.completed : null}
      leaving={acking} onToday={onAcknowledge} dataNotice={notice.notice_id} />;
  }
  const button = iconLabel(language, "next");
  return <section className="written-summary notice-summary" aria-label={t.title} data-notice={notice.notice_id}>
    <h2>{t.title}</h2>
    {shown.map((line, index) => <p key={index} role={index === 0 ? "status" : undefined}>{line}</p>)}
    {numbers && <dl>
      <div><dt>{t.done}</dt><dd>{numbers.completed}</dd></div>
      <div><dt>{t.right}</dt><dd>{numbers.correct}</dd></div>
      <div><dt>{t.errors}</dt><dd>{numbers.wrong}</dd></div>
    </dl>}
    <div className="written-summary-actions">
      <button type="button" disabled={acking} onClick={() => { if (!acking) onAcknowledge(); }}>{button}</button>
    </div>
  </section>;
}
