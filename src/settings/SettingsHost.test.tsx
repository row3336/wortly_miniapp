import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, fixture, id, response } from "../learning/learningFixtures.test-support";
import { SettingsHost } from "./SettingsHost";
import { useSettingsDocument } from "./useSettingsDocument";
import { SettingsPendingStore } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";

afterEach(cleanup);
function Host(props: Parameters<typeof useSettingsDocument>[0] & { language: "ru"; active: boolean; onToday(): void }) {
  const document = useSettingsDocument(props);
  return <SettingsHost {...props} document={document} />;
}
function setup(minimumStateVersion?: string) {
  const f = fixture(); f.owner.dispose();
  const data = settingsResponse(); data.state_version = "1";
  for (const field of Object.values(data.settings)) field.version = "1";
  data.settings.dictionary_language.value = "ru";
  data.settings.material.value = { mode: "topics", topic_ids: [id(201)] };
  const get = vi.fn(async () => response(data));
  f.fetcher.mockImplementation(async url => String(url).endsWith("/settings") ? get()
    : response({ state_version: data.state_version, topics: [{ id: id(201), number: 1, german_name: "Haus", description: "House" }] }));
  const props = { access: f.access(), transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 30000 },
    pendingStore: new SettingsPendingStore(f.storage), language: "ru" as const, active: true,
    minimumStateVersion, onCurrent: vi.fn(), onToday: vi.fn() };
  const ui = render(<Host {...props} />);
  return { f, data, get, props, ...ui };
}
const group = () => within(screen.getByRole("group", { name: "Новых карточек в группе" }));
async function ready() { await waitFor(() => expect(group().getByRole("textbox").hasAttribute("disabled")).toBe(false)); }

describe("Settings host uses the shared confirmed version", () => {
  it("does not publish a first stale read as confirmed settings", async () => {
    const { data, get, props } = setup("9");
    await screen.findByText("Не удалось получить актуальные настройки. Обнови их.");
    expect(props.onCurrent).not.toHaveBeenCalled(); expect(screen.queryByRole("group", { name: "Новых карточек в группе" })).toBeNull();
    data.state_version = "9"; fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" })); await ready();
    expect(get).toHaveBeenCalledTimes(2); expect(props.onCurrent).toHaveBeenCalledWith(expect.objectContaining({ version: "9" }));
  });
  it("blocks stale rights on render and retains the editor and search through a late old response", async () => {
    const { data, get, props, rerender } = setup(); await ready();
    const field = group().getByRole("textbox"), search = screen.getByRole("searchbox");
    fireEvent.change(field, { target: { value: "17" } }); fireEvent.change(search, { target: { value: "haus" } });
    const gate = deferred<Response>(); get.mockReturnValueOnce(gate.promise); props.onCurrent.mockClear();
    rerender(<Host {...props} minimumStateVersion="9" />);
    expect(group().getByRole("textbox")).toBe(field); expect(field.hasAttribute("disabled")).toBe(true);
    expect(props.onCurrent).not.toHaveBeenCalled();
    await act(async () => gate.resolve(response(data)));
    await screen.findByText("Не удалось получить актуальные настройки. Обнови их.");
    expect(props.onCurrent).not.toHaveBeenCalled(); expect((field as HTMLInputElement).value).toBe("17");
    expect(screen.getByRole("searchbox")).toBe(search); expect((search as HTMLInputElement).value).toBe("haus");
    data.state_version = "9"; fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" })); await ready();
    expect(group().getByRole("textbox")).toBe(field); expect(screen.getByRole("searchbox")).toBe(search);
    expect((field as HTMLInputElement).value).toBe("17"); expect(props.onCurrent).toHaveBeenCalledWith(expect.objectContaining({ version: "9" }));
  });
  it("an application settings owner refreshes a higher floor while the editor is hidden", async () => {
    const { data, get, props, rerender } = setup(); await ready();
    const field = group().getByRole("textbox"); fireEvent.change(field, { target: { value: "17" } });
    rerender(<Host {...props} active={false} minimumStateVersion="9" />); await act(async () => {});
    expect(get).toHaveBeenCalledTimes(2); expect(field.hasAttribute("disabled")).toBe(true);
    data.state_version = "9"; rerender(<Host {...props} minimumStateVersion="9" />);
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" })); await ready();
    expect(get).toHaveBeenCalledTimes(3); expect(group().getByRole("textbox")).toBe(field); expect((field as HTMLInputElement).value).toBe("17");
  });
  it("publishing its own already-covered floor does not trigger another GET", async () => {
    const { data, get, props, rerender } = setup(); data.state_version = "9"; await ready();
    rerender(<Host {...props} minimumStateVersion="9" />); await act(async () => {});
    expect(get).toHaveBeenCalledOnce(); expect(group().getByRole("textbox").hasAttribute("disabled")).toBe(false);
  });
});

describe("Settings host saves review mode and learning content (M-SET)", () => {
  it.each([["Строгий режим повторов", "Мягкий", "review_error_mode", "soft"],
    ["Состав Learning", "Фразы", "learning_content", "phrases"]] as const)(
    "%s: %s goes through setting.save and shows success only after the committed reply", async (title, option, key, value) => {
      const { f, data } = setup(); await ready();
      const reply = deferred<Response>(); const posts: Array<Record<string, unknown>> = [];
      const original = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementation(async (url, init) => {
        if (!String(url).endsWith("/commands")) return original(url, init);
        const command = JSON.parse(String(init?.body)) as { command_id: string; expected_field_version: string };
        posts.push(command);
        const { state_version, ...current } = structuredClone(data);
        Object.assign(current.settings[key], { value, version: "2" });
        return reply.promise.then(() => response({ command: { id: command.command_id, kind: "setting.save", status: "applied",
          applied_at: "2026-09-30T00:00:00Z", target_id: f.access().profile.profile_id, action_id: null, result_id: null,
          context_id: null, object_version: "2" }, current, state_version: "2" }));
      });
      const box = () => within(screen.getByRole("group", { name: title }));
      fireEvent.click(box().getByRole("radio", { name: option }));
      expect(posts).toEqual([]); // choosing is not saving
      fireEvent.click(box().getByRole("button", { name: "Сохранить" }));
      await waitFor(() => expect(posts).toHaveLength(1));
      expect(posts[0]).toMatchObject({ kind: "setting.save", expected_field_version: "1", payload: { key, value } });
      expect(box().queryByText("Сохранено")).toBeNull();
      await act(async () => reply.resolve(response({})));
      await waitFor(() => expect(box().getByText("Сохранено")).toBeDefined());
      expect((box().getByRole("radio", { name: option }) as HTMLInputElement).checked).toBe(true);
    });
});
