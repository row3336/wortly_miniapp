import { useState } from "react";
import { useBackLayer } from "../app/navigationBack";
import type { Language } from "../i18n/language";
import type { DictionaryIntervalSnapshot } from "./dictionaryIntervalController";
import { intervalText } from "./intervalCopy";
import { IntervalWindow } from "./IntervalWindow";
import type { DictionaryIntervalContextActions } from "./useDictionaryIntervalContext";
import "./interval.css";

type Props = {
  language: Language;
  /** The open card context (useDictionaryIntervalContext): offer, pending command and undo offer are its state. */
  context: { state: DictionaryIntervalSnapshot; actions: DictionaryIntervalContextActions };
  /** false for a host that is leaving: no window and no native Back. */
  enabled?: boolean;
};

/** The draining bar keeps the timing of its first showing: re-renders never restart or stretch it (CT 2.1.2 p.3). */
function UndoBar({ remainingMs, durationMs }: { remainingMs: number; durationMs: number }) {
  const [timing] = useState(() => ({ animationDuration: `${durationMs}ms`, animationDelay: `-${Math.max(0, durationMs - remainingMs)}ms` }));
  return <div className="interval-undo-track" aria-hidden="true"><div className="interval-undo-bar" style={timing} /></div>;
}

/**
 * The manual increase of the open card (TA:149–151, К07-059…067, К07-122, К07-123). Everything is the server's offer:
 * the control exists only with capability interval_increase. The window closing is local (it is not context.close, TA:151).
 * root decision, pending owner (M-INTV Р6): a request or its status check on the way blurs the current screen with a circle;
 * an outcome still unknown after the check shows its message and «Повторить» (the same command) here and in the window.
 * root decision, pending owner (M-INTV Р1): the written quiz reaches this window through the card of its answered word
 * (context.open of core takes only the dictionary source). Р7: an unresolved increase lives in the document's memory only;
 * after a full restart the card shows the server's terms. Р9: while the undo strip shows, a new increase stays possible.
 */
export function IntervalPanel({ language, context, enabled = true }: Props) {
  const t = intervalText(language), { state, actions } = context;
  // The window remembers the last applied command at its opening: any command applied after that (the confirmed increase,
  // and then its undo) keeps it closed from the render that shows the result on (К07-122, TA:151), never a frame later.
  const [open, setOpen] = useState<{ since: string | null } | null>(null);
  // The command the user last started here: its refusal or unknown outcome is the one to explain.
  const [last, setLast] = useState<"interval.increase" | "action.undo" | null>(null);
  const applied = state.applied;
  const succeeded = open !== null && applied !== null && applied.commandId !== open.since;

  const pending = state.pending?.kind === "interval.increase" || state.pending?.kind === "action.undo" ? state.pending : null;
  const offered = state.interval !== null && state.capabilities.interval_increase !== null;
  const windowShown = enabled && open !== null && !succeeded && state.interval !== null
    && (offered || pending?.kind === "interval.increase");
  useBackLayer("overlay", windowShown ? () => setOpen(null) : null);

  const openWindow = () => {
    setOpen({ since: applied?.commandId ?? null });
    // An unresolved increase is checked again at once (К07-123): no separate «Проверить сохранение».
    if (pending?.status === "unknown" && !pending.busy) void actions.refresh();
  };
  const unknown = pending !== null && pending.status === "unknown" && !pending.busy;
  const refused = last === "action.undo" && pending === null && state.problem !== null
    && state.problem.reason !== "load" && state.problem.reason !== "stale_response";
  return <div className="interval-panel">
    {(offered || pending?.kind === "interval.increase") && <button type="button" className="card-action"
      disabled={!state.canIncrease && pending?.kind !== "interval.increase"} onClick={openWindow}>{t.open}</button>}
    {/* The strip appears without focus: announced as a polite status. */}
    {state.undoOffer && <div className="interval-undo" role="status" aria-live="polite">
      <button type="button" className="card-action" disabled={!state.canUndo}
        onClick={() => { setLast("action.undo"); void actions.undo(); }}>{t.undo}</button>
      <UndoBar key={applied?.commandId ?? ""} remainingMs={state.undoOffer.remainingMs} durationMs={state.undoOffer.durationMs} />
    </div>}
    {unknown && !windowShown && <div className="interval-status">
      <p role="alert">{pending.kind === "interval.increase" ? t.unknown : t.undoUnknown}</p>
      <button type="button" className="card-action" disabled={!state.canRetry} onClick={() => { void actions.retry(); }}>{t.retry}</button>
    </div>}
    {refused && <p role="alert" className="interval-problem">{t.undoFailed}</p>}
    {windowShown && <IntervalWindow language={language} interval={state.interval!} state={state} own={last === "interval.increase"}
      onConfirm={choice => {
        setLast("interval.increase");
        try { void actions.increase(choice); } catch { /* the offer changed under the tap: nothing was sent */ }
      }}
      onRetry={() => { void actions.retry(); }} onClose={() => setOpen(null)} />}
    {pending?.busy && <div className="interval-wait" role="status" aria-label={t.saving}><span className="interval-spinner" /></div>}
  </div>;
}
