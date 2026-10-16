// M-P03-9 (the texts of §4.8 by cause) and the rule of the button of §4.1 (C335) on the shared controls: CommandRecovery,
// the window status of К-11/К-9а (WindowRecoveryStatus) and the entry screen (§4.13 routes, К-9, closed window, K13).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRecovery, gateWaitText } from "./CommandRecovery";
import { WindowRecoveryStatus } from "./RecoveryOverlay";
import { commandCopy, recoveryCopy } from "./commandCopy";
import { EntryScreen } from "../app/EntryScreen";
import { t } from "../i18n/messages";
import type { LaneGate } from "./gateWait";

afterEach(() => { cleanup(); });

const open: LaneGate = { checkable: true, primaryWritable: true, stopWritable: true, wait: null };
const held = (wait: LaneGate["wait"]): LaneGate => ({ checkable: false, primaryWritable: false, stopWritable: false, wait });

describe("§4.8 by cause (M-P03-9): the wait line of a manual control", () => {
  it.each(["ru", "uk", "en"] as const)("maintenance or a hold → commandMaintenance with the estimate; else 9.2.2 / 9.2.1 (%s)", language => {
    expect(gateWaitText(language, { cause: "maintenance", waitSeconds: 40 }))
      .toBe(`${t(language).commandMaintenance} ${t(language).maintenanceWaitSeconds.replace("{n}", "40")}`);
    expect(gateWaitText(language, { cause: "maintenance", waitSeconds: 0 })).toBe(`${t(language).commandMaintenance} ${t(language).maintenanceOver}`);
    expect(gateWaitText(language, { cause: "maintenance", waitSeconds: null })).toBe(t(language).commandMaintenance);
    expect(gateWaitText(language, { cause: "maintenance", waitSeconds: 600 }))
      .toBe(`${t(language).commandMaintenance} ${t(language).maintenanceWaitMinutes.replace("{n}", "10")}`);
    expect(gateWaitText(language, { cause: "offline" })).toBe(recoveryCopy[language].offline);
    expect(gateWaitText(language, { cause: "checking" })).toBe(recoveryCopy[language].checking);
  });

  it.each(["ru", "uk", "en"] as const)("the window status of К-11/К-9а: 9.2.2, 9.2.4 with the estimate, 9.2.1; no button (%s)", language => {
    const { rerender, container } = render(<WindowRecoveryStatus language={language} wait={{ cause: "offline" }} />);
    expect(screen.getByRole("status").textContent).toBe(recoveryCopy[language].offline);
    rerender(<WindowRecoveryStatus language={language} wait={{ cause: "maintenance", waitSeconds: 30 }} />);
    expect(screen.getByRole("status").textContent)
      .toBe(`${recoveryCopy[language].maintenance} ${t(language).maintenanceWaitSeconds.replace("{n}", "30")}`);
    rerender(<WindowRecoveryStatus language={language} wait={{ cause: "checking" }} />);
    expect(screen.getByRole("status").textContent).toBe(recoveryCopy[language].checking);
    expect(container.querySelector("button")).toBeNull();
  });
});

