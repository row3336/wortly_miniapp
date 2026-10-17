import type { Language } from "../i18n/language";

/**
 * The texts of a notice (project notices ed.2.4 §6) — ONLY those already approved in the canon; every line names its
 * source (file:line, under /Users/wf/ai_wf/sessions/active/889_wortly/). Where the canon has no approved text the entry is
 * null and marked «нет утверждённого текста»: the screen then shows nothing in its place; nothing here is invented.
 *
 * The summary labels and the buttons are not here: they are the existing copy of the summary screens of the product
 * (written/WrittenSummary.tsx, i18n/messages.ts), reused as they are.
 *
 * «Знаем и работаем» (R2-05, second half of the answer) has no text and no mechanism: defect_class is always null
 * (Д1; CON §6.1 п.9, contracts.md:261) and the phrase is never shown (S-P04; tz_app.md:235).
 */
export type NoticeLines = {
  /**
   * answer_loss closed by save_failed: row 9.2.7 of the catalogue R10, all three languages approved —
   * questions/answers_claude_round2_20261008.md:189 (approval :38, :117; tz_app.md:235; contracts.md:261).
   */
  saveFailed: string;
  /**
   * answer_loss closed by the person's own Stop: R2-05 вар.1 —
   * development/Wortly_cont_core_bot_tg_app/questions_Wortly_cont_core_bot_tg_app/questions_round2_2026-10-12.md:84
   * (owner's answer :88). Approved in ru only; uk/en: нет утверждённого текста («затем утвердить точные ru/uk/en строки», :84).
   */
  stopClosed: string | null;
  stopLost: string | null;
};

export const noticeLines: Record<Language, NoticeLines> = {
  ru: {
    // answers_claude_round2_20261008.md:189 (ru)
    saveFailed: "Не удалось сохранить последнее действие. Занятие завершено. Ранее сохранённый прогресс не потерян.",
    // questions_round2_2026-10-12.md:84
    stopClosed: "Занятие завершено.",
    // questions_round2_2026-10-12.md:84
    stopLost: "Последний ответ не сохранился. Остальные ответы сохранены.",
  },
  uk: {
    // answers_claude_round2_20261008.md:189 (uk)
    saveFailed: "Не вдалося зберегти останню дію. Заняття завершено. Раніше збережений прогрес не втрачено.",
    // нет утверждённого текста (R2-05: только ru, questions_round2_2026-10-12.md:84)
    stopClosed: null,
    // нет утверждённого текста (R2-05: только ru, questions_round2_2026-10-12.md:84)
    stopLost: null,
  },
  en: {
    // answers_claude_round2_20261008.md:189 (en)
    saveFailed: "We couldn't save your last action. The session has ended. Your earlier progress is safe.",
    // нет утверждённого текста (R2-05: только ru, questions_round2_2026-10-12.md:84)
    stopClosed: null,
    // нет утверждённого текста (R2-05: только ru, questions_round2_2026-10-12.md:84)
    stopLost: null,
  },
};
