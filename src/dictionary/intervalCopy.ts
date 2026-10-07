import type { Language } from "../i18n/language";

// root decision, pending owner (M-INTV Р8): working copy for G05. «Увеличить интервал», «Отменить увеличение» and
// «Предел достигнут» are the wording of TA:149–151 and RA 6.1.10/6.1.12; the other texts and uk/en are working copies.
const copy = {
  ru: { open: "Увеличить интервал", title: "Увеличить интервал", slider: "Новый интервал", interval: "Интервал",
    next: "Следующий повтор", days: (n: number) => `${n} дн.`, confirm: "Увеличить", cancel: "Отмена",
    undo: "Отменить увеличение", saving: "Сохраняем…", checking: "Нет подтверждения. Проверяем…",
    unknown: "Увеличение не подтверждено", undoUnknown: "Отмена увеличения не подтверждена", retry: "Повторить",
    conflict: "Срок изменился. Проверьте новый выбор.", failed: "Не удалось увеличить интервал",
    undoFailed: "Не удалось отменить увеличение", limit: "Предел достигнут" },
  uk: { open: "Збільшити інтервал", title: "Збільшити інтервал", slider: "Новий інтервал", interval: "Інтервал",
    next: "Наступне повторення", days: (n: number) => `${n} дн.`, confirm: "Збільшити", cancel: "Скасувати",
    undo: "Скасувати збільшення", saving: "Зберігаємо…", checking: "Немає підтвердження. Перевіряємо…",
    unknown: "Збільшення не підтверджено", undoUnknown: "Скасування збільшення не підтверджено", retry: "Повторити",
    conflict: "Строк змінився. Перевірте новий вибір.", failed: "Не вдалося збільшити інтервал",
    undoFailed: "Не вдалося скасувати збільшення", limit: "Межу досягнуто" },
  en: { open: "Increase interval", title: "Increase interval", slider: "New interval", interval: "Interval",
    next: "Next review", days: (n: number) => `${n} d`, confirm: "Increase", cancel: "Cancel",
    undo: "Undo increase", saving: "Saving…", checking: "Not confirmed yet. Checking…",
    unknown: "Increase not confirmed", undoUnknown: "Undo not confirmed", retry: "Retry",
    conflict: "The schedule changed. Check the new choice.", failed: "Could not increase the interval",
    undoFailed: "Could not undo the increase", limit: "Limit reached" },
} as const;

export type IntervalText = (typeof copy)[Language];

export function intervalText(language: Language): IntervalText {
  return copy[language];
}
