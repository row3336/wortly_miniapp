import { useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { HttpOptions } from "../api/http";
import { useBackLayer } from "../app/navigationBack";
import type { OpenedAccess } from "../app/openedAccess";
import type { Language } from "../i18n/language";
import { acceptedForeignStart } from "../commands/foreignStart";
import { notifyAcceptedMilestone } from "../platform/telegram";
import type { AsyncStorage } from "../platform/storage";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useWrittenDocument, type WrittenActions } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";

export type WrittenHostOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  storage: AsyncStorage;
  newId(): string;
  language: Language;
  /** The document's existing settings owner. */
  settings: SettingsDocument;
  minimumStateVersion?: string;
  /** Only a resume read that confirmed mode=written supplies an open session of this client (В02). */
  initialSessionId: string | null;
  /** "today" only while the document would show Today; "hidden" keeps the owner without a screen. */
  route: "today" | "written" | "hidden";
  onWritten(): void;
  /** Navigation only: a confirmed closure that shows no summary, or an explicit return. */
  onToday(): void | Promise<void>;
  /**
   * «Уточнить поля» (TA:115, К05-080): push the full card of the answered assignment; it returns to this quiz (M-CARD).
   * Without it the result offers no such button.
   */
  onOpenCard?(cardId: string, details: { assignment: string }): void;
  /**
   * Answer 17.1-А (R1): this owner's accepted start made a session the server holds open in another pair. The document
   * refreshes its access once per such session and goes into it; the owner only reports it.
   */
  onForeignStart?(sessionId: string): void;
};
/**
 * An accepted card study action of a card opened from this quiz (M-ACTIONS cardActionsController), or its manual interval
 * increase and that increase's undo (M-INTV).
 */
export type WrittenCardAction = {
  kind: "card.exclude" | "card.return" | "card.relearn" | "interval.increase" | "action.undo"; cardId: string; stateVersion: string;
};
export type WrittenHost = {
  /** Today waits for the first recovery and for own receipts or sessions it must show first. */
  blocksToday: boolean;
  canRequestStart: boolean;
  requestStart(bucket: "words" | "phrases"): void;
  /**
   * An exclude or relearn of the answered card moved the main written quiz on (TA:153, К07-070, К07-079): the quiz reads
   * its session at least as new as that action and, back on its route, goes on to the next question or the summary.
   * An increase or its undo only makes the session read at least that new: the increase ended the correction of the
   * earlier answer on the server (Т08, RA:181), the quiz shows that and stays on its step.
   */
  cardActionApplied(event: WrittenCardAction): void;
  screen: ReactNode;
};
const copy = {
  ru: { loading: "Загружаем занятие…", settings: "Для занятия нужно подтвердить настройки и текущую словарную пару.", refresh: "Обновить настройки", today: "На Сегодня" },
  uk: { loading: "Завантажуємо заняття…", settings: "Для заняття потрібно підтвердити налаштування та поточну словникову пару.", refresh: "Оновити налаштування", today: "На Сьогодні" },
  en: { loading: "Loading your session…", settings: "Confirm session settings and the current dictionary pair to study.", refresh: "Refresh settings", today: "Return to Today" },
} as const;

type Lifetime = {
  key: string; pair: string; storage: AsyncStorage; transport: HttpOptions; floor: string;
  /** The owner's session before a consumed request, or false when no own start is awaited. */
  request: { bucket: "words" | "phrases"; access: OpenedAccess } | null; starting: boolean; awaitingStart: string | null | false;
  recovered: boolean; claimed: string | null; idleNotified: boolean; notified: Set<string>; answered: Set<string>; completed: Set<string>;
  /** A confirmed exclude/relearn of the card on screen: «Дальше» once the session read after it is shown (M-ACTIONS Р4). */
  advance: string | null;
  /** The state version of that action: the session is read at least this new. Settings are not gated by it. */
  actionFloor: string;
};

