import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, id, response } from "../learning/learningFixtures.test-support";
import { testGate } from "../commands/testGate.test-support";
import { ManualClock } from "../commands/writeGate.test-support";
import type { OpenedAccess } from "../app/openedAccess";
import { SettingsHost } from "../settings/SettingsHost";
import { useSettingsDocument } from "../settings/useSettingsDocument";
import { SettingsPendingStore } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import type { ProfileDeleteApi } from "./profileDeleteApi";
import type { ProfileDeletion } from "./ProfileDeleteScreen";

afterEach(cleanup);
function Host(props: Parameters<typeof useSettingsDocument>[0] & { language: "ru"; active: boolean; onToday(): void; deletion?: ProfileDeletion }) {
  const document = useSettingsDocument(props);
  return <SettingsHost {...props} document={document} />;
}
function setup(role: "owner" | "user" = "user") {
  const f = fixture(); f.owner.dispose();
  const data = settingsResponse(); data.state_version = "1";
  for (const field of Object.values(data.settings)) field.version = "1";
  data.settings.dictionary_language.value = "ru";
  f.fetcher.mockImplementation(async url => String(url).endsWith("/settings") ? response(data)
    : response({ state_version: data.state_version, topics: [] }));
  const base = f.access();
  const access: OpenedAccess = { ...base, profile: { ...base.profile, role }, isLive: base.isLive, run: base.run };
  const clock = new ManualClock();
  const api: ProfileDeleteApi = { delete: vi.fn(async () => ({ outcome: "applied", status: "applied" }) as const),
    check: vi.fn(async () => "unknown" as const) };
  const onEnded = vi.fn();
  const deletion: ProfileDeletion = { storage: f.storage, newId: () => id(700), onEnded, api, clock };
  const props = { access, transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 30000, gate: testGate() },
    pendingStore: new SettingsPendingStore(f.storage), language: "ru" as const, active: true,
    onCurrent: vi.fn(), onToday: vi.fn(), deletion };
  const ui = render(<Host {...props} />);
  return { f, props, api, clock, onEnded, ...ui };
}
const openButton = () => screen.findByRole("button", { name: "Удалить профиль" });
const confirmButton = () => screen.getByRole("button", { name: "Удалить навсегда" });

describe("the profile deletion in Settings (P04 §8, П5-006)", () => {
  it("a user: the item opens the question; the final button becomes active after 5 s and sends once", async () => {
    const t = setup();
    fireEvent.click(await openButton());
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(screen.getByText("Кнопка станет доступна через 5 с.")).toBeDefined();
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(confirmButton());
    await act(async () => { await t.clock.advanceBy(4_000); });
    expect(screen.getByText("Кнопка станет доступна через 1 с.")).toBeDefined();
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
    await act(async () => { await t.clock.advanceBy(1_000); });
    expect(confirmButton().hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(t.onEnded).toHaveBeenCalledWith({ kind: "deleted" }));
    expect(t.api.delete).toHaveBeenCalledTimes(1);
    expect(t.api.delete).toHaveBeenCalledWith(expect.anything(), { profileId: t.props.access.profile.profile_id, commandId: id(700) });
  });

  it("the owner: the item is shown, its button unavailable with the explanation; no question opens", async () => {
    const t = setup("owner");
    const button = await openButton();
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/Владелец не может удалить свой профиль/)).toBeDefined();
    fireEvent.click(button);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(t.clock.pending()).toBe(0);
  });

  it("leaving Settings drops the screen and its intent: back in Settings only the item, nothing is sent", async () => {
    const t = setup();
    fireEvent.click(await openButton());
    t.rerender(<Host {...t.props} active={false} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    t.rerender(<Host {...t.props} active={true} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await act(async () => { await t.clock.advanceBy(60_000); });
    expect(t.api.delete).not.toHaveBeenCalled();
    expect(t.clock.pending()).toBe(0);
    // A new tap is a new question with its own 5 s.
    fireEvent.click(await openButton());
    expect(confirmButton().hasAttribute("disabled")).toBe(true);
  });

  it("«Назад» and «Отмена» return to Settings without sending", async () => {
    const t = setup();
    fireEvent.click(await openButton());
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(await openButton());
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(t.api.delete).not.toHaveBeenCalled();
  });

  it("Telegram's native Back closes the question like «Назад»: nothing is sent, the item is back, a new open waits 5 s again", async () => {
    let onBack: (() => void) | null = null;
    vi.stubGlobal("Telegram", { WebApp: { BackButton: { show: vi.fn(), hide: vi.fn(),
      onClick: (handler: () => void) => { onBack = handler; }, offClick: () => { onBack = null; } } } });
    try {
      const t = setup();
      fireEvent.click(await openButton());
      await act(async () => { await t.clock.advanceBy(5_000); });
      expect(confirmButton().hasAttribute("disabled")).toBe(false);
      expect(onBack).not.toBeNull();
      act(() => { onBack!(); });
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(t.clock.pending()).toBe(0);
      fireEvent.click(await openButton());
      expect(confirmButton().hasAttribute("disabled")).toBe(true);
      expect(t.api.delete).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it("a new access of the same document (a foreground) reaches the waiting repeat: the same ID goes with it (P2-2)", async () => {
    const t = setup();
    const replies = [{ outcome: "unknown" } as const, { outcome: "applied", status: "already_applied" } as const];
    t.api.delete = vi.fn(async () => replies.shift() ?? { outcome: "unknown" as const });
    fireEvent.click(await openButton());
    await act(async () => { await t.clock.advanceBy(5_000); });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(t.api.delete).toHaveBeenCalledTimes(1));
    // The entry's foreground: the old access stops being live before the screen gets the new one.
    const old = t.props.access;
    const dead = { ...old, isLive: () => false };
    t.rerender(<Host {...t.props} access={dead} />);
    await act(async () => { await t.clock.advanceBy(2_000); });
    expect(t.api.delete).toHaveBeenCalledTimes(1);
    const fresh = { ...old, isLive: () => true };
    t.rerender(<Host {...t.props} access={fresh} />);
    await act(async () => { await t.clock.advanceBy(0); });
    await waitFor(() => expect(t.onEnded).toHaveBeenCalledWith({ kind: "deleted" }));
    expect(t.api.delete).toHaveBeenCalledTimes(2);
    const ids = (t.api.delete as ReturnType<typeof vi.fn>).mock.calls.map(call => call[1].commandId);
    expect(ids[1]).toBe(ids[0]);
  });

  it("Settings without the deletion option show no item (pending/rejected never reach Settings at all)", async () => {
    const t = setup();
    t.rerender(<Host {...t.props} deletion={undefined} />);
    await screen.findByRole("button", { name: "Обновить настройки" });
    expect(screen.queryByRole("button", { name: "Удалить профиль" })).toBeNull();
  });
});
