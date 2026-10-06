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
    const replace = renderToStaticMarkup(<EntryScreen language="en" state={{ kind: "replace_confirm", epoch: "1" }} />);
    expect(unavailable).not.toContain("<button");
    expect(rejected).not.toContain("<button");
    expect(replace).not.toContain("<button");
  });

  it.each([
    ["ru", "Wortly уже открыт", "Вернись в другое открытое окно или на другое устройство.",
      "Wortly не может проверить, закрыто ли другое окно. Если продолжить здесь, там изменения сохраняться не будут.",
      "Завершить там и продолжить здесь", "Отмена"],
    ["uk", "Wortly вже відкрито", "Повернися до іншого відкритого вікна або пристрою.",
      "Wortly не може перевірити, чи закрите інше вікно. Якщо продовжити тут, там зміни не зберігатимуться.",
      "Завершити там і продовжити тут", "Скасувати"],
    ["en", "Wortly is already open", "Return to the other open window or device.",
      "Wortly cannot check whether the other window is closed. If you continue here, changes there will not be saved.",
      "End there and continue here", "Cancel"],
  ] as const)("shows the other window and the replacement question in %s", (language, title, busy, replace, confirm, cancel) => {
    const other = renderToStaticMarkup(<EntryScreen language={language} state={{ kind: "other_window" }}
      onRetry={() => {}} onReplaceConfirm={() => {}} onReplaceCancel={() => {}} />);
    expect(other).toContain(title); expect(other).toContain(busy);
    // No «check again» button until the owner's answer (Q37): coming back to the window checks.
    expect(other).not.toContain("<button");
    const question = renderToStaticMarkup(<EntryScreen language={language} state={{ kind: "replace_confirm", epoch: "2" }}
      onReplaceConfirm={() => {}} onReplaceCancel={() => {}} />);
    expect(question).toContain(title); expect(question).toContain(replace);
    expect(question).not.toContain(busy); expect(question).not.toContain(">2<");
    expect(question.match(/<button/g)).toHaveLength(2);
    expect(question).toContain(confirm); expect(question).toContain(cancel);
  });
});
