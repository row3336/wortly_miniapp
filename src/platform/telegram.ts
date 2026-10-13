export type Theme = "light" | "dark";
export type EdgeInsets = { top: number; right: number; bottom: number; left: number };

type TelegramEvent = "themeChanged" | "viewportChanged" | "safeAreaChanged" | "contentSafeAreaChanged";

export interface TelegramWebApp {
  initData?: string;
  initDataUnsafe?: { user?: { language_code?: string } };
  colorScheme?: Theme;
  viewportHeight?: number;
  safeAreaInset?: Partial<EdgeInsets>;
  contentSafeAreaInset?: Partial<EdgeInsets>;
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  HapticFeedback?: { notificationOccurred(type: "success"): void };
  /** Bot API 7.7: whether a vertical swipe may collapse or close the Mini App. */
  isVerticalSwipesEnabled?: boolean;
  disableVerticalSwipes?(): void;
  enableVerticalSwipes?(): void;
  ready?(): void;
  close?(): void;
  onEvent?(event: TelegramEvent, callback: () => void): void;
  offEvent?(event: TelegramEvent, callback: () => void): void;
}

type TelegramWindow = Window & { Telegram?: { WebApp?: TelegramWebApp } };

export function telegramWebApp(win: Window): TelegramWebApp | null {
  return (win as TelegramWindow).Telegram?.WebApp ?? null;
}

/** The language hint is untrusted; account identity is verified by the server. */
export function telegramLanguage(win: Window): string | undefined {
  return telegramWebApp(win)?.initDataUnsafe?.user?.language_code;
}

export function signedInitData(win: Window): string | null {
  return telegramWebApp(win)?.initData || null;
}

function usableInset(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function platformInsets(app: TelegramWebApp | null): EdgeInsets | null {
  // Telegram's content inset already describes the usable content rectangle.
  // Never add it to safeAreaInset or CSS env() a second time.
  const inset = app?.contentSafeAreaInset ?? app?.safeAreaInset;
  if (!inset) return null;
  return {
    top: usableInset(inset.top),
    right: usableInset(inset.right),
    bottom: usableInset(inset.bottom),
    left: usableInset(inset.left),
  };
}

export function platformTheme(app: TelegramWebApp | null, win: Window): Theme {
  if (app?.colorScheme === "dark" || app?.colorScheme === "light") return app.colorScheme;
  return win.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function availableHeight(app: TelegramWebApp | null, win: Window): number | null {
  const candidates = [app?.viewportHeight, win.visualViewport?.height, win.innerHeight];
  return candidates.find((height) => typeof height === "number" && Number.isFinite(height) && height > 0) ?? null;
}

export function syncPlatform(root: HTMLElement, win: Window): () => void {
  const app = telegramWebApp(win);
  const media = win.matchMedia?.("(prefers-color-scheme: dark)");
  const update = () => {
    const theme = platformTheme(app, win);
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    const height = availableHeight(app, win);
    if (height !== null) root.style.setProperty("--app-height", `${height}px`);
    const inset = platformInsets(app);
    for (const edge of ["top", "right", "bottom", "left"] as const) {
      const property = `--safe-${edge}`;
      if (inset) root.style.setProperty(property, `${inset[edge]}px`);
      else root.style.removeProperty(property);
    }
    const meta = win.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) meta.content = theme === "dark" ? "#171717" : "#F0EEE9";
  };
  update();
  app?.ready?.();
  const events: TelegramEvent[] = ["themeChanged", "viewportChanged", "safeAreaChanged", "contentSafeAreaChanged"];
  for (const event of events) app?.onEvent?.(event, update);
  win.addEventListener("resize", update);
  win.visualViewport?.addEventListener("resize", update);
  media?.addEventListener?.("change", update);
  return () => {
    for (const event of events) app?.offEvent?.(event, update);
    win.removeEventListener("resize", update);
    win.visualViewport?.removeEventListener("resize", update);
    media?.removeEventListener?.("change", update);
  };
}

export function bindBackButton(win: Window, onBack: () => void): () => void {
  const back = telegramWebApp(win)?.BackButton;
  if (!back) return () => {};
  back.onClick(onBack);
  back.show();
  return () => {
    back.offClick(onBack);
    back.hide();
  };
}

/** Closes the Mini App; outside Telegram there is nothing to close and the page stays as it is. */
export function closeMiniApp(win: Window): void {
  try {
    telegramWebApp(win)?.close?.();
  } catch { /* A window that cannot close keeps showing its last screen. */ }
}

export function notifyAcceptedMilestone(
  win: Window,
  milestone: "entry" | "quiz-start" | "quiz-complete" | "learning-complete",
): void {
  // Call sites must provide a confirmed, non-duplicate milestone.
  try {
    if (milestone) telegramWebApp(win)?.HapticFeedback?.notificationOccurred("success");
  } catch { /* Optional device feedback cannot change a confirmed application result. */ }
}

/**
 * R14-01: while the owner drags a translation field, a vertical swipe must not collapse the Mini App. Disables Telegram's
 * vertical swipes and returns the restore: swipes come back only if they were enabled before (an older client without
 * the method keeps its behaviour; a failing call changes nothing).
 */
export function suspendVerticalSwipes(win: Window): () => void {
  const app = telegramWebApp(win);
  if (!app?.disableVerticalSwipes || app.isVerticalSwipesEnabled === false) return () => {};
  try {
    app.disableVerticalSwipes();
  } catch {
    return () => {};
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      app.enableVerticalSwipes?.();
    } catch { /* The swipe setting is a convenience of the gesture, never part of a saved result. */ }
  };
}
