import { useRef, type ReactNode } from "react";
import type { LearningPreviewAddress } from "../api/generated";
import { recoveryCopy } from "../commands/commandCopy";
import { CommandRecovery, localCleanupOnly } from "../commands/CommandRecovery";
import { RecoveryOverlay, recoveryConflict, recoveryScreen } from "../commands/RecoveryOverlay";
import { StepBackButton, stepBackCopy } from "../commands/StepBackButton";
import { useEnterNext } from "../commands/useEnterNext";
import type { Language } from "../i18n/language";
import { answerExampleSource } from "../study/answerExample";
import { WrittenAnswerInput } from "../study/WrittenAnswerInput";
import { WrittenAnswerResult } from "../study/WrittenAnswerResult";
import type { LearningViewController, LearningViewSnapshot } from "./learningViewController";
import "./learning.css";

export type LearningActions = Pick<LearningViewController,
  "setDraft" | "submit" | "previousResult" | "next" | "grade" | "correct" | "undo" | "retry" | "refresh" | "stop" | "advancePreview">;
export type LearningScreenProps = {
  state: LearningViewSnapshot;
  language: Language;
  submitOnEnter: boolean;
  actions: LearningActions;
  /** The card renderer owns the approved example presentation policy; this screen does not choose one. */
  renderPreview(preview: LearningPreviewAddress): ReactNode;
};
const copy = {
  ru: { title: "Изучение слов", exit: "Выйти", loading: "Загружаем занятие…", idle: "Занятие ещё не началось.",
    saving: "Сохраняем ответ…", present: "Подтверждаем показ задания…", unknown: "Проверяем, сохранилось ли действие.",
    stop: "Завершаем занятие…", closed: "Занятие завершено.", unavailable: "Занятие недоступно в этом окне.", stale: "Не удалось обновить занятие.",
    previous: "Предыдущий ответ", captured: "Отправленный ответ", forgot: "Забыл…", next: "Дальше", known: "Уже знаю",
    groupDone: "Группа изучена.", passDone: "Этот проход завершён.", today: "Вернуться на Сегодня",
    local: "Не удалось обновить данные на этом устройстве.", savedLocal: "Действие сохранено. Не удалось обновить данные на этом устройстве.",
    changed: "Задание изменилось. Обнови занятие.", resultChanged: "Результат изменился. Обнови занятие.", noMaterial: "Сейчас нет доступных слов для этого занятия.",
    busy: "Занятие открыто на другом устройстве" },
  uk: { title: "Вивчення слів", exit: "Вийти", loading: "Завантажуємо заняття…", idle: "Заняття ще не почалося.",
    saving: "Зберігаємо відповідь…", present: "Підтверджуємо показ завдання…", unknown: "Перевіряємо, чи збереглася дія.",
    stop: "Завершуємо заняття…", closed: "Заняття завершено.", unavailable: "Заняття недоступне в цьому вікні.", stale: "Не вдалося оновити заняття.",
    previous: "Попередня відповідь", captured: "Надіслана відповідь", forgot: "Не пам’ятаю…", next: "Далі", known: "Уже знаю",
    groupDone: "Групу вивчено.", passDone: "Цей прохід завершено.", today: "Повернутися на Сьогодні",
    local: "Не вдалося оновити дані на цьому пристрої.", savedLocal: "Дію збережено. Не вдалося оновити дані на цьому пристрої.",
    changed: "Завдання змінилося. Онови заняття.", resultChanged: "Результат змінився. Онови заняття.", noMaterial: "Зараз немає доступних слів для цього заняття.",
    busy: "Заняття відкрито на іншому пристрої" },
  en: { title: "Learn words", exit: "Exit", loading: "Loading your session…", idle: "The session has not started yet.",
    saving: "Saving your answer…", present: "Confirming the displayed question…", unknown: "Checking whether the action was saved.",
    stop: "Ending the session…", closed: "The session has ended.", unavailable: "This session is unavailable in this window.", stale: "Could not refresh the session.",
    previous: "Previous answer", captured: "Submitted answer", forgot: "I forgot…", next: "Next", known: "I already know this",
    groupDone: "You have learned this group.", passDone: "This round has ended.", today: "Return to Today",
    local: "Could not update data on this device.", savedLocal: "The action was saved. Could not update data on this device.",
    changed: "The question has changed. Refresh the session.", resultChanged: "The result has changed. Refresh the session.", noMaterial: "There are no words available for this session right now.",
    busy: "A session is open on another device" },
} as const;

