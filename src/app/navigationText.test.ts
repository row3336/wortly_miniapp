import { describe, expect, it } from "vitest";
import { directionLabel, iconLabel, iconNames, navigationText, type DictionaryPair } from "../i18n/messages";
import { supportedLanguages } from "../i18n/language";
import sprite from "../../public/icons/i1-symbols.svg?raw";

describe("direction labels (И04, TA:168): spelled by the UI language, languages from the dictionary pair", () => {
  it.each([
    ["ru", "ru-de", "Рус → Нем", "Нем → Рус"],
    ["ru", "uk-de", "Укр → Нем", "Нем → Укр"],
    ["uk", "ru-de", "Рос → Нім", "Нім → Рос"],
    ["uk", "uk-de", "Укр → Нім", "Нім → Укр"],
    ["en", "ru-de", "Ru → De", "De → Ru"],
    ["en", "uk-de", "Uk → De", "De → Uk"],
  ] as const)("UI %s, pair %s", (language, pair, toGerman, fromGerman) => {
    expect(directionLabel(language, pair, "l1-de")).toBe(toGerman);
    expect(directionLabel(language, pair, "de-l1")).toBe(fromGerman);
  });

  it("never takes the source language from the UI language", () => {
    // A Russian pair stays Russian in every UI; a Ukrainian UI never turns it into Ukrainian.
    for (const language of supportedLanguages) {
      expect(directionLabel(language, "ru-de", "l1-de")).toBe({ ru: "Рус → Нем", uk: "Рос → Нім", en: "Ru → De" }[language]);
    }
    expect(directionLabel("uk", "ru-de", "l1-de")).not.toContain("Укр");
    expect(directionLabel("ru", "uk-de", "l1-de")).not.toContain("Рус");
  });

  it("always uses the arrow →", () => {
    for (const language of supportedLanguages) for (const pair of ["ru-de", "uk-de"] as DictionaryPair[]) {
      expect(directionLabel(language, pair, "l1-de")).toMatch(/^\S+ → \S+$/);
    }
  });

  it("leaves the en-de pair without an abbreviation: the specification names none for English (owner question)", () => {
    for (const language of supportedLanguages) {
      expect(directionLabel(language, "en-de", "l1-de")).toBeNull();
      expect(directionLabel(language, "en-de", "de-l1")).toBeNull();
    }
  });
});

describe("working navigation and icon names", () => {
  it("names the three sections in every UI language", () => {
    expect(supportedLanguages.map(language => [navigationText(language).today, navigationText(language).dictionary,
      navigationText(language).settings])).toEqual([["Сьогодні", "Словник", "Налаштування"], ["Today", "Dictionary", "Settings"],
      ["Сегодня", "Словарь", "Настройки"]]);
  });

  it("gives every И1 symbol a non-empty screen-reader name in every UI language", () => {
    for (const language of supportedLanguages) for (const name of iconNames) expect(iconLabel(language, name).trim()).not.toBe("");
  });

  it("ships the accepted И1 sprite with exactly these symbol ids", () => {
    const ids = Array.from(sprite.matchAll(/<symbol id="([a-z]+)"/g), match => match[1]);
    expect(ids).toEqual([...iconNames]);
  });
});
