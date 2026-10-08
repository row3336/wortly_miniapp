import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenedClient, Profile, SavedCommandFact, SettingCommand, SettingsResponse, TodayResponse, Topic } from "../api/generated";
import { settingsRefusalText } from "../written/writtenApp.test-support";
import { App } from "./App";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const profileId = id(1);
// Test hook: holds the resumed session read, so the loading frame of the written owner can be observed.
let sessionReads = 0; let sessionHook: ((n: number) => Promise<void>) | null = null;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function current(state = "10"): SettingsResponse {
  return { state_version: state, needs_setup: true, settings: {
    ui_language: { value: "ru", version: "1" }, dictionary_language: { value: "uk", version: "1" },
    time_zone: { value: "UTC", version: "1" }, retry_gap: { value: null, version: "1" },
    retry_count: { value: 3, version: "1" }, learning_group_size: { value: null, version: "1" },
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
function fixture() {
  const data = current();
  const profile: Profile = { profile_id: profileId, access: { status: "admitted", version: "1", reason: null },
    role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: "10" };
  const facts = new Map<string, SavedCommandFact>();
  const state = { epoch: "1", session: null as OpenedClient["session"] };
  const haptic = vi.fn();
  const settingsReply = vi.fn(async () => json(data));
  const topicsReply = vi.fn(async () => json({ topics, state_version: data.state_version }));
  const openReply = vi.fn(async (body: { client_instance_id: string; document_id: string }) => json({ status: "opened",
    profile, compatibility: { compatible: true, contract_version: "1" }, client_instance_id: body.client_instance_id,
    document_id: body.document_id, proof_version: "1", document_epoch: state.epoch, session: state.session }));
  const todayReply = vi.fn(async () => json({ state_version: profile.state_version, pair: `${profile.dictionary_language}-de`,
    local_date: "2026-09-30", status: "no_material", base: { total: 0, words: 0, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "no_material", ready: 0, preview: 0, next_due_at: null, new_group_size: 0,
      manual_eligible: 0, automatic_eligible: 0 }, conjugation: { ready: 0, openable: 0, next_due_date: null },
    next_repeat_date: null } satisfies TodayResponse));
  const projection = () => { const { state_version: _, ...result } = data; return structuredClone(result); };
  const apply = (command: SettingCommand) => {
    const setting = data.settings[command.payload.key as keyof SettingsResponse["settings"]];
    Object.assign(setting, { value: structuredClone(command.payload.value), version: String(BigInt(setting.version) + 1n) });
    data.state_version = String(BigInt(data.state_version) + 1n);
    Object.assign(profile, { state_version: data.state_version, ui_language: data.settings.ui_language.value,
      dictionary_language: data.settings.dictionary_language.value });
    const fact: SavedCommandFact = { id: command.command_id, kind: "setting.save", status: "applied",
      applied_at: "2026-09-30T00:00:00Z", target_id: profileId, action_id: null, result_id: null, context_id: null,
      object_version: String(BigInt(command.expected_field_version) + 1n) };
    facts.set(fact.id, fact);
    return { command: fact, current: projection(), state_version: data.state_version };
  };
  const commandReply = vi.fn(async (command: SettingCommand) => json(apply(command)));
  const statusReply = vi.fn(async (commandId: string) => json(facts.has(commandId)
    ? { command: { ...facts.get(commandId)!, status: "already_applied" }, current: projection(), state_version: data.state_version }
    : { command: { id: commandId, status: "not_found" }, current: profile, state_version: profile.state_version }));
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    bindDeadline(init?.signal);
    const path = String(url), body = init?.body ? JSON.parse(init.body as string) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "synthetic-token", expires_at: "2026-10-01T00:00:00Z",
      profile, compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) return json({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return openReply(body);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token" });
    if (path.endsWith("/today")) return todayReply();
    if (path.endsWith("/settings/topics")) return topicsReply();
    if (path.endsWith("/settings")) return settingsReply();
    if (path.endsWith("/commands")) {
      expect(init?.headers).toHaveProperty("X-Origin-Proof", "synthetic-proof");
      return commandReply(body);
    }
    if (path.includes("/commands/")) return statusReply(path.split("/").at(-1)!);
    if (state.session && path.includes(`/sessions/${state.session.id}?`)) { sessionReads++; await sessionHook?.(sessionReads); }
    // The persisted mode of the reported session: a valid Written summary (it resumes on the written route, never in Learning).
    if (state.session && path.includes(`/sessions/${state.session.id}?`)) return json({ current: { session_id: state.session.id,
      mode: "written", status: "summary", pair: `${profile.dictionary_language}-de`, direction: "l1-de", local_date: "2026-09-30",
      bucket: "words", close_reason: null, progress: { completed: 2, total: 2, correct: 2, wrong: 0 }, assignment: null,
      summary: { completed: 2, correct: 2, wrong: 0, ratio: { numerator: 2, denominator: 2 } } }, state_version: data.state_version });
    throw new Error("Unexpected synthetic endpoint");
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "en" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: haptic } } });
  return { data, profile, state, haptic, settingsReply, topicsReply, openReply, todayReply, commandReply, statusReply, fetcher, apply };
}
function group(name: string) { return within(screen.getByRole("group", { name })); }
async function settings() {
  fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
  await screen.findByRole("group", { name: "Язык интерфейса" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Обновить настройки" }).hasAttribute("disabled")).toBe(false));
}
function change(name: string, value: string) { fireEvent.change(group(name).getByRole("combobox"), { target: { value } }); }
function save(name: string) { fireEvent.click(group(name).getByRole("button", { name: "Сохранить" })); }
async function refresh() {
  fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Обновить настройки" }).hasAttribute("disabled")).toBe(false));
}
async function foreground() { await act(async () => { window.dispatchEvent(new Event("pageshow")); }); }
// Role queries scoped to the page that is actually shown: same roles, accessible names and visibility rules, but searched
// only inside the current Settings page (re-resolved on every call, no element is kept across navigation).
function settingsPage() {
  const page = screen.getByRole("main");
  within(page).getByRole("heading", { level: 1, name: "Настройки" });
  return within(page);
}
function settingsSection(name: string) { return within(settingsPage().getByRole("region", { name })); }
function settingsHeader() {
  const header = settingsPage().getByRole("heading", { level: 1, name: "Настройки" }).closest("header");
  expect(header).not.toBeNull();
  return within(header!);
}
function todayNav() { return within(screen.getByRole("navigation", { name: "Основная навигация" })); }
// The transport deadline (api/http.ts) is the only product timer on this path. Hold it: a reply is late only relative to
// the navigation and foreground the test performs, never relative to how much CPU this worker gets. http.ts arms the
// deadline and then synchronously calls fetch, so the fixture binds each request signal to the deadline armed for it.
const transportTimeoutMs = 1000;
const heldDeadlines = new Set<unknown>(), deadlineOf = new WeakMap<AbortSignal, unknown>(), heldHandleCalls: string[] = [];
let armedDeadline: unknown;
// A held deadline never runs; Node timer methods called on it are recorded (expected: none) instead of throwing.
function heldHandle(): object {
  const handle: Record<string | symbol, () => unknown> = {};
  const record = (method: string, result: () => unknown) => () => { heldHandleCalls.push(method); return result(); };
  for (const method of ["ref", "unref", "refresh", "close"]) handle[method] = record(method, () => handle);
  handle.hasRef = record("hasRef", () => true);
  handle[Symbol.toPrimitive] = record("toPrimitive", () => NaN);
  return Object.freeze(handle);
}
function holdTransportDeadlines() {
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (ms !== transportTimeoutMs || !/\/src\/api\/http\.ts:\d+/.test(new Error().stack ?? "")) return realSetTimeout(handler, ms, ...rest);
    const handle = heldHandle(); heldDeadlines.add(handle); armedDeadline = handle; return handle;
  }) as unknown as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: unknown) => {
    if (!heldDeadlines.delete(handle)) realClearTimeout(handle as number | undefined);
  }) as typeof clearTimeout);
}
function bindDeadline(signal: AbortSignal | null | undefined) {
  if (signal) deadlineOf.set(signal, armedDeadline);
  armedDeadline = undefined;
}
// The held request itself is not aborted and its own deadline is still held.
function expectDeadlineHeld(f: ReturnType<typeof fixture>, path: string, nth: number) {
  const signal = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith(path))[nth]?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  expect(heldDeadlines.has(signal ? deadlineOf.get(signal) : undefined)).toBe(true);
}
beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "1000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "20000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
  holdTransportDeadlines();
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterEach(() => {
  // Diagnostic only: a request the test never answered keeps its deadline held.
  if (heldDeadlines.size) console.info(`transport deadlines still held at test end: ${heldDeadlines.size}`);
  const calls = [...heldHandleCalls];
  heldDeadlines.clear(); heldHandleCalls.length = 0; armedDeadline = undefined;
  expect(calls).toEqual([]);
});

