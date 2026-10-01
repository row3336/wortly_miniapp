import type { ConjunctionHint as Hint } from "../api/generated";
import type { Language } from "../i18n/language";

const missing = {
  ru: { category: "Категория не заполнена", position: "Положение глагола не заполнено" },
  uk: { category: "Категорію не заповнено", position: "Положення дієслова не заповнено" },
  en: { category: "Category not filled in", position: "Verb position not filled in" },
} as const;

/** Saved question context also accompanies its own result, never the next question's context. */
export function ConjunctionHint({ hint, language }: { hint: Hint | null; language: Language }) {
  if (hint === null) return null;
  const category = hint.meaning_category, position = hint.verb_position, t = missing[language];
  return <p className="written-conjunction written-hint">
    <span lang={category ? "de" : language}>{category || t.category}</span>
    {" · "}
    <span lang={position ? "de" : language}>{position || t.position}</span>
  </p>;
}