describe("CommandRecovery under the write gate (§4.1 «Правило кнопки», C335)", () => {
  const lanes = [{ phase: "unresolved", problem: "paused" }, { phase: "idle" }];
  it("held: «Проверить» and both resends stay visible and inactive with the wait; a press does nothing", () => {
    const onCheck = vi.fn(), onRetry = vi.fn();
    render(<CommandRecovery className="x" language="ru" lanes={lanes} canRetryPrimary canRetryStop onCheck={onCheck} onRetry={onRetry}
      gate={held({ cause: "maintenance", waitSeconds: 40 })} />);
    for (const name of [commandCopy.ru.check, commandCopy.ru.retry, commandCopy.ru.retryStop]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onCheck).not.toHaveBeenCalled(); expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(gateWaitText("ru", { cause: "maintenance", waitSeconds: 40 }));
  });

  it("the check follows checkButtonActive alone: a family-locked ID keeps its check, not its resend", () => {
    const onCheck = vi.fn(), onRetry = vi.fn();
    render(<CommandRecovery className="x" language="ru" lanes={lanes} canRetryPrimary canRetryStop={false} onCheck={onCheck}
      onRetry={onRetry} gate={{ checkable: true, primaryWritable: false, stopWritable: true, wait: null }} />);
    fireEvent.click(screen.getByRole("button", { name: commandCopy.ru.check }));
    fireEvent.click(screen.getByRole("button", { name: commandCopy.ru.retry }));
    expect(onCheck).toHaveBeenCalledOnce(); expect(onRetry).not.toHaveBeenCalled();
  });

  it("open: the controls act at once; no wait line", () => {
    const onCheck = vi.fn(), onRetry = vi.fn();
    render(<CommandRecovery className="x" language="en" lanes={lanes} canRetryPrimary canRetryStop onCheck={onCheck} onRetry={onRetry} gate={open} />);
    fireEvent.click(screen.getByRole("button", { name: commandCopy.en.check }));
    fireEvent.click(screen.getByRole("button", { name: commandCopy.en.retry }));
    fireEvent.click(screen.getByRole("button", { name: commandCopy.en.retryStop }));
    expect(onCheck).toHaveBeenCalledOnce(); expect(onRetry.mock.calls).toEqual([["primary"], ["stop"]]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the local cleanup of a confirmed outcome sends and reads nothing: the gate does not hold it", () => {
    const onCheck = vi.fn();
    render(<CommandRecovery className="x" language="ru" lanes={lanes} canRetryPrimary={false} canRetryStop={false} localOnly
      onCheck={onCheck} onRetry={vi.fn()} gate={held({ cause: "offline" })} />);
    fireEvent.click(screen.getByRole("button", { name: commandCopy.ru.updateDevice }));
    expect(onCheck).toHaveBeenCalledOnce();
  });
});

describe("the entry screen (§4.13 routes, К-9, closed window, K13)", () => {
  const ru = t("ru");
  it("route В (no route): «Попробовать ещё раз» is visible and disabled until Я19; the handler is never called (AC-102)", () => {
    const onRetry = vi.fn();
    render(<EntryScreen language="ru" state={{ kind: "unavailable" }} onRetry={onRetry} />);
    const button = screen.getByRole("button", { name: ru.retry }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it.each(["document", "own"] as const)("route %s: active by checkable; inactive with the wait line otherwise", route => {
    const onRetry = vi.fn();
    const { rerender } = render(<EntryScreen language="ru" state={{ kind: "unavailable", route, checkable: true }} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: ru.retry }));
    expect(onRetry).toHaveBeenCalledOnce();
    rerender(<EntryScreen language="ru" state={{ kind: "unavailable", route, wait: { cause: "offline" } }} onRetry={onRetry} />);
    const button = screen.getByRole("button", { name: ru.retry }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toBe(recoveryCopy.ru.offline);
  });

  it("К-9: a planned pause — its title, detail and estimate, no button; an outage wait — the loader and 9.2.2, no button", () => {
    const { rerender, container } = render(<EntryScreen language="ru"
      state={{ kind: "unavailable", waiting: true, wait: { cause: "maintenance", waitSeconds: 40 } }} onRetry={vi.fn()} />);
    expect(screen.getByRole("heading").textContent).toBe(ru.maintenance);
    expect(container.textContent).toContain(ru.maintenanceDetail);
    expect(container.textContent).toContain(ru.maintenanceWaitSeconds.replace("{n}", "40"));
    expect(container.querySelector("button")).toBeNull();
    rerender(<EntryScreen language="ru" state={{ kind: "unavailable", waiting: true, wait: { cause: "offline" } }} onRetry={vi.fn()} />);
    expect(container.textContent).toContain(recoveryCopy.ru.offline);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".wortly-loader")).not.toBeNull();
  });

  it.each([
    ["identity", "closedWindow", "closedWindowDetail"],
    ["busy", "busy", "busyDetail"],
  ] as const)("a window closed by ВР-8/ВР-8б (%s): its line without buttons, never «replaced»", (reason, title, detail) => {
    for (const language of ["ru", "uk", "en"] as const) {
      const { container, unmount } = render(<EntryScreen language={language} state={{ kind: "closed", reason }} onRetry={vi.fn()} />);
      expect(screen.getByRole("heading").textContent).toBe(t(language)[title]);
      expect(container.textContent).toContain(t(language)[detail]);
      expect(container.querySelector("button")).toBeNull();
      unmount();
    }
  });

  it("K13: a held reapply is visible and inactive with the wait; the pause line is shown once", () => {
    const onReapply = vi.fn();
    const { container, rerender } = render(<EntryScreen language="ru"
      state={{ kind: "rejected", blocked: true, wait: { cause: "offline" } }} onReapply={onReapply} />);
    const button = screen.getByRole("button", { name: ru.reapply }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button); expect(onReapply).not.toHaveBeenCalled();
    expect(container.textContent).toContain(recoveryCopy.ru.offline);
    rerender(<EntryScreen language="ru" state={{ kind: "rejected", pause: { waitSeconds: 40 }, blocked: true,
      wait: { cause: "maintenance", waitSeconds: 40 } }} onReapply={onReapply} />);
    expect(container.textContent?.split(ru.maintenanceWaitSeconds.replace("{n}", "40")).length).toBe(2);
  });
});
