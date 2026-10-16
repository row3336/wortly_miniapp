import { newerVersion, type Installation } from "./installation";
import type { InstallationDecision } from "./installationStore";

/**
 * C163 шаг 6 (C405/C410, P2-5B): the pure decisions of the four writers of the installation record. Each runs
 * synchronously over the ACTUAL record the store read under its lock (installationStore.mutate) — never over a snapshot
 * kept in memory — and either writes, keeps, or refuses. No await, no side effect, no clock.
 */

/** The record this page knew, compared field by field (the proof by identity, never logged). */
export function sameInstallation(left: Installation | null, right: Installation | null): boolean {
  if (left === null || right === null) return left === right;
  return left.profileId === right.profileId && left.clientInstanceId === right.clientInstanceId
    && left.registrationId === right.registrationId && left.proof === right.proof
    && left.proofVersion === right.proofVersion && left.activated === right.activated;
}

/**
 * The ONE way a writer builds a record (project_installation_store.md §2, §4 «без spread»): exactly the six fields, named
 * one by one — no `{...current}`, so no extra field of an actual value can ever be carried into a write.
 */
function six(profileId: string, clientInstanceId: string, registrationId: string, proof: string | null,
  proofVersion: string | null, activated: boolean): Installation {
  return { profileId, clientInstanceId, registrationId, proof, proofVersion, activated };
}

const fresh = (profileId: string, ids: { clientInstanceId: string; registrationId: string }): Installation =>
  six(profileId, ids.clientInstanceId, ids.registrationId, null, null, false);

/**
 * Writer 1 — A create/reuse (the ordinary entry, prepareInstallation): a record with a proof is reused as it is; none,
 * or one without a proof (its registration belonged to an earlier sign-in), is replaced by a new record with new IDs.
 * The decision is made on the actual record: a B another run of this page wrote meanwhile WITH a proof is reused, never
 * replaced by a late A.
 */
export function decideA(current: Installation | null, profileId: string,
  ids: { clientInstanceId: string; registrationId: string }): InstallationDecision<Installation> {
  if (current && current.proof && current.proofVersion) return { keep: true, result: current };
  const created = fresh(profileId, ids);
  return { write: created, result: created };
}

export type BConflict = "foreign";
/**
 * Writer 2 — B after a refused proof (C163 шаг 5, CON:200): the actual record must be exactly the A this page knew
 * (expectedA) or exactly this page's own B as it last knew it (ownB: profile, client, registration, proof, version,
 * activated — 6b, P2-6A: a record with our client id but another registration or proof is NOT ours). Own B with a
 * proof is reused; own B without one, or A, are replaced by a NEW B (6b: «no record» is a conflict). Anything else — a fresher A,
 * another window's B, a forged or re-registered record under our client id — is "foreign": nothing is written.
 */
export function decideB(current: Installation | null, profileId: string, expectedA: Installation, ownB: Installation | null,
  ids: { clientInstanceId: string; registrationId: string }): InstallationDecision<Installation, BConflict> {
  if (current && ownB !== null && sameInstallation(current, ownB)) {
    if (current.proof && current.proofVersion) return { keep: true, result: current };
  } else if (current === null || !sameInstallation(current, expectedA)) {
    // 6b (P3, OB-null): no record is no proof of anything either — A vanished (cleanup, profile wipe P04, another
    // window): C405 asks for the EXACT expected A or own B, so nothing else, «none» included, gets a B.
    return { conflict: "foreign" };
  }
  const created = fresh(profileId, ids);
  return { write: created, result: created };
}

export type RegisterConflict = "replaced" | "inconsistent";
/**
 * Writer 3 — the result of POST /client/register. It belongs only to the IDs that were sent: another record now
 * (replaced by A or B) → "replaced". The highest proof_version is read from the ACTUAL record: a newer one there keeps it
 * (this reply is late); the same version with another proof → "inconsistent"; the same version and proof → kept. The
 * proof is written over the actual record, so its `activated` is never lowered.
 */
export function decideRegister(current: Installation | null,
  sent: { profileId?: string; clientInstanceId: string; registrationId: string },
  reply: { proof: string; proofVersion: string }): InstallationDecision<Installation, RegisterConflict> {
  if (!current || current.clientInstanceId !== sent.clientInstanceId || current.registrationId !== sent.registrationId
    || sent.profileId !== undefined && current.profileId !== sent.profileId) {
    return { conflict: "replaced" };
  }
  if (current.proofVersion !== null) {
    if (newerVersion(current.proofVersion, reply.proofVersion)) return { keep: true, result: current };
    if (current.proofVersion === reply.proofVersion) {
      return current.proof === reply.proof ? { keep: true, result: current } : { conflict: "inconsistent" };
    }
  }
  const updated = six(current.profileId, current.clientInstanceId, current.registrationId, reply.proof, reply.proofVersion, current.activated);
  return { write: updated, result: updated };
}

export type ActivatedConflict = "replaced";
/**
 * Writer 4 — `activated` after a confirmed opened of this installation. Only the flag of the actual record of the SAME
 * installation changes — the same profile, client_instance_id AND registration_id (6b, P2-6A); a fresher proof of that
 * registration there is kept, never rewritten from a snapshot; already set → kept; anything else → "replaced".
 */
export function decideActivated(current: Installation | null,
  installation: { profileId: string; clientInstanceId: string; registrationId: string }): InstallationDecision<Installation, ActivatedConflict> {
  if (!current || current.profileId !== installation.profileId || current.clientInstanceId !== installation.clientInstanceId
    || current.registrationId !== installation.registrationId) return { conflict: "replaced" };
  if (current.activated) return { keep: true, result: current };
  const updated = six(current.profileId, current.clientInstanceId, current.registrationId, current.proof, current.proofVersion, true);
  return { write: updated, result: updated };
}
