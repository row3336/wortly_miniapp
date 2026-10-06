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

  it.each([
    ["ru", "Wortly уже открыт", "Вернись в другое открытое окно или на другое устройство.", "Не удалось открыть Wortly"],
    ["uk", "Wortly вже відкрито", "Повернися до іншого відкритого вікна або пристрою.", "Не вдалося відкрити Wortly"],
    ["en", "Wortly is already open", "Return to the other open window or device.", "Wortly could not open"],
  ] as const)("a replaced window that cannot close shows the busy screen without any button in %s (until Q54)", (language, title, busy, unavailable) => {
    const replaced = renderToStaticMarkup(<EntryScreen language={language} state={{ kind: "replaced" }}
      onRetry={() => {}} onReapply={() => {}} />);
    expect(replaced).toContain(title); expect(replaced).toContain(busy);
    expect(replaced).not.toContain(unavailable);
    expect(replaced).not.toContain("<button");
  });
});
