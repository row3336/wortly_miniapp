import { gateWaitText, recoveryCover } from "../commands/CommandRecovery";
import { recoveryCopy } from "../commands/commandCopy";
import { RecoveryOverlay, recoveryConflict, recoveryScreen } from "../commands/RecoveryOverlay";
import { startRefusalIntent } from "../commands/startRefusal";
import type { ForegroundIntent } from "../app/entryController";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { commandCopy } from "../commands/commandCopy";
import type { Language } from "../i18n/language";
import { AssociationBlock } from "../study/AssociationBlock";
import type { OralDocumentSnapshot } from "./oralDocumentController";
import { oralRefineCardId } from "./oralRefine";
import { closedReasonLines } from "../written/WrittenSummary";
import { NoticeShown } from "../notices/NoticeShown";
import { FORCED_ORAL_REASONS } from "./oralClosureHandoff";
import type { OralDocumentActions } from "./useOralDocument";
import "./oral.css";

export type OralScreenProps = {
  state: OralDocumentSnapshot | null;
  actions: OralDocumentActions;
  language: Language;
  /** The host sets this only for the currently displayed route. */
  active: boolean;
  /**
   * Leaves the summary of this owner's own Stop, or the shown refusal of its start, for Today; navigation belongs to the
   * host. intent (fix5, Q29): the «На Сегодня» of a start refused as SESSION_BUSY carries startRefusalIntent (П01).
   */
  onToday(intent?: ForegroundIntent): void;
  /** «Уточнить поля»: opens the question's card (М12) on top of the quiz; without it the button is absent. */
  onRefineFields?(cardId: string, assignmentId: string): void;
  /**
   * Q32: the «На Сегодня» of a session closed without the person (FORCED_ORAL_REASONS); the host acknowledges its
   * notice first when the reason has one (NOTICE_ORAL_REASONS; project notices ed.2.4 §6). Without it: onToday.
   */
  onForcedToday?(sessionId: string): void;
  /** That acknowledgement is under way: the button waits. */
  leaving?: boolean;
  /** The oral_forced_close of this closed session known to the board (calendar causes): named once its summary is drawn. */
  forcedNoticeId?: string | null;
  /** answer_loss of the own Stop's session (project notices §6): its lines on the summary, set by the host. */
  noticeLines?: string[] | null;
  /** That notice's id, named once the summary with it is drawn (c.screen(notice_shown)). */
  noticeId?: string | null;
};

// Q32 вар.1, R4-03: the closures without the person shown with their reason (single source: oralClosureHandoff).
export { FORCED_ORAL_REASONS };
/**
 * The reasons the server creates oral_forced_close for (until R22: Codex C486; core N2a), so the only ones whose «На
 * Сегодня» acknowledges a notice. remote_stop and pair_changed have none: no read is awaited and no ack is sent.
 */
export const NOTICE_ORAL_REASONS: readonly string[] = ["midnight", "timezone_date_changed"];

