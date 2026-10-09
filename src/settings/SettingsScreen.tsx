import { useEffect, useId, useRef, useState } from "react";
import type { SettingConstraint, Topic } from "../api/generated";
import { BottomNav } from "../app/BottomNav";
import type { FeedbackDocument } from "../feedback/useFeedbackDocument";
import type { Language } from "../i18n/language";
import { t as appText } from "../i18n/messages";
import type { SettingKey } from "./settingsApi";
import type { SettingsController, SettingsSnapshot } from "./settingsController";
import { catalogAllows, MaterialEditor, materialParts, type CatalogState } from "./MaterialEditor";
import { SettingsFeedback } from "./SettingsFeedback";
import { SettingsResetDialog } from "./SettingsResetDialog";
import { languageNames, settingsCopy } from "./settingsCopy";
import "./settings.css";

type Actions = Pick<SettingsController, "edit" | "save" | "acceptCurrent" | "keepMine" | "refresh" | "retry" | "reset">;
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
};
const groups: Array<{ name: "languages" | "learning" | "checking" | "additional"; fields: SettingKey[] }> = [
  { name: "languages", fields: ["ui_language", "dictionary_language"] },
  { name: "learning", fields: ["material", "learning_group_size", "learning_content", "review_error_mode", "transition_mode"] },
  { name: "checking", fields: ["strict_case", "include_preterite", "include_comparative"] },
  { name: "additional", fields: ["learning_intervals_seconds", "learning_mix", "retry_gap", "retry_count",
    "learning_reminder_pause_seconds"] },
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

function SettingField({ setting, ...props }: SettingsScreenProps & { setting: SettingKey }) {
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
      {snapshot.pending?.intent.payload.key === setting && !knownRefusal(snapshot)
        && <span role="status">{snapshot.phase === "sending" ? t.saving : t.unknown}</span>}
      {outcome?.status === "accepted" && <span className="settings-saved" role="status">{t.saved}</span>}
    </div>
  </section>;
}

function knownRefusal(snapshot: SettingsSnapshot): boolean {
  return snapshot.problem?.reason === "incompatible" || snapshot.problem?.reason === "command_refused";
}

/** The top line's wording for the current problem. */
function problemText(snapshot: SettingsSnapshot, language: Language): string {
  const t = settingsCopy[language], reason = snapshot.problem!.reason;
  // Exactly CLIENT_INCOMPATIBLE of a command: the app's text for that refusal (CommandRecovery). Working text, G05 open.
  if (reason === "incompatible") return appText(language).commandIncompatible;
  // A known 422 of this attempt, the outcome of earlier ones still unconfirmed. Working text, pending owner.
  if (reason === "command_refused") return snapshot.resetPending ? t.refusedAttempt.reset : t.refusedAttempt.save;
  if (snapshot.resetPending && (reason === "network" || reason === "not_found")) return t.reset.unknown;
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
  const { snapshot, language, actions, onToday, onDictionary, feedback } = props;
  const t = settingsCopy[language];
  const busy = ["loading", "checking", "sending"].includes(snapshot.phase);
  const line = resetLine(snapshot);
  return <main className="settings-screen" lang={language}>
    <header className="settings-header"><h1>{t.title}</h1>
      <button type="button" className="settings-secondary" disabled={busy} onClick={() => { void actions.refresh(); }}>{t.refresh}</button>
    </header>
    {busy && line !== "sending" && <p role="status">{snapshot.phase === "sending" ? snapshot.resetPending ? t.reset.sending : t.saving
      : snapshot.data ? t.refreshing : t.loading}</p>}
    {snapshot.problem && line !== "unknown" && <div className="settings-error" role="alert">
      <p>{problemText(snapshot, language)}</p>
      {snapshot.canRetry && <button className="settings-secondary" type="button" onClick={() => { void actions.retry(); }}>{t.retry}</button>}
    </div>}
    {!snapshot.data && !busy && !snapshot.problem && <p role="alert">{t.unavailable}</p>}
    {snapshot.data && groups.map(group => group.name === "additional"
      ? <details className="settings-group" key={group.name}><summary>{t.additional}</summary>
        <div className="settings-group-body">{group.fields.map(setting => <SettingField key={setting} setting={setting} {...props} />)}</div>
      </details>
      : <section className="settings-group" key={group.name} aria-labelledby={`settings-${group.name}`}>
        <h2 id={`settings-${group.name}`}>{t[group.name]}</h2>
        <div className="settings-group-body">{group.fields.map(setting => <SettingField key={setting} setting={setting} {...props} />)}</div>
      </section>)}
    {snapshot.data && <SettingsReset snapshot={snapshot} language={language} onReset={() => { void actions.reset(); }}
      onRetry={() => { void actions.retry(); }} />}
    {feedback && <SettingsFeedback feedback={feedback} language={language} />}
    <BottomNav current="settings" language={language} enabled={onDictionary ? ["today", "dictionary"] : ["today"]}
      onNavigate={tab => { if (tab === "today") onToday(); else if (tab === "dictionary") onDictionary?.(); }} />
  </main>;
}
