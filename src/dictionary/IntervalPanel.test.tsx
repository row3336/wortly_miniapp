import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryContextInterval } from "../api/generated";
import type { DictionaryIntervalSnapshot } from "./dictionaryIntervalController";
import { IntervalPanel } from "./IntervalPanel";
import type { DictionaryIntervalContextActions } from "./useDictionaryIntervalContext";

// Snapshots shaped as DictionaryIntervalController publishes them (core C-INTV / C-INTV-OFFER projection).
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const TODAY = "2026-09-29";
const addDays = (days: number) => {
  const date = new Date(`${TODAY}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
};
afterEach(cleanup);

function interval(steps: number[] = [15, 23, 36, 58, 94, 155], version = "7", initial = 5): DictionaryContextInterval {
  return { local_date: TODAY, expected_pair: "ru-de", direction: "l1-de", applicable: true,
    current_schedule: { interval_days: 10, next_due_date: "2026-10-05", persisted: true }, expected_progress_version: version,
    options: steps.map((days, index) => ({ option_id: index + 1, interval_days: days, next_due_date: addDays(days) })),
    default_option_id: steps.length ? Math.min(initial, steps.length) : null };
}
function snapshot(patch: Partial<DictionaryIntervalSnapshot> = {}): DictionaryIntervalSnapshot {
  const value = patch.interval === undefined ? interval() : patch.interval;
  return { phase: "ready", cardId: id(1), context: { id: id(500), kind: "dictionary", card_id: id(1) }, view: null,
    interval: value, capabilities: { interval_increase: value && value.options.length ? { direction: "l1-de" } : null,
      undo_offer: null, undo_target: null },
    pending: null, problem: null, stateVersion: "41", canIncrease: !!value?.options.length, canUndo: false, canRetry: false,
    undoOffer: null, applied: null, ...patch };
}
function harness(initial: DictionaryIntervalSnapshot) {
  const actions: DictionaryIntervalContextActions = { increase: vi.fn(async () => undefined), undo: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined), close: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined) };
  const view = render(<IntervalPanel language="ru" context={{ state: initial, actions }} />);
  const show = (state: DictionaryIntervalSnapshot) => view.rerender(<IntervalPanel language="ru" context={{ state, actions }} />);
  return { actions, show };
}
const dialog = () => screen.getByRole("dialog", { name: "Увеличить интервал" });
const slider = () => within(dialog()).getByRole("slider", { name: "Новый интервал" }) as HTMLInputElement;

describe("IntervalPanel: the bottom window of the manual increase (TA:149, К07-059…067)", () => {
  it("no capability (top step, phrase, Learning): no control at all (К07-063, К07-064)", () => {
    harness(snapshot({ interval: interval([]) }));
    expect(screen.queryByRole("button", { name: "Увеличить интервал" })).toBeNull();
    cleanup();
    harness(snapshot({ interval: null }));
    expect(screen.queryByRole("button", { name: "Увеличить интервал" })).toBeNull();
  });

  it("one slider over the offered steps, starting at default_option_id, with real days and date; one confirmation", () => {
    const { actions } = harness(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    // +5 conditional successes: option 5 (94 days).
    expect(slider().value).toBe("4");
    expect(slider().getAttribute("aria-valuetext")).toMatch(/^94 дн\., /);
    expect(within(dialog()).getByText("94 дн.")).toBeTruthy();
    expect(within(dialog()).queryByRole("checkbox")).toBeNull();
    expect(within(dialog()).queryByRole("textbox")).toBeNull();
    fireEvent.change(slider(), { target: { value: "5" } });
    expect(within(dialog()).getByText("155 дн.")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    expect(actions.increase).toHaveBeenCalledTimes(1);
    expect(actions.increase).toHaveBeenCalledWith({ option_id: 6 });
  });

  it("fewer than five steps: the last one is the initial position (Т82: 8 or 2 steps → +5 or +2)", () => {
    harness(snapshot({ interval: interval([3, 5], "1", 5) }));
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    expect(slider().value).toBe("1");
    expect(within(dialog()).getByText("5 дн.")).toBeTruthy();
  });

  it("while saving: blurred screen with a circle, nothing can be confirmed; success closes the window (К07-122, К07-123)", () => {
    const { show } = harness(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    show(snapshot({ pending: { kind: "interval.increase", commandId: id(101), status: "sending", busy: true }, canIncrease: false }));
    expect(screen.getByRole("status", { name: "Сохраняем…" })).toBeTruthy();
    expect((within(dialog()).getByRole("button", { name: "Увеличить" }) as HTMLButtonElement).disabled).toBe(true);
    show(snapshot({ interval: interval([155]), applied: { kind: "interval.increase", commandId: id(101), stateVersion: "42" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("unknown outcome: the window says so and «Повторить» repeats the same command; closing the window keeps the check (Т84)", () => {
    const { actions, show } = harness(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    const unknown = { kind: "interval.increase" as const, commandId: id(101), status: "unknown" as const, busy: true };
    show(snapshot({ pending: unknown, problem: { reason: "network" }, canIncrease: false }));
    expect(within(dialog()).getByRole("alert").textContent).toContain("Нет подтверждения. Проверяем…");
    expect(screen.getByRole("status", { name: "Сохраняем…" })).toBeTruthy();
    show(snapshot({ pending: { ...unknown, busy: false }, problem: { reason: "not_found" }, canIncrease: false, canRetry: true }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(within(dialog()).getByRole("alert").textContent).toContain("Увеличение не подтверждено");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Повторить" }));
    expect(actions.retry).toHaveBeenCalledTimes(1);
    expect(actions.increase).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.close).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Увеличение не подтверждено");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(actions.retry).toHaveBeenCalledTimes(2);
    // Reopening the window checks the same command again, it never creates a new increase.
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    expect(actions.refresh).toHaveBeenCalledTimes(1);
    expect(actions.increase).toHaveBeenCalledTimes(1);
  });

  it("VERSION_CONFLICT: the new preview puts the slider on its new default and asks again; nothing is sent by itself", () => {
    const { actions, show } = harness(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    fireEvent.change(slider(), { target: { value: "1" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    show(snapshot({ interval: interval([20, 30, 40, 60, 100, 160, 270], "8"), problem: { reason: "rejected", code: "VERSION_CONFLICT" } }));
    expect(within(dialog()).getByRole("alert").textContent).toContain("Срок изменился. Проверьте новый выбор.");
    expect(slider().value).toBe("4");
    expect(within(dialog()).getByText("100 дн.")).toBeTruthy();
    expect(actions.increase).toHaveBeenCalledTimes(1);
  });

  it("another known refusal keeps the choice for a new confirmation", () => {
    const { actions, show } = harness(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    fireEvent.change(slider(), { target: { value: "2" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    show(snapshot({ problem: { reason: "rejected", code: "WRITE_UNAVAILABLE" } }));
    expect(within(dialog()).getByRole("alert").textContent).toContain("Не удалось увеличить интервал");
    expect(slider().value).toBe("2");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    expect(actions.increase).toHaveBeenLastCalledWith({ option_id: 3 });
  });

  it("Escape closes only the window, not the card context (TA:151)", () => {
    const { actions } = harness(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(actions.close).not.toHaveBeenCalled();
  });
});

describe("IntervalPanel: «Отменить увеличение» with the 3 second bar (К07-122, CT 2.1.2)", () => {
  it("shown only with the controller's undo offer; the bar keeps the timing of its first showing", () => {
    const offered = { capabilities: { interval_increase: { direction: "l1-de" as const },
      undo_offer: { action_id: id(501), context_id: id(500), status: "offered" as const, version: "2" },
      undo_target: { action_id: id(501), kind: "interval.increase" as const, version: "1", context_id: id(500) } },
      applied: { kind: "interval.increase" as const, commandId: id(101), stateVersion: "43" } };
    const { actions, show } = harness(snapshot({ ...offered, undoOffer: null }));
    expect(screen.queryByRole("button", { name: "Отменить увеличение" })).toBeNull();
    show(snapshot({ ...offered, undoOffer: { remainingMs: 2500, durationMs: 3000 }, canUndo: true }));
    const bar = document.querySelector(".interval-undo-bar") as HTMLElement;
    expect(bar.style.animationDuration).toBe("3000ms");
    expect(bar.style.animationDelay).toBe("-500ms");
    show(snapshot({ ...offered, undoOffer: { remainingMs: 1000, durationMs: 3000 }, canUndo: true }));
    expect((document.querySelector(".interval-undo-bar") as HTMLElement).style.animationDelay).toBe("-500ms");
    fireEvent.click(screen.getByRole("button", { name: "Отменить увеличение" }));
    expect(actions.undo).toHaveBeenCalledTimes(1);
    show(snapshot({ ...offered, undoOffer: null }));
    expect(screen.queryByRole("button", { name: "Отменить увеличение" })).toBeNull();
  });

  it("a pending undo blurs the screen; a refused undo says so; an unknown one offers «Повторить»", () => {
    const { actions, show } = harness(snapshot({ undoOffer: { remainingMs: 3000, durationMs: 3000 }, canUndo: true }));
    fireEvent.click(screen.getByRole("button", { name: "Отменить увеличение" }));
    show(snapshot({ pending: { kind: "action.undo", commandId: id(103), status: "sending", busy: true } }));
    expect(screen.getByRole("status", { name: "Сохраняем…" })).toBeTruthy();
    show(snapshot({ pending: { kind: "action.undo", commandId: id(103), status: "unknown", busy: false }, canRetry: true }));
    expect(screen.getByRole("alert").textContent).toContain("Отмена увеличения не подтверждена");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(actions.retry).toHaveBeenCalledTimes(1);
    act(() => show(snapshot({ problem: { reason: "rejected", code: "CAPABILITY_EXPIRED" } })));
    expect(screen.getByRole("alert").textContent).toContain("Не удалось отменить увеличение");
  });
});

describe("IntervalPanel after QA (M-INTV-QA: QA-P, QA-W, Н1, Н6)", () => {
  it("the slider starts on the server's default even when it is not +5: step 3 of 8 (C-INTV Р2), with its days", () => {
    const { actions } = harness(snapshot({ interval: interval([15, 23, 36, 58, 94, 155, 259, 438], "7", 3) }));
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    expect(slider().value).toBe("2");
    expect([slider().min, slider().max]).toEqual(["0", "7"]);
    expect(within(dialog()).getByText("36 дн.")).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    expect(actions.increase).toHaveBeenCalledWith({ option_id: 3 });
  });

  it("steps but no capability (excluded, Learning): no control", () => {
    harness(snapshot({ capabilities: { interval_increase: null, undo_offer: null, undo_target: null }, canIncrease: false }));
    expect(screen.queryByRole("button", { name: "Увеличить интервал" })).toBeNull();
  });

  it("uk and en: the control, the window and the undo have their texts", () => {
    for (const [language, open, undo] of [["uk", "Збільшити інтервал", "Скасувати збільшення"], ["en", "Increase interval", "Undo increase"]] as const) {
      const actions: DictionaryIntervalContextActions = { increase: vi.fn(async () => undefined), undo: vi.fn(async () => undefined),
        retry: vi.fn(async () => undefined), close: vi.fn(async () => undefined), refresh: vi.fn(async () => undefined) };
      render(<IntervalPanel language={language} context={{ state: snapshot({ undoOffer: { remainingMs: 3000, durationMs: 3000 },
        canUndo: true }), actions }} />);
      expect(screen.getByRole("button", { name: undo })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: open }));
      expect(screen.getByRole("dialog", { name: open })).toBeTruthy();
      cleanup();
    }
  });

  it("a status check of a pending undo blurs the screen and offers no «Повторить» yet", () => {
    harness(snapshot({ pending: { kind: "action.undo", commandId: id(9), status: "unknown", busy: true } }));
    expect(screen.getByRole("status", { name: "Сохраняем…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  });

  it("Н1: after the increase closed the window, its accepted undo does not open it again (TA:151, К07-122)", () => {
    const { show } = harness(snapshot());
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Увеличить" }));
    show(snapshot({ interval: interval([155]), applied: { kind: "interval.increase", commandId: id(101), stateVersion: "42" },
      undoOffer: { remainingMs: 3000, durationMs: 3000 }, canUndo: true }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Отменить увеличение" }));
    show(snapshot({ applied: { kind: "action.undo", commandId: id(102), stateVersion: "44" } }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // A new window is the user's explicit choice.
    fireEvent.click(screen.getByRole("button", { name: "Увеличить интервал" }));
    expect(dialog()).toBeTruthy();
  });

  it("Н6: the strip is announced politely when it appears", () => {
    harness(snapshot({ undoOffer: { remainingMs: 3000, durationMs: 3000 }, canUndo: true }));
    const region = screen.getByRole("button", { name: "Отменить увеличение" }).closest("[role=status]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });
});

