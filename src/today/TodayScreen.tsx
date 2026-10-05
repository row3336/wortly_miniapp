import { useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TodayResponse } from "../api/generated";
import type { Language } from "../i18n/language";
import type { TodayState } from "./todayController";
import "./today.css";

export type OrdinaryQuiz = { material: "words" | "phrases"; direction: "l1-de" | "de-l1" };
type Navigation = "today" | "dictionary" | "settings" | "statistics";

export type TodayScreenProps = {
  state: TodayState;
  language: Language;
  onRetry: () => void;
  notice?: ReactNode;
  /** The host owns command_id and must reconcile its outcome before remounting after a rejected start. */
  onStartQuiz?: (quiz: OrdinaryQuiz) => void | Promise<void>;
  /** Per-row availability of onStartQuiz; without it every ready row with a handler is available. */
  canStartQuiz?: (quiz: OrdinaryQuiz) => boolean;
  onOpenLearning?: () => void | Promise<void>;
  onStartConjugation?: () => void | Promise<void>;
  onOpenConjugations?: () => void;
  onNavigate?: (destination: Navigation) => void;
  enabledDestinations?: readonly Navigation[];
};

const copy = {
  ru: {
    today: "Сегодня", next: "Следующий шаг", loading: "Загружаем план на сегодня",
    failed: "Не удалось загрузить план", expired: "Не удалось подтвердить доступ. Открой Wortly снова через бота.", startUnconfirmed: "Не удалось подтвердить запуск занятия", retry: "Повторить", busy: "Занятие открыто на другом устройстве",
    allDone: "На сегодня всё", waiting: "Learning ждёт следующего этапа",
    work: "Доступные занятия", setup: "Настрой обучение", noMaterial: "Пока нет доступного материала",
    learning: "Learning", learningReady: "Продолжить изучение", learningPreview: "Ознакомление со словами",
    newGroup: "Новая группа слов", learningComplete: "Текущая группа завершена",
    learningNoMaterial: "Нет слов для новой группы", learningSetup: "Выбери материал в настройках",
    nextStage: "Следующий этап", reviews: "Интервальные повторы", reviewsDone: "Повторы на сегодня выполнены",
    reviewsEmpty: "Нет готовых повторов", readyReviews: "Готово к повтору",
    wordsTo: "Слова: перевод на немецкий", wordsFrom: "Слова: перевод с немецкого",
    phrasesTo: "Фразы: перевод на немецкий", phrasesFrom: "Фразы: перевод с немецкого",
    words: "слов", phrases: "фраз", base: "В базе", total: "всего", due: "Ближайший повтор",
    conjugations: "Спряжения", conjugationsReady: "Готово", conjugationsOpenable: "Доступно", conjugationQuiz: "Тест спряжений", conjugationPractice: "Открыть спряжения",
    dictionary: "Словарь", settings: "Настройки", statistics: "Статистика", nav: "Основная навигация",
    pair: "Активная пара", refreshing: "Обновляем план", ruPair: "Русский ↔ Немецкий", ukPair: "Украинский ↔ Немецкий", enPair: "Английский ↔ Немецкий",
  },
  uk: {
    today: "Сьогодні", next: "Наступний крок", loading: "Завантажуємо план на сьогодні",
    failed: "Не вдалося завантажити план", expired: "Не вдалося підтвердити доступ. Відкрий Wortly знову через бота.", startUnconfirmed: "Не вдалося підтвердити запуск заняття", retry: "Спробувати ще раз", busy: "Заняття відкрито на іншому пристрої",
    allDone: "На сьогодні все", waiting: "Learning чекає наступного етапу",
    work: "Доступні заняття", setup: "Налаштуй навчання", noMaterial: "Поки немає доступного матеріалу",
    learning: "Learning", learningReady: "Продовжити вивчення", learningPreview: "Ознайомлення зі словами",
    newGroup: "Нова група слів", learningComplete: "Поточну групу завершено",
    learningNoMaterial: "Немає слів для нової групи", learningSetup: "Обери матеріал у налаштуваннях",
    nextStage: "Наступний етап", reviews: "Інтервальні повторення", reviewsDone: "Повторення на сьогодні виконано",
    reviewsEmpty: "Немає готових повторень", readyReviews: "Готово до повторення",
    wordsTo: "Слова: переклад німецькою", wordsFrom: "Слова: переклад з німецької",
    phrasesTo: "Фрази: переклад німецькою", phrasesFrom: "Фрази: переклад з німецької",
    words: "слів", phrases: "фраз", base: "У базі", total: "усього", due: "Найближче повторення",
    conjugations: "Відмінювання", conjugationsReady: "Готово", conjugationsOpenable: "Доступно", conjugationQuiz: "Тест відмінювання", conjugationPractice: "Відкрити відмінювання",
    dictionary: "Словник", settings: "Налаштування", statistics: "Статистика", nav: "Основна навігація",
    pair: "Активна пара", refreshing: "Оновлюємо план", ruPair: "Російська ↔ Німецька", ukPair: "Українська ↔ Німецька", enPair: "Англійська ↔ Німецька",
  },
  en: {
    today: "Today", next: "Next up", loading: "Loading today's plan",
    failed: "Could not load your plan", expired: "Could not confirm access. Open Wortly again from the bot.", startUnconfirmed: "Could not confirm that the session started", retry: "Try again", busy: "A session is open on another device",
    allDone: "All done for today", waiting: "Learning is waiting for the next stage",
    work: "Available sessions", setup: "Set up your learning", noMaterial: "No material is available yet",
    learning: "Learning", learningReady: "Continue learning", learningPreview: "Preview words",
    newGroup: "New word group", learningComplete: "Current group complete",
    learningNoMaterial: "No words for a new group", learningSetup: "Choose material in settings",
    nextStage: "Next stage", reviews: "Spaced reviews", reviewsDone: "Today's reviews are complete",
    reviewsEmpty: "No reviews are ready", readyReviews: "Ready to review",
    wordsTo: "Words: translate into German", wordsFrom: "Words: translate from German",
    phrasesTo: "Phrases: translate into German", phrasesFrom: "Phrases: translate from German",
    words: "words", phrases: "phrases", base: "In your collection", total: "total", due: "Next review",
    conjugations: "Conjugations", conjugationsReady: "Ready", conjugationsOpenable: "Available", conjugationQuiz: "Conjugation quiz", conjugationPractice: "Open conjugations",
    dictionary: "Dictionary", settings: "Settings", statistics: "Statistics", nav: "Main navigation",
    pair: "Active pair", refreshing: "Refreshing plan", ruPair: "Russian ↔ German", ukPair: "Ukrainian ↔ German", enPair: "English ↔ German",
  },
} as const;

