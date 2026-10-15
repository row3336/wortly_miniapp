import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse, TodayResponse } from "../api/generated";
import { learningViewFixture } from "../learning/learningView.test-support";
import { accepted, current, deferred, id, original, pending, primaryKey, profile, response, missing, stop, stopKey } from "../learning/learningFixtures.test-support";
import { SettingsPendingStore, settingsSlotOf } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { settingsResetSlotOf } from "../settings/settingsResetPending";
import { SettingsHost } from "../settings/SettingsHost";
import { useSettingsDocument } from "../settings/useSettingsDocument";
import type { LearningCommandIntent } from "../learning/learningCommandIntent";
import { watchCommits } from "./flashWatch.test-support";
import { LearningHost, type LearningHostProps } from "./LearningHost";
import { testGate } from "../commands/testGate.test-support";

const fixtures: ReturnType<typeof learningViewFixture>[] = [];
afterEach(() => {
  cleanup();
  for (const f of fixtures.splice(0)) { f.view.dispose(); f.owner.dispose(); }
  vi.useRealTimers(); vi.restoreAllMocks();
});
function settingsData(): SettingsResponse {
  const data = settingsResponse();
  data.state_version = "1"; data.needs_setup = false;
  data.settings.dictionary_language.value = "ru"; data.settings.transition_mode.value = "normal";
  return data;
}
function today(status: TodayResponse["learning"]["status"] = "new_group"): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status, ready: 0, preview: 0, next_due_at: status === "waiting" ? "2026-10-01T00:00:00Z" : null,
      new_group_size: status === "new_group" ? 4 : 0, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
type Route = LearningHostProps["route"];
function setup(options: { initialSessionId?: string | null; route?: Route; confirmed?: boolean; status?: TodayResponse["learning"]["status"];
  deferredNavigation?: boolean; pendingSave?: boolean; language?: "ru" | "uk" | "en";
  /** A sent settings reset of this client whose status check waits for the promise, then fails (the outcome stays unknown). */
  pendingReset?: Promise<void>; fixture?: ReturnType<typeof learningViewFixture>; saved?: { primary?: LearningCommandIntent; stop?: LearningCommandIntent } } = {}) {
  const seed = options.initialSessionId === undefined ? null : options.initialSessionId;
  const f = options.fixture ?? learningViewFixture("normal", seed); fixtures.push(f); f.view.dispose(); f.owner.dispose();
  if (options.saved?.primary) f.values.set(primaryKey, JSON.stringify(pending(options.saved.primary)));
  if (options.saved?.stop) f.values.set(stopKey, JSON.stringify(pending(options.saved.stop)));
  // A setting save sent earlier whose outcome is unknown: its status read fails, so it stays unresolved. Both records sit
  // in this profile's own slots (R3-02, MA-09).
  if (options.pendingSave) f.values.set(settingsSlotOf(f.access().profile.profile_id), JSON.stringify({ schemaVersion: 1, profileId: f.access().profile.profile_id,
    clientInstanceId: f.access().document.clientInstanceId, intent: { command_id: id(60), kind: "setting.save",
      expected_field_version: "1", payload: { key: "transition_mode", value: "normal" } } }));
  if (options.pendingReset) f.values.set(settingsResetSlotOf(f.access().profile.profile_id), JSON.stringify({ schemaVersion: 1, profileId: f.access().profile.profile_id,
    clientInstanceId: f.access().document.clientInstanceId, intent: { command_id: id(61), kind: "settings.reset", payload: {} } }));
  const data = settingsData(); if (options.confirmed === false) data.settings.transition_mode.value = null;
  const transport = { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() };
  const store = new SettingsPendingStore(f.storage), settingsRead = vi.fn(async () => response(data));
  const onToday = vi.fn(), onLearning = vi.fn(), renderPreview = vi.fn((preview: Parameters<LearningHostProps["renderPreview"]>[0]) =>
    <p data-testid="approved-preview">{preview.content.card.lemma}</p>);
  f.fetcher.mockImplementation(async (...call) => {
    const path = new URL(String(call[0]), "http://localhost").pathname;
    if (options.pendingSave && path.includes("/commands/")) throw new TypeError("network");
    if (options.pendingReset && path.endsWith(`/commands/${id(61)}`)) { await options.pendingReset; throw new TypeError("network"); }
    const saved = [options.saved?.primary, options.saved?.stop].find(command => command && path.endsWith(`/commands/${command.command_id}`));
    if (saved) return response(saved.kind === "session.start"
      ? accepted(saved, "1", current(saved.session_id), "already_applied") : missing(saved, "1"));
    if (path.endsWith("/settings")) return settingsRead();
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: data.state_version });
    if (path.endsWith("/today")) return response(today(options.status));
    return f.handler(...call);
  });
  let setRoute!: (route: Route) => void;
  function Harness({ floor }: { floor?: string }) {
    const [route, updateRoute] = useState<Route>(options.route ?? "today"); setRoute = updateRoute;
    const access = f.access();
    const settings = useSettingsDocument({ access, transport, pendingStore: store, minimumStateVersion: floor, onCurrent() {} });
    return <>
      <LearningHost access={access} transport={transport} storage={f.storage} newId={f.newId} language={options.language ?? "ru"}
        initialSessionId={seed} route={route} settings={settings} minimumStateVersion={floor} submitOnEnter
        renderPreview={renderPreview} onLearning={() => { onLearning(); if (!options.deferredNavigation) updateRoute("learning"); }}
        onToday={() => { onToday(); updateRoute("today"); }} onSettings={() => updateRoute("settings")} />
      {route === "settings" && <SettingsHost access={access} transport={transport} language="ru" active document={settings}
        onToday={() => updateRoute("today")} />}
    </>;
  }
  const ui = render(<Harness />);
  return { f, data, transport, onToday, onLearning, renderPreview, settingsRead,
    route: (route: Route) => act(() => setRoute(route)), update: (floor?: string) => ui.rerender(<Harness floor={floor} />), ...ui };
}
async function question() {
  fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
  return input;
}

