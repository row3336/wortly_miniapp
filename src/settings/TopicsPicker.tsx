import { useId, useMemo, useState } from "react";
import type { Topic } from "../api/generated";
import type { Language } from "../i18n/language";
import "./topicsPicker.css";

type Props = {
  topics: readonly Topic[];
  selected: readonly string[];
  language: Language;
  disabled?: boolean;
  onChange(ids: string[]): void;
};
const copy = {
  ru: { heading: "Темы", search: "Найти тему по номеру или немецкому названию", clear: "Очистить поиск",
    all: "Выбрать все темы", selected: "Выбрано", of: "из", results: "Найдено", list: "Список тем",
    empty: "Тем пока нет", noMatch: "Темы не найдены. Измени поисковый запрос.",
    minimum: "Нужно выбрать хотя бы одну тему. Последнюю выбранную тему снять нельзя.",
    missing: "В загруженном списке нет некоторых выбранных тем. Обнови настройки, чтобы продолжить выбор." },
  uk: { heading: "Теми", search: "Знайти тему за номером або німецькою назвою", clear: "Очистити пошук",
    all: "Обрати всі теми", selected: "Обрано", of: "з", results: "Знайдено", list: "Список тем",
    empty: "Тем поки немає", noMatch: "Теми не знайдено. Зміни пошуковий запит.",
    minimum: "Потрібно обрати хоча б одну тему. Останню обрану тему зняти не можна.",
    missing: "У завантаженому списку немає деяких обраних тем. Онови налаштування, щоб продовжити вибір." },
  en: { heading: "Topics", search: "Find a topic by number or German name", clear: "Clear search",
    all: "Select all topics", selected: "Selected", of: "of", results: "Found", list: "Topic list",
    empty: "No topics are available yet", noMatch: "No topics found. Change your search.",
    minimum: "Choose at least one topic. You cannot deselect the last selected topic.",
    missing: "Some selected topics are missing from the loaded list. Refresh settings to continue choosing." },
};

function searchText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("de").replace(/[äöüß]/g,
    letter => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[letter]!).trim();
}

/** Search and scroll belong to this editor; the parent owns draft selection and save. */
export function TopicsPicker({ topics, selected, language, disabled = false, onChange }: Props) {
  const [query, setQuery] = useState("");
  const prefix = useId();
  const t = copy[language];
  const chosen = new Set(selected.map(id => id.toLowerCase()));
  const catalogIds = new Set(topics.map(topic => topic.id.toLowerCase()));
  const missing = [...chosen].some(id => !catalogIds.has(id));
  const locked = disabled || missing;
  const filtered = useMemo(() => {
    const term = searchText(query);
    return topics.filter(topic => searchText(`${topic.number} ${topic.german_name}`).includes(term));
  }, [topics, query]);
  const allSelected = topics.length > 0 && topics.every(topic => chosen.has(topic.id.toLowerCase()));
  const toggle = (topic: Topic, checked: boolean) => {
    if (locked) return;
    if (checked) {
      if (!chosen.has(topic.id.toLowerCase())) onChange([...selected, topic.id]);
    } else if (chosen.size > 1) onChange(selected.filter(id => id.toLowerCase() !== topic.id.toLowerCase()));
  };

  return <section className="topics-picker" aria-labelledby={`${prefix}-heading`}>
    <h3 id={`${prefix}-heading`}>{t.heading}</h3>
    <label className="topics-search" htmlFor={`${prefix}-search`}>
      {t.search}
      <input id={`${prefix}-search`} type="search" value={query} onChange={event => setQuery(event.target.value)}
        autoComplete="off" spellCheck={false} />
    </label>
    {query && <button className="topics-text-button" type="button" onClick={() => setQuery("")}>{t.clear}</button>}
    <div className="topics-selection">
      <p role="status">{t.selected}: {chosen.size} {t.of} {topics.length}. {t.results}: {filtered.length}</p>
      <button type="button" className="topics-all" disabled={locked || topics.length === 0 || allSelected}
        onClick={() => { if (!locked) onChange(topics.map(topic => topic.id)); }}>{t.all}</button>
    </div>
    <p id={`${prefix}-minimum`} className="topics-hint">{t.minimum}</p>
    {missing && <p className="topics-error" role="alert">{t.missing}</p>}
    <div className="topics-scroll" role="group" aria-label={t.list} tabIndex={0} aria-describedby={`${prefix}-minimum`}>
      {filtered.map(topic => {
        const checked = chosen.has(topic.id.toLowerCase());
        return <label key={topic.id} className="topics-row">
          <input type="checkbox" checked={checked} disabled={locked || (checked && chosen.size === 1)}
            onChange={event => toggle(topic, event.target.checked)}
            aria-labelledby={`${prefix}-${topic.id}-name`} aria-describedby={`${prefix}-${topic.id}-description ${prefix}-minimum`} />
          <span className="topics-details">
            <strong id={`${prefix}-${topic.id}-name`} lang="de">{topic.number}. {topic.german_name}</strong>
            <span id={`${prefix}-${topic.id}-description`} className="topics-description">{topic.description}</span>
          </span>
        </label>;
      })}
      {filtered.length === 0 && <p className="topics-empty">{topics.length === 0 ? t.empty : t.noMatch}</p>}
    </div>
  </section>;
}
