import type { StatisticsOverviewResponse } from "../api/generated";
import type { Language } from "../i18n/language";

type BaseType = keyof StatisticsOverviewResponse["base"]["by_type"];

export type StatisticsCopy = {
  title: string; back: string; period: string; current: string; previous: string; loading: string; retry: string;
  failed: string; expired: string; stale: string; pairChanged: string;
  weekGroup: string; nowGroup: string; weekRange: (from: string, to: string) => string;
  practice: string; practiceNote: string; day: string; words: string; phrases: string;
  reverseDirection: string; reverseNote: string; reverseNone: string;
  learned: string; added: string; notStarted: string;
  base: string; baseTotal: string; baseTypes: string; types: Record<BaseType, string>;
  ready: string; readyRows: { wordsTo: string; wordsFrom: string; phrasesTo: string; phrasesFrom: string };
  results: string; resultsNote: string; lastWrong: string; streaksTitle: string; streak: (n: string) => string;
  owner: string; ownerNote: string; profile: string; ownerProfile: (n: number, id: string) => string;
};

// reverseNote/reverseDirection: working text, wording awaits owner approval (Q14).
// reverseNone: screen-reader name of the «—» cell; working text, wording awaits owner approval (формулировка на утверждении владельца).
// Working copy for G05: the layout belongs to G03 and the owner fixes the wording. Row titles repeat «Сегодня».
export const statisticsCopy: Record<Language, StatisticsCopy> = {
  ru: {
    title: "Статистика", back: "Назад", period: "Период", current: "Эта неделя", previous: "Прошлая неделя",
    loading: "Загружаем статистику", retry: "Повторить", failed: "Не удалось загрузить статистику",
    expired: "Не удалось подтвердить доступ. Открой Wortly снова через бота.",
    stale: "Получены устаревшие данные. Повтори загрузку.", pairChanged: "Пара языков изменилась. Повтори загрузку.",
    weekGroup: "За неделю", nowGroup: "Сейчас", weekRange: (from, to) => `Неделя ${from} – ${to}`,
    practice: "Практика по дням", practiceNote: "Разные карточки письменного квиза «на немецкий».",
    day: "День", words: "Слова", phrases: "Фразы",
    reverseDirection: "Немецкий → родной", reverseNote: "В письменном квизе такого направления нет, поэтому здесь «—».", reverseNone: "Нет такого направления",
    learned: "Изучено", added: "Добавлено в базу", notStarted: "Ещё не начинал",
    base: "База", baseTotal: "Всего", baseTypes: "Состав базы",
    types: { noun: "Существительные", verb: "Глаголы", phrase: "Фразы", adjective: "Прилагательные", pronoun: "Местоимения",
      adverb: "Наречия", preposition: "Предлоги", conjunction: "Союзы", particle: "Частицы" },
    ready: "Готово к повтору",
    readyRows: { wordsTo: "Слова: перевод на немецкий", wordsFrom: "Слова: перевод с немецкого",
      phrasesTo: "Фразы: перевод на немецкий", phrasesFrom: "Фразы: перевод с немецкого" },
    results: "Результаты слов", resultsNote: "Основной письменный квиз «на немецкий».",
    lastWrong: "Последний ответ неверный", streaksTitle: "Верных ответов подряд после последней ошибки",
    streak: n => `Слов с серией ${n}`,
    owner: "Показатель владельца", profile: "Профиль", ownerNote: "Карточки хотя бы с одним успешным повтором, по профилям.",
    ownerProfile: (n, id) => `Профиль ${n} · ${id}`,
  },
  uk: {
    title: "Статистика", back: "Назад", period: "Період", current: "Цей тиждень", previous: "Минулий тиждень",
    loading: "Завантажуємо статистику", retry: "Повторити", failed: "Не вдалося завантажити статистику",
    expired: "Не вдалося підтвердити доступ. Відкрий Wortly знову через бота.",
    stale: "Отримано застарілі дані. Повтори завантаження.", pairChanged: "Пару мов змінено. Повтори завантаження.",
    weekGroup: "За тиждень", nowGroup: "Зараз", weekRange: (from, to) => `Тиждень ${from} – ${to}`,
    practice: "Практика за днями", practiceNote: "Різні картки письмового квізу «німецькою».",
    day: "День", words: "Слова", phrases: "Фрази",
    reverseDirection: "Німецька → рідна", reverseNote: "У письмовому квізі такого напрямку немає, тому тут «—».", reverseNone: "Такого напрямку немає",
    learned: "Вивчено", added: "Додано до бази", notStarted: "Ще не починав",
    base: "База", baseTotal: "Усього", baseTypes: "Склад бази",
    types: { noun: "Іменники", verb: "Дієслова", phrase: "Фрази", adjective: "Прикметники", pronoun: "Займенники",
      adverb: "Прислівники", preposition: "Прийменники", conjunction: "Сполучники", particle: "Частки" },
    ready: "Готово до повторення",
    readyRows: { wordsTo: "Слова: переклад німецькою", wordsFrom: "Слова: переклад з німецької",
      phrasesTo: "Фрази: переклад німецькою", phrasesFrom: "Фрази: переклад з німецької" },
    results: "Результати слів", resultsNote: "Основний письмовий квіз «німецькою».",
    lastWrong: "Остання відповідь неправильна", streaksTitle: "Правильних відповідей поспіль після останньої помилки",
    streak: n => `Слів із серією ${n}`,
    owner: "Показник власника", profile: "Профіль", ownerNote: "Картки щонайменше з одним успішним повторенням, за профілями.",
    ownerProfile: (n, id) => `Профіль ${n} · ${id}`,
  },
  en: {
    title: "Statistics", back: "Back", period: "Period", current: "This week", previous: "Last week",
    loading: "Loading statistics", retry: "Try again", failed: "Could not load statistics",
    expired: "Could not confirm access. Open Wortly again from the bot.",
    stale: "Outdated data was received. Try again.", pairChanged: "The language pair changed. Try again.",
    weekGroup: "This period", nowGroup: "Right now", weekRange: (from, to) => `Week ${from} – ${to}`,
    practice: "Practice by day", practiceNote: "Distinct cards of the written quiz «into German».",
    day: "Day", words: "Words", phrases: "Phrases",
    reverseDirection: "German → native", reverseNote: "The written quiz has no such direction, so this shows «—».", reverseNone: "No such direction",
    learned: "Learned", added: "Added to the collection", notStarted: "Not started yet",
    base: "Collection", baseTotal: "Total", baseTypes: "Collection by type",
    types: { noun: "Nouns", verb: "Verbs", phrase: "Phrases", adjective: "Adjectives", pronoun: "Pronouns",
      adverb: "Adverbs", preposition: "Prepositions", conjunction: "Conjunctions", particle: "Particles" },
    ready: "Ready to review",
    readyRows: { wordsTo: "Words: translate into German", wordsFrom: "Words: translate from German",
      phrasesTo: "Phrases: translate into German", phrasesFrom: "Phrases: translate from German" },
    results: "Word results", resultsNote: "The main written quiz «into German».",
    lastWrong: "Last answer was wrong", streaksTitle: "Correct answers in a row since the last mistake",
    streak: n => `Words with a streak of ${n}`,
    owner: "Owner metric", profile: "Profile", ownerNote: "Cards with at least one successful review, by profile.",
    ownerProfile: (n, id) => `Profile ${n} · ${id}`,
  },
};
