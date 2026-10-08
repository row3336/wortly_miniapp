import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse, TodayResponse } from "../api/generated";
import { learningViewFixture } from "../learning/learningView.test-support";
import { accepted, current, deferred, id, original, pending, primaryKey, profile, response, missing, stop, stopKey } from "../learning/learningFixtures.test-support";
import { SettingsPendingStore } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { SettingsHost } from "../settings/SettingsHost";
import { useSettingsDocument } from "../settings/useSettingsDocument";
import type { LearningCommandIntent } from "../learning/learningCommandIntent";
import { LearningHost, type LearningHostProps } from "./LearningHost";

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
  deferredNavigation?: boolean; fixture?: ReturnType<typeof learningViewFixture>; saved?: { primary?: LearningCommandIntent; stop?: LearningCommandIntent } } = {}) {
  const seed = options.initialSessionId === undefined ? null : options.initialSessionId;
  const f = options.fixture ?? learningViewFixture("normal", seed); fixtures.push(f); f.view.dispose(); f.owner.dispose();
  if (options.saved?.primary) f.values.set(primaryKey, JSON.stringify(pending(options.saved.primary)));
  if (options.saved?.stop) f.values.set(stopKey, JSON.stringify(pending(options.saved.stop)));
  const data = settingsData(); if (options.confirmed === false) data.settings.transition_mode.value = null;
  const transport = { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000 };
  const store = new SettingsPendingStore(f.storage), settingsRead = vi.fn(async () => response(data));
  const onToday = vi.fn(), onLearning = vi.fn(), renderPreview = vi.fn((preview: Parameters<LearningHostProps["renderPreview"]>[0]) =>
    <p data-testid="approved-preview">{preview.content.card.lemma}</p>);
  f.fetcher.mockImplementation(async (...call) => {
    const path = new URL(String(call[0]), "http://localhost").pathname;
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
      <LearningHost access={access} transport={transport} storage={f.storage} newId={f.newId} language="ru"
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
    h.update("2"); await screen.findByText("Для занятия нужно подтвердить настройки и текущую словарную пару.");
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
    await screen.findByText("Занятие завершено.");
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
    expect(h.onToday).not.toHaveBeenCalled(); expect(h.f.posts()).toEqual([]);
  });
});
