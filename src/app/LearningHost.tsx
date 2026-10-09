import { useEffect, useReducer, useRef } from "react";
import type { HttpOptions } from "../api/http";
import type { Language } from "../i18n/language";
import { LearningScreen, type LearningScreenProps } from "../learning/LearningScreen";
import { useLearningDocument } from "../learning/useLearningDocument";
import type { AsyncStorage } from "../platform/storage";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import type { TodayScreenProps } from "../today/TodayScreen";
import { useBackLayer } from "./navigationBack";
import type { OpenedAccess } from "./openedAccess";
import { TodayHost } from "./TodayHost";

export type LearningHostProps = {
  access: OpenedAccess;
  transport: HttpOptions;
  storage: AsyncStorage;
  newId(): string;
  language: Language;
  /** The document's existing settings owner, with confirmation for the current access source. */
  settings: SettingsDocument;
  minimumStateVersion?: string;
  /** A session already verified as Learning by the document's mode read. */
  initialSessionId: string | null;
  route: "today" | "learning" | "settings";
  submitOnEnter: boolean;
  renderPreview: LearningScreenProps["renderPreview"];
  onLearning(): void;
  /** One automatic notification per confirmed closure, or explicit idle/closed navigation to Today. */
  onToday(): void | Promise<void>;
  onSettings(): void;
  /** Other sections reachable from Today; without it only Settings is. */
  onNavigate?(destination: "dictionary" | "statistics"): void;
  /** Ordinary quiz rows and the conjugation test of the Today screen this host renders; their owners live elsewhere in the document. */
  quizzes?: Pick<TodayScreenProps, "onStartQuiz" | "canStartQuiz" | "onStartConjugation">;
};

const copy = {
  ru: { loading: "Проверяем сохранённое занятие…", today: "На Сегодня", settings: "Настройки",
    pending: "Проверяем сохранение настроек. Начать занятие пока нельзя.",
    loadingSettings: "Загружаем настройки занятия.", failed: "Не удалось подтвердить настройки занятия.",
    incomplete: "Для занятия нужно подтвердить настройки и текущую словарную пару.", refresh: "Обновить настройки", check: "Проверить сохранённые действия" },
  uk: { loading: "Перевіряємо збережене заняття…", today: "На Сьогодні", settings: "Налаштування",
    pending: "Перевіряємо збереження налаштувань. Почати заняття поки не можна.",
    loadingSettings: "Завантажуємо налаштування заняття.", failed: "Не вдалося підтвердити налаштування заняття.",
    incomplete: "Для заняття потрібно підтвердити налаштування та поточну словникову пару.", refresh: "Оновити налаштування", check: "Перевірити збережені дії" },
  en: { loading: "Checking your saved session…", today: "Go to Today", settings: "Settings",
    pending: "Checking whether settings were saved. A session cannot start yet.",
    loadingSettings: "Loading session settings.", failed: "Could not confirm session settings.",
    incomplete: "Confirm session settings and the current dictionary pair to study.", refresh: "Refresh settings", check: "Check saved actions" },
} as const;

type Lifetime = {
  key: string; pair: string; storage: AsyncStorage; transport: HttpOptions;
  floor: string; requested: OpenedAccess | null; starting: boolean;
  routedSession: string | null; notifiedClosed: Set<string>;
};

