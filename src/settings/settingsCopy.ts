import type { Language } from "../i18n/language";
import type { KnownRefusal, SettingKey } from "./settingsApi";
import type { SettingsSnapshot } from "./settingsController";

type Copy = {
  title: string; today: string; dictionary: string; navigation: string;
  languages: string; learning: string; checking: string; additional: string;
  save: string; saved: string; saving: string; loading: string; refreshing: string;
  refresh: string; retry: string; unknown: string; unavailable: string;
  invalid: string; conflict: string; acceptCurrent: string; keepMine: string; current: string;
  exhausted: string; rejected: string; notSet: string; choose: string; on: string; off: string;
  level: string; topics: string; selectedTopics: string; materialHint: string;
  topicsLoading: string; topicsFailed: string; topicsRefresh: string; currentTopicsMissing: string;
  bounds: (minimum: number, maximum: number) => string;
  addInterval: string; removeInterval: string; interval: string; intervalsHint: string;
  normal: string; accelerated: string;
  reviewModes: Record<string, string>; learningContents: Record<string, string>;
  hints: Partial<Record<SettingKey, string>>;
  /** Why Mix is muted while the material is chosen by CEFR level (2.21г): locked, or still active because a value is required. */
  mixByLevel: { locked: string };
  fields: Record<SettingKey, string>;
  /** Returning the initial settings: the button, its confirmation window (Q08) and the states after confirming. */
  reset: { button: string; title: string; resets: string; kept: string; confirm: string; cancel: string;
    sending: string; done: string; failed: string; unknown: string };
  /** Known refusals (incompatible, command_refused) are worded by the screen from existing texts. */
  problems: Record<Exclude<NonNullable<SettingsSnapshot["problem"]>["reason"], KnownRefusal["refusal"]>, string>;
};

