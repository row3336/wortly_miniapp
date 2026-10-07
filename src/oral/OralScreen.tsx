import { useEffect, useLayoutEffect, useRef } from "react";
import { commandCopy } from "../commands/commandCopy";
import type { Language } from "../i18n/language";
import type { OralDocumentSnapshot } from "./oralDocumentController";
import { oralRefineCardId } from "./oralRefine";
import type { OralDocumentActions } from "./useOralDocument";
import "./oral.css";

export type OralScreenProps = {
  state: OralDocumentSnapshot | null;
  actions: OralDocumentActions;
  language: Language;
  /** The host sets this only for the currently displayed route. */
  active: boolean;
  /** Leaves the summary of this owner's own Stop for Today; navigation belongs to the host. */
  onToday(): void;
  /** «Уточнить поля»: opens the question's card (М12) on top of the quiz; without it the button is absent. */
  onRefineFields?(cardId: string, assignmentId: string): void;
};

const copy = {
  ru: { title: "Устное занятие", exit: "Выйти", reveal: "Раскрыть", correct: "Правильно", wrong: "Неправильно",
    question: "Задание", translation: "Перевод", meaning: "Значение союза", verb: "Позиция глагола",
    loading: "Загружаем занятие…", idle: "Занятие ещё не началось.", remember: "Вспомни перевод.",
    present: "Подтверждаем показ задания…", grade: "Оцени свой ответ.", saving: "Сохраняем действие…",
    unknown: "Действие ещё не подтверждено. Проверь состояние.", stale: "Не удалось обновить занятие. Проверь состояние.",
    stopping: "Завершаем занятие…", closed: "Занятие завершено.", disposed: "Занятие недоступно в этом окне.",
    inactive: "Занятие сейчас не активно.", summary: "Итог занятия", completed: "Пройдено", right: "Верно", errors: "Ошибки",
    remaining: "Осталось", today: "На Сегодня", refresh: commandCopy.ru.check, retryStudy: "Повторить действие",
    retryStop: commandCopy.ru.retryStop, recovery: "Проверка состояния", pendingStudy: "Учебное действие ещё не подтверждено.",
    pendingStop: "Завершение ещё не подтверждено.", cleanup: "Не удалось обновить данные на этом устройстве. Проверь состояние.",
    blocked: "Действие нельзя повторить. Проверь состояние занятия.", refine: "Уточнить поля" },
  uk: { title: "Усне заняття", exit: "Вийти", reveal: "Розкрити", correct: "Правильно", wrong: "Неправильно",
    question: "Завдання", translation: "Переклад", meaning: "Значення сполучника", verb: "Позиція дієслова",
    loading: "Завантажуємо заняття…", idle: "Заняття ще не почалося.", remember: "Згадай переклад.",
    present: "Підтверджуємо показ завдання…", grade: "Оціни свою відповідь.", saving: "Зберігаємо дію…",
    unknown: "Дію ще не підтверджено. Перевір стан.", stale: "Не вдалося оновити заняття. Перевір стан.",
    stopping: "Завершуємо заняття…", closed: "Заняття завершено.", disposed: "Заняття недоступне в цьому вікні.",
    inactive: "Заняття зараз не активне.", summary: "Підсумок заняття", completed: "Пройдено", right: "Правильно", errors: "Помилки",
    remaining: "Залишилося", today: "На Сьогодні", refresh: commandCopy.uk.check, retryStudy: "Повторити дію",
    retryStop: commandCopy.uk.retryStop, recovery: "Перевірка стану", pendingStudy: "Навчальну дію ще не підтверджено.",
    pendingStop: "Завершення ще не підтверджено.", cleanup: "Не вдалося оновити дані на цьому пристрої. Перевір стан.",
    blocked: "Дію не можна повторити. Перевір стан заняття.", refine: "Уточнити поля" },
  en: { title: "Oral practice", exit: "Exit", reveal: "Reveal", correct: "Correct", wrong: "Incorrect",
    question: "Question", translation: "Translation", meaning: "Conjunction meaning", verb: "Verb position",
    loading: "Loading your session…", idle: "The session has not started yet.", remember: "Recall the translation.",
    present: "Confirming the displayed question…", grade: "Assess your answer.", saving: "Saving the action…",
    unknown: "The action is not confirmed yet. Check status.", stale: "Could not refresh the session. Check status.",
    stopping: "Ending the session…", closed: "The session has ended.", disposed: "This session is unavailable in this window.",
    inactive: "This session is not active right now.", summary: "Session summary", completed: "Completed", right: "Correct", errors: "Errors",
    remaining: "Remaining", today: "Return to Today", refresh: commandCopy.en.check, retryStudy: "Retry action",
    retryStop: commandCopy.en.retryStop, recovery: "Status check", pendingStudy: "The study action is not confirmed yet.",
    pendingStop: "Ending the session is not confirmed yet.", cleanup: "Could not update data on this device. Check status.",
    blocked: "This action cannot be retried. Check session status.", refine: "Refine fields" },
} as const;