/** Route composition keeps one command owner alive; Start is an explicit, cancellable UI event. */
export function LearningHost(props: LearningHostProps) {
  const latest = useRef(props); latest.current = props;
  const lifetime = useRef<Lifetime | null>(null);
  const [, repaint] = useReducer((value: number) => value + 1, 0);
  const pair = props.access.profile.dictionary_language;
  let bound = lifetime.current;
  if (!bound || bound.key !== props.access.key || bound.pair !== pair
    || bound.storage !== props.storage || bound.transport !== props.transport) {
    bound = { key: props.access.key, pair, storage: props.storage, transport: props.transport,
      floor: props.access.profile.state_version, requested: null, starting: false,
      routedSession: null, notifiedClosed: new Set() };
    lifetime.current = bound;
  }
  const confirmed = props.settings.confirmed;
  for (const version of [props.access.profile.state_version, props.minimumStateVersion,
    confirmed?.settings.dictionary_language.value === pair ? confirmed.state_version : undefined]) {
    if (version !== undefined && BigInt(version) > BigInt(bound.floor)) bound.floor = version;
  }
  const settingsReady = props.settings.state.phase === "ready" && props.settings.state.dataCurrent
    && !props.settings.state.pending && confirmed !== null;
  const configured = settingsReady && !confirmed.needs_setup && confirmed.settings.dictionary_language.value === pair
    && confirmed.settings.transition_mode.value !== null
    && BigInt(confirmed.state_version) >= BigInt(bound.floor);
  const enabled = props.route === "learning" && configured;
  const { state, actions } = useLearningDocument({ access: props.access, transport: props.transport,
    storage: props.storage, newId: props.newId, initialSessionId: props.initialSessionId,
    transitionMode: confirmed?.settings.transition_mode.value ?? null,
    enabled, minimumStateVersion: bound.floor });

  // Foreground invalidates an unconsumed tap as well as the hook's command rights.
  useEffect(() => {
    const cancel = () => { bound.requested = null; };
    document.addEventListener("visibilitychange", cancel, true);
    window.addEventListener("pageshow", cancel, true);
    return () => {
      document.removeEventListener("visibilitychange", cancel, true);
      window.removeEventListener("pageshow", cancel, true);
    };
  }, [bound]);

  useEffect(() => {
    if (props.route === "settings" || bound.requested !== null && bound.requested !== props.access
      || !configured || !props.access.isLive()) bound.requested = null;
    if (!enabled || bound.requested === null || bound.starting || state === null) return;
    // Consume before starting: re-renders and double taps cannot enqueue another start.
    bound.requested = null; bound.starting = true;
    void actions.start().finally(() => {
      bound.starting = false;
      if (lifetime.current === bound) repaint();
    });
  }, [bound, props.route, props.access, configured, enabled, state, actions]);

  const recoveredSession = state?.sessionId ?? state?.commands.primary.pendingIntent?.session_id
    ?? state?.commands.stop.pendingIntent?.session_id ?? null;
  useEffect(() => {
    if (props.route !== "today") bound.routedSession = null;
    if (!state || !recoveredSession || state.phase === "disposed") return;
    if (state.phase === "closed" && state.sessionId !== null) {
      if (bound.notifiedClosed.has(state.sessionId)) return;
      bound.notifiedClosed.add(state.sessionId);
      bound.requested = null;
      void latest.current.onToday();
      return;
    }
    // The real hook discovers durable primary/stop receipts even with a null open seed.
    // A deliberate visit to Settings must remain available during that recovery.
    if (props.route === "today" && bound.routedSession !== recoveredSession) {
      bound.routedSession = recoveredSession;
      latest.current.onLearning();
    }
  }, [bound, state?.sessionId, state?.phase, recoveredSession, props.route]);

  const requestStart = () => {
    if (bound.starting || bound.requested || !props.access.isLive()) return;
    if (configured && document.visibilityState === "visible") bound.requested = props.access;
    if (props.route !== "learning") props.onLearning();
    repaint();
  };
  const openSettings = () => { bound.requested = null; props.onSettings(); };

  // Native Back runs the visible Learning exit/return control (tz_app:86). While an already sent stop
  // is awaited it stays visible and does nothing: no second stop; waiting and retry stay on screen (К10-151).
  const stopLane = state?.commands.stop;
  const todayShown = state !== null && (state.phase === "idle" && state.sessionId === null || state.phase === "closed")
    && !state.commands.primary.pending && !state.commands.stop.pending && state.commands.canBegin && !bound.starting;
  let back: (() => void) | null = null;
  if (props.route === "learning" && state) {
    const closed = state.phase === "closed" || state.phase === "disposed";
    const awaitingStop = state.phase !== "disposed" && stopLane !== undefined && (state.phase === "stopping"
      || stopLane.pending || ["sending", "checking", "loading"].includes(stopLane.phase));
    if (!closed && state.canStop) {
      const reason = state.phase === "summary" ? "summary_home" : "stop";
      back = () => { void actions.stop(reason); };
    } else if (todayShown) back = () => { void latest.current.onToday(); };
    else if (awaitingStop) back = () => {};
  }
  useBackLayer("screen", back);

  const t = copy[props.language];
  if (props.route === "settings") return null;
  if (props.route === "today") {
    // Never falsify access.session to evade TodayHost's existing resume placeholder.
    // The document must supply a fresh open after the closed notification.
    if (props.access.session !== null || state === null || state.phase === "loading"
      || recoveredSession !== null && state.phase !== "closed") {
      return <p role="status">{t.loading}</p>;
    }
    return <TodayHost access={props.access} transport={props.transport} language={props.language}
      onOpenLearning={requestStart} enabledDestinations={props.onNavigate ? ["settings", "dictionary", "statistics"] : ["settings"]}
      onStartQuiz={props.quizzes?.onStartQuiz} canStartQuiz={props.quizzes?.canStartQuiz}
      onStartConjugation={props.quizzes?.onStartConjugation}
      onNavigate={destination => {
        if (destination === "settings") openSettings();
        else if (destination !== "today") { bound.requested = null; props.onNavigate?.(destination); }
      }} />;
  }
  return <>
    {configured && <button type="button" onClick={openSettings}>{t.settings}</button>}
    {!configured && <section aria-label={t.settings}>
      <p role="status">{props.settings.state.pending ? t.pending
        : props.settings.state.phase === "loading" ? t.loadingSettings
        : props.settings.state.problem ? t.failed : t.incomplete}</p>
      <button type="button" onClick={openSettings}>{t.settings}</button>
      <button type="button" onClick={() => { void props.settings.actions.refresh(); }}>{t.refresh}</button>
    </section>}
    {state ? <LearningScreen state={state} actions={actions} language={props.language}
      submitOnEnter={props.submitOnEnter} renderPreview={props.renderPreview} /> : <p role="status">{t.loading}</p>}
    {/* A study result left after the closure is checked by its automatic recovery, never by hand (Я15, CT §6.1 п. 2). */}
    {state?.phase === "closed" && (state.commands.primary.pending && !state.commands.automaticPrimary || state.commands.stop.pending)
      && <button type="button" onClick={() => { void actions.refresh(); }}>{t.check}</button>}
    {state && (state.phase === "idle" && state.sessionId === null || state.phase === "closed")
      && !state.commands.primary.pending && !state.commands.stop.pending && state.commands.canBegin
      && !bound.starting && <button type="button" onClick={() => { void props.onToday(); }}>{t.today}</button>}
  </>;
}
