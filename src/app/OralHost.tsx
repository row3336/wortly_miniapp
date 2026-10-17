import type { ForegroundIntent } from "./entryController";
import { useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { HttpOptions } from "../api/http";
import type { Language } from "../i18n/language";
import { OralScreen } from "../oral/OralScreen";
import type { OralSessionPendingStore, OralStopPendingStore } from "../oral/oralPending";
import { useOralDocument, type OralDocumentActions } from "../oral/useOralDocument";
import { acceptedForeignStart } from "../commands/foreignStart";
import { notifyAcceptedMilestone } from "../platform/telegram";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import type { OrdinaryQuiz } from "../today/TodayScreen";
import { useBackLayer } from "./navigationBack";
import type { OpenedAccess } from "./openedAccess";
import { noticePendingStart, useNoticePendingSignal } from "../notices/noticePending";
import { FORCED_ORAL_REASONS, NOTICE_ORAL_REASONS } from "../oral/OralScreen";
import type { ClosureNotices } from "../notices/noticeBoard";
import { useClosureNotice } from "../notices/useClosureNotice";

/** One pair per storage: the pending slots serialize through their shared in-memory queue. */
export type OralStores = { study: OralSessionPendingStore; stop: OralStopPendingStore };
export type OralHostOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  stores: OralStores;
  newId(): string;
  language: Language;
  /** The document's existing settings owner. */
  settings: SettingsDocument;
  minimumStateVersion?: string;
  /** Only a resume read that confirmed mode=oral supplies an active seed. */
  initialSessionId: string | null;
  /** A fresh mode read for the reported session is still unresolved. */
  seedPending: boolean;
  /** "today" only while the document would show Today; "hidden" keeps the owner without a screen. */
  route: "today" | "oral" | "hidden";
  onOral(): void;
  /** Navigation only: a confirmed closure, a rejected start or nothing left to show. */
  /** intent (fix4, П01): only from the screen of a start refused as SESSION_BUSY (startRefusalIntent). */
  onToday(intent?: ForegroundIntent): void | Promise<void>;
  /**
   * «Уточнить поля» (M-ORAL-ENTRY): the question's card opens on top of the quiz and Back returns to it. The oral quiz
   * never moves on by a card action (К07-080), so nothing is reported back.
   */
  onOpenCard?(cardId: string, details: { assignment: string }): void;
  /**
   * Answer 17.1-А (R1): this owner's accepted start made a session the server holds open in another pair. The document
   * refreshes its access once per such session and goes into it; the owner only reports it.
   */
  onForeignStart?(sessionId: string): void;
  /**
   * NOTICE_PENDING (project notices ed.2.4 §6.1): a start of this owner was refused because a notice waits. The document
   * reads GET /notices and shows it; the owner sends nothing more for that start (no new ID, no POST).
   */
  onNoticePending?(): void;
  /**
   * Q32 / Д4 (project notices ed.2.4 §6): the own session was closed by the calendar (midnight, a new date) — the only
   * causes with an oral_forced_close (NOTICE_ORAL_REASONS). The document reads GET /notices for it (Т2). Every forced
   * cause, these and remote_stop / pair_changed, keeps the owner on its summary with the reason (FORCED_ORAL_REASONS).
   */
  onForcedClosure?(sessionId: string): void;
  /**
   * The «На Сегодня» (and native Back) of a calendar summary: acknowledges the session's oral_forced_close, then goes to
   * Today; false when the
   * acknowledgement did not end (the summary stays and the press can be repeated, §5). Without it: plain onToday.
   */
  onLeaveForcedClosure?(sessionId: string): Promise<boolean>;
  /** The oral_forced_close of that session the document's board knows (named once its summary is drawn). */
  forcedNotice?(sessionId: string): string | null;
  /** answer_loss of a session this owner closed by its Stop with X (project notices §6; Т2). */
  closureNotices?: ClosureNotices;
};
export type OralHost = {
  /** Today waits for the first recovery and for own receipts or sessions it must show first. */
  blocksToday: boolean;
  canRequestStart: boolean;
  requestStart(quiz: OrdinaryQuiz): void;
  screen: ReactNode;
};

