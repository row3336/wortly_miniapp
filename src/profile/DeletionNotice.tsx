import type { EntrySnapshot } from "../app/entryController";
import type { Language } from "../i18n/language";
import { deleteText } from "./profileDeleteCopy";

/**
 * PD-28 (P04 ред.14 §3.7): after the explicit sign-in that followed an unknown outcome, the profile the core now names
 * decides. Another profile_id: the earlier profile is deleted (only S34 removes the Telegram link). The same one: the
 * deletion was not applied and a new question is needed. Null while the sign-in has not named a profile yet.
 */
export function deletionCheckResult(confirmedProfileId: string | null, snapshot: EntrySnapshot): "deleted" | "not_deleted" | null {
  if (!confirmedProfileId || !snapshot.profile) return null;
  const kind = snapshot.state.kind;
  if (kind === "checking" || kind === "deletion_unknown" || kind === "profile_deleted") return null;
  return snapshot.profile.profile_id.toLowerCase() === confirmedProfileId.toLowerCase() ? "not_deleted" : "deleted";
}

/** The conclusion of PD-28, without the archive details of the one-time answer; «Продолжить» shows the entry under it. */
export function DeletionNotice({ kind, language, onContinue }: { kind: "deleted" | "not_deleted"; language: Language; onContinue(): void }) {
  const d = deleteText(language);
  return <main className="app-shell">
    <section className="entry-card" aria-live="polite">
      <h1>{d.group}</h1>
      <p>{kind === "deleted" ? d.deletedAfterLogin : d.notDeletedAfterLogin}</p>
      <button className="primary-action" type="button" onClick={onContinue}>{d.continue}</button>
    </section>
  </main>;
}
