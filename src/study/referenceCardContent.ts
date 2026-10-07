import type { CardExample, CardExamples, DictionaryCardContent, DictionaryViewContent, PrepositionCardExamples } from "../api/generated";
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

const caseRoles = ["akkusativ", "dativ"] as const;
/** The common example each own case role replaces (core card_content.COMMON_ROLE; pending owner). */
const commonRole = { akkusativ: "wechsel_direction", dativ: "wechsel_location" } as const;

function bothWechselRoles(common: readonly CardExample[]): boolean {
  return Object.values(commonRole).every(role => common.some(example => example.role === role));
}
/** Field by field, independent of key order. */
function sameOwnText(left: unknown, right: Record<string, unknown>): boolean {
  return record(left) && exactKeys(left, ["value", "version"]) && left.value === right.value && left.version === right.version;
}
function sameCommonExample(left: unknown, right: CardExample): boolean {
  return record(left) && exactKeys(left, ["id", "text", "role", "highlighted_parts"]) && left.id === right.id
    && left.text === right.text && left.role === right.role && sameJsonValue(left.highlighted_parts, right.highlighted_parts);
}
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((item, index) => sameJsonValue(item, right[index]));
  if (record(left) || record(right)) return record(left) && record(right) && exactKeys(left, Object.keys(right))
    && Object.keys(right).every(key => sameJsonValue(left[key], right[key]));
  return left === right;
}

/** К05-127 / К07-121 pair of a two-case preposition: roles are keys (a duplicate is unrepresentable).
 * effective is the full own pair, or both common examples — never a mix — and must agree with editor. */
function validPrepositionPair(value: unknown, common: readonly CardExample[]): boolean {
  if (!record(value) || !exactKeys(value, ["editor", "effective"]) || !bothWechselRoles(common)) return false;
  const editor = value.editor, effective = value.effective;
  if (!record(editor) || !exactKeys(editor, [...caseRoles]) || !record(effective)) return false;
  if (!caseRoles.every(role => {
    const entry = editor[role];
    // A stored role text is never blank: "" in a frozen read is damage, not an own example.
    return record(entry) && exactKeys(entry, ["value", "version"]) && version(entry.version)
      && (entry.value === null || typeof entry.value === "string" && entry.value.trim() !== "");
  })) return false;
  const full = caseRoles.every(role => (editor[role] as Record<string, unknown>).value !== null);
  if (!exactKeys(effective, ["source", ...caseRoles])) return false;
  if (effective.source === "personal") {
    return full && caseRoles.every(role => sameOwnText(effective[role], editor[role] as Record<string, unknown>));
  }
  return effective.source === "common" && !full && caseRoles.every(role => {
    const source = common.find(example => example.role === commonRole[role]);
    return source !== undefined && sameCommonExample(effective[role], source);
  });
}

/** Frozen candidates shared by preview and answered detail. This does not select what to display.
 * A two-case preposition may also carry its pair; an older snapshot of such a card has none. */
export function validCardExamples(value: unknown): value is CardExamples | PrepositionCardExamples {
  if (!record(value)) return false;
  const withPair = Object.hasOwn(value, "preposition_pair");
  return exactKeys(value, withPair ? ["common", "personal", "preposition_pair"] : ["common", "personal"])
    && personal(value.personal)
    && Array.isArray(value.common) && value.common.every(example => record(example)
      && exactKeys(example, ["id", "text", "role", "highlighted_parts"]) && uuid(example.id) && typeof example.text === "string"
      && (example.role === null || oneOf(example.role, ["general", "wechsel_location", "wechsel_direction"]))
      && Array.isArray(example.highlighted_parts) && json(example.highlighted_parts))
    && singleWechselRoles(value.common)
    && (!withPair || validPrepositionPair(value.preposition_pair, value.common as CardExample[]));
}

const contentKeys = ["pair", "card", "translations", "grammar", "reference_conjugations", "examples", "association"];
const editableFields = ["translation", "example", "association"];

/** Public reference content only. Common and personal examples stay distinct; no display policy here.
 * There is no personal hint (K07-125) and no editor versions: the card read and Learning use this. */
export function validReferenceCardContent(value: unknown, cardId: string, pair: string): value is DictionaryCardContent {
  return record(value) && exactKeys(value, contentKeys) && validContent(value, cardId, pair);
}

/** The card view's content: the same reference content plus the required expected version of
 * each own field, also when it has no value (the editor's expected_field_version). The view is a
 * current read, never a frozen one: a two-case preposition must carry its pair (the case-role versions). */
export function validDictionaryViewContent(value: unknown, cardId: string, pair: string): value is DictionaryViewContent {
  if (!record(value) || !exactKeys(value, [...contentKeys, "field_versions"])) return false;
  const versions = value.field_versions;
  return record(versions) && exactKeys(versions, editableFields) && editableFields.every(field => version(versions[field]))
    && validContent(value, cardId, pair) && pairPresentWhenTwoCase(value);
}

function pairPresentWhenTwoCase(value: Record<string, unknown>): boolean {
  const examples = value.examples as CardExamples, card = value.card as Record<string, unknown>;
  return Object.hasOwn(examples, "preposition_pair") === (card.type === "preposition" && bothWechselRoles(examples.common));
}

function validContent(value: Record<string, unknown>, cardId: string, pair: string): boolean {
  if (value.pair !== pair || !oneOf(value.pair, ["ru-de", "uk-de", "en-de"]) || !record(value.card)) return false;
  const card = value.card, translations = value.translations;
  if (!exactKeys(card, ["id", "revision", "lemma", "type", "cefr"]) || !sameId(card.id, cardId) || !version(card.revision)
    || typeof card.lemma !== "string" || !oneOf(card.type, ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"])
    || !(card.cefr === null || oneOf(card.cefr, ["A1", "A2", "B1", "B2", "C1", "C2"]))) return false;
  return record(translations) && exactKeys(translations, ["common", "personal"]) && Array.isArray(translations.common)
    && translations.common.every(item => typeof item === "string") && personal(translations.personal)
    && grammar(value.grammar, card.type as string) && conjugations(value.reference_conjugations, card.type as string)
    && validCardExamples(value.examples)
    // Only a preposition has case roles (K07-121).
    && (!Object.hasOwn(value.examples as object, "preposition_pair") || card.type === "preposition")
    && personal(value.association);
}
