import type { Language } from "../i18n/language";
import { maintenanceWait } from "../i18n/messages";
import { recoveryCopy } from "./commandCopy";
import type { RecoveryView } from "./laneRecovery";

export type RecoveryScreen =
  /**
   * "unconfirmed": the number of sends that really went out is unreliable, the checks of the result go on (counter_unknown,
   * C093 §6). It stays a "waiting" screen, so the wait for the card to show (Q25.2) is not covered by it.
   */
  | { kind: "waiting"; status: "checking" | "offline" | "resending" | "maintenance" | "unconfirmed"; pauseSeconds: number | null }
  /**
   * Six sends went out and the server confirmed that the action is not saved. Temporary until CP4 (the automatic
   * closure, Я15.8): the screen only says so; the existing Exit stays the way out.
   */
  | { kind: "unsaved" };

type Lanes = {
  recovery: RecoveryView | null;
  primary: { pending: boolean; outcome: string | null; pendingIntent: { command_id: string } | null };
};
const waiting = (status: Exclude<Extract<RecoveryScreen, { kind: "waiting" }>["status"], "maintenance">): RecoveryScreen =>
  ({ kind: "waiting", status, pauseSeconds: null });

/**
 * What the screen shows of the automatic recovery of the pending study action. The first send keeps the ordinary
 * indicator: the blurred screen belongs to a lost reply (Я15.2; root decision, pending owner, D-RECOV question 9).
 * A refusal, a conflict or a termination shows the lane's own state instead (CP4 adds the conflict screen of Я17).
 */
export function recoveryScreen(lanes: Lanes): RecoveryScreen | null {
  const recovery = lanes.recovery, primary = lanes.primary;
  if (!recovery || !primary.pending || primary.outcome !== null || primary.pendingIntent?.command_id !== recovery.commandId) return null;
  const state = recovery.state;
  switch (state.name) {
    case "sending": return state.attempt === 1 && !recovery.afterLoss ? null : waiting("resending");
    case "retry_wait": return waiting("resending");
    case "checking": case "pre_send_check": case "window_check": case "suspended": return waiting("checking");
    // Not an exhaustion of the six sends and no slot is released: only the checks run (9.2.9 + the voluntary Stop 9.2.10).
    case "counter_unknown": return waiting("unconfirmed");
    case "unreachable": return waiting("offline");
    case "maintenance": return { kind: "waiting", status: "maintenance", pauseSeconds: state.pauseSeconds };
    case "exhausted": return { kind: "unsaved" };
    default: return null;
  }
}

/** Я17: the machine stopped on another payload under the same command_id of the pending action. */
export function recoveryConflict(lanes: Lanes): boolean {
  const recovery = lanes.recovery;
  return !!recovery && lanes.primary.pending && lanes.primary.pendingIntent?.command_id === recovery.commandId
    && recovery.state.name === "conflict";
}

/** The loading indicator of the application start (styles/app.css). */
export function Loader() {
  return <svg className="wortly-loader" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="11" fill="var(--line)" />
    <circle cx="12" cy="12" r="8" fill="none" stroke="var(--muted)" strokeWidth="2" />
    <circle className="wortly-loader-arc" cx="12" cy="12" r="8" fill="none" stroke="var(--text)" strokeWidth="3" pathLength="100" />
  </svg>;
}

/**
 * Н6 (D-CP4 3.1.4): the record of a study action outlived the confirmed closure of its session and is still checked by
 * its ID. The session no longer runs, so nothing is covered: only the indicator and 9.2.1, or 9.2.2 while the server
 * is unreachable, or 9.2.4 in a confirmed planned pause (503 MAINTENANCE only: root decision on QA CP4a-1 Ф5, C049);
 * no buttons until the answer is definite.
 */
export function ClosedCheckStatus({ screen, language, className }: { screen: RecoveryScreen | null; language: Language; className: string }) {
  const t = recoveryCopy[language];
  const status = screen?.kind === "waiting" ? screen.status : "checking";
  const wait = screen?.kind === "waiting" && status === "maintenance" ? maintenanceWait(language, screen.pauseSeconds) : null;
  return <div className={className} role="status" aria-busy="true">
    <Loader />
    <p>{status === "offline" ? t.offline : status === "maintenance" ? `${t.maintenance}${wait ? ` ${wait}` : ""}` : t.checking}</p>
  </div>;
}

/**
 * The blurred cover of the study content with an indicator and the connection status; it has no buttons (Я15), except
 * 9.2.10 under the unconfirmed status: the ordinary voluntary Stop (onEnd), off while Stop is not allowed (canEnd).
 */
export function RecoveryOverlay({ screen, language, canEnd = false, onEnd }: {
  screen: RecoveryScreen; language: Language; canEnd?: boolean; onEnd?: () => void;
}) {
  const t = recoveryCopy[language];
  if (screen.kind === "unsaved") return <div className="recovery-overlay" role="status"><p>{t.unsaved}</p></div>;
  const wait = screen.status === "maintenance" ? maintenanceWait(language, screen.pauseSeconds) : null;
  return <div className="recovery-overlay" role="status" aria-busy="true">
    <Loader />
    <p>{t[screen.status]}{wait ? ` ${wait}` : ""}</p>
    {screen.status === "unconfirmed" && onEnd && <button type="button" disabled={!canEnd} onClick={() => { if (canEnd) onEnd(); }}>{t.endSession}</button>}
  </div>;
}
