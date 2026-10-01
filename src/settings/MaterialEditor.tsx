import type { SettingConstraint, Topic } from "../api/generated";
import type { Language } from "../i18n/language";
import { TopicsPicker } from "./TopicsPicker";
import { settingsCopy } from "./settingsCopy";

export type CatalogState = { phase: "loading" | "ready" | "failed"; topics: readonly Topic[] | null };
type Props = {
  input: unknown;
  constraint: SettingConstraint;
  catalog: CatalogState;
  language: Language;
  disabled: boolean;
  id: string;
  onChange(value: unknown): void;
  onReload(): void;
};

export function materialParts(input: unknown): { mode: string; level: string; topics: string[] } {
  const item = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return { mode: typeof item.mode === "string" ? item.mode : "",
    level: typeof item.selected_level === "string" ? item.selected_level : "",
    topics: Array.isArray(item.topic_ids) && item.topic_ids.every(id => typeof id === "string") ? item.topic_ids : [] };
}

export function catalogAllows(input: unknown, catalog: CatalogState): boolean {
  const material = materialParts(input);
  return material.mode !== "topics" || (catalog.phase === "ready" && catalog.topics !== null
    && material.topics.every(id => catalog.topics!.some(topic => topic.id.toLowerCase() === id.toLowerCase())));
}

export function MaterialEditor({ input, constraint, catalog, language, disabled, id, onChange, onReload }: Props) {
  const t = settingsCopy[language];
  const material = materialParts(input);
  const levels = constraint.modes?.level.selected_level;
  return <div className="settings-material">
    <p className="settings-help">{t.materialHint}</p>
    <div className="settings-options">
      {(["level", "topics"] as const).map(mode => <label key={mode}>
        <input type="radio" name={`${id}-mode`} checked={material.mode === mode} disabled={disabled}
          onChange={() => onChange(mode === "level" ? { mode, selected_level: "" } : { mode, topic_ids: [] })} />
        {t[mode]}
      </label>)}
    </div>
    {material.mode === "level" && <label className="settings-label" htmlFor={`${id}-level`}>{t.level}
      <select id={`${id}-level`} value={material.level} disabled={disabled}
        onChange={event => onChange({ mode: "level", selected_level: event.target.value })}>
        <option value="" disabled>{t.choose}</option>
        {material.level && (!Array.isArray(levels) || !levels.includes(material.level))
          && <option value={material.level} disabled>{material.level}</option>}
        {Array.isArray(levels) && levels.map(level => <option key={level} value={level}>{level}</option>)}
      </select>
    </label>}
    {material.mode === "topics" && <div className="settings-topic-editor">
      {catalog.phase === "loading" && <p role="status">{t.topicsLoading}</p>}
      {catalog.phase === "failed" && <p className="settings-error" role="alert">{t.topicsFailed}</p>}
      <button type="button" className="settings-secondary" onClick={onReload} disabled={catalog.phase === "loading"}>{t.topicsRefresh}</button>
      {catalog.topics !== null && <TopicsPicker topics={catalog.topics} selected={material.topics} language={language}
        disabled={disabled || catalog.phase !== "ready"} onChange={topic_ids => onChange({ mode: "topics", topic_ids })} />}
    </div>}
  </div>;
}
