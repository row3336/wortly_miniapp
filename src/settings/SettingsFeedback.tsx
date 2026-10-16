import { useId } from "react";
import { FEEDBACK_TEXT_MAX_UTF16, feedbackTextLength } from "../feedback/feedbackApi";
import type { FeedbackDocument } from "../feedback/useFeedbackDocument";
import type { Language } from "../i18n/language";
import { settingsFeedbackCopy } from "./settingsFeedbackCopy";

type Props = { feedback: FeedbackDocument; language: Language };

/** The message to the developer: one field; success only from the server's answer, the text stays on any failure. */
export function SettingsFeedback({ feedback, language }: Props) {
  const id = useId(), t = settingsFeedbackCopy[language];
  const { state, actions } = feedback;
  const length = feedbackTextLength(state.text), over = length - FEEDBACK_TEXT_MAX_UTF16;
  const busy = ["loading", "checking", "sending"].includes(state.phase);
  return <section className="settings-group settings-feedback" aria-labelledby={`${id}-title`}>
    <h2 id={`${id}-title`}>{t.title}</h2>
    <div className="settings-group-body">
      <label className="settings-label" htmlFor={`${id}-text`}>{t.label}
        <textarea id={`${id}-text`} rows={5} value={state.text} readOnly={!state.canEdit} aria-describedby={`${id}-hint ${id}-count ${id}-status`} aria-invalid={over > 0}
          onChange={event => actions.edit(event.target.value)} />
      </label>
      <p id={`${id}-hint`} className="settings-help">{t.hint}</p>
      <p id={`${id}-count`} className={over > 0 ? "settings-help settings-error" : "settings-help"}>{t.counter(length, FEEDBACK_TEXT_MAX_UTF16)}</p>
      <div id={`${id}-status`} aria-live="polite">
        {busy && <p role="status">{state.phase === "sending" ? t.sending : state.phase === "checking" ? t.checking : t.loading}</p>}
        {state.confirmed && <p className="settings-saved" role="status">{t.confirmed}</p>}
        {over > 0 && <p className="settings-error" role="alert">{t.tooLong(over)}</p>}
        {state.refusal && over <= 0 && <p className="settings-error" role="alert">{state.refusal.code === "VALIDATION_FAILED" ? t.refusedInvalid : t.refused}</p>}
        {state.problem && <p className="settings-error" role="alert">{t.problems[state.problem]}</p>}
      </div>
      <div className="settings-actions">
        <button type="button" className="settings-primary" disabled={!state.canSend} onClick={() => { void actions.send(); }}>{t.send}</button>
        {state.canRetry && <button type="button" className="settings-secondary" onClick={() => { void actions.retry(); }}>{state.problem === "lost_envelope" ? t.checkAgain : t.retry}</button>}
      </div>
    </div>
  </section>;
}
