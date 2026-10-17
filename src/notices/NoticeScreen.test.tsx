import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NoticeView } from "../api/generated";
import type { Language } from "../i18n/language";
import { noticeLines } from "./noticeCopy";
import { NoticeScreen } from "./NoticeScreen";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const view = (extra: Partial<NoticeView> = {}): NoticeView => ({ notice_id: id(101), kind: "answer_loss", session_id: id(201),
  mode: "written", close_reason: "save_failed", defect_class: null, created_at: "2026-10-07T00:00:01Z",
  summary: { completed: 7, correct: 5, wrong: 2, ratio: { numerator: 5, denominator: 7 } }, ...extra });
afterEach(cleanup);
// R2-05 (owner's addition) and CON §6.1 п.9: no «знаем и работаем» / «мы оповещены» while defect_class is null.
const KNOWN_DEFECT = /знаем|работаем|оповещен|знаємо|працюємо|we know|working on/i;

describe("NoticeScreen (project notices ed.2.4 §6)", () => {
  it.each<[Language, string]>([
    ["ru", "Не удалось сохранить последнее действие. Занятие завершено. Ранее сохранённый прогресс не потерян."],
    ["uk", "Не вдалося зберегти останню дію. Заняття завершено. Раніше збережений прогрес не втрачено."],
    ["en", "We couldn't save your last action. The session has ended. Your earlier progress is safe."],
  ])("answer_loss + save_failed: line 9.2.7 (%s), the summary numbers, «Далее»", (language, line) => {
    const onAcknowledge = vi.fn();
    render(<NoticeScreen notice={view()} language={language} acking={false} onAcknowledge={onAcknowledge} />);
    expect(screen.getByText(line)).toBeTruthy();
    const region = screen.getByRole("region");
    expect(region.textContent).toContain("7"); expect(region.textContent).toContain("5"); expect(region.textContent).toContain("2");
    expect(region.textContent).not.toMatch(KNOWN_DEFECT);
    expect(onAcknowledge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: { ru: "Далее", uk: "Далі", en: "Next" }[language] }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });
  it("answer_loss + stop: R2-05 in ru; uk/en have no approved text and show no line of their own", () => {
    render(<NoticeScreen notice={view({ close_reason: "stop" })} language="ru" acking={false} onAcknowledge={() => {}} />);
    expect(screen.getByText("Занятие завершено.")).toBeTruthy();
    expect(screen.getByText("Последний ответ не сохранился. Остальные ответы сохранены.")).toBeTruthy();
    cleanup();
    expect(noticeLines.uk.stopLost).toBeNull(); expect(noticeLines.en.stopLost).toBeNull();
    render(<NoticeScreen notice={view({ close_reason: "stop" })} language="en" acking={false} onAcknowledge={() => {}} />);
    expect(screen.getByRole("region").querySelectorAll("p")).toHaveLength(0);
  });
  it("oral_forced_close: the reason and «На Сегодня», the oral summary", () => {
    const onAcknowledge = vi.fn();
    render(<NoticeScreen notice={view({ kind: "oral_forced_close", mode: "oral", close_reason: "timezone_date_changed" })}
      language="ru" acking={false} onAcknowledge={onAcknowledge} />);
    expect(screen.getByText("Занятие закрыто: сменилась дата")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    expect(onAcknowledge).toHaveBeenCalledTimes(1);
  });
  it.each(["ru", "uk", "en"] as const)("defect_class null (and absent): no «знаем и работаем» in any kind (%s)", language => {
    for (const notice of [view(), view({ close_reason: "stop" }), view({ kind: "oral_forced_close", mode: "oral", close_reason: "midnight" })]) {
      const { defect_class: _null, ...absent } = notice;
      for (const shown of [notice, absent as NoticeView]) {
        render(<NoticeScreen notice={shown} language={language} acking={false} onAcknowledge={() => {}} />);
        expect(document.body.textContent).not.toMatch(KNOWN_DEFECT);
        cleanup();
      }
    }
  });
  it("while its acknowledgement runs the press waits; a Learning summary without numbers shows none", () => {
    const onAcknowledge = vi.fn();
    render(<NoticeScreen notice={view({ mode: "learning", summary: { group_status: "active", total: 4, preview_position: 4 } })}
      language="ru" acking onAcknowledge={onAcknowledge} />);
    const button = screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(screen.getByRole("region").querySelector("dl")).toBeNull();
  });
});
