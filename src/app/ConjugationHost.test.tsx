import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "../api/generated";
import type { ConjugationIntent } from "../conjugation/conjugationIntent";
import { conjugationId as id, conjugationServer, FORMS, type CloseReason, type ModelSession } from "../conjugation/conjugationModel.test-support";
import type { AsyncStorage } from "../platform/storage";
import { SettingsPendingStore } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { useSettingsDocument } from "../settings/useSettingsDocument";
import { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "../conjugation/conjugationPending";
import { leavesToToday, useConjugationHost, type ConjugationHost, type ConjugationHostOptions } from "./ConjugationHost";
import { createOpenedAccess, type OpenedAccess } from "./openedAccess";

const S1 = id(3), studyKey = "wortly.pending.conjugation_session";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const macrotasks = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(done => setTimeout(done, 0)); }); };
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
/** Telegram BackButton double: records click handlers. */
function fakeBack() {
  const handlers = new Set<() => void>();
  return { api: { show() {}, hide() {}, onClick(handler: () => void) { handlers.add(handler); }, offClick(handler: () => void) { handlers.delete(handler); } },
    get bound() { return handlers.size; }, click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}
const active = (over: Partial<ModelSession> = {}): ModelSession => ({ id: S1, status: "active", assignment: FORMS[0], presented: true, results: [], ...over });

type Options = { sessions?: ModelSession[]; seed?: boolean; route?: ConjugationHostOptions["route"]; holdRoute?: boolean;
  seedPending?: boolean; settings?: (data: SettingsResponse) => void; holdSettings?: boolean; saved?: ConjugationIntent };
/** The host over a synthetic server model for one profile; it makes no claim of backend acceptance. */
function setup(options: Options = {}) {
  const model = conjugationServer({ sessions: options.sessions, version: "10" });
  const values = new Map<string, string>();
  if (options.saved) values.set(studyKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent: options.saved }));
  const storage: AsyncStorage = { get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); }, remove: async k => { values.delete(k); } };
  const data = settingsResponse(); data.state_version = "10"; data.needs_setup = false;
  data.settings.dictionary_language.value = "ru"; data.settings.transition_mode.value = "normal"; options.settings?.(data);
  let releaseSettings: () => void = () => undefined;
  const settingsGate = options.holdSettings ? new Promise<void>(done => { releaseSettings = done; }) : null;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url), "https://model.invalid").pathname;
    if (path.endsWith("/settings")) { if (settingsGate) await settingsGate; return response(data); }
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: data.state_version });
    return await model.handle(url, init) ?? response({ error: { code: "UNEXPECTED" } }, 500);
  });
  const transport = { fetcher, timeoutMs: 1000, maxResponseBytes: 200000 };
  const seed = options.seed ? S1 : null;
  const opened = (generation: number) => createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2),
    document_epoch: "1", proof_version: "1", profile: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
      time_zone: "UTC", state_version: "10", access: { status: "admitted", version: "1", reason: null } },
    session: seed ? { id: seed, phase: "active" } : null, compatibility: { compatible: true, contract_version: "1" } },
  token: "synthetic-token", proof: "synthetic-proof", generation, isLive: () => true, onDenied() {} });
  const stores = { study: new ConjugationSessionPendingStore(storage), stop: new ConjugationStopPendingStore(storage) };
  const settingsStore = new SettingsPendingStore(storage), back = fakeBack(), haptic = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { HapticFeedback: { notificationOccurred: haptic }, BackButton: back.api } });
  const onToday = vi.fn(), onConjugation = vi.fn(), host: { current: ConjugationHost | null } = { current: null };
  let setRoute!: (route: ConjugationHostOptions["route"]) => void, setAccess!: (access: OpenedAccess) => void, generation = 1;
  function Harness() {
    const [route, update] = useState<ConjugationHostOptions["route"]>(options.route ?? (seed ? "conjugation" : "today")); setRoute = update;
    const [access, replace] = useState(() => opened(1)); setAccess = replace;
    const settings = useSettingsDocument({ access, transport, pendingStore: settingsStore, onCurrent() {} });
    const value = useConjugationHost({ access, transport, stores, newId: model.newId, language: "ru", settings,
      initialSessionId: seed, seedPending: options.seedPending ?? false, route,
      onConjugation: () => { onConjugation(); if (!options.holdRoute) update("conjugation"); },
      onToday: () => { onToday(); update("today"); } });
    host.current = value;
    return <>{value.screen}{route === "today" && <p data-testid="today">{value.blocksToday ? "held" : "shown"}</p>}</>;
  }
  render(<Harness />);
  const starts = () => model.posted.filter(post => post.kind === "session.start");
  const stops = () => model.posted.filter(post => post.kind === "session.stop");
  return { model, fetcher, values, onToday, onConjugation, host, back, haptic, starts, stops, releaseSettings,
    route: (route: ConjugationHostOptions["route"]) => act(() => setRoute(route)),
    /** A new access object of the same document tuple, as after a foreground. */
    reopen: () => act(() => setAccess(opened(++generation))),
    /** Taps «Тест спряжений» on Today once the start right is there. */
    async start() {
      await waitFor(() => expect(host.current?.canRequestStart).toBe(true));
      act(() => host.current!.requestStart());
    } };
}
async function editable() {
  const field = await screen.findByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(field.readOnly).toBe(false));
  return field;
}
async function answer(text: string) {
  fireEvent.change(await editable(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
}

afterEach(() => { cleanup(); setVisibility("visible"); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("useConjugationHost: start from Today", () => {
  it.each<[string, Options]>([
    ["settings still loading", { holdSettings: true }],
    ["no confirmed transition mode", { settings: data => { data.settings.transition_mode.value = null; } }],
    ["settings of another pair", { settings: data => { data.settings.dictionary_language.value = "uk"; } }],
  ])("H1 a closed start right (%s): no start, no route", async (_name, options) => {
    const h = setup(options);
    await macrotasks();
    expect(h.host.current!.canRequestStart).toBe(false);
    act(() => h.host.current!.requestStart());
    await macrotasks();
    expect(h.onConjugation).not.toHaveBeenCalled(); expect(h.model.posted).toEqual([]);
    expect(screen.getByTestId("today")).toBeTruthy();
    h.releaseSettings();
  });

  it("H2 a tap opens the route once and sends exactly one start of a new conjugation session, also after a second tap", async () => {
    const h = setup();
    await h.start();
    act(() => h.host.current!.requestStart());
    await editable();
    act(() => h.host.current!.requestStart());
    await macrotasks();
    expect(h.onConjugation).toHaveBeenCalledOnce();
    expect(h.starts()).toHaveLength(1);
    expect(h.starts()[0].payload).toEqual({ mode: "conjugation" });
    expect(h.model.sessions.has(h.starts()[0].session_id)).toBe(true);
    expect(h.model.kinds()).toEqual(["session.start", "assignment.present"]);
  });

  it("H2 a consumed tap never starts again: after the test is ended no new session is started", async () => {
    const h = setup();
    await h.start();
    await editable();
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    await screen.findByText("Занятие завершено");
    await macrotasks();
    expect(h.starts()).toHaveLength(1); expect(h.model.kinds()).toEqual(["session.start", "assignment.present", "session.stop"]);
  });

  it("H3 a background between the tap and the start cancels it: nothing is sent and the empty route returns to Today once", async () => {
    const h = setup();
    await h.start();
    setVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await macrotasks();
    expect(h.model.posted).toEqual([]);
    expect(h.onToday).toHaveBeenCalledOnce();
  });

  it("H4 while the start is on its way the screen loads; it shows no refresh failure", async () => {
    const h = setup();
    const held = h.model.hold((url, method) => method === "POST" && url.pathname.endsWith("/commands"));
    await h.start();
    await held.entered;
    await macrotasks();
    expect(screen.getByText("Загружаем занятие…")).toBeTruthy();
    expect(screen.queryByText("Не удалось обновить занятие.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Проверить статус" })).toBeNull();
    held.release();
    await editable();
  });

  // pending owner answer 5.1.1 (D-CONJ-HOST): TEMPORARY expectation. The host adds nothing to a refused start; the screen
  // stays as the module shows it. Replace this test once the owner chooses what a refused start shows.
  it.each(["NO_MATERIAL", "SETUP_REQUIRED"])("H5 a refused start (%s) stays on the module's screen: one start, no Today, no retry", async code => {
    const h = setup();
    h.model.server.rejectStart = code;
    await h.start();
    await screen.findByText("Не удалось обновить занятие.");
    await macrotasks();
    expect(h.starts()).toHaveLength(1); expect(h.model.posted).toHaveLength(1);
    expect(h.onToday).not.toHaveBeenCalled(); expect(h.haptic).not.toHaveBeenCalled();
  });

  it("H10 an own unconfirmed receipt without a reported session claims the route before Today, once", async () => {
    const h = setup({ holdRoute: true, saved: { command_id: id(60), kind: "session.start", session_id: id(61), payload: { mode: "conjugation" } } });
    expect(screen.getByTestId("today").textContent).toBe("held");
    await waitFor(() => expect(h.onConjugation).toHaveBeenCalledOnce());
    await macrotasks();
    expect(h.onConjugation).toHaveBeenCalledOnce();
    expect(screen.getByTestId("today").textContent).toBe("held");
    expect(h.model.posted).toEqual([]);
  });

  it("H10 without any session or receipt Today is released after the first recovery", async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId("today").textContent).toBe("shown"));
  });

  // pending owner answer 5.1.3 (D-CONJ-HOST): TEMPORARY expectation, no haptic signal until the owner decides.
  it("H12 neither an accepted start nor the summary after an own answer gives a haptic signal", async () => {
    const h = setup();
    await h.start();
    await answer("kommst");
    fireEvent.click(await screen.findByRole("button", { name: "Далее" }));
    await answer("kommst");
    fireEvent.click(await screen.findByRole("button", { name: "Далее" }));
    await screen.findByText("Итог спряжений");
    await macrotasks();
    expect(h.haptic).not.toHaveBeenCalled();
  });
});

