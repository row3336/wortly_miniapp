import type { Language } from "../i18n/language";
import { maintenanceWait, t } from "../i18n/messages";
import type { EntryState } from "./entryState";
import { RemoteStopScreen } from "../study/RemoteStopScreen";
import { gateWaitText } from "../commands/CommandRecovery";
import { recoveryCopy } from "../commands/commandCopy";

type Props = {
  state: EntryState;
  language: Language;
  onRetry?: () => void;
  onReapply?: () => void;
  onRemoteRequest?: () => void;
  onRemoteCancel?: () => void;
  onRemoteConfirm?: () => void;
  onRemoteCheck?: () => void;
  onRemoteRetry?: () => void;
  /** The check of a window whose request got DOCUMENT_STALE: only its title differs from the ordinary entry. */
  afterStale?: boolean;
};

export function EntryScreen({ state, language, onRetry, onReapply,
  onRemoteRequest, onRemoteCancel, onRemoteConfirm, onRemoteCheck, onRemoteRetry, afterStale }: Props) {
  if (state.kind === "remote" || state.kind === "remote_confirm" || state.kind === "busy" && state.remoteTarget) {
    return <RemoteStopScreen state={state} language={language} onRequest={onRemoteRequest}
      onCancel={onRemoteCancel} onConfirm={onRemoteConfirm} onCheck={onRemoteCheck} onRetry={onRemoteRetry} />;
  }
  const copy = t(language);
  // К-9 / a first open held by the outage mark (P03 §4.8, §4.10): a wait screen without a button — the planned pause
  // with its estimate, otherwise «waiting for the server» (9.2.2) under the loader.
  const waiting = state.kind === "unavailable" && state.waiting ? state : null;
  const waitPause = waiting?.wait?.cause === "maintenance" ? waiting.wait : null;
  const loading = state.kind === "checking" || state.kind === "opening" || state.kind === "reapplying" || !!waiting && !waitPause;
  // A window whose document a newer one took over reads as «already open», without buttons, until Q54 is answered.
  const busy = state.kind === "busy" || state.kind === "replaced";
  const title = waitPause ? copy.maintenance : loading
    ? afterStale ? copy.updating : copy.loading
    : state.kind === "closed"
      ? state.reason === "busy" ? copy.busy : copy.closedWindow
    : state.kind === "pending"
      ? copy.pending
      : state.kind === "rejected"
        ? state.pause ? copy.maintenance : state.closed ? copy.rejectedClosed : copy.rejected
        : busy
          ? copy.busy
          : state.kind === "opened"
            ? copy.opened
          : state.kind === "expired"
            ? copy.expired
          : state.kind === "incompatible"
            ? copy.incompatible
        : copy.unavailable;
  const detail = waitPause ? copy.maintenanceDetail : waiting ? recoveryCopy[language].offline : loading
    ? copy.loadingDetail
    : state.kind === "closed"
      ? state.reason === "busy" ? copy.busyDetail : copy.closedWindowDetail
    : state.kind === "pending"
      ? copy.pendingDetail
      : state.kind === "rejected"
        ? state.pause ? copy.maintenanceDetail : state.closed ? copy.rejectedClosedDetail : copy.rejectedDetail
        : busy
          ? copy.busyDetail
          : state.kind === "opened"
            ? copy.openedDetail
          : state.kind === "expired"
            ? copy.expiredDetail
          : state.kind === "incompatible"
            ? copy.incompatibleDetail
        : copy.unavailableDetail;
  const wait = state.kind === "rejected" && state.pause ? maintenanceWait(language, state.pause.waitSeconds)
    : waitPause ? maintenanceWait(language, waitPause.waitSeconds) : null;
  // The rule of the button (§4.1, C335): a gate that holds keeps the button visible and inactive, with the wait of §4.8;
  // the button of §4.13 route В stays blocked until Я19 whatever the gate (no request leaves).
  const retryActive = state.kind === "unavailable" && (state.route === "document" || state.route === "own" || state.route === "profile")
    && !!state.checkable;
  const reapplyBlocked = state.kind === "rejected" && !!state.blocked;
  const gateLine = state.kind === "unavailable" && !waiting && state.wait ? gateWaitText(language, state.wait)
    : state.kind === "rejected" && state.blocked && state.wait && !state.pause ? gateWaitText(language, state.wait) : null;

  return (
    <main className="app-shell">
      <section className="entry-card" aria-live="polite" aria-busy={loading}>
        {loading && (
          <svg className="wortly-loader" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="11" fill="var(--line)" />
            <circle cx="12" cy="12" r="8" fill="none" stroke="var(--muted)" strokeWidth="2" />
            <circle className="wortly-loader-arc" cx="12" cy="12" r="8" fill="none" stroke="var(--text)" strokeWidth="3" pathLength="100" />
          </svg>
        )}
        <h1>{title}</h1>
        <p>{detail}</p>
        {wait && <p className="maintenance-wait">{wait}</p>}
        {state.kind === "rejected" && state.reason && <p className="access-reason">{state.reason}</p>}
        {gateLine && <p className="gate-wait" role="status">{gateLine}</p>}
        {state.kind === "rejected" && !state.closed && onReapply && (
          <button className="primary-action" type="button" disabled={reapplyBlocked}
            onClick={() => { if (!reapplyBlocked) onReapply(); }}>
            {copy.reapply}
          </button>
        )}
        {state.kind === "unavailable" && !waiting && onRetry && (
          <button className="primary-action" type="button" disabled={!retryActive}
            onClick={() => { if (retryActive) onRetry(); }}>
            {copy.retry}
          </button>
        )}
      </section>
    </main>
  );
}
