import type { WrittenSummary as Summary } from "../api/generated";
import type { Language } from "../i18n/language";

export type WrittenSummaryProps = {
  summary: Summary;
  /** completed: the queue ran out; interrupted: the user stopped the session. */
  outcome: "completed" | "interrupted";
  language: Language;
  canToday: boolean;
  onToday(): void;
};
const copy = {
  ru: { title: "Итог занятия", completed: "Занятие завершено.", interrupted: "Занятие прервано.", done: "Пройдено", right: "Верно",
    errors: "Ошибки", percent: "Процент", today: "На Сегодня" },
  uk: { title: "Підсумок заняття", completed: "Заняття завершено.", interrupted: "Заняття перервано.", done: "Пройдено", right: "Правильно",
    errors: "Помилки", percent: "Відсоток", today: "На Сьогодні" },
  en: { title: "Session summary", completed: "The session is complete.", interrupted: "The session was interrupted.", done: "Completed",
    right: "Correct", errors: "Errors", percent: "Percentage", today: "Return to Today" },
} as const;
const locales = { ru: "ru-RU", uk: "uk-UA", en: "en-US" } as const;

/** Д02 renders only confirmed server numbers: no answers is «—», never 0 % (В06.3); drills never add cards. */
export function WrittenSummary({ summary, outcome, language, canToday, onToday }: WrittenSummaryProps) {
  const t = copy[language], ratio = summary.ratio;
  const percent = ratio === null || ratio.denominator === 0 ? "—"
    : new Intl.NumberFormat(locales[language], { style: "percent", maximumFractionDigits: 0 }).format(ratio.numerator / ratio.denominator);
  return <section className="written-summary" aria-label={t.title}>
    <h2>{t.title}</h2>
    <p role="status">{outcome === "completed" ? t.completed : t.interrupted}</p>
    <dl>
      <div><dt>{t.done}</dt><dd>{summary.completed}</dd></div>
      <div><dt>{t.right}</dt><dd>{summary.correct}</dd></div>
      <div><dt>{t.errors}</dt><dd>{summary.wrong}</dd></div>
      <div><dt>{t.percent}</dt><dd>{percent}</dd></div>
    </dl>
    <button type="button" disabled={!canToday} onClick={() => { if (canToday) onToday(); }}>{t.today}</button>
  </section>;
}
