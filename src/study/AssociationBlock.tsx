import type { ReactNode } from "react";
import type { PersonalCardText } from "../api/generated";
import type { Language } from "../i18n/language";
import "./referenceCard.css";

/**
 * Working copy for the owner (R12-07, R12-08 вар.2): the texts are shown to the owner for approval, none is approved yet.
 * «own» is the heading of the hint after a mistake; «plain» is the card, the introduction and the oral question.
 */
export const associationCopy = {
  ru: { plain: "Ассоциация", own: "Твоя ассоциация", invite: "Своей ассоциации пока нет. Добавь её — так слово легче вспомнить.", add: "Добавить ассоциацию" },
  uk: { plain: "Асоціація", own: "Твоя асоціація", invite: "Своєї асоціації поки немає. Додай її — так слово легше згадати.", add: "Додати асоціацію" },
  en: { plain: "Association", own: "Your association", invite: "You have no association of your own yet. Add one to make the word easier to recall.", add: "Add association" },
} as const;

export type AssociationInvite = { onAdd(): void } | "text";
type Props = {
  /** `null` and a blank text mean the learner has none of their own; the caller omits the block when the core sent no key at all. */
  association: PersonalCardText | null;
  /** Interface language: the heading, the invitation and the button. */
  language: Language;
  /** The language of the association's text (L1 of the pair); when the caller does not know it, no `lang` is set. */
  textLanguage?: string;
  /** «own» after a mistake; the plain heading everywhere else. */
  heading?: "plain" | "own";
  /** Without it an empty association renders nothing: the screen has no way to invite. «text» is the line alone, no button. */
  invite?: AssociationInvite;
  /** М12 only: the own-field control of the card editor, placed under the text. */
  children?: ReactNode;
};

/** The learner's own association, or, when empty, the invitation to add one. Shared by the card, the introduction and the quizzes. */
export function AssociationBlock({ association, language, textLanguage, heading = "plain", invite, children }: Props) {
  const t = associationCopy[language], title = heading === "own" ? t.own : t.plain;
  const text = association?.value.trim() ? association.value : null;
  if (text === null && invite === undefined) return null;
  return <section className="reference-association" aria-label={title}>
    <h3>{title}</h3>
    {text !== null ? <p lang={textLanguage}>{text}</p>
      : <p className="reference-missing" lang={language}>{t.invite}</p>}
    {text === null && invite !== undefined && invite !== "text"
      && <button type="button" className="reference-association-add" onClick={invite.onAdd}>{t.add}</button>}
    {children}
  </section>;
}
