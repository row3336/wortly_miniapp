import type { CardExamples, DictionaryCardContent } from "../api/generated";
import { exactKeys, oneOf, record, sameId, uuid, version } from "../api/wireValidation";

const states = ["applicable", "not_applicable", "unknown"];
const pronouns = ["ich", "du", "er_sie_es", "wir", "ihr", "sie_sie"];
const formFields: Record<string, string[]> = { noun: ["gender", "singular", "plural"],
  verb: ["infinitive", "preterite", "participle_ii", "auxiliary"], adjective: ["positive", "comparative", "superlative"] };
const nullableText = (value: unknown) => value === null || typeof value === "string";
const personal = (value: unknown) => value === null || record(value) && exactKeys(value, ["value", "version"])
  && typeof value.value === "string" && version(value.version);
const term = (value: unknown) => record(value) && exactKeys(value, ["id", "name"]) && uuid(value.id) && typeof value.name === "string";

function grammar(value: unknown, kind: string): boolean {
  if (value === null) return true;
  if (!record(value)) return false;
  const fields = formFields[kind];
  if (fields) {
    const extra = kind === "noun" ? ["article_status"] : kind === "verb" ? ["separability"] : [];
    if (!exactKeys(value, [...fields.flatMap(field => [field, `${field}_status`]), ...extra])) return false;
    if (!fields.every(field => nullableText(value[field]) && oneOf(value[`${field}_status`], states)
      && (value[`${field}_status`] !== "not_applicable" || value[field] === null))) return false;
    if (kind === "noun") return (value.gender === null || oneOf(value.gender, ["masculine", "feminine", "neuter"]))
      && oneOf(value.article_status, states) && (value.article_status !== "not_applicable" || value.gender === null);
    if (kind === "verb") return (value.auxiliary === null || oneOf(value.auxiliary, ["haben", "sein"]))
      && oneOf(value.separability, ["separable", "inseparable", "unknown"]);
    return true;
  }
  if (kind === "preposition") return exactKeys(value, ["category", "cases"]) && term(value.category)
    && Array.isArray(value.cases) && value.cases.every(term);
  if (kind === "conjunction") return exactKeys(value, ["meaning_category", "verb_position"])
    && term(value.meaning_category) && term(value.verb_position);
  return false;
}
function conjugations(value: unknown, kind: string): boolean {
  if (!Array.isArray(value) || kind !== "verb" && value.length > 0) return false;
  const seen = new Set<string>();
  return value.every(row => {
    if (!record(row) || !exactKeys(row, ["tense", "forms"]) || !oneOf(row.tense, ["present", "preterite"])
      || seen.has(row.tense as string) || !Array.isArray(row.forms) || row.forms.length !== pronouns.length) return false;
    seen.add(row.tense as string);
    return row.forms.every((form, index) => record(form) && exactKeys(form, ["pronoun_group", "value", "status"])
      && form.pronoun_group === pronouns[index] && nullableText(form.value) && oneOf(form.status, states)
      && (form.status !== "not_applicable" || form.value === null));
  });
}
function json(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") { if (!Number.isFinite(item)) return false; }
    else if (Array.isArray(item)) { for (const child of item) pending.push(child); }
    else if (record(item)) { for (const child of Object.values(item)) pending.push(child); }
    else return false;
  }
  return true;
}

/** One example per wechsel role is a storage invariant (examples_one_wechsel_role_idx); a duplicate is a corrupted
 * snapshot and is rejected here, so the display code never meets it. */
function singleWechselRoles(common: readonly { role: unknown }[]): boolean {
  return ["wechsel_location", "wechsel_direction"].every(role => common.filter(example => example.role === role).length <= 1);
}

/** Frozen candidates shared by preview and answered detail. This does not select what to display. */
export function validCardExamples(value: unknown): value is CardExamples {
  return record(value) && exactKeys(value, ["common", "personal"]) && personal(value.personal)
    && Array.isArray(value.common) && value.common.every(example => record(example)
      && exactKeys(example, ["id", "text", "role", "highlighted_parts"]) && uuid(example.id) && typeof example.text === "string"
      && (example.role === null || oneOf(example.role, ["general", "wechsel_location", "wechsel_direction"]))
      && Array.isArray(example.highlighted_parts) && json(example.highlighted_parts))
    && singleWechselRoles(value.common);
}

/** Public reference content only. Common and personal examples stay distinct; no display policy here. */
export function validReferenceCardContent(value: unknown, cardId: string, pair: string): value is DictionaryCardContent {
  if (!record(value) || !exactKeys(value, ["pair", "card", "translations", "grammar", "reference_conjugations", "examples", "association", "hint"])
    || value.pair !== pair || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"]) || !record(value.card)) return false;
  const card = value.card, translations = value.translations;
  if (!exactKeys(card, ["id", "revision", "lemma", "type", "cefr"]) || !sameId(card.id, cardId) || !version(card.revision)
    || typeof card.lemma !== "string" || !oneOf(card.type, ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"])
    || !(card.cefr === null || oneOf(card.cefr, ["A1", "A2", "B1", "B2", "C1", "C2"]))) return false;
  return record(translations) && exactKeys(translations, ["common", "personal"]) && Array.isArray(translations.common)
    && translations.common.every(item => typeof item === "string") && personal(translations.personal)
    && grammar(value.grammar, card.type as string) && conjugations(value.reference_conjugations, card.type as string)
    && validCardExamples(value.examples)
    && personal(value.association) && personal(value.hint);
}
