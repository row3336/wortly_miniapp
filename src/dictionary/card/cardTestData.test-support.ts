import type { CardExample, DictionaryCardView, DictionaryCardViewResponse, DictionaryStudyDirection } from "../../api/generated";

export const cardIdOf = (n: number) => `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`;
export const CARD = cardIdOf(1);

type Pair = "ru-de" | "uk-de" | "en-de";

/** A not yet studied noun accepted by the strict view decoder. */
export function cardView(cardId = CARD, pair: Pair = "ru-de"): DictionaryCardView {
  return {
    status: "available",
    content: {
      pair, card: { id: cardId, revision: "1", lemma: "Haus", type: "noun", cefr: "A1" },
      translations: { common: ["дом"], personal: null },
      grammar: { gender: "neuter", gender_status: "applicable", singular: "Haus", plural: "Häuser", article_status: "applicable",
        singular_status: "applicable", plural_status: "applicable" },
      reference_conjugations: [], examples: { common: [], personal: null }, association: null,
      field_versions: { translation: "1", example: "1", association: "1" },
    },
    study: {
      status: "available", card_id: cardId, card_revision: "1", pair, card_type: "noun", local_date: "2026-10-07",
      facts: {
        common_translation_present: true, exclusion: { excluded: false, version: null },
        manual: { selected: false, selection_version: "1" },
        learning: { ever_selected: false, finished_or_skipped: false, current: null }, non_learning_history: false,
      },
      directions: (["l1-de", "de-l1"] as const).map(direction => ({
        direction, introduced: false, progress_present: false, progress_version: null, schedule: null, interval_preview: null,
      })),
    },
    card_actions: { exclude: false, return: false, relearn: false },
  };
}

/** Both directions in ordinary reviews; options are consistent with local_date 2026-10-07. */
export function reviewing(view = cardView()): DictionaryCardView {
  view.study.facts.learning = { ever_selected: true, finished_or_skipped: true, current: null };
  const terms: Record<DictionaryStudyDirection["direction"], { interval_days: number; next_due_date: string }> = {
    "l1-de": { interval_days: 3, next_due_date: "2026-10-10" }, "de-l1": { interval_days: 8, next_due_date: "2026-10-15" } };
  view.study.directions.forEach(direction => Object.assign(direction, {
    introduced: true, progress_present: true, progress_version: "2", schedule: terms[direction.direction],
    interval_preview: direction.direction === "l1-de" ? [{ step_id: 1, interval_days: 9, next_due_date: "2026-10-16" }] : [],
  }));
  view.card_actions = { exclude: true, return: false, relearn: true };
  return view;
}

export function excluded(view = reviewing()): DictionaryCardView {
  view.study.facts.exclusion = { excluded: true, version: "3" };
  Object.assign(view.study.directions[0], { schedule: null, interval_preview: null });
  view.card_actions = { exclude: false, return: true, relearn: false };
  return view;
}

export const response = (current: DictionaryCardView | { status: "unavailable" }, state_version = "5"): DictionaryCardViewResponse =>
  ({ state_version, current });

const example = (n: number, role: CardExample["role"], text = `Satz ${n}.`): CardExample =>
  ({ id: `00000000-0000-4000-8000-${String(800 + n).padStart(12, "0")}`, text, role, highlighted_parts: [] });
export const direction = example(1, "wechsel_direction", "Ich gehe in die Stadt.");
export const location = example(2, "wechsel_location", "Ich bin in der Stadt.");
export const general = example(3, "general", "Die Stadt ist groß.");

/** A two-case preposition (in) with both common wechsel examples and the pair key the view requires. */
export function preposition(own: { akkusativ: string | null; dativ: string | null } = { akkusativ: null, dativ: null }): DictionaryCardView {
  const view = cardView();
  view.content.card = { ...view.content.card, lemma: "in", type: "preposition" };
  view.study.card_type = "preposition";
  view.content.grammar = { category: { id: "00000000-0000-4000-8000-000000000a01", name: "Wechselpräposition" },
    cases: [{ id: "00000000-0000-4000-8000-000000000a02", name: "Akkusativ" }, { id: "00000000-0000-4000-8000-000000000a03", name: "Dativ" }] };
  const editor = { akkusativ: { value: own.akkusativ, version: "2" }, dativ: { value: own.dativ, version: "2" } };
  const full = own.akkusativ !== null && own.dativ !== null;
  view.content.examples = { common: [direction, general, location], personal: null, preposition_pair: { editor,
    effective: full ? { source: "personal", akkusativ: { value: own.akkusativ!, version: "2" }, dativ: { value: own.dativ!, version: "2" } }
      : { source: "common", akkusativ: direction, dativ: location } } };
  return view;
}
