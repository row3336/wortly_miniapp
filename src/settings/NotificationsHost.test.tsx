import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, id, response } from "../learning/learningFixtures.test-support";
import { SettingsHost } from "./SettingsHost";
import { useSettingsDocument } from "./useSettingsDocument";
import { SettingsPendingStore } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";

// project_notifications §8.1–8.2 (M2): the submenu is an inner view of SettingsHost on the shared controller and document.
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function Host(props: Parameters<typeof useSettingsDocument>[0] & { language: "ru"; active: boolean; onToday(): void }) {
  const document = useSettingsDocument(props);
  return <SettingsHost {...props} document={document} />;
}
function setup(opened = true) {
  const handlers = new Set<() => void>(), close = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { close, BackButton: { show: vi.fn(), hide: vi.fn(),
    onClick: (h: () => void) => { handlers.add(h); }, offClick: (h: () => void) => { handlers.delete(h); } } } });
  const f = fixture(); f.owner.dispose();
  const data = settingsResponse(); data.state_version = "1";
  for (const field of Object.values(data.settings)) field.version = "1";
  data.settings.dictionary_language.value = "ru";
  data.settings.material.value = { mode: "topics", topic_ids: [id(201)] };
  data.notifications.telegram_opened = opened;
  const posts: Array<{ command_id: string; expected_field_version: string; payload: { key: string; value: unknown } }> = [];
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith("/settings")) return response(data);
    if (String(url).endsWith("/commands")) {
      const command = JSON.parse(String(init?.body)) as (typeof posts)[number];
      posts.push(command);
      Object.assign(data.settings[command.payload.key as "notify_weekly"], { value: command.payload.value, version: "2" });
      data.state_version = "2";
      const { state_version, ...current } = structuredClone(data);
      return response({ command: { id: command.command_id, kind: "setting.save", status: "applied", applied_at: "2026-10-13T00:00:00Z",
        target_id: f.access().profile.profile_id, action_id: null, result_id: null, context_id: null, object_version: "2" },
      current, state_version });
    }
    return response({ state_version: data.state_version, topics: [{ id: id(201), number: 1, german_name: "Haus", description: "House" }] });
  });
  const props = { access: f.access(), transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 30000 },
    pendingStore: new SettingsPendingStore(f.storage), language: "ru" as const, active: true, onCurrent: vi.fn(), onToday: vi.fn() };
  const ui = render(<Host {...props} />);
  const back = () => act(() => { for (const handler of [...handlers]) handler(); });
  return { f, data, posts, props, close, handlers, back, ...ui };
}
async function openSubmenu() {
  await waitFor(() => expect(screen.getByRole("button", { name: "Уведомления", hidden: true })).toBeDefined());
  const additional = screen.getByText("Дополнительно").closest("details")!; additional.open = true;
  fireEvent.click(within(additional).getByRole("button", { name: "Уведомления" }));
  await screen.findByRole("heading", { level: 1, name: "Уведомления" });
}

describe("Settings host: the submenu «Уведомления»", () => {
  it("opens from the row, saves a switch at once with one command, and Telegram's Back returns to the settings", async () => {
    const { posts, back } = setup(); await openSubmenu();
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 1, name: "Уведомления" }));
    const weekly = () => within(screen.getByRole("group", { name: "Недельный отчёт" }));
    await waitFor(() => expect((weekly().getByRole("switch") as HTMLInputElement).disabled).toBe(false));
    fireEvent.click(weekly().getByRole("switch"));
    await waitFor(() => expect(weekly().getByText("Сохранено")).toBeDefined());
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ expected_field_version: "1", payload: { key: "notify_weekly", value: false } });
    expect((weekly().getByRole("switch") as HTMLInputElement).checked).toBe(false);
    back();
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    expect(screen.queryByRole("heading", { name: "Уведомления" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Уведомления" }));
  });
  it("Back is not taken while Settings are hidden", async () => {
    const { props, rerender, handlers } = setup(); await openSubmenu();
    expect(handlers.size).toBe(1);
    rerender(<Host {...props} active={false} />);
    expect(handlers.size).toBe(0);
    // The view stays for the next visit, and Back is supplied again once Settings are shown.
    rerender(<Host {...props} active />);
    expect(handlers.size).toBe(1);
    expect(screen.getByRole("heading", { level: 1, name: "Уведомления" })).toBeDefined();
  });
  it("before the bot is opened the switches are closed and «Открыть бота» closes the Mini App back to the bot", async () => {
    const { close, posts } = setup(false); await openSubmenu();
    await waitFor(() => expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).disabled).toBe(false));
    for (const item of screen.getAllByRole("switch")) expect(item).toMatchObject({ checked: false, disabled: true });
    fireEvent.click(screen.getByRole("button", { name: "Открыть бота" }));
    expect(close).toHaveBeenCalledOnce();
    expect(posts).toEqual([]);
  });
});