/** Route composition of the written owner: a Today tap is one explicit, cancellable start request. */
export function useWrittenHost(options: WrittenHostOptions): WrittenHost {
  const latest = useRef(options); latest.current = options;
  const lifetime = useRef<Lifetime | null>(null);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const { access, route } = options, pair = access.profile.dictionary_language;
  let bound = lifetime.current;
  if (!bound || bound.key !== access.key || bound.pair !== pair || bound.storage !== options.storage || bound.transport !== options.transport) {
    bound = { key: access.key, pair, storage: options.storage, transport: options.transport, floor: access.profile.state_version,
      request: null, starting: false, awaitingStart: false, recovered: false, claimed: null, idleNotified: false,
      notified: new Set(), answered: new Set(), completed: new Set(), advance: null, actionFloor: access.profile.state_version };
    lifetime.current = bound;
  }
  const confirmed = options.settings.confirmed;
  for (const version of [access.profile.state_version, options.minimumStateVersion,
    confirmed?.settings.dictionary_language.value === pair ? confirmed.state_version : undefined]) {
    if (version !== undefined && BigInt(version) > BigInt(bound.floor)) bound.floor = version;
  }
  // The timer mode decides the result transition; a session never starts without a confirmed value (TA §5).
  const gate = options.settings.state.phase === "ready" && options.settings.state.dataCurrent && !options.settings.state.pending
    && confirmed !== null && confirmed.settings.dictionary_language.value === pair && confirmed.settings.transition_mode.value !== null
    && BigInt(confirmed.state_version) >= BigInt(bound.floor);
  const enabled = route === "written" && gate;
  const { state, actions } = useWrittenDocument({ access, storage: options.storage, transport: options.transport, newId: options.newId,
    transitionMode: confirmed?.settings.transition_mode.value ?? null, enabled,
    minimumStateVersion: BigInt(bound.actionFloor) > BigInt(bound.floor) ? bound.actionFloor : bound.floor,
    initialSessionId: options.initialSessionId });
  const latestState = useRef(state); latestState.current = state;
  if (state && state.phase !== "loading" && state.phase !== "disposed") bound.recovered = true;

  // Foreground invalidates an unconsumed tap as well as the owner's command rights.
  useEffect(() => {
    const cancel = () => { bound.request = null; };
    document.addEventListener("visibilitychange", cancel, true);
    window.addEventListener("pageshow", cancel, true);
    return () => {
      document.removeEventListener("visibilitychange", cancel, true);
      window.removeEventListener("pageshow", cancel, true);
    };
  }, [bound]);

  useEffect(() => {
    if (route === "hidden" || bound.request !== null && bound.request.access !== access || !gate || !access.isLive()) bound.request = null;
    if (!enabled || bound.request === null || bound.starting || state === null) return;
    // Consume before starting: re-renders and double taps cannot enqueue another start.
    const { bucket } = bound.request;
    bound.request = null; bound.starting = true;
    bound.awaitingStart = state.sessionId?.toLowerCase() ?? null;
    void actions.start(bucket).finally(() => {
      bound.starting = false;
      if (lifetime.current === bound) repaint();
    });
  }, [bound, route, access, gate, enabled, state, actions]);

  const primary = state?.commands.primary, stop = state?.commands.stop;
  const lanesPending = !!primary?.pending || !!stop?.pending;
  const live = state !== null && state.phase !== "disposed" && state.phase !== "loading";
  // Any closure but summary_home keeps its summary: the own Stop, and one not chosen here (Q27-А, TA:205).
  // A closure that answered the own «На Сегодня» is navigation, like summary_home itself (F1, C081).
  const ownSummary = state?.phase === "closed" && state.closed !== null && state.closed.reason !== "summary_home"
    && !state.closed.homeRequested;
  // Own receipts and a still open own session are shown before Today; a closed session never is.
  const claim = live && (lanesPending || state.phase === "unknown"
    || state.sessionId !== null && state.phase !== "closed" && state.phase !== "idle")
    ? state.sessionId ?? primary?.pendingIntent?.session_id ?? stop?.pendingIntent?.session_id ?? "receipt" : null;
  useEffect(() => {
    const current = latest.current;
    if (current.route !== "written") bound.idleNotified = false;
    if (current.route !== "today") bound.claimed = null;
    if (!state || state.phase === "disposed") return;
    const sessionId = state.sessionId?.toLowerCase() ?? null;
    // A projection of the new session exists only after the server accepted its start.
    if (bound.awaitingStart !== false && sessionId !== null && sessionId !== bound.awaitingStart
      && state.current?.session_id.toLowerCase() === sessionId) {
      bound.awaitingStart = false;
      notifyAcceptedMilestone(window, "quiz-start");
    }
    // Only a summary reached by this owner's own answer is an actual completion.
    if (state.phase === "summary" && sessionId !== null && bound.answered.has(sessionId) && !bound.completed.has(sessionId)) {
      bound.completed.add(sessionId);
      notifyAcceptedMilestone(window, "quiz-complete");
    }
    if (current.route === "today" && claim !== null && bound.claimed !== claim) {
      bound.claimed = claim;
      current.onWritten();
      return;
    }
    if (current.route !== "written") return;
    const closedId = state.closed?.sessionId.toLowerCase() ?? null;
    // summary_home returns to Today once; the own Stop and an external closure keep their «Занятие прервано» summary.
    if (state.phase === "closed" && closedId !== null && !ownSummary && !bound.notified.has(closedId)) {
      bound.notified.add(closedId);
      void current.onToday();
      return;
    }
    if (state.phase === "idle" && state.sessionId === null && !lanesPending && !state.problem
      && bound.request === null && !bound.starting && !bound.idleNotified) {
      bound.idleNotified = true;
      void current.onToday();
    }
  }, [bound, state, route, claim, lanesPending, ownSummary]);

  const startedElsewhere = state && state.phase !== "disposed" ? acceptedForeignStart(state.commands.primary, state) : null;
  useEffect(() => { if (startedElsewhere !== null) latest.current.onForeignStart?.(startedElsewhere); }, [startedElsewhere]);

  // root decision, pending owner (M-ACTIONS Р4): the quiz goes on by itself only from the result of that card, and only
  // after a read at least as new as the action (canNext needs a fresh projection); any other step means it already moved.
  useEffect(() => {
    if (bound.advance === null || route !== "written" || !state) return;
    if (state.phase === "result_correct" || state.phase === "result_wrong") {
      // Only the result of the excluded or relearnt card moves on; another card's result is the user's own step.
      if (state.resultCardId?.toLowerCase() !== bound.advance) { bound.advance = null; return; }
      if (!state.canNext) return;
      bound.advance = null;
      void actions.next();
      return;
    }
    if (["loading", "stale", "unknown", "changing_result", "undoing", "visible_unconfirmed", "submitting"].includes(state.phase)) return;
    bound.advance = null;
  }, [bound, route, state, actions]);

  const screenActions = useMemo<WrittenActions>(() => ({ ...actions, submit: flags => {
    const sessionId = latestState.current?.sessionId?.toLowerCase();
    if (sessionId) bound.answered.add(sessionId);
    return actions.submit(flags);
  } }), [actions, bound]);

  // Native Back runs the visible control (TA §4): exit is Stop without confirmation, the summary goes to Today.
  // While an already sent Stop is awaited it stays visible and sends nothing more (К10-151).
  let back: (() => void) | null = null;
  if (route === "written" && state && state.phase !== "disposed") {
    const awaitingStop = state.phase === "stopping" || !!stop?.pending || ["sending", "checking", "loading"].includes(stop?.phase ?? "");
    if (state.canSummaryHome) back = () => { void actions.stop("summary_home"); };
    else if (state.canStop) back = () => { void actions.stop("stop"); };
    else if (awaitingStop) back = () => {};
    else if (ownSummary || state.phase === "idle" && !lanesPending) back = () => { void latest.current.onToday(); };
  }
  useBackLayer("screen", back);

  const requestStart = (bucket: "words" | "phrases") => {
    if (bucket !== "words" && bucket !== "phrases" || !gate || bound.starting || bound.request || !access.isLive()) return;
    if (document.visibilityState === "visible") bound.request = { bucket, access };
    if (route !== "written") options.onWritten();
    repaint();
  };
  const cardActionApplied = (event: WrittenCardAction) => {
    // «Вернуть в повторы» never changes a running quiz (К07-085).
    if (event.kind === "card.return" || !/^[1-9][0-9]*$/.test(event.stateVersion)) return;
    // root decision, pending owner (M-INTV Р2): no «Дальше» after an increase or its undo, only a fresh session read.
    const moves = event.kind === "card.exclude" || event.kind === "card.relearn";
    if (moves) bound.advance = event.cardId.toLowerCase();
    if (BigInt(event.stateVersion) > BigInt(bound.actionFloor)) bound.actionFloor = event.stateVersion;
    repaint();
  };
  const openCard = options.onOpenCard
    ? (cardId: string, assignment: string) => latest.current.onOpenCard?.(cardId, { assignment }) : undefined;
  const t = copy[options.language];
  // The document owner is created in an effect after the first written render and reads its projection before it is live.
  // Until then the refusal below would flash on every return from Settings. A prefetched question that waits for
  // confirmed settings is not loading: it cannot finish without the user, so it keeps the refusal and its buttons.
  const settling = state === null ? access.isLive() && access.profile.access.status === "admitted"
    : state.phase === "loading" && !state.waitingForSettings;
  return {
    blocksToday: !bound.recovered || claim !== null,
    canRequestStart: gate,
    requestStart,
    cardActionApplied,
    screen: route !== "written" ? null : !gate && !live && settling ? <section className="written-screen" aria-busy="true">
      <p role="status">{t.loading}</p>
    </section> : !gate && !live ? <section className="written-screen" aria-label={t.settings}>
      <p role="status">{t.settings}</p>
      <button type="button" onClick={() => { void options.settings.actions.refresh(); }}>{t.refresh}</button>
      <button type="button" onClick={() => { void latest.current.onToday(); }}>{t.today}</button>
    </section> : state ? <WrittenScreen state={state} language={options.language} submitOnEnter actions={screenActions}
      onToday={() => { void latest.current.onToday(); }} onRefineFields={openCard} /> : null,
  };
}
