import type { Language } from "../i18n/language";
import { navigationText, type IconName } from "../i18n/messages";
import { tabs, type Tab } from "./navigation";
import { Icon } from "./navigationIcons";
import "../today/today.css";
import "./navigation.css";

export type BottomNavProps = {
  current: Tab;
  language: Language;
  /** Without a handler every section is shown and none can be opened. */
  onNavigate?: (tab: Tab) => void;
  /** Sections the host can open; without the list every section with a handler is available. */
  enabled?: readonly Tab[];
};

const icons: Record<Tab, IconName> = { today: "calendar", dictionary: "book", settings: "settings" };

/** The main navigation (К09-038); it only navigates and owns no screen. A session never renders it (К09-040). */
export function BottomNav(props: BottomNavProps) {
  const t = navigationText(props.language);
  const available = (tab: Tab) => !!props.onNavigate && (!props.enabled || props.enabled.includes(tab));
  return <nav className="today-nav bottom-nav" aria-label={t.navigation}>
    {tabs.map(tab => <button type="button" key={tab} aria-current={tab === props.current ? "page" : undefined}
      disabled={!available(tab)} onClick={() => props.onNavigate?.(tab)}>
      <Icon name={icons[tab]} decorative /><span>{t[tab]}</span>
    </button>)}
  </nav>;
}
