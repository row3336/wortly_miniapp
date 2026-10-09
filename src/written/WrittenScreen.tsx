import { useRef } from "react";
import type { Language } from "../i18n/language";
import { recoveryCopy } from "../commands/commandCopy";
import { CommandRecovery, localCleanupOnly, recoveryCover } from "../commands/CommandRecovery";
import { Loader, RecoveryOverlay, recoveryConflict, recoveryScreen } from "../commands/RecoveryOverlay";
import { StepBackButton, stepBackCopy } from "../commands/StepBackButton";
import { useEnterNext } from "../commands/useEnterNext";
import { answerExampleSource } from "../study/answerExample";
import { WrittenAnswerInput } from "../study/WrittenAnswerInput";
import { WrittenAnswerResult } from "../study/WrittenAnswerResult";
import type { WrittenActions } from "./useWrittenDocument";
import type { WrittenViewSnapshot } from "./writtenViewController";
import { WrittenSummary } from "./WrittenSummary";
import "./written.css";

export type WrittenScreenProps = {
  state: WrittenViewSnapshot;
  language: Language;
  submitOnEnter: boolean;
  actions: WrittenActions;
  /** Navigation only: leaves an already closed session of this owner for Today. */
  onToday(): void;
  /** «Уточнить поля» (TA:115, К05-080): opens the full card of the answered assignment; the card returns to this quiz. */
  onRefineFields?(cardId: string, assignmentId: string): void;
};
const copy = {
  ru: { words: "Слова: перевод на немецкий", phrases: "Фразы: перевод на немецкий", exit: "Выйти", loading: "Загружаем занятие…",
    saving: "Сохраняем ответ…", present: "Подтверждаем показ задания…", unknown: "Проверяем, сохранилось ли действие.",
    stop: "Завершаем занятие…", closed: "Занятие завершено.", unavailable: "Занятие недоступно в этом окне.", stale: "Не удалось обновить занятие.",
    previous: "Предыдущий ответ",
    captured: "Отправленный ответ", forgot: "Забыл…", today: "На Сегодня", summary: "Итог занятия",
    local: "Не удалось обновить данные на этом устройстве.", blocked: "Действие нельзя повторить. Проверь состояние занятия.",
    changed: "Задание изменилось. Обнови занятие.", noMaterial: "Сейчас нет доступных слов для этого занятия.", noPhrases: "Пока нет доступного материала",
    busy: "Занятие открыто на другом устройстве", setup: "Для занятия нужно подтвердить настройки и текущую словарную пару.",
    refine: "Уточнить поля" },
  uk: { words: "Слова: переклад німецькою", phrases: "Фрази: переклад німецькою", exit: "Вийти", loading: "Завантажуємо заняття…",
    saving: "Зберігаємо відповідь…", present: "Підтверджуємо показ завдання…", unknown: "Перевіряємо, чи збереглася дія.",
    stop: "Завершуємо заняття…", closed: "Заняття завершено.", unavailable: "Заняття недоступне в цьому вікні.", stale: "Не вдалося оновити заняття.",
    previous: "Попередня відповідь",
    captured: "Надіслана відповідь", forgot: "Не пам’ятаю…", today: "На Сьогодні", summary: "Підсумок заняття",
    local: "Не вдалося оновити дані на цьому пристрої.", blocked: "Дію не можна повторити. Перевір стан заняття.",
    changed: "Завдання змінилося. Онови заняття.", noMaterial: "Зараз немає доступних слів для цього заняття.", noPhrases: "Поки немає доступного матеріалу",
    busy: "Заняття відкрито на іншому пристрої", setup: "Для заняття потрібно підтвердити налаштування та поточну словникову пару.",
    refine: "Уточнити поля" },
  en: { words: "Words: translate into German", phrases: "Phrases: translate into German", exit: "Exit", loading: "Loading your session…",
    saving: "Saving your answer…", present: "Confirming the displayed question…", unknown: "Checking whether the action was saved.",
    stop: "Ending the session…", closed: "The session has ended.", unavailable: "This session is unavailable in this window.", stale: "Could not refresh the session.",
    previous: "Previous answer",
    captured: "Submitted answer", forgot: "I forgot…", today: "Return to Today", summary: "Session summary",
    local: "Could not update data on this device.", blocked: "This action cannot be retried. Check session status.",
    changed: "The question has changed. Refresh the session.", noMaterial: "There are no words available for this session right now.", noPhrases: "No material is available yet",
    busy: "A session is open on another device", setup: "Confirm session settings and the current dictionary pair to study.",
    refine: "Refine fields" },
} as const;

/**
 * Working copy for G05, root decision, pending owner (В3, 2.31б): the label of the daily counter. It names the
 * material of the session group (the core counts words or phrases by that group) and inflects the noun by the number.
 */
