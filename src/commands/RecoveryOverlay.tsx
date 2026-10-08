import type { Language } from "../i18n/language";
import { maintenanceWait } from "../i18n/messages";
import { recoveryCopy } from "./commandCopy";
import type { RecoveryView } from "./laneRecovery";

export type RecoveryScreen =
  | { kind: "waiting"; status: "checking" | "offline" | "resending" | "maintenance"; pauseSeconds: number | null }
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
    case "checking": case "pre_send_check": case "window_check": case "counter_unknown": case "suspended": return waiting("checking");
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

/** The blurred cover of the study content with an indicator and the connection status; it has no buttons (Я15). */
export function RecoveryOverlay({ screen, language }: { screen: RecoveryScreen; language: Language }) {
  const t = recoveryCopy[language];
  if (screen.kind === "unsaved") return <div className="recovery-overlay" role="status"><p>{t.unsaved}</p></div>;
  const wait = screen.status === "maintenance" ? maintenanceWait(language, screen.pauseSeconds) : null;
  return <div className="recovery-overlay" role="status" aria-busy="true">
    <Loader />
    <p>{t[screen.status]}{wait ? ` ${wait}` : ""}</p>
  </div>;
}
