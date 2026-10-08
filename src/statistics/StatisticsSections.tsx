import type { ReactNode } from "react";
import type { StatisticsOverviewResponse } from "../api/generated";
import type { Language } from "../i18n/language";
import { directionLabel, type StudyDirection } from "../i18n/messages";
import { statisticsCopy } from "./statisticsCopy";

type Props = { data: StatisticsOverviewResponse; language: Language };

const locales: Record<Language, string> = { ru: "ru-RU", uk: "uk-UA", en: "en-US" };
const streakGroups = [["one", "1"], ["two", "2"], ["three", "3"], ["four", "4"], ["five_plus", "5+"]] as const;
const typeOrder = ["noun", "verb", "phrase", "adjective", "pronoun", "adverb", "preposition", "conjunction", "particle"] as const;

/** Local calendar dates from the server are formatted as plain dates: no device time zone may shift them. */
function formatDay(value: string, language: Language, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locales[language], { timeZone: "UTC", ...options }).format(new Date(`${value}T00:00:00Z`));
}

function Row({ label, value }: { label: ReactNode; value: number }) {
  return <div className="stat-row"><dt>{label}</dt><dd>{value}</dd></div>;
}

/** Words and phrases of one fact side by side, e.g. «Изучено». */
function Pair({ id, title, counts, language }: { id: string; title: string; counts: { words: number; phrases: number }; language: Language }) {
  const t = statisticsCopy[language];
  return <section className="today-card" aria-labelledby={id}>
    <h3 id={id}>{title}</h3>
    <dl className="stat-list"><Row label={t.words} value={counts.words} /><Row label={t.phrases} value={counts.phrases} /></dl>
  </section>;
}

export function PeriodGroup({ data, language }: Props) {
  const t = statisticsCopy[language];
  const days = data.practice.days;
  const from = formatDay(days[0].local_date, language, { day: "numeric", month: "short" });
  const to = formatDay(days[days.length - 1].local_date, language, { day: "numeric", month: "short", year: "numeric" });
  return <section className="stat-group" aria-labelledby="stat-week-heading">
    <h2 id="stat-week-heading">{t.weekGroup}</h2>
    <p className="today-small">{t.weekRange(from, to)}</p>
    <section className="today-card" aria-labelledby="stat-practice-heading">
      <h3 id="stat-practice-heading">{t.practice}</h3>
      <p className="today-small">{t.practiceNote}</p>
      <p className="today-small">{t.reverseNote}</p>
      {/* Conjugations are a separate number outside the directions; its unit is undecided (Q15), so no figure exists yet. */}
      <table className="stat-table">
        <thead><tr><th scope="col">{t.day}</th><th scope="col">{t.words}</th><th scope="col">{t.phrases}</th><th scope="col">{t.reverseDirection}</th></tr></thead>
        <tbody>{days.map(item => <tr key={item.local_date}>
          <th scope="row">{formatDay(item.local_date, language, { weekday: "short", day: "numeric", month: "short" })}</th>
          <td>{item.words}</td><td>{item.phrases}</td><td aria-label={t.reverseNone}>—</td>
        </tr>)}</tbody>
      </table>
    </section>
    <Pair id="stat-learned-heading" title={t.learned} counts={data.learned} language={language} />
    <Pair id="stat-added-heading" title={t.added} counts={data.added} language={language} />
  </section>;
}

export function NowGroup({ data, language }: Props) {
  const t = statisticsCopy[language];
  const direction = (value: StudyDirection) => directionLabel(language, data.pair, value);
  const ready: { key: keyof typeof t.readyRows; direction: StudyDirection; count: number }[] = [
    { key: "wordsTo", direction: "l1-de", count: data.ready.words["l1-de"] },
    { key: "wordsFrom", direction: "de-l1", count: data.ready.words["de-l1"] },
    { key: "phrasesTo", direction: "l1-de", count: data.ready.phrases["l1-de"] },
    { key: "phrasesFrom", direction: "de-l1", count: data.ready.phrases["de-l1"] },
  ];
  return <section className="stat-group" aria-labelledby="stat-now-heading">
    <h2 id="stat-now-heading">{t.nowGroup}</h2>
    <section className="today-card" aria-labelledby="stat-base-heading">
      <h3 id="stat-base-heading">{t.base}</h3>
      <dl className="stat-list">
        <Row label={t.baseTotal} value={data.base.total} />
        <Row label={t.words} value={data.base.words} /><Row label={t.phrases} value={data.base.phrases} />
      </dl>
      <p className="today-small">{t.baseTypes}</p>
      <dl className="stat-list">{typeOrder.map(type => <Row key={type} label={t.types[type]} value={data.base.by_type[type]} />)}</dl>
    </section>
    <section className="today-card" aria-labelledby="stat-ready-heading">
      <h3 id="stat-ready-heading">{t.ready}</h3>
      <dl className="stat-list">{ready.map(row => <Row key={row.key} value={row.count}
        label={<>{direction(row.direction) && <><span className="today-direction">{direction(row.direction)}</span>{" "}</>}{t.readyRows[row.key]}</>} />)}</dl>
    </section>
    <Pair id="stat-not-started-heading" title={t.notStarted} counts={data.not_started} language={language} />
    <section className="today-card" aria-labelledby="stat-results-heading">
      <h3 id="stat-results-heading">{t.results}</h3>
      <p className="today-small">{t.resultsNote}</p>
      <dl className="stat-list">
        <Row label={t.lastWrong} value={data.word_results.last_wrong} />
      </dl>
      <p className="today-small">{t.streaksTitle}</p>
      <dl className="stat-list">{streakGroups.map(([key, label]) =>
        <Row key={key} label={t.streak(label)} value={data.word_results.streaks[key]} />)}</dl>
    </section>
  </section>;
}

/** Rendered only when the server sent the key: the owner metric never exists for anyone else. */
export function OwnerGroup({ data, language }: Props) {
  const t = statisticsCopy[language];
  if (!data.owner_metric) return null;
  return <section className="today-card" aria-labelledby="stat-owner-heading">
    <h3 id="stat-owner-heading">{t.owner}</h3>
    <p className="today-small">{t.ownerNote}</p>
    <table className="stat-table">
      <thead><tr><th scope="col">{t.profile}</th><th scope="col">{t.words}</th><th scope="col">{t.phrases}</th></tr></thead>
      <tbody>{data.owner_metric.profiles.map((profile, index) => <tr key={profile.profile_id}>
        <th scope="row">{t.ownerProfile(index + 1, profile.profile_id.slice(0, 8))}</th>
        <td>{profile.words}</td><td>{profile.phrases}</td>
      </tr>)}</tbody>
    </table>
  </section>;
}
