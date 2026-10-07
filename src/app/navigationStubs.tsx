import type { Language } from "../i18n/language";
import { navigationText } from "../i18n/messages";
import "../today/today.css";
import "./navigation.css";

// Working copy for G05: an entry point only. M-STAT connects the statistics (Д03); the placeholder reads no data and owns no state.

/** Statistics opens from Today and returns there by the same transition as native Back (К09-039, TA:86). */
export function StatisticsPlaceholder(props: { language: Language; onBack(): void }) {
  const t = navigationText(props.language);
  return <main className="today-screen">
    <header className="today-header"><h1>{t.statistics}</h1>
      <button type="button" className="today-text-action" onClick={props.onBack}>{t.back}</button></header>
    <p className="nav-placeholder-text">{t.placeholder}</p>
  </main>;
}
