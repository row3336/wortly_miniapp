import { sameId } from "../api/wireValidation";

/** What a mode lane snapshot tells about its last settled command (CommandLane, Learning and conjugation lanes alike). */
type StartLane = {
  outcome: string | null;
  resolved: { kind: string; sessionId: string | null } | null;
};

/**
 * What the mode's owner proved about its session: every owner (written and Learning views, oral and conjugation
 * documents) keeps the session the server proved open in another pair as a fact, never as the shown problem.
 */
type StartView = { pairMismatch: string | null };

/**
 * The session of this owner's own accepted start that the server holds open in another pair, or null (R1, answer 17.1-А:
 * the pair moved on another device and the server started the session there). The start is a fact, not a refusal: the
 * window refreshes its access and goes into that session. Only the owner's proof about exactly that session counts: a
 * mismatch or a reason of another session is not this start's. An unknown start (a lost reply not yet checked) has no
 * outcome and never counts.
 */
export function acceptedForeignStart(lane: StartLane | null | undefined, view: StartView | null | undefined): string | null {
  const sessionId = lane?.outcome === "accepted" && lane.resolved?.kind === "session.start" ? lane.resolved.sessionId : null;
  if (!lane || !view || sessionId === null) return null;
  return view.pairMismatch !== null && sameId(view.pairMismatch, sessionId) ? sessionId.toLowerCase() : null;
}