// Wording approved by the owner (R10, 08.10.2026); display conditions follow TA. Approved by R10: only mixByLevel.locked (Б4.3.31);
// every other field here is still a working copy for G05 and the owner fixes its wording. Hints follow TA:126 (Mix), TA:160 and K04-102 (strict mode),
// K04-105 (Learning content), 2.21г (Mix is not applied for a CEFR level); modes and contents are labelled by the server's enum values.
// `reset` is approved in all three languages by R10 (catalog answers_claude_round2_20261008.md table 2.3, rows Сброс-2..5 and
// Д2.1.6–Д2.1.9) with the owner's edit of the button (Сброс-1, table 3.1 there); the Ukrainian button is Codex's spelling fix
// of the owner's entry. The window title is not renamed after the button. Display conditions follow TA 12.4.
export const settingsCopy: Record<Language, Copy> = {
  ru: {
    title: "Настройки", today: "Сегодня", dictionary: "Словарь", navigation: "Основная навигация",
    languages: "Языки", learning: "Обучение", checking: "Проверка ответов", additional: "Дополнительно",
    save: "Сохранить", saved: "Сохранено", saving: "Сохраняем изменение", loading: "Загружаем настройки",
    refreshing: "Проверяем актуальные настройки", refresh: "Обновить настройки", retry: "Повторить отправку",
    unknown: "Пока не удалось подтвердить сохранение. Проверь состояние или повтори отправку.",
    unavailable: "Не удалось загрузить настройки", invalid: "Проверь значение и допустимые варианты.",
    conflict: "Сохранённое значение изменилось. Твой ввод остался.", acceptCurrent: "Принять сохранённое",
    keepMine: "Сохранить моё значение", current: "Сейчас сохранено", exhausted: "Это поле пока нельзя сохранить. Обнови настройки.",
    rejected: "Изменение не принято. Проверь значение и попробуй снова.", notSet: "Не задано", choose: "Выбери значение",
    on: "Включено", off: "Выключено", level: "Уровень", topics: "Темы учебника", selectedTopics: "Выбрано тем",
    materialHint: "Уровень или темы определяют новые слова. Изученные слова остаются в повторах.",
    topicsLoading: "Загружаем список тем", topicsFailed: "Не удалось загрузить актуальный список тем",
    topicsRefresh: "Обновить список тем", currentTopicsMissing: "Названия сохранённых тем пока недоступны. Обнови список тем.",
    bounds: (a, b) => `Целое число от ${a} до ${b}.`,
    addInterval: "Добавить интервал", removeInterval: "Удалить интервал", interval: "Интервал",
    intervalsHint: "Интервалы указаны в секундах. Порядок сохраняется; уже назначенные сроки не меняются.",
    normal: "Обычный", accelerated: "Ускоренный",
    reviewModes: { strict: "Строгий", soft: "Мягкий" },
    learningContents: { words: "Слова", phrases: "Фразы", mixed: "Слова + фразы" },
    hints: {
      review_error_mode: "Строгий: после ошибки интервалы начинаются заново, повтор завтра. Мягкий: по прежней формуле бота. Это не проверка регистра. Режим действует со следующего занятия для письменных слов, фраз и в оцениваемых спряжениях; уже назначенные даты не меняются. Устные повторы всегда мягкие, Learning идёт по своему правилу. Строгий режим можно выбрать, если слова забываются на длинных интервалах; выбор остаётся за тобой.",
      learning_content: "Состав влияет на следующий автоматический набор, а не на текущую группу. Изученное остаётся в повторах.",
      learning_mix: "Выключено: темы идут по порядку. Включено: выбранные темы смешиваются. Это не меняет выбор слов или фраз и уже начатую группу.",
    },
    mixByLevel: {
      locked: "При выборе по уровню CEFR слова берутся из уровня случайно, поэтому «Перемешивать темы» не действует. Сохранённое значение снова начнёт действовать, если выбрать темы.",
    },
    fields: {
      ui_language: "Язык интерфейса", dictionary_language: "Язык словаря", material: "Учебный материал",
      learning_group_size: "Новых карточек в группе", transition_mode: "Режим перехода",
      strict_case: "Проверять регистр букв", include_preterite: "Проверять Präteritum",
      include_comparative: "Проверять степени сравнения", learning_mix: "Перемешивать темы",
      learning_intervals_seconds: "Интервалы Learning, секунды", retry_gap: "Карточек между повторами ошибки",
      retry_count: "Повторов после ошибки",
      learning_reminder_pause_seconds: "Пауза между напоминаниями, секунды",
      review_error_mode: "Строгий режим повторов", learning_content: "Состав Learning",
    },
    reset: {
      button: "Сброс настроек", title: "Вернуть исходные настройки?",
      resets: "Сбросятся настройки Learning, повторов после ошибок, проверки ответов и перехода между карточками.",
      kept: "Языки, выбранный учебный материал и настройки напоминаний сохранятся. Текущая группа, результаты и сроки повторов не изменятся.",
      confirm: "Вернуть", cancel: "Отмена", sending: "Возвращаем исходные настройки", done: "Исходные настройки возвращены.",
      failed: "Не удалось вернуть исходные настройки. Ничего не изменилось. Попробуй ещё раз.",
      unknown: "Пока не удалось подтвердить возврат исходных настроек. Проверь состояние или повтори отправку.",
    },
    problems: {
      network: "Не удалось обновить настройки. Попробуй ещё раз.", storage: "Не удалось завершить сохранение на этом устройстве. Обнови настройки.",
      invalid_pending: "Не удалось восстановить незавершённое сохранение. Новые изменения пока недоступны.",
      pending_changed: "Данные незавершённого сохранения изменились. Обнови настройки.",
      expired: "Нужно снова подтвердить вход. Открой Wortly кнопкой в боте.",
      forbidden: "Доступ к настройкам не подтверждён. Открой Wortly снова через бота.",
      context_closed: "Этот экран больше не активен. Открой Wortly снова через бота.",
      context_refreshed: "Доступ обновился. Проверь состояние сохранения ещё раз.",
      stale_response: "Не удалось получить актуальные настройки. Обнови их.",
      client_changed: "Изменение отправлено из другого запуска приложения. Проверь его состояние.",
      profile_changed: "Профиль изменился. Открой Wortly снова через бота.",
      mismatch: "Не удалось подтвердить именно это изменение. Новые изменения пока недоступны.",
      not_found: "Подтверждение сохранения пока не найдено. Можно проверить ещё раз или повторить отправку.",
    },
  },
  uk: {
    title: "Налаштування", today: "Сьогодні", dictionary: "Словник", navigation: "Основна навігація",
    languages: "Мови", learning: "Навчання", checking: "Перевірка відповідей", additional: "Додатково",
    save: "Зберегти", saved: "Збережено", saving: "Зберігаємо зміну", loading: "Завантажуємо налаштування",
    refreshing: "Перевіряємо актуальні налаштування", refresh: "Оновити налаштування", retry: "Повторити надсилання",
    unknown: "Поки не вдалося підтвердити збереження. Перевір стан або повтори надсилання.",
    unavailable: "Не вдалося завантажити налаштування", invalid: "Перевір значення й доступні варіанти.",
    conflict: "Збережене значення змінилося. Твоє введення залишилося.", acceptCurrent: "Прийняти збережене",
    keepMine: "Зберегти моє значення", current: "Зараз збережено", exhausted: "Це поле поки не можна зберегти. Онови налаштування.",
    rejected: "Зміну не прийнято. Перевір значення й спробуй ще раз.", notSet: "Не задано", choose: "Обери значення",
    on: "Увімкнено", off: "Вимкнено", level: "Рівень", topics: "Теми підручника", selectedTopics: "Обрано тем",
    materialHint: "Рівень або теми визначають нові слова. Вивчені слова залишаються в повтореннях.",
    topicsLoading: "Завантажуємо список тем", topicsFailed: "Не вдалося завантажити актуальний список тем",
    topicsRefresh: "Оновити список тем", currentTopicsMissing: "Назви збережених тем поки недоступні. Онови список тем.",
    bounds: (a, b) => `Ціле число від ${a} до ${b}.`,
    addInterval: "Додати інтервал", removeInterval: "Видалити інтервал", interval: "Інтервал",
    intervalsHint: "Інтервали вказано в секундах. Порядок зберігається; уже призначені строки не змінюються.",
    normal: "Звичайний", accelerated: "Прискорений",
    reviewModes: { strict: "Суворий", soft: "М’який" },
    learningContents: { words: "Слова", phrases: "Фрази", mixed: "Слова + фрази" },
    hints: {
      review_error_mode: "Суворий: після помилки інтервали починаються заново, повтор завтра. М’який: за колишньою формулою бота. Це не перевірка регістру. Режим діє з наступного заняття для письмових слів, фраз і в оцінюваних дієвідмінах; уже призначені дати не змінюються. Усні повторення завжди м’які, Learning іде за власним правилом. Суворий режим можна вибрати, якщо слова забуваються на довгих інтервалах; вибір залишається за тобою.",
      learning_content: "Склад впливає на наступний автоматичний набір, а не на поточну групу. Вивчене залишається в повтореннях.",
      learning_mix: "Вимкнено: теми йдуть по порядку. Увімкнено: вибрані теми змішуються. Це не змінює вибір слів чи фраз і вже розпочату групу.",
    },
    mixByLevel: {
      locked: "Під час вибору за рівнем CEFR слова беруться з рівня випадково, тому «Перемішувати теми» не діє. Збережене значення знову почне діяти, якщо вибрати теми.",
    },
    fields: {
      ui_language: "Мова інтерфейсу", dictionary_language: "Мова словника", material: "Навчальний матеріал",
      learning_group_size: "Нових карток у групі", transition_mode: "Режим переходу",
      strict_case: "Перевіряти регістр літер", include_preterite: "Перевіряти Präteritum",
      include_comparative: "Перевіряти ступені порівняння", learning_mix: "Перемішувати теми",
      learning_intervals_seconds: "Інтервали Learning, секунди", retry_gap: "Карток між повтореннями помилки",
      retry_count: "Повторень після помилки",
      learning_reminder_pause_seconds: "Пауза між нагадуваннями, секунди",
      review_error_mode: "Суворий режим повторень", learning_content: "Склад Learning",
    },
    reset: {
      button: "Скидання налаштувань", title: "Повернути початкові налаштування?",
      resets: "Скинуться налаштування Learning, повторень після помилок, перевірки відповідей і переходу між картками.",
      kept: "Мови, вибраний навчальний матеріал і налаштування нагадувань збережуться. Поточна група, результати й терміни повторень не зміняться.",
      confirm: "Повернути", cancel: "Скасувати", sending: "Повертаємо початкові налаштування", done: "Початкові налаштування повернуто.",
      failed: "Не вдалося повернути початкові налаштування. Нічого не змінилося. Спробуй ще раз.",
      unknown: "Поки не вдалося підтвердити повернення початкових налаштувань. Перевір стан або повтори надсилання.",
    },
    problems: {
      network: "Не вдалося оновити налаштування. Спробуй ще раз.", storage: "Не вдалося завершити збереження на цьому пристрої. Онови налаштування.",
      invalid_pending: "Не вдалося відновити незавершене збереження. Нові зміни поки недоступні.",
      pending_changed: "Дані незавершеного збереження змінилися. Онови налаштування.",
      expired: "Потрібно знову підтвердити вхід. Відкрий Wortly кнопкою в боті.",
      forbidden: "Доступ до налаштувань не підтверджено. Відкрий Wortly знову через бота.",
      context_closed: "Цей екран більше не активний. Відкрий Wortly знову через бота.",
      context_refreshed: "Доступ оновився. Перевір стан збереження ще раз.",
      stale_response: "Не вдалося отримати актуальні налаштування. Онови їх.",
      client_changed: "Зміну надіслано з іншого запуску застосунку. Перевір її стан.",
      profile_changed: "Профіль змінився. Відкрий Wortly знову через бота.",
      mismatch: "Не вдалося підтвердити саме цю зміну. Нові зміни поки недоступні.",
      not_found: "Підтвердження збереження поки не знайдено. Можна перевірити ще раз або повторити надсилання.",
    },
  },
  en: {
    title: "Settings", today: "Today", dictionary: "Dictionary", navigation: "Main navigation",
    languages: "Languages", learning: "Learning", checking: "Answer checking", additional: "Additional settings",
    save: "Save", saved: "Saved", saving: "Saving your change", loading: "Loading settings",
    refreshing: "Checking current settings", refresh: "Refresh settings", retry: "Retry sending",
    unknown: "Saving has not been confirmed yet. Check its status or retry sending.",
    unavailable: "Could not load settings", invalid: "Check the value and allowed options.",
    conflict: "The saved value changed. Your input has been kept.", acceptCurrent: "Use saved value",
    keepMine: "Save my value", current: "Currently saved", exhausted: "This field cannot be saved right now. Refresh settings.",
    rejected: "The change was not accepted. Check the value and try again.", notSet: "Not set", choose: "Choose a value",
    on: "On", off: "Off", level: "Level", topics: "Textbook topics", selectedTopics: "Topics selected",
    materialHint: "Level or topics determine new words. Learned words remain in reviews.",
    topicsLoading: "Loading the topic list", topicsFailed: "Could not load the current topic list",
    topicsRefresh: "Refresh topic list", currentTopicsMissing: "Saved topic names are not available yet. Refresh the topic list.",
    bounds: (a, b) => `A whole number from ${a} to ${b}.`,
    addInterval: "Add interval", removeInterval: "Remove interval", interval: "Interval",
    intervalsHint: "Intervals are in seconds. Their order is kept; existing scheduled times do not change.",
    normal: "Normal", accelerated: "Accelerated",
    reviewModes: { strict: "Strict", soft: "Soft" },
    learningContents: { words: "Words", phrases: "Phrases", mixed: "Words + phrases" },
    hints: {
      review_error_mode: "Strict: after a mistake the intervals start over, with a review tomorrow. Soft: the bot's earlier formula. This is not the letter-case check. The mode applies from the next session to written words, phrases and graded conjugations; dates already set do not change. Spoken reviews are always soft; Learning follows its own rule. You can choose strict if words are forgotten at long intervals; the choice is yours.",
      learning_content: "The content affects the next automatic set, not the current group. Learned items stay in reviews.",
      learning_mix: "Off: topics go in order. On: the selected topics are mixed. This does not change the choice of words or phrases or a group already started.",
    },
    mixByLevel: {
      locked: "When the material is chosen by CEFR level, words are picked from the level at random, so “Mix topics” has no effect. The saved value applies again if you choose topics.",
    },
    fields: {
      ui_language: "Interface language", dictionary_language: "Dictionary language", material: "Learning material",
      learning_group_size: "New cards per group", transition_mode: "Transition mode",
      strict_case: "Check letter case", include_preterite: "Check Präteritum",
      include_comparative: "Check comparison forms", learning_mix: "Mix topics",
      learning_intervals_seconds: "Learning intervals, seconds", retry_gap: "Cards between error retries",
      retry_count: "Retries after an error",
      learning_reminder_pause_seconds: "Pause between reminders, seconds",
      review_error_mode: "Strict review mode", learning_content: "Learning content",
    },
    reset: {
      button: "Restore default settings", title: "Restore default settings?",
      resets: "Learning, retries after errors, answer checking and card transition settings will be reset.",
      kept: "Languages, selected study material and reminder settings will be preserved. Your current group, results and review dates will not change.",
      confirm: "Restore", cancel: "Cancel", sending: "Restoring default settings", done: "Default settings restored.",
      failed: "Could not restore default settings. Nothing has changed. Please try again.",
      unknown: "Restoring default settings has not been confirmed yet. Check its status or retry sending.",
    },
    problems: {
      network: "Could not refresh settings. Try again.", storage: "Could not finish saving on this device. Refresh settings.",
      invalid_pending: "Could not recover an unfinished save. New changes are temporarily unavailable.",
      pending_changed: "The unfinished save data changed. Refresh settings.",
      expired: "Confirm your login again. Open Wortly using the button in the bot.",
      forbidden: "Access to settings was not confirmed. Open Wortly again from the bot.",
      context_closed: "This screen is no longer active. Open Wortly again from the bot.",
      context_refreshed: "Access was refreshed. Check the save status again.",
      stale_response: "Could not load current settings. Refresh them.",
      client_changed: "This change was sent from another app launch. Check its status.",
      profile_changed: "The profile changed. Open Wortly again from the bot.",
      mismatch: "This particular change could not be confirmed. New changes are temporarily unavailable.",
      not_found: "Save confirmation has not been found yet. Check again or retry sending.",
    },
  },
};

export const languageNames: Record<string, string> = { uk: "Українська", en: "English", ru: "Русский" };
