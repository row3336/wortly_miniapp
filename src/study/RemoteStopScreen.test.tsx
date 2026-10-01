import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EntryScreen } from "../app/EntryScreen";
import type { RemoteStopSnapshot } from "./remoteStopController";

afterEach(cleanup);
const targetId = "00000000-0000-4000-8000-000000000004";
const unresolved = (): RemoteStopSnapshot => ({ phase: "unresolved", pending: true, targetId,
  outcome: null, problem: "network", canRetry: true, stateVersion: null });

describe("remote stop entry screens", () => {
  it.each([
    ["ru", "Завершить занятие?", "Завершить занятие", "Отмена"],
    ["uk", "Завершити заняття?", "Завершити заняття", "Скасувати"],
    ["en", "End the session?", "End session", "Cancel"],
  ] as const)("requires a separate confirmation and focuses cancellation in %s", (language, title, yes, cancel) => {
    const confirm = vi.fn(), dismiss = vi.fn();
    render(<EntryScreen language={language} state={{ kind: "remote_confirm", targetId }}
      onRemoteConfirm={confirm} onRemoteCancel={dismiss} />);
    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: cancel }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: yes })); expect(confirm).toHaveBeenCalledOnce();
  });

  it("only displays the remote action for a server-provided target", () => {
    const request = vi.fn();
    const view = render(<EntryScreen language="ru" state={{ kind: "busy" }} onRemoteRequest={request} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<EntryScreen language="ru" state={{ kind: "busy", remoteTarget: targetId }} onRemoteRequest={request} />);
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" }));
    expect(request).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain(targetId);
  });

  it("unknown outcome offers a status check and only the allowed explicit retry", () => {
    const check = vi.fn(), retry = vi.fn();
    const view = render(<EntryScreen language="ru" state={{ kind: "remote", remote: unresolved() }}
      onRemoteCheck={check} onRemoteRetry={retry} />);
    expect(screen.getByRole("heading", { name: "Завершение пока не подтверждено" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить результат" }));
    expect(check).toHaveBeenCalledOnce(); expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Повторить завершение" }));
    expect(retry).toHaveBeenCalledOnce();
    view.rerender(<EntryScreen language="ru" state={{ kind: "remote",
      remote: { ...unresolved(), problem: "mismatch", canRetry: false } }} onRemoteCheck={check} onRemoteRetry={retry} />);
    expect(screen.queryByRole("button", { name: "Повторить завершение" })).toBeNull();
  });

  it.each(["sending", "checking"] as const)("does not show success or clickable commands during %s", phase => {
    render(<EntryScreen language="ru" state={{ kind: "remote", remote: { ...unresolved(), phase, canRetry: false } }}
      onRemoteCheck={vi.fn()} onRemoteRetry={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Занятие завершено" })).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("a cleanup failure preserves the known accepted outcome and prevents resending", () => {
    render(<EntryScreen language="ru" state={{ kind: "remote", remote: {
      ...unresolved(), outcome: "accepted", problem: "storage", canRetry: false,
    } }} onRemoteCheck={vi.fn()} onRemoteRetry={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Занятие завершено" })).toBeTruthy();
    expect(screen.queryByText(/Пока неизвестно/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить завершение" })).toBeNull();
  });
});
