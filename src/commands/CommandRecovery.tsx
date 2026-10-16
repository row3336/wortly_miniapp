import type { Language } from "../i18n/language";
import { maintenanceWait, t as messages } from "../i18n/messages";
import { commandCopy, recoveryCopy } from "./commandCopy";
import type { GateWait } from "./gateWait";
import type { LaneGate } from "./documentLanes";
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
  /**
   * The write gate (§4.1 «Правило кнопки», C335): while it holds, the controls stay visible and inactive with the wait
   * of §4.8 — «Проверить» by checkButtonActive, a resend by mayWrite of its ID. A press meanwhile does nothing; nothing
   * is queued, and once the gate lets it the user presses again.
   */
  gate?: LaneGate;
};

/**
 * The wait line of a manual control under a shut gate (P03 §4.8 «Ручные K01s, K03–K14», M-P03-9): the planned pause or an
 * announced hold — commandMaintenance with the estimate; the server unreachable or not ready — 9.2.2; the check of the
 * identity with pending actions — 9.2.1.
 */
export function gateWaitText(language: Language, wait: GateWait): string {
  if (wait.cause === "maintenance") {
    const estimate = maintenanceWait(language, wait.waitSeconds);
    return `${messages(language).commandMaintenance}${estimate ? ` ${estimate}` : ""}`;
  }
  return wait.cause === "checking" ? recoveryCopy[language].checking : recoveryCopy[language].offline;
}

type LaneFacts = { pending: boolean; outcome: string | null; problem?: string | null };
/**
 * S07: the server confirmed that the primary action was saved (accepted, never a refusal), only its local record could
 * not be cleared (problem "storage"), and Stop has nothing unknown: the one control left repeats that cleanup. A
 * refused action whose record was left keeps the ordinary check of its state.
 */
export function localCleanupOnly(primary: LaneFacts, stop: LaneFacts): boolean {
  return primary.pending && primary.outcome === "accepted" && primary.problem === "storage" && !(stop.pending && stop.outcome === null);
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
export function CommandRecovery({ className, language, lanes, canRetryPrimary, canRetryStop, localOnly = false, onCheck, onRetry, gate }: Props) {
  const t = commandCopy[language];
  const checking = lanes.some(lane => ["sending", "checking", "loading"].includes(lane.phase));
  const copy = messages(language);
  const incompatible = lanes.some(lane => lane.problem === "incompatible");
  // Q27 (C458): the lost answer is never sent again; the line says so, the screen's «Выйти» ends the session.
  const lost = lanes.some(lane => lane.problem === "lost_envelope");
  const paused = lanes.find(lane => lane.problem === "maintenance");
  const wait = paused ? maintenanceWait(language, paused.pauseSeconds) : null;
  // The local cleanup of a confirmed outcome reads and sends nothing: the gate does not hold it.
  const checkBlocked = !localOnly && gate?.checkable === false;
  const primaryBlocked = gate?.primaryWritable === false, stopBlocked = gate?.stopWritable === false;
  const held = checkBlocked || canRetryPrimary && primaryBlocked || canRetryStop && stopBlocked;
  const gateLine = held && gate?.wait ? gateWaitText(language, gate.wait) : null;
  const checkDisabled = checking || checkBlocked;
  return <div className={className}>
    {/* The controls are a wrapping flex row; .command-note (styles/app.css) gives the note its own row. */}
    {incompatible && <p role="status" className="command-note">{copy.commandIncompatible}</p>}
    {lost && <p role="status" className="command-note">{recoveryCopy[language].lost}</p>}
    {!incompatible && gateLine && <p role="status" className="command-note">{gateLine}</p>}
    {!incompatible && !gateLine && paused && <p role="status" className="command-note">{copy.commandMaintenance}{wait ? ` ${wait}` : ""}</p>}
    <button type="button" disabled={checkDisabled} onClick={() => { if (!checkDisabled) onCheck(); }}>{localOnly ? t.updateDevice : t.check}</button>
    {canRetryPrimary && <button type="button" disabled={primaryBlocked}
      onClick={() => { if (!primaryBlocked) onRetry("primary"); }}>{t.retry}</button>}
    {canRetryStop && <button type="button" disabled={stopBlocked}
      onClick={() => { if (!stopBlocked) onRetry("stop"); }}>{t.retryStop}</button>}
  </div>;
}
