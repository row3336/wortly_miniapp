import type { ForegroundIntent } from "../app/entryController";

/**
 * fix4 (П01, TZA 12.1, C382): the «На Сегодня» of the screen of a start the server refused as SESSION_BUSY — the only
 * transition that may spend the П01 episode of the write gate. Any other way back to Today carries no intent.
 */
export function startRefusalIntent(primary: { outcome: string | null; rejectionCode?: string | null;
  resolved?: { kind: string; commandId: string } | null } | null | undefined): ForegroundIntent | undefined {
  // C384: the signal names the very refusal on screen — its start's command_id; the gate matches it with its episode.
  return primary?.outcome === "rejected" && primary.resolved?.kind === "session.start" && primary.rejectionCode === "SESSION_BUSY"
    ? { startRefused: primary.resolved.commandId } : undefined;
}
