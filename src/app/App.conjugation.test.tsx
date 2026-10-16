import { withJournalIntake } from "../journal/intake.test-support";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import { conjugationId as id, conjugationServer, FORMS, type ModelSession } from "../conjugation/conjugationModel.test-support";
import { cardIdOf } from "../dictionary/card/cardTestData.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { activeButton } from "./gateButton.test-support";
import { gate, replaceDocument, watchFlash } from "./flashWatch.test-support";
import { commandPosts, enabledExits, foregroundOpen, loseReply as loseStudyReply, moveWithout, noLandings, pairMoved,
  settle as pause, watchCommits } from "./pairMoved.test-support";
import { besidesContext, launch, serveLaunchCard } from "./launchCard.test-support";
import { pageGateOpen } from "./pageGate.test-support";
import { lsPendingRaw } from "../commands/lsPending.test-support";

/** The mode matrix below runs every suite plain and under StrictMode, as src/main.tsx does in development. */
let strict = false;
const root = () => strict ? <StrictMode><App /></StrictMode> : <App />;
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
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
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

describe.each([["StrictMode", true], ["plain render", false]])("App (%s)", (_name, strictMode) => {
  beforeEach(() => { strict = strictMode; });
  describe("the conjugation test through the actual App document", () => {
    it("A1 Today's «Тест спряжений» opens the test without the bottom navigation; one answer is one command", async () => {
      const a = app();
      render(root());
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
      render(root());
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
      render(root());
      await screen.findByText(/Готово: 0/, undefined, exchange);
      expect(screen.queryByRole("button", { name: /Тест спряжений/ })).toBeNull();
      cleanup();
      const a = app({ transitionMode: null });
      render(root());
      const button = await screen.findByRole("button", { name: /Тест спряжений/ }, exchange) as HTMLButtonElement;
      await settled();
      expect(button.disabled).toBe(true);
      fireEvent.click(button); await settled();
      expect(a.model.posted).toEqual([]); expect(screen.queryByRole("heading", testScreen)).toBeNull();
    });

    it("A3 a restart with an open session continues at its shown form: nothing is sent, no «Вход подтверждён», no Today", async () => {
      const a = app({ sessions: [active()], reported: S1 });
      render(root());
      await screen.findByRole("heading", testScreen, exchange);
      await editable(); await settled();
      expect(screen.getByText("kommen")).toBeTruthy();
      expect(a.model.posted).toEqual([]); expect(screen.queryByText("Вход подтверждён")).toBeNull();
      expect(a.todayReply).not.toHaveBeenCalled();
    });

    // The mode read itself opens the route (ApplicationDocument start("conjugation")); the host's claim of an open session
    // is only a fallback that needs the host's own read, so it cannot stand in for it while that read is still under way.
    it("A3 a restart with an open session opens the test route from the mode read, before the host has read the session", async () => {
      const a = app({ sessions: [active()], reported: S1 });
      // The host's read is the first session read made once the test route is on screen (the mode read opens the route;
      // StrictMode repeats the mode read's setup, so counting reads would hold the wrong one). Holding it keeps the host's
      // snapshot unsettled, so its claim cannot open the route.
      const hostRead = a.model.hold((url, method) => method === "GET" && url.pathname.includes("/sessions/")
        && document.querySelector("h1")?.textContent !== "Сегодня");
      render(root());
      await hostRead.entered;
      await settled();
      expect(screen.getByRole("heading", testScreen)).toBeTruthy();
      expect(screen.queryByRole("navigation", navigation)).toBeNull();
      hostRead.release();
      await editable();
      expect(a.model.posted).toEqual([]);
    });

    it("A4 a restart with a prefetched form confirms its display exactly once, after it is shown", async () => {
      const a = app({ sessions: [active({ presented: false })], reported: S1 });
      render(root());
      await editable(); await settled();
      expect(a.kinds()).toEqual(["assignment.present"]);
      expect(a.model.posted[0]).toMatchObject({ session_id: S1, assignment_id: FORMS[0] });
    });

    // Q29 (owner's answer 12.10, variant 1; was «5.1.1» of D-CONJ-HOST): a refused start stays on the module's screen until
    // the person leaves it; here a return from the background (a new access, so a new owner without that session) leads
    // back to Today (no SESSION_BUSY: the window has no other device's session).
    it("A5 a refused start stays on the test screen; after a foreground Today offers a new start with another session ID", async () => {
      const a = app();
      a.model.server.rejectStart = "NO_MATERIAL";
      render(root());
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

    // C085: an explicit Back is the one way out of a refused start; it clears, cancels and starts nothing.
    it("A5 native Back after a refused start shows a fresh Today that stays; a new tap starts another session", async () => {
      const a = app();
      a.model.server.rejectStart = "NO_MATERIAL";
      render(root());
      fireEvent.click(await startButton());
      await screen.findByText("Не удалось обновить занятие.", undefined, exchange);
      await settled();
      const todays = a.todayReply.mock.calls.length;
      await a.back.click();
      await screen.findByRole("navigation", navigation, exchange);
      await settled();
      expect(screen.queryByRole("heading", testScreen)).toBeNull();
      expect(a.todayReply.mock.calls.length).toBeGreaterThan(todays); expect(a.model.posted).toHaveLength(1);
      fireEvent.click(await startButton());
      await editable();
      expect(a.starts()).toHaveLength(2); expect(a.starts()[1].session_id).not.toBe(a.starts()[0].session_id);
    });

    it("A7 an own unconfirmed start of an earlier document is shown before Today, and Today waits until it is resolved", async () => {
      const a = app();
      render(root());
      const lost = a.model.hold((url, method) => method === "POST" && url.pathname.endsWith("/commands"));
      fireEvent.click(await startButton());
      await lost.entered;
      cleanup();
      const check = a.model.hold((url, method) => method === "GET" && url.pathname.includes("/commands/"));
      const todays = a.todayReply.mock.calls.length;
      render(root());
      await check.entered;
      await screen.findByRole("heading", testScreen, exchange);
      await settled();
      expect(a.todayReply.mock.calls.length).toBe(todays);
      expect(screen.queryByRole("navigation", navigation)).toBeNull();
      check.release(); lost.release();
    });

    it("A8 the summary's «На Сегодня» closes the session and shows a fresh Today with its navigation", async () => {
      const a = app({ sessions: [active({ status: "summary", assignment: null })], reported: S1 });
      render(root());
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
      render(root());
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
      render(root());
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
        render(root());
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
      render(root());
      await screen.findByText("В очереди на изучение", undefined, exchange);
      // StrictMode repeats the card document's setup: the first controller is disposed at once, and both read the same origin.
      expect(card.origins()).toEqual(strict ? ["?origin=message", "?origin=message"] : ["?origin=message"]);
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
});

// Answer 17.1-А (R1): the pair moved to uk on another device and this window's start made the conjugation test in uk-de;
// the window refreshes its access by itself (one client/open) and shows that test.
describe("conjugation R1: the window refreshes itself into the session of the new pair (17.1-А)", () => {
  it.each([false, true])("lost reply %s: one client/open, the uk question, its answer and Stop of that session", async lose => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(); const opens = world.opens.length, mark = a.fetcher.mock.calls.length;
    world.moved = true; if (lose) loseStudyReply(a.fetcher, "session.start");
    fireEvent.click(start);
    if (lose) {
      const check = await screen.findByRole("button", { name: "Проверить статус" }, exchange);
      await pause(1000); expect(world.opens.slice(opens)).toEqual([]);
      expect(check).toBeTruthy();
      fireEvent.click(await activeButton("Проверить статус", exchange)); // C335: pressed once the gate lets it
    }
    const field = await screen.findByRole("textbox", undefined, exchange) as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false));
    await pause(500);
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    fireEvent.change(field, { target: { value: "kommst" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" })); await pause(1000);
    fireEvent.click(screen.getByRole("button", { name: "Завершить" })); await pause(1500);
    expect(commandPosts(a.fetcher, mark).map(post => [post.kind, post.session_id])).toEqual([["session.start", world.started],
      ["assignment.present", world.started], ["answer.submit", world.started], ["session.stop", world.started]]);
  });
  // C178 (a): the server proved the created session open in another pair; that is a known fact, not a failed update, so
  // no failure text is shown from the tap until the landing, neither for a direct reply nor after the check of a lost one.
  it.each([false, true])("lost reply %s: no failure text for the known pair change, one client/open, the same session", async lose => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(); const opens = world.opens.length, mark = a.fetcher.mock.calls.length;
    const failure = ["Не удалось обновить занятие", "Не вдалося оновити заняття"];
    world.moved = true; if (lose) loseStudyReply(a.fetcher, "session.start");
    fireEvent.click(start);
    let shown: { seen: string[]; stop(): void };
    if (lose) {
      // The lost reply itself is a real unknown: its own lines stay until the check.
      const check = await screen.findByRole("button", { name: "Проверить статус" }, exchange);
      await pause(500); expect(world.opens.slice(opens)).toEqual([]);
      expect(check).toBeTruthy();
      const active = await activeButton("Проверить статус", exchange); // C335: pressed once the gate lets it
      shown = watchCommits(failure); fireEvent.click(active);
    } else shown = watchCommits(failure);
    try {
      const field = await screen.findByRole("textbox", undefined, exchange) as HTMLTextAreaElement;
      await waitFor(() => expect(field.readOnly).toBe(false)); await pause(500);
    } finally { shown.stop(); }
    expect(shown.seen).toEqual([]);
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    expect(commandPosts(a.fetcher, mark).map(post => [post.kind, post.session_id])).toEqual([["session.start", world.started],
      ["assignment.present", world.started]]);
  });
  // P03 M-P03-10 (К-11 ВР-1/ВР-5): the lost refresh is recovered by one foreground after the gate's ready, not by hand.
  it("a refresh lost by the transport is recovered by one foreground after ready (К-11) into the same session", async () => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(); const mark = a.fetcher.mock.calls.length;
    world.moved = true; const open = foregroundOpen(a.fetcher, "fail");
    fireEvent.click(start);
    const field = await screen.findByRole("textbox", undefined, exchange) as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false));
    expect(open.attempts).toBe(2);
    expect(screen.queryByRole("button", { name: "Попробовать ещё раз" })).toBeNull();
    expect(commandPosts(a.fetcher, mark).map(post => [post.kind, post.session_id])).toEqual([["session.start", world.started],
      ["assignment.present", world.started]]);
  });
  // StrictMode (with the conjugation StrictMode fix, fbc7566): the refresh is asked once and the window lands in the
  // created session as without StrictMode: its question is answerable, and nothing but its start and present is sent.
  it("StrictMode direct reply: one client/open, the answerable question of the same session, no other start and no Stop", async () => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<StrictMode><App /></StrictMode>); const start = await startButton();
    const opens = world.opens.length, mark = a.fetcher.mock.calls.length;
    world.moved = true; fireEvent.click(start);
    const field = await screen.findByRole("textbox", undefined, exchange) as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false));
    await pause(1000);
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    expect(commandPosts(a.fetcher, mark).map(post => [post.kind, post.session_id])).toEqual([["session.start", world.started],
      ["assignment.present", world.started]]);
  });
  // QA-R1-V3 F3 (QA-C3): a start in the window's own pair is no R1, also after a lost reply and its check by ID.
  it.each([false, true])("own pair (lost reply %s): no refresh, the session of this pair", async lose => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(); const opens = world.opens.length, mark = a.fetcher.mock.calls.length;
    if (lose) loseStudyReply(a.fetcher, "session.start");
    fireEvent.click(start);
    if (lose) {
      // P03 (L2, M-P03-4): the lost reply closed the page gate; the check comes once the connection is back, so the
      // presentation that follows it is not kept on the client. M-P03-10 (C335): until then the button is inactive.
      await pageGateOpen();
      fireEvent.click(await activeButton("Проверить статус", exchange));
    }
    const field = await screen.findByRole("textbox", undefined, exchange) as HTMLTextAreaElement;
    await waitFor(() => expect(field.readOnly).toBe(false)); await pause(2500);
    expect(world.opens.slice(opens)).toEqual([]);
    expect(commandPosts(a.fetcher, mark).map(post => post.kind)).toEqual(["session.start", "assignment.present"]);
  });
  // C151 forks: a reply below the floor, a reply naming another session, and a refresh that finds the created session
  // closed, another session open or the pair changed again. None is this start's R1 landing: no refresh into it, no new
  // start, no Stop of any session, and the test is never shown. The refresh asks once; the second open after it is the
  // new owner's existing return to Today (idle → onToday → synchronize).
  it.each(noLandings)("no landing (%s): no second start, no Stop, the created session is not shown", async kind => {
    const a = app(); const world = pairMoved(a.fetcher); world.low = kind === "low";
    render(<App />); const start = await startButton(); const opens = world.opens.length, mark = a.fetcher.mock.calls.length;
    moveWithout(world, kind); fireEvent.click(start);
    await pause(3000);
    expect(world.opens.slice(opens)).toEqual(kind === "low" || kind === "foreign" ? [] : ["foreground", "foreground"]);
    expect(commandPosts(a.fetcher, mark).map(post => post.kind)).toEqual(["session.start"]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(enabledExits()).toEqual([]);
    // A reply below the floor is a real failed update: its failure text stays (C178 hides only the known pair change).
    if (kind === "low") expect(screen.getAllByText(/Не удалось обновить занятие/).length).toBeGreaterThan(0);
  });
});

