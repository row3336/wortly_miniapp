import type { Language } from "../i18n/language";

/**
 * The first choice of the dictionary language (19.2-А: it is closed after that choice, for now) and its traces in
 * Settings. Wording approved by the owner: the screen ru 25.1-А, uk/en and the pair names 27.1-А (ru pair names and
 * their order follow И02), the Settings and conflict lines 28.1-А (D-PAIR-LOCK-APP TEXTS_DRAFT rows 4.2, 5.1, 6.2).
 */
type Copy = {
  title: string; question: string; proceed: string; footnote: string;
  /** Full pair names (И02), labelled in the interface language; never replaced by bare language names. */
  pairs: Record<Language, string>;
  /** After VERSION_CONFLICT or any other proof that the choice was already made elsewhere: no claim about where. */
  confirmed(pair: string): string;
  /** Caption of the read-only field in Settings once the language is chosen. */
  locked: string;
  /** DICTIONARY_LANGUAGE_LOCKED of a save in Settings. */
  lockedRefusal: string;
};

export const dictionaryChoiceCopy: Record<Language, Copy> = {
  ru: {
    title: "Язык словаря", question: "На каком языке показывать переводы слов?", proceed: "Продолжить",
    footnote: "После подтверждения язык словаря пока нельзя изменить",
    pairs: { uk: "Немецко-украинский", en: "Немецко-английский", ru: "Немецко-русский" },
    confirmed: pair => `Язык словаря уже подтверждён. Сейчас выбрано: ${pair}.`,
    locked: "Язык словаря пока нельзя изменить.",
    lockedRefusal: "Изменение не принято: язык словаря пока нельзя изменить.",
  },
  uk: {
    title: "Мова словника", question: "Якою мовою показувати переклади слів?", proceed: "Продовжити",
    footnote: "Після підтвердження мову словника поки не можна змінити",
    pairs: { uk: "Німецько-український", en: "Німецько-англійський", ru: "Німецько-російський" },
    confirmed: pair => `Мову словника вже підтверджено. Зараз обрано: ${pair}.`,
    locked: "Мову словника поки не можна змінити.",
    lockedRefusal: "Зміну не прийнято: мову словника поки не можна змінити.",
  },
  en: {
    title: "Dictionary language", question: "Which language should word translations be shown in?", proceed: "Continue",
    footnote: "After you confirm, the dictionary language can't be changed for now",
    pairs: { uk: "German–Ukrainian", en: "German–English", ru: "German–Russian" },
    confirmed: pair => `The dictionary language is already confirmed. Current choice: ${pair}.`,
    locked: "The dictionary language can't be changed for now.",
    lockedRefusal: "The change was not accepted: the dictionary language can't be changed for now.",
  },
};

/** И02: Ukrainian, English, Russian, in this order. */
export const pairOrder: readonly Language[] = ["uk", "en", "ru"];
