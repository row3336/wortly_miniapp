import type { Language } from "./language";

const messages = {
  uk: {
    loading: "Відкриваємо Wortly",
    loadingDetail: "Зачекай трохи.",
    pending: "Заявку надіслано",
    pendingDetail: "Коли доступ буде схвалено, відкрий Wortly знову через бота.",
    rejected: "Доступ поки не надано",
    rejectedDetail: "Ти можеш подати заявку ще раз.",
    reapply: "Подати заявку ще раз",
    unavailable: "Не вдалося відкрити Wortly",
    unavailableDetail: "Спробуй відкрити застосунок пізніше.",
    retry: "Спробувати ще раз",
    busy: "Wortly вже відкрито",
    busyDetail: "Повернися до іншого відкритого вікна або пристрою.",
    opened: "Вхід підтверджено",
    openedDetail: "Продовження поки недоступне.",
    expired: "Потрібно знову підтвердити вхід",
    expiredDetail: "Закрий застосунок і знову натисни кнопку Wortly в боті.",
  },
  en: {
    loading: "Opening Wortly",
    loadingDetail: "Please wait a moment.",
    pending: "Request sent",
    pendingDetail: "Once access is approved, open Wortly again from the bot.",
    rejected: "Access is not available yet",
    rejectedDetail: "You can apply again.",
    reapply: "Apply again",
    unavailable: "Wortly could not open",
    unavailableDetail: "Please try opening the app later.",
    retry: "Try again",
    busy: "Wortly is already open",
    busyDetail: "Return to the other open window or device.",
    opened: "Sign-in confirmed",
    openedDetail: "You cannot continue yet.",
    expired: "Please confirm sign-in again",
    expiredDetail: "Close the app and tap the Wortly button in the bot again.",
  },
  ru: {
    loading: "Открываем Wortly",
    loadingDetail: "Подожди немного.",
    pending: "Заявка отправлена",
    pendingDetail: "Когда доступ одобрят, открой Wortly снова через бота.",
    rejected: "Доступ пока не предоставлен",
    rejectedDetail: "Ты можешь подать заявку ещё раз.",
    reapply: "Подать заявку ещё раз",
    unavailable: "Не удалось открыть Wortly",
    unavailableDetail: "Попробуй открыть приложение позже.",
    retry: "Попробовать ещё раз",
    busy: "Wortly уже открыт",
    busyDetail: "Вернись в другое открытое окно или на другое устройство.",
    opened: "Вход подтверждён",
    openedDetail: "Продолжить пока нельзя.",
    expired: "Нужно снова подтвердить вход",
    expiredDetail: "Закрой приложение и снова нажми кнопку Wortly в боте.",
  },
} as const;

export function t(language: Language) {
  return messages[language];
}

/** Pair ids of the contract; the pair belongs to the dictionary, never to the UI language. */
export type DictionaryPair = "ru-de" | "uk-de" | "en-de";
export type StudyDirection = "l1-de" | "de-l1";

// Direction abbreviations by UI language (И04, TA:168). The specification names no abbreviation for English as the
// source language of the en-de pair: that label stays absent until the owner chooses one.
const languageAbbreviations: Record<Language, Partial<Record<"ru" | "uk" | "en" | "de", string>>> = {
  ru: { ru: "Рус", uk: "Укр", de: "Нем" },
  uk: { ru: "Рос", uk: "Укр", de: "Нім" },
  en: { ru: "Ru", uk: "Uk", de: "De" },
};

/** «Рус → Нем»: spelled in the UI language, languages taken from the dictionary pair; null when no abbreviation exists. */
export function directionLabel(language: Language, pair: DictionaryPair, direction: StudyDirection): string | null {
  const names = languageAbbreviations[language];
  const source = names[pair.slice(0, 2) as "ru" | "uk" | "en"], german = names.de;
  if (!source || !german) return null;
  return direction === "l1-de" ? `${source} → ${german}` : `${german} → ${source}`;
}

// Working copy for G05: section names repeat TodayScreen and SettingsScreen; placeholder lines are not specified texts.
const navigationMessages = {
  ru: { navigation: "Основная навигация", today: "Сегодня", dictionary: "Словарь", settings: "Настройки",
    statistics: "Статистика", back: "Назад", placeholder: "Этот раздел ещё в работе." },
  uk: { navigation: "Основна навігація", today: "Сьогодні", dictionary: "Словник", settings: "Налаштування",
    statistics: "Статистика", back: "Назад", placeholder: "Цей розділ ще в роботі." },
  en: { navigation: "Main navigation", today: "Today", dictionary: "Dictionary", settings: "Settings",
    statistics: "Statistics", back: "Back", placeholder: "This section is still in progress." },
} as const;

export function navigationText(language: Language) {
  return navigationMessages[language];
}

/** Symbol ids of the accepted icon family И1 «Мягкий контур» (public/icons/i1-symbols.svg). */
export const iconNames = ["home", "book", "quiz", "learn", "search", "filter", "back", "next", "edit", "save", "cancel",
  "replace", "undo", "help", "audio", "dice", "eye", "hide", "calendar", "history", "settings", "flag", "trash", "exit",
  "success", "error", "loading", "more"] as const;
export type IconName = (typeof iconNames)[number];

// Working copy for G05: names of the icons for the screen reader (TA §2); final icons and wording come with G05.
const iconLabels: Record<Language, Record<IconName, string>> = {
  ru: { home: "Главная", book: "Словарь", quiz: "Квиз", learn: "Изучение", search: "Поиск", filter: "Фильтр", back: "Назад",
    next: "Далее", edit: "Изменить", save: "Сохранить", cancel: "Отмена", replace: "Заменить", undo: "Шаг назад",
    help: "Справка", audio: "Прослушать", dice: "Случайный выбор", eye: "Показать", hide: "Скрыть", calendar: "Календарь",
    history: "История", settings: "Настройки", flag: "Сообщить о проблеме", trash: "Удалить", exit: "Выйти",
    success: "Верно", error: "Ошибка", loading: "Загрузка", more: "Ещё" },
  uk: { home: "Головна", book: "Словник", quiz: "Квіз", learn: "Вивчення", search: "Пошук", filter: "Фільтр", back: "Назад",
    next: "Далі", edit: "Змінити", save: "Зберегти", cancel: "Скасувати", replace: "Замінити", undo: "Крок назад",
    help: "Довідка", audio: "Прослухати", dice: "Випадковий вибір", eye: "Показати", hide: "Сховати", calendar: "Календар",
    history: "Історія", settings: "Налаштування", flag: "Повідомити про проблему", trash: "Видалити", exit: "Вийти",
    success: "Правильно", error: "Помилка", loading: "Завантаження", more: "Ще" },
  en: { home: "Home", book: "Dictionary", quiz: "Quiz", learn: "Learning", search: "Search", filter: "Filter", back: "Back",
    next: "Next", edit: "Edit", save: "Save", cancel: "Cancel", replace: "Replace", undo: "Step back",
    help: "Help", audio: "Listen", dice: "Random pick", eye: "Show", hide: "Hide", calendar: "Calendar",
    history: "History", settings: "Settings", flag: "Report a problem", trash: "Delete", exit: "Exit",
    success: "Correct", error: "Error", loading: "Loading", more: "More" },
};

export function iconLabel(language: Language, name: IconName): string {
  return iconLabels[language][name];
}
