import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "../api/generated";
import type { Language } from "../i18n/language";
import { fixture, id, response } from "../learning/learningFixtures.test-support";
import { SettingsHost } from "./SettingsHost";
import { SettingsPendingStore, type SettingsPending } from "./settingsPending";
import { settingsResponse } from "./settingsRead.test-support";
import { useSettingsDocument } from "./useSettingsDocument";

/**
 * The dictionary language in the actual Settings screen once it is chosen (19.2-А, texts 28.1-А), with the real
 * settings document and controller: a chosen language is shown and never offered, a draft or an intent of another
 * language left from before the choice ends in a visible refusal with the current value shown, never in a select
 * that cannot be saved (QA-PAIR-LOCK-CP2 F1, C182).
 */
afterEach(cleanup);
type Props = Parameters<typeof useSettingsDocument>[0] & { language: Language; active: boolean; onToday(): void };
function Host(props: Props) {
  const document = useSettingsDocument(props);
  return <SettingsHost {...props} document={document} />;
}
/** Settings as the core serves them: after the choice only the current language is in the constraint (CP2). */
function served(language: "uk" | "en" | "ru", version: string, state: string): SettingsResponse {
  const data = settingsResponse(); data.state_version = state;
  data.settings.dictionary_language = { value: language, version };
  data.constraints.dictionary_language = { type: "enum", values: BigInt(version) > 1n ? [language] : ["ru", "uk", "en"] };
  return data;
}
const refusal = (commandId: string, code: string, current: SettingsResponse) => response({ command: { id: commandId, status: "rejected" },
  error: { code }, current: (({ state_version: _, ...rest }) => rest)(current), state_version: current.state_version }, 409);

function setup(options: { data: SettingsResponse; language?: Language; stored?: SettingsPending["intent"] }) {
  const f = fixture(); f.owner.dispose();
  let data = options.data;
  const get = vi.fn(async () => response(data));
  const commands = vi.fn<(body: Record<string, any>) => Promise<Response>>(async () => { throw new Error("unexpected command"); });
  const status = vi.fn(async (commandId: string) => response({ command: { id: commandId, status: "not_found" },
    current: f.access().profile, state_version: data.state_version }));
  f.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (path.endsWith("/settings")) return get();
    if (path.endsWith("/settings/topics")) return response({ state_version: data.state_version, topics: [] });
    if (path.endsWith("/commands") && init?.method === "POST") return commands(JSON.parse(String(init.body)));
    if (path.includes("/commands/")) return status(path.split("/").at(-1)!);
    throw new Error(`unexpected ${path}`);
  });
  const pendingStore = new SettingsPendingStore(f.storage);
  const props: Props = { access: f.access(), transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 30000 },
    pendingStore, language: options.language ?? "ru", active: true, onCurrent: vi.fn(), onToday: vi.fn() };
  const mount = async () => {
    if (options.stored) await pendingStore.save({ schemaVersion: 1, profileId: f.access().profile.profile_id,
      clientInstanceId: f.access().document.clientInstanceId, intent: options.stored }, new AbortController().signal);
    render(<Host {...props} />);
  };
  return { f, get, commands, status, pendingStore, mount, serve(next: SettingsResponse) { data = next; } };
}
const field = (name: string) => within(screen.getByRole("group", { name }));
const ready = () => waitFor(() => expect(field("Новых карточек в группе").getByRole("textbox").hasAttribute("disabled")).toBe(false));

