import { useId } from "react";
import type { SettingConstraint, Topic } from "../api/generated";
import type { Language } from "../i18n/language";
import type { SettingKey } from "./settingsApi";
import type { SettingsController, SettingsSnapshot } from "./settingsController";
import { catalogAllows, MaterialEditor, materialParts, type CatalogState } from "./MaterialEditor";
import { languageNames, settingsCopy } from "./settingsCopy";
import "./settings.css";

type Actions = Pick<SettingsController, "edit" | "save" | "acceptCurrent" | "keepMine" | "refresh" | "retry">;
export type SettingsScreenProps = {
  snapshot: SettingsSnapshot;
  catalog: CatalogState;
  language: Language;
  actions: Actions;
  onReloadTopics(): void;
  onToday(): void;
};
const groups: Array<{ name: "languages" | "learning" | "checking" | "additional"; fields: SettingKey[] }> = [
  { name: "languages", fields: ["ui_language", "dictionary_language"] },
  { name: "learning", fields: ["material", "learning_group_size", "transition_mode"] },
  { name: "checking", fields: ["strict_case", "include_preterite", "include_comparative"] },
  { name: "additional", fields: ["learning_intervals_seconds", "learning_mix", "retry_gap", "retry_count",
    "learning_poll_seconds", "learning_reminder_pause_seconds", "learning_ready_percent"] },
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
  const change = (next: unknown) => actions.edit(setting, next);
  const inputProps = { id: `${id}-input`, disabled: !snapshot.canEdit,
    "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-help ${id}-error`, "aria-invalid": draft?.valid === false };

  return <section className="settings-field" role="group" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>{title}</h3>
    {rule.type === "integer" && <input {...inputProps} type="text" inputMode="numeric"
      value={typeof value === "number" || typeof value === "string" ? value : ""}
      onChange={event => change(event.target.value)} />}
    {rule.type === "enum" && <select {...inputProps} value={typeof value === "string" ? value : ""}
      onChange={event => change(event.target.value)}>
      <option value="" disabled>{t.choose}</option>
      {typeof value === "string" && value && !choices.includes(value)
        && <option value={value} disabled>{displayValue(value, setting, language)}</option>}
      {choices.map(item => <option key={item} value={item}>{displayValue(item, setting, language)}</option>)}
    </select>}
    {rule.type === "boolean" && <div className="settings-options">
      {[true, false].map(choice => <label key={String(choice)}>
        <input type="radio" name={`${id}-boolean`} checked={value === choice} disabled={!snapshot.canEdit}
          onChange={() => change(choice)} aria-describedby={`${id}-help ${id}-error`} />
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
      {snapshot.pending?.intent.payload.key === setting && <span role="status">{snapshot.phase === "sending" ? t.saving : t.unknown}</span>}
      {outcome?.status === "accepted" && <span className="settings-saved" role="status">{t.saved}</span>}
    </div>
  </section>;
}

/** Presentation only: callbacks retain command identity and lifetime in the host/controller. */
export function SettingsScreen(props: SettingsScreenProps) {
  const { snapshot, language, actions, onToday } = props;
  const t = settingsCopy[language];
  const busy = ["loading", "checking", "sending"].includes(snapshot.phase);
  return <main className="settings-screen" lang={language}>
    <header className="settings-header"><h1>{t.title}</h1>
      <button type="button" className="settings-secondary" disabled={busy} onClick={() => { void actions.refresh(); }}>{t.refresh}</button>
    </header>
    {busy && <p role="status">{snapshot.phase === "sending" ? t.saving : snapshot.data ? t.refreshing : t.loading}</p>}
    {snapshot.problem && <div className="settings-error" role="alert">
      <p>{snapshot.pending && snapshot.problem.reason === "network" ? t.unknown : t.problems[snapshot.problem.reason]}</p>
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
    <nav className="settings-nav" aria-label={t.navigation}>
      <button type="button" onClick={onToday}>{t.today}</button>
      <button type="button" disabled>{t.dictionary}</button>
      <button type="button" aria-current="page" disabled>{t.title}</button>
    </nav>
  </main>;
}
