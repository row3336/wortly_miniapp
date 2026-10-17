import type { ConjugationSummary, ConjugationSummaryBlock } from "../api/generated";
import type { Language } from "../i18n/language";
import type { CloseReason } from "./conjugationDocumentController";
import { NoticeShown } from "../notices/NoticeShown";

export type ConjugationSummaryViewProps = {
  /** null = the frozen summary is not known (closed without a read); never shown as zeros. */
  summary: ConjugationSummary | null;
  /** Omitted for the live summary phase; null = closed for an unknown reason. */
  closedReason?: CloseReason | null;
  language: Language;
  /** Today: summary_home in the summary phase, navigation only when closed; null = not allowed now. */
  onHome: (() => void) | null;
  /** answer_loss of this closed session in the open window (project notices §6): its lines in place of the reason line. */
  noticeLines?: string[] | null;
  /** That notice's id, named once this summary is drawn (c.screen(notice_shown)). */
  noticeId?: string | null;
};

// Working copy for G05: the owner fixes final wording. Grade words repeat the written result labels.
const copy = {
  ru: { title: "Итог спряжений", completed: "Завершённые блоки", partial: "Незавершённые блоки", error: "С ошибкой",
    grades: ["Трудно", "Нормально", "Легко"], forms: (n: number) => `отвечено форм: ${n} из 6`,
    answers: (c: number, r: number, w: number) => `Ответов в этом занятии: ${c} (верно ${r}, ошибок ${w})`,
    none: "В этом занятии ответов нет", legacyCompleted: (n: number) => `Завершено блоков: ${n}`,
    legacyPartial: (n: number, f: number) => `Незавершённых блоков: ${n}, отвечено в них форм: ${f}`,
    noBlocks: "Подробности по блокам недоступны", unavailable: "Подробности итога недоступны", home: "На Сегодня",
    reasons: { stop: "Занятие завершено", summary_home: "Занятие завершено", remote_stop: "Занятие завершено на другом устройстве",
      midnight: "Занятие закрыто: начался новый день", timezone_date_changed: "Занятие закрыто: сменилась дата",
      pair_changed: "Занятие закрыто: изменилась языковая пара" }, closed: "Занятие закрыто" },
  uk: { title: "Підсумок дієвідмін", completed: "Завершені блоки", partial: "Незавершені блоки", error: "З помилкою",
    grades: ["Важко", "Нормально", "Легко"], forms: (n: number) => `форм із відповіддю: ${n} із 6`,
    answers: (c: number, r: number, w: number) => `Відповідей у цьому занятті: ${c} (правильно ${r}, помилок ${w})`,
    none: "У цьому занятті відповідей немає", legacyCompleted: (n: number) => `Завершено блоків: ${n}`,
    legacyPartial: (n: number, f: number) => `Незавершених блоків: ${n}, форм із відповіддю в них: ${f}`,
    noBlocks: "Подробиці за блоками недоступні", unavailable: "Подробиці підсумку недоступні", home: "На Сьогодні",
    reasons: { stop: "Заняття завершено", summary_home: "Заняття завершено", remote_stop: "Заняття завершено на іншому пристрої",
      midnight: "Заняття закрито: почався новий день", timezone_date_changed: "Заняття закрито: змінилася дата",
      pair_changed: "Заняття закрито: змінилася мовна пара" }, closed: "Заняття закрито" },
  en: { title: "Conjugation summary", completed: "Completed blocks", partial: "Unfinished blocks", error: "With a mistake",
    grades: ["Hard", "Normal", "Easy"], forms: (n: number) => `forms answered: ${n} of 6`,
    answers: (c: number, r: number, w: number) => `Answers in this session: ${c} (correct ${r}, mistakes ${w})`,
    none: "No answers in this session", legacyCompleted: (n: number) => `Completed blocks: ${n}`,
    legacyPartial: (n: number, f: number) => `Unfinished blocks: ${n}, forms answered in them: ${f}`,
    noBlocks: "Block details are unavailable", unavailable: "Summary details are unavailable", home: "To Today",
    reasons: { stop: "The session has ended", summary_home: "The session has ended", remote_stop: "The session was ended on another device",
      midnight: "The session was closed: a new day began", timezone_date_changed: "The session was closed: the date changed",
      pair_changed: "The session was closed: the language pair changed" }, closed: "The session was closed" },
} as const;
// Part names stay German in every interface language (table 6.1.7).
const tenses = { present: "Präsens", preterite: "Präteritum" } as const;