// D-STALE-WINDOW 3.1.14 (2.33): an answer of a replaced window refused with the core's envelope shows no refusal.
describe("the conjugation test while the window checks its document", () => {
  it("replaced window: an answer refused as DOCUMENT_STALE keeps its record and never shows a refusal on any screen update", async () => {
    const a = app({ sessions: [active()], reported: S1 });
    vi.stubGlobal("Telegram", { WebApp: { ...(window as unknown as { Telegram: { WebApp: object } }).Telegram.WebApp, close: vi.fn() } });
    render(<App />);
    const input = await editable();
    fireEvent.change(input, { target: { value: "kommst" } });
    const hold = gate(), r = replaceDocument(a.fetcher, hold.promise), watch = watchFlash(document.body);
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(r.foregrounds()).toBe(1));
    await settled();
    expect(watch.seen).toEqual([]);
    expect(JSON.parse(lsPendingRaw("wortly.pending.conjugation_session")!).intent).toMatchObject({ kind: "answer.submit" });
    await act(async () => { hold.open(); }); await settled();
    await screen.findByRole("heading", { name: "Wortly уже открыт" });
    watch.stop();
    expect(watch.seen).toEqual([]);
    // One answer POST, refused by the core before the model: nothing more is sent after the refusal.
    expect(a.fetcher.mock.calls.filter(([, init]) => init?.method === "POST" && JSON.parse(String(init.body)).kind === "answer.submit"))
      .toHaveLength(1);
  });
});

// race_fix (A-SETTINGS-RACE, ApplicationDocument: Settings are read at least as new as every mode seed, C153/C159; QA-FINAL
// Q3, C245): a restart with an open conjugation session reads Settings and the session separately, and another write of
// the profile can land between those reads. The pair stays the chosen one; only the version moves.
describe("conjugation: a profile write between the Settings read and the session read of a new document (race_fix)", () => {
  it("re-reads Settings and keeps the resumed form answerable; nothing is sent", async () => {
    const a = app({ sessions: [active()], reported: S1 });
    const base = a.fetcher.getMockImplementation()!;
    let bumped = false, settingsReads = 0;
    a.fetcher.mockImplementation(async (url, init) => {
      const reply = await base(url, init);
      if ((init?.method ?? "GET") === "GET" && new URL(String(url), "http://localhost").pathname.endsWith("/settings")) {
        settingsReads++;
        if (!bumped) { bumped = true; a.model.bump(); }
      }
      return reply;
    });
    render(<App />);
    await screen.findByRole("heading", testScreen, exchange);
    await editable();
    expect(bumped).toBe(true);
    expect(settingsReads).toBeGreaterThanOrEqual(2);
    expect(a.model.posted).toEqual([]);
  });
});