describe("useConjugationHost: closures", () => {
  it("H6 «Завершить» sends one Stop and keeps the closed screen; Back or «На Сегодня» returns to Today once", async () => {
    const h = setup({ seed: true, sessions: [active()] });
    await editable();
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    await screen.findByText("Занятие завершено");
    await macrotasks();
    expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "stop" }]);
    expect(h.onToday).not.toHaveBeenCalled();
    await h.back.click();
    expect(h.onToday).toHaveBeenCalledOnce();
  });

  it("H6 «На Сегодня» on the own closed screen returns once", async () => {
    const h = setup({ seed: true, sessions: [active()] });
    await editable();
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    fireEvent.click(await screen.findByRole("button", { name: "На Сегодня" }));
    await macrotasks();
    expect(h.onToday).toHaveBeenCalledOnce();
  });

  it("H7 the summary's «На Сегодня» sends one summary_home Stop and returns to Today exactly once", async () => {
    const h = setup({ seed: true, sessions: [active({ status: "summary", assignment: null })] });
    fireEvent.click(await screen.findByRole("button", { name: "На Сегодня" }));
    await waitFor(() => expect(h.onToday).toHaveBeenCalled());
    await macrotasks();
    expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "summary_home" }]);
    expect(h.onToday).toHaveBeenCalledOnce();
  });

  const reasons: [CloseReason, string][] = [["midnight", "Занятие закрыто: начался новый день"],
    ["timezone_date_changed", "Занятие закрыто: сменилась дата"], ["pair_changed", "Занятие закрыто: изменилась языковая пара"],
    ["remote_stop", "Занятие завершено на другом устройстве"]];
  it.each(reasons)("H8 a closure by %s read on return stays on the closed screen with its reason until Back", async (reason, text) => {
    const h = setup({ seed: true, sessions: [active()] });
    await editable();
    h.model.close(S1, reason);
    await h.reopen();
    await screen.findByText(text);
    await macrotasks();
    expect(h.onToday).not.toHaveBeenCalled(); expect(h.model.posted).toEqual([]);
    await h.back.click(); await h.back.click();
    expect(h.onToday).toHaveBeenCalledOnce();
  });

  it.each(reasons)("H8 a closure by %s learnt from the refusal SESSION_CLOSED of an answer keeps its reason until «На Сегодня»", async (reason, text) => {
    const h = setup({ seed: true, sessions: [active()] });
    await editable();
    h.model.close(S1, reason);
    await answer("kommst");
    await screen.findByText(text);
    await macrotasks();
    expect(h.onToday).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await macrotasks();
    expect(h.onToday).toHaveBeenCalledOnce(); expect(h.model.kinds()).toEqual(["answer.submit"]);
  });

  it("leavesToToday: only summary_home leaves by itself", () => {
    expect((["stop", "remote_stop", "midnight", "timezone_date_changed", "pair_changed", "save_failed", null] as const)
      .map(reason => leavesToToday(reason))).toEqual([false, false, false, false, false, false, false]);
    expect(leavesToToday("summary_home")).toBe(true);
  });
});