const copy = {
  ru: { title: "Устное занятие", exit: "Выйти", reveal: "Раскрыть", correct: "Правильно", wrong: "Неправильно",
    question: "Задание", translation: "Перевод", meaning: "Значение союза", verb: "Позиция глагола",
    loading: "Загружаем занятие…", idle: "Занятие ещё не началось.", remember: "Вспомни перевод.",
    present: "Подтверждаем показ задания…", grade: "Оцени свой ответ.", saving: "Сохраняем действие…",
    unknown: "Действие ещё не подтверждено. Проверь состояние.", stale: "Не удалось обновить занятие. Проверь состояние.",
    staleShort: "Не удалось обновить занятие.",
    stopping: "Завершаем занятие…", closed: "Занятие завершено.", disposed: "Занятие недоступно в этом окне.",
    inactive: "Занятие сейчас не активно.", summary: "Итог занятия", completed: "Пройдено", right: "Верно", errors: "Ошибки",
    remaining: "Осталось", today: "На Сегодня", refresh: commandCopy.ru.check, retryStudy: "Повторить действие",
    retryStop: commandCopy.ru.retryStop, recovery: "Проверка состояния", pendingStudy: "Учебное действие ещё не подтверждено.",
    pendingStop: "Завершение ещё не подтверждено.", cleanup: "Не удалось обновить данные на этом устройстве. Проверь состояние.",
    blocked: "Действие нельзя повторить. Проверь состояние занятия.", refine: "Уточнить поля",
    busy: "Занятие открыто на другом устройстве" },
  uk: { title: "Усне заняття", exit: "Вийти", reveal: "Розкрити", correct: "Правильно", wrong: "Неправильно",
    question: "Завдання", translation: "Переклад", meaning: "Значення сполучника", verb: "Позиція дієслова",
    loading: "Завантажуємо заняття…", idle: "Заняття ще не почалося.", remember: "Згадай переклад.",
    present: "Підтверджуємо показ завдання…", grade: "Оціни свою відповідь.", saving: "Зберігаємо дію…",
    unknown: "Дію ще не підтверджено. Перевір стан.", stale: "Не вдалося оновити заняття. Перевір стан.",
    staleShort: "Не вдалося оновити заняття.",
    stopping: "Завершуємо заняття…", closed: "Заняття завершено.", disposed: "Заняття недоступне в цьому вікні.",
    inactive: "Заняття зараз не активне.", summary: "Підсумок заняття", completed: "Пройдено", right: "Правильно", errors: "Помилки",
    remaining: "Залишилося", today: "На Сьогодні", refresh: commandCopy.uk.check, retryStudy: "Повторити дію",
    retryStop: commandCopy.uk.retryStop, recovery: "Перевірка стану", pendingStudy: "Навчальну дію ще не підтверджено.",
    pendingStop: "Завершення ще не підтверджено.", cleanup: "Не вдалося оновити дані на цьому пристрої. Перевір стан.",
    blocked: "Дію не можна повторити. Перевір стан заняття.", refine: "Уточнити поля",
    busy: "Заняття відкрито на іншому пристрої" },
  en: { title: "Oral practice", exit: "Exit", reveal: "Reveal", correct: "Correct", wrong: "Incorrect",
    question: "Question", translation: "Translation", meaning: "Conjunction meaning", verb: "Verb position",
    loading: "Loading your session…", idle: "The session has not started yet.", remember: "Recall the translation.",
    present: "Confirming the displayed question…", grade: "Assess your answer.", saving: "Saving the action…",
    unknown: "The action is not confirmed yet. Check status.", stale: "Could not refresh the session. Check status.",
    staleShort: "Could not refresh the session.",
    stopping: "Ending the session…", closed: "The session has ended.", disposed: "This session is unavailable in this window.",
    inactive: "This session is not active right now.", summary: "Session summary", completed: "Completed", right: "Correct", errors: "Errors",
    remaining: "Remaining", today: "Return to Today", refresh: commandCopy.en.check, retryStudy: "Retry action",
    retryStop: commandCopy.en.retryStop, recovery: "Status check", pendingStudy: "The study action is not confirmed yet.",
    pendingStop: "Ending the session is not confirmed yet.", cleanup: "Could not update data on this device. Check status.",
    blocked: "This action cannot be retried. Check session status.", refine: "Refine fields",
    busy: "A session is open on another device" },
} as const;

