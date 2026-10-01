import { describe, expect, it, vi } from "vitest";
import { platformInsets, platformTheme, signedInitData, syncPlatform, telegramLanguage } from "./telegram";
import type { TelegramWebApp } from "./telegram";

describe("Telegram platform boundary", () => {
  it("works outside Telegram and does not fabricate signed init data", () => {
    const win = {
      matchMedia: () => ({ matches: false }),
    } as unknown as Window;
    expect(telegramLanguage(win)).toBeUndefined();
    expect(signedInitData(win)).toBeNull();
    expect(platformTheme(null, win)).toBe("light");
    expect(platformInsets(null)).toBeNull();
  });

  it("uses Telegram theme and one content inset without adding the outer inset", () => {
    const app: TelegramWebApp = {
      colorScheme: "dark",
      safeAreaInset: { top: 10, bottom: 6 },
      contentSafeAreaInset: { top: 20, bottom: 8 },
    };
    const win = { matchMedia: () => ({ matches: false }) } as unknown as Window;
    expect(platformTheme(app, win)).toBe("dark");
    expect(platformInsets(app)).toEqual({ top: 20, right: 0, bottom: 8, left: 0 });
  });

  it("updates and unsubscribes from viewport changes", () => {
    const listeners = new Map<string, () => void>();
    const app: TelegramWebApp = {
      viewportHeight: 500,
      onEvent: vi.fn((event, callback) => { listeners.set(event, callback); }),
      offEvent: vi.fn(),
      ready: vi.fn(),
    };
    const root = document.createElement("div");
    const win = {
      Telegram: { WebApp: app },
      document,
      innerHeight: 700,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    } as unknown as Window;
    const cleanup = syncPlatform(root, win);
    expect(root.style.getPropertyValue("--app-height")).toBe("500px");
    app.viewportHeight = 320;
    listeners.get("viewportChanged")?.();
    expect(root.style.getPropertyValue("--app-height")).toBe("320px");
    cleanup();
    expect(app.offEvent).toHaveBeenCalledTimes(4);
  });
});
