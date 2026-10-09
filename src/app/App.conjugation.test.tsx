import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import { conjugationId as id, conjugationServer, FORMS, type ModelSession } from "../conjugation/conjugationModel.test-support";
import { cardIdOf } from "../dictionary/card/cardTestData.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { besidesContext, launch, serveLaunchCard } from "./launchCard.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Language = "ru" | "uk" | "en";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const S1 = id(3);
/** A wait for a screen that arrives after a chain of server exchanges (open, Today, session read): not the default 1 s. */
const exchange = { timeout: 5000 };
const navigation = { name: "Основная навигация" } as const;
const testScreen = { name: "Тест спряжений", level: 1 } as const;

function today(ready: number): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-10-01", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready, openable: ready, next_due_date: null }, next_repeat_date: null };
}
/** Telegram BackButton double: records click handlers. */
function fakeBack() {
  const handlers = new Set<() => void>();
  return { api: { show() {}, hide() {}, onClick(handler: () => void) { handlers.add(handler); }, offClick(handler: () => void) { handlers.delete(handler); } },
    get bound() { return handlers.size; }, click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}

/** The real App over one synthetic server: entry, Settings, Today and the conjugation model, with one state version. */
function app(options: { sessions?: ModelSession[]; reported?: string | null; ready?: number; transitionMode?: "normal" | null;
  language?: Language } = {}) {
  const model = conjugationServer({ sessions: options.sessions, version: "10", profileId: id(50) });
  const language = options.language ?? "ru";
  const server = { session: options.reported ?? null as string | null, ready: options.ready ?? 2 };
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = language; stored.settings.dictionary_language.value = "ru";
  stored.settings.transition_mode.value = options.transitionMode === undefined ? "normal" : options.transitionMode;
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: language, dictionary_language: "ru", time_zone: "UTC",
    state_version: model.version(), access: { status: "admitted", version: "1", reason: null } });
  const openReply = vi.fn(async (body: { client_instance_id: string; document_id: string }) => response({ status: "opened", profile: account(),
    compatibility, client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1",
    session: server.session === null ? null : { id: server.session, phase: "active" } }));
  const todayReply = vi.fn(async () => response(today(server.ready)));
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-02T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return openReply(body);
    if (path.endsWith("/today")) return todayReply();
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: model.version() });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: model.version() });
    return await model.handle(url, init) ?? response({ error: { code: "UNEXPECTED" } }, 500);
  });
  const back = fakeBack();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: language } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() }, BackButton: back.api } });
  const kinds = () => model.kinds();
  return { model, server, openReply, todayReply, fetcher, back, kinds,
    starts: () => model.posted.filter(post => post.kind === "session.start") };
}
const active = (over: Partial<ModelSession> = {}): ModelSession => ({ id: S1, status: "active", assignment: FORMS[0], presented: true, results: [], ...over });
const settled = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise(done => setTimeout(done, 0)); }); };
async function editable() {
  const field = await screen.findByRole("textbox", undefined, exchange) as HTMLTextAreaElement;
  await waitFor(() => expect(field.readOnly).toBe(false));
  return field;
}
async function answer(text: string) {
  fireEvent.change(await editable(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
}
async function startButton(name: RegExp = /Тест спряжений/) {
  const button = await screen.findByRole("button", { name }, exchange) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}
const foreground = () => act(async () => { window.dispatchEvent(new Event("pageshow")); });

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "200000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the conjugation test through the actual App document", () => {
  it("A1 Today's «Тест спряжений» opens the test without the bottom navigation; one answer is one command", async () => {
    const a = app();
    render(<App />);
    expect((await startButton()).textContent).toContain("2");
    expect(screen.getByRole("navigation", navigation)).toBeTruthy();
    fireEvent.click(await startButton());
    await screen.findByRole("heading", testScreen, exchange);
    expect(screen.queryByRole("navigation", navigation)).toBeNull();
    await answer("kommst");
    await screen.findByRole("button", { name: "Далее" }, exchange);
    expect(a.kinds()).toEqual(["session.start", "assignment.present", "answer.submit"]);
    expect(a.starts()[0].payload).toEqual({ mode: "conjugation" });
  });

  it("A1 native Back on a question stops the test and keeps its closed screen; the next Back returns to Today", async () => {
    const a = app({ sessions: [active()], reported: S1 });
    render(<App />);
    await editable();
    await a.back.click();
    await screen.findByText("Занятие завершено", undefined, exchange);
    await settled();
    expect(screen.queryByRole("navigation", navigation)).toBeNull();
    expect(a.model.posted.map(post => [post.kind, post.payload])).toEqual([["session.stop", { reason: "stop" }]]);
    a.server.session = null;
    await a.back.click();
    await screen.findByRole("navigation", navigation, exchange);
    expect(a.model.posted).toHaveLength(1);
  });

  it("A2 no ready conjugations: no button; ready ones without a confirmed timer mode: a disabled button that sends nothing", async () => {
    app({ ready: 0 });
    render(<App />);
    await screen.findByText(/Готово: 0/, undefined, exchange);
    expect(screen.queryByRole("button", { name: /Тест спряжений/ })).toBeNull();
    cleanup();
    const a = app({ transitionMode: null });
    render(<App />);
    const button = await screen.findByRole("button", { name: /Тест спряжений/ }, exchange) as HTMLButtonElement;
    await settled();
    expect(button.disabled).toBe(true);
    fireEvent.click(button); await settled();
    expect(a.model.posted).toEqual([]); expect(screen.queryByRole("heading", testScreen)).toBeNull();
  });

  it("A3 a restart with an open session continues at its shown form: nothing is sent, no «Вход подтверждён», no Today", async () => {
    const a = app({ sessions: [active()], reported: S1 });
    render(<App />);
    await screen.findByRole("heading", testScreen, exchange);
    await editable(); await settled();
    expect(screen.getByText("kommen")).toBeTruthy();
    expect(a.model.posted).toEqual([]); expect(screen.queryByText("Вход подтверждён")).toBeNull();
    expect(a.todayReply).not.toHaveBeenCalled();
  });

  it("A4 a restart with a prefetched form confirms its display exactly once, after it is shown", async () => {
    const a = app({ sessions: [active({ presented: false })], reported: S1 });
    render(<App />);
    await editable(); await settled();
    expect(a.kinds()).toEqual(["assignment.present"]);
    expect(a.model.posted[0]).toMatchObject({ session_id: S1, assignment_id: FORMS[0] });
  });

  // pending owner answer 5.1.1 (D-CONJ-HOST): TEMPORARY expectation. A refused start stays on the module's screen; only a
  // return from the background (a new access, so a new owner without that session) leads back to Today.
  it("A5 a refused start stays on the test screen; after a foreground Today offers a new start with another session ID", async () => {
    const a = app();
    a.model.server.rejectStart = "NO_MATERIAL";
    render(<App />);
    fireEvent.click(await startButton());
    await screen.findByText("Не удалось обновить занятие.", undefined, exchange);
    const todays = a.todayReply.mock.calls.length;
    await settled();
    expect(a.starts()).toHaveLength(1); expect(a.todayReply.mock.calls.length).toBe(todays);
    await foreground();
    fireEvent.click(await startButton());
    await editable();
    expect(a.starts()).toHaveLength(2);
    expect(a.starts()[1].session_id).not.toBe(a.starts()[0].session_id);
  });

  it("A7 an own unconfirmed start of an earlier document is shown before Today, and Today waits until it is resolved", async () => {
    const a = app();
    render(<App />);
    const lost = a.model.hold((url, method) => method === "POST" && url.pathname.endsWith("/commands"));
    fireEvent.click(await startButton());
    await lost.entered;
    cleanup();
    const check = a.model.hold((url, method) => method === "GET" && url.pathname.includes("/commands/"));
    const todays = a.todayReply.mock.calls.length;
    render(<App />);
    await check.entered;
    await screen.findByRole("heading", testScreen, exchange);
    await settled();
    expect(a.todayReply.mock.calls.length).toBe(todays);
    expect(screen.queryByRole("navigation", navigation)).toBeNull();
    check.release(); lost.release();
  });

  it("A8 the summary's «На Сегодня» closes the session and shows a fresh Today with its navigation", async () => {
    const a = app({ sessions: [active({ status: "summary", assignment: null })], reported: S1 });
    render(<App />);
    await screen.findByText("Итог спряжений", undefined, exchange);
    const todays = a.todayReply.mock.calls.length;
    a.server.session = null;
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByRole("navigation", navigation, exchange);
    expect(a.todayReply.mock.calls.length).toBeGreaterThan(todays);
    expect(a.model.posted.map(post => [post.kind, post.payload])).toEqual([["session.stop", { reason: "summary_home" }]]);
  });

  it("A9 a return from the background keeps the same session and form; no new start", async () => {
    const a = app();
    render(<App />);
    fireEvent.click(await startButton());
    fireEvent.change(await editable(), { target: { value: "komm" } });
    a.server.session = a.starts()[0].session_id;
    const opens = a.openReply.mock.calls.length;
    await foreground();
    await waitFor(() => expect(a.openReply.mock.calls.length).toBeGreaterThan(opens));
    await settled();
    expect((await editable()).value).toBe("komm");
    expect(a.starts()).toHaveLength(1); expect(a.kinds()).toEqual(["session.start", "assignment.present"]);
  });

  it("A10 a closure at midnight during the test keeps the closed screen with its reason; Back returns to Today", async () => {
    const a = app({ sessions: [active()], reported: S1 });
    render(<App />);
    await editable();
    a.model.close(S1, "midnight"); a.server.session = null;
    await foreground();
    await screen.findByText("Занятие закрыто: начался новый день", undefined, exchange);
    const todays = a.todayReply.mock.calls.length;
    await settled();
    expect(a.todayReply.mock.calls.length).toBe(todays); expect(a.model.posted).toEqual([]);
    await a.back.click();
    await screen.findByRole("navigation", navigation, exchange);
    expect(a.model.posted).toEqual([]);
  });

  it.each<[Language, RegExp, string]>([["uk", /Тест відмінювання/, "Тест дієвідмін"], ["en", /Conjugation quiz/, "Conjugation test"]])(
    "A12 %s: the existing button and screen titles", async (language, button, title) => {
      app({ language });
      render(<App />);
      fireEvent.click(await startButton(button));
      await screen.findByRole("heading", { name: title, level: 1 }, exchange);
    });
});

describe("the launch card over a conjugation session (answer S01)", () => {
  const LAUNCH = cardIdOf(3);
  it("A6 the card opens first and the form is not confirmed under it; Back shows the same form and confirms it once", async () => {
    launch(`?card=${LAUNCH}`);
    const a = app({ sessions: [active({ presented: false })], reported: S1 });
    const card = serveLaunchCard(a.fetcher as never, LAUNCH, { learning: true });
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(card.origins()).toEqual(["?origin=message"]);
    await waitFor(() => expect(a.fetcher.mock.calls.some(([, init]) => init?.method === "POST"
      && JSON.parse(String(init.body)).kind === "context.open")).toBe(true));
    await settled();
    expect(screen.queryByRole("heading", testScreen)).toBeNull(); expect(a.model.posted).toEqual([]);
    await a.back.click();
    await editable(); await settled();
    expect(screen.getByText("kommen")).toBeTruthy();
    expect(a.kinds()).toEqual(["assignment.present"]);
    const posted = a.fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init!.body)).kind as string)
      .filter(kind => kind === "context.open" || kind === "context.close");
    expect(posted).toEqual(["context.open", "context.close"]);
    expect(besidesContext(a.kinds())).toEqual(["assignment.present"]);
    expect(a.todayReply).not.toHaveBeenCalled();
  });
});
