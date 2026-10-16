import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Language } from "../i18n/language";
import { notificationFlags, notificationHours } from "./settingsApi";
import type { SettingsDraft } from "./settingsController";
import { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen";
import { notificationsCopy } from "./notificationsCopy";
import { settingsResponse } from "./settingsRead.test-support";

// project_notifications §8 (M2): the submenu «Уведомления» of Settings and the row that opens it.
afterEach(cleanup);
function fixture(language: Language = "ru", view: "main" | "notifications" = "notifications") {
  const props: SettingsScreenProps = {
    snapshot: { phase: "ready", data: settingsResponse(), dataCurrent: true, drafts: {}, pending: null, resetPending: null,
      outcome: null, resetOutcome: null, problem: null, canEdit: true, canReset: true, canRetry: false,
      canContinueWithServer: false },
    language, catalog: { phase: "ready", topics: [] },
    actions: { edit: vi.fn(), save: vi.fn(async () => {}), acceptCurrent: vi.fn(), keepMine: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}), retry: vi.fn(async () => {}), reset: vi.fn(async () => {}),
      continueWithServer: vi.fn(async () => {}) },
    onReloadTopics: vi.fn(), onToday: vi.fn(), view, onView: vi.fn(), onOpenBot: vi.fn(),
  };
  return props;
}
const kind = (name: string) => within(screen.getByRole("group", { name }));
const switchOf = (name: string) => kind(name).getByRole("switch") as HTMLInputElement;
const hourOf = (name: string) => kind(name).getByRole("combobox", { name: "Время" }) as HTMLSelectElement;
const kinds = ["Напоминания Learning", "Недельный отчёт", "Ежедневный отчёт #daily", "Вечернее напоминание о повторах"];
function draft(input: unknown, rest: Partial<SettingsDraft> = {}): SettingsDraft {
  return { input, original: 7, fieldVersion: "1", valid: true, conflict: false, error: null, canSave: false, canKeepMine: false, ...rest };
}

