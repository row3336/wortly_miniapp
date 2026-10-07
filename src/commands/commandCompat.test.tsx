// The shared recovery controls name a planned pause or an outdated client by themselves (M-COMPAT-HDR).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandRecovery } from "./CommandRecovery";
import { t } from "../i18n/messages";

afterEach(() => { cleanup(); });
const show = (lanes: { phase: string; problem?: string | null; pauseSeconds?: number | null }[], language: "ru" | "uk" | "en" = "ru") =>
  render(<CommandRecovery className="x" language={language} lanes={lanes} canRetryPrimary canRetryStop={false} onCheck={vi.fn()} onRetry={vi.fn()} />);

describe("command recovery notes", () => {
  it.each(["ru", "uk", "en"] as const)("a planned pause with a wait shows its note and keeps both controls (%s)", language => {
    show([{ phase: "unresolved", problem: "maintenance", pauseSeconds: 45 }, { phase: "idle" }], language);
    expect(screen.getByRole("status").textContent).toContain(t(language).commandMaintenance);
    expect(screen.getByRole("status").textContent).toMatch(/45/);
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("rounds a long wait to minutes, says that the estimate has passed at zero and adds nothing without one", () => {
    show([{ phase: "unresolved", problem: "maintenance", pauseSeconds: 90 }, { phase: "idle" }]);
    expect(screen.getByRole("status").textContent).toContain("2 мин");
    cleanup();
    show([{ phase: "unresolved", problem: "maintenance", pauseSeconds: 0 }, { phase: "idle" }]);
    expect(screen.getByRole("status").textContent).toContain(t("ru").maintenanceOver);
    cleanup();
    show([{ phase: "unresolved", problem: "maintenance", pauseSeconds: null }, { phase: "idle" }]);
    expect(screen.getByRole("status").textContent).toBe(t("ru").commandMaintenance);
  });

  it.each(["ru", "uk", "en"] as const)("an outdated client is told to update, without the pause text (%s)", language => {
    show([{ phase: "idle" }, { phase: "unresolved", problem: "incompatible" }], language);
    expect(screen.getByRole("status").textContent).toBe(t(language).commandIncompatible);
  });

  it("says nothing for a network error, a storage error or no problem", () => {
    for (const problem of ["network", "storage", null, undefined]) {
      show([{ phase: "unresolved", problem }, { phase: "idle" }]);
      expect(screen.queryByRole("status")).toBeNull();
      cleanup();
    }
  });
});
