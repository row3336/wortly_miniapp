import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse, Topic } from "../api/generated";
import type { SettingsDraft } from "./settingsController";
import { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen";
import type { FeedbackDocument } from "../feedback/useFeedbackDocument";
import { resetKeys } from "./settingsApi";
import { settingsCopy } from "./settingsCopy";
import { settingsFeedbackCopy } from "./settingsFeedbackCopy";

const big = "9007199254740995";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function current(state = big): SettingsResponse {
  return { state_version: state, needs_setup: true, settings: {
    ui_language: { value: "ru", version: "1" }, dictionary_language: { value: "uk", version: "1" },
    time_zone: { value: "UTC", version: "1" }, retry_gap: { value: null, version: "1" },
    retry_count: { value: 3, version: big }, learning_group_size: { value: null, version: "1" },
    learning_intervals_seconds: { value: [120, 30, 120], version: "1" },
    learning_reminder_pause_seconds: { value: null, version: "1" }, learning_mix: { value: null, version: "1" },
    strict_case: { value: true, version: "1" }, include_preterite: { value: false, version: "1" },
    include_comparative: { value: null, version: "1" }, transition_mode: { value: null, version: "1" },
    review_error_mode: { value: "strict", version: "1" },
    learning_content: { value: "words", version: "1" },
    material: { value: null, version: "1" },
  }, constraints: {
    ui_language: { type: "enum", values: ["ru", "uk", "en"] },
    dictionary_language: { type: "enum", values: ["ru", "uk", "en"] },
    retry_gap: { type: "integer", minimum: 1, maximum: 2147483647 },
    retry_count: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_group_size: { type: "integer", minimum: 1, maximum: 2147483647 },
    learning_reminder_pause_seconds: { type: "integer", minimum: 60, maximum: 2147483647 },
    learning_intervals_seconds: { type: "ordered_integer_list", nonempty: true, item_minimum: 1, item_maximum: 2147483647 },
    learning_mix: { type: "boolean" }, strict_case: { type: "boolean" }, include_preterite: { type: "boolean" },
    include_comparative: { type: "boolean" }, transition_mode: { type: "enum", values: ["normal", "accelerated"] },
    review_error_mode: { type: "enum", values: ["strict", "soft"] },
    learning_content: { type: "enum", values: ["words", "phrases", "mixed"] },
    material: { type: "exclusive_choice", modes: { level: { selected_level: ["A1", "A2", "B1", "B2", "C1", "C2"] },
      topics: { topic_ids: "nonempty_existing_uuid_list" } } },
  } };
}

const topics: Topic[] = [{ id: id(8), number: 7, german_name: "Küche", description: "Full stored description" },
  { id: id(9), number: 12, german_name: "Straße", description: "Another full description" }];
afterEach(cleanup);
function draft(input: unknown, rest: Partial<SettingsDraft> = {}): SettingsDraft {
  return { input, original: 3, fieldVersion: big, valid: true, conflict: false, error: null,
    canSave: true, canKeepMine: false, ...rest };
}
function fixture() {
  const props: SettingsScreenProps = {
    snapshot: { phase: "ready", data: current(), dataCurrent: true, drafts: {}, pending: null, resetPending: null,
      outcome: null, resetOutcome: null, problem: null, canEdit: true, canReset: true, canRetry: false,
      canContinueWithServer: false },
    language: "ru", catalog: { phase: "ready", topics },
    actions: { edit: vi.fn(), save: vi.fn(async () => {}), acceptCurrent: vi.fn(), keepMine: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}), retry: vi.fn(async () => {}), reset: vi.fn(async () => {}),
      continueWithServer: vi.fn(async () => {}) },
    onReloadTopics: vi.fn(), onToday: vi.fn(),
  };
  return props;
}
function field(name: string) { return within(screen.getByRole("group", { name, hidden: true })); }
function openAdditional(container: HTMLElement) { container.querySelector("details")!.open = true; }

