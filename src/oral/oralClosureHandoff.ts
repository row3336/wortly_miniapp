import type { OralClosed } from "./oralDocumentController";

/**
 * M1d (C537; Q32 вар.1, R4-03; Codex C581/C582): the local handoff of the closure of an own oral session S inside the live
 * Mini App, from the owner that accepted the fact to the next owners of the same profile and installation — the owner of
 * the pair the window moved to among them. Only the immutable fact travels: S, its real reason and the local mark that the
 * person left its frame («На Сегодня» or the native Back on it). No projection, numbers, cards or rights of S, and no
 * version: a fact once accepted by a live owner does not turn stale because a later owner has a higher floor (C582).
 * The JS document is its lifetime: a reload or a closed Mini App starts empty (R22 is not touched).
 */
type Reason = NonNullable<OralClosed["reason"]>;
/**
 * Q32 вар.1, R4-03 (TZA :295, tz_app.md SHA-16 7d949301; Codex C520): in the OPEN window every proven closure of the
 * session without the person shows its summary with the reason and an explicit «На Сегодня» — never the bare closed
 * line, never a return to Today by itself. R22 limits only the notice of a closed Mini App, not this screen.
 * Only these closures are handed off.
 */
export const FORCED_ORAL_REASONS: readonly string[] = ["midnight", "timezone_date_changed", "remote_stop", "pair_changed"];
/** reason null: a frame left before any owner noted its fact here (the mark alone, so it is never shown later). */
type Fact = { sessionId: string; reason: Reason | null; left: boolean };
export type OralClosureOwner = { profileId: string; clientInstanceId: string };

const facts = new Map<string, Map<string, Fact>>();
const ownerKey = (owner: OralClosureOwner) => `${owner.profileId.toLowerCase()}:${owner.clientInstanceId.toLowerCase()}`;

/** An owner accepted the closure of its own S with its reason (a fresh, attributed fact). The first reason stays. */
export function noteOralClosure(owner: OralClosureOwner, sessionId: string, reason: Reason): void {
  if (!FORCED_ORAL_REASONS.includes(reason)) return;
  const key = ownerKey(owner), id = sessionId.toLowerCase();
  let sessions = facts.get(key);
  if (!sessions) { sessions = new Map(); facts.set(key, sessions); }
  if (!sessions.has(id)) sessions.set(id, { sessionId: id, reason, left: false });
}

/** The person left the frame of that closure: no owner shows it again in this document. */
export function leaveOralClosure(owner: OralClosureOwner, sessionId: string): void {
  const key = ownerKey(owner), id = sessionId.toLowerCase();
  let sessions = facts.get(key);
  if (!sessions) { sessions = new Map(); facts.set(key, sessions); }
  const fact = sessions.get(id);
  if (fact) fact.left = true; else sessions.set(id, { sessionId: id, reason: null, left: true });
}

/** Whether the person left the frame of that closure. */
export function oralClosureLeft(owner: OralClosureOwner, sessionId: string): boolean {
  return facts.get(ownerKey(owner))?.get(sessionId.toLowerCase())?.left === true;
}

/** Tests only: each test starts with an empty document (src/test.setup.ts). */
export function resetOralClosures(): void { facts.clear(); }

/** The latest closure of this owner's sessions whose frame was not left yet, if any. */
export function unleftOralClosure(owner: OralClosureOwner): { sessionId: string; reason: Reason } | null {
  const sessions = [...(facts.get(ownerKey(owner))?.values() ?? [])].filter(fact => !fact.left && fact.reason !== null);
  const last = sessions.at(-1);
  return last && last.reason !== null ? { sessionId: last.sessionId, reason: last.reason } : null;
}