export type OralForcedSummaryProps = {
  language: Language;
  /** The closed status line: «Занятие завершено.», or the failed read of the summary in the open window. */
  status: string;
  /** The reason (Q32); нет утверждённого текста — the working copy of the written summary (WrittenSummary reasons, 6.1.O5). */
  reasonLine: string;
  /** The numbers of the actual summary (T3): completed, correct, wrong — nothing else, and none when unknown (never zeros). */
  counts: { completed: number; correct: number; wrong: number } | null;
  /**
   * «Осталось» (TZA М19 :83: Пройдено/верно/ошибки/остаток): total − completed of the session's actual progress; null when
   * no progress of this pair is known — then the line is absent, never a 0. The notice of a closed Mini App has no progress
   * in core a2c29f4 (study/notices.py takes the summary only): it shows the line once the core sends one (M1b dependency).
   */
  remaining: number | null;
  leaving: boolean;
  onToday(): void;
  dataNotice?: string;
  /** The oral_forced_close drawn here, named once shown (c.screen(notice_shown), project notices §8). */
  noticeId?: string | null;
  children?: ReactNode;
};
/**
 * The ONE summary screen of an oral session closed without the person (project notices ed.2.4 §6, Д4, R4-03; Q32): the open
 * window (OralScreen) and the next open after a closed Mini App (NoticeScreen, oral_forced_close) render this same frame
 * from the same facts: the reason, Пройдено/Верно/Ошибки and «Осталось» (TZA М19 :83; Codex C525) where the progress is
 * known; for pair_changed numbers of the other pair never appear (C178); no live practice block.
 */
export function OralForcedSummary({ language, status, reasonLine, counts, remaining, leaving, onToday, dataNotice, noticeId, children }: OralForcedSummaryProps) {
  const t = copy[language];
  return <main className="oral-screen" lang={language} aria-label={t.title} data-notice={dataNotice}>
    <header className="oral-header"><h1>{t.title}</h1></header>
    <p role="status" aria-live="polite">{status}</p>
    <section className="oral-summary" aria-label={t.summary}>
      <h2>{t.summary}</h2>
      <p>{reasonLine}</p>
      {noticeId && <NoticeShown noticeId={noticeId} />}
      {counts && <dl><div><dt>{t.completed}</dt><dd>{counts.completed}</dd></div><div><dt>{t.right}</dt><dd>{counts.correct}</dd></div>
        <div><dt>{t.errors}</dt><dd>{counts.wrong}</dd></div>{remaining !== null && <div><dt>{t.remaining}</dt><dd>{remaining}</dd></div>}</dl>}
      <button type="button" disabled={leaving} onClick={() => { if (!leaving) onToday(); }}>{t.today}</button>
    </section>
    {children}
  </main>;
}
/** The closed status line of the oral summary, shared with the notice screen. */
export function oralClosedLine(language: Language): string { return copy[language].closed; }