describe("settings screen fields", () => {
  it("keeps a stored enum value visible after allowed choices narrow", () => {
    const f = fixture(); f.snapshot.data!.settings.ui_language.value = "en";
    f.snapshot.data!.constraints.ui_language.values = ["ru", "uk"];
    render(<SettingsScreen {...f} />);
    const select = field("Язык интерфейса").getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("en");
    expect(select.selectedOptions[0].textContent).toBe("English");
    expect(select.selectedOptions[0].disabled).toBe(true);
    expect(f.actions.edit).not.toHaveBeenCalled();
  });
  it("renders saved values, independent languages and a collapsed additional section", () => {
    const f = fixture(), { container } = render(<SettingsScreen {...f} />);
    expect(screen.getByRole("heading", { level: 1, name: "Настройки" })).toBeDefined();
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelectorAll(".settings-field")).toHaveLength(15);
    // P12/P14: the readiness fields are gone from the screen, the reminder pause stays.
    expect(screen.queryByText(/Проверять готовность/)).toBeNull();
    expect(screen.queryByText(/Готовность Learning/)).toBeNull();
    expect(screen.getByRole("group", { name: "Пауза между напоминаниями, секунды", hidden: true })).toBeDefined();
    expect((field("Язык интерфейса").getByRole("combobox") as HTMLSelectElement).value).toBe("ru");
    expect((field("Язык словаря").getByRole("combobox") as HTMLSelectElement).value).toBe("uk");
    expect([...container.querySelectorAll<HTMLButtonElement>(".settings-field button")].filter(button => button.textContent === "Сохранить")
      .every(button => button.disabled)).toBe(true);
    expect(f.actions.edit).not.toHaveBeenCalled(); expect(f.actions.save).not.toHaveBeenCalled();
  });

  it("shows only the API's allowed languages in the specified order", () => {
    const f = fixture(); f.snapshot.data!.constraints.ui_language.values = ["ru", "uk"];
    render(<SettingsScreen {...f} />);
    const select = field("Язык интерфейса").getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(["", "uk", "ru"]);
    fireEvent.change(select, { target: { value: "uk" } });
    expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("ui_language", "uk");
    expect(f.actions.save).not.toHaveBeenCalled();
  });

  it("does not present an unset boolean as a saved false or invent numeric defaults", () => {
    const f = fixture(); render(<SettingsScreen {...f} />);
    const radios = field("Проверять степени сравнения").getAllByRole("radio") as HTMLInputElement[];
    expect(radios.every(radio => !radio.checked)).toBe(true);
    expect(field("Проверять степени сравнения").getByText("Не задано")).toBeDefined();
    expect((field("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).value).toBe("");
    fireEvent.click(radios[1]); expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("include_comparative", false);
  });

  it("displays actual bounds and leaves invalid input intact, without saving on Enter", () => {
    const f = fixture(); f.snapshot.data!.constraints.learning_group_size = { type: "integer", minimum: 2, maximum: 11 };
    f.snapshot.drafts.learning_group_size = draft("1e2", { valid: false, error: "invalid", canSave: false });
    render(<SettingsScreen {...f} />); const group = field("Новых карточек в группе");
    const input = group.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("1e2"); expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(group.getByText("Целое число от 2 до 11.")).toBeDefined();
    expect(group.getByText("Проверь значение и допустимые варианты.")).toBeDefined();
    expect((group.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" }); expect(f.actions.save).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "7" } }); expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("learning_group_size", "7");
  });

  it("submits only the explicitly chosen field, with command creation left to its controller", () => {
    const f = fixture(); f.snapshot.drafts.learning_group_size = draft("7");
    render(<SettingsScreen {...f} />);
    fireEvent.click(field("Новых карточек в группе").getByRole("button", { name: "Сохранить" }));
    expect(f.actions.save).toHaveBeenCalledExactlyOnceWith("learning_group_size");
    expect(screen.queryByText("Сохранено")).toBeNull();
  });

  it("preserves interval order and blank new rows instead of supplying a default", () => {
    const f = fixture(), { container } = render(<SettingsScreen {...f} />); openAdditional(container);
    const group = field("Интервалы Learning, секунды");
    expect((group.getAllByRole("textbox") as HTMLInputElement[]).map(input => input.value)).toEqual(["120", "30", "120"]);
    fireEvent.change(group.getByLabelText("Интервал 2"), { target: { value: "7" } });
    expect(f.actions.edit).toHaveBeenLastCalledWith("learning_intervals_seconds", [120, "7", 120]);
    fireEvent.click(group.getByRole("button", { name: "Добавить интервал" }));
    expect(f.actions.edit).toHaveBeenLastCalledWith("learning_intervals_seconds", [120, 30, 120, ""]);
    fireEvent.click(group.getByRole("button", { name: "Удалить интервал 2" }));
    expect(f.actions.edit).toHaveBeenLastCalledWith("learning_intervals_seconds", [120, 120]);
    expect(f.actions.save).not.toHaveBeenCalled();
  });
});

describe("settings conflict and recovery presentation", () => {
  it("keeps the draft, shows current, and offers both explicit conflict decisions", () => {
    const f = fixture(); f.snapshot.data!.settings.learning_group_size = { value: 9, version: "2" };
    f.snapshot.drafts.learning_group_size = draft("7", { conflict: true, error: "conflict", canSave: false, canKeepMine: true });
    render(<SettingsScreen {...f} />); const group = field("Новых карточек в группе");
    expect((group.getByRole("textbox") as HTMLInputElement).value).toBe("7");
    expect(group.getByText("Сейчас сохранено: 9")).toBeDefined();
    expect(group.queryByRole("button", { name: "Сохранить" })).toBeNull();
    fireEvent.click(group.getByRole("button", { name: "Принять сохранённое" }));
    fireEvent.click(group.getByRole("button", { name: "Сохранить моё значение" }));
    expect(f.actions.acceptCurrent).toHaveBeenCalledExactlyOnceWith("learning_group_size");
    expect(f.actions.keepMine).toHaveBeenCalledExactlyOnceWith("learning_group_size");
  });

  it("does not offer saving an invalid conflict or expose field versions to the user", () => {
    const f = fixture(); f.snapshot.drafts.learning_group_size = draft("bad", {
      valid: false, conflict: true, error: "invalid", canSave: false, canKeepMine: false });
    render(<SettingsScreen {...f} />); const group = field("Новых карточек в группе");
    expect((group.getByRole("button", { name: "Сохранить моё значение" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain(big);
  });

  it("shows unknown outcome and exact retry, keeping new writes disabled", () => {
    const f = fixture(); f.snapshot = { ...f.snapshot, phase: "unresolved", canEdit: false, canRetry: true,
      problem: { reason: "network", code: "RAW_INTERNAL_CODE" },
      pending: { schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), intent: { command_id: id(3),
        kind: "setting.save", expected_field_version: "1", payload: { key: "learning_group_size", value: 7 } } },
      drafts: { learning_group_size: draft("7", { canSave: false }) } };
    render(<SettingsScreen {...f} />);
    expect((field("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText("Сохранено")).toBeNull(); expect(document.body.textContent).not.toContain("RAW_INTERNAL_CODE");
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    expect(f.actions.retry).toHaveBeenCalledExactlyOnceWith(); expect(f.actions.save).not.toHaveBeenCalled();
  });

  it("reports accepted facts separately from a cleanup failure", () => {
    const f = fixture(); f.snapshot.canEdit = false; f.snapshot.phase = "unresolved";
    f.snapshot.outcome = { commandId: id(3), key: "strict_case", status: "accepted" };
    f.snapshot.problem = { reason: "storage" };
    render(<SettingsScreen {...f} />);
    expect(field("Проверять регистр букв").getByText("Сохранено")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("на этом устройстве");
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
  });

  it.each(["expired", "forbidden", "context_closed", "profile_changed"] as const)(
    "shows a usable reopening instruction after %s, without old fields", reason => {
      const f = fixture(); f.snapshot = { ...f.snapshot, data: null, drafts: {}, phase: "blocked", canEdit: false, problem: { reason } };
      render(<SettingsScreen {...f} />);
      expect(screen.getByRole("alert").textContent).toContain("бот");
      expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByText("Язык словаря")).toBeNull();
    });

  it("distinguishes initial loading from a failed load and keeps retry explicit", () => {
    const f = fixture(); f.snapshot = { ...f.snapshot, data: null, phase: "loading", canEdit: false };
    const { rerender } = render(<SettingsScreen {...f} />);
    expect(screen.getByText("Загружаем настройки")).toBeDefined(); expect(screen.queryByText("Не задано")).toBeNull();
    f.snapshot = { ...f.snapshot, phase: "blocked", problem: { reason: "network" } }; rerender(<SettingsScreen {...f} />);
    expect(screen.getByRole("alert").textContent).toContain("Попробуй ещё раз");
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    expect(f.actions.refresh).toHaveBeenCalledOnce();
  });
});

describe("material settings", () => {
  it("waits for the current server topics before offering an informed conflict choice", () => {
    const f = fixture(); f.snapshot.data!.settings.material.value = { mode: "topics", topic_ids: [id(99)] };
    f.snapshot.drafts.material = draft({ mode: "level", selected_level: "A1" }, {
      conflict: true, error: "conflict", canSave: false, canKeepMine: true });
    const { rerender } = render(<SettingsScreen {...f} />);
    const group = field("Учебный материал");
    expect(group.getByText(/Названия сохранённых тем пока недоступны/)).toBeDefined();
    expect((group.getByRole("button", { name: "Принять сохранённое" }) as HTMLButtonElement).disabled).toBe(true);
    expect((group.getByRole("button", { name: "Сохранить моё значение" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(group.getByRole("button", { name: "Обновить список тем" })); expect(f.onReloadTopics).toHaveBeenCalledOnce();
    f.catalog = { phase: "ready", topics: [...topics, { id: id(99), number: 99, german_name: "Neu", description: "New topic" }] };
    rerender(<SettingsScreen {...f} />);
    expect(group.getByText("Сейчас сохранено: 99. Neu")).toBeDefined();
    expect((group.getByRole("button", { name: "Сохранить моё значение" }) as HTMLButtonElement).disabled).toBe(false);
    expect(f.actions.keepMine).not.toHaveBeenCalled();
  });
  it("keeps the saved level visible when it is no longer offered for a new choice", () => {
    const f = fixture(); f.snapshot.data!.settings.material.value = { mode: "level", selected_level: "A1" };
    f.snapshot.data!.constraints.material.modes!.level.selected_level = ["A2", "B1"];
    render(<SettingsScreen {...f} />);
    const select = field("Учебный материал").getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("A1"); expect(select.selectedOptions[0].disabled).toBe(true);
    expect(f.actions.edit).not.toHaveBeenCalled();
  });
  it("shows the actual server topic names when a conflict has the same selected count", () => {
    const f = fixture(); f.snapshot.data!.settings.material.value = { mode: "topics", topic_ids: [id(9)] };
    f.snapshot.drafts.material = draft({ mode: "topics", topic_ids: [id(8)] }, {
      conflict: true, error: "conflict", canSave: false, canKeepMine: true });
    render(<SettingsScreen {...f} />);
    expect(field("Учебный материал").getByText("Сейчас сохранено: 12. Straße")).toBeDefined();
    expect((screen.getByRole("checkbox", { name: "7. Küche" }) as HTMLInputElement).checked).toBe(true);
  });
  it("switches exclusively to level without choosing a value and uses only API levels", () => {
    const f = fixture(); f.snapshot.data!.constraints.material.modes!.level.selected_level = ["A2", "B1"];
    const { rerender } = render(<SettingsScreen {...f} />);
    fireEvent.click(field("Учебный материал").getByRole("radio", { name: "Уровень" }));
    expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("material", { mode: "level", selected_level: "" });
    f.snapshot.drafts.material = draft({ mode: "level", selected_level: "" }, { valid: false, canSave: false });
    rerender(<SettingsScreen {...f} />);
    const select = field("Учебный материал").getByRole("combobox") as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(["", "A2", "B1"]);
    fireEvent.change(select, { target: { value: "B1" } });
    expect(f.actions.edit).toHaveBeenLastCalledWith("material", { mode: "level", selected_level: "B1" });
    expect(f.actions.save).not.toHaveBeenCalled();
  });

  it("switches exclusively to topics without automatically choosing the first topic", () => {
    const f = fixture(); f.snapshot.data!.settings.material.value = { mode: "level", selected_level: "A1" };
    render(<SettingsScreen {...f} />);
    fireEvent.click(field("Учебный материал").getByRole("radio", { name: "Темы учебника" }));
    expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("material", { mode: "topics", topic_ids: [] });
    expect(f.actions.save).not.toHaveBeenCalled();
  });

  it.each(["loading", "failed"] as const)("does not present a %s catalog as empty or permit a topic save", phase => {
    const f = fixture(); f.snapshot.drafts.material = draft({ mode: "topics", topic_ids: [id(8)] });
    f.catalog = { phase, topics: null }; render(<SettingsScreen {...f} />);
    const group = field("Учебный материал");
    expect(group.queryByText("Тем пока нет")).toBeNull();
    expect((group.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    expect(group.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("keeps topic search through refresh and only blocks affected material", () => {
    const f = fixture(); f.snapshot.drafts.material = draft({ mode: "topics", topic_ids: [id(8)] });
    f.snapshot.drafts.learning_group_size = draft("5");
    const { rerender } = render(<SettingsScreen {...f} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "kueche" } });
    const list = screen.getByRole("group", { name: "Список тем" }); list.scrollTop = 45;
    f.catalog = { ...f.catalog, phase: "failed" }; rerender(<SettingsScreen {...f} />);
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("kueche");
    expect(screen.getByRole("group", { name: "Список тем" })).toBe(list); expect(list.scrollTop).toBe(45);
    expect((field("Учебный материал").getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    expect((field("Новых карточек в группе").getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Обновить список тем" })); expect(f.onReloadTopics).toHaveBeenCalledOnce();
    f.catalog = { ...f.catalog, phase: "ready" }; rerender(<SettingsScreen {...f} />);
    expect((field("Учебный материал").getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks saving unknown selected topics without displaying their identifiers", () => {
    const f = fixture(); f.snapshot.drafts.material = draft({ mode: "topics", topic_ids: [id(99)] });
    render(<SettingsScreen {...f} />);
    expect((field("Учебный материал").getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).not.toContain(id(99));
  });
});

describe("settings language and navigation", () => {
  it.each([["ru", "Настройки", "Сегодня"], ["uk", "Налаштування", "Сьогодні"], ["en", "Settings", "Today"]] as const)(
    "uses %s labels and delegates only available navigation", (language, title, today) => {
      const f = fixture(); f.language = language; render(<SettingsScreen {...f} />);
      expect(screen.getByRole("heading", { level: 1, name: title })).toBeDefined();
      const buttons = within(screen.getByRole("navigation")).getAllByRole("button") as HTMLButtonElement[];
      expect(buttons[1].disabled).toBe(true); expect(buttons[2].getAttribute("aria-current")).toBe("page");
      fireEvent.click(screen.getByRole("button", { name: today })); expect(f.onToday).toHaveBeenCalledOnce();
      expect(f.actions.save).not.toHaveBeenCalled();
    });
  it("opens the Dictionary from the shared panel when the host provides it (M-NAV)", () => {
    const f = fixture(), onDictionary = vi.fn(); render(<SettingsScreen {...f} onDictionary={onDictionary} />);
    const panel = within(screen.getByRole("navigation", { name: "Основная навигация" }));
    expect((panel.getByRole("button", { name: "Настройки" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(panel.getByRole("button", { name: "Словарь" }));
    expect(onDictionary).toHaveBeenCalledOnce(); expect(f.onToday).not.toHaveBeenCalled();
  });
});

describe("review error mode, learning content and Mix explanation (M-SET)", () => {
  const labels = {
    ru: { strict: "Строгий режим повторов", content: "Состав Learning", mix: "Перемешивать темы",
      modes: ["Строгий", "Мягкий"], contents: ["Слова", "Фразы", "Слова + фразы"], strictHint: /не проверка регистра/, mixHint: /темы идут по порядку/, contentHint: /следующий автоматический набор/ },
    uk: { strict: "Суворий режим повторень", content: "Склад Learning", mix: "Перемішувати теми",
      modes: ["Суворий", "М’який"], contents: ["Слова", "Фрази", "Слова + фрази"], strictHint: /не перевірка регістру/, mixHint: /теми йдуть по порядку/, contentHint: /наступний автоматичний набір/ },
    en: { strict: "Strict review mode", content: "Learning content", mix: "Mix topics",
      modes: ["Strict", "Soft"], contents: ["Words", "Phrases", "Words + phrases"], strictHint: /not the letter-case check/, mixHint: /topics go in order/, contentHint: /next automatic set/ },
  } as const;

  it("shows both settings in the main learning group with the saved choice and the server's options", () => {
    const f = fixture(), { container } = render(<SettingsScreen {...f} />);
    const mode = field("Строгий режим повторов"), content = field("Состав Learning");
    expect((mode.getAllByRole("radio") as HTMLInputElement[]).map(r => [r.value, r.checked])).toEqual([["strict", true], ["soft", false]]);
    expect((content.getAllByRole("radio") as HTMLInputElement[]).map(r => [r.value, r.checked]))
      .toEqual([["words", true], ["phrases", false], ["mixed", false]]);
    expect(container.querySelector("details")?.contains(mode.getAllByRole("radio")[0])).toBe(false);
    expect(container.querySelector("details")?.contains(content.getAllByRole("radio")[0])).toBe(false);
    // The strict mode is a separate field from the letter-case check.
    expect(field("Проверять регистр букв")).toBeDefined();
  });

  it("builds the options from the server constraint, not from a fixed list", () => {
    const f = fixture(); f.snapshot.data!.constraints.learning_content.values = ["words", "mixed"];
    render(<SettingsScreen {...f} />);
    expect((field("Состав Learning").getAllByRole("radio") as HTMLInputElement[]).map(r => r.value)).toEqual(["words", "mixed"]);
  });

  it("choosing edits only the draft of that key and never saves by itself", () => {
    const f = fixture(); render(<SettingsScreen {...f} />);
    fireEvent.click(field("Строгий режим повторов").getByRole("radio", { name: "Мягкий" }));
    expect(f.actions.edit).toHaveBeenLastCalledWith("review_error_mode", "soft");
    fireEvent.click(field("Состав Learning").getByRole("radio", { name: "Слова + фразы" }));
    expect(f.actions.edit).toHaveBeenLastCalledWith("learning_content", "mixed");
    expect(f.actions.edit).toHaveBeenCalledTimes(2); expect(f.actions.save).not.toHaveBeenCalled();
  });

  it.each([["Строгий режим повторов", "review_error_mode", "soft"], ["Состав Learning", "learning_content", "phrases"]] as const)(
    "%s saves only on the explicit button, by its own key", (title, key, value) => {
      const f = fixture(); f.snapshot.drafts[key] = draft(value, { original: key === "review_error_mode" ? "strict" : "words", fieldVersion: "1" });
      render(<SettingsScreen {...f} />);
      expect((field(title).getAllByRole("radio") as HTMLInputElement[]).find(r => r.checked)?.value).toBe(value);
      expect(f.actions.save).not.toHaveBeenCalled();
      fireEvent.click(field(title).getByRole("button", { name: "Сохранить" }));
      expect(f.actions.save).toHaveBeenCalledExactlyOnceWith(key);
      expect(screen.queryByText("Сохранено")).toBeNull();
    });

  it("keeps an invalid value visible with an error and does not substitute another option", () => {
    const f = fixture(); f.snapshot.drafts.learning_content = draft("verbs", { valid: false, error: "invalid", canSave: false });
    render(<SettingsScreen {...f} />);
    const content = field("Состав Learning");
    const radios = content.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map(r => [r.value, r.checked])).toEqual([["verbs", true], ["words", false], ["phrases", false], ["mixed", false]]);
    expect(content.getByText("Проверь значение и допустимые варианты.")).toBeDefined();
    expect((content.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    // The server's real options stay selectable so the user can correct the input.
    expect(radios.filter(r => !r.disabled).map(r => r.value)).toEqual(["words", "phrases", "mixed"]);
    expect(f.actions.edit).not.toHaveBeenCalled();
  });

  it("keeps the stored value visible after the allowed choices narrow, without selecting another", () => {
    const f = fixture(); f.snapshot.data!.settings.learning_content.value = "mixed";
    f.snapshot.data!.constraints.learning_content.values = ["words", "phrases"];
    render(<SettingsScreen {...f} />);
    const radios = field("Состав Learning").getAllByRole("radio") as HTMLInputElement[];
    expect(radios.find(r => r.checked)?.value).toBe("mixed"); expect(radios.find(r => r.checked)?.disabled).toBe(true);
    expect(f.actions.edit).not.toHaveBeenCalled();
  });

  it("offers both explicit conflict decisions for review mode and keeps the user's choice", () => {
    const f = fixture(); f.snapshot.data!.settings.review_error_mode = { value: "strict", version: "5" };
    f.snapshot.drafts.review_error_mode = draft("soft", { original: "strict", fieldVersion: "1", conflict: true, error: "conflict",
      canSave: false, canKeepMine: true });
    render(<SettingsScreen {...f} />); const mode = field("Строгий режим повторов");
    expect((mode.getAllByRole("radio") as HTMLInputElement[]).find(r => r.checked)?.value).toBe("soft");
    expect(mode.getByText("Сейчас сохранено: Строгий")).toBeDefined();
    expect(mode.queryByRole("button", { name: "Сохранить" })).toBeNull();
    fireEvent.click(mode.getByRole("button", { name: "Принять сохранённое" }));
    fireEvent.click(mode.getByRole("button", { name: "Сохранить моё значение" }));
    expect(f.actions.acceptCurrent).toHaveBeenCalledExactlyOnceWith("review_error_mode");
    expect(f.actions.keepMine).toHaveBeenCalledExactlyOnceWith("review_error_mode");
  });

  it("disables the choices while editing is not allowed and shows accepted status only after commit", () => {
    const f = fixture(); f.snapshot.canEdit = false; f.snapshot.outcome = { commandId: id(3), key: "review_error_mode", status: "accepted" };
    render(<SettingsScreen {...f} />);
    expect((field("Строгий режим повторов").getAllByRole("radio") as HTMLInputElement[]).every(r => r.disabled)).toBe(true);
    expect(field("Строгий режим повторов").getByText("Сохранено")).toBeDefined();
    expect(field("Состав Learning").queryByText("Сохранено")).toBeNull();
  });

  it.each(["ru", "uk", "en"] as const)("explains strict mode and Mix and labels the choices in %s", language => {
    const f = fixture(); f.language = language; const l = labels[language];
    const { container } = render(<SettingsScreen {...f} />); openAdditional(container);
    const mode = field(l.strict), content = field(l.content), mix = field(l.mix);
    for (const name of l.modes) expect(mode.getByRole("radio", { name })).toBeDefined();
    for (const name of l.contents) expect(content.getByRole("radio", { name })).toBeDefined();
    expect(mode.getByText(l.strictHint)).toBeDefined();
    expect(mix.getByText(l.mixHint)).toBeDefined();
    expect(content.getByText(l.contentHint)).toBeDefined();
  });

  it("links the explanations to their controls", () => {
    const f = fixture(), { container } = render(<SettingsScreen {...f} />); openAdditional(container);
    const radio = field("Строгий режим повторов").getAllByRole("radio")[0];
    const hint = document.getElementById(radio.getAttribute("aria-describedby")!.split(" ")[0]);
    expect(hint?.textContent).toMatch(/не проверка регистра/);
    const mixRadio = field("Перемешивать темы").getAllByRole("radio")[0];
    expect(document.getElementById(mixRadio.getAttribute("aria-describedby")!.split(" ")[0])?.textContent)
      .toMatch(/темы идут по порядку/);
  });
});

describe("Mix with the material chosen by CEFR level (M-SET-MIX-LEVEL, 2.21г)", () => {
  const level = { mode: "level", selected_level: "A1", topic_ids: [] };
  function levelFixture(mix: boolean | null, material: unknown = level) {
    const f = fixture(); f.snapshot.data!.settings.material.value = material as never;
    f.snapshot.data!.settings.learning_mix.value = mix; return f;
  }
  const mixRadios = () => field("Перемешивать темы").getAllByRole("radio") as HTMLInputElement[];

  it("disables and mutes the stored Mix choice, explains why and keeps the value", async () => {
    const f = levelFixture(true), { container } = render(<SettingsScreen {...f} />); openAdditional(container);
    // A real click, as the browser does it: it must not reach the handler of a disabled radio.
    await userEvent.click(mixRadios()[1]);
    expect(f.actions.edit).not.toHaveBeenCalled();
    expect(mixRadios().every(r => r.disabled)).toBe(true);
    expect(mixRadios().map(r => r.checked)).toEqual([true, false]);
    expect(field("Перемешивать темы").getByText(/поэтому «Перемешивать темы» не действует\. Сохранённое значение снова начнёт действовать/)).toBeDefined();
    expect(screen.getByRole("group", { name: "Перемешивать темы", hidden: true }).className).toContain("settings-field-muted");
    expect(f.actions.edit).not.toHaveBeenCalled();
  });

  it("locks Mix too while no value is stored, shows it as off and does not ask to set it (2.25а)", async () => {
    const f = levelFixture(null), { container } = render(<SettingsScreen {...f} />); openAdditional(container);
    expect(mixRadios().every(r => r.disabled)).toBe(true);
    expect(mixRadios().map(r => r.checked)).toEqual([false, true]);
    expect(field("Перемешивать темы").queryByText(/нужно задать/)).toBeNull();
    await userEvent.click(mixRadios()[0]);
    expect(f.actions.edit).not.toHaveBeenCalled();
  });

  it("follows the saved material, not an unsaved draft of it", () => {
    const topics = { mode: "topics", selected_level: null, topic_ids: [id(8)] };
    // Saved topics, draft level: Mix stays usable.
    const a = levelFixture(true, topics); a.snapshot.drafts.material = draft(level);
    const first = render(<SettingsScreen {...a} />); openAdditional(first.container);
    expect(mixRadios().some(r => r.disabled)).toBe(false);
    first.unmount();
    // Saved level, draft topics: Mix stays locked.
    const b = levelFixture(true); b.snapshot.drafts.material = draft(topics);
    const second = render(<SettingsScreen {...b} />); openAdditional(second.container);
    expect(mixRadios().every(r => r.disabled)).toBe(true);
  });

  it("does not mute Mix for topics or for an unset material", () => {
    for (const material of [{ mode: "topics", selected_level: null, topic_ids: [id(8)] }, null]) {
      const f = levelFixture(true, material), { container, unmount } = render(<SettingsScreen {...f} />); openAdditional(container);
      expect(mixRadios().some(r => r.disabled)).toBe(false);
      expect(field("Перемешивать темы").getByText(/темы идут по порядку/)).toBeDefined();
      expect(screen.getByRole("group", { name: "Перемешивать темы", hidden: true }).className).not.toContain("muted");
      unmount();
    }
  });

  it.each([["uk", /тому «Перемішувати теми» не діє/], ["en", /so “Mix topics” has no effect/]] as const)("explains in %s", (language, text) => {
    const f = levelFixture(false); f.language = language;
    const { container } = render(<SettingsScreen {...f} />); openAdditional(container);
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
  });

  it("links the note to the radios", () => {
    const f = levelFixture(true), { container } = render(<SettingsScreen {...f} />); openAdditional(container);
    const ids = mixRadios()[0].getAttribute("aria-describedby")!.split(" ");
    expect(ids.map(item => document.getElementById(item)?.textContent).join(" ")).toMatch(/Сохранённое значение снова начнёт действовать/);
  });
});

describe("returning the initial settings (M-SET-RESET, D-SET-RESET 4.1, 5.3.1)", () => {
  const feedback = { state: { phase: "ready", text: "", canEdit: true, canSend: false, canRetry: false, confirmed: false,
    refusal: false, problem: null }, actions: { edit: vi.fn(), send: vi.fn(), retry: vi.fn() } } as unknown as FeedbackDocument;
  const resetButton = () => screen.getByRole("button", { name: "Сброс настроек" });
  const resetRecord = { schemaVersion: 1 as const, profileId: id(1), clientInstanceId: id(2),
    intent: { command_id: id(100), kind: "settings.reset" as const, payload: {} } };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("stands after the collapsed additional settings and before the message to the developer", () => {
    const f = fixture(); const { container } = render(<SettingsScreen {...f} feedback={feedback} />);
    const details = container.querySelector("details")!;
    const developer = screen.getByRole("region", { name: settingsFeedbackCopy.ru.title });
    expect(details.contains(resetButton())).toBe(false);
    expect(details.compareDocumentPosition(resetButton()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(resetButton().compareDocumentPosition(developer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("asks first with the approved Q08 text, which names only the general blocks", async () => {
    const f = fixture(); render(<SettingsScreen {...f} />);
    fireEvent.click(resetButton());
    const dialog = screen.getByRole("dialog", { name: "Вернуть исходные настройки?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect([...dialog.querySelectorAll("p")].map(item => item.textContent)).toEqual([
      "Сбросятся настройки Learning, повторов после ошибок, проверки ответов и перехода между карточками.",
      "Языки, выбранный учебный материал и настройки напоминаний сохранятся. Текущая группа, результаты и сроки повторов не изменятся.",
    ]);
    expect(within(dialog).getAllByRole("button").map(button => button.textContent)).toEqual(["Вернуть", "Отмена"]);
    for (const key of resetKeys) expect(dialog.textContent).not.toContain(settingsCopy.ru.fields[key]);
    expect(f.actions.reset).not.toHaveBeenCalled();
  });

  it.each(["cancel", "escape", "back"] as const)("closes on %s without a command and returns focus to the button", async way => {
    const handlers = new Set<() => void>();
    vi.stubGlobal("Telegram", { WebApp: { BackButton: { show() {}, hide() {}, onClick: (h: () => void) => { handlers.add(h); },
      offClick: (h: () => void) => { handlers.delete(h); } } } });
    const f = fixture(); render(<SettingsScreen {...f} />);
    resetButton().focus(); fireEvent.click(resetButton());
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Отмена" }));
    if (way === "cancel") fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    else if (way === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
    else { expect(handlers.size).toBe(1); act(() => { for (const handler of [...handlers]) handler(); }); }
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.actions.reset).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(resetButton());
    expect(handlers.size).toBe(0);
  });

  it("«Вернуть» closes the window and asks the owner once; the button follows canReset", () => {
    const f = fixture(); const view = render(<SettingsScreen {...f} />);
    fireEvent.click(resetButton()); fireEvent.click(screen.getByRole("button", { name: "Вернуть" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(f.actions.reset).toHaveBeenCalledOnce();
    f.snapshot = { ...f.snapshot, canReset: false }; view.rerender(<SettingsScreen {...f} />);
    expect((resetButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows waiting, then success only from the outcome; a refusal says nothing changed", () => {
    const f = fixture();
    f.snapshot = { ...f.snapshot, phase: "sending", resetPending: resetRecord, canEdit: false, canReset: false };
    const view = render(<SettingsScreen {...f} />);
    // One line, next to the button: the top status line stays silent about the reset (QA finding 2).
    expect(screen.getAllByRole("status").map(item => item.textContent)).toEqual(["Возвращаем исходные настройки"]);
    expect(screen.queryByText("Исходные настройки возвращены.")).toBeNull();
    f.snapshot = { ...f.snapshot, phase: "ready", resetPending: null, canEdit: true, canReset: true,
      resetOutcome: { commandId: id(100), status: "accepted" } };
    view.rerender(<SettingsScreen {...f} />);
    expect(screen.getByRole("status").textContent).toBe("Исходные настройки возвращены.");
    f.snapshot = { ...f.snapshot, resetOutcome: { commandId: id(100), status: "rejected", code: "DOCUMENT_STALE" } };
    view.rerender(<SettingsScreen {...f} />);
    expect(screen.getByRole("alert").textContent).toBe("Не удалось вернуть исходные настройки. Ничего не изменилось. Попробуй ещё раз.");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it.each(["network", "not_found"] as const)("an unknown outcome (%s) offers the exact retry and keeps new writes disabled", reason => {
    const f = fixture();
    f.snapshot = { ...f.snapshot, phase: "unresolved", resetPending: resetRecord, problem: { reason }, canEdit: false, canReset: false, canRetry: true };
    const { container } = render(<SettingsScreen {...f} />);
    const unknown = "Пока не удалось подтвердить возврат исходных настроек. Проверь состояние или повтори отправку.";
    // Shown and announced once, in the reset block, with its retry there (QA finding 2).
    expect(screen.getAllByRole("alert").map(item => item.textContent)).toEqual([unknown]);
    expect(screen.queryByRole("status")).toBeNull();
    const block = container.querySelector(".settings-reset-status")!;
    expect(block.textContent).toContain(unknown);
    expect((resetButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("button", { name: "Повторить отправку" })).toHaveLength(1);
    fireEvent.click(within(block as HTMLElement).getByRole("button", { name: "Повторить отправку" }));
    expect(f.actions.retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Обновить настройки" })).toBeDefined();
    expect(f.actions.reset).not.toHaveBeenCalled();
  });

  it.each([
    ["client_changed", "unresolved"], ["pending_changed", "unresolved"], [null, "checking"],
  ] as const)("with no retry available (%s, %s) the block never suggests one (defect 2.1)", (reason, phase) => {
    // A status check clears the problem while it runs (settingsController refresh), so it says nothing failed yet.
    const f = fixture();
    f.snapshot = { ...f.snapshot, phase, resetPending: { ...resetRecord, clientInstanceId: reason === "client_changed" ? id(9) : id(2) },
      problem: reason ? { reason } : null, canEdit: false, canReset: false, canRetry: false };
    const { container } = render(<SettingsScreen {...f} />);
    expect(container.querySelector(".settings-reset-status")?.textContent).toBe("");
    expect(screen.queryByText(/Пока не удалось подтвердить возврат/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
  });

  it("after «Вернуть» focus moves to the reset result, not to the button that is disabled now", () => {
    const f = fixture(); const { container, rerender } = render(<SettingsScreen {...f} />);
    resetButton().focus(); fireEvent.click(resetButton());
    fireEvent.click(screen.getByRole("button", { name: "Вернуть" }));
    const status = container.querySelector(".settings-reset-status");
    expect(document.activeElement).toBe(status);
    f.snapshot = { ...f.snapshot, phase: "sending", resetPending: resetRecord, canEdit: false, canReset: false };
    rerender(<SettingsScreen {...f} />);
    expect(document.activeElement).toBe(status);
    expect(status?.textContent).toBe("Возвращаем исходные настройки");
  });

  it("without settings data the top line still reports the unknown reset once, with its retry", () => {
    const f = fixture();
    f.snapshot = { ...f.snapshot, phase: "unresolved", data: null, resetPending: resetRecord, problem: { reason: "network" },
      canEdit: false, canReset: false, canRetry: true };
    render(<SettingsScreen {...f} />);
    expect(screen.getAllByRole("alert").map(item => item.textContent))
      .toEqual(["Пока не удалось подтвердить возврат исходных настроек. Проверь состояние или повтори отправку.Повторить отправку"]);
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" })); expect(f.actions.retry).toHaveBeenCalledOnce();
  });

  it("a retryable reason without an approved reset text keeps the top line and its retry, not a second line", () => {
    const f = fixture();
    f.snapshot = { ...f.snapshot, phase: "unresolved", resetPending: resetRecord, problem: { reason: "stale_response" },
      canEdit: false, canReset: false, canRetry: true };
    const { container } = render(<SettingsScreen {...f} />);
    expect(container.querySelector(".settings-reset-status")?.textContent).toBe("");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Повторить отправку" })).toHaveLength(1);
  });

  it.each([
    ["incompatible", "reset", "Нужно обновить приложение: эта версия не может отправлять новые действия. Закрой Wortly и открой снова через бота."],
    ["command_refused", "reset", "Сервер не принял эту отправку возврата исходных настроек. Выполнен ли возврат раньше, пока не подтверждено. Проверь состояние."],
    ["incompatible", "save", "Нужно обновить приложение: эта версия не может отправлять новые действия. Закрой Wortly и открой снова через бота."],
    ["command_refused", "save", "Сервер не принял эту отправку изменения. Принято ли оно раньше, пока не подтверждено. Проверь состояние."],
  ] as const)("a known refusal (%s, %s) uses an existing text and offers no repeat (C082)", (reason, kind, text) => {
    const f = fixture();
    const save = { schemaVersion: 1 as const, profileId: id(1), clientInstanceId: id(2),
      intent: { command_id: id(100), kind: "setting.save" as const, expected_field_version: "1", payload: { key: "retry_count" as const, value: 4 } } };
    f.snapshot = { ...f.snapshot, phase: "unresolved", ...(kind === "reset" ? { resetPending: resetRecord } : { pending: save }),
      problem: { reason, code: reason === "incompatible" ? "CLIENT_INCOMPATIBLE" : "VALIDATION_FAILED" },
      canEdit: false, canReset: false, canRetry: false };
    render(<SettingsScreen {...f} />);
    expect(screen.getAllByRole("alert").map(item => item.textContent)).toEqual([text]);
    expect(screen.queryByText(/повтори отправку/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    expect(screen.getByRole("button", { name: "Обновить настройки" })).toBeDefined();
  });

  it("a mismatch shows the existing text and no reset status or retry", () => {
    const f = fixture();
    f.snapshot = { ...f.snapshot, phase: "unresolved", resetPending: { ...resetRecord, mismatch: true },
      problem: { reason: "mismatch", code: "COMMAND_PAYLOAD_MISMATCH" }, canEdit: false, canReset: false };
    render(<SettingsScreen {...f} />);
    expect(screen.getByRole("alert").textContent).toBe(settingsCopy.ru.problems.mismatch);
    expect(screen.queryByRole("status")).toBeNull(); expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
  });

  describe("Q36 continue with the server's settings after a mismatch", () => {
    const save = { schemaVersion: 1 as const, profileId: id(1), clientInstanceId: id(2), mismatch: true as const,
      intent: { command_id: id(100), kind: "setting.save" as const, expected_field_version: "1", payload: { key: "retry_count" as const, value: 4 } } };
    const mismatchState = (f: ReturnType<typeof fixture>, canContinueWithServer: boolean) => {
      f.snapshot = { ...f.snapshot, phase: "unresolved", pending: save, problem: { reason: "mismatch", code: "COMMAND_PAYLOAD_MISMATCH" },
        canEdit: false, canReset: false, canContinueWithServer };
    };
    it.each([["ru", "Продолжить с текущими настройками"], ["uk", "Продовжити з поточними налаштуваннями"],
      ["en", "Continue with the current settings"]] as const)("%s: the offered action has its own text, calls only continueWithServer", async (language, label) => {
      const f = fixture(); mismatchState(f, true); render(<SettingsScreen {...f} language={language} />);
      expect(screen.getByRole("alert").textContent).toContain(settingsCopy[language].mismatchContinue);
      expect(screen.queryByRole("button", { name: settingsCopy[language].retry })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(f.actions.continueWithServer).toHaveBeenCalledOnce();
      for (const name of ["retry", "save", "reset", "refresh"] as const) expect(f.actions[name]).not.toHaveBeenCalled();
    });
    describe("focus and announcements while leaving the mismatch", () => {
      const pressed = async (language: "ru" | "uk" | "en" = "ru") => {
        const f = fixture(); mismatchState(f, true);
        const run = { finish: () => {} };
        f.actions.continueWithServer = vi.fn(() => new Promise<void>(resolve => { run.finish = resolve; }));
        const view = render(<SettingsScreen {...f} language={language} />);
        const button = screen.getByRole("button", { name: settingsCopy[language].continueWithServer });
        button.focus(); await userEvent.keyboard("{Enter}");
        const show = (snapshot: Partial<SettingsScreenProps["snapshot"]>) =>
          view.rerender(<SettingsScreen {...f} language={language} snapshot={{ ...f.snapshot, ...snapshot }} />);
        return { f, run, show, button };
      };
      const region = () => document.querySelector<HTMLElement>(".settings-continue-status");
      const done = { phase: "ready" as const, pending: null, problem: null, canEdit: true, canContinueWithServer: false };

      it("keyboard activation calls the action once; the process is announced as a status while the button is gone", async () => {
        const { f, show } = await pressed();
        expect(f.actions.continueWithServer).toHaveBeenCalledOnce();
        show({ phase: "checking", canContinueWithServer: false, canEdit: false });
        expect(screen.queryByRole("button", { name: "Продолжить с текущими настройками" })).toBeNull();
        expect(screen.getAllByRole("status").map(item => item.textContent).filter(text => text === settingsCopy.ru.refreshing)).toHaveLength(1);
        expect(document.activeElement).toBe(region());
      });

      it("focus is on the progress region at once, before any new state arrives", async () => {
        await pressed();
        expect(document.activeElement).toBe(region());
        expect(within(region()!).getByRole("status").textContent).toBe(settingsCopy.ru.refreshing);
        expect(screen.getAllByRole("status").filter(item => item.textContent === settingsCopy.ru.refreshing)).toHaveLength(1);
      });

      it("the result does not take focus from where the user moved it during the action", async () => {
        const { run, show } = await pressed();
        const refresh = screen.getByRole("button", { name: "Обновить настройки" });
        refresh.focus(); expect(document.activeElement).toBe(refresh);
        show({ phase: "checking", canContinueWithServer: false });
        await act(async () => { run.finish(); }); show(done);
        expect(within(region()!).getByRole("status").textContent).toBe(settingsCopy.ru.continued);
        expect(document.activeElement).toBe(refresh);
      });

      it.each([
        ["a remaining problem", { pending: null, problem: { reason: "network" as const } }],
        ["a remaining pending record", { pending: save, problem: null }],
      ])("%s alone is a failure, not a success", async (_name, rest) => {
        const { run, show } = await pressed();
        show({ phase: "checking", canContinueWithServer: false }); await act(async () => { run.finish(); });
        show({ phase: "unresolved", canContinueWithServer: false, canEdit: false, ...rest });
        expect(within(region()!).getByRole("status").textContent).toBe(settingsCopy.ru.continueFailed);
      });

      it("the success line is removed when a new save starts", async () => {
        const { f, run, show } = await pressed();
        show({ phase: "checking", canContinueWithServer: false }); await act(async () => { run.finish(); });
        show({ ...done, drafts: { retry_count: draft(5) } });
        expect(within(region()!).getByRole("status").textContent).toBe(settingsCopy.ru.continued);
        fireEvent.click(field("Повторов после ошибки").getByRole("button", { name: "Сохранить" }));
        expect(f.actions.save).toHaveBeenCalledOnce(); expect(region()).toBeNull();
      });

      it.each([["ru"], ["uk"], ["en"]] as const)("%s: a failed check of the mismatched save leads to the refresh, never to retrying the old command", async language => {
        const { show } = await pressed(language);
        show({ phase: "unresolved", problem: { reason: "network" }, canContinueWithServer: false, canEdit: false, canRetry: false });
        expect(screen.getByRole("alert").textContent).toBe(settingsCopy[language].mismatchRefresh);
        expect(screen.queryByText(settingsCopy[language].unknown)).toBeNull();
        expect(screen.queryByRole("button", { name: settingsCopy[language].retry })).toBeNull();
      });

      it.each(["ru", "uk", "en"] as const)("%s: after success the result is announced and focus lands on the status region", async language => {
        const { run, show } = await pressed(language);
        show({ phase: "checking", canContinueWithServer: false });
        await act(async () => { run.finish(); }); show(done);
        const status = within(region()!).getByRole("status");
        expect(status.textContent).toBe(settingsCopy[language].continued);
        expect(document.activeElement).toBe(status.parentElement);
        expect(document.activeElement).not.toBe(document.body);
        expect(screen.queryByRole("alert")).toBeNull();
      });

      it("after a failure the message is a status, focus is kept on the page region and refresh is still available", async () => {
        const { f, run, show } = await pressed();
        show({ phase: "checking", canContinueWithServer: false });
        await act(async () => { run.finish(); });
        show({ phase: "unresolved", problem: { reason: "network" }, canContinueWithServer: false, canEdit: false });
        const status = within(region()!).getByRole("status");
        expect(status.textContent).toBe(settingsCopy.ru.continueFailed);
        expect(document.activeElement).toBe(status.parentElement);
        expect(screen.getByRole("alert").textContent).toBe(settingsCopy.ru.mismatchRefresh);
        expect(screen.queryByText(/повтори отправку/)).toBeNull(); expect(screen.queryByText(settingsCopy.ru.unknown)).toBeNull();
        const refresh = screen.getByRole("button", { name: "Обновить настройки" });
        expect(refresh.hasAttribute("disabled")).toBe(false);
        fireEvent.click(refresh); expect(f.actions.refresh).toHaveBeenCalledOnce();
        expect(region()).toBeNull();
      });

      it("when the action is offered again after a failed attempt, the stale failure line is gone", async () => {
        const { run, show } = await pressed();
        show({ phase: "checking", canContinueWithServer: false }); await act(async () => { run.finish(); });
        show({ phase: "unresolved", problem: { reason: "network" }, canContinueWithServer: false });
        expect(within(region()!).getByRole("status").textContent).toBe(settingsCopy.ru.continueFailed);
        show({ phase: "unresolved", problem: { reason: "mismatch" }, canContinueWithServer: true });
        expect(screen.queryByText(settingsCopy.ru.continueFailed)).toBeNull();
        expect(screen.getByRole("button", { name: "Продолжить с текущими настройками" })).toBeDefined();
      });

      it("an action that returns at once with no state change leaves the offered button and its focus alone", async () => {
        const { run, button } = await pressed();
        await act(async () => { run.finish(); });
        expect(region()).toBeNull();
        expect(screen.getByRole("button", { name: "Продолжить с текущими настройками" })).toBe(button);
        expect(document.activeElement).toBe(button);
      });
    });

    it("without a successful readback the existing blocked text shows and no action is offered", () => {
      const f = fixture(); mismatchState(f, false); render(<SettingsScreen {...f} />);
      expect(screen.getByRole("alert").textContent).toBe(settingsCopy.ru.problems.mismatch);
      expect(screen.queryByRole("button", { name: "Продолжить с текущими настройками" })).toBeNull();
    });
  });

  it.each([
    ["uk", "Скидання налаштувань", "Повернути початкові налаштування?", ["Повернути", "Скасувати"]],
    ["en", "Restore default settings", "Restore default settings?", ["Restore", "Cancel"]],
  ] as const)("uses the approved %s button, window title and buttons", (language, button, title, buttons) => {
    const f = fixture(); render(<SettingsScreen {...f} language={language} />);
    fireEvent.click(screen.getByRole("button", { name: button }));
    const dialog = screen.getByRole("dialog", { name: title });
    expect(within(dialog).getAllByRole("button").map(item => item.textContent)).toEqual([...buttons]);
  });
});
