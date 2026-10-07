import { useEffect, useId, useRef, useState } from "react";
import type { DictionaryContextInterval } from "../api/generated";
import type { Language } from "../i18n/language";
import { formatStudyDate } from "./card/cardStudy";
import type { DictionaryIntervalSnapshot } from "./dictionaryIntervalController";
import type { IntervalChoice } from "./intervalApi";
import { intervalText } from "./intervalCopy";

type Props = {
  language: Language;
  /** The server's preview of the written L1→De: steps, days, dates and the initial step. */
  interval: DictionaryContextInterval;
  state: DictionaryIntervalSnapshot;
  /** The window's own increase was the last command (its refusal or unknown outcome is shown here). */
  own: boolean;
  onConfirm(choice: IntervalChoice): void;
  onRetry(): void;
  onClose(): void;
};

/** A changed preview (new version or other steps) is a new choice, never the old one applied silently. */
function previewKey(interval: DictionaryContextInterval): string {
  return JSON.stringify([interval.expected_progress_version, interval.local_date,
    interval.options.map(option => [option.option_id, option.interval_days, option.next_due_date])]);
}

/**
 * The bottom window of the manual increase (TA:39, TA:149, К07-059…067, RA 6.1.12): one slider over the steps the server
 * offers, their days and date, the server's initial step; one confirmation. No direction choice, no date input, no decrease.
 * root decision, pending owner (M-INTV Р5): a new preview (after VERSION_CONFLICT) puts the slider on its new
 * default_option_id; any other known refusal keeps the choice for a new confirmation.
 */
export function IntervalWindow({ language, interval, state, own, onConfirm, onRetry, onClose }: Props) {
  const t = intervalText(language), id = useId();
  const options = interval.options;
  const [selected, setSelected] = useState<number | null>(interval.default_option_id);
  const key = previewKey(interval), shownKey = useRef(key);
  useEffect(() => {
    if (shownKey.current === key) return;
    shownKey.current = key;
    setSelected(interval.default_option_id);
  }, [key, interval.default_option_id]);
  const index = Math.max(0, options.findIndex(option => option.option_id === selected));
  const option = options.length > 0 ? options[index] : null;

  const slider = useRef<HTMLInputElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (slider.current ?? cancel.current)?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  const pending = own && state.pending?.kind === "interval.increase" ? state.pending : null;
  const problem = own && pending === null ? state.problem : null;
  let message: string | null = null;
  if (pending?.status === "unknown") message = pending.busy ? t.checking : t.unknown;
  else if (problem?.code === "VERSION_CONFLICT") message = t.conflict;
  else if (problem && problem.reason !== "load" && problem.reason !== "stale_response") message = t.failed;

  return <div className="interval-backdrop">
    <div className="interval-sheet" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close.current(); } }}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      {option ? <>
        <input ref={slider} type="range" className="interval-slider" aria-label={t.slider} min={0} max={options.length - 1} step={1}
          value={index} disabled={pending !== null}
          aria-valuetext={`${t.days(option.interval_days)}, ${formatStudyDate(option.next_due_date, language)}`}
          onChange={event => setSelected(options[Number(event.target.value)]?.option_id ?? null)} />
        <dl className="interval-choice">
          <div><dt>{t.interval}</dt><dd>{t.days(option.interval_days)}</dd></div>
          <div><dt>{t.next}</dt><dd>{formatStudyDate(option.next_due_date, language)}</dd></div>
        </dl>
      </> : <p className="interval-note">{t.limit}</p>}
      {message && <p role="alert" className="interval-problem">{message}</p>}
      <div className="interval-actions">
        {pending?.status === "unknown" && !pending.busy
          ? <button type="button" disabled={!state.canRetry} onClick={onRetry}>{t.retry}</button>
          : <button type="button" disabled={option === null || !state.canIncrease}
            onClick={() => { if (option) onConfirm({ option_id: option.option_id }); }}>{t.confirm}</button>}
        <button ref={cancel} type="button" onClick={() => close.current()}>{t.cancel}</button>
      </div>
    </div>
  </div>;
}
