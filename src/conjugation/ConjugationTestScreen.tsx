import { useEffect, useLayoutEffect, useRef } from "react";
import type { Language } from "../i18n/language";
import { WrittenAnswerInput } from "../study/WrittenAnswerInput";
import { WrittenAnswerResult } from "../study/WrittenAnswerResult";
import "../learning/learning.css";
import { ConjugationQuestionHeading } from "./ConjugationQuestionHeading";
import { conjugationWrittenQuestion } from "./conjugationQuestion";
import { ConjugationSummaryView } from "./ConjugationSummaryView";
import type { ConjugationTestFlow, ConjugationView } from "./conjugationTestFlow";

export type ConjugationTestScreenProps = {
  view: ConjugationView;
  /** Owned by its creator (host); the screen never disposes it. */
  flow: ConjugationTestFlow;
  language: Language;
  submitOnEnter: boolean;
};

// Working copy for G05.
const copy = {
  ru: { title: "Тест спряжений", stop: "Завершить", loading: "Загружаем занятие…", presenting: "Подтверждаем показ вопроса…",
    submitting: "Сохраняем ответ…", unknown: "Ответ ещё не подтверждён. Проверьте статус.", forgot: "Отправлено: «Забыл…»",
    stopping: "Завершаем занятие…", previous: "Предыдущий ответ", previousMode: "Предыдущий ответ", barrier: "Подтверждаем показ следующего вопроса…",
    recovery: "Действие ещё не подтверждено. Проверьте статус.", stale: "Не удалось обновить занятие.", refresh: "Проверить статус",
    refreshSummary: "Обновить итог", retryStudy: "Повторить действие", retryStop: "Повторить завершение" },
  uk: { title: "Тест дієвідмін", stop: "Завершити", loading: "Завантажуємо заняття…", presenting: "Підтверджуємо показ питання…",
    submitting: "Зберігаємо відповідь…", unknown: "Відповідь ще не підтверджено. Перевірте статус.", forgot: "Надіслано: «Не пам’ятаю…»",
    stopping: "Завершуємо заняття…", previous: "Попередня відповідь", previousMode: "Попередня відповідь", barrier: "Підтверджуємо показ наступного питання…",
    recovery: "Дію ще не підтверджено. Перевірте статус.", stale: "Не вдалося оновити заняття.", refresh: "Перевірити статус",
    refreshSummary: "Оновити підсумок", retryStudy: "Повторити дію", retryStop: "Повторити завершення" },
  en: { title: "Conjugation test", stop: "End", loading: "Loading the session…", presenting: "Confirming the displayed question…",
    submitting: "Saving the answer…", unknown: "The answer is not confirmed yet. Check status.", forgot: "Sent: “I forgot…”",
    stopping: "Ending the session…", previous: "Previous answer", previousMode: "Previous answer", barrier: "Confirming the next question…",
    recovery: "The action is not confirmed yet. Check status.", stale: "Could not refresh the session.", refresh: "Check status",
    refreshSummary: "Refresh summary", retryStudy: "Retry action", retryStop: "Retry ending the session" },
} as const;
/** Known problem codes; any other code gets the general stale text. */
const problems: Record<Language, Readonly<Record<string, string>>> = {
  ru: { network: "Нет связи с сервером.", unconfirmed_session: "Есть неподтверждённое занятие.", storage: "Не удалось обновить данные на этом устройстве.",
      expired: "Доступ истёк.", forbidden: "Доступ закрыт." },
  uk: { network: "Немає зв’язку із сервером.", unconfirmed_session: "Є непідтверджене заняття.", storage: "Не вдалося оновити дані на цьому пристрої.",
      expired: "Доступ закінчився.", forbidden: "Доступ закрито." },
  en: { network: "No connection to the server.", unconfirmed_session: "There is an unconfirmed session.", storage: "Could not update data on this device.",
      expired: "Access has expired.", forbidden: "Access is closed." },
};
const control = 'button, a, input, textarea, select, [contenteditable="true"], [role="dialog"]';

type QuestionView = Extract<ConjugationView, { screen: "question" }>;

/** The answer field of one assignment. The draft lives only in the flow: the field shows `view.draft` and every edit
 * goes to `flow.setDraft`, whose `onChange` makes the owner render again. */
