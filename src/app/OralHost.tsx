import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { HttpOptions } from "../api/http";
import type { Language } from "../i18n/language";
import { OralScreen } from "../oral/OralScreen";
import type { OralSessionPendingStore, OralStopPendingStore } from "../oral/oralPending";
import { useOralDocument, type OralDocumentActions } from "../oral/useOralDocument";
import { bindBackButton, notifyAcceptedMilestone } from "../platform/telegram";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import type { OrdinaryQuiz } from "../today/TodayScreen";
import type { OpenedAccess } from "./openedAccess";

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
  onToday(): void | Promise<void>;
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
      claimed: null, idleNotified: false, notified: new Set(), graded: null, completed: new Set() };
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
  const lanesPending = !!study?.pending || !!stop?.pending;
  const live = state !== null && state.phase !== "disposed" && state.phase !== "loading";
  // Own receipts and a still open own session are shown before Today; a closed session is not resumed.
  const claim = live && (lanesPending || state.phase === "unknown"
    || state.sessionId !== null && state.phase !== "closed" && state.phase !== "idle")
    ? state.sessionId ?? study?.pendingIntent?.session_id ?? stop?.pendingIntent?.session_id ?? "receipt" : null;
  const resolvedStart = study?.resolved?.kind === "session.start" ? study.resolved.commandId : null;
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
    // A rejected start leaves this owner unable to start again: Today is the only exit.
    if (resolvedStart && study?.outcome === "rejected" && !bound.notified.has(resolvedStart)) {
      bound.notified.add(resolvedStart); bound.awaitingStart = false;
      void current.onToday();
      return;
    }
    // The own Stop shows its summary; any other confirmed closure returns to Today once.
    const reason = state.closed?.reason ?? null;
    if (state.phase === "closed" && sessionId !== null && reason !== null && reason !== "stop" && !bound.notified.has(sessionId)) {
      bound.notified.add(sessionId);
      void current.onToday();
      return;
    }
    if (!current.seedPending && state.phase === "idle" && state.sessionId === null && !lanesPending
      && bound.request === null && !bound.starting && !bound.idleNotified) {
      bound.idleNotified = true;
      void current.onToday();
    }
  }, [bound, state, route, claim, resolvedStart, study?.outcome, lanesPending, options.seedPending]);

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
    if (state.phase === "summary" && state.canSummaryHome) back = () => { void actions.stop("summary_home"); };
    else if (state.phase !== "closed" && state.canStop) back = () => { void actions.stop("stop"); };
    else if (ownSummary) back = () => { void latest.current.onToday(); };
    else if (awaitingStop) back = () => {};
  }
  const backHandler = useRef<() => void>(() => {});
  // Only a committed screen supplies the handler; binding follows presence alone.
  useLayoutEffect(() => { if (back) backHandler.current = back; });
  const hasBack = back !== null;
  useEffect(() => hasBack ? bindBackButton(window, () => backHandler.current()) : undefined, [hasBack]);

  const requestStart = (quiz: OrdinaryQuiz) => {
    const bucket = oralBucket(quiz);
    if (bucket === null || !gate || bound.starting || bound.request || !access.isLive()) return;
    if (document.visibilityState === "visible") bound.request = { bucket, access };
    if (route !== "oral") options.onOral();
    repaint();
  };
  return {
    blocksToday: !bound.recovered || claim !== null,
    canRequestStart: gate,
    requestStart,
    screen: route === "oral" ? <OralScreen state={seedPending ? null : state} actions={screenActions} language={options.language}
      active onToday={() => { void latest.current.onToday(); }} /> : null,
  };
}
