import type { Language } from "../i18n/language";
import { commandCopy } from "./commandCopy";

type Props = {
  className: string;
  language: Language;
  /** Both lanes of the document; a check waits while either one is still exchanging. */
  lanes: { phase: string }[];
  canRetryPrimary: boolean;
  canRetryStop: boolean;
  onCheck(): void;
  onRetry(lane: "primary" | "stop"): void;
};

/** The controls of an unknown command outcome: check it by the same ID, resend exactly it, or retry Stop. */
export function CommandRecovery({ className, language, lanes, canRetryPrimary, canRetryStop, onCheck, onRetry }: Props) {
  const t = commandCopy[language];
  const checking = lanes.some(lane => ["sending", "checking", "loading"].includes(lane.phase));
  return <div className={className}>
    <button type="button" disabled={checking} onClick={() => { if (!checking) onCheck(); }}>{t.check}</button>
    {canRetryPrimary && <button type="button" onClick={() => { onRetry("primary"); }}>{t.retry}</button>}
    {canRetryStop && <button type="button" onClick={() => { onRetry("stop"); }}>{t.retryStop}</button>}
  </div>;
}