function BlockLabel({ block }: { block: ConjugationSummaryBlock }) {
  return <><span lang="de">{block.base_lemma}</span>{" · "}<span lang="de">{tenses[block.tense]}</span></>;
}

/** М17 working presentation (T3B_PRESENTATION_HANDOFF §1 A/B/C): only server facts, grouped, never sorted or recomputed. */
export function ConjugationSummaryView({ summary, closedReason, language, onHome, noticeLines, noticeId }: ConjugationSummaryViewProps) {
  const t = copy[language];
  // save_failed has no entry in t.reasons yet (owner question N4.4): it falls back to the generic closed text.
  const reasons: Partial<Record<CloseReason, string>> = t.reasons;
  const reason = closedReason === undefined ? null : closedReason === null ? t.closed : reasons[closedReason] ?? t.closed;
  let body;
  if (summary === null) body = <p>{t.unavailable}</p>;
  else if (summary.blocks !== null) {
    // Grouping keeps the server order inside each group; 3/6 is never a block.
    const completed = summary.blocks.filter(block => block.answered_groups.length === 6);
    const partial = summary.blocks.filter(block => block.answered_groups.length < 6);
    body = <>
      {completed.length > 0 && <section aria-label={t.completed}><h3>{t.completed}</h3><ul>
        {completed.map(block => <li key={block.cycle_id}><BlockLabel block={block} />{" — "}
          {block.effect === "success" && block.grade !== null && block.grade >= 3 ? t.grades[block.grade - 3] : t.error}</li>)}
      </ul></section>}
      {/* The outcome of an unfinished block (Q1) is not shown. */}
      {partial.length > 0 && <section aria-label={t.partial}><h3>{t.partial}</h3><ul>
        {partial.map(block => <li key={block.cycle_id}><BlockLabel block={block} />{" — "}{t.forms(block.answered_groups.length)}</li>)}
      </ul></section>}
      <p>{summary.completed === 0 ? t.none : t.answers(summary.completed, summary.correct, summary.wrong)}</p>
    </>;
  } else if (summary.completed_cycle_ids.length > 0 || summary.partial.length > 0 || summary.results.length > 0 || summary.completed > 0) {
    // L1: a reliable legacy summary without block labels.
    const forms = summary.partial.reduce((total, block) => total + block.answered_groups.length, 0);
    body = <>
      <p>{t.legacyCompleted(summary.completed_cycle_ids.length)}</p>
      <p>{t.legacyPartial(summary.partial.length, forms)}</p>
      <p>{t.answers(summary.completed, summary.correct, summary.wrong)}</p>
      <p>{t.noBlocks}</p>
    </>;
  } else body = <p>{t.unavailable}</p>; // L0: indistinguishable from the synthetic zero, so nothing is claimed.
  return <section aria-label={t.title}>
    {noticeId && <NoticeShown noticeId={noticeId} />}
    {noticeLines && noticeLines.length > 0
      ? noticeLines.map((line, index) => <p key={index} role={index === 0 ? "status" : undefined}>{line}</p>)
      : reason && <p role="status">{reason}</p>}
    <h2>{t.title}</h2>
    {body}
    <button type="button" className="learning-previous" disabled={!onHome} onClick={() => onHome?.()}>{t.home}</button>
  </section>;
}