function formatDate(value: string | null, language: Language, kind: "date" | "time" = "date"): string | null {
  if (!value) return null;
  const parsed = new Date(kind === "date" ? `${value}T12:00:00` : value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat(language === "uk" ? "uk-UA" : language === "ru" ? "ru-RU" : "en-US",
    kind === "date" ? { year: "numeric", month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(parsed);
}

function summary(data: TodayResponse, language: Language): string {
  const t = copy[language];
  switch (data.status) {
    case "work_now": return t.work;
    case "learning_waiting": return t.waiting;
    case "setup_required": return t.setup;
    case "no_material": return t.noMaterial;
    case "all_done": return t.allDone;
  }
}

export function TodayScreen(props: TodayScreenProps) {
  const t = copy[props.language];
  const canNavigate = (destination: Navigation) => !!props.onNavigate
    && (!props.enabledDestinations || props.enabledDestinations.includes(destination));
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState(false);
  const actionInFlight = useRef(false);

  async function once(action?: () => void | Promise<void>) {
    if (!action || actionInFlight.current || actionError) return;
    actionInFlight.current = true;
    setStarting(true);
    try { await action(); } catch {
      // The host must reconcile the saved command_id before it remounts this screen.
      setActionError(true);
    } finally {
      actionInFlight.current = false;
      setStarting(false);
    }
  }

  const data = props.state.kind === "ready" ? props.state.data : null;
  const learning = data?.learning;
  const learningAvailable = learning?.status === "preview" || learning?.status === "ready" || learning?.status === "new_group";
  const learningCount = learning?.status === "preview" ? learning.preview
    : learning?.status === "ready" ? learning.ready : learning?.new_group_size;
  const learningTitle = learning?.status === "preview" ? t.learningPreview
    : learning?.status === "ready" ? t.learningReady
      : learning?.status === "new_group" ? t.newGroup
        : learning?.status === "waiting" ? t.waiting
          : learning?.status === "setup_required" ? t.learningSetup
            : learning?.status === "no_material" ? t.learningNoMaterial : t.learningComplete;
  const quizRows: { key: string; material: OrdinaryQuiz["material"]; direction: OrdinaryQuiz["direction"]; title: string; count: number }[] = data ? [
    { key: "wordsTo", material: "words", direction: "l1-de", title: t.wordsTo, count: data.ordinary.words["l1-de"].ready },
    { key: "wordsFrom", material: "words", direction: "de-l1", title: t.wordsFrom, count: data.ordinary.words["de-l1"].ready },
    { key: "phrasesTo", material: "phrases", direction: "l1-de", title: t.phrasesTo, count: data.ordinary.phrases["l1-de"].ready },
    { key: "phrasesFrom", material: "phrases", direction: "de-l1", title: t.phrasesFrom, count: data.ordinary.phrases["de-l1"].ready },
  ] : [];

  if (actionError) return <main className="today-screen">
    <header className="today-header"><h1>{t.today}</h1></header>
    <section className="today-status" role="alert"><p>{t.startUnconfirmed}</p></section>
  </main>;

  return <main className="today-screen">
    <header className="today-header">
      <h1>{t.today}</h1>
      {data && <button type="button" className="today-text-action" disabled={!canNavigate("statistics")} onClick={() => props.onNavigate?.("statistics")}>{t.statistics}</button>}
    </header>
    {props.notice}
    {data ? <>
      <section className="today-summary" aria-label={t.next}>
        <p className="today-small">{t.pair}: {data.pair === "ru-de" ? t.ruPair : data.pair === "uk-de" ? t.ukPair : t.enPair}</p>
        <h2>{summary(data, props.language)}</h2>
        {data.next_repeat_date && <p className="today-muted">{t.due}: {formatDate(data.next_repeat_date, props.language)}</p>}
        {props.state.kind === "ready" && props.state.refreshing && <p className="today-small" role="status">{t.refreshing}</p>}
      </section>
      <div className="today-sections">
        <section className="today-card" aria-labelledby="today-learning-heading">
          <h2 id="today-learning-heading">{t.learning}</h2>
          {learningAvailable ? <button type="button" className="today-card-action" disabled={starting || !props.onOpenLearning}
            onClick={() => { void once(props.onOpenLearning); }}>
            <span>{learningTitle}</span><strong>{learningCount}</strong>
          </button> : <p>{learningTitle}</p>}
          {learning?.status === "waiting" && learning.next_due_at &&
            <p className="today-small">{t.nextStage}: {formatDate(learning.next_due_at, props.language, "time")}</p>}
        </section>
        <section className="today-card" aria-labelledby="today-reviews-heading">
          <h2 id="today-reviews-heading">{t.reviews}</h2>
          {data.ordinary_status === "done" && <p>{data.status === "all_done" ? t.reviewsDone : t.reviewsEmpty}</p>}
          <p className="today-small today-count-heading">{t.readyReviews}</p>
          <div className="today-counts">
            {quizRows.map((row) => row.count > 0 ? <button type="button" className="today-quiz-row" key={row.key}
              disabled={starting || !props.onStartQuiz || props.canStartQuiz?.({ material: row.material, direction: row.direction }) === false}
              onClick={() => { void once(() => props.onStartQuiz?.({ material: row.material, direction: row.direction })); }}>
              <span>{row.title}</span><strong>{row.count}</strong>
            </button> : <div className="today-quiz-row today-quiz-inert" key={row.key}>
              <span>{row.title}</span><strong>{row.count}</strong>
            </div>)}
          </div>
        </section>
        <section className="today-card today-base" aria-labelledby="today-base-heading">
          <h2 id="today-base-heading">{t.base}</h2>
          <p><strong>{data.base.total}</strong> {t.total} · {data.base.words} {t.words} · {data.base.phrases} {t.phrases}</p>
        </section>
        <section className="today-card" aria-labelledby="today-conjugation-heading">
          <h2 id="today-conjugation-heading">{t.conjugations}</h2>
          <p className="today-small">{t.conjugationsReady}: {data.conjugation.ready} · {t.conjugationsOpenable}: {data.conjugation.openable}</p>
          {data.conjugation.ready > 0 && <button type="button" className="today-card-action" disabled={starting || !props.onStartConjugation}
            onClick={() => { void once(props.onStartConjugation); }}><span>{t.conjugationQuiz}</span><strong>{data.conjugation.ready}</strong></button>}
          {data.conjugation.openable > 0 && <button type="button" className="today-card-action"
            disabled={!props.onOpenConjugations} onClick={props.onOpenConjugations}>{t.conjugationPractice}<span aria-hidden="true">›</span></button>}
          {data.conjugation.next_due_date && <p className="today-small">{t.due}: {formatDate(data.conjugation.next_due_date, props.language)}</p>}
        </section>
      </div>
      <nav className="today-nav" aria-label={t.nav}>
        <button type="button" aria-current="page" disabled={!canNavigate("today")} onClick={() => props.onNavigate?.("today")}>{t.today}</button>
        <button type="button" disabled={!canNavigate("dictionary")} onClick={() => props.onNavigate?.("dictionary")}>{t.dictionary}</button>
        <button type="button" disabled={!canNavigate("settings")} onClick={() => props.onNavigate?.("settings")}>{t.settings}</button>
      </nav>
    </> : <section className="today-status" role="status" aria-busy={props.state.kind === "loading"}>
      {props.state.kind === "loading" && <svg className="today-loader" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="11" fill="var(--line)" />
        <circle cx="12" cy="12" r="8" fill="none" stroke="var(--muted)" strokeWidth="2" />
        <circle className="today-loader-arc" cx="12" cy="12" r="8" fill="none" stroke="var(--text)" strokeWidth="3" pathLength="100" />
      </svg>}
      <p>{props.state.kind === "loading" ? t.loading : props.state.kind === "busy" ? t.busy
        : props.state.kind === "failed" && props.state.reason === "expired" ? t.expired : t.failed}</p>
      {props.state.kind === "failed" && props.state.reason !== "expired" && <button type="button" className="today-retry" onClick={props.onRetry}>{t.retry}</button>}
    </section>}
  </main>;
}
