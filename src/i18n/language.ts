import type { AsyncStorage } from "../platform/storage";

export const supportedLanguages = ["uk", "en", "ru"] as const;
export type Language = (typeof supportedLanguages)[number];
export const languageStorageKey = "wortly.uiLanguage";

export function supportedLanguage(value: unknown): Language | null {
  if (typeof value !== "string") return null;
  const base = value.trim().toLowerCase().split(/[-_]/, 1)[0];
  return supportedLanguages.find((language) => language === base) ?? null;
}

export function chooseInitialLanguage(
  saved: unknown,
  telegram: unknown,
  navigatorLanguage: unknown,
): Language {
  return supportedLanguage(saved) ?? supportedLanguage(telegram) ?? supportedLanguage(navigatorLanguage) ?? "en";
}

export async function loadInitialLanguage(
  storage: AsyncStorage,
  telegram: unknown,
  navigatorLanguage: unknown,
): Promise<Language> {
  return chooseInitialLanguage(await readSavedLanguage(storage), telegram, navigatorLanguage);
}

export async function readSavedLanguage(storage: AsyncStorage): Promise<Language | null> {
  let saved: string | null = null;
  try {
    saved = await storage.get(languageStorageKey);
  } catch {
    // Private/disabled storage must not prevent an understandable entry screen.
  }
  return supportedLanguage(saved);
}

export function serverLanguage(value: unknown, current: Language): Language {
  return supportedLanguage(value) ?? current;
}