describe("LearningHost with real document owners and synthetic HTTP", () => {
  it("creates one explicit session after a double Today tap and uses the required preview renderer", async () => {
    const h = setup(); const button = await screen.findByRole("button", { name: /Новая группа слов4/ });
    expect(h.f.posts()).toEqual([]); expect(h.f.newId).not.toHaveBeenCalled();
    await act(async () => {}); fireEvent.click(button); fireEvent.click(button); await screen.findByTestId("approved-preview");
    expect(h.f.posts().map(post => post.kind)).toEqual(["session.start"]);
    expect(h.onLearning).toHaveBeenCalledOnce(); expect(h.renderPreview).toHaveBeenCalled();
    const started = h.f.posts()[0]; expect(started.session_id).toBe(id(100));
    await question();
    expect(h.f.posts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
    expect(h.f.posts()[1].preview_id).toBe(id(20)); expect(h.onToday).not.toHaveBeenCalled();
  });
  it("does not expose a Start for a waiting group", async () => {
    const h = setup({ status: "waiting" }); await screen.findByText("Learning ждёт следующего этапа");
    expect(screen.queryByRole("button", { name: /Начать|Новая группа/ })).toBeNull(); expect(h.f.posts()).toEqual([]);
  });
  it("recovers a durable start with a null seed via its original GET and never posts another Start", async () => {
    const command = original({ kind: "session.start", session_id: id(3), payload: { mode: "learning" } });
    const h = setup({ saved: { primary: command } });
    await screen.findByRole("textbox"); expect(h.onLearning).toHaveBeenCalledOnce(); expect(h.f.posts()).toEqual([]);
    expect(h.f.fetcher.mock.calls.some(call => String(call[0]).includes(command.command_id) && call[1]?.method === "GET")).toBe(true);
    expect(h.f.values.has(primaryKey)).toBe(false);
    h.unmount(); const next = setup({ initialSessionId: id(3), fixture: h.f });
    await screen.findByRole("textbox"); expect(next.f.posts()).toEqual([]);
    expect(next.f.fetcher.mock.calls.some(call => String(call[0]).includes(id(3)) && call[1]?.method === "GET")).toBe(true);
  });
  it("routes an unresolved saved Stop to Learning even when open has no session seed", async () => {
    const command = original(stop);
    const h = setup({ saved: { stop: command }, confirmed: false });
    await screen.findByRole("button", { name: "Повторить завершение" });
    expect(h.onLearning).toHaveBeenCalledOnce(); expect(h.f.posts()).toEqual([]);
    expect(h.f.values.has(stopKey)).toBe(true); expect(h.onToday).not.toHaveBeenCalled();
    expect(h.f.fetcher.mock.calls.some(call => String(call[0]).includes(command.command_id) && call[1]?.method === "GET")).toBe(true);
  });
  it("keeps the same owner and draft across Settings, with no hidden presentation", async () => {
    const h = setup({ initialSessionId: id(3) }); const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    fireEvent.change(input, { target: { value: "unsent retained draft" } });
    const reads = (h.f.storage.get as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[0] === primaryKey).length;
    fireEvent.click(screen.getByRole("button", { name: "Настройки" })); await screen.findByRole("heading", { level: 1, name: "Настройки" });
    expect(h.f.posts()).toEqual([]); fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("unsent retained draft");
    expect((h.f.storage.get as ReturnType<typeof vi.fn>).mock.calls.filter(call => call[0] === primaryKey).length).toBe(reads);
    expect(h.settingsRead).toHaveBeenCalledOnce(); expect(h.f.posts()).toEqual([]);
  });
  it("recovers prefetched work while Settings is visible and presents it only after returning to Learning", async () => {
    const h = setup({ initialSessionId: id(3), route: "settings" });
    h.f.setStep({ ...current(), assignment: { ...current().assignment!, status: "prefetched" } });
    await screen.findByRole("heading", { level: 1, name: "Настройки" }); await act(async () => {});
    expect(h.onLearning).not.toHaveBeenCalled(); expect(h.f.posts()).toEqual([]);
    h.route("learning"); await screen.findByRole("textbox");
    await waitFor(() => expect(screen.getByRole("button", { name: "Забыл…" }).hasAttribute("disabled")).toBe(false));
    expect(h.f.posts().map(post => post.kind)).toEqual(["assignment.present"]);
    expect(h.f.posts()[0].assignment_id).toBe(id(6));
  });
  it("does not default a null transition setting; settings recovery and existing Stop remain available", async () => {
    const h = setup({ initialSessionId: id(3), confirmed: false });
    await screen.findByText("Для занятия нужно подтвердить настройки и текущую словарную пару.");
    const input = await screen.findByRole("textbox"); expect((input as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Настройки" })).toBeDefined();
    expect(h.f.posts()).toEqual([]); fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    expect(h.f.posts().map(post => post.kind)).toEqual(["session.stop"]);
  });
  it("cancels a Today tap on Settings or foreground instead of keeping a delayed Start", async () => {
    const h = setup({ deferredNavigation: true });
    const button = await screen.findByRole("button", { name: /Новая группа слов4/ }); fireEvent.click(button);
    h.route("settings"); h.route("learning"); await screen.findByRole("button", { name: "На Сегодня" });
    expect(h.f.posts()).toEqual([]);
    h.route("today"); fireEvent.click(await screen.findByRole("button", { name: /Новая группа слов4/ }));
    act(() => window.dispatchEvent(new Event("pageshow"))); h.route("learning");
    await screen.findByRole("button", { name: "На Сегодня" }); expect(h.f.posts()).toEqual([]);
    h.f.replace({ session: null }); h.update(); await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    const nextTap = await screen.findByRole("button", { name: /Новая группа слов4/ });
    fireEvent.click(nextTap); h.route("learning"); await screen.findByTestId("approved-preview");
    expect(h.f.posts().map(post => post.kind)).toEqual(["session.start"]);
  });
  it("blocks a newer floor until fresh matching Settings and open, retaining the current assignment draft", async () => {
    const h = setup({ initialSessionId: id(3) }); const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false)); fireEvent.change(input, { target: { value: "keep" } });
    // Settings still answer version 1: the re-read is refused as stale. The screen is the failed one, never the text asking
    // to confirm settings (C159).
    h.update("2"); await screen.findByText("Не удалось подтвердить настройки занятия.");
    expect(screen.queryByText("Для занятия нужно подтвердить настройки и текущую словарную пару.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Проверить" })?.hasAttribute("disabled") ?? true).toBe(true); expect(h.f.posts()).toEqual([]);
    h.data.state_version = "2"; h.f.replace({ profile: profile("2") });
    const router = h.f.fetcher.getMockImplementation()!;
    h.f.fetcher.mockImplementation(async (...call) => {
      const reply = await router(...call); const body = await reply.json();
      if (body.current?.mode === "learning") body.state_version = "2";
      return response(body);
    });
    h.update("2"); await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("keep"); expect(h.f.posts()).toEqual([]);
  });
  // C159 (no false published state): while the owner reads Settings again for a raised floor, the gate is closed and the
  // screen says that settings are loading; it never asks the user to confirm them.
  it("a raised floor under a held Settings re-read: loading text in every commit, gate closed until the read is current", async () => {
    const h = setup({ initialSessionId: id(3), route: "learning" }); const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    h.data.state_version = "2"; h.f.replace({ profile: profile("2") });
    const router = h.f.fetcher.getMockImplementation()!;
    h.f.fetcher.mockImplementation(async (...call) => {
      const reply = await router(...call); const body = await reply.json();
      if (body.current?.mode === "learning") body.state_version = "2";
      return response(body);
    });
    const reread = deferred<Response>(); h.settingsRead.mockReturnValueOnce(reread.promise);
    const flash = watchCommits(["нужно подтвердить настройки", "Не удалось подтвердить настройки"]);
    try {
      h.update("2");
      await screen.findByText("Загружаем настройки занятия.");
      expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true); expect(h.f.posts()).toEqual([]);
      await act(async () => { reread.resolve(response(h.data)); });
      await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false));
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    expect(screen.queryByText("Загружаем настройки занятия.")).toBeNull(); expect(h.f.posts()).toEqual([]);
  });
  it("an unresolved setting save keeps its own text and the gate closed; Settings stay unread", async () => {
    const h = setup({ initialSessionId: id(3), route: "learning", pendingSave: true });
    const flash = watchCommits(["нужно подтвердить настройки", "Не удалось подтвердить настройки"]);
    try {
      await screen.findByText("Проверяем сохранение настроек. Начать занятие пока нельзя.");
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Настройки" })).toBeDefined();
    expect(h.settingsRead).not.toHaveBeenCalled(); expect(h.f.posts()).toEqual([]);
  });
  // C185 (owner answer 31.1-А): the send or the check of a settings reset shows the same loading text as a Settings read.
  it.each([["ru", "Загружаем настройки занятия.", "Не удалось подтвердить настройки занятия.", "нужно подтвердить настройки"],
    ["uk", "Завантажуємо налаштування заняття.", "Не вдалося підтвердити налаштування заняття.", "потрібно підтвердити налаштування"],
    ["en", "Loading session settings.", "Could not confirm session settings.", "Confirm session settings"]] as const)(
    "%s: a stored reset whose status check is under way shows the loading text; its failure stays the failed text", async (language, loading, failed, confirm) => {
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      const flash = watchCommits([confirm]);
      const h = setup({ initialSessionId: id(3), route: "learning", pendingReset: held, language });
      try {
        // The status read is out: the owner is checking, not loading for the first time.
        await waitFor(() => expect(h.f.fetcher.mock.calls.some(([url]) => String(url).endsWith(`/commands/${id(61)}`))).toBe(true));
        await act(async () => {});
        expect(screen.getByText(loading)).toBeDefined();
        expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true);
        await act(async () => { release(); });
        await screen.findByText(failed);
        expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true);
        expect(screen.queryByText(loading)).toBeNull(); expect(h.f.posts()).toEqual([]);
      } finally { flash.stop(); }
      expect(flash.seen).toEqual([]);
    });
  it("accepts newer confirmed Settings from the same source without requiring another open", async () => {
    const h = setup({ initialSessionId: id(3), route: "learning" }); const access = h.f.access();
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    fireEvent.change(input, { target: { value: "same source draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Настройки" })); await screen.findByRole("heading", { level: 1, name: "Настройки" });
    h.data.state_version = "2";
    const router = h.f.fetcher.getMockImplementation()!;
    h.f.fetcher.mockImplementation(async (...call) => {
      const reply = await router(...call), body = await reply.json();
      if (body.current?.mode === "learning") body.state_version = "2";
      return response(body);
    });
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(h.settingsRead).toHaveBeenCalledTimes(2)); await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false));
    expect(h.f.access()).toBe(access); expect(access.profile.state_version).toBe("1");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("same source draft"); expect(h.f.posts()).toEqual([]);
  });
  it("foreground retains the same assignment draft but waits for a fresh open and Settings source", async () => {
    const h = setup({ initialSessionId: id(3), route: "learning" }); const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    fireEvent.change(input, { target: { value: "foreground draft" } });
    act(() => window.dispatchEvent(new Event("pageshow")));
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true); expect(h.f.posts()).toEqual([]);
    const settings = deferred<Response>(); h.settingsRead.mockReturnValueOnce(settings.promise);
    h.f.replace({}, "fresh-synthetic-token"); h.update(); await waitFor(() => expect(h.settingsRead).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true); expect(h.f.posts()).toEqual([]);
    await act(async () => { settings.resolve(response(h.data)); });
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(false));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("foreground draft"); expect(h.f.posts()).toEqual([]);
  });
  it("sends Stop in its separate lane during an in-flight answer and ignores the late answer and foreground", async () => {
    const h = setup({ initialSessionId: id(3), route: "learning" }); const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    fireEvent.change(input, { target: { value: "Haus" } });
    const gate = deferred<Response>(), router = h.f.fetcher.getMockImplementation()!;
    let late!: Response;
    h.f.fetcher.mockImplementation(async (...call) => {
      if (call[1]?.method === "POST" && JSON.parse(String(call[1].body)).kind === "answer.submit") {
        late = await router(...call); return gate.promise;
      }
      return router(...call);
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(h.f.values.has(primaryKey)).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    expect(h.f.posts().map(post => post.kind).slice(-2)).toEqual(["answer.submit", "session.stop"]);
    expect(h.f.values.has(primaryKey)).toBe(true); expect(h.f.values.has(stopKey)).toBe(false);
    await act(async () => { gate.resolve(late); });
    h.f.replace({ session: null }); act(() => window.dispatchEvent(new Event("pageshow"))); h.update();
    await screen.findByText("Активная пара: Русский ↔ Немецкий");
    expect(h.onToday).toHaveBeenCalledOnce(); expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("reloads an accepted answer with a lost ACK from the same durable storage and original command ID", async () => {
    const h = setup({ initialSessionId: id(3), route: "learning" }); h.f.wrong();
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    fireEvent.change(input, { target: { value: "captured answer A" } });
    const router = h.f.fetcher.getMockImplementation()!;
    // The old document cannot check the lost answer by ID: it is left unknown there.
    let offline = true;
    h.f.fetcher.mockImplementation(async (...call) => {
      if (call[1]?.method === "POST") { await router(...call); throw new Error("synthetic lost ACK"); }
      if (offline && String(call[0]).includes("/commands/")) throw new Error("synthetic status outage");
      return router(...call);
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверяем, сохранилось ли действие.");
    const command = h.f.posts()[0]; expect(h.f.values.has(primaryKey)).toBe(true);
    h.unmount(); offline = false; h.f.replace({ session: null });
    const reloaded = setup({ fixture: h.f });
    await screen.findByRole("region", { name: "Есть ошибка" });
    expect(reloaded.f.storage).toBe(h.f.storage); expect(reloaded.onLearning).toHaveBeenCalledOnce();
    expect(reloaded.f.posts()).toHaveLength(1); expect(reloaded.f.values.has(primaryKey)).toBe(false);
    expect(reloaded.f.fetcher.mock.calls.some(call => String(call[0]).includes(command.command_id) && call[1]?.method === "GET")).toBe(true);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
  it("keeps an unresolved answer after closed, checks it before the next Start and never replays it", async () => {
    const h = setup({ initialSessionId: id(3), route: "learning" });
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    fireEvent.change(input, { target: { value: "Haus" } });
    const router = h.f.fetcher.getMockImplementation()!;
    let primaryId: string | null = null, checkingFails = true;
    h.f.fetcher.mockImplementation(async (...call) => {
      if (primaryId && String(call[0]).includes(`/commands/${primaryId}`) && checkingFails) throw new Error("synthetic status outage");
      if (call[1]?.method === "POST" && JSON.parse(String(call[1].body)).kind === "answer.submit") {
        primaryId = JSON.parse(String(call[1].body)).command_id; await router(...call); throw new Error("synthetic lost ACK");
      }
      return router(...call);
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Проверяем, сохранилось ли действие."); fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    h.f.replace({ session: null }); h.update(); await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: /Новая группа слов4/ }));
    // Н6 (D-CP4 3.1.4): while the record outlives the closure, the screen says that it is checked, not only «завершено».
    await screen.findByText("Нет связи с сервером. Ждём, когда связь восстановится…");
    await act(async () => {});
    // The answer is a study result: no manual check, its automatic recovery keeps checking it by ID (Я15).
    expect(screen.queryByRole("button", { name: "Проверить сохранённые действия" })).toBeNull();
    expect(h.f.posts().map(post => post.kind)).toEqual(["answer.submit", "session.stop"]);
    expect(h.f.values.has(primaryKey)).toBe(true); expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    // Once the server answers, the next check of the probe schedule finds it not applied in the closed session.
    checkingFails = false;
    const home = await screen.findByRole("button", { name: "На Сегодня" }, { timeout: 25_000 });
    expect(h.f.values.has(primaryKey)).toBe(false); expect(h.f.posts()).toHaveLength(2);
    fireEvent.click(home);
    fireEvent.click(await screen.findByRole("button", { name: /Новая группа слов4/ })); await screen.findByTestId("approved-preview");
    expect(h.f.posts().map(post => post.kind)).toEqual(["answer.submit", "session.stop", "session.start"]);
    expect(h.f.posts()[2].session_id).not.toBe(id(3)); expect(h.onToday).toHaveBeenCalledTimes(2);
  }, 40_000);
  it("summary_home waits for a confirmed closed reply and refreshes Today exactly once", async () => {
    const h = setup({ initialSessionId: id(3) }); h.f.setStep({ ...current(), status: "summary", assignment: null });
    const summary = await screen.findByRole("button", { name: "Вернуться на Сегодня" });
    const gate = deferred<Response>(), router = h.f.fetcher.getMockImplementation()!;
    let closedReply!: Response;
    h.f.fetcher.mockImplementation(async (...call) => {
      if (call[1]?.method === "POST") { closedReply = await router(...call); return gate.promise; }
      return router(...call);
    });
    fireEvent.click(summary); await waitFor(() => expect(h.f.posts()).toHaveLength(1));
    expect(h.f.posts()[0]).toMatchObject({ kind: "session.stop", session_id: id(3), payload: { reason: "summary_home" } });
    expect(h.onToday).not.toHaveBeenCalled(); await act(async () => { gate.resolve(closedReply); });
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    h.f.replace({ session: null }); h.update(); await screen.findByText("Активная пара: Русский ↔ Немецкий");
    h.update(); expect(h.onToday).toHaveBeenCalledOnce(); expect(h.f.posts()).toHaveLength(1);
  });
  it("summary and a settled Stop rejection do not navigate; a later closed read notifies Today once", async () => {
    const h = setup({ initialSessionId: id(3) });
    h.f.setStep({ ...current(), status: "summary", assignment: null });
    await screen.findByRole("button", { name: "Вернуться на Сегодня" }); expect(h.onToday).not.toHaveBeenCalled();
    const router = h.f.fetcher.getMockImplementation()!;
    h.f.fetcher.mockImplementation(async (...call) => {
      if (call[1]?.method === "POST") {
        const command = JSON.parse(String(call[1].body));
        return response({ state_version: "1", current: { ...current(), status: "summary", assignment: null },
          command: { id: command.command_id, status: "rejected" }, error: { code: "SESSION_STALE" } }, 409);
      }
      return router(...call);
    });
    fireEvent.click(screen.getByRole("button", { name: "Вернуться на Сегодня" }));
    await screen.findByRole("button", { name: "Проверить состояние" }); expect(h.onToday).not.toHaveBeenCalled();
    h.f.setStep({ ...current(), status: "closed", close_reason: "stop", assignment: null });
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" }));
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    expect(screen.getByText("Проверяем сохранённое занятие…")).toBeDefined();
    h.f.replace({ session: null }); h.update(); await screen.findByText("Активная пара: Русский ↔ Немецкий");
    expect(h.onToday).toHaveBeenCalledOnce();
  });
  it("a revoked access hides Learning without treating disposal as closed", async () => {
    const h = setup({ initialSessionId: id(3) }); await screen.findByRole("textbox");
    h.f.revoke(); h.update(); await screen.findByText("Занятие недоступно в этом окне.");
    // The Settings owner of a closed access reports a standing problem, not a read under way (C159).
    expect(screen.getByText("Не удалось подтвердить настройки занятия.")).toBeDefined(); expect(screen.queryByText("Загружаем настройки занятия.")).toBeNull();
    expect(h.onToday).not.toHaveBeenCalled(); expect(h.f.posts()).toEqual([]);
  });
});

// QA CP2b probes H1 and H2, ported (M-RECOV-AUTO CP4a-1, D-CP4 3.1.1 and 3.1.4): what the closed Learning screen shows
// while a study record outlives the confirmed closure, and that a conflict no longer blocks a new session.
describe("a study record after the confirmed closure (Н2, Н6)", () => {
  function closure(intercept: (call: Parameters<typeof fetch>, router: (...call: Parameters<typeof fetch>) => Promise<Response>) => Promise<Response> | null) {
    const f = learningViewFixture("normal", id(3)); fixtures.push(f); f.view.dispose(); f.owner.dispose();
    const data = settingsData();
    const transport = { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() };
    const store = new SettingsPendingStore(f.storage), onToday = vi.fn();
    const router = async (...call: Parameters<typeof fetch>) => {
      const path = new URL(String(call[0]), "http://localhost").pathname;
      if (path.endsWith("/settings")) return response(data);
      if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: data.state_version });
      if (path.endsWith("/today")) return response(today());
      return f.handler(...call);
    };
    f.fetcher.mockImplementation(async (...call) => intercept(call, router) ?? router(...call));
    function Harness() {
      const [route, updateRoute] = useState<Route>("learning");
      const access = f.access();
      const settings = useSettingsDocument({ access, transport, pendingStore: store, onCurrent() {} });
      return <LearningHost access={access} transport={transport} storage={f.storage} newId={f.newId} language="ru"
        initialSessionId={id(3)} route={route} settings={settings} submitOnEnter
        renderPreview={preview => <p data-testid="approved-preview">{preview.content.card.lemma}</p>}
        onLearning={() => updateRoute("learning")} onToday={() => { onToday(); updateRoute("today"); }} onSettings={() => updateRoute("settings")} />;
    }
    const ui = render(<Harness />);
    return { f, onToday, update: () => ui.rerender(<Harness />) };
  }
  const buttons = () => screen.queryAllByRole("button").map(button => button.textContent);
  const body = (call: Parameters<typeof fetch>) => call[1]?.method === "POST" ? JSON.parse(String(call[1].body)) : null;
  async function answer() {
    const input = await screen.findByRole("textbox");
    await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
    fireEvent.change(input, { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  }

  it("H1 a conflict, «Выйти», Today: «Новая группа слов» starts a new session on this device", async () => {
    let conflicted: string | null = null;
    const mismatch = () => response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
    const h = closure(call => {
      if (conflicted && call[1]?.method !== "POST" && String(call[0]).includes(`/commands/${conflicted}`)) return Promise.resolve(mismatch());
      if (body(call)?.kind === "answer.submit") { conflicted = body(call).command_id; return Promise.resolve(mismatch()); }
      return null;
    });
    await answer();
    await screen.findByText("Не удалось подтвердить это действие. Повторить его нельзя. Заверши занятие, чтобы продолжить.");
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    await waitFor(() => expect(h.f.values.has(primaryKey)).toBe(false));
    h.f.replace({ session: null }); h.update(); await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: /Новая группа слов/ }));
    await waitFor(() => expect(h.f.posts().map(post => post.kind)).toContain("session.start"));
    expect(h.f.posts().map(post => post.kind).filter(kind => kind === "answer.submit")).toHaveLength(1);
  }, 30_000);

  it("H2 a lost answer, «Выйти» offline: 9.2.2 with an indicator, nothing blurred, no buttons; back online: 9.2.8, then «На Сегодня»", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let answerId: string | null = null, offline = true;
    const h = closure((call, router) => {
      if (answerId && offline && String(call[0]).includes(`/commands/${answerId}`)) return Promise.reject(new TypeError("offline"));
      if (body(call)?.kind === "answer.submit") {
        answerId = body(call).command_id;
        return router(...call).then(() => { throw new TypeError("lost"); });
      }
      return null;
    });
    await answer();
    await screen.findByText("Нет связи с сервером. Ждём, когда связь восстановится…");
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    h.f.replace({ session: null }); h.update(); await act(async () => {});
    fireEvent.click(await screen.findByRole("button", { name: /Новая группа слов/ }));
    await screen.findByText("Нет связи с сервером. Ждём, когда связь восстановится…");
    expect(document.querySelector(".learning-closed-check .wortly-loader")).toBeTruthy();
    expect(document.querySelector(".recovery-overlay")).toBeNull();
    expect(screen.queryByText("Занятие завершено.")).toBeNull();
    expect(buttons()).toEqual(["Настройки"]);
    offline = false;
    await act(() => vi.advanceTimersByTimeAsync(31_000));
    await screen.findByText("Занятие завершено. Последнее действие сохранено.");
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    expect(h.f.values.has(primaryKey)).toBe(false);
    expect(h.f.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
  }, 30_000);
});
