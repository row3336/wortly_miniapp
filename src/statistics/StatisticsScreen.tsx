import type { Language } from "../i18n/language";
import "../app/navigation.css";
import "../today/today.css";
import "./statistics.css";
import type { PracticeWeek } from "./practiceApi";
import type { StatisticsSnapshot } from "./statisticsController";
import { statisticsCopy } from "./statisticsCopy";
import { NowGroup, OwnerGroup, PeriodGroup } from "./StatisticsSections";

export type StatisticsScreenProps = {
  state: StatisticsSnapshot;
  week: PracticeWeek;
  language: Language;
  onWeek(week: PracticeWeek): void;
  onRetry(): void;
  onBack(): void;
};

const weeks: PracticeWeek[] = ["current", "previous"];

/** Only a read the server has just confirmed shows numbers: loading and errors never draw a zero (TA:335). */
export function StatisticsScreen(props: StatisticsScreenProps) {
  const t = statisticsCopy[props.language];
  const { state } = props;
  const data = state.phase === "ready" ? state.data : null;
  const failed = state.phase === "failed";
  const message = state.problem === "expired" || state.problem === "forbidden" ? t.expired
    : state.problem === "stale_response" ? t.stale : state.problem === "pair_changed" ? t.pairChanged : t.failed;
  // An expired or forbidden access is already revoked: a repeat could not succeed.
  const retryable = failed && state.problem !== "expired" && state.problem !== "forbidden";
  return <main className="today-screen stat-screen">
    <header className="today-header">
      <h1>{t.title}</h1>
      <button type="button" className="today-text-action" onClick={props.onBack}>{t.back}</button>
    </header>
    <div className="stat-weeks" role="group" aria-label={t.period}>
      {weeks.map(week => <button key={week} type="button" className="stat-week" aria-pressed={props.week === week}
        onClick={() => props.onWeek(week)}>{week === "current" ? t.current : t.previous}</button>)}
    </div>
    {data ? <>
      <PeriodGroup data={data} language={props.language} />
      <NowGroup data={data} language={props.language} />
      <OwnerGroup data={data} language={props.language} />
    </> : failed ? <section className="today-status" role="alert">
      <p>{message}</p>
      {retryable && <button type="button" className="today-retry" onClick={props.onRetry}>{t.retry}</button>}
    </section> : <section className="today-status" role="status" aria-busy="true">
      <svg className="today-loader" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="11" fill="var(--line)" />
        <circle cx="12" cy="12" r="8" fill="none" stroke="var(--muted)" strokeWidth="2" />
        <circle className="today-loader-arc" cx="12" cy="12" r="8" fill="none" stroke="var(--text)" strokeWidth="3" pathLength="100" />
      </svg>
      <p>{t.loading}</p>
    </section>}
  </main>;
}
