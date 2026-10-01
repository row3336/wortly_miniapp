import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntryScreen } from "./EntryScreen";

describe("entry messages", () => {
  it.each([
    ["ru", "Заявка отправлена", "Не удалось открыть Wortly"],
    ["uk", "Заявку надіслано", "Не вдалося відкрити Wortly"],
    ["en", "Request sent", "Wortly could not open"],
  ] as const)("has pre-API messages in %s", (language, pending, unavailable) => {
    expect(renderToStaticMarkup(<EntryScreen language={language} state={{ kind: "pending" }} />)).toContain(pending);
    expect(renderToStaticMarkup(<EntryScreen language={language} state={{ kind: "unavailable" }} />)).toContain(unavailable);
  });

  it("does not offer a fake retry or reapplication without handlers", () => {
    const unavailable = renderToStaticMarkup(<EntryScreen language="en" state={{ kind: "unavailable" }} />);
    const rejected = renderToStaticMarkup(<EntryScreen language="en" state={{ kind: "rejected" }} />);
    expect(unavailable).not.toContain("<button");
    expect(rejected).not.toContain("<button");
  });
});
