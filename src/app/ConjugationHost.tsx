import { startRefusalIntent } from "../commands/startRefusal";
import type { ForegroundIntent } from "./entryController";
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import type { HttpOptions } from "../api/http";
import { acceptedForeignStart } from "../commands/foreignStart";
import type { CloseReason } from "../conjugation/conjugationDocumentController";
import type { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "../conjugation/conjugationPending";
import { ConjugationTestFlow, type ConjugationView, type FlowInput } from "../conjugation/conjugationTestFlow";
import { ConjugationTestScreen } from "../conjugation/ConjugationTestScreen";
import { useConjugationDocument } from "../conjugation/useConjugationDocument";
import type { Language } from "../i18n/language";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useBackLayer } from "./navigationBack";
import type { OpenedAccess } from "./openedAccess";
import { noticePendingStart, useNoticePendingSignal } from "../notices/noticePending";

/** One pair per storage: the pending slots serialize through their shared in-memory queue. */
export type ConjugationStores = { study: ConjugationSessionPendingStore; stop: ConjugationStopPendingStore };
export type ConjugationHostOptions = {
  access: OpenedAccess;
  transport: HttpOptions;
  stores: ConjugationStores;
  newId(): string;
  language: Language;
  /** The document's existing settings owner. */
  settings: SettingsDocument;
  minimumStateVersion?: string;
  /** Only a resume read that confirmed mode=conjugation supplies an active seed. */
  initialSessionId: string | null;
  /** A fresh mode read for the reported session is still unresolved. */
  seedPending: boolean;
  /** "today" only while the document would show Today; "hidden" keeps the owner without a screen. */
  route: "today" | "conjugation" | "hidden";
  onConjugation(): void;
  /** Navigation only: a summary_home closure, an explicit return or nothing left to show. */
  /** intent (fix4, П01): only from the screen of a start refused as SESSION_BUSY (startRefusalIntent). */
  onToday(intent?: ForegroundIntent): void | Promise<void>;
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
};
export type ConjugationHost = {
  /** Today waits for the first recovery and for own receipts or sessions it must show first. */
  blocksToday: boolean;
  canRequestStart: boolean;
  requestStart(): void;
  screen: ReactNode;
};

/**
 * Whether a confirmed closure leaves the conjugation screen by itself. Any closure not chosen through «На Сегодня»
 * keeps the closed screen with its actual server reason (RA:354, TA:205, CT:144; D-CONJ-HOST 5.1.2): the own Stop,
 * midnight, a changed date or pair, a Stop from another device. The automatic closure C adds save_failed here (CP4b).
 */
export function leavesToToday(reason: CloseReason | null): boolean {
  return reason === "summary_home";
}

/** Refusals of session.start that end this start for good (Ж01): no retry of the same ID can succeed. */
// NOTICE_PENDING (project notices ed.2.4 §6.1; core FINAL_START_CODES since a2c29f4): kept by its ID as well.
const finalStartRefusals: readonly string[] = ["SESSION_BUSY", "NO_MATERIAL", "SETUP_REQUIRED", "SESSION_CLOSED", "NOTICE_PENDING"];

// The written quiz's block for a start without confirmed settings (useWrittenHost.tsx). Not shared yet: src/written is
// owned by another package now (D-CONJ-HOST 5.2.12, deferred); the wording is the same, no new strings.
const copy = {
  ru: { settings: "Для занятия нужно подтвердить настройки и текущую словарную пару.", refresh: "Обновить настройки", today: "На Сегодня" },
  uk: { settings: "Для заняття потрібно підтвердити налаштування та поточну словникову пару.", refresh: "Оновити налаштування", today: "На Сьогодні" },
  en: { settings: "Confirm session settings and the current dictionary pair to study.", refresh: "Refresh settings", today: "Return to Today" },
} as const;

type Lifetime = {
  key: string; pair: string; stores: ConjugationStores; transport: HttpOptions; floor: string;
  request: OpenedAccess | null; starting: boolean;
  recovered: boolean; claimed: string | null; idleNotified: boolean; notified: Set<string>;
};

/** The flow's identity (TA:109): a new access object of the same document is no new identity, so neither the draft
 * nor the timer of a shown result starts anew after a return from the background. Same tuple as the hook's retention. */
function flowTuple(access: OpenedAccess): string {
  const { profile, document } = access;
  return JSON.stringify([profile.profile_id.toLowerCase(), document.clientInstanceId.toLowerCase(),
    document.documentId.toLowerCase(), document.epoch, profile.dictionary_language]);
}