describe("the chosen dictionary language in the actual Settings screen", () => {
  it.each([
    ["ru", "Язык словаря", "Українська", "Язык словаря пока нельзя изменить.", "Язык интерфейса"],
    ["uk", "Мова словника", "Українська", "Мову словника поки не можна змінити.", "Мова інтерфейсу"],
    ["en", "Dictionary language", "Українська", "The dictionary language can't be changed for now.", "Interface language"],
  ] as const)("(%s) is shown with its caption, never offered; the interface language still is", async (language, title, value, caption, ui) => {
    const s = setup({ data: served("uk", "2", "20"), language });
    await s.mount();
    await waitFor(() => expect(field(ui).getByRole("combobox").hasAttribute("disabled")).toBe(false));
    const locked = field(title);
    expect(locked.getByText(value)).toBeTruthy(); expect(locked.getByText(caption)).toBeTruthy();
    expect(locked.queryByRole("combobox")).toBeNull(); expect(locked.queryByRole("button")).toBeNull();
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });

  it("a draft of another language that met VERSION_CONFLICT is not left as a select: the current pair is named, other drafts stay", async () => {
    const s = setup({ data: served("uk", "1", "20") });
    await s.mount(); await ready();
    // Real select changes, as a person makes them: another language, and an unsent edit of another field.
    fireEvent.change(field("Язык словаря").getByRole("combobox"), { target: { value: "en" } });
    fireEvent.change(field("Новых карточек в группе").getByRole("textbox"), { target: { value: "7" } });
    const chosen = served("uk", "2", "21");
    s.commands.mockImplementationOnce(async body => { s.serve(chosen); return refusal(body.command_id, "VERSION_CONFLICT", chosen); });
    fireEvent.click(field("Язык словаря").getByRole("button", { name: "Сохранить" }));
    const locked = await waitFor(() => { const group = field("Язык словаря"); expect(group.queryByRole("combobox")).toBeNull(); return group; });
    expect(locked.getByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-украинский.")).toBeTruthy();
    expect(locked.getByText("Українська")).toBeTruthy(); expect(locked.getByText("Язык словаря пока нельзя изменить.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Сохранить моё значение" })).toBeNull();
    expect(screen.queryByText("Сохранённое значение изменилось. Твой ввод остался.")).toBeNull();
    expect(screen.queryByText("Проверь значение и допустимые варианты.")).toBeNull();
    // The other unsent draft is kept and still saveable; nothing was sent again.
    expect((field("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).value).toBe("7");
    expect(field("Новых карточек в группе").getByRole("button", { name: "Сохранить" }).hasAttribute("disabled")).toBe(false);
    expect(s.commands).toHaveBeenCalledOnce();
    expect(s.commands.mock.calls[0][0]).toMatchObject({ expected_field_version: "1", payload: { key: "dictionary_language", value: "en" } });
    expect(await s.pendingStore.load(s.f.access().profile.profile_id, new AbortController().signal)).toBeNull();
  });

  it("an intent of another language stored before the choice is retried once, refused as locked and shown so", async () => {
    const stored = { command_id: id(400), kind: "setting.save" as const, expected_field_version: "2",
      payload: { key: "dictionary_language" as const, value: "en" as const } };
    const s = setup({ data: served("uk", "2", "20"), stored });
    await s.mount();
    await screen.findByText("Подтверждение сохранения пока не найдено. Можно проверить ещё раз или повторить отправку.");
    // While unresolved the field shows the current value and the existing unknown line, not the sent language.
    expect(field("Язык словаря").getByText("Українська")).toBeTruthy(); expect(field("Язык словаря").queryByRole("combobox")).toBeNull();
    s.commands.mockImplementationOnce(async body => refusal(body.command_id, "DICTIONARY_LANGUAGE_LOCKED", served("uk", "2", "20")));
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    await screen.findByText("Изменение не принято: язык словаря пока нельзя изменить.");
    expect(s.commands).toHaveBeenCalledOnce(); expect(s.commands.mock.calls[0][0]).toMatchObject({ command_id: id(400) });
    expect(field("Язык словаря").getByText("Українська")).toBeTruthy(); expect(field("Язык словаря").queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить моё значение" })).toBeNull();
    expect(await s.pendingStore.load(s.f.access().profile.profile_id, new AbortController().signal)).toBeNull();
    // The rest of Settings is editable again.
    await ready(); await act(async () => {});
    expect(s.commands).toHaveBeenCalledOnce();
  });
});

// Probes of the independent QA (QA-FIRST-CHOICE), kept as permanent tests.
describe("QA: drafts left in the owner when the language becomes chosen without a refusal", () => {
  it("a draft of en made at version 1, then Settings re-read at version 2: the field is read-only, nothing invalid is shown, other fields save", async () => {
    const s = setup({ data: served("uk", "1", "20") });
    await s.mount(); await ready();
    fireEvent.change(field("Язык словаря").getByRole("combobox"), { target: { value: "en" } });
    fireEvent.change(field("Новых карточек в группе").getByRole("textbox"), { target: { value: "7" } });
    s.serve(served("uk", "2", "21"));
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(field("Язык словаря").queryByRole("combobox")).toBeNull());
    expect(field("Язык словаря").getByText("Українська")).toBeTruthy();
    expect(field("Язык словаря").getByText("Язык словаря пока нельзя изменить.")).toBeTruthy();
    expect(screen.queryByText("Проверь значение и допустимые варианты.")).toBeNull();
    expect(screen.queryByText("Сохранённое значение изменилось. Твой ввод остался.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить моё значение" })).toBeNull();
    expect((field("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).value).toBe("7");
    s.commands.mockImplementationOnce(async body => {
      const next = served("uk", "2", "22"); next.settings.learning_group_size = { value: 7, version: "2" }; s.serve(next);
      return response({ command: { id: body.command_id, kind: "setting.save", status: "applied", applied_at: "2026-10-09T00:00:00Z",
        target_id: s.f.access().profile.profile_id, action_id: null, result_id: null, context_id: null, object_version: "2" },
        current: (({ state_version: _, ...rest }) => rest)(next), state_version: "22" });
    });
    await waitFor(() => expect(field("Новых карточек в группе").getByRole("button", { name: "Сохранить" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(field("Новых карточек в группе").getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Сохранено");
    expect(s.commands).toHaveBeenCalledOnce();
    expect(s.commands.mock.calls[0][0]).toMatchObject({ payload: { key: "learning_group_size" } });
  });

  it("the caption and the value in uk and en after VERSION_CONFLICT name the pair in the interface language", async () => {
    for (const [language, title, expected] of [["uk", "Мова словника", "Мову словника вже підтверджено. Зараз обрано: Німецько-англійський."],
      ["en", "Dictionary language", "The dictionary language is already confirmed. Current choice: German–English."]] as const) {
      const s = setup({ data: served("en", "1", "20"), language });
      await s.mount(); await waitFor(() => expect(field(title).getByRole("combobox").hasAttribute("disabled")).toBe(false));
      fireEvent.change(field(title).getByRole("combobox"), { target: { value: "ru" } });
      const chosen = served("en", "2", "21");
      s.commands.mockImplementationOnce(async body => { s.serve(chosen); return refusal(body.command_id, "VERSION_CONFLICT", chosen); });
      fireEvent.click(field(title).getByRole("button", { name: language === "uk" ? "Зберегти" : "Save" }));
      await screen.findByText(expected);
      cleanup();
    }
  });
});