describe("Settings in the real App document", () => {
  it("a stale settings GET after foreground cannot restore old editing rights", async () => {
    const f = fixture(); f.data.settings.material.value = { mode: "topics", topic_ids: [id(8)] };
    render(<App />);
    fireEvent.click(await waitFor(() => todayNav().getByRole("button", { name: "Настройки" })));
    await waitFor(() => settingsSection("Языки").getByRole("group", { name: "Язык интерфейса" }));
    await waitFor(() => expect(settingsHeader().getByRole("button", { name: "Обновить настройки" }).hasAttribute("disabled")).toBe(false));
    const learning = () => within(settingsSection("Обучение").getByRole("group", { name: "Новых карточек в группе" }));
    const field = learning().getByRole("textbox");
    const search = screen.getByRole("searchbox"); fireEvent.change(search, { target: { value: "ku" } });
    fireEvent.change(field, { target: { value: "17" } }); f.profile.state_version = "11";
    await foreground(); await waitFor(() => expect(f.settingsReply).toHaveBeenCalledTimes(2));
    await screen.findByText("Не удалось получить актуальные настройки. Обнови их.");
    expect(learning().getByRole("textbox")).toBe(field); expect(field.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("searchbox")).toBe(search); expect((search as HTMLInputElement).value).toBe("ku");
    expect(f.commandReply).not.toHaveBeenCalled(); f.data.state_version = "11";
    fireEvent.click(settingsHeader().getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(settingsHeader().getByRole("button", { name: "Обновить настройки" }).hasAttribute("disabled")).toBe(false));
    expect((learning().getByRole("textbox") as HTMLInputElement).value).toBe("17");
    expect(f.commandReply).not.toHaveBeenCalled();
  });
  it("opens actual settings once, enabling only implemented destinations", async () => {
    const f = fixture(); render(<App />); await settings();
    expect(f.settingsReply).toHaveBeenCalledOnce(); expect(f.topicsReply).toHaveBeenCalledOnce();
    // M-NAV: the shared panel opens the Dictionary entry point from Settings too.
    expect(screen.getByRole("button", { name: "Словарь" }).hasAttribute("disabled")).toBe(false);
    expect(f.commandReply).not.toHaveBeenCalled(); expect(f.haptic).toHaveBeenCalledOnce();
  });
  it("retains unsent text, topic query and picker node across Today and foreground", async () => {
    const f = fixture(); f.data.settings.material.value = { mode: "topics", topic_ids: [id(8)] };
    render(<App />); await settings();
    const input = group("Новых карточек в группе").getByRole("textbox");
    fireEvent.change(input, { target: { value: "1e2" } });
    const search = screen.getByRole("searchbox"); fireEvent.change(search, { target: { value: "kue" } });
    search.parentElement!.scrollTop = 42;
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText("Активная пара: Украинский ↔ Немецкий");
    expect(screen.queryByRole("group", { name: "Новых карточек в группе" })).toBeNull();
    await settings(); await foreground();
    expect((group("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).value).toBe("1e2");
    expect(screen.getByRole("searchbox")).toBe(search);
    expect((search as HTMLInputElement).value).toBe("kue"); expect(search.parentElement!.scrollTop).toBe(42);
    expect(f.settingsReply).toHaveBeenCalledTimes(3); expect(f.topicsReply).toHaveBeenCalledTimes(3);
    expect(f.commandReply).not.toHaveBeenCalled(); expect(f.haptic).toHaveBeenCalledOnce();
  });
  it("publishes and caches a language only from confirmed current, with one save for double clicks", async () => {
    const f = fixture(), pending = deferred<Response>();
    f.commandReply.mockImplementationOnce(() => pending.promise);
    render(<App />); await settings(); change("Язык интерфейса", "en");
    expect(document.documentElement.lang).toBe("ru"); expect(localStorage.getItem("wortly.uiLanguage")).toBe("ru");
    save("Язык интерфейса"); save("Язык интерфейса");
    await waitFor(() => expect(f.commandReply).toHaveBeenCalledOnce());
    expect(document.documentElement.lang).toBe("ru");
    expectDeadlineHeld(f, "/commands", 0);
    pending.resolve(json(f.apply(f.commandReply.mock.calls[0][0])));
    await screen.findByRole("heading", { name: "Settings", level: 1 });
    await waitFor(() => expect(localStorage.getItem("wortly.uiLanguage")).toBe("en"));
    expect(screen.getByText("Saved")).toBeDefined(); expect(f.haptic).toHaveBeenCalledOnce();
    expect(localStorage.getItem("wortly.pending.setting")).toBeNull();
  });
  it("refreshes the profile before showing Today with the saved dictionary language", async () => {
    const f = fixture(); render(<App />); await settings(); change("Язык словаря", "en"); save("Язык словаря");
    await screen.findByText("Сохранено"); const pending = deferred<Response>();
    f.openReply.mockImplementationOnce(() => pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText("Загружаем план на сегодня");
    expect(f.todayReply).toHaveBeenCalledOnce(); expect(screen.queryByText("Активная пара: Украинский ↔ Немецкий")).toBeNull();
    await waitFor(() => expect(f.openReply).toHaveBeenCalledTimes(2));
    const body = f.openReply.mock.calls[1][0];
    expectDeadlineHeld(f, "/client/open", 1);
    pending.resolve(json({ status: "opened", profile: f.profile, compatibility: { compatible: true, contract_version: "1" },
      ...body, proof_version: "1", document_epoch: "1", session: null }));
    await screen.findByText("Активная пара: Английский ↔ Немецкий");
    expect(f.todayReply).toHaveBeenCalledTimes(2); expect(document.documentElement.lang).toBe("ru");
  });
  it("reconciles a lost reply with status without replaying the command", async () => {
    const f = fixture(); f.commandReply.mockImplementationOnce(async command => { f.apply(command); throw new Error("lost reply"); });
    render(<App />); await settings(); change("Язык словаря", "en"); save("Язык словаря");
    await screen.findAllByText(/Пока не удалось подтвердить сохранение/);
    expect(localStorage.getItem("wortly.pending.setting")).not.toBeNull();
    await refresh(); await screen.findByText("Сохранено");
    expect(f.statusReply).toHaveBeenCalledOnce(); expect(f.commandReply).toHaveBeenCalledOnce();
    expect(localStorage.getItem("wortly.pending.setting")).toBeNull();
  });
  it("recovers a sent intent after a full App remount using GET status only", async () => {
    const f = fixture(); f.commandReply.mockImplementationOnce(async command => { f.apply(command); throw new Error("lost reply"); });
    const mounted = render(<App />); await settings(); change("Язык словаря", "en"); save("Язык словаря");
    await screen.findAllByText(/Пока не удалось подтвердить сохранение/);
    const pending = localStorage.getItem("wortly.pending.setting")!;
    expect(pending).not.toMatch(/synthetic-token|synthetic-proof|document_id|init_data/);
    mounted.unmount(); render(<App />);
    await waitFor(() => expect(localStorage.getItem("wortly.pending.setting")).toBeNull());
    expect(screen.queryByRole("heading", { name: "Настройки", level: 1 })).toBeNull();
    await settings(); await screen.findByText("Сохранено");
    expect(f.commandReply).toHaveBeenCalledOnce(); expect(f.statusReply).toHaveBeenCalledOnce();
    expect(localStorage.getItem("wortly.pending.setting")).toBeNull();
  });
  it("keeps a foreground conflict's input and lets the user choose the stored value", async () => {
    const f = fixture(); render(<App />); await settings();
    fireEvent.change(group("Новых карточек в группе").getByRole("textbox"), { target: { value: "7" } });
    f.data.settings.learning_group_size = { value: 9, version: "2" }; f.data.state_version = f.profile.state_version = "11";
    await foreground(); await screen.findByText("Сохранённое значение изменилось. Твой ввод остался.");
    expect((group("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).value).toBe("7");
    fireEvent.click(group("Новых карточек в группе").getByRole("button", { name: "Принять сохранённое" }));
    expect((group("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).value).toBe("9");
    expect(f.commandReply).not.toHaveBeenCalled();
  });
  it("supports edits and saves inside React StrictMode", async () => {
    const f = fixture(); render(<StrictMode><App /></StrictMode>); await settings();
    change("Язык словаря", "en"); save("Язык словаря"); await screen.findByText("Сохранено");
    expect(f.commandReply).toHaveBeenCalledOnce(); expect(f.haptic).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("revokes the document after a current settings refusal (%s)", async status => {
    const f = fixture(); f.settingsReply.mockImplementationOnce(async () => json({ error: { code: "DENIED" } }, status));
    render(<App />);
    await screen.findByText(status === 401 ? "Закрой приложение и снова нажми кнопку Wortly в боте." : "Не удалось открыть Wortly");
    expect(screen.queryByRole("heading", { name: "Настройки", level: 1 })).toBeNull();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull(); expect(f.commandReply).not.toHaveBeenCalled();
  });
  it("ignores a late catalog refusal from a superseded foreground handle", async () => {
    const f = fixture(), pending = deferred<Response>();
    f.topicsReply.mockImplementationOnce(() => pending.promise);
    render(<App />); await settings(); await foreground();
    await waitFor(() => expect(f.topicsReply).toHaveBeenCalledTimes(2));
    expectDeadlineHeld(f, "/settings/topics", 0);
    await act(async () => { pending.resolve(json({ error: { code: "DENIED" } }, 401)); });
    expect(screen.getByRole("heading", { name: "Настройки", level: 1 })).toBeDefined();
    change("Язык словаря", "en"); save("Язык словаря"); await screen.findByText("Сохранено");
  });
  it("discards memory drafts on a new document epoch", async () => {
    const f = fixture(); render(<App />); await settings();
    fireEvent.change(group("Новых карточек в группе").getByRole("textbox"), { target: { value: "7" } });
    f.state.epoch = "2"; await foreground(); await screen.findByText("Активная пара: Украинский ↔ Немецкий");
    await settings(); expect((group("Новых карточек в группе").getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(f.commandReply).not.toHaveBeenCalled();
  });
  it("does not send when persisting the intent fails", async () => {
    const f = fixture(); render(<App />); await settings();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "wortly.pending.setting") throw new Error("full");
      return original.call(this, key, value);
    });
    change("Язык словаря", "en"); save("Язык словаря");
    await screen.findByText("Не удалось завершить сохранение на этом устройстве. Обнови настройки.");
    expect(f.commandReply).not.toHaveBeenCalled();
  });
  it("reconciles a pending save hidden behind Today after foreground replaces its access", async () => {
    const f = fixture(), pending = deferred<Response>();
    f.commandReply.mockImplementationOnce(() => pending.promise);
    render(<App />); await settings(); change("Язык словаря", "en"); save("Язык словаря");
    await waitFor(() => expect(f.commandReply).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText("Активная пара: Украинский ↔ Немецкий");
    expectDeadlineHeld(f, "/commands", 0);
    await act(async () => { pending.resolve(json(f.apply(f.commandReply.mock.calls[0][0]))); });
    await screen.findByText("Активная пара: Английский ↔ Немецкий");
    expect(f.statusReply).toHaveBeenCalledOnce(); expect(f.commandReply).toHaveBeenCalledOnce();
    expect(localStorage.getItem("wortly.pending.setting")).toBeNull();
  });
  it("joins a pre-save foreground, then opens once more without rolling back the new UI language", async () => {
    const f = fixture(); render(<App />); await settings();
    const delayed = deferred<Response>(), stale = structuredClone(f.profile);
    f.openReply.mockImplementationOnce(() => delayed.promise);
    await foreground(); await waitFor(() => expect(f.openReply).toHaveBeenCalledTimes(2));
    // The second open is held, and so is its transport deadline: only the test decides when it answers.
    const language = () => within(settingsSection("Языки").getByRole("group", { name: "Язык интерфейса" }));
    // From the save on, passively record every <html lang> change and every persisted language write. Mutation records
    // are queued one per change with its old value, so a batched en -> ru -> en is still seen in full.
    const langChanges: MutationRecord[] = [], langObserver = new MutationObserver(records => { langChanges.push(...records); });
    langObserver.observe(document.documentElement, { attributeFilter: ["lang"], attributeOldValue: true });
    onTestFinished(() => langObserver.disconnect());
    const writes = vi.spyOn(Storage.prototype, "setItem");
    fireEvent.change(language().getByRole("combobox"), { target: { value: "en" } });
    fireEvent.click(language().getByRole("button", { name: "Сохранить" }));
    await screen.findByRole("heading", { name: "Settings", level: 1 });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("button", { name: "Today" }));
    await screen.findByText("Loading today's plan");
    expectDeadlineHeld(f, "/client/open", 1);
    await act(async () => { delayed.resolve(json({ status: "opened", profile: stale,
      compatibility: { compatible: true, contract_version: "1" }, ...f.openReply.mock.calls[1][0],
      proof_version: "1", document_epoch: "1", session: null })); });
    await screen.findByText("Active pair: Ukrainian ↔ German");
    expect(document.documentElement.lang).toBe("en"); expect(localStorage.getItem("wortly.uiLanguage")).toBe("en");
    expect(f.openReply).toHaveBeenCalledTimes(3); expect(f.commandReply).toHaveBeenCalledOnce();
    // The language moves from ru to en once and is never shown or stored as ru again, not even transiently.
    langChanges.push(...langObserver.takeRecords());
    const distinct = (values: (string | null)[]) => values.filter((value, i) => i === 0 || value !== values[i - 1]);
    expect(distinct([...langChanges.map(change => change.oldValue), document.documentElement.lang])).toEqual(["ru", "en"]);
    expect(distinct(writes.mock.calls.filter(([key]) => key === "wortly.uiLanguage").map(([, value]) => value))).toEqual(["en"]);
  });
  it("stops after two stale foreground replies, hides the old pair and allows manual retry", async () => {
    const f = fixture(); render(<App />); await settings(); const stale = structuredClone(f.profile);
    change("Язык словаря", "en"); save("Язык словаря"); await screen.findByText("Сохранено");
    const oldReply = async (body: { client_instance_id: string; document_id: string }) => json({ status: "opened", profile: stale,
      compatibility: { compatible: true, contract_version: "1" }, ...body, proof_version: "1", document_epoch: "1", session: null });
    f.openReply.mockImplementationOnce(oldReply).mockImplementationOnce(oldReply);
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText("Не удалось загрузить план");
    expect(f.openReply).toHaveBeenCalledTimes(3); expect(f.todayReply).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Активная пара:/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText("Активная пара: Английский ↔ Немецкий");
    expect(f.openReply).toHaveBeenCalledTimes(4);
  });
  it("allows other settings after a catalog failure and refreshes both reads explicitly", async () => {
    const f = fixture(); f.data.settings.material.value = { mode: "topics", topic_ids: [id(8)] };
    f.topicsReply.mockImplementationOnce(async () => json({ error: { code: "UNAVAILABLE" } }, 503));
    render(<App />); await settings(); await screen.findByText("Не удалось загрузить актуальный список тем");
    change("Язык словаря", "en"); save("Язык словаря"); await screen.findByText("Сохранено");
    await refresh(); await screen.findByRole("searchbox");
    expect(f.settingsReply).toHaveBeenCalledTimes(2); expect(f.topicsReply).toHaveBeenCalledTimes(2);
    expect(f.commandReply).toHaveBeenCalledOnce();
  });
  it("retains query during a failed catalog refresh and retries only topics", async () => {
    const f = fixture(); f.data.settings.material.value = { mode: "topics", topic_ids: [id(8)] };
    render(<App />); await settings(); const search = screen.getByRole("searchbox");
    fireEvent.change(search, { target: { value: "kue" } });
    f.topicsReply.mockImplementationOnce(async () => json({ error: { code: "UNAVAILABLE" } }, 503));
    await refresh(); await screen.findByText("Не удалось загрузить актуальный список тем");
    expect(screen.getByRole("searchbox")).toBe(search);
    fireEvent.click(screen.getByRole("button", { name: "Обновить список тем" }));
    await waitFor(() => expect(screen.queryByText("Не удалось загрузить актуальный список тем")).toBeNull());
    expect((search as HTMLInputElement).value).toBe("kue");
    expect(f.settingsReply).toHaveBeenCalledTimes(2); expect(f.topicsReply).toHaveBeenCalledTimes(3);
  });
  it("keeps a confirmed locale and success when intent cleanup fails, without replay", async () => {
    const f = fixture(); render(<App />); await settings(); const original = Storage.prototype.removeItem;
    const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, key) {
      if (key === "wortly.pending.setting") throw new Error("unavailable"); return original.call(this, key);
    });
    change("Язык интерфейса", "en"); save("Язык интерфейса"); await screen.findByText("Saved");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("wortly.pending.setting")).not.toBeNull();
    expect((group("Dictionary language").getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    remove.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "Refresh settings" }));
    await waitFor(() => expect(localStorage.getItem("wortly.pending.setting")).toBeNull());
    expect(f.commandReply).toHaveBeenCalledOnce();
  });
  it("does not undo a confirmed locale when caching that preference fails", async () => {
    const f = fixture(); render(<App />); await settings(); const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === "wortly.uiLanguage") throw new Error("unavailable"); return original.call(this, key, value);
    });
    change("Язык интерфейса", "en"); save("Язык интерфейса"); await screen.findByText("Saved");
    expect(document.documentElement.lang).toBe("en"); expect(f.commandReply).toHaveBeenCalledOnce();
    expect(localStorage.getItem("wortly.pending.setting")).toBeNull();
  });
  it("keeps an unknown outcome across tabs without silently resending", async () => {
    const f = fixture(); f.commandReply.mockRejectedValueOnce(new Error("request lost"));
    render(<App />); await settings(); change("Язык словаря", "en"); save("Язык словаря");
    await screen.findAllByText(/Пока не удалось подтвердить сохранение/);
    const original = f.commandReply.mock.calls[0][0];
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText("Активная пара: Украинский ↔ Немецкий"); await settings();
    await screen.findByText("Подтверждение сохранения пока не найдено. Можно проверить ещё раз или повторить отправку.");
    expect(f.commandReply).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" })); await screen.findByText("Сохранено");
    expect(f.commandReply).toHaveBeenCalledTimes(2); expect(f.commandReply.mock.calls[1][0]).toEqual(original);
  });
  it("preserves the server resume route when returning from settings", async () => {
    const f = fixture(); render(<App />); await settings();
    f.state.session = { id: id(30), phase: "active" };
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByRole("region", { name: "Итог занятия" });
    expect(screen.queryByRole("heading", { name: "Настройки", level: 1 })).toBeNull();
    expect(f.todayReply).toHaveBeenCalledOnce();
  });
  it("never flashes the written settings refusal while the settings are re-read on return from Settings", async () => {
    const f = fixture(); render(<App />); await settings();
    f.state.session = { id: id(30), phase: "active" };
    const texts: string[] = [];
    const observer = new MutationObserver(() => { texts.push(document.body.textContent ?? ""); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    onTestFinished(() => observer.disconnect());
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByRole("region", { name: "Итог занятия" }, { timeout: 4000 });
    observer.disconnect();
    expect(texts.length).toBeGreaterThan(0);
    // Positive control: the refusal text is the one the written host really renders (see useWrittenHost.test.tsx).
    expect(settingsRefusalText).toContain("подтвердить настройки");
    expect(texts.filter(text => text.includes(settingsRefusalText))).toEqual([]);
  });

  it("shows a loading status, not the refusal, while the owner reads the resumed session", async () => {
    const f = fixture(); render(<App />); await settings();
    f.state.session = { id: id(30), phase: "active" };
    const gate = deferred<void>();
    sessionReads = 0;
    sessionHook = async n => { if (n >= 2) await gate.promise; };
    onTestFinished(() => { sessionHook = null; gate.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await waitFor(() => expect(sessionReads).toBeGreaterThanOrEqual(2));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(document.body.textContent).not.toContain(settingsRefusalText);
    expect(document.body.textContent).toContain("Загружаем занятие…");
    gate.resolve();
    await screen.findByRole("region", { name: "Итог занятия" }, { timeout: 4000 });
  });
});