describe("submenu «Уведомления» (§8.1)", () => {
  it("shows the zone, four switches, three whole-hour times, the notes and the footnote; no pause and no weekday", () => {
    const { container } = render(<SettingsScreen {...fixture()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Уведомления" })).toBeDefined();
    expect(screen.getByText("Время указано по твоему часовому поясу: Asia/Tokyo")).toBeDefined();
    expect(screen.getAllByRole("switch")).toHaveLength(4);
    expect(kinds.map(name => switchOf(name).checked)).toEqual([true, true, false, true]);
    expect(within(screen.getByRole("group", { name: "Напоминания Learning" })).queryByRole("combobox")).toBeNull();
    expect(screen.getAllByRole("combobox")).toHaveLength(3);
    expect([hourOf("Недельный отчёт").value, hourOf("Ежедневный отчёт #daily").value, hourOf("Вечернее напоминание о повторах").value])
      .toEqual(["7", "7", "18"]);
    const options = Array.from(hourOf("Недельный отчёт").options, option => option.textContent);
    expect(options).toHaveLength(24); expect(options[0]).toBe("00:00"); expect(options[23]).toBe("23:00");
    expect(kind("Недельный отчёт").getByText("Приходит в понедельник за прошлую неделю")).toBeDefined();
    expect(kind("Ежедневный отчёт #daily").getByText("Приходит после окончания суток по твоему времени за эти сутки")).toBeDefined();
    expect(screen.getByText("Сообщения о доступе, ответы на обращения и сообщения безопасности приходят всегда.")).toBeDefined();
    expect(screen.queryByRole("note")).toBeNull();
    const text = container.textContent!;
    for (const absent of ["Пауза", "пауз", "День недели", "Пн", "UTC", "Без паузы"]) expect(text).not.toContain(absent);
    // The main settings are hidden, not shown beside the submenu, and the reset is not offered here.
    expect(screen.queryByRole("button", { name: "Сброс настроек" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
  it("an unset time zone is named as not set", () => {
    const f = fixture(); f.snapshot.data!.settings.time_zone.value = null;
    render(<SettingsScreen {...f} />);
    expect(screen.getByText("Время указано по твоему часовому поясу: Не задано")).toBeDefined();
  });
  it.each([["uk", "Сповіщення", "Тижневий звіт", "Час"], ["en", "Notifications", "Weekly report", "Time"]] as const)(
    "%s texts", (language, title, weekly, time) => {
      render(<SettingsScreen {...fixture(language)} />);
      expect(screen.getByRole("heading", { level: 1, name: title })).toBeDefined();
      expect(within(screen.getByRole("group", { name: weekly })).getByRole("combobox", { name: time })).toBeDefined();
      expect(screen.getAllByRole("switch")).toHaveLength(4);
    });
  it("every language has every working text, and no pause or weekday line", () => {
    for (const copy of Object.values(notificationsCopy)) {
      const lines = [...Object.values(copy).filter(value => typeof value === "string"), copy.zone("Z")];
      expect(lines.every(line => line.length > 0)).toBe(true);
      expect(Object.keys(copy).some(key => /pause|weekday|day$/i.test(key))).toBe(false);
    }
  });
});

describe("saving at once (§8.2)", () => {
  it("a switch saves its own key at once with one command", () => {
    const f = fixture(); render(<SettingsScreen {...f} />);
    fireEvent.click(switchOf("Недельный отчёт"));
    expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("notify_weekly", false);
    expect(f.actions.save).toHaveBeenCalledExactlyOnceWith("notify_weekly");
  });
  it("a time saves its own hour at once as a whole number", () => {
    const f = fixture(); render(<SettingsScreen {...f} />);
    fireEvent.change(hourOf("Вечернее напоминание о повторах"), { target: { value: "21" } });
    expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("evening_reminder_hour", 21);
    expect(f.actions.save).toHaveBeenCalledExactlyOnceWith("evening_reminder_hour");
  });
  it("while a command is in flight every field is closed and the key shows «Сохраняем изменение»", () => {
    const f = fixture(); f.snapshot.canEdit = false; f.snapshot.phase = "sending";
    f.snapshot.pending = { schemaVersion: 1, profileId: "p", clientInstanceId: "c", intent: { command_id: "x", kind: "setting.save",
      expected_field_version: "1", payload: { key: "daily_report_hour", value: 9 } } };
    f.snapshot.drafts = { daily_report_hour: draft(9) };
    render(<SettingsScreen {...f} />);
    for (const element of [...screen.getAllByRole("switch"), ...screen.getAllByRole("combobox")]) {
      expect((element as HTMLInputElement).disabled).toBe(true);
    }
    expect(hourOf("Ежедневный отчёт #daily").value).toBe("9");
    expect(kind("Ежедневный отчёт #daily").getAllByRole("status").map(item => item.textContent)).toContain("Сохраняем изменение");
  });
  it("a saved key says «Сохранено»; an unknown outcome says so beside its key", () => {
    const f = fixture(); f.snapshot.outcome = { commandId: "x", key: "notify_learning", status: "accepted" };
    const { rerender } = render(<SettingsScreen {...f} />);
    expect(kind("Напоминания Learning").getByText("Сохранено")).toBeDefined();
    f.snapshot.outcome = null; f.snapshot.phase = "unresolved"; f.snapshot.canEdit = false;
    f.snapshot.problem = { reason: "network" }; f.snapshot.canRetry = true;
    f.snapshot.pending = { schemaVersion: 1, profileId: "p", clientInstanceId: "c", intent: { command_id: "x", kind: "setting.save",
      expected_field_version: "1", payload: { key: "notify_learning", value: false } } };
    rerender(<SettingsScreen {...f} />);
    expect(kind("Напоминания Learning").getByRole("status").textContent).toBe("Пока не удалось подтвердить сохранение. Проверь состояние или повтори отправку.");
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    expect(f.actions.retry).toHaveBeenCalledOnce();
  });
  it("a version conflict offers the current value, «Принять сохранённое» and «Сохранить моё значение»", () => {
    const f = fixture(); f.snapshot.data!.settings.weekly_report_hour = { value: 8, version: "2" };
    f.snapshot.drafts = { weekly_report_hour: draft(10, { conflict: true, error: "conflict", canKeepMine: true }) };
    render(<SettingsScreen {...f} />);
    const weekly = kind("Недельный отчёт");
    expect(weekly.getByText("Сохранённое значение изменилось. Твой ввод остался.")).toBeDefined();
    expect(weekly.getByText("Сейчас сохранено: 08:00")).toBeDefined();
    fireEvent.click(weekly.getByRole("button", { name: "Принять сохранённое" }));
    expect(f.actions.acceptCurrent).toHaveBeenCalledExactlyOnceWith("weekly_report_hour");
    fireEvent.click(weekly.getByRole("button", { name: "Сохранить моё значение" }));
    expect(f.actions.keepMine).toHaveBeenCalledExactlyOnceWith("weekly_report_hour");
  });
  it("a refused value keeps the user's draft with the refusal line", () => {
    const f = fixture(); f.snapshot.drafts = { evening_reminder_hour: draft(22, { error: "rejected" }) };
    render(<SettingsScreen {...f} />);
    expect(hourOf("Вечернее напоминание о повторах").value).toBe("22");
    expect(kind("Вечернее напоминание о повторах").getByText("Изменение не принято. Проверь значение и попробуй снова.")).toBeDefined();
  });
  it("an undetermined reset closes the submenu's fields until the server's outcome and says so here (N-AC25)", () => {
    const f = fixture(); f.snapshot.phase = "unresolved"; f.snapshot.canEdit = false; f.snapshot.canRetry = true;
    f.snapshot.problem = { reason: "network" };
    f.snapshot.resetPending = { schemaVersion: 2, profileId: "p", clientInstanceId: "c",
      intent: { command_id: "x", kind: "settings.reset", payload: { expected_reset_epoch: "1" } } };
    render(<SettingsScreen {...f} />);
    for (const element of [...screen.getAllByRole("switch"), ...screen.getAllByRole("combobox")]) {
      expect((element as HTMLInputElement).disabled).toBe(true);
    }
    expect(screen.getByRole("alert").textContent).toContain("Пока не удалось подтвердить возврат исходных настроек.");
  });
  it("a mismatch shows the existing continuation line and «Продолжить с текущими настройками»", () => {
    const f = fixture(); f.snapshot.phase = "unresolved"; f.snapshot.canEdit = false; f.snapshot.canContinueWithServer = true;
    f.snapshot.problem = { reason: "mismatch", code: "COMMAND_PAYLOAD_MISMATCH" };
    render(<SettingsScreen {...f} />);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить с текущими настройками" }));
    expect(f.actions.continueWithServer).toHaveBeenCalledOnce();
  });
});

describe("before the bot is opened (R12-15)", () => {
  function closed() {
    const f = fixture(); f.snapshot.data!.notifications.telegram_opened = false;
    // Even a stored true is shown off until the bot is opened.
    f.snapshot.data!.settings.notify_learning.value = true;
    return f;
  }
  it("the switches are shown off and closed, the times stay open, the line and «Открыть бота» are shown", () => {
    const f = closed(); render(<SettingsScreen {...f} />);
    for (const name of kinds) expect(switchOf(name)).toMatchObject({ checked: false, disabled: true });
    for (const element of screen.getAllByRole("combobox")) expect((element as HTMLSelectElement).disabled).toBe(false);
    const note = screen.getByRole("note");
    expect(within(note).getByText("Уведомления включатся, когда ты откроешь бота")).toBeDefined();
    fireEvent.click(within(note).getByRole("button", { name: "Открыть бота" }));
    expect(f.onOpenBot).toHaveBeenCalledOnce();
    fireEvent.click(switchOf("Напоминания Learning"));
    expect(f.actions.edit).not.toHaveBeenCalled(); expect(f.actions.save).not.toHaveBeenCalled();
    fireEvent.change(hourOf("Недельный отчёт"), { target: { value: "9" } });
    expect(f.actions.save).toHaveBeenCalledExactlyOnceWith("weekly_report_hour");
  });
  it("after NOTIFICATIONS_NOT_OPENED (draft dropped, fresh read) no refusal line hides the reason: the bot line is shown", () => {
    const f = closed(); f.snapshot.outcome = { commandId: "x", key: "notify_learning", status: "rejected", code: "NOTIFICATIONS_NOT_OPENED" };
    render(<SettingsScreen {...f} />);
    expect(screen.getByText("Уведомления включатся, когда ты откроешь бота")).toBeDefined();
    expect(screen.queryByText("Изменение не принято. Проверь значение и попробуй снова.")).toBeNull();
    expect(switchOf("Напоминания Learning")).toMatchObject({ checked: false, disabled: true });
  });
});

describe("the row on the settings screen", () => {
  it("is in «Дополнительно» where the pause was, opens the submenu, and the pause field is gone (R14-02)", () => {
    const f = fixture("ru", "main"); render(<SettingsScreen {...f} />);
    expect(screen.queryByRole("group", { name: /Пауза/, hidden: true })).toBeNull();
    const additional = screen.getByText("Дополнительно").closest("details")!;
    additional.open = true;
    fireEvent.click(within(additional).getByRole("button", { name: "Уведомления" }));
    expect(f.onView).toHaveBeenCalledExactlyOnceWith("notifications");
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
  });
  it("«Назад» in the submenu returns to the settings", () => {
    const f = fixture(); render(<SettingsScreen {...f} />);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(f.onView).toHaveBeenCalledExactlyOnceWith("main");
  });
  it("the notification keys are never fields of the main screen", () => {
    render(<SettingsScreen {...fixture("ru", "main")} />);
    for (const key of [...notificationFlags, ...notificationHours]) expect(document.body.textContent).not.toContain(key);
    expect(screen.queryAllByRole("switch", { hidden: true })).toHaveLength(0);
  });
});
