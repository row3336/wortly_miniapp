import type { SettingsProjection } from "../api/generated";
import type { SettingsSnapshot } from "./settingsController";

/**
 * Whether this profile has chosen its dictionary language (19.2-А, 19.3-А): the field has been saved at least once, so
 * its version is above 1. A field version only grows, so any read that shows it above 1 proves the choice, whatever
 * else is still unresolved. Version 1 proves nothing on its own: only a confirmed read can require the choice.
 */
export function languageChosen(data: Pick<SettingsProjection, "settings"> | null): boolean {
  return data !== null && BigInt(data.settings.dictionary_language.version) > 1n;
}

export type DictionaryChoice = "chosen" | "required" | "loading" | "failed";

/**
 * What Today waits for before it can be shown. Never inferred from the profile (it carries no field version) nor from
 * a default: an unknown read is "loading" or "failed" and is shown with the existing Today states.
 */
export function dictionaryChoice(state: SettingsSnapshot, confirmed: SettingsProjection | null): DictionaryChoice {
  if (languageChosen(state.data)) return "chosen";
  if (confirmed) return "required";
  // A first choice sent from this screen and not yet resolved stays on it, checked and retried under the same command.
  if (state.data && state.pending?.intent.payload.key === "dictionary_language") return "required";
  // An unresolved intent of another field (or a reset) is not resolved from here: this screen may neither repeat it nor
  // drop it, so the existing failed frame stands, whose retry only checks the intent's status (C211, open to the owner).
  return state.phase === "blocked" || state.phase === "unresolved" || state.phase === "disposed" ? "failed" : "loading";
}