/** The reverse oral mode exists only for De→L1. */
export function oralBucket(quiz: OrdinaryQuiz): "words" | "phrases" | null {
  return quiz.direction === "de-l1" ? quiz.material : null;
}

type Lifetime = {
  key: string; pair: string; stores: OralStores; transport: HttpOptions; floor: string;
  request: { bucket: "words" | "phrases"; access: OpenedAccess } | null; starting: boolean;
  /** The start command resolved before this owner's own start, or false when no own start is awaited. */
  awaitingStart: string | null | false;
  recovered: boolean; claimed: string | null; idleNotified: boolean;
  notified: Set<string>; graded: string | null; completed: Set<string>;
  /** P2-B: the earlier sessions whose closure summary (priorClosure) the person already left by «На Сегодня» or Back. */
  priorLeft: Set<string>;
};

/** Route composition for the oral owner; Start is an explicit, cancellable UI event. */
export function useOralHost(options: OralHostOptions): OralHost {
  const latest = useRef(options); latest.current = options;
  const lifetime = useRef<Lifetime | null>(null);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const { access, route, seedPending } = options, pair = access.profile.dictionary_language;
  let bound = lifetime.current;
  if (!bound || bound.key !== access.key || bound.pair !== pair || bound.stores !== options.stores
    || bound.transport !== options.transport) {
    bound = { key: access.key, pair, stores: options.stores, transport: options.transport,
      floor: access.profile.state_version, request: null, starting: false, awaitingStart: false, recovered: false,
      claimed: null, idleNotified: false, notified: new Set(), graded: null, completed: new Set(), priorLeft: new Set() };
    lifetime.current = bound;
  }
  const confirmed = options.settings.confirmed;
  for (const version of [access.profile.state_version, options.minimumStateVersion,
    confirmed?.settings.dictionary_language.value === pair ? confirmed.state_version : undefined]) {
    if (version !== undefined && BigInt(version) > BigInt(bound.floor)) bound.floor = version;
  }
  // Settings identity only: oral has no timer and the server decides its own setup refusal.
  const gate = options.settings.state.phase === "ready" && options.settings.state.dataCurrent
    && !options.settings.state.pending && confirmed !== null && confirmed.settings.dictionary_language.value === pair
    && BigInt(confirmed.state_version) >= BigInt(bound.floor);
  const enabled = route === "oral" && gate && !seedPending;
  const { state, actions } = useOralDocument({ access, transport: options.transport, studyStore: options.stores.study,
    stopStore: options.stores.stop, newId: options.newId, initialSessionId: options.initialSessionId,
    minimumStateVersion: bound.floor, enabled });
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
    if (route === "hidden" || bound.request !== null && bound.request.access !== access || !gate || !access.isLive()) {
      bound.request = null;
    }
    if (!enabled || bound.request === null || bound.starting || state === null) return;
    // Consume before starting: re-renders and double taps cannot enqueue another start.
    const { bucket } = bound.request;
    bound.request = null; bound.starting = true;
    bound.awaitingStart = state.commands.study.resolved?.commandId ?? null;
    void actions.start(bucket).finally(() => {
      bound.starting = false;
      if (lifetime.current === bound) repaint();
    });
  }, [bound, route, access, gate, enabled, state, actions]);

  const study = state?.commands.study, stop = state?.commands.stop;
  // P2-B: the closure of the own earlier session of the left pair, while not left yet (forced causes only).
  const prior = state?.priorClosure ?? null;
  const shownPrior = prior && FORCED_ORAL_REASONS.includes(prior.reason) && !bound.priorLeft.has(prior.sessionId.toLowerCase())
    ? prior.sessionId : null;
  const shownState = state && state.priorClosure && shownPrior === null ? { ...state, priorClosure: undefined } : state;
  const lanesPending = !!study?.pending || !!stop?.pending;
  const live = state !== null && state.phase !== "disposed" && state.phase !== "loading";
  // Own receipts and a still open own session are shown before Today; a closed session is not resumed.
  const claim = live && (lanesPending || state.phase === "unknown"
    || state.sessionId !== null && state.phase !== "closed" && state.phase !== "idle")
    ? state.sessionId ?? study?.pendingIntent?.session_id ?? stop?.pendingIntent?.session_id ?? "receipt" : null;
  const resolvedStart = study?.resolved?.kind === "session.start" ? study.resolved.commandId : null;
  const startRefusedShown = resolvedStart !== null && study?.outcome === "rejected";
  useEffect(() => {
    const current = latest.current;
    if (current.route !== "oral") bound.idleNotified = false;
    if (current.route !== "today") bound.claimed = null;
    if (!state || state.phase === "disposed") return;
    if (resolvedStart && bound.awaitingStart !== false && resolvedStart !== bound.awaitingStart && study?.outcome === "accepted") {
      bound.awaitingStart = false;
      notifyAcceptedMilestone(window, "quiz-start");
    }
    const sessionId = state.sessionId?.toLowerCase() ?? null;
    if (state.phase === "summary" && sessionId !== null && bound.graded === sessionId && !bound.completed.has(sessionId)) {
      bound.completed.add(sessionId);
      notifyAcceptedMilestone(window, "quiz-complete");
    }
    if (current.route === "today" && claim !== null && bound.claimed !== claim) {
      bound.claimed = claim;
      current.onOral();
      return;
    }
    if (current.route !== "oral") return;
    // A rejected start leaves this owner unable to start again: Today is the only exit. Q29 (fix5): the refusal stays on
    // the oral screen until the person leaves it — its «На Сегодня» (the П01 intent of that command, OralScreen) or Back;
    // nothing goes to Today by itself, so no П01 episode is spent and no foreground is sent without a human action.
    if (startRefusedShown) {
      if (!bound.notified.has(resolvedStart!)) { bound.notified.add(resolvedStart!); bound.awaitingStart = false; }
      return;
    }
    // The own Stop shows its summary; a closure without the person (Q32: any proven cause) shows its summary with the
    // reason until «На Сегодня»; a calendar one also reads its notice (Т2). summary_home and the client's own automatic
    // closure return to Today once.
    const reason = state.closed?.reason ?? null;
    if (state.phase === "closed" && sessionId !== null && reason !== null && FORCED_ORAL_REASONS.includes(reason)) {
      if (!bound.notified.has(sessionId)) {
        bound.notified.add(sessionId);
        if (NOTICE_ORAL_REASONS.includes(reason)) current.onForcedClosure?.(sessionId);
      }
      return;
    }
    if (state.phase === "closed" && sessionId !== null && reason !== null && reason !== "stop" && !bound.notified.has(sessionId)) {
      bound.notified.add(sessionId);
      void current.onToday();
      return;
    }
    // P2-B (C537): the proven closure of the own earlier session of the left pair stays on screen until the explicit exit.
    if (shownPrior !== null) return;
    if (!current.seedPending && state.phase === "idle" && state.sessionId === null && !lanesPending
      && bound.request === null && !bound.starting && !bound.idleNotified) {
      bound.idleNotified = true;
      void current.onToday();
    }
  }, [bound, state, route, claim, resolvedStart, startRefusedShown, study?.outcome, lanesPending, options.seedPending, shownPrior]);

  const startedElsewhere = state && state.phase !== "disposed" ? acceptedForeignStart(study, state) : null;
  useEffect(() => { if (startedElsewhere !== null) latest.current.onForeignStart?.(startedElsewhere); }, [startedElsewhere]);
  useNoticePendingSignal(state && state.phase !== "disposed" ? noticePendingStart(study) : null, options.onNoticePending);
  // Q32: the «На Сегодня» of a summary closed without the person acknowledges its notice first; held while that runs.
  const leaving = useRef(false);
  const leaveForced = (sessionId: string) => {
    // P2-B: the earlier session of the left pair has no notice here (R22): plain navigation, remembered as left.
    const prior = latestState.current?.priorClosure;
    if (prior && prior.sessionId.toLowerCase() === sessionId.toLowerCase()) {
      bound.priorLeft.add(sessionId.toLowerCase()); repaint(); void latest.current.onToday(); return;
    }
    const leave = latest.current.onLeaveForcedClosure, reason = latestState.current?.closed?.reason ?? null;
    // remote_stop / pair_changed have no notice: plain navigation, no read and no acknowledgement.
    if (!leave || reason === null || !NOTICE_ORAL_REASONS.includes(reason)) { void latest.current.onToday(); return; }
    if (leaving.current) return;
    leaving.current = true; repaint();
    void leave(sessionId).finally(() => { leaving.current = false; if (lifetime.current === bound) repaint(); });
  };

  // answer_loss in the open window (§6): the own Stop's summary shows the notice's line; its «На Сегодня» acknowledges it.
  const closure = useClosureNotice({ notices: options.closureNotices,
    closed: state?.phase === "closed" && state.closed?.reason === "stop" ? state.closed : null,
    unsavedClosures: state?.unsavedClosures, language: options.language, visible: route === "oral" });
  const closureRef = useRef(closure); closureRef.current = closure;
  const leaveOwn = () => {
    if (closureRef.current.notice) closureRef.current.leave(() => { void latest.current.onToday(); });
    else void latest.current.onToday();
  };
  const screenActions = useMemo<OralDocumentActions>(() => ({ ...actions, grade: correct => {
    bound.graded = latestState.current?.sessionId?.toLowerCase() ?? null;
    return actions.grade(correct);
  } }), [actions, bound]);

  // Native Back runs the visible oral control (tz_app:86). While an already sent stop is awaited it stays visible
  // and does nothing: no second stop (К10-151).
  let back: (() => void) | null = null;
  if (route === "oral" && state && !seedPending && state.phase !== "disposed") {
    const awaitingStop = state.phase === "stopping" || !!stop?.pending || ["sending", "checking", "loading"].includes(stop?.phase ?? "");
    const ownSummary = state.phase === "closed" && state.closed?.reason === "stop" && state.closed.summaryRead === "known";
    const forcedSummary = state.phase === "closed" && state.closed !== null && state.closed.reason !== null
      && FORCED_ORAL_REASONS.includes(state.closed.reason) && (state.closed.summaryRead === "known" || state.closed.summaryRead === "failed");
    if (state.phase === "summary" && state.canSummaryHome) back = () => { void actions.stop("summary_home"); };
    else if (state.phase !== "closed" && state.canStop) back = () => { void actions.stop("stop"); };
    else if (ownSummary) back = leaveOwn;
    else if (forcedSummary) { const closedId = state.closed!.sessionId; back = () => leaveForced(closedId); }
    else if (shownPrior !== null) { const priorId = shownPrior; back = () => leaveForced(priorId); }
    else if (awaitingStop) back = () => {};
  }
  useBackLayer("screen", back);

  const requestStart = (quiz: OrdinaryQuiz) => {
    const bucket = oralBucket(quiz);
    if (bucket === null || !gate || bound.starting || bound.request || !access.isLive()) return;
    if (document.visibilityState === "visible") bound.request = { bucket, access };
    if (route !== "oral") options.onOral();
    repaint();
  };
  const openCard = options.onOpenCard
    ? (cardId: string, assignment: string) => latest.current.onOpenCard?.(cardId, { assignment }) : undefined;
  return {
    blocksToday: !bound.recovered || claim !== null,
    canRequestStart: gate,
    requestStart,
    screen: route === "oral" ? <OralScreen state={seedPending ? null : shownState} actions={screenActions} language={options.language}
      active onToday={intent => { if (intent === undefined && state?.closed?.reason === "stop") leaveOwn(); else void latest.current.onToday(intent); }}
      onRefineFields={openCard} onForcedToday={leaveForced} leaving={leaving.current || closure.leaving}
      noticeLines={closure.lines} noticeId={closure.notice?.notice_id ?? null}
      forcedNoticeId={state?.closed ? options.forcedNotice?.(state.closed.sessionId) ?? null : null} /> : null,
  };
}
