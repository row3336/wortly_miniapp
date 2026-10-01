import type { ConjunctionHint } from "../api/generated";
import { exactKeys, record } from "../api/wireValidation";

export function validConjunctionHint(value: unknown): value is ConjunctionHint | null {
  return value === null || record(value) && exactKeys(value, ["meaning_category", "verb_position"])
    && (value.meaning_category === null || typeof value.meaning_category === "string")
    && (value.verb_position === null || typeof value.verb_position === "string");
}
