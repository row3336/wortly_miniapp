import type { Language } from "../i18n/language";
import { maintenanceWait, t as messages } from "../i18n/messages";
import { commandCopy } from "./commandCopy";
import type { RecoveryScreen } from "./RecoveryOverlay";

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

type PendingKind = { primary: { pendingIntent: { kind: string } | null } };
/**
 * The blurred cover a study screen shows for its recovery. The mark that a shown question was seen (assignment.present)
 * waits without it: the question stays visible, its draft can be typed and the screen's short status says what it
 * waits for, while its answer and any change of the previous result wait for the confirmation (owner answer Q25.2 of
 * 08.10.2026; TA §12.3, TA:113). An unsaved outcome is no waiting and keeps its screen.
 */
export function recoveryCover(screen: RecoveryScreen | null, lanes: PendingKind): RecoveryScreen | null {
  return screen?.kind === "waiting" && lanes.primary.pendingIntent?.kind === "assignment.present" ? null : screen;
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
