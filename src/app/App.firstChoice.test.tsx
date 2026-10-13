// The first choice of the dictionary language in the actual App document (19.2-А, 19.3-А, texts 25.1/27.1/28.1-А,
// navigation 29.1-А): it stands in front of Today until a Settings read proves the language chosen.
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { OpenedClient, Profile, SavedCommandFact, SettingCommand, SettingsResponse, TodayResponse } from "../api/generated";
import { cardIdOf, cardView } from "../dictionary/card/cardTestData.test-support";
import type { Language } from "../i18n/language";
import { settingsSlotOf } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { launch, serveLaunchCard } from "./launchCard.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const profileId = id(1);
/** The unresolved save of this profile lives in its own slot (R3-02); the legacy global key is only read. */
const settingSlot = settingsSlotOf(profileId);
const CARD = cardIdOf(3);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const exchange = { timeout: 5000 };
const pairNames: Record<Language, string> = { uk: "Украинский", en: "Английский", ru: "Русский" };
const todayPair = (language: Language) => `Активная пара: ${pairNames[language]} ↔ Немецкий`;

/** One synthetic server: entry, Settings (the field versions as the core keeps them) and Today of the current pair. */
function fixture(options: { version?: string; ui?: Language; dictionary?: Language } = {}) {
  const data = settingsResponse(); data.state_version = "10"; data.needs_setup = false;
  for (const field of Object.values(data.settings)) field.version = "1";
  data.settings.ui_language.value = options.ui ?? "ru";
  data.settings.dictionary_language = { value: options.dictionary ?? options.ui ?? "uk", version: options.version ?? "1" };
  const profile: Profile = { profile_id: profileId, access: { status: "admitted", version: "1", reason: null }, role: "user",
    ui_language: data.settings.ui_language.value, dictionary_language: data.settings.dictionary_language.value, time_zone: "UTC",
    state_version: "10" };
  const facts = new Map<string, SavedCommandFact>();
  const state = { session: null as OpenedClient["session"] };
  const back = new Set<() => void>();
  const projection = () => { const { state_version: _, ...rest } = structuredClone(data); return rest; };
  const narrow = () => {
    const field = data.settings.dictionary_language;
    data.constraints.dictionary_language = { type: "enum", values: BigInt(field.version) > 1n ? [field.value] : ["ru", "uk", "en"] };
  };
  narrow();
  /** As the core: a known command id gets its fact; a stale field version gets VERSION_CONFLICT and changes nothing. */
  const apply = (command: SettingCommand): Response => {
    const known = facts.get(command.command_id);
    if (known) return json({ command: { ...known, status: "already_applied" }, current: projection(), state_version: data.state_version });
    const setting = data.settings[command.payload.key as keyof SettingsResponse["settings"]];
    if (setting.version !== command.expected_field_version) return json({ command: { id: command.command_id, status: "rejected" },
      error: { code: "VERSION_CONFLICT" }, current: projection(), state_version: data.state_version }, 409);
    Object.assign(setting, { value: structuredClone(command.payload.value), version: String(BigInt(setting.version) + 1n) });
    narrow();
    data.state_version = String(BigInt(data.state_version) + 1n);
    Object.assign(profile, { state_version: data.state_version, ui_language: data.settings.ui_language.value,
      dictionary_language: data.settings.dictionary_language.value });
    const fact: SavedCommandFact = { id: command.command_id, kind: "setting.save", status: "applied",
      applied_at: "2026-10-09T00:00:00Z", target_id: profileId, action_id: null, result_id: null, context_id: null,
      object_version: setting.version };
    facts.set(fact.id, fact);
    return json({ command: fact, current: projection(), state_version: data.state_version });
  };
  const settingsReply = vi.fn(async () => json(data));
  const commandReply = vi.fn(async (command: SettingCommand) => apply(command));
  const statusReply = vi.fn(async (commandId: string) => json(facts.has(commandId)
    ? { command: { ...facts.get(commandId)!, status: "already_applied" }, current: projection(), state_version: data.state_version }
    : { command: { id: commandId, status: "not_found" }, current: profile, state_version: profile.state_version }));
  const openReply = vi.fn(async (body: { client_instance_id: string; document_id: string }) => json({ status: "opened",
    profile: structuredClone(profile), compatibility: { compatible: true, contract_version: "1" }, client_instance_id: body.client_instance_id,
    document_id: body.document_id, proof_version: "1", document_epoch: "1", session: state.session }));
  const todayReply = vi.fn(async () => json({ state_version: profile.state_version, pair: `${profile.dictionary_language}-de`,
    local_date: "2026-10-09", status: "no_material", base: { total: 0, words: 0, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "no_material", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null } satisfies TodayResponse));
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "synthetic-token", expires_at: "2026-10-10T00:00:00Z",
      profile, compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) return json({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return openReply(body);
    if (path.endsWith("/today")) return todayReply();
    if (path.endsWith("/settings/topics")) return json({ topics: [], state_version: data.state_version });
    if (path.endsWith("/settings")) return settingsReply();
    if (path.endsWith("/commands") && body?.kind === "setting.save") return commandReply(body);
    if (path.includes("/commands/")) return statusReply(path.split("/").at(-1)!);
    return json({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: options.ui ?? "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() },
    BackButton: { show() {}, hide() {}, onClick: (handler: () => void) => { back.add(handler); }, offClick: (handler: () => void) => { back.delete(handler); } } } });
  const paths = () => fetcher.mock.calls.map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`);
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))
    .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, any>);
  return { data, profile, state, back, apply, settingsReply, commandReply, statusReply, openReply, todayReply, fetcher, paths, posts,
    /** Another window confirmed this language meanwhile (the same command the core would apply). */
    chooseElsewhere(value: Language) { apply({ command_id: id(900), kind: "setting.save", expected_field_version: "1",
      payload: { key: "dictionary_language", value } } as SettingCommand); },
    pressBack: () => act(async () => { for (const handler of [...back]) handler(); }) };
}
type Server = ReturnType<typeof fixture>;

/** The choice screen, found by its heading; the radios are enabled once the Settings read is confirmed. */
async function choiceScreen(title = "Язык словаря") {
  const heading = await screen.findByRole("heading", { level: 1, name: title }, exchange);
  const page = within(heading.closest("main")!);
  await waitFor(() => expect(page.getAllByRole("radio").some(radio => !(radio as HTMLInputElement).disabled)).toBe(true), exchange);
  return page;
}
async function choose(pair: string, proceed = "Продолжить") {
  const page = await choiceScreen();
  fireEvent.click(page.getByRole("radio", { name: pair }));
  fireEvent.click(page.getByRole("button", { name: proceed }));
}
const languageSaves = (f: Server) => f.posts().filter(post => post.kind === "setting.save");
/** Every text the document showed, captured on each DOM change. */
function recordTexts() {
  const texts: string[] = [];
  const observer = new MutationObserver(() => { texts.push(document.body.textContent ?? ""); });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  onTestFinished(() => observer.disconnect());
  return texts;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/"); });

describe("the first choice of the dictionary language in the actual App", () => {
  it("a first entry without a session shows the choice instead of Today: no sections, no Back, nothing sent", async () => {
    const f = fixture();
    render(<App />);
    const page = await choiceScreen();
    expect(page.getByText("На каком языке показывать переводы слов?")).toBeTruthy();
    expect(page.getByText("После подтверждения язык словаря пока нельзя изменить")).toBeTruthy();
    // И02: the pair names in this order; the proposed language (the interface language, И03) is marked.
    expect(page.getAllByRole("radio").map(radio => radio.closest("label")!.textContent))
      .toEqual(["Немецко-украинский", "Немецко-английский", "Немецко-русский"]);
    expect((page.getByRole("radio", { name: "Немецко-украинский" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    expect(screen.queryByText(/Активная пара/)).toBeNull();
    expect(f.back.size).toBe(0);
    expect(f.posts()).toEqual([]);
  });

  it("confirming the proposed language saves it once with field version 1 and opens Today", async () => {
    const f = fixture();
    render(<App />); await choose("Немецко-украинский");
    await screen.findByText(todayPair("uk"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1);
    expect(languageSaves(f)[0]).toMatchObject({ kind: "setting.save", expected_field_version: "1",
      payload: { key: "dictionary_language", value: "uk" } });
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Основная навигация" })).toBeTruthy();
    expect(f.back.size).toBe(0);
  });

  it("confirming another language goes through the pair change: Today shows only the new pair", async () => {
    const f = fixture(); const texts = recordTexts();
    render(<App />); await choose("Немецко-английский");
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1);
    expect(languageSaves(f)[0]).toMatchObject({ expected_field_version: "1", payload: { key: "dictionary_language", value: "en" } });
    // The document waited for an open that carries the new pair before it showed Today.
    expect(f.openReply).toHaveBeenCalledTimes(2);
    expect(texts.filter(text => text.includes(todayPair("uk")))).toEqual([]);
    expect(texts.some(text => text.includes(todayPair("en")))).toBe(true);
  });

  it("works inside React StrictMode", async () => {
    const f = fixture();
    render(<StrictMode><App /></StrictMode>); await choose("Немецко-английский");
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1);
  });

  it("a profile whose language is already chosen (version 2) never sees the choice", async () => {
    const f = fixture({ version: "2" }); const texts = recordTexts();
    render(<App />); await screen.findByText(todayPair("uk"), undefined, exchange);
    expect(texts.filter(text => text.includes("На каком языке показывать переводы слов?"))).toEqual([]);
    expect(f.posts()).toEqual([]);
  });

  it.each([
    ["uk", "Мова словника", "Якою мовою показувати переклади слів?", "Продовжити",
      "Після підтвердження мову словника поки не можна змінити", ["Німецько-український", "Німецько-англійський", "Німецько-російський"]],
    ["en", "Dictionary language", "Which language should word translations be shown in?", "Continue",
      "After you confirm, the dictionary language can't be changed for now", ["German–Ukrainian", "German–English", "German–Russian"]],
  ] as const)("(%s) shows the approved texts and pair names", async (ui, title, question, proceed, footnote, pairs) => {
    fixture({ ui, dictionary: ui });
    render(<App />);
    const page = await choiceScreen(title);
    expect(page.getByText(question)).toBeTruthy(); expect(page.getByText(footnote)).toBeTruthy();
    expect(page.getByRole("button", { name: proceed })).toBeTruthy();
    expect(page.getAllByRole("radio").map(radio => radio.closest("label")!.textContent)).toEqual([...pairs]);
  });
});

describe("the first choice when the Settings read is unknown", () => {
  it("a held Settings read shows the existing Today loading state, never the choice nor Today", async () => {
    const f = fixture(), held = deferred<Response>();
    f.settingsReply.mockImplementationOnce(() => held.promise);
    render(<App />);
    await screen.findByText("Загружаем план на сегодня", undefined, exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
    expect(screen.queryByText(/Активная пара/)).toBeNull();
    await act(async () => { held.resolve(json(f.data)); });
    await choiceScreen();
  });

  it("a failed Settings read shows the existing failure with retry; the retry reads Settings again and shows the choice", async () => {
    const f = fixture();
    f.settingsReply.mockImplementationOnce(async () => json({ error: { code: "UNAVAILABLE" } }, 503));
    render(<App />);
    await screen.findByText("Не удалось загрузить план", undefined, exchange);
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await choiceScreen();
    expect(f.settingsReply).toHaveBeenCalledTimes(2);
  });
});

describe("an unresolved or conflicting first choice", () => {
  it("an unknown outcome stays on the screen and is retried under the same command id, never as a new one", async () => {
    const f = fixture();
    f.commandReply.mockImplementationOnce(async () => { throw new TypeError("network"); });
    render(<App />); await choose("Немецко-английский");
    await screen.findByText("Пока не удалось подтвердить сохранение. Проверь состояние или повтори отправку.", undefined, exchange);
    expect(localStorage.getItem(settingSlot)).not.toBeNull();
    const page = within(screen.getByRole("main"));
    expect(page.getAllByRole("radio").every(radio => (radio as HTMLInputElement).disabled)).toBe(true);
    expect((page.getByRole("radio", { name: "Немецко-английский" }) as HTMLInputElement).checked).toBe(true);
    expect(page.getByRole("button", { name: "Продолжить" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(page.getByRole("button", { name: "Повторить отправку" }));
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(2);
    expect(languageSaves(f)[1]).toEqual(languageSaves(f)[0]);
    expect(localStorage.getItem(settingSlot)).toBeNull();
  });

  it("a lost reply is checked by status from the screen without sending again", async () => {
    const f = fixture();
    f.commandReply.mockImplementationOnce(async command => { f.apply(command); throw new TypeError("lost reply"); });
    render(<App />); await choose("Немецко-английский");
    await screen.findByText("Пока не удалось подтвердить сохранение. Проверь состояние или повтори отправку.", undefined, exchange);
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(f.statusReply).toHaveBeenCalledOnce(); expect(languageSaves(f)).toHaveLength(1);
  });

  it("a sent choice recovers after a full remount by status only and the screen is not shown again", async () => {
    const f = fixture();
    f.commandReply.mockImplementationOnce(async command => { f.apply(command); throw new TypeError("lost reply"); });
    const mounted = render(<App />); await choose("Немецко-английский");
    await screen.findByText("Пока не удалось подтвердить сохранение. Проверь состояние или повтори отправку.", undefined, exchange);
    expect(localStorage.getItem(settingSlot)).not.toMatch(/synthetic-token|synthetic-proof|document_id|init_data/);
    mounted.unmount(); const texts = recordTexts(); render(<App />);
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1); expect(f.statusReply).toHaveBeenCalledOnce();
    expect(localStorage.getItem(settingSlot)).toBeNull();
    expect(texts.filter(text => text.includes("На каком языке показывать переводы слов?"))).toEqual([]);
  });

  it("an intent that cannot be stored is not sent; the screen says so and offers its check", async () => {
    const f = fixture(); const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (key === settingSlot) throw new Error("full");
      return original.call(this, key, value);
    });
    render(<App />); await choose("Немецко-английский");
    await screen.findByText("Не удалось завершить сохранение на этом устройстве. Обнови настройки.", undefined, exchange);
    expect(languageSaves(f)).toEqual([]);
    expect(screen.getByRole("button", { name: "Обновить настройки" })).toBeTruthy();
  });

  it("VERSION_CONFLICT keeps the other window's choice: the screen names it, sends nothing more and leaves to its Today", async () => {
    const f = fixture();
    render(<App />); await choiceScreen();
    f.chooseElsewhere("ru");
    await choose("Немецко-английский");
    await screen.findByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-русский.", undefined, exchange);
    const page = within(screen.getByRole("main"));
    expect(page.getAllByRole("radio").every(radio => (radio as HTMLInputElement).disabled)).toBe(true);
    expect((page.getByRole("radio", { name: "Немецко-русский" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("button", { name: "Сохранить моё значение" })).toBeNull();
    expect(languageSaves(f)).toHaveLength(1);
    fireEvent.click(page.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(todayPair("ru"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1); expect(f.data.settings.dictionary_language).toEqual({ value: "ru", version: "2" });
  });

  it("a choice made elsewhere and seen on a foreground re-read is named the same way, with nothing sent", async () => {
    const f = fixture();
    render(<App />); await choiceScreen();
    f.chooseElsewhere("en");
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await screen.findByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-английский.", undefined, exchange);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(f.posts()).toEqual([]);
  });
});

describe("the bot's card button before the first choice (29.1-А)", () => {
  function cardServer() {
    launch(`?card=${CARD}`);
    const f = fixture();
    // The core answers the card in its current pair; a read made before the document shows that pair fails on the client.
    return { ...f, ...serveLaunchCard(f.fetcher, CARD, { learning: true,
      view: cardId => cardView(cardId, `${f.profile.dictionary_language}-de`) }) };
  }
  const cardKinds = (f: Server) => f.posts().map(post => post.kind).filter(kind => kind !== "setting.save");

  it("shows the choice first, reads and writes nothing of the card; after the choice it opens the card, and Back leads to Today", async () => {
    const f = cardServer();
    render(<App />); await choiceScreen();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(f.views()).toEqual([]); expect(cardKinds(f)).toEqual([]);
    expect(f.paths().filter(path => path.includes("/dictionary/") || path.includes("/learning/"))).toEqual([]);
    await choose("Немецко-английский");
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(f.views()).toEqual([`/api/v1/dictionary/cards/${CARD}/view`]); expect(f.origins()).toEqual(["?origin=message"]);
    // The card was read only after the document opened with the chosen pair.
    const calls = f.paths(), opens = calls.flatMap((path, at) => path.endsWith("/client/open") ? [at] : []);
    expect(opens).toHaveLength(2);
    expect(calls.findIndex(path => path.endsWith("/view"))).toBeGreaterThan(opens[1]);
    await waitFor(() => expect(cardKinds(f)).toEqual(["context.open"]));
    await f.pressBack();
    await screen.findByText(todayPair("en"), undefined, exchange);
    await waitFor(() => expect(cardKinds(f)).toEqual(["context.open", "context.close"]));
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
  });

  it("a late open after the choice keeps the card closed until the document shows the chosen pair", async () => {
    const f = cardServer(); const held = deferred<void>();
    render(<App />); await choiceScreen();
    const base = f.openReply.getMockImplementation()!;
    f.openReply.mockImplementationOnce(async body => { await held.promise; return base(body); });
    await choose("Немецко-английский");
    await waitFor(() => expect(f.openReply).toHaveBeenCalledTimes(2), exchange);
    await screen.findByText("Загружаем план на сегодня", undefined, exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(f.views()).toEqual([]); expect(cardKinds(f)).toEqual([]);
    await act(async () => { held.resolve(); });
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(f.views()).toHaveLength(1);
  });

  it("an unknown outcome of the choice keeps the card closed; the retry with the same command opens it", async () => {
    const f = cardServer();
    f.commandReply.mockImplementationOnce(async () => { throw new TypeError("network"); });
    render(<App />); await choose("Немецко-украинский");
    await screen.findByText("Пока не удалось подтвердить сохранение. Проверь состояние или повтори отправку.", undefined, exchange);
    expect(f.views()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(languageSaves(f)).toHaveLength(2); expect(languageSaves(f)[1]).toEqual(languageSaves(f)[0]);
  });

  it("a profile with the language chosen opens the card over Today as before (S01)", async () => {
    launch(`?card=${CARD}`);
    const f = fixture({ version: "2" });
    const card = serveLaunchCard(f.fetcher, CARD, { learning: true, view: cardId => cardView(cardId, "uk-de") });
    const texts = recordTexts();
    render(<App />); await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(card.views()).toHaveLength(1);
    expect(texts.filter(text => text.includes("На каком языке показывать переводы слов?"))).toEqual([]);
    await f.pressBack(); await screen.findByText(todayPair("uk"), undefined, exchange);
  });
});

// Probes of the independent QA (QA-FIRST-CHOICE), kept as permanent tests with assertions in place of its notes.
const approved = {
  ru: { title: "Язык словаря", question: "На каком языке показывать переводы слов?", proceed: "Продолжить",
    footnote: "После подтверждения язык словаря пока нельзя изменить", pairs: ["Немецко-украинский", "Немецко-английский", "Немецко-русский"] },
  uk: { title: "Мова словника", question: "Якою мовою показувати переклади слів?", proceed: "Продовжити",
    footnote: "Після підтвердження мову словника поки не можна змінити", pairs: ["Німецько-український", "Німецько-англійський", "Німецько-російський"] },
  en: { title: "Dictionary language", question: "Which language should word translations be shown in?", proceed: "Continue",
    footnote: "After you confirm, the dictionary language can't be changed for now", pairs: ["German–Ukrainian", "German–English", "German–Russian"] },
} as const;
const pendingText = "Пока не удалось подтвердить сохранение. Проверь состояние или повтори отправку.";
const pause = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

describe("QA: texts, order and flags of the first choice", () => {
  it.each(["ru", "uk", "en"] as const)("(%s) every string of the screen equals the approved text; flags follow И02", async ui => {
    fixture({ ui, dictionary: ui }); render(<App />);
    const a = approved[ui];
    const page = await choiceScreen(a.title);
    const main = page.getByRole("radiogroup").closest("main")!;
    // The whole text of the screen, in order, no other strings (no hidden extras).
    expect(Array.from(main.querySelectorAll("h1, p, label, button")).map(node => node.textContent))
      .toEqual([a.title, a.question, ...a.pairs, a.proceed, a.footnote]);
    const rows = page.getAllByRole("radio").map(radio => radio.closest("label")!);
    const flags = rows.map(row => Array.from(row.querySelectorAll("svg")).map(svg => svg.getAttribute("viewBox")));
    // DE (5x3) first in every row; UA (3x2) after the text of the first row, GB (60x30) of the second, none for ru.
    expect(flags).toEqual([["0 0 5 3", "0 0 3 2"], ["0 0 5 3", "0 0 60 30"], ["0 0 5 3"]]);
    expect(Array.from(rows[0].children).map(child => child.tagName.toLowerCase())).toEqual(["input", "svg", "span", "svg"]);
    expect(Array.from(rows[2].children).map(child => child.tagName.toLowerCase())).toEqual(["input", "svg", "span"]);
    expect(main.getAttribute("lang")).toBe(ui);
  });
});

describe("QA: gate when Settings are not confirmed", () => {
  it("Settings below the document floor: failure with retry, not Today nor the choice; retry then shows the choice", async () => {
    const f = fixture(); const stale = structuredClone(f.data); stale.state_version = "5";
    f.settingsReply.mockImplementationOnce(async () => json(stale));
    render(<App />);
    await screen.findByText("Не удалось загрузить план", undefined, exchange);
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
    expect(screen.queryByText(/Активная пара/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await choiceScreen();
  });

  it("Settings always failing: the frame never shows Today or the choice and nothing is sent", async () => {
    const f = fixture(); f.settingsReply.mockImplementation(async () => json({ error: { code: "UNAVAILABLE" } }, 503));
    render(<App />);
    await screen.findByText("Не удалось загрузить план", undefined, exchange);
    for (let n = 0; n < 2; n++) {
      fireEvent.click(screen.getByRole("button", { name: "Повторить" })); await pause(50);
      await screen.findByText("Не удалось загрузить план", undefined, exchange);
    }
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
    expect(screen.queryByText(/Активная пара/)).toBeNull();
    expect(f.posts()).toEqual([]); expect(f.back.size).toBe(0);
  });

  it("a chosen profile whose Settings read fails also gets the failed frame (availability cost of the gate)", async () => {
    const f = fixture({ version: "2" }); f.settingsReply.mockImplementation(async () => json({ error: { code: "UNAVAILABLE" } }, 503));
    render(<App />);
    await screen.findByText("Не удалось загрузить план", undefined, exchange);
    expect(screen.queryByText(/Активная пара/)).toBeNull();
    f.settingsReply.mockImplementation(async () => json(f.data));
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText(todayPair("uk"), undefined, exchange);
  });

  /**
   * F1 (QA-FIRST-CHOICE): a save of another field left unresolved while the language is still at version 1 — from an
   * earlier build, or from Settings opened during an older session (D1-T2) — is the one intent of the document. It
   * stays the user's own unknown outcome under its old command: the gate never resends, clears or replaces it.
   */
  async function unresolvedOtherSave(f: Server, reply: (command: SettingCommand) => Promise<Response>) {
    // Stored by a document where the field was editable; the language is then served at version 1 again.
    const version = f.data.settings.dictionary_language.version;
    f.data.settings.dictionary_language.version = "2";
    f.commandReply.mockImplementationOnce(reply);
    const mounted = render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }, exchange));
    const size = await screen.findByRole("group", { name: "Новых карточек в группе" }, exchange);
    await waitFor(() => expect((within(size).getByRole("textbox") as HTMLInputElement).disabled).toBe(false), exchange);
    fireEvent.change(within(size).getByRole("textbox"), { target: { value: "7" } });
    fireEvent.click(within(size).getByRole("button", { name: "Сохранить" }));
    await screen.findAllByText(/Пока не удалось подтвердить сохранение/, undefined, exchange);
    const stored = localStorage.getItem(settingSlot)!;
    expect(stored).toContain("learning_group_size");
    mounted.unmount();
    f.data.settings.dictionary_language.version = version;
    f.data.constraints.dictionary_language = { type: "enum", values: ["ru", "uk", "en"] };
    return stored;
  }

  it("F1: an applied save of another field whose reply was lost is resolved by the status check, then the choice is shown", async () => {
    const f = fixture();
    const stored = await unresolvedOtherSave(f, async command => { f.apply(command); throw new TypeError("lost reply"); });
    const texts = recordTexts();
    // The opening read checks the stored intent's status: its fact settles it, and the choice follows.
    render(<App />);
    await choiceScreen();
    expect(f.statusReply).toHaveBeenCalledOnce();
    expect(texts.filter(text => text.includes(todayPair("uk")))).toEqual([]);
    expect(f.posts()).toHaveLength(1); expect(JSON.parse(stored).intent.command_id).toBe(f.posts()[0].command_id);
    expect(f.data.settings.learning_group_size.value).toBe(7);
    expect(localStorage.getItem(settingSlot)).toBeNull();
    await choose("Немецко-английский");
    await screen.findByText(todayPair("en"), undefined, exchange);
  });

  it("F1 boundary: a never-applied save of another field keeps its old command and is neither resent nor cleared by the gate", async () => {
    const f = fixture();
    const stored = await unresolvedOtherSave(f, async () => { throw new TypeError("network"); });
    render(<App />);
    await screen.findByText("Не удалось загрузить план", undefined, exchange);
    for (let n = 0; n < 2; n++) {
      fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
      await waitFor(() => expect(f.statusReply).toHaveBeenCalledTimes(2 + n), exchange);
      await screen.findByText("Не удалось загрузить план", undefined, exchange);
    }
    // Only its status is read; the open question of resending it from here is the owner's (C211).
    expect(f.posts()).toHaveLength(1);
    expect(localStorage.getItem(settingSlot)).toBe(stored);
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
    expect(screen.queryByText(/Активная пара/)).toBeNull();
  });
});

describe("QA: confirmation paths", () => {
  it("double click on «Продолжить» sends one save", async () => {
    const f = fixture(); render(<App />);
    const page = await choiceScreen();
    fireEvent.click(page.getByRole("radio", { name: "Немецко-английский" }));
    const button = page.getByRole("button", { name: "Продолжить" });
    fireEvent.click(button); fireEvent.click(button); fireEvent.click(button);
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1);
  });

  it("unknown outcome, another window chooses meanwhile, retry gets VERSION_CONFLICT: named current pair, no overwrite", async () => {
    const f = fixture();
    f.commandReply.mockImplementationOnce(async () => { throw new TypeError("network"); });
    render(<App />); await choose("Немецко-английский");
    await screen.findByText(pendingText, undefined, exchange);
    f.chooseElsewhere("ru");
    fireEvent.click(screen.getByRole("button", { name: "Повторить отправку" }));
    await screen.findByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-русский.", undefined, exchange);
    expect(f.data.settings.dictionary_language).toEqual({ value: "ru", version: "2" });
    expect(screen.queryByRole("button", { name: "Сохранить моё значение" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    expect(f.back.size).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(todayPair("ru"), undefined, exchange);
    expect(localStorage.getItem(settingSlot)).toBeNull();
  });

  it("unknown outcome, another window chose, refresh (status) instead of retry: the screen names the current pair", async () => {
    const f = fixture();
    f.commandReply.mockImplementationOnce(async () => { throw new TypeError("network"); });
    render(<App />); await choose("Немецко-английский");
    await screen.findByText(pendingText, undefined, exchange);
    f.chooseElsewhere("ru");
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await screen.findByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-русский.", undefined, exchange);
    expect(f.data.settings.dictionary_language).toEqual({ value: "ru", version: "2" });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(todayPair("ru"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1);
  });

  it("the core answers DICTIONARY_LANGUAGE_LOCKED to the first choice (core variant): the current pair is named, no dead end", async () => {
    const f = fixture();
    render(<App />); await choiceScreen();
    f.chooseElsewhere("ru");
    f.commandReply.mockImplementationOnce(async command => { const { state_version: _, ...rest } = structuredClone(f.data);
      return json({ command: { id: command.command_id, status: "rejected" }, error: { code: "DICTIONARY_LANGUAGE_LOCKED" },
        current: rest, state_version: f.data.state_version }, 409); });
    await choose("Немецко-английский");
    await screen.findByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-русский.", undefined, exchange);
    const page = within(screen.getByRole("main"));
    expect((page.getByRole("radio", { name: "Немецко-русский" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(page.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(todayPair("ru"), undefined, exchange);
    expect(f.data.settings.dictionary_language).toEqual({ value: "ru", version: "2" });
  });
});

describe("QA: foreground while the choice is open", () => {
  it("F3: a picked but unsent radio survives a foreground re-read and is the one sent", async () => {
    const f = fixture(); render(<App />);
    const page = await choiceScreen();
    fireEvent.click(page.getByRole("radio", { name: "Немецко-английский" }));
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await pause(300);
    const after = await choiceScreen();
    expect(after.getAllByRole("radio").map(radio => `${(radio as HTMLInputElement).value}:${(radio as HTMLInputElement).checked}`))
      .toEqual(["uk:false", "en:true", "ru:false"]);
    expect(f.openReply.mock.calls.length).toBeGreaterThanOrEqual(2);
    fireEvent.click(after.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(todayPair("en"), undefined, exchange);
    expect(languageSaves(f)).toHaveLength(1); expect(languageSaves(f)[0].payload.value).toBe("en");
  });
});

describe("QA: card entry", () => {
  function cardServer() {
    launch(`?card=${CARD}`);
    const f = fixture();
    return { ...f, ...serveLaunchCard(f.fetcher, CARD, { learning: true,
      view: cardId => cardView(cardId, `${f.profile.dictionary_language}-de`) }) };
  }
  const cardKinds = (f: Server) => f.posts().map(post => post.kind).filter(kind => kind !== "setting.save");

  it("closing before the choice keeps the address with ?card and sends no card traffic", async () => {
    const f = cardServer();
    const mounted = render(<App />); await choiceScreen();
    mounted.unmount();
    expect(window.location.search).toBe(`?card=${CARD}`);
    expect(f.views()).toEqual([]); expect(cardKinds(f)).toEqual([]);
    // A reopen of the same address asks again.
    render(<App />); await choiceScreen();
    expect(f.views()).toEqual([]);
  });

  it("same language: the card is read only after the second open; Back leads to Today", async () => {
    const f = cardServer();
    render(<App />); await choose("Немецко-украинский");
    await screen.findByText("В очереди на изучение", undefined, exchange);
    const calls = f.paths(), opens = calls.flatMap((path, at) => path.endsWith("/client/open") ? [at] : []);
    expect(opens).toHaveLength(2); expect(calls.findIndex(path => path.endsWith("/view"))).toBeGreaterThan(opens[1]);
    await f.pressBack(); await screen.findByText(todayPair("uk"), undefined, exchange);
    expect(window.location.search).toBe("");
  });

  it("F2: a choice made elsewhere (settled screen) holds the card until «Продолжить»; then it opens under the new pair", async () => {
    const f = cardServer();
    render(<App />); await choiceScreen();
    f.chooseElsewhere("en");
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await screen.findByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-английский.", undefined, exchange);
    await pause(200);
    expect(f.views()).toEqual([]); expect(cardKinds(f)).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByText("В очереди на изучение", undefined, exchange);
    const calls = f.paths(), opens = calls.flatMap((path, at) => path.endsWith("/client/open") ? [at] : []);
    expect(calls.findIndex(path => path.endsWith("/view"))).toBeGreaterThan(opens[opens.length - 1]);
    await f.pressBack(); await screen.findByText(todayPair("en"), undefined, exchange);
  });

  it("Back is never bound while the choice, the unknown outcome and the settled screen are shown", async () => {
    const f = cardServer();
    f.commandReply.mockImplementationOnce(async () => { throw new TypeError("network"); });
    render(<App />); await choose("Немецко-английский");
    await screen.findByText(pendingText, undefined, exchange);
    expect(f.back.size).toBe(0);
    f.chooseElsewhere("ru");
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(document.body.textContent).toContain("уже подтверждён"), exchange);
    expect(f.back.size).toBe(0);
  });
});

describe("QA r2: leaving the settled screen", () => {
  it("F8: VERSION_CONFLICT -> «Продолжить» -> Settings: the field is read-only and shows no leftover refusal line", async () => {
    const f = fixture(); render(<App />); await choiceScreen();
    f.chooseElsewhere("ru");
    await choose("Немецко-английский");
    await screen.findByText("Язык словаря уже подтверждён. Сейчас выбрано: Немецко-русский.", undefined, exchange);
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(todayPair("ru"), undefined, exchange);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    const field = within(await screen.findByRole("group", { name: "Язык словаря" }, exchange));
    expect(field.queryByRole("combobox")).toBeNull();
    expect(field.queryByText(/уже подтверждён/)).toBeNull();
    expect(field.queryByText("Изменение не принято: язык словаря пока нельзя изменить.")).toBeNull();
    expect(field.getByText("Язык словаря пока нельзя изменить.")).toBeTruthy();
    expect(languageSaves(f)).toHaveLength(1);
  });
});