function QuestionPanel({ view, flow, language, submitOnEnter, status }: {
  view: QuestionView; flow: ConjugationTestFlow; language: Language; submitOnEnter: boolean; status: string | undefined;
}) {
  const container = useRef<HTMLDivElement>(null);
  const ticket = view.presentationTicket;
  useLayoutEffect(() => {
    const element = container.current;
    if (!ticket || !element) return;
    let cancelled = false;
    // Runs after every layout effect of this commit, so the host has committed the same input to the flow.
    // It confirms a visible DOM commit, not that a person physically looked at it.
    queueMicrotask(() => {
      if (cancelled || document.visibilityState !== "visible" || !element.isConnected || container.current !== element) return;
      flow.committed(ticket);
    });
    return () => { cancelled = true; };
  }, [ticket, flow]);
  return <div ref={container}>
    <WrittenAnswerInput assignment={conjugationWrittenQuestion(view.question)} heading={<ConjugationQuestionHeading question={view.question} />}
      language={language} value={view.draft} readOnly={!view.editable} canSubmit={view.canSubmit} canForget={view.canForget}
      submitOnEnter={submitOnEnter} status={status}
      onChange={text => flow.setDraft(text)}
      onSubmit={() => flow.submit()} onForget={() => flow.forget()} />
  </div>;
}

/** Renderer of the conjugation test view. Rights and memory stay in the flow; every action goes through it. */
export function ConjugationTestScreen({ view, flow, language, submitOnEnter }: ConjugationTestScreenProps) {
  const t = copy[language], root = useRef<HTMLElement>(null), composing = useRef(false);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const target = event.target;
      const inside = target instanceof Element && (target === document.body || !!root.current?.contains(target));
      const ime = composing.current || event.isComposing || event.keyCode === 229;
      // Every Enter is reported so the flow knows a key is held (the one that submitted the answer included);
      // only a free Enter on this screen may act, and only the flow decides whether it is Next.
      const free = inside && submitOnEnter && !event.defaultPrevented && !(target instanceof Element && target.closest(control));
      flow.enter({ repeat: event.repeat || !free, composing: ime });
      if (free && !event.repeat && !ime) event.preventDefault();
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === "Enter") flow.enterReleased(); };
    document.addEventListener("keydown", keydown);
    document.addEventListener("keyup", keyup);
    return () => { document.removeEventListener("keydown", keydown); document.removeEventListener("keyup", keyup); };
  }, [flow, submitOnEnter]);

  const problem = view.problem === null ? null : problems[language][view.problem] ?? t.stale;
  const status = view.stopping ? t.stopping : view.screen === "question"
    ? view.status === "presenting" ? t.presenting : view.status === "submitting" ? t.submitting
      : view.status === "unknown" ? view.pendingForgot ? `${t.unknown} ${t.forgot}` : t.unknown : undefined
    : undefined;
  const ended = view.screen === "summary" || view.screen === "closed";
  const retries = (view.canRetry.study || view.canRetry.stop) && <div className="learning-recovery">
    {view.canRetry.study && <button type="button" onClick={() => flow.retry("study")}>{t.retryStudy}</button>}
    {view.canRetry.stop && <button type="button" onClick={() => flow.retry("stop")}>{t.retryStop}</button>}
  </div>;

  return <main ref={root} className="learning-screen" aria-busy={view.screen === "loading"}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}>
    <header className="learning-header"><h1>{t.title}</h1>
      {!ended && view.screen !== "loading" && <button type="button" disabled={!view.canStop}
        onClick={() => flow.stop()}>{t.stop}</button>}
    </header>
    {view.screen === "loading" && <p role="status">{t.loading}</p>}
    {view.screen === "recovery" && <><p role="status">{t.recovery}</p>{problem && <p>{problem}</p>}</>}
    {view.screen === "stale" && <>
      <p role="status">{problem ?? t.stale}</p>
      <div className="learning-recovery"><button type="button" onClick={() => flow.refresh()}>{t.refresh}</button></div>
    </>}
    {view.screen === "question" && <>
      <QuestionPanel key={view.question.assignmentId} view={view} flow={flow} language={language} submitOnEnter={submitOnEnter} status={status} />
      {view.canPrevious && <button type="button" className="learning-previous" onClick={() => flow.previous()}>{t.previous}</button>}
    </>}
    {view.screen === "result" && <>
      {view.mode === "previous" && <p>{t.previousMode}</p>}
      {view.barrier && <p role="status">{t.barrier}</p>}
      {view.stopping && <p role="status">{t.stopping}</p>}
      <WrittenAnswerResult result={view.result} language={language} pending={view.pending} grades={view.grades}
        canCorrect={view.canCorrect} canNext={view.canNext} timer={view.timer}
        onGrade={grade => flow.grade(grade)} onCorrect={() => flow.correct()} onNext={() => flow.next()} />
    </>}
    {view.screen === "summary" && <ConjugationSummaryView summary={view.summary} language={language}
      onHome={view.canHome ? () => flow.home() : null} />}
    {view.screen === "closed" && <>
      <ConjugationSummaryView summary={view.summary} closedReason={view.reason} language={language} onHome={() => flow.today()} />
      {/* T2 C2: the only way to learn an unknown frozen summary is this manual addressed read. */}
      {view.summary === null && <div className="learning-recovery">
        <button type="button" onClick={() => flow.refresh()}>{t.refreshSummary}</button></div>}
    </>}
    {!ended && retries}
  </main>;
}
