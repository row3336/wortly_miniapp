import { describe, expect, it } from "vitest";
import { chooseInitialLanguage, loadInitialLanguage, readSavedLanguage, serverLanguage, supportedLanguage } from "./language";

describe("initial UI language", () => {
  it("uses the saved choice before Telegram and browser hints", () => {
    expect(chooseInitialLanguage("ru-RU", "uk-UA", "en-GB")).toBe("ru");
  });

  it("uses Telegram before navigator.language when the saved value is unsupported", () => {
    expect(chooseInitialLanguage("de", "uk_UA", "ru-RU")).toBe("uk");
  });

  it("uses browser language and finally English", () => {
    expect(chooseInitialLanguage(null, "de", "ru-RU")).toBe("ru");
    expect(chooseInitialLanguage(null, "de", "fr-FR")).toBe("en");
  });

  it("ignores empty and malformed hints", () => {
    expect(supportedLanguage(" uk-UA ")).toBe("uk");
    expect(supportedLanguage("english")).toBeNull();
    expect(supportedLanguage(42)).toBeNull();
  });

  it("keeps the entry understandable when storage rejects", async () => {
    const storage = {
      async get() { throw new Error("Storage blocked"); },
      async set() {},
      async remove() {},
    };
    await expect(loadInitialLanguage(storage, "uk", "ru")).resolves.toBe("uk");
    await expect(readSavedLanguage(storage)).resolves.toBeNull();
  });

  it("keeps the saved preference separate from Telegram and browser hints", async () => {
    const storage = { async get() { return "ru-RU"; }, async set() {}, async remove() {} };
    await expect(readSavedLanguage(storage)).resolves.toBe("ru");
    await expect(loadInitialLanguage(storage, "uk", "en")).resolves.toBe("ru");
  });

  it("accepts the server choice after authorization", () => {
    expect(serverLanguage("uk-UA", "ru")).toBe("uk");
    expect(serverLanguage("de", "ru")).toBe("ru");
  });
});
