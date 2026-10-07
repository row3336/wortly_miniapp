import type { DictionaryCardStudy, DictionaryReviewSchedule } from "../../api/generated";
import type { Language } from "../../i18n/language";
import type { StudyDirection } from "../../i18n/messages";
import type { CardOrigin } from "./cardOrigin";

/** One review direction of an introduced card, as the server reports it; nothing is computed here. */
export type CardStudyRow = {
  direction: StudyDirection;
  /** Null only while the main written reviews are off: their old terms are hidden (К07-058). */
  schedule: DictionaryReviewSchedule | null;
  writtenOff: boolean;
  /** The top step of the manual L1→De increase is reached (К07-063, RA 6.1.10). */
  limitReached: boolean;
};
export type CardStudyState =
  | { kind: "not_selected" }
  | { kind: "manual" }
  | { kind: "learning" }
  | { kind: "reviews"; rows: CardStudyRow[] };

/**
 * The study block of М12 from the server facts only (TA §7, RA 6.1.10, К07-055…058, К07-063).
 * root decision, pending owner (M-CARD Р4): when facts overlap, current Learning wins, then the manual selection,
 * then "not introduced", then ordinary reviews.
 * root decision, pending owner (M-CARD Р5): an introduced direction without terms is not shown.
 */
export function cardStudyState(study: DictionaryCardStudy, origin: CardOrigin): CardStudyState {
  const facts = study.facts;
  if (facts.learning.current !== null) return { kind: "learning" };
  if (facts.manual.selected) return { kind: "manual" };
  const excluded = facts.exclusion.excluded;
  if (!excluded && study.directions.every(direction => !direction.introduced)) return { kind: "not_selected" };
  const rows: CardStudyRow[] = [];
  for (const direction of study.directions) {
    if (origin.kind === "quiz" && direction.direction !== origin.direction) continue;
    if (!direction.introduced) continue;
    const writtenOff = excluded && direction.direction === "l1-de";
    if (writtenOff) { rows.push({ direction: direction.direction, schedule: null, writtenOff, limitReached: false }); continue; }
    if (direction.schedule === null) continue;
    // core dictionary_card_state: only the written L1→De of a word has an increase ladder; there an empty ladder is
    // the top step, elsewhere an empty ladder only means the operation does not exist.
    const limitReached = direction.direction === "l1-de" && study.card_type !== "phrase"
      && Array.isArray(direction.interval_preview) && direction.interval_preview.length === 0;
    rows.push({ direction: direction.direction, schedule: direction.schedule, writtenOff, limitReached });
  }
  return { kind: "reviews", rows };
}

const locales: Record<Language, string> = { ru: "ru-RU", uk: "uk-UA", en: "en-US" };

/** A calendar date of the server, shown in the UI language; noon avoids a time-zone day shift. */
export function formatStudyDate(value: string, language: Language): string {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(locales[language], { year: "numeric", month: "short", day: "numeric" }).format(parsed);
}