/**
 * Connect local display to the owner's exact capabilities; no command identity or outcome is invented here.
 * The Learning answer is the shared written input (М08): its result shows one example of the answered card by the same
 * rule as the written quiz (К05-126, К05-127; selectAnswerExample). root decision, pending owner (M-LEARN-FIN Р6).
 */
export function LearningScreen({ state, language, submitOnEnter, actions, renderPreview }: LearningScreenProps) {
  const t = copy[language], composing = useRef(false), root = useRef<HTMLElement>(null);
  const primary = state.commands.primary, stop = state.commands.stop;
  const pendingKind = primary.pendingIntent?.kind;
  const revision = pendingKind === "result.grade" || pendingKind === "result.correct";
  const resultVisible = ["result_correct", "result_wrong", "previous_result", "changing_result"].includes(state.phase)
    || state.phase === "unknown" && revision;
  const result = resultVisible ? state.answer?.result : null;
  const pendingResult = state.phase === "changing_result" ? "changing" : state.phase === "unknown" && revision ? "unknown" : null;
  const unknownAnswer = state.phase === "unknown" && pendingKind === "answer.submit";
  const isClosed = state.phase === "closed" || state.phase === "disposed";
  // A refused «Шаг назад» says that this right is gone; the re-read state shows what holds now (CT 2.2).
  const refusedUndo = primary.outcome === "rejected" && primary.resolved?.kind === "result.undo" && state.problem === primary.rejectionCode;
  // Я17 (CT §6.1 п. 10): the conflict's own text; its action is «Выйти» of the header.
  const problem = recoveryConflict(state.commands) ? recoveryCopy[language].conflict
    : refusedUndo && state.problem !== "SESSION_CLOSED" ? stepBackCopy[language].unavailable
    : state.problem === "NO_MATERIAL" ? t.noMaterial
    : state.problem === "SESSION_BUSY" ? t.busy
    : state.problem === "ASSIGNMENT_STALE" ? t.changed
    : state.problem === "RESULT_STALE" ? t.resultChanged
    : state.problem === "SESSION_CLOSED" ? t.closed
    : state.problem === "storage" ? primary.outcome === "accepted" || stop.outcome === "accepted" ? t.savedLocal : t.local
    : state.problem ? t.stale : null;
  // A study result recovers by itself: no check or retry button for it (Я15, CT §6.1 п. 2); Stop keeps its own.
  const automatic = state.commands.automaticPrimary;
  const manualLanes = automatic ? [stop] : [primary, stop];
  const unresolved = manualLanes.some(lane => lane.pending && lane.outcome === null);
  const showRecovery = !isClosed && (unresolved || !automatic && (problem || state.phase === "stale"));
  const recovering = isClosed ? null : recoveryScreen(state.commands);
  const status = state.phase === "submitting" ? t.saving : state.phase === "visible_unconfirmed" ? t.present
    : state.phase === "unknown" ? t.unknown : undefined;
  const pendingForgot = primary.pending && primary.outcome === null && primary.pendingIntent?.kind === "answer.submit"
    && "forgot" in primary.pendingIntent.payload;
  useEnterNext(root, composing, submitOnEnter, result, state.canNext && !pendingResult, actions);

  return <main ref={root} className={`learning-screen${state.phase === "summary" ? " learning-screen-summary" : ""}`} onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}>
    {state.phase !== "summary" && <header className="learning-header"><h1>{t.title}</h1>
      {!isClosed && <button type="button" disabled={!state.canStop}
        onClick={() => { if (state.canStop) void actions.stop(state.phase === "summary" ? "summary_home" : "stop"); }}>{t.exit}</button>}
    </header>}
    {state.phase === "preview" && state.current?.preview && <>
      <p className="learning-preview-position">{state.current.preview.position} / {state.current.preview.total}</p>
      {renderPreview(state.current.preview)}
      <div className="learning-preview-actions">
        <button type="button" disabled={!state.canAdvancePreview} onClick={() => { if (state.canAdvancePreview) void actions.advancePreview(true); }}>{t.known}</button>
        <button type="button" disabled={!state.canAdvancePreview} onClick={() => { if (state.canAdvancePreview) void actions.advancePreview(); }}>{t.next}</button>
      </div>
    </>}
    {state.question && <WrittenAnswerInput assignment={state.question} language={language}
      value={pendingForgot ? "" : unknownAnswer && state.submittedText !== null ? state.submittedText : state.draft}
      readOnly={!state.canEditDraft}
      canSubmit={state.canSubmit} canForget={state.canForget} submitOnEnter={submitOnEnter} status={pendingForgot ? `${t.forgot} ${status ?? ""}` : status}
      onChange={value => actions.setDraft(value)} onSubmit={() => { void actions.submit(); }} onForget={() => { void actions.submit({ forgot: true }); }} />}
    {unknownAnswer && !state.question && <section aria-label={t.captured} className="learning-captured">
      <p className="written-parts">{t.captured}</p><p lang={state.submittedText === null ? language : "de"}>{state.submittedText ?? t.forgot}</p>
      <p role="status">{t.unknown}</p>
    </section>}
    {result && <WrittenAnswerResult result={result} language={language} pending={pendingResult}
      grades={state.grades} canCorrect={state.canCorrect} canNext={state.canNext} timer={state.timer} example={answerExampleSource}
      onGrade={grade => { void actions.grade(grade); }} onCorrect={() => { void actions.correct(); }} onNext={() => { void actions.next(); }} />}
    {result && state.canUndo && <StepBackButton className="learning-step-back" language={language} onUndo={() => { void actions.undo(); }} />}
    {state.canPrevious && <button type="button" className="learning-previous" onClick={() => actions.previousResult()}>{t.previous}</button>}
    {state.phase === "summary" && <button type="button" className="learning-summary" aria-label={t.today} disabled={!state.canStop}
      onClick={() => { if (state.canStop) void actions.stop("summary_home"); }}>
      {state.current?.group.status === "completed" ? t.groupDone : t.passDone}
    </button>}
    {/* The phase summary keeps «Шаг назад» while the server grants it (К10-127, К05-151). */}
    {state.phase === "summary" && state.canUndo
      && <StepBackButton className="learning-step-back" language={language} onUndo={() => { void actions.undo(); }} />}
    {["loading", "idle", "stopping", "closed", "disposed", "undoing"].includes(state.phase) && <p role="status">
      {state.phase === "loading" ? t.loading : state.phase === "idle" ? t.idle : state.phase === "stopping" ? t.stop
        : state.phase === "undoing" ? stepBackCopy[language].pending
        : state.phase === "disposed" ? t.unavailable : t.closed}
    </p>}
    {state.phase === "unknown" && !state.question && !unknownAnswer && !result && <p role="status">{t.unknown}</p>}
    {problem && !isClosed && <p role="status">{problem}</p>}
    {showRecovery && <CommandRecovery className="learning-recovery" language={language} lanes={manualLanes} localOnly={localCleanupOnly(primary, stop)}
      canRetryPrimary={state.canRetryPrimary} canRetryStop={stop.canRetry}
      onCheck={() => { void actions.refresh(); }} onRetry={lane => { void actions.retry(lane); }} />}
    {recovering && <RecoveryOverlay screen={recovering} language={language} />}
  </main>;
}
