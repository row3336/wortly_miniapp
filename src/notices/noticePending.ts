import { useEffect, useRef } from "react";

/**
 * A start refused as NOTICE_PENDING (project notices ed.2.4 §6.1, T5; core a2c29f4 N1b): the profile has a notice not
 * acknowledged yet. The same lane state comes from the direct reply and from the check of an unknown start (the refusal is
 * kept by its command_id, Ж01). Returns that start's command_id, or null.
 */
export function noticePendingStart(lane: { outcome: string | null; rejectionCode?: string | null;
  resolved?: { kind: string; commandId: string } | null } | null | undefined): string | null {
  return lane?.outcome === "rejected" && lane.resolved?.kind === "session.start" && lane.rejectionCode === "NOTICE_PENDING"
    ? lane.resolved.commandId : null;
}

/**
 * Tells the document once per refused start (§6.1 «Восстановление клиента»): it reads GET /notices and shows the waiting
 * summary. Nothing is sent from here: no new command_id and no POST; a new session needs a new press.
 */
export function useNoticePendingSignal(commandId: string | null, onNoticePending: (() => void) | undefined): void {
  const told = useRef(new Set<string>());
  const latest = useRef(onNoticePending); latest.current = onNoticePending;
  useEffect(() => {
    if (commandId === null || told.current.has(commandId)) return;
    told.current.add(commandId);
    latest.current?.();
  }, [commandId]);
}
