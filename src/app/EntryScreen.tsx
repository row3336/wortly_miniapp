import type { Language } from "../i18n/language";
import { t } from "../i18n/messages";
import type { EntryState } from "./entryState";
import { RemoteStopScreen } from "../study/RemoteStopScreen";

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
  onReplaceConfirm?: () => void;
  onReplaceCancel?: () => void;
};

export function EntryScreen({ state, language, onRetry, onReapply,
  onRemoteRequest, onRemoteCancel, onRemoteConfirm, onRemoteCheck, onRemoteRetry, onReplaceConfirm, onReplaceCancel }: Props) {
  if (state.kind === "remote" || state.kind === "remote_confirm" || state.kind === "busy" && state.remoteTarget) {
    return <RemoteStopScreen state={state} language={language} onRequest={onRemoteRequest}
      onCancel={onRemoteCancel} onConfirm={onRemoteConfirm} onCheck={onRemoteCheck} onRetry={onRemoteRetry} />;
  }
  const copy = t(language);
  const loading = state.kind === "checking" || state.kind === "opening" || state.kind === "reapplying";
  // Another window of this installation, whether the lock or the server reported it, reads as «already open».
  const busy = state.kind === "busy" || state.kind === "other_window" || state.kind === "replace_confirm";
  const title = loading
    ? copy.loading
    : state.kind === "pending"
      ? copy.pending
      : state.kind === "rejected"
        ? copy.rejected
        : busy
          ? copy.busy
          : state.kind === "opened"
            ? copy.opened
          : state.kind === "expired"
            ? copy.expired
        : copy.unavailable;
  const detail = loading
    ? copy.loadingDetail
    : state.kind === "pending"
      ? copy.pendingDetail
      : state.kind === "rejected"
        ? copy.rejectedDetail
        : state.kind === "replace_confirm"
          ? copy.replaceDetail
        : busy
          ? copy.busyDetail
          : state.kind === "opened"
            ? copy.openedDetail
          : state.kind === "expired"
            ? copy.expiredDetail
        : copy.unavailableDetail;

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
        {state.kind === "rejected" && state.reason && <p className="access-reason">{state.reason}</p>}
        {state.kind === "rejected" && onReapply && (
          <button className="primary-action" type="button" onClick={onReapply}>
            {copy.reapply}
          </button>
        )}
        {state.kind === "replace_confirm" && onReplaceConfirm && (
          <button className="primary-action" type="button" onClick={onReplaceConfirm}>
            {copy.replaceConfirm}
          </button>
        )}
        {state.kind === "replace_confirm" && onReplaceCancel && (
          <button className="secondary-action" type="button" onClick={onReplaceCancel}>
            {copy.replaceCancel}
          </button>
        )}
        {state.kind === "unavailable" && onRetry && (
          <button className="primary-action" type="button" onClick={onRetry}>
            {copy.retry}
          </button>
        )}
      </section>
    </main>
  );
}