/** A detached renderer: accepted state and command identity belong exclusively to the owner. */
export function OralScreen({ state, actions, language, active, onToday, onRefineFields, onForcedToday, leaving, noticeLines, noticeId, forcedNoticeId }: OralScreenProps) {
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

  // M1d (Q19 вариант 1, К19-018): an automatic study step (present, reveal, grade) recovers by its machine — no manual
  // check or retry of it (Я15, CT §6.1 п.2), as in the written and Learning screens; Stop keeps its own.
  const automatic = state?.automaticStudy === true;
  const allLanes = state ? [state.commands.study, state.commands.stop] : [];
  const lanes = state && automatic ? [state.commands.stop] : allLanes;
  // The first send of an automatic step goes by its machine, which prepares its budget before the lane holds the intent:
  // that is the same ordinary indicator, never a failed refresh.
  const saving = state?.commands.study.phase === "sending" || state?.recovery?.state.name === "sending";
  const phase = state?.phase ?? "loading";
  // Server facts of this owner's own Stop, of a closure without the person (Q32), or of a closure whose reason is not
  // known yet; any other reason keeps the plain closed line.
  const forcedReason = state?.closed?.reason != null && FORCED_ORAL_REASONS.includes(state.closed.reason)
    ? state.closed.reason as "midnight" | "timezone_date_changed" | "remote_stop" | "pair_changed" : null;
  // pair_changed: the closed session belongs to the old pair; its numbers never reach this pair (C178), so nothing of it
  // is read or awaited here — only a summary already known for this pair is shown.
  const otherPair = forcedReason === "pair_changed" && state?.closed?.summaryRead !== "known";
  // The own closures: the person's Stop and the closure C of this document after the sends of X ran out (save_failed,
  // CON §6.1 п.8): their summary, with the answer_loss lines the host passes (9.2.7 / R2-05).
  const own = state?.closed?.reason === "stop" || state?.closed?.reason === "save_failed";
  const closed = active && phase === "closed" && state?.closed && !otherPair
    && (own || state.closed.reason === null || forcedReason !== null) ? state.closed : null;
  const waiting = closed?.summaryRead === "pending" || closed?.summaryRead === "reading";
  const readFailed = closed?.summaryRead === "failed";
  const closedSummary = closed?.summaryRead === "known" && (own || forcedReason !== null) ? closed : null;
  // Q32: the reason of a closure without the person, on its summary. нет утверждённого текста: the working copy of the
  // written and conjugation summaries (WrittenSummary.tsx reasons, 6.1.O5), reused as is.
  const forcedLine = forcedReason !== null ? closedReasonLines[language][forcedReason] ?? closedReasonLines[language].unknown : null;
  // Q32: the closure without the person, known (its summary), unread (read failed) or of the other pair (no numbers, C178).
  const forced = active && phase === "closed" && forcedLine !== null && state?.closed
    && (closedSummary !== null || readFailed || otherPair) ? state.closed : null;
  const leaveForced = (sessionId: string) => { if (!leaving) { if (onForcedToday) onForcedToday(sessionId); else onToday(); } };
  const unread = closed?.summaryRead === "pending" ? closed.sessionId.toLowerCase() : null;
  const requested = useRef(new Set<string>());
  useEffect(() => {
    // One GET status check per closed session; after a failure only the explicit check retries.
    if (!unread || requested.current.has(unread)) return;
    requested.current.add(unread);
    void actions.refresh();
  }, [unread, actions]);

  // The problem line already names the cause; the generic stale line beside it would contradict it.
  const busyRefused = state?.problem === "SESSION_BUSY";
  // A session the server proved open in another pair is a known fact, not a failed update (C178): no failure line for it
  // unless a real problem is named; the check stays (as the written and Learning screens).
  const knownMismatch = !!state?.pairMismatch && state.problem === null;
  // The machine's own status over the study screen (Я15.2; the first send keeps the ordinary indicator).
  const recovering = active && !!state && phase !== "disposed" && phase !== "closed" && state.suspended !== true
    ? recoveryCover(recoveryScreen({ recovery: state.recovery ?? null, primary: state.commands.study }), { primary: state.commands.study }) : null;
  // An automatic step with no cover of its machine (it only checks a record of another window, 2.3 А; or the mark of a
  // shown question, Q25.2): the short status of the check (9.2.1, R10) or of that mark — never «Проверь состояние».
  const automaticStatus = state?.commands.study.pendingIntent?.kind === "assignment.present" ? t.present
    : recovering ? null : recoveryCopy[language].checking;
  // A screen whose only study action recovers by its machine has no manual check while Stop has none to show either: its
  // failure line then names the failure without asking for a check (the line of the written and Learning screens).
  const manualCheck = !!state && (lanes.some(lane => lane.pending) || state.canRetry.study || state.canRetry.stop);
  const staleLine = automatic && !manualCheck ? t.staleShort : t.stale;
  const status = !active ? t.inactive : phase === "disposed" ? t.disposed : phase === "closed" ? readFailed ? staleLine : t.closed
    : phase === "stopping" ? t.stopping : phase === "visible_unconfirmed" ? t.present : saving ? t.saving : phase === "loading" ? t.loading
    // The mark of a shown question waits without the machine's cover (recoveryCover, Q25.2): its own short status says so.
    : phase === "idle" ? t.idle : phase === "unknown" ? automatic ? automaticStatus : t.unknown : phase === "stale" ? busyRefused || knownMismatch ? null : t.stale
    : phase === "prefetched" ? t.present
    : phase === "question" ? t.remember : phase === "revealed" ? t.grade : null;
  const localProblem = state?.problem === "storage" || allLanes.some(lane => lane.problem === "storage");
  const blocked = allLanes.some(lane => lane.problem === "mismatch" || lane.problem === "invalid_pending" || lane.problem === "pending_changed");
  // Я17 (CT §6.1 п.10): the machine stopped on another payload under the same command_id of the study step; the conflict's
  // own text (9.2.5, R10), its action is «Выйти» of the header — as the written screen.
  const conflict = !!state && recoveryConflict({ recovery: state.recovery ?? null, primary: state.commands.study });
  // A suspended owner shows only «loading» until its window's foreground answers: an earlier refusal or busy line
  // beside it would read as a failure of this return (2.33). The fresh owner after the foreground shows real problems.
  const suspended = state?.suspended === true;
  // A lane check that found the command absent on the same open step succeeded: its «not_found» is a fact about the
  // command, not a failed refresh, and the unconfirmed-action lines already say what is true. The owner vouches for the
  // source of the current cause (checkedAbsent); the screen never infers it from an older marker of one lane.
  const checkedAbsent = state?.checkedAbsent === true;
  // Same wording as the written quiz: a refused start names the other device, not a generic refresh failure.
  const problem = suspended ? null
    : conflict ? recoveryCopy[language].conflict : localProblem ? t.cleanup : blocked ? t.blocked : busyRefused ? t.busy : checkedAbsent ? null : state?.problem ? staleLine : null;
  const summary = state?.current?.status === "summary" ? state.current.summary : forced ? null : closedSummary?.summary ?? null;
  const progress = closedSummary ? closedSummary.progress : state?.current?.progress;
  const remaining = progress ? progress.total - progress.completed : null;
  const usable = active && !!state && phase !== "disposed";
  const refreshBusy = lanes.some(lane => lane.phase === "loading" || lane.phase === "checking");
  // An automatic study step has no manual check (its machine checks it): the controls stay for Stop, as in the written screen.
  const showRecovery = usable && !suspended && (lanes.some(lane => lane.pending) || state!.canRetry.study || state!.canRetry.stop
    || !automatic && (phase === "unknown" || phase === "stale" || phase === "closed" || !!problem));
  // The machine's own status over the study screen (Я15.2; the first send keeps the ordinary indicator).
  const allowed = (capability: boolean | undefined) => usable && capability === true;
  const checkBlocked = state?.gate?.checkable === false;
  const studyBlocked = state?.gate?.primaryWritable === false, stopBlocked = state?.gate?.stopWritable === false;
  const gateHeld = checkBlocked || !!state?.canRetry.study && studyBlocked || !!state?.canRetry.stop && stopBlocked;
  const toToday = closedSummary !== null || allowed(state?.canSummaryHome);
  const refineCard = active && phase !== "disposed" ? oralRefineCardId(state) : null;
  // Q29 (fix5): a refused start stays on this screen until the person leaves it; its exit names that refusal (П01).
  const study = state?.commands.study;
  const startRefused = usable && !assignment && study?.outcome === "rejected" && study.resolved?.kind === "session.start";

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

  const recovery = showRecovery && <section className="oral-recovery" aria-label={t.recovery}>
      {!automatic && state!.commands.study.pending && state!.commands.study.outcome === null && <p>{t.pendingStudy}</p>}
      {state!.commands.stop.pending && state!.commands.stop.outcome === null && <p>{t.pendingStop}</p>}
      {/* §4.1 «Правило кнопки» (C335; M-P03-9/10): visible and inactive while the write gate holds, with its wait. */}
      {gateHeld && state!.gate?.wait && <p role="status" className="command-note">{gateWaitText(language, state!.gate.wait)}</p>}
      <button type="button" disabled={refreshBusy || checkBlocked}
        onClick={() => { if (usable && !refreshBusy && !checkBlocked) void actions.refresh(); }}>{t.refresh}</button>
      {state!.canRetry.study && <button type="button" disabled={studyBlocked}
        onClick={() => { if (allowed(state!.canRetry.study) && !studyBlocked) void actions.retry("study"); }}>{t.retryStudy}</button>}
      {state!.canRetry.stop && <button type="button" disabled={stopBlocked}
        onClick={() => { if (allowed(state!.canRetry.stop) && !stopBlocked) void actions.retry("stop"); }}>{t.retryStop}</button>}
    </section>;

  // Q32: the same frame as the notice of a closed Mini App; the check of the open window stays only where it has work —
  // a failed read of the summary (its repeat) or an own action still pending — never for the other pair (C178).
  // P2-B (C537): the fresh closure of the own earlier session of the pair this window left — its reason and the explicit
  // way to Today only: no numbers of that pair (C178), no check, no notice (R22).
  const prior = active && phase === "idle" && state?.priorClosure && FORCED_ORAL_REASONS.includes(state.priorClosure.reason)
    ? state.priorClosure : null;
  if (prior) {
    const line = closedReasonLines[language][prior.reason as "midnight" | "timezone_date_changed" | "remote_stop" | "pair_changed"]
      ?? closedReasonLines[language].unknown;
    return <OralForcedSummary language={language} status={t.closed} reasonLine={line} counts={null} remaining={null}
      leaving={!!leaving} onToday={() => leaveForced(prior.sessionId)} />;
  }
  if (forced) {
    const counts = closedSummary?.summary ?? null, done = closedSummary?.progress ?? null;
    const lanesOpen = lanes.some(lane => lane.pending) || !!state?.canRetry.study || !!state?.canRetry.stop || !!problem;
    return <OralForcedSummary language={language} status={readFailed ? t.stale : t.closed} reasonLine={forcedLine!}
      counts={counts && { completed: counts.completed, correct: counts.correct, wrong: counts.wrong }}
      remaining={counts && done ? done.total - done.completed : null} leaving={!!leaving}
      noticeId={forcedNoticeId} onToday={() => leaveForced(forced.sessionId)}>
      {problem && <p role="status">{problem}</p>}
      {(readFailed || lanesOpen) && recovery}
    </OralForcedSummary>;
  }

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
      {/* R12-08 вар.2: the learner's own association stands in the German → native question, before and after «Раскрыть».
          `undefined` is an older core that sends none: no block, no invitation. The invitation opens М12 like «Уточнить поля». */}
      {assignment.prompt.association !== undefined && <AssociationBlock association={assignment.prompt.association} language={language}
        textLanguage={state!.current!.pair.split("-")[0]}
        invite={refineCard !== null && onRefineFields ? { onAdd: () => onRefineFields(refineCard, assignment.id) } : "text"} />}
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
      {closedSummary && noticeLines?.map((line, index) => <p key={index}>{line}</p>)}
      {closedSummary && noticeId && <NoticeShown noticeId={noticeId} />}
      <dl><div><dt>{t.completed}</dt><dd>{summary.completed}</dd></div><div><dt>{t.right}</dt><dd>{summary.correct}</dd></div>
        <div><dt>{t.errors}</dt><dd>{summary.wrong}</dd></div>{remaining !== null && <div><dt>{t.remaining}</dt><dd>{remaining}</dd></div>}</dl>
      <button type="button" disabled={!toToday || !!closedSummary && !!leaving}
        onClick={() => { if (closedSummary) onToday(); else if (allowed(state?.canSummaryHome)) void actions.stop("summary_home"); }}>{t.today}</button>
    </section>}
    {problem && <p role="status">{problem}</p>}
    {/* 9.2.12 + Q30: the closure C's own budget ran out with the session open; its action is «Повторить завершение». */}
    {usable && state?.closureFailed && <p role="status">{recoveryCopy[language].closeFailed}</p>}
    {/* WORKING STUB (Q34, C556 В3; text №16 waits for the owner), as the written screen: the send budget of this page cannot
      be opened, or the last «Начать» met damaged records; no study send was made. The general unavailability line. */}
    {usable && (state?.storageUnavailable || state?.startBlocked) && <p role="status">{t.disposed}</p>}
    {startRefused && <button type="button" className="oral-today"
      onClick={() => onToday(startRefusalIntent(study))}>{t.today}</button>}
    {recovery}
    {recovering && <RecoveryOverlay screen={recovering} language={language} canEnd={allowed(state?.canStop)}
      onEnd={() => { if (allowed(state?.canStop)) void actions.stop("stop"); }} />}
  </main>;
}
