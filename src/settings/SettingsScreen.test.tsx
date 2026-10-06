import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse, Topic } from "../api/generated";
import type { SettingsDraft } from "./settingsController";
import { SettingsScreen, type SettingsScreenProps } from "./SettingsScreen";

const big = "9007199254740995";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function current(state = big): SettingsResponse {
  return { state_version: state, needs_setup: true, settings: {
    ui_language: { value: "ru", version: "1" }, dictionary_language: { value: "uk", version: "1" },
    time_zone: { value: "UTC", version: "1" }, retry_gap: { value: null, version: "1" },
    retry_count: { value: 3, version: big }, learning_group_size: { value: null, version: "1" },
    learning_intervals_seconds: { value: [120, 30, 120], version: "1" },
    learning_poll_seconds: { value: null, version: "1" }, learning_reminder_pause_seconds: { value: null, version: "1" },
    learning_ready_percent: { value: null, version: "1" }, learning_mix: { value: null, version: "1" },
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
    learning_poll_seconds: { type: "integer", minimum: 10, maximum: 2147483647 },
    learning_reminder_pause_seconds: { type: "integer", minimum: 60, maximum: 2147483647 },
    learning_ready_percent: { type: "integer", minimum: 1, maximum: 100 },
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
    snapshot: { phase: "ready", data: current(), dataCurrent: true, drafts: {}, pending: null, outcome: null,
      problem: null, canEdit: true, canRetry: false },
    language: "ru", catalog: { phase: "ready", topics },
    actions: { edit: vi.fn(), save: vi.fn(async () => {}), acceptCurrent: vi.fn(), keepMine: vi.fn(async () => {}),
      refresh: vi.fn(async () => {}), retry: vi.fn(async () => {}) },
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
    expect((field("Новых слов в группе").getByRole("textbox") as HTMLInputElement).value).toBe("");
    fireEvent.click(radios[1]); expect(f.actions.edit).toHaveBeenCalledExactlyOnceWith("include_comparative", false);
  });

  it("displays actual bounds and leaves invalid input intact, without saving on Enter", () => {
    const f = fixture(); f.snapshot.data!.constraints.learning_group_size = { type: "integer", minimum: 2, maximum: 11 };
    f.snapshot.drafts.learning_group_size = draft("1e2", { valid: false, error: "invalid", canSave: false });
    render(<SettingsScreen {...f} />); const group = field("Новых слов в группе");
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
    fireEvent.click(field("Новых слов в группе").getByRole("button", { name: "Сохранить" }));
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
    render(<SettingsScreen {...f} />); const group = field("Новых слов в группе");
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
    render(<SettingsScreen {...f} />); const group = field("Новых слов в группе");
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
    expect((field("Новых слов в группе").getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
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
    expect((field("Новых слов в группе").getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(false);
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
});
