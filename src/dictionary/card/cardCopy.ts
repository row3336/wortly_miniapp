import type { Language } from "../../i18n/language";
import type { StudyDirection } from "../../i18n/messages";

// root decision, pending owner (M-CARD Р8): working copy for G05. The study statuses and actions are the wording of
// RA table 6.1.10; the uk/en texts and the direction fallback are working translations.
const copy = {
  ru: { screen: "Карточка", loading: "Загружаем карточку…", failed: "Не удалось загрузить карточку", retry: "Повторить",
    unavailable: "Карточка недоступна", examples: "Примеры", personalExample: "Личный пример", missing: "Не заполнено",
    study: "Изучение", queued: "В очереди на изучение", add: "Добавить в обучение", manual: "В следующей группе слов",
    remove: "Убрать из следующей группы", learning: "Изучается", interval: "Интервал", days: (n: number) => `${n} дн.`,
    next: "Следующий повтор", writtenOff: "Основные письменные повторы выключены", limit: "Предел достигнут",
    saving: "Сохраняем…", manualFailed: "Не удалось изменить обучение", manualUnknown: "Изменение не подтверждено",
    forward: "Перевод → немецкий", reverse: "Немецкий → перевод" },
  uk: { screen: "Картка", loading: "Завантажуємо картку…", failed: "Не вдалося завантажити картку", retry: "Повторити",
    unavailable: "Картка недоступна", examples: "Приклади", personalExample: "Особистий приклад", missing: "Не заповнено",
    study: "Вивчення", queued: "У черзі на вивчення", add: "Додати до навчання", manual: "У наступній групі слів",
    remove: "Прибрати з наступної групи", learning: "Вивчається", interval: "Інтервал", days: (n: number) => `${n} дн.`,
    next: "Наступне повторення", writtenOff: "Основні письмові повторення вимкнено", limit: "Межу досягнуто",
    saving: "Зберігаємо…", manualFailed: "Не вдалося змінити навчання", manualUnknown: "Зміну не підтверджено",
    forward: "Переклад → німецька", reverse: "Німецька → переклад" },
  en: { screen: "Card", loading: "Loading the card…", failed: "Could not load the card", retry: "Retry",
    unavailable: "Card unavailable", examples: "Examples", personalExample: "Personal example", missing: "Not filled in",
    study: "Study", queued: "Queued for learning", add: "Add to learning", manual: "In the next word group",
    remove: "Remove from the next group", learning: "Learning", interval: "Interval", days: (n: number) => `${n} d`,
    next: "Next review", writtenOff: "Main written reviews are off", limit: "Limit reached",
    saving: "Saving…", manualFailed: "Could not change learning", manualUnknown: "Change not confirmed",
    forward: "Translation → German", reverse: "German → translation" },
} as const;

export type CardText = (typeof copy)[Language];

export function cardText(language: Language): CardText {
  return copy[language];
}

/** Fallback when the UI language has no abbreviation for the dictionary language (messages.directionLabel). */
export function directionFallback(t: CardText, direction: StudyDirection): string {
  return direction === "l1-de" ? t.forward : t.reverse;
}
