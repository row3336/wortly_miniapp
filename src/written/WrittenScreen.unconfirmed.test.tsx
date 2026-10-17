// An unknown count of sends (counter_unknown) in the written quiz: 9.2.9 and the voluntary Stop 9.2.10 on the cover, as in
// Learning (R10, C093 §6, D-TEXT-DEFECTS 3.2 п. 4). The real document owner over the synthetic written server, on fake time.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Language } from "../i18n/language";
import type { WrittenIntent } from "./writtenIntent";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { id, tick, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const texts = {
  ru: { text: "Не удалось подтвердить последнее действие. Мы продолжаем проверять. Можно завершить занятие.", end: "Завершить занятие" },
  uk: { text: "Не вдалося підтвердити останню дію. Ми продовжуємо перевіряти. Можна завершити заняття.", end: "Завершити заняття" },
  en: { text: "We couldn't confirm your last action. We keep checking. You can end the session.", end: "End session" },
} as const;

/** A reload with a saved answer whose receipt is missing: the count is unknown, only checks remain (CT §6.1 п. 4). */
async function reloaded(language: Language = "ru") {
  vi.useFakeTimers();
  const saved: WrittenIntent = { command_id: id(400), session_id: id(3), kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } };
  const f = writtenFixture({ active: true, saved: { primary: saved } });
  f.replace({ session: { id: id(3), phase: "active" } });
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: "normal", initialSessionId: id(3) });
    return state ? <WrittenScreen state={state} language={language} submitOnEnter actions={actions} onToday={vi.fn()} /> : null;
  }
  render(<Harness />);
  const step = (ms = 0) => act(() => tick(ms));
  await step(); await step(1000);
  const overlay = () => document.querySelector(".recovery-overlay");
  return { ...f, step, overlay };
}

describe("the written quiz, an unknown count of sends", () => {
  it.each(["ru", "uk", "en"] as const)("%s: the catalog text and one button, no resend or manual check", async language => {
    const h = await reloaded(language);
    expect(h.overlay()?.querySelector("p")?.textContent).toBe(texts[language].text);
    expect(Array.from(h.overlay()!.querySelectorAll("button")).map(button => button.textContent)).toEqual([texts[language].end]);
    for (const name of ["Проверить состояние", "Повторить отправку", "Перевірити стан", "Повторити надсилання", "Check status", "Retry sending"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(h.posts()).toEqual([]);
  });
  it("the button is the ordinary Stop: one session.stop with reason stop, then the cover is gone", async () => {
    const h = await reloaded();
    const hold = h.hold();
    const end = () => screen.getByRole("button", { name: "Завершить занятие" }) as HTMLButtonElement;
    expect(end().disabled).toBe(false);
    fireEvent.click(end()); await h.step();
    expect(h.posts().map(post => post.kind)).toEqual(["session.stop"]);
    // T1 (project notices §4.1, core 35c3844): the person's Stop names the unconfirmed answer X; before M1b it was {reason: "stop"}.
    expect(h.posts()[0].payload).toEqual({ reason: "stop", unsaved_command_id: id(400) });
    expect(end().disabled).toBe(true);
    fireEvent.click(end()); await h.step();
    expect(h.posts()).toHaveLength(1);
    expect(h.overlay()?.textContent).toContain("Не удалось подтвердить последнее действие.");
    hold.resolve(); await h.step(); await h.step(1000);
    expect(h.overlay()).toBeNull();
    expect(h.posts().map(post => post.kind)).toEqual(["session.stop"]);
  });
});
