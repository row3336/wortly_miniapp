import type { Language } from "../i18n/language";
import { maintenanceWait, t as messages } from "../i18n/messages";
import { commandCopy } from "./commandCopy";

type Props = {
  className: string;
  language: Language;
  /** Both lanes of the document; a check waits while either one is still exchanging. */
  lanes: { phase: string; problem?: string | null; pauseSeconds?: number | null }[];
  canRetryPrimary: boolean;
  canRetryStop: boolean;
  /** Only a local record of a confirmed outcome is left: the control repeats its cleanup, so it is named so. */
  localOnly?: boolean;
  onCheck(): void;
  onRetry(lane: "primary" | "stop"): void;
};

type LaneFacts = { pending: boolean; outcome: string | null; problem?: string | null };
/**
 * The outcome of the primary action is confirmed, only its local record could not be cleared (problem "storage"), and
 * Stop has nothing unknown: the one control left repeats that cleanup.
 */
export function localCleanupOnly(primary: LaneFacts, stop: LaneFacts): boolean {
  return primary.pending && primary.outcome !== null && primary.problem === "storage" && !(stop.pending && stop.outcome === null);
}

/**
 * The controls of an unknown command outcome: check it by the same ID, resend exactly it, or retry Stop.
 * A refusal that is neither a lost reply nor a denial (planned pause, outdated client) also names itself here,
 * so every study screen that shows these controls says it without each knowing about it.
 */
export function CommandRecovery({ className, language, lanes, canRetryPrimary, canRetryStop, localOnly = false, onCheck, onRetry }: Props) {
  const t = commandCopy[language];
  const checking = lanes.some(lane => ["sending", "checking", "loading"].includes(lane.phase));
  const copy = messages(language);
  const incompatible = lanes.some(lane => lane.problem === "incompatible");
  const paused = lanes.find(lane => lane.problem === "maintenance");
  const wait = paused ? maintenanceWait(language, paused.pauseSeconds) : null;
  return <div className={className}>
    {/* The controls are a wrapping flex row; .command-note (styles/app.css) gives the note its own row. */}
    {incompatible && <p role="status" className="command-note">{copy.commandIncompatible}</p>}
    {!incompatible && paused && <p role="status" className="command-note">{copy.commandMaintenance}{wait ? ` ${wait}` : ""}</p>}
    <button type="button" disabled={checking} onClick={() => { if (!checking) onCheck(); }}>{localOnly ? t.updateDevice : t.check}</button>
    {canRetryPrimary && <button type="button" onClick={() => { onRetry("primary"); }}>{t.retry}</button>}
    {canRetryStop && <button type="button" onClick={() => { onRetry("stop"); }}>{t.retryStop}</button>}
  </div>;
}
