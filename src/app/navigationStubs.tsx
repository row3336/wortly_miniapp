import type { Language } from "../i18n/language";
import { navigationText } from "../i18n/messages";
import { BottomNav, type BottomNavProps } from "./BottomNav";
import "../today/today.css";
import "./navigation.css";

// Working copy for G05: entry points only. M-DICT connects the dictionary screen (М11) and M-STAT the statistics (Д03);
// these placeholders read no data and own no state.

export function DictionaryPlaceholder(props: { language: Language; navigation: Omit<BottomNavProps, "current" | "language"> }) {
  const t = navigationText(props.language);
  return <main className="today-screen">
    <header className="today-header"><h1>{t.dictionary}</h1></header>
    <p className="nav-placeholder-text">{t.placeholder}</p>
    <BottomNav current="dictionary" language={props.language} {...props.navigation} />
  </main>;
}

/** Statistics opens from Today and returns there by the same transition as native Back (К09-039, TA:86). */
export function StatisticsPlaceholder(props: { language: Language; onBack(): void }) {
  const t = navigationText(props.language);
  return <main className="today-screen">
    <header className="today-header"><h1>{t.statistics}</h1>
      <button type="button" className="today-text-action" onClick={props.onBack}>{t.back}</button></header>
    <p className="nav-placeholder-text">{t.placeholder}</p>
  </main>;
}