const practiceLabel = {
  ru: { prefix: "Сегодня", words: { one: "слово", few: "слова", many: "слов" } },
  uk: { prefix: "Сьогодні", words: { one: "слово", few: "слова", many: "слів" } },
  en: { prefix: "Today", words: { one: "word", few: "words", many: "words" } },
} as const;
// Phrase counter label (В3). uk/en: root decision, pending owner (O24); ru is the owner-approved text.
const phraseCounter = { ru: "Фраз за день", uk: "Фраз за день", en: "Phrases today" } as const;
export function practiceText(language: Language, phrases: boolean, count: number): string {
  if (phrases) return `${phraseCounter[language]}: ${count}`;
  const label = practiceLabel[language], category = new Intl.PluralRules(language).select(count);
  // English has no "few": every other category falls to the plural form.
  return `${label.prefix}: ${count} ${category === "one" ? label.words.one : category === "few" ? label.words.few : label.words.many}`;
}

/** Connects the local display to the owner's exact capabilities; command identity and outcome are never invented here. */
export function WrittenScreen({ state, language, submitOnEnter, actions, onToday, onRefineFields }: WrittenScreenProps) {
  const t = copy[language], composing = useRef(false), root = useRef<HTMLElement>(null);
  const primary = state.commands.primary, stop = state.commands.stop;
  const revising = primary.pendingIntent?.kind === "result.grade" || primary.pendingIntent?.kind === "result.correct";
  const resultVisible = ["result_correct", "result_wrong", "previous_result", "changing_result"].includes(state.phase)
    || state.phase === "unknown" && revising;
  const result = resultVisible ? state.answer?.result : null;
  const pendingResult = state.phase === "changing_result" ? "changing" : state.phase === "unknown" && revising ? "unknown" : null;
  const unknownAnswer = state.phase === "unknown" && primary.pendingIntent?.kind === "answer.submit";
  const closed = state.phase === "closed" ? state.closed : null;
  // Every closure but summary_home is an interrupted session with its summary (Д02; Q27-А for one not chosen here).
  const interrupted = closed !== null && closed.reason !== "summary_home" && closed.natural === false;
  // F1 (C081): a natural end closed later keeps its confirmed completed summary; the closed session grants nothing.
  // summary_home itself, accepted or met by SESSION_CLOSED, is only the way to Today.
  const naturalClosed = closed !== null && closed.natural === true && closed.reason !== "summary_home" && !closed.homeRequested;
  // C088: «Шаг назад» from that summary is unresolved, so neither its completed nor an interrupted summary is known.
  const undecided = closed !== null && closed.natural === null && closed.reason !== "summary_home" && !closed.homeRequested;
  const problemCode = state.problem, phrases = state.bucket === "phrases";
  // 2.31б: the daily count of unique items of the session's group, taken from the server step; never a local tally.
  const practice = state.practice;
  // A refused «Шаг назад» says that this right is gone; the re-read state shows what holds now (CT 2.2).
  const refusedUndo = primary.outcome === "rejected" && primary.resolved?.kind === "result.undo" && problemCode === primary.rejectionCode;
  // Я17 (CT §6.1 п. 10): the conflict's own text; its action is «Выйти» of the header.
  const problem = recoveryConflict(state.commands) ? recoveryCopy[language].conflict
    : refusedUndo && problemCode !== "SESSION_CLOSED" ? stepBackCopy[language].unavailable
    : problemCode === "NO_MATERIAL" ? phrases ? t.noPhrases : t.noMaterial : problemCode === "SESSION_BUSY" ? t.busy
    : problemCode === "SETUP_REQUIRED" ? t.setup : problemCode === "ASSIGNMENT_STALE" ? t.changed
    : problemCode === "SESSION_CLOSED" ? t.closed : problemCode === "storage" ? t.local
    : problemCode === "mismatch" || problemCode === "invalid_pending" || problemCode === "pending_changed" ? t.blocked
    : problemCode ? t.stale : null;
  const unresolved = primary.pending && primary.outcome === null || stop.pending && stop.outcome === null;
  // A study result recovers by itself: no check or retry button for it (Я15, CT §6.1 п. 2); Stop keeps its own.
  const automatic = state.commands.automaticPrimary;
  const manualLanes = automatic ? [stop] : [primary, stop];
  // An ordinary request in flight shows only its indicator; checking and retry belong to an unknown outcome (TA табл. 5.1).
  const unknownLane = manualLanes.some(lane => lane.pending && lane.outcome === null && lane.phase !== "sending");
  const isClosed = state.phase === "closed" || state.phase === "disposed";
  const summaryFailed = interrupted && closed.summaryRead === "failed";
  const showRecovery = !isClosed && (unknownLane || !automatic && (!!problem && state.phase !== "idle" || state.phase === "stale"))
    || summaryFailed;
  const recovering = isClosed ? null : recoveryCover(recoveryScreen(state.commands), state.commands);
  // S07: «Продолжить» repeats only the local cleanup of a saved action, never the check and read of «Проверить состояние».
  const localOnly = localCleanupOnly(primary, stop);
  const status = state.phase === "submitting" ? t.saving : state.phase === "visible_unconfirmed" ? t.present
    : state.phase === "unknown" ? t.unknown : undefined;
  const pendingForgot = primary.pending && primary.outcome === null && primary.pendingIntent?.kind === "answer.submit"
    && "forgot" in primary.pendingIntent.payload;
  const canNext = state.canNext && !pendingResult;
  // root decision, pending owner (M-ACTIONS Р9): only while no command of the quiz is unresolved, so the card never
  // opens over a result whose grade or correction is still being saved. The text uk/en is a G05 working copy.
  const refineCard = result && !pendingResult && !primary.pending && !stop.pending ? state.resultCardId : null;
  useEnterNext(root, composing, submitOnEnter, result, canNext, actions);

  // Waiting for the summary of an interrupted session looks like the application start, never like a zero result.
  if (interrupted && (closed.summaryRead === "pending" || closed.summaryRead === "reading")) return <main className="app-shell" lang={language} aria-busy="true">
    <div role="status" aria-label={t.summary}>
      <Loader />
      <p>{t.loading}</p>
    </div>
  </main>;

  const summary = state.phase === "summary" || naturalClosed ? state.summary
    : interrupted && closed.summaryRead === "known" ? closed.summary : null;
  return <main ref={root} className="written-screen" lang={language} onCompositionStart={() => { composing.current = true; }}
    onCompositionEnd={() => { composing.current = false; }}>
    {!summary && <header className="written-header">
      <h1>{phrases ? t.phrases : t.words}</h1>
      {!isClosed && state.phase !== "idle" && <button type="button" disabled={!state.canStop}
        onClick={() => { if (state.canStop) void actions.stop("stop"); }}>{t.exit}</button>}
    </header>}
    {!summary && !isClosed && practice && <p className="written-practice">{practiceText(language, phrases, practice.count)}</p>}
    {state.question && <WrittenAnswerInput assignment={state.question} language={language}
      value={pendingForgot ? "" : unknownAnswer && state.submittedText !== null ? state.submittedText : state.draft}
      readOnly={!state.canEditDraft} canSubmit={state.canSubmit} canForget={state.canForget} submitOnEnter={submitOnEnter}
      status={pendingForgot ? `${t.forgot} ${status ?? ""}` : status}
      onChange={value => actions.setDraft(value)} onSubmit={() => { void actions.submit(); }}
      onForget={() => { void actions.submit({ forgot: true }); }} />}
    {unknownAnswer && !state.question && <section aria-label={t.captured} className="written-captured">
      <p className="written-parts">{t.captured}</p><p lang={state.submittedText === null ? language : "de"}>{state.submittedText ?? t.forgot}</p>
      <p role="status">{t.unknown}</p>
    </section>}
    {result && <WrittenAnswerResult result={result} language={language} pending={pendingResult}
      grades={state.grades} canCorrect={state.canCorrect} canNext={canNext} timer={state.timer} example={answerExampleSource}
      onGrade={grade => { void actions.grade(grade); }} onCorrect={() => { void actions.correct(); }} onNext={() => { void actions.next(); }} />}
    {result && refineCard !== null && onRefineFields && <button type="button" className="written-refine"
      onClick={() => onRefineFields(refineCard, result.assignment_id)}>{t.refine}</button>}
    {result && state.canUndo && <StepBackButton className="written-step-back" language={language} onUndo={() => { void actions.undo(); }} />}
    {state.phase === "previous_result" && primary.pendingIntent?.kind === "assignment.present" && primary.outcome === null
      && <p role="status">{t.present}</p>}
    {state.canPrevious && <button type="button" className="written-previous" onClick={() => actions.previousResult()}>{t.previous}</button>}
    {summary && <WrittenSummary summary={summary} outcome={state.phase === "summary" || naturalClosed ? "completed" : "interrupted"} language={language}
      closedReason={!interrupted || closed.reason === "stop" || closed.reason === "summary_home" ? undefined : closed.reason}
      canToday={state.phase === "summary" ? state.canSummaryHome : true}
      onUndo={state.phase === "summary" && state.canUndo ? () => { void actions.undo(); } : undefined}
      onToday={() => { if (state.phase === "summary") void actions.stop("summary_home"); else onToday(); }} />}
    {["loading", "stopping", "disposed", "undoing"].includes(state.phase) && <p role="status">
      {state.phase === "loading" ? t.loading : state.phase === "stopping" ? t.stop : state.phase === "undoing"
        ? stepBackCopy[language].pending : t.unavailable}</p>}
    {state.phase === "closed" && !summary && <p role="status">{undecided ? t.unknown : t.closed}</p>}
    {state.phase === "unknown" && !state.question && !unknownAnswer && !result && <p role="status">{t.unknown}</p>}
    {problem && !isClosed && <p role="status">{problem}</p>}
    {showRecovery && <CommandRecovery className="written-recovery" language={language} lanes={manualLanes} localOnly={localOnly}
      canRetryPrimary={state.canRetryPrimary} canRetryStop={stop.canRetry}
      onCheck={() => { void (localOnly ? actions.cleanup() : actions.refresh()); }} onRetry={lane => { void actions.retry(lane); }} />}
    {recovering && <RecoveryOverlay screen={recovering} language={language} canEnd={state.canStop}
      onEnd={() => { if (state.canStop) void actions.stop("stop"); }} />}
    {(state.phase === "idle" && !unresolved || summaryFailed || undecided) && <button type="button" className="written-today" onClick={onToday}>{t.today}</button>}
  </main>;
}
