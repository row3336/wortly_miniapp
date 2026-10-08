/** Top-level sections of the main navigation (К09-038). */
export const tabs = ["today", "dictionary", "settings"] as const;
export type Tab = (typeof tabs)[number];
export type StudyScreen = "learning" | "oral" | "written";
/** Screens of the application document (TA табл. 4.1). */
export type ScreenId = Tab | StudyScreen | "statistics" | "card";
/** Screens opened on top of another one; they always return to their source. */
export type NestedScreen = "statistics" | "card";

/** What a nested screen returns to: addresses only, never a copy of study progress (TA §1, TA:86). */
export type ReturnContext = {
  source: ScreenId;
  /** The addressed object of the source route, e.g. the card a related card was opened from. */
  subject: string | null;
  /** The source's own return context: a chain of nested screens unwinds one step per Back. */
  parent: ReturnContext | null;
  /** The study assignment the screen was opened from, by id. */
  assignment?: string;
  search?: { query: string; mode: "words" | "phrases" };
  scroll?: number;
};
/** Fields a source may hand over when it opens a nested screen. */
export type ReturnDetails = Pick<ReturnContext, "assignment" | "search" | "scroll">;
/**
 * A nested screen opened from outside the application: "message" is a bot message button (answer S01). Its source is
 * then only where Back leads, not what opened it, so the screen takes no rights of that source.
 */
export type Entry = "message";

export type Route = {
  screen: ScreenId;
  /** The addressed object of this screen (a card id), never its content. */
  subject: string | null;
  back: ReturnContext | null;
  /** The context this screen was re-entered with by Back, for the source to restore its search and scroll. */
  restored: ReturnContext | null;
  /** Direction of the change that produced this route, for the screen transition (П1). */
  direction: "forward" | "back" | "none";
  /** Set on the pushed screen only; a return by Back never carries it. */
  entry?: Entry;
};

export type NavigationAction =
  /** A section or a study session: the route starts afresh. */
  | { type: "open"; screen: Tab | StudyScreen }
  /** A nested screen remembers where it was opened from. */
  | { type: "push"; screen: NestedScreen; subject?: string; details?: ReturnDetails; entry?: Entry }
  | { type: "back" }
  /** Today after a section, a closed session or an explicit return. */
  | { type: "home" };

export const initialRoute: Route = { screen: "today", subject: null, back: null, restored: null, direction: "none" };

export function isStudy(screen: ScreenId): screen is StudyScreen {
  return screen === "learning" || screen === "oral" || screen === "written";
}
function isTab(screen: ScreenId): screen is Tab {
  return (tabs as readonly ScreenId[]).includes(screen);
}

/**
 * The screen native Back leads to (TA:86): a nested screen returns to its source, a section other than Today
 * returns to Today. Today has no Back of its own, and a session leaves only through its own exit control.
 */
export function backDestination(route: Route): ScreenId | null {
  if (isStudy(route.screen)) return null;
  if (route.back) return route.back.source;
  return route.screen === "today" ? null : "today";
}

function sideways(from: ScreenId, to: Tab): Route["direction"] {
  const before = isTab(from) ? tabs.indexOf(from) : -1;
  return tabs.indexOf(to) < before ? "back" : "forward";
}

export function navigationReducer(route: Route, action: NavigationAction): Route {
  switch (action.type) {
    case "open":
      if (route.screen === action.screen && route.back === null) return route;
      return { screen: action.screen, subject: null, back: null, restored: null,
        direction: isStudy(action.screen) ? "forward" : sideways(route.screen, action.screen) };
    case "push":
      return { screen: action.screen, subject: action.subject ?? null, restored: null, direction: "forward",
        back: { ...action.details, source: route.screen, subject: route.subject, parent: route.back },
        ...(action.entry ? { entry: action.entry } : {}) };
    case "back": {
      // A session is left through its own exit; Back never navigates away from it by itself.
      if (isStudy(route.screen)) return route;
      const back = route.back;
      if (!back) return route.screen === "today" ? route : navigationReducer(route, { type: "home" });
      return { screen: back.source, subject: back.subject, back: back.parent, restored: back, direction: "back" };
    }
    case "home":
      if (route.screen === "today" && route.back === null) return route;
      return { ...initialRoute, direction: "back" };
  }
}
