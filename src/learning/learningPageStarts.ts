import type { LearningSessionPending } from "./learningSessionPending";

type Origin = { profileId: string; clientInstanceId: string; pair: string; sessionId: string; commandId: string };
const originOf = (pending: LearningSessionPending): Origin => ({ profileId: pending.profileId.toLowerCase(),
  clientInstanceId: pending.clientInstanceId.toLowerCase(), pair: pending.pair,
  sessionId: pending.intent.session_id.toLowerCase(), commandId: pending.intent.command_id.toLowerCase() });

/**
 * The Learning starts that this page (one real JS document) created and has not resolved yet: memory only, never stored.
 * A start record read from the device that is not listed here was made by another page — a full reload or another
 * window — and is only checked by its ID, never sent again (owner decision 35.1-А, C204/C205). Being listed proves
 * nothing about HTTP: it is no fact of a send, no right to send and no new budget; the existing rules still decide.
 */
export class LearningPageStarts {
  private readonly own = new Map<string, Origin>();

  /** Called with the exact intent before its first asynchronous step (the slot write), so no record precedes the mark. */
  mark(pending: LearningSessionPending): void {
    if (pending.intent.kind !== "session.start") return;
    const origin = originOf(pending);
    this.own.set(origin.commandId, origin);
  }
  /** Whether this page created exactly this start: the same profile, installation, pair, session and command. */
  owns(pending: LearningSessionPending): boolean {
    const mark = this.own.get(pending.intent.command_id.toLowerCase());
    if (!mark) return false;
    const origin = originOf(pending);
    return mark.profileId === origin.profileId && mark.clientInstanceId === origin.clientInstanceId
      && mark.pair === origin.pair && mark.sessionId === origin.sessionId;
  }
  /** Only after the record of a known outcome was cleared: a failed cleanup keeps the mark with its record. */
  forget(commandId: string): void { this.own.delete(commandId.toLowerCase()); }
}

/**
 * Created once when this JS document loads the module: it outlives App remounts, StrictMode cleanups, new storage
 * wrappers and new open handles of this page, and a reload or another window starts with an empty one.
 */
export const documentLearningStarts = new LearningPageStarts();