/** A detached renderer: accepted state and command identity belong exclusively to the owner. */
export function OralScreen({ state, actions, language, active, onToday, onRefineFields }: OralScreenProps) {
  const t = copy[language], promptElement = useRef<HTMLParagraphElement>(null);
  const assignment = state?.current?.status === "active" ? state.current.assignment : null;
  const ticket = state?.presentationTicket ?? null;
  useLayoutEffect(() => {
    const element = promptElement.current;
    if (!active || !ticket || !element || assignment?.status !== "prefetched") return;
    let cancelled = false;
    // This confirms a visible DOM commit, not that a person physically looked at it.
    queueMicrotask(() => {
      if (cancelled || document.visibilityState !== "visible" || !element.isConnected
        || promptElement.current !== element) return;
      void actions.shown(ticket);
    });
    return () => { cancelled = true; };
  }, [active, ticket, assignment?.id, assignment?.status, actions]);

  const lanes = state ? [state.commands.study, state.commands.stop] : [];
  const saving = state?.commands.study.phase === "sending";
  const phase = state?.phase ?? "loading";
  // Server facts of this owner's own Stop, or of a closure whose reason is not known yet; any other reason
  // keeps the plain closed line.
  const closed = active && phase === "closed" && state?.closed
    && (state.closed.reason === "stop" || state.closed.reason === null) ? state.closed : null;
  const waiting = closed?.summaryRead === "pending" || closed?.summaryRead === "reading";
  const readFailed = closed?.summaryRead === "failed";
  const closedSummary = closed?.summaryRead === "known" && closed.reason === "stop" ? closed : null;
  const unread = closed?.summaryRead === "pending" ? closed.sessionId.toLowerCase() : null;
  const requested = useRef(new Set<string>());
  useEffect(() => {
    // One GET status check per closed session; after a failure only the explicit check retries.
    if (!unread || requested.current.has(unread)) return;
    requested.current.add(unread);
    void actions.refresh();
  }, [unread, actions]);

  const status = !active ? t.inactive : phase === "disposed" ? t.disposed : phase === "closed" ? readFailed ? t.stale : t.closed
    : phase === "stopping" ? t.stopping : phase === "visible_unconfirmed" ? t.present : saving ? t.saving : phase === "loading" ? t.loading
    : phase === "idle" ? t.idle : phase === "unknown" ? t.unknown : phase === "stale" ? t.stale
    : phase === "prefetched" ? t.present
    : phase === "question" ? t.remember : phase === "revealed" ? t.grade : null;
  const localProblem = state?.problem === "storage" || lanes.some(lane => lane.problem === "storage");
  const blocked = lanes.some(lane => lane.problem === "mismatch" || lane.problem === "invalid_pending" || lane.problem === "pending_changed");
  const problem = localProblem ? t.cleanup : blocked ? t.blocked : state?.problem ? t.stale : null;
  const summary = state?.current?.status === "summary" ? state.current.summary : closedSummary?.summary ?? null;
  const progress = closedSummary ? closedSummary.progress : state?.current?.progress;
  const remaining = progress ? progress.total - progress.completed : null;
  const usable = active && !!state && phase !== "disposed";
  const refreshBusy = lanes.some(lane => lane.phase === "loading" || lane.phase === "checking");
  const showRecovery = usable && (phase === "unknown" || phase === "stale" || phase === "closed"
    || !!problem || lanes.some(lane => lane.pending) || state!.canRetry.study || state!.canRetry.stop);
  const allowed = (capability: boolean | undefined) => usable && capability === true;
  const toToday = closedSummary !== null || allowed(state?.canSummaryHome);
  const refineCard = active && phase !== "disposed" ? oralRefineCardId(state) : null;

  // Waiting for the summary of the own Stop looks like the application start, never like a zero result.
  if (waiting) return <main className="app-shell" lang={language} aria-busy="true">
    <div role="status" aria-label={t.summary}>
      <svg className="wortly-loader" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="11" fill="var(--line)" />
        <circle cx="12" cy="12" r="8" fill="none" stroke="var(--muted)" strokeWidth="2" />
        <circle className="wortly-loader-arc" cx="12" cy="12" r="8" fill="none" stroke="var(--text)" strokeWidth="3" pathLength="100" />
      </svg>
    </div>
  </main>;

  return <main className="oral-screen" lang={language} aria-label={t.title}>
    <header className="oral-header"><h1>{t.title}</h1>
      {phase !== "closed" && phase !== "disposed" && <button type="button" disabled={!allowed(state?.canStop)}
        onClick={() => { if (allowed(state?.canStop)) void actions.stop("stop"); }}>{t.exit}</button>}
    </header>
    <p role="status" aria-live="polite">{status}</p>
    {assignment && <section className="oral-question" aria-label={t.question}>
      <p ref={promptElement} className="oral-prompt" lang="de">{assignment.prompt.text}</p>
      {assignment.prompt.conjunction_hint && <dl className="oral-hint">
        {assignment.prompt.conjunction_hint.meaning_category !== null && <div><dt>{t.meaning}</dt><dd>{assignment.prompt.conjunction_hint.meaning_category}</dd></div>}
        {assignment.prompt.conjunction_hint.verb_position !== null && <div><dt>{t.verb}</dt><dd>{assignment.prompt.conjunction_hint.verb_position}</dd></div>}
      </dl>}
      {assignment.revealed ? <>
        <section className="oral-translation" aria-label={t.translation} lang={state!.current!.pair.split("-")[0]}>
          {assignment.translations.map((translation, index) => <p key={index}>{translation}</p>)}
        </section>
        <div className="oral-grade">
          <button type="button" className="oral-correct" disabled={!allowed(state?.canGrade)}
            onClick={() => { if (allowed(state?.canGrade)) void actions.grade(true); }}>{t.correct}</button>
          <button type="button" className="oral-wrong" disabled={!allowed(state?.canGrade)}
            onClick={() => { if (allowed(state?.canGrade)) void actions.grade(false); }}>{t.wrong}</button>
        </div>
      </> : <button type="button" className="oral-reveal" disabled={!allowed(state?.canReveal)}
        onClick={() => { if (allowed(state?.canReveal)) void actions.reveal(); }}>{t.reveal}</button>}
      {refineCard !== null && onRefineFields && <button type="button" className="oral-refine"
        onClick={() => onRefineFields(refineCard, assignment.id)}>{t.refine}</button>}
    </section>}
    {summary && <section className="oral-summary" aria-label={t.summary}>
      <h2>{t.summary}</h2>
      <dl><div><dt>{t.completed}</dt><dd>{summary.completed}</dd></div><div><dt>{t.right}</dt><dd>{summary.correct}</dd></div>
        <div><dt>{t.errors}</dt><dd>{summary.wrong}</dd></div>{remaining !== null && <div><dt>{t.remaining}</dt><dd>{remaining}</dd></div>}</dl>
      <button type="button" disabled={!toToday}
        onClick={() => { if (closedSummary) onToday(); else if (allowed(state?.canSummaryHome)) void actions.stop("summary_home"); }}>{t.today}</button>
    </section>}
    {problem && <p role="status">{problem}</p>}
    {showRecovery && <section className="oral-recovery" aria-label={t.recovery}>
      {state!.commands.study.pending && state!.commands.study.outcome === null && <p>{t.pendingStudy}</p>}
      {state!.commands.stop.pending && state!.commands.stop.outcome === null && <p>{t.pendingStop}</p>}
      <button type="button" disabled={refreshBusy} onClick={() => { if (usable && !refreshBusy) void actions.refresh(); }}>{t.refresh}</button>
      {state!.canRetry.study && <button type="button" onClick={() => { if (allowed(state!.canRetry.study)) void actions.retry("study"); }}>{t.retryStudy}</button>}
      {state!.canRetry.stop && <button type="button" onClick={() => { if (allowed(state!.canRetry.stop)) void actions.retry("stop"); }}>{t.retryStop}</button>}
    </section>}
  </main>;
}
