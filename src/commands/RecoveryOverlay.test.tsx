// The cover of the automatic recovery (Я15): buttonless, except 9.2.10 under the unconfirmed status 9.2.9 (R10, C093 §6).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Language } from "../i18n/language";
import { recoveryCover } from "./CommandRecovery";
import { ClosedCheckStatus, RecoveryOverlay, type RecoveryScreen } from "./RecoveryOverlay";

afterEach(() => cleanup());
const waiting = (status: Extract<RecoveryScreen, { kind: "waiting" }>["status"]): RecoveryScreen => ({ kind: "waiting", status, pauseSeconds: null });

describe("the unconfirmed cover (9.2.9 and 9.2.10)", () => {
  it.each([
    ["ru", "Не удалось подтвердить последнее действие. Мы продолжаем проверять. Можно завершить занятие.", "Завершить занятие"],
    ["uk", "Не вдалося підтвердити останню дію. Ми продовжуємо перевіряти. Можна завершити заняття.", "Завершити заняття"],
    ["en", "We couldn't confirm your last action. We keep checking. You can end the session.", "End session"],
  ] as const)("%s: the catalog text, the indicator and one button", (language: Language, text, button) => {
    const { container } = render(<RecoveryOverlay screen={waiting("unconfirmed")} language={language} canEnd onEnd={vi.fn()} />);
    expect(container.querySelector("p")?.textContent).toBe(text);
    expect(container.querySelector(".wortly-loader")).not.toBeNull();
    expect(container.querySelector(".recovery-overlay")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getAllByRole("button").map(item => item.textContent)).toEqual([button]);
  });
  it("calls the ordinary Stop once per click and does nothing while Stop is not allowed", () => {
    const onEnd = vi.fn();
    const { rerender } = render(<RecoveryOverlay screen={waiting("unconfirmed")} language="ru" canEnd={false} onEnd={onEnd} />);
    const button = screen.getByRole("button", { name: "Завершить занятие" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button); expect(onEnd).not.toHaveBeenCalled();
    rerender(<RecoveryOverlay screen={waiting("unconfirmed")} language="ru" canEnd onEnd={onEnd} />);
    expect((screen.getByRole("button", { name: "Завершить занятие" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие" })); expect(onEnd).toHaveBeenCalledTimes(1);
  });
  it("shows no button without a handler", () => {
    render(<RecoveryOverlay screen={waiting("unconfirmed")} language="ru" canEnd />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it.each(["checking", "offline", "resending", "maintenance"] as const)("%s keeps the buttonless cover with its own text", status => {
    const { container } = render(<RecoveryOverlay screen={waiting(status)} language="ru" canEnd onEnd={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("p")?.textContent).not.toContain("Можно завершить занятие");
  });
  it("the unsaved screen keeps no button either", () => {
    render(<RecoveryOverlay screen={{ kind: "unsaved" }} language="ru" canEnd onEnd={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the wait for the card to show (Q25.2)", () => {
  it("is not covered by the unconfirmed status either; any other action is", () => {
    const unconfirmed = waiting("unconfirmed");
    expect(recoveryCover(unconfirmed, { primary: { pendingIntent: { kind: "assignment.present" } } })).toBeNull();
    expect(recoveryCover(unconfirmed, { primary: { pendingIntent: { kind: "answer.submit" } } })).toBe(unconfirmed);
  });
});

describe("the closed-session check under counter_unknown (state Н6)", () => {
  // The session is closed, so the unconfirmed status must not offer 9.2.9 or the Stop button of 9.2.10: only 9.2.1.
  it.each([
    ["ru", "Проверяем, сохранилось ли действие…"],
    ["uk", "Перевіряємо, чи збереглася дія…"],
    ["en", "Checking whether your action was saved…"],
  ] as const)("%s: shows 9.2.1 without 9.2.9 and without a button", (language: Language, checking) => {
    const { container } = render(<ClosedCheckStatus screen={waiting("unconfirmed")} language={language} className="learning-closed-check" />);
    expect(container.querySelector("p")?.textContent).toBe(checking);
    expect(container.textContent).not.toMatch(/Не удалось подтвердить|Не вдалося підтвердити|couldn't confirm/);
    expect(container.querySelector(".wortly-loader")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/Завершить занятие|Завершити заняття|End session/)).toBeNull();
  });
});
