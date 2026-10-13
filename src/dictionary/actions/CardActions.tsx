import { useId, useRef } from "react";
import type { Language } from "../../i18n/language";
import { FEEDBACK_TEXT_MAX_UTF16, feedbackTextLength } from "../../feedback/feedbackApi";
import { ActionDialog } from "./ActionDialog";
import { actionsCopy } from "./actionsCopy";
import type { CardActionsSnapshot } from "./cardActionsController";
import type { CardActionsDocument } from "./useCardActions";
import "./cardActions.css";

type Props = { language: Language; lemma: string; document: CardActionsDocument };
type Text = (typeof actionsCopy)[Language];

function problemText(t: Text, state: CardActionsSnapshot): string | null {
  const problem = state.problem;
  if (state.status === "unknown") return state.checking ? t.checking : t.unknown;
  if (state.status !== "refused" || !problem) return null;
  if (problem.reason === "mismatch") return t.mismatch;
  // root decision, pending owner (M-ACTIONS Р5): a refusal is a message and a new card read, never «Повторить»; SETUP_REQUIRED
  // (return/relearn need the profile's time zone, C-EXCL §9) has its own text.
  return problem.code === "VERSION_CONFLICT" ? t.conflict : problem.code === "SETUP_REQUIRED" ? t.setup : t.refused;
}

/**
 * Card study actions and the complaint under the study block of М12 (RA tables 6.1.10–6.1.12, TA:153).
 * root decision, pending owner (M-ACTIONS Р1): only the actions the card read allows are drawn; «Не повторять» and
 * «Вернуть в повторы» have no confirmation (RA:259), «Изучить заново» has its own window (К07-077).
 */
export function CardActions({ language, lemma, document }: Props) {
  const t = actionsCopy[language], id = useId();
  const { state, complaint, actions } = document;
  const offered = state.offered, busy = state.status === "sending" || state.status === "unknown";
  const problem = problemText(t, state);
  const relearnCancel = useRef<HTMLButtonElement>(null), field = useRef<HTMLTextAreaElement>(null);
  const form = complaint.form;
  const length = feedbackTextLength(form.text), over = length - FEEDBACK_TEXT_MAX_UTF16;
  const formBusy = ["loading", "checking", "sending"].includes(form.phase);
  return <section className="card-actions" aria-label={t.group}>
    <div className="card-actions-buttons">
      {offered.exclude && <button type="button" className="card-action" onClick={actions.exclude}>{t.exclude}</button>}
      {offered.return && <button type="button" className="card-action" onClick={actions.restore}>{t.restore}</button>}
      {offered.relearn && <button type="button" className="card-action" onClick={actions.askRelearn}>{t.relearn}</button>}
      <button type="button" className="card-action" onClick={actions.openComplaint}>{t.report}</button>
    </div>
    <div aria-live="polite">
      {state.status === "sending" && <p role="status">{t.saving}</p>}
      {problem && <p className={busy ? "card-actions-note" : "card-actions-problem"} role={busy ? "status" : "alert"}>{problem}</p>}
      {state.canRetry && <button type="button" className="card-action" onClick={actions.retry}>{t.retry}</button>}
      {complaint.sent && !complaint.open && <p className="card-actions-note" role="status">{t.reportSent}</p>}
    </div>
    {state.confirming && <ActionDialog title={t.relearnTitle(lemma)} initialFocus={relearnCancel} onClose={actions.cancelRelearn}>
      <p>{t.relearnText}</p>
      <div className="card-dialog-actions">
        <button ref={relearnCancel} type="button" onClick={actions.cancelRelearn}>{t.cancel}</button>
        <button type="button" onClick={actions.confirmRelearn}>{t.relearnConfirm}</button>
      </div>
    </ActionDialog>}
    {complaint.open && <ActionDialog title={t.reportTitle} initialFocus={field} onClose={actions.closeComplaint}>
      <label className="card-dialog-label" htmlFor={`${id}-text`}>{t.reportLabel}</label>
      <textarea ref={field} id={`${id}-text`} className="card-dialog-text" rows={4} value={form.text} readOnly={!form.canEdit}
        aria-describedby={`${id}-attached ${id}-count ${id}-status`} aria-invalid={over > 0} onChange={event => actions.editComplaint(event.target.value)} />
      <p id={`${id}-attached`} className="card-actions-note">{t.reportAttached(lemma)}</p>
      <p id={`${id}-count`} className={over > 0 ? "card-actions-problem" : "card-actions-note"}>{t.reportCounter(length, FEEDBACK_TEXT_MAX_UTF16)}</p>
      <div id={`${id}-status`} aria-live="polite">
        {formBusy && <p role="status">{form.phase === "checking" ? t.reportChecking : t.sending}</p>}
        {over > 0 && <p className="card-actions-problem" role="alert">{t.reportTooLong(over)}</p>}
        {form.refusal && over <= 0 && <p className="card-actions-problem" role="alert">{form.refusal.code === "VALIDATION_FAILED" ? t.reportRefusedInvalid : t.reportRefused}</p>}
        {form.problem && <p className="card-actions-problem" role="alert">{t.reportProblems[form.problem]}</p>}
      </div>
      <div className="card-dialog-actions">
        <button type="button" disabled={!form.canSend} onClick={actions.sendComplaint}>{t.send}</button>
        {form.canRetry && <button type="button" onClick={actions.retryComplaint}>{t.reportRetry}</button>}
        <button type="button" onClick={actions.closeComplaint}>{t.close}</button>
      </div>
    </ActionDialog>}
  </section>;
}
