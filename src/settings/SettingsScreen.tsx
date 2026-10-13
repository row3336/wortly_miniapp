import { useEffect, useId, useRef, useState } from "react";
import type { SettingConstraint, Topic } from "../api/generated";
import { BottomNav } from "../app/BottomNav";
import type { FeedbackDocument } from "../feedback/useFeedbackDocument";
import type { Language } from "../i18n/language";
import { t as appText, navigationText } from "../i18n/messages";
import { storedOnly, type MainSettingKey, type SettingKey } from "./settingsApi";
import type { SettingsController, SettingsSnapshot } from "./settingsController";
import { catalogAllows, MaterialEditor, materialParts, type CatalogState } from "./MaterialEditor";
import { SettingsFeedback } from "./SettingsFeedback";
import { SettingsResetDialog } from "./SettingsResetDialog";
import { languageChosen } from "./dictionaryChoice";
import { dictionaryChoiceCopy } from "./dictionaryChoiceCopy";
import { languageNames, settingsCopy } from "./settingsCopy";
import { NotificationsPanel } from "./NotificationsPanel";
import { notificationsCopy } from "./notificationsCopy";
import "./settings.css";

type Actions = Pick<SettingsController, "edit" | "save" | "acceptCurrent" | "keepMine" | "refresh" | "retry" | "reset" | "continueWithServer">
  & Partial<Pick<SettingsController, "cancelStored">>;
export type SettingsScreenProps = {
  snapshot: SettingsSnapshot;
  catalog: CatalogState;
  language: Language;
  actions: Actions;
  onReloadTopics(): void;
  onToday(): void;
  /** The Dictionary section of the main navigation; without it the panel shows it unavailable. */
  onDictionary?(): void;
  /** The message to the developer, owned by the document; without it the group is not shown. */
  feedback?: FeedbackDocument;
  /** False while the panel is hidden (another section is shown); a focus move waits until it is shown. Default: shown. */
  active?: boolean;
  /**
   * The inner view of Settings (project_notifications §8.1): the main screen M10 or the submenu «Уведомления». The host owns
   * it; without `onView` the row to the submenu is not shown. Default: main.
   */
  view?: SettingsView;
  onView?(view: SettingsView): void;
  /** «Открыть бота» in the submenu before the bot is opened (R12-15). */
  onOpenBot?(): void;
};
export type SettingsView = "main" | "notifications";
const groups: Array<{ name: "languages" | "learning" | "checking" | "additional"; fields: MainSettingKey[] }> = [
  { name: "languages", fields: ["ui_language", "dictionary_language"] },
  { name: "learning", fields: ["material", "learning_group_size", "learning_content", "review_error_mode", "transition_mode"] },
  { name: "checking", fields: ["strict_case", "include_preterite", "include_comparative"] },
  // R14-02: the Learning reminder pause is no setting any more; its group is gone and the row «Уведомления» follows here.
  { name: "additional", fields: ["learning_intervals_seconds", "learning_mix", "retry_gap", "retry_count"] },
];