describe("useConjugationHost: native Back", () => {
  it("H9 Back on a question stops once; while that Stop is on its way Back sends nothing more; the closed screen returns to Today", async () => {
    const h = setup({ seed: true, sessions: [active()] });
    await editable();
    const held = h.model.hold((_url, method) => method === "POST");
    await h.back.click();
    await held.entered;
    // The awaited Stop keeps Back bound, doing nothing (К10-151): it neither sends again nor leaves.
    expect(h.back.bound).toBe(1);
    await h.back.click(); await h.back.click();
    expect(h.onToday).not.toHaveBeenCalled();
    held.release();
    await screen.findByText("Занятие завершено");
    expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "stop" }]);
    expect(h.onToday).not.toHaveBeenCalled();
    await h.back.click();
    expect(h.onToday).toHaveBeenCalledOnce();
  });

  it("H9 Back on the summary is its «На Сегодня»: summary_home", async () => {
    const h = setup({ seed: true, sessions: [active({ status: "summary", assignment: null })] });
    await screen.findByText("Итог спряжений");
    await waitFor(() => expect(h.back.bound).toBe(1));
    await h.back.click();
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "summary_home" }]);
  });
});

describe("useConjugationHost: owner lifetime", () => {
  it("H11 an unresolved mode read keeps the screen loading and the owner closed", async () => {
    const h = setup({ seed: true, seedPending: true, sessions: [active()] });
    await macrotasks();
    expect(screen.getByText("Загружаем занятие…")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(h.model.posted).toEqual([]);
  });

  it("H14 a new access object of the same document keeps the typed draft", async () => {
    const h = setup({ seed: true, sessions: [active()] });
    fireEvent.change(await editable(), { target: { value: "komm" } });
    await h.reopen();
    await waitFor(async () => expect((await editable()).value).toBe("komm"));
    expect(h.model.posted).toEqual([]);
  });

  it("H15 without the start right a session waiting for its form: the settings block, its refresh and Today", async () => {
    const h = setup({ seed: true, sessions: [active({ presented: false })], settings: data => { data.settings.transition_mode.value = null; } });
    await screen.findByText("Для занятия нужно подтвердить настройки и текущую словарную пару.");
    const reads = h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/settings")).length;
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/settings")).length).toBeGreaterThan(reads));
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    expect(h.onToday).toHaveBeenCalledOnce(); expect(h.model.posted).toEqual([]);
  });
});

describe("useConjugationHost: result transition", () => {
  it.each<["normal" | "accelerated", string, number | null]>([["accelerated", "kommst", 2000], ["accelerated", "kommt", 2000],
    ["normal", "kommst", 3000], ["normal", "kommt", null]])("H13 %s mode, answer %s: the result moves on after %s ms", async (mode, text, delay) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup({ seed: true, sessions: [active()], settings: data => { data.settings.transition_mode.value = mode; } });
    await answer(text);
    await screen.findByRole("button", { name: "Далее" });
    await act(async () => { vi.advanceTimersByTime(1900); });
    expect(screen.queryByRole("button", { name: "Далее" })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1200); });
    if (delay === 2000) { await waitFor(() => expect(screen.queryByRole("button", { name: "Далее" })).toBeNull()); return; }
    await act(async () => { vi.advanceTimersByTime(1000); });
    if (delay === 3000) { await waitFor(() => expect(screen.queryByRole("button", { name: "Далее" })).toBeNull()); return; }
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
  });

  it("H13/H14 a background cancels the result timer for good: after the return the result waits for «Далее»", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup({ seed: true, sessions: [active()] });
    await answer("kommst");
    await screen.findByRole("button", { name: "Далее" });
    setVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await act(async () => { vi.advanceTimersByTime(4000); });
    setVisibility("visible");
    await h.reopen();
    await screen.findByRole("button", { name: "Далее" });
    await act(async () => { vi.advanceTimersByTime(10000); });
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    expect(h.model.kinds()).toEqual(["answer.submit"]);
  });
});