/** Route composition of the conjugation test (М16/М17): hook, one flow and the screen; Start is an explicit, cancellable UI event. */
export function useConjugationHost(options: ConjugationHostOptions): ConjugationHost {
  const latest = useRef(options); latest.current = options;
  const lifetime = useRef<Lifetime | null>(null);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const { access, route, seedPending } = options, pair = access.profile.dictionary_language;
  let bound = lifetime.current;
  if (!bound || bound.key !== access.key || bound.pair !== pair || bound.stores !== options.stores
    || bound.transport !== options.transport) {
    bound = { key: access.key, pair, stores: options.stores, transport: options.transport, floor: access.profile.state_version,
      request: null, starting: false, recovered: false, claimed: null, idleNotified: false, notified: new Set() };
    lifetime.current = bound;
  }
  const confirmed = options.settings.confirmed;
  for (const version of [access.profile.state_version, options.minimumStateVersion,
    confirmed?.settings.dictionary_language.value === pair ? confirmed.state_version : undefined]) {
    if (version !== undefined && BigInt(version) > BigInt(bound.floor)) bound.floor = version;
  }
  // The timer mode decides the result transition (TA:109); a test never starts without a confirmed value, as written.
  const transitionMode = confirmed?.settings.transition_mode.value ?? null;
  const gate = options.settings.state.phase === "ready" && options.settings.state.dataCurrent
    && !options.settings.state.pending && confirmed !== null && confirmed.settings.dictionary_language.value === pair
    && transitionMode !== null && BigInt(confirmed.state_version) >= BigInt(bound.floor);
  const enabled = route === "conjugation" && gate && !seedPending;
  const { state, actions } = useConjugationDocument({ access, transport: options.transport, studyStore: options.stores.study,
    stopStore: options.stores.stop, newId: options.newId, initialSessionId: options.initialSessionId,
    minimumStateVersion: bound.floor, enabled });
  const latestState = useRef(state); latestState.current = state;
  if (state && state.phase !== "loading" && state.phase !== "disposed") bound.recovered = true;

  // Every way to Today leaves once per session: the flow's own (summary_home, «На Сегодня») and this host's.
  const leave = useRef((sessionId: string | null, intent?: ForegroundIntent) => {
    const owner = lifetime.current;
    if (owner && sessionId !== null) {
      if (owner.notified.has(sessionId)) return;
      owner.notified.add(sessionId);
    }
    void latest.current.onToday(intent);
  });
  // One flow for the hook's lifetime: its actions are stable and always reach the current document owner.
  // StrictMode runs the effect cleanup on a flow that stays in use; a disposed flow is final, so the effect replaces it.
  const [flowEpoch, replaceFlow] = useReducer((value: number) => value + 1, 0);
  const flow = useMemo(() => new ConjugationTestFlow({ actions, onChange: repaint,
    schedule: (delayMs, run) => { const timer = window.setTimeout(run, delayMs); return () => window.clearTimeout(timer); },
    onToday: () => leave.current(latestState.current?.sessionId?.toLowerCase() ?? null) }), [actions, flowEpoch]);
  useEffect(() => {
    if (flow.isDisposed) replaceFlow();
    return () => flow.dispose();
  }, [flow]);

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
    if (route === "hidden" || bound.request !== null && bound.request !== access || !gate || !access.isLive()) bound.request = null;
    // The controller refuses a start it may not make yet (its first recovery or a refresh still runs): the tap waits.
    if (!enabled || bound.request === null || bound.starting || !state?.canStart) return;
    // Consume before starting: re-renders and double taps cannot enqueue another start.
    bound.request = null; bound.starting = true;
    // pending owner answer 5.1.3 (D-CONJ-HOST): no haptic signal for the conjugation test until the owner decides.
    void actions.start().finally(() => {
      bound.starting = false;
      if (lifetime.current === bound) repaint();
    });
  }, [bound, route, access, gate, enabled, state, actions]);

  const study = state?.commands.study, stop = state?.commands.stop;
  const lanesPending = !!study?.pending || !!stop?.pending;
  const live = state !== null && state.phase !== "disposed" && state.phase !== "loading";
  // A start the server refused for good (C085): the refused session never opened, nothing of it is pending, so the test
  // has nothing to show or resume. Only such a proven refusal counts; an unknown outcome, a lost reply, a stale read or
  // a mismatch are not proof. (The server's finality of these codes: C-START-REFUSAL.)
  const refusedStart = live && !lanesPending && state.currentStep === null && study?.outcome === "rejected"
    && study.resolved?.kind === "session.start" && study.resolved.sessionId !== null && state.sessionId !== null
    && study.resolved.sessionId.toLowerCase() === state.sessionId.toLowerCase()
    && finalStartRefusals.includes(study.rejectionCode ?? "");
  // Own receipts and a still open own session are shown before Today; a closed session is not resumed, nor a refused start.
  const claim = live && !refusedStart && (lanesPending || state.phase === "unknown"
    || state.sessionId !== null && state.phase !== "closed" && state.phase !== "idle")
    ? state.sessionId ?? study?.sessionId ?? stop?.sessionId ?? "receipt" : null;
  const startedElsewhere = state && state.phase !== "disposed" ? acceptedForeignStart(study, state) : null;
  useEffect(() => { if (startedElsewhere !== null) latest.current.onForeignStart?.(startedElsewhere); }, [startedElsewhere]);
  useNoticePendingSignal(refusedStart ? noticePendingStart(study) : null, options.onNoticePending);
  useEffect(() => {
    const current = latest.current;
    if (current.route !== "conjugation") bound.idleNotified = false;
    if (current.route !== "today") bound.claimed = null;
    if (!state || state.phase === "disposed") return;
    if (current.route === "today" && claim !== null && bound.claimed !== claim) {
      bound.claimed = claim;
      current.onConjugation();
      return;
    }
    if (current.route !== "conjugation") return;
    // Q29 (owner's answer 12.10, variant 1; was «5.1.1» of D-CONJ-HOST): a refused start stays on the conjugation screen
    // as the module shows it, until the person leaves it (Back below); this host adds no automatic return and no text.
    const sessionId = state.sessionId?.toLowerCase() ?? null;
    if (state.phase === "closed" && leavesToToday(state.closed?.reason ?? null)) {
      leave.current(sessionId);
      return;
    }
    if (!current.seedPending && state.phase === "idle" && state.sessionId === null && !lanesPending
      && bound.request === null && !bound.starting && !bound.idleNotified) {
      bound.idleNotified = true;
      void current.onToday();
    }
  }, [bound, state, route, claim, lanesPending, options.seedPending]);

  // While the own start is on its way the selected session has no projection yet, which the module shows as a failed
  // refresh. The flow sees no snapshot then, so the screen loads (TA табл. 4.1; D-CONJ-HOST 3.6.3, H4). A refused start
  // still reaches the screen afterwards, as the module shows it (Q29 above).
  const masked = seedPending || bound.starting;
  const input: FlowInput = { source: { tuple: flowTuple(access), access }, state: masked ? null : state,
    transitionMode, active: enabled };
  const view: ConjugationView | null = route === "conjugation" ? flow.project(input) : null;
  // Every render commits its input after layout, before the screen confirms a shown question (ConjugationTestScreen).
  useLayoutEffect(() => { flow.commit(route === "conjugation" ? input : { ...input, active: false }); });

  // Native Back runs the visible control (TA:86): the summary goes home, a running test stops without confirmation,
  // a closed one returns to Today. While an already sent Stop is awaited it stays visible and does nothing (К10-151).
  let back: (() => void) | null = null;
  if (view && state && !seedPending && state.phase !== "disposed") {
    const awaitingStop = view.stopping || !!stop?.pending || ["sending", "checking", "loading"].includes(stop?.phase ?? "");
    if (view.screen === "summary" && view.canHome) back = () => flow.home();
    else if (view.screen !== "closed" && view.canStop) back = () => flow.stop();
    else if (view.screen === "closed") back = () => flow.today();
    // Q29 (was «5.1.1»): only an explicit Back leaves a refused start (C085); the screen and its wording stay as the module
    // has them, and nothing returns by itself. fix5 (C388): this Back is the exit of the shown refusal, so it names that
    // command (startRefusalIntent: SESSION_BUSY only) — the П01 episode of exactly it, as the «На Сегодня» of the other modes.
    else if (refusedStart) back = () => leave.current(state.sessionId?.toLowerCase() ?? null, startRefusalIntent(study));
    else if (awaitingStop) back = () => {};
  }
  useBackLayer("screen", back);

  const requestStart = () => {
    if (!gate || bound.starting || bound.request || !access.isLive()) return;
    if (document.visibilityState === "visible") bound.request = access;
    if (route !== "conjugation") options.onConjugation();
    repaint();
  };
  const t = copy[options.language];
  // The owner is created in an effect after the first render and reads its session before it is live: until then the
  // refusal below would flash on every return from Settings. A session that waits for confirmed settings (a form not shown
  // yet) is not loading: it cannot go on without the user, so it gets the refusal and its buttons, as in the written quiz.
  const settling = state === null ? access.isLive() && access.profile.access.status === "admitted" : state.phase === "loading";
  let screen: ReactNode = null;
  if (view && !gate && !masked && !settling && view.screen === "loading") {
    screen = <section className="learning-screen" aria-label={t.settings}>
      <p role="status">{t.settings}</p>
      <button type="button" onClick={() => { void options.settings.actions.refresh(); }}>{t.refresh}</button>
      <button type="button" onClick={() => { void latest.current.onToday(); }}>{t.today}</button>
    </section>;
  } else if (view) screen = <ConjugationTestScreen view={view} flow={flow} language={options.language} submitOnEnter />;
  return { blocksToday: !bound.recovered || claim !== null, canRequestStart: gate, requestStart, screen };
}