function displayValue(value: unknown, key: SettingKey, language: Language, topics: readonly Topic[] | null = null): string {
  const t = settingsCopy[language];
  if (value === null || value === undefined) return t.notSet;
  if (typeof value === "boolean") return value ? t.on : t.off;
  if (key === "material") {
    const material = materialParts(value);
    if (material.mode === "level") return `${t.level}: ${material.level}`;
    const names = material.topics.map(id => {
      const topic = topics?.find(item => item.id.toLowerCase() === id.toLowerCase());
      return topic ? `${topic.number}. ${topic.german_name}` : null;
    });
    return names.some(name => name === null) ? t.currentTopicsMissing : names.join("; ");
  }
  if (key === "ui_language" || key === "dictionary_language") return languageNames[String(value)] ?? t.notSet;
  if (key === "transition_mode") return value === "accelerated" ? t.accelerated : t.normal;
  if (key === "review_error_mode") return t.reviewModes[String(value)] ?? String(value);
  if (key === "learning_content") return t.learningContents[String(value)] ?? String(value);
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function bounds(rule: SettingConstraint, language: Language): string | null {
  const list = rule.type === "ordered_integer_list";
  const a = list ? rule.item_minimum : rule.minimum;
  const b = list ? rule.item_maximum : rule.maximum;
  return typeof a === "number" && typeof b === "number" ? settingsCopy[language].bounds(a, b) : null;
}

/**
 * The dictionary language once chosen (19.2-А): shown, never offered for change. A draft or a refused intent of another
 * language may remain in the owner; it is not shown as the field's value and offers no save, so nothing waits on it.
 */
function LockedLanguage({ snapshot, language }: Pick<SettingsScreenProps, "snapshot" | "language">) {
  const id = useId(), t = settingsCopy[language], lock = dictionaryChoiceCopy[language];
  const current = snapshot.data!.settings.dictionary_language;
  const outcome = snapshot.outcome?.key === "dictionary_language" ? snapshot.outcome : null;
  return <section className="settings-field" role="group" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{t.fields.dictionary_language}</h3>
    <p>{displayValue(current.value, "dictionary_language", language)}</p>
    <p className="settings-help">{lock.locked}</p>
    <div className="settings-error" aria-live="polite">
      {outcome?.status === "rejected" && outcome.code === "DICTIONARY_LANGUAGE_LOCKED" && <p>{lock.lockedRefusal}</p>}
      {/* A first choice that met an earlier one: no claim about where it was made, only the pair now chosen. */}
      {outcome?.status === "rejected" && outcome.code === "VERSION_CONFLICT"
        && <p>{lock.confirmed(lock.pairs[current.value as Language] ?? displayValue(current.value, "dictionary_language", language))}</p>}
    </div>
    <div className="settings-actions">
      {/* An unresolved save keeps its existing line; after a known refusal the top line explains it. */}
      {snapshot.pending?.intent.payload.key === "dictionary_language" && !knownRefusal(snapshot)
        && <span role="status">{snapshot.phase === "sending" ? t.saving : t.unknown}</span>}
      {outcome?.status === "accepted" && <span className="settings-saved" role="status">{t.saved}</span>}
    </div>
  </section>;
}

function SettingField({ setting, ...props }: SettingsScreenProps & { setting: MainSettingKey }) {
  const { snapshot, language, actions, catalog, onReloadTopics } = props;
  const id = useId(), t = settingsCopy[language];
  const data = snapshot.data!;
  const current = data.settings[setting];
  const draft = snapshot.drafts[setting];
  const value = draft ? draft.input : current.value;
  const rule = data.constraints[setting];
  const title = t.fields[setting];
  const allowedCatalog = setting !== "material" || catalogAllows(value, catalog);
  const readableConflict = setting !== "material" || catalogAllows(current.value, catalog);
  const choices = setting === "ui_language" || setting === "dictionary_language"
    ? ["uk", "en", "ru"].filter(item => rule.values?.includes(item)) : rule.values ?? [];
  const busy = ["loading", "checking", "sending"].includes(snapshot.phase);
  const outcome = snapshot.outcome?.key === setting ? snapshot.outcome : null;
  const help = bounds(rule, language);
  const hint = t.hints[setting];
  // 2.21г, 2.25а: a CEFR level picks words at random, so Mix is always muted and locked; an unset Mix is shown as off
  // and never blocks a start.
  const mixByLevel = setting === "learning_mix" && materialParts(data.settings.material.value).mode === "level";
  const mixLocked = mixByLevel;
  const mixNote = mixByLevel ? t.mixByLevel.locked : null;
  const describedBy = `${hint ? `${id}-hint ` : ""}${mixNote ? `${id}-mix-note ` : ""}${id}-help ${id}-error`;
  // Fixed two or three way switches are shown as radios; the options still come from the server constraint.
  const radioChoice = rule.type === "enum" && (setting === "review_error_mode" || setting === "learning_content");
  const change = (next: unknown) => actions.edit(setting, next);
  const inputProps = { id: `${id}-input`, disabled: !snapshot.canEdit,
    "aria-labelledby": `${id}-title`, "aria-describedby": describedBy, "aria-invalid": draft?.valid === false };

  return <section className={mixByLevel ? "settings-field settings-field-muted" : "settings-field"} role="group" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{title}</h3>
    {rule.type === "integer" && <input {...inputProps} type="text" inputMode="numeric"
      value={typeof value === "number" || typeof value === "string" ? value : ""}
      onChange={event => change(event.target.value)} />}
    {rule.type === "enum" && !radioChoice && <select {...inputProps} value={typeof value === "string" ? value : ""}
      onChange={event => change(event.target.value)}>
      <option value="" disabled>{t.choose}</option>
      {typeof value === "string" && value && !choices.includes(value)
        && <option value={value} disabled>{displayValue(value, setting, language)}</option>}
      {choices.map(item => <option key={item} value={item}>{displayValue(item, setting, language)}</option>)}
    </select>}
    {radioChoice && <div className="settings-options">
      {[...(typeof value === "string" && value && !choices.includes(value) ? [value] : []), ...choices].map(item => <label key={item}>
        <input type="radio" name={`${id}-choice`} value={item} checked={value === item}
          disabled={!snapshot.canEdit || !choices.includes(item)} onChange={() => change(item)}
          aria-describedby={describedBy} />
        {displayValue(item, setting, language)}
      </label>)}
    </div>}
    {rule.type === "boolean" && <div className="settings-options">
      {[true, false].map(choice => <label key={String(choice)}>
        <input type="radio" name={`${id}-boolean`} checked={value === choice || (mixLocked && value === null && !choice)} disabled={!snapshot.canEdit || mixLocked}
          onChange={() => change(choice)} aria-describedby={describedBy} />
        {choice ? t.on : t.off}
      </label>)}
    </div>}
    {rule.type === "ordered_integer_list" && <div className="settings-intervals">
      <p className="settings-help">{t.intervalsHint}</p>
      {(Array.isArray(value) ? value : []).map((item, index, items) => <div className="settings-interval" key={index}>
        <label className="settings-label" htmlFor={`${id}-${index}`}>{t.interval} {index + 1}
          <input id={`${id}-${index}`} type="text" inputMode="numeric" disabled={!snapshot.canEdit}
            value={typeof item === "string" || typeof item === "number" ? item : ""}
            aria-describedby={`${id}-help ${id}-error`} aria-invalid={draft?.valid === false}
            onChange={event => change(items.map((old, position) => position === index ? event.target.value : old))} />
        </label>
        <button className="settings-secondary" type="button" disabled={!snapshot.canEdit}
          aria-label={`${t.removeInterval} ${index + 1}`} onClick={() => change(items.filter((_, position) => position !== index))}>{t.removeInterval}</button>
      </div>)}
      <button className="settings-secondary" type="button" disabled={!snapshot.canEdit}
        onClick={() => change([...(Array.isArray(value) ? value : []), ""])}>{t.addInterval}</button>
    </div>}
    {rule.type === "exclusive_choice" && <MaterialEditor input={value} constraint={rule} catalog={catalog}
      language={language} disabled={!snapshot.canEdit} id={id} onChange={change} onReload={onReloadTopics} />}
    {hint && <p id={`${id}-hint`} className="settings-help">{hint}</p>}
    {mixNote && <p id={`${id}-mix-note`} className="settings-help">{mixNote}</p>}
    <p id={`${id}-help`} className="settings-help">{help}{current.value === null && !draft ? ` ${t.notSet}` : ""}</p>
    <div id={`${id}-error`} className="settings-error" aria-live="polite">
      {draft?.error === "invalid" && <p>{t.invalid}</p>}
      {draft?.error === "version_exhausted" && <p>{t.exhausted}</p>}
      {draft?.error === "rejected" && <p>{t.rejected}</p>}
      {draft?.conflict && <div className="settings-conflict">
        <p>{t.conflict}</p><p>{t.current}: {displayValue(current.value, setting, language, catalog.topics)}</p>
        {!readableConflict && materialParts(value).mode !== "topics" && <button type="button" className="settings-secondary"
          onClick={onReloadTopics} disabled={catalog.phase === "loading"}>{t.topicsRefresh}</button>}
        <div className="settings-actions">
          <button type="button" className="settings-secondary" disabled={!snapshot.canEdit || busy || !readableConflict}
            onClick={() => actions.acceptCurrent(setting)}>{t.acceptCurrent}</button>
          <button type="button" className="settings-primary" disabled={!draft.canKeepMine || !allowedCatalog || !readableConflict}
            onClick={() => { void actions.keepMine(setting); }}>{t.keepMine}</button>
        </div>
      </div>}
    </div>
    <div className="settings-actions">
      {!draft?.conflict && <button type="button" className="settings-primary"
        disabled={!draft?.canSave || !allowedCatalog} onClick={() => { void actions.save(setting); }}>{t.save}</button>}
      {/* After a known refusal the top line explains it; t.unknown would promise a repeat that is not offered. */}
      {snapshot.pending?.intent.payload.key === setting && !knownRefusal(snapshot) && !snapshot.pending.mismatch
        && <span role="status">{snapshot.phase === "sending" ? t.saving : t.unknown}</span>}
      {outcome?.status === "accepted" && <span className="settings-saved" role="status">{t.saved}</span>}
    </div>
  </section>;
}

function knownRefusal(snapshot: SettingsSnapshot): boolean {
  return snapshot.problem?.reason === "incompatible" || snapshot.problem?.reason === "command_refused";
}

/** The top line's wording for the current problem. */
export function problemText(snapshot: SettingsSnapshot, language: Language): string {
  const t = settingsCopy[language], reason = snapshot.problem!.reason;
  // Exactly CLIENT_INCOMPATIBLE of a command: the app's text for that refusal (CommandRecovery). Working text, G05 open.
  if (reason === "incompatible") return appText(language).commandIncompatible;
  // A known 422 of this attempt, the outcome of earlier ones still unconfirmed. Working text, pending owner.
  if (reason === "command_refused") return snapshot.resetPending ? t.refusedAttempt.reset : t.refusedAttempt.save;
  if (reason === "mismatch" && snapshot.canContinueWithServer) return t.mismatchContinue;
  if (snapshot.resetPending && (reason === "network" || reason === "not_found")) return t.reset.unknown;
  // A mismatched save is never repeated: its failed check leads to the refresh, not to "retry sending".
  if (snapshot.pending?.mismatch && reason === "network") return t.mismatchRefresh;
  return snapshot.pending && reason === "network" ? t.unknown : t.problems[reason];
}

/**
 * The one line that reports a sent reset, next to its button; the screen's top lines then stay silent about it, so a
 * state is shown and announced once. Д2.1.9 asks to retry, so it is the line only while the retry is available: not
 * during a status check, nor for client_changed, pending_changed or mismatch (their own top-line texts apply).
 */
function resetLine(snapshot: SettingsSnapshot): "sending" | "unknown" | null {
  if (!snapshot.data || !snapshot.resetPending) return null;
  if (snapshot.phase === "sending") return "sending";
  return snapshot.canRetry && !!snapshot.problem && ["network", "not_found"].includes(snapshot.problem.reason) ? "unknown" : null;
}

/**
 * Returning the initial settings (TA 12.4): the button opens the Q08 confirmation; only «Вернуть» sends, and the
 * result is shown once the server answered. An unknown outcome is retried with the same command from here.
 */
function SettingsReset({ snapshot, language, onReset, onRetry }: { snapshot: SettingsSnapshot; language: Language;
  onReset(): void; onRetry(): void }) {
  const t = settingsCopy[language].reset;
  const [asking, setAsking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const status = useRef<HTMLDivElement>(null);
  // The button is disabled as soon as the reset is sent, so focus would fall to the page; it moves to the
  // result instead. This runs after the closed window returned focus to the button.
  useEffect(() => { if (confirmed) { setConfirmed(false); status.current?.focus(); } }, [confirmed]);
  const line = resetLine(snapshot), outcome = snapshot.resetOutcome;
  return <div className="settings-group settings-reset">
    <div className="settings-actions">
      <button type="button" className="settings-secondary" disabled={!snapshot.canReset} onClick={() => setAsking(true)}>{t.button}</button>
      <div className="settings-reset-status" ref={status} tabIndex={-1}>
        {line === "sending" && <span role="status">{t.sending}</span>}
        {line === "unknown" && <p className="settings-error" role="alert">{t.unknown}</p>}
        {line === "unknown" && <button className="settings-secondary" type="button" onClick={onRetry}>{settingsCopy[language].retry}</button>}
        {outcome?.status === "accepted" && <span className="settings-saved" role="status">{t.done}</span>}
        {outcome?.status === "rejected" && <p className="settings-error" role="alert">{t.failed}</p>}
      </div>
    </div>
    {asking && <SettingsResetDialog language={language} canConfirm={snapshot.canReset} onCancel={() => setAsking(false)}
      onConfirm={() => { setAsking(false); setConfirmed(true); onReset(); }} />}
  </div>;
}

/** Presentation only: callbacks retain command identity and lifetime in the host/controller. */
export function SettingsScreen(props: SettingsScreenProps) {
  const { snapshot, language, actions, onToday, onDictionary, feedback, active } = props;
  const t = settingsCopy[language];
  const busy = ["loading", "checking", "sending"].includes(snapshot.phase);
  const line = resetLine(snapshot);
  // Leaving a mismatch (Q36): the button disappears when pressed, so focus moves to a status region with the result,
  // as for the reset. "settled" means the action returned; the result is read once the snapshot is no longer busy.
  const [leaving, setLeaving] = useState<null | "running" | "settled" | "done" | "failed">(null);
  const leavingStatus = useRef<HTMLDivElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The button offered again means nothing changed: it takes back the focus the region held, and no result line is needed.
    if ((leaving === "settled" && !busy || leaving === "done" || leaving === "failed") && snapshot.canContinueWithServer) {
      if (document.activeElement === leavingStatus.current) continueButton.current?.focus();
      setLeaving(null);
    } else if (leaving === "settled" && !busy) setLeaving(!snapshot.pending && !snapshot.problem ? "done" : "failed");
  }, [leaving, busy, snapshot.pending, snapshot.problem, snapshot.canContinueWithServer]);
  useEffect(() => {
    // The pressed button disappears, so focus moves to the region at once. The result takes it only if the user has not moved it elsewhere.
    const active = document.activeElement;
    if (leaving === "running" || (leaving === "done" || leaving === "failed")
      && (!active || active === document.body || active === leavingStatus.current)) leavingStatus.current?.focus();
  }, [leaving]);
  // R9-01: a live mismatch is followed by an automatic read, so the continuation appears with no press of the user. The button
  // that was pressed to save (and the refresh button) are disabled while it runs and focus falls to the page. When the
  // read ends for a marked save, the offered action takes focus (or, if the read failed, the refresh button, the manual
  // way on), once per result, and never from an element the user has moved focus to. A result that arrives while the
  // panel is hidden (the user left Settings) waits and takes focus when the panel is shown again.
  const offered = useRef(false), wasBusy = useRef(busy), focusDue = useRef(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const marked = snapshot.pending?.mismatch === true;
  useEffect(() => {
    const was = offered.current, wasWorking = wasBusy.current;
    offered.current = snapshot.canContinueWithServer; wasBusy.current = busy;
    if (leaving) { focusDue.current = false; return; }
    if (snapshot.canContinueWithServer && !was || wasWorking && !busy && marked) focusDue.current = true;
    if (!focusDue.current || busy || active === false) return;
    focusDue.current = false;
    const current = document.activeElement as HTMLElement | null;
    if (current && current !== document.body && !(current as HTMLButtonElement).disabled && current.isConnected
      && !current.closest("[hidden]")) return;
    (snapshot.canContinueWithServer ? continueButton : refreshButton).current?.focus();
  }, [snapshot.canContinueWithServer, busy, marked, leaving, active]);
  // A new save is a new operation: the old result line is not left beside it.
  const clearResult = () => setLeaving(state => state === "done" || state === "failed" ? null : state);
  const fieldProps = { ...props, actions: { ...actions, save: (key: SettingKey) => { clearResult(); return actions.save(key); } } };
  const leave = () => {
    setLeaving("running");
    void actions.continueWithServer().finally(() => setLeaving(state => state === "running" ? "settled" : state));
  };
  const { view = "main", onView, onOpenBot } = props;
  const notifications = view === "notifications", n = notificationsCopy[language];
  // A changed view moves focus to its start: the submenu's title, or back to the row that opened it.
  const title = useRef<HTMLHeadingElement>(null), row = useRef<HTMLButtonElement>(null), viewShown = useRef(view);
  useEffect(() => {
    if (viewShown.current === view) return;
    viewShown.current = view;
    if (active !== false) (view === "notifications" ? title : row).current?.focus();
  }, [view, active]);
  return <main className="settings-screen" lang={language}>
    <header className="settings-header">
      {notifications && <button type="button" className="settings-secondary" onClick={() => onView?.("main")}>{navigationText(language).back}</button>}
      <h1 ref={title} tabIndex={-1}>{notifications ? n.title : t.title}</h1>
      <button type="button" className="settings-secondary" disabled={busy} ref={refreshButton}
        onClick={() => { setLeaving(null); void actions.refresh(); }}>{t.refresh}</button>
    </header>
    {busy && line !== "sending" && leaving !== "running" && leaving !== "settled" && <p role="status">{snapshot.phase === "sending" ? snapshot.resetPending ? t.reset.sending : t.saving
      : snapshot.data ? t.refreshing : t.loading}</p>}
    {leaving && <div className="settings-continue-status" ref={leavingStatus} tabIndex={-1}>
      {leaving === "done" ? <span className="settings-saved" role="status">{t.continued}</span>
        : leaving === "failed" ? <span className="settings-error" role="status">{t.continueFailed}</span>
        : <span role="status">{t.refreshing}</span>}
    </div>}
    {/* The reset's own line sits beside its button on the main view; the submenu has no such button, so it shows the problem here. */}
    {snapshot.problem && (line !== "unknown" || notifications) && <div className="settings-error" role="alert">
      <p>{problemText(snapshot, language)}</p>
      {snapshot.canRetry && <button className="settings-secondary" type="button" onClick={() => { void actions.retry(); }}>{t.retry}</button>}
      {/* R2-09 / P5-013: the explicit cancel of a refused earlier change (kept between openings); a stored-only key (R14-02)
          has no field, so its line says what the change was. */}
      {snapshot.canCancelStored && actions.cancelStored && <>
        {snapshot.pending && storedOnly(snapshot.pending.intent.payload.key) && <p>{t.storedOnly.note}</p>}
        <button className="settings-secondary" type="button" onClick={() => { void actions.cancelStored?.(); }}>{t.storedOnly.cancel}</button>
      </>}
      {snapshot.canContinueWithServer && <button className="settings-secondary" type="button" ref={continueButton}
        onClick={leave}>{t.continueWithServer}</button>}
    </div>}
    {!snapshot.data && !busy && !snapshot.problem && <p role="alert">{t.unavailable}</p>}
    {snapshot.data && notifications && <section className="settings-group" aria-label={n.title}>
      <NotificationsPanel snapshot={snapshot} language={language} actions={fieldProps.actions} onOpenBot={onOpenBot} />
    </section>}
    {/* The main view stays mounted while the submenu is shown, so its unsent editor text and topic query survive. */}
    <div className="settings-view" hidden={notifications}>
    {snapshot.data && groups.map(group => group.name === "additional"
      ? <details className="settings-group" key={group.name}><summary>{t.additional}</summary>
        <div className="settings-group-body">{group.fields.map(setting => <SettingField key={setting} setting={setting} {...fieldProps} />)}
          {/* project_notifications §8.1: the row to the submenu, where the pause group was (R14-02). */}
          {onView && <button type="button" className="settings-secondary settings-row" ref={row}
            onClick={() => onView("notifications")}>{n.title}</button>}</div>
      </details>
      : <section className="settings-group" key={group.name} aria-labelledby={`settings-${group.name}`}>
        <h2 id={`settings-${group.name}`}>{t[group.name]}</h2>
        <div className="settings-group-body">{group.fields.map(setting => setting === "dictionary_language"
          && languageChosen(snapshot.data) ? <LockedLanguage key={setting} snapshot={snapshot} language={language} />
          : <SettingField key={setting} setting={setting} {...fieldProps} />)}</div>
      </section>)}
    {snapshot.data && <SettingsReset snapshot={snapshot} language={language} onReset={() => { clearResult(); void actions.reset(); }}
      onRetry={() => { void actions.retry(); }} />}
    {feedback && <SettingsFeedback feedback={feedback} language={language} />}
    <BottomNav current="settings" language={language} enabled={onDictionary ? ["today", "dictionary"] : ["today"]}
      onNavigate={tab => { if (tab === "today") onToday(); else if (tab === "dictionary") onDictionary?.(); }} />
    </div>
  </main>;
}
