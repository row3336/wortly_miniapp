import type { Language } from "./language";

const messages = {
  uk: {
    loading: "Відкриваємо Wortly",
    loadingDetail: "Зачекай трохи.",
    // Wording approved by the owner (R10, 08.10.2026); display conditions follow TA. Check after DOCUMENT_STALE (Б4.3.1).
    updating: "Оновлюємо Wortly",
    pending: "Заявку надіслано",
    pendingDetail: "Коли доступ буде схвалено, відкрий Wortly знову через бота.",
    rejected: "Доступ поки не надано",
    rejectedDetail: "Ти можеш подати заявку ще раз.",
    // Wording approved by the owner (R10, 08.10.2026); display conditions follow TA.
    // Reapplication closed after two refusals (CT §6.3).
    // The contact form waits for answer 4.4-Б3.3, so nothing here mentions a contact.
    rejectedClosed: "Доступ не надано",
    rejectedClosedDetail: "Подати заявку ще раз уже не можна.",
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
    // M-COMPAT-HDR (working copy, labelled until G05)
    incompatible: "Потрібно оновити Wortly",
    incompatibleDetail: "Ця версія застосунку застаріла й не може надсилати нові дії. Закрий Wortly і відкрий його знову через бота.",
    maintenance: "Триває планове оновлення",
    maintenanceDetail: "Зараз нові дії не приймаються. Спробуй ще раз трохи пізніше.",
    maintenanceWaitSeconds: "Приблизне очікування — близько {n} с.",
    maintenanceWaitMinutes: "Приблизне очікування — близько {n} хв.",
    maintenanceOver: "Оновлення ще триває, орієнтовний час уже минув.",
    commandMaintenance: "Триває планове оновлення, нові дії зараз не приймаються. Пізніше перевір стан надсилання.",
    commandIncompatible: "Потрібно оновити застосунок: ця версія не може надсилати нові дії. Закрий Wortly і відкрий знову через бота.",
    // WORKING TEXT (P03 §4.8, §4.12 ВР-8 [ПРЕДЛ, DEV-14]; M-P03-9): the neutral line of a window closed for good, never
    // «replaced»; to be shown to the owner.
    closedWindow: "Це вікно більше не активне",
    closedWindowDetail: "Відкрий Wortly знову через бота.",
  },
  en: {
    loading: "Opening Wortly",
    loadingDetail: "Please wait a moment.",
    // Wording approved by the owner (R10, 08.10.2026); display conditions follow TA. Check after DOCUMENT_STALE (Б4.3.1).
    updating: "Updating Wortly",
    pending: "Request sent",
    pendingDetail: "Once access is approved, open Wortly again from the bot.",
    rejected: "Access is not available yet",
    rejectedDetail: "You can apply again.",
    rejectedClosed: "Access was not granted",
    rejectedClosedDetail: "You can no longer apply again.",
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
    // M-COMPAT-HDR (working copy, labelled until G05)
    incompatible: "Wortly needs an update",
    incompatibleDetail: "This version of the app is out of date and cannot send new actions. Close Wortly and open it again from the bot.",
    maintenance: "A planned update is in progress",
    maintenanceDetail: "New actions are not accepted right now. Please try again a little later.",
    maintenanceWaitSeconds: "Estimated wait: about {n} s.",
    maintenanceWaitMinutes: "Estimated wait: about {n} min.",
    maintenanceOver: "The update is still in progress; the estimated time has passed.",
    commandMaintenance: "A planned update is in progress and new actions are not accepted. Check the sending status later.",
    commandIncompatible: "The app needs an update: this version cannot send new actions. Close Wortly and open it again from the bot.",
    // WORKING TEXT (P03 §4.8, §4.12 ВР-8 [ПРЕДЛ, DEV-14]; M-P03-9).
    closedWindow: "This window is no longer active",
    closedWindowDetail: "Open Wortly again from the bot.",
  },
  ru: {
    loading: "Открываем Wortly",
    loadingDetail: "Подожди немного.",
    // Wording approved by the owner (R10, 08.10.2026); display conditions follow TA. Check after DOCUMENT_STALE (Б4.3.1).
    updating: "Обновляем Wortly",
    pending: "Заявка отправлена",
    pendingDetail: "Когда доступ одобрят, открой Wortly снова через бота.",
    rejected: "Доступ пока не предоставлен",
    rejectedDetail: "Ты можешь подать заявку ещё раз.",
    rejectedClosed: "Доступ не предоставлен",
    rejectedClosedDetail: "Подать заявку ещё раз уже нельзя.",
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
    // M-COMPAT-HDR (working copy, labelled until G05)
    incompatible: "Нужно обновить Wortly",
    incompatibleDetail: "Эта версия приложения устарела и не может отправлять новые действия. Закрой Wortly и открой его снова через бота.",
    maintenance: "Идёт плановое обновление",
    maintenanceDetail: "Сейчас новые действия не принимаются. Попробуй ещё раз чуть позже.",
    maintenanceWaitSeconds: "Примерное ожидание — около {n} с.",
    maintenanceWaitMinutes: "Примерное ожидание — около {n} мин.",
    maintenanceOver: "Обновление ещё идёт, ожидаемое время уже прошло.",
    commandMaintenance: "Идёт плановое обновление, новые действия сейчас не принимаются. Позже проверь состояние отправки.",
    commandIncompatible: "Нужно обновить приложение: эта версия не может отправлять новые действия. Закрой Wortly и открой снова через бота.",
    // WORKING TEXT (P03 §4.8, §4.12 ВР-8 [ПРЕДЛ, DEV-14]; M-P03-9).
    closedWindow: "Это окно больше не активно",
    closedWindowDetail: "Открой Wortly снова через бота.",
  },
} as const;

export function t(language: Language) {
  return messages[language];
}

/** The planned-pause wait line. A zero or missing estimate gets no number: the server only says the time has passed. */
export function maintenanceWait(language: Language, waitSeconds: number | null | undefined): string | null {
  if (waitSeconds === null || waitSeconds === undefined) return null;
  const copy = messages[language];
  if (waitSeconds === 0) return copy.maintenanceOver;
  return waitSeconds >= 60
    ? copy.maintenanceWaitMinutes.replace("{n}", String(Math.ceil(waitSeconds / 60)))
    : copy.maintenanceWaitSeconds.replace("{n}", String(waitSeconds));
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
