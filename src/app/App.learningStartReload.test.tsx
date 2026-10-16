import { withJournalIntake } from "../journal/intake.test-support";
// 35.1-А (C204/C205) through the actual App. Each test names its page explicitly: a remount of App in the same JS
// document keeps its page (learningPage), a full reload or another window gets a new one. A render alone is neither.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, SettingsResponse, TodayResponse } from "../api/generated";
import { LearningPageStarts } from "../learning/learningPageStarts";
import { learningViewFixture } from "../learning/learningView.test-support";
import { closed, profile, response } from "../learning/learningFixtures.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { lsPendingRaw } from "../commands/lsPending.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const LSLOT = "wortly.pending.learning_session";
const compatibility = { compatible: true, contract_version: "1" };
const exchange = { timeout: 5000 };
const RETRY = "Повторить отправку";
const settled = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(done => setTimeout(done, 20)); }); };

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 4, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
/**
 * The synthetic core of these tests. lose: the next start's reply is lost, "before" the core saw it (nothing created)
 * or "after" it (the session exists). refuse: the next open is refused with 403.
 */
function server() {
  const f = learningViewFixture("normal", null); f.view.dispose(); f.owner.dispose();
  let version = 1n;
  // stopClosed: Stop of a session this core never had is refused as SESSION_CLOSED; true answers with its closed projection.
  const control = { lose: null as null | "before" | "after", refuse: false, stopClosed: false };
  const account = (): Profile => profile(String(version));
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const known = new Set<string>(), sessions = new Set<string>();
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const parsed = new URL(String(url), "http://localhost"), path = parsed.pathname, method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-02T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) {
      if (control.refuse) { control.refuse = false; return response({ error: { code: "FORBIDDEN" } }, 403); }
      return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
        document_id: body.document_id, proof_version: "1", document_epoch: "1", session: null });
    }
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(version) } as SettingsResponse);
    const lose = method === "POST" && body.kind === "session.start" ? control.lose : null;
    if (lose) control.lose = null;
    if (lose === "before") throw new TypeError("synthetic network loss");
    if (method === "POST" && body.kind === "session.start") { known.add(body.command_id); sessions.add(body.session_id); }
    if (method === "POST" && body.kind === "session.stop" && !sessions.has(body.session_id)) {
      // The core's refusal (study/sessions.py:376): nothing is written, the start of that session is not cancelled.
      const current = control.stopClosed ? { ...closed(), session_id: body.session_id } : { session_id: body.session_id, status: "not_found" };
      return response({ command: { id: body.command_id, status: "rejected" }, current, state_version: String(version),
        error: { code: "SESSION_CLOSED" } }, 409);
    }
    // A command or a session this core never received is unknown here.
    if (method === "GET" && path.includes("/commands/") && !known.has(path.split("/").at(-1)!)) {
      return response({ state_version: String(version), current: account(), command: { id: path.split("/").at(-1)!, status: "not_found" } });
    }
    if (method === "GET" && path.includes("/sessions/") && !sessions.has(path.split("/").at(-1)!)) {
      return response({ current: { session_id: path.split("/").at(-1)!, status: "not_found" }, state_version: String(version) });
    }
    const reply = await f.handler(url, init);
    const value = await reply.clone().json().catch(() => null) as { state_version?: unknown } | null;
    if (method === "POST") version++;
    if (typeof value?.state_version === "string" && BigInt(value.state_version) > version) version = BigInt(value.state_version);
    if (lose === "after") throw new TypeError("synthetic reply loss");
    if (typeof value?.state_version !== "string") return reply;
    return response({ ...value, state_version: String(version) }, reply.status);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))
    .map(([, init]) => { const b = JSON.parse(String(init!.body)); return `${b.kind}:${b.command_id}:${b.session_id}`; });
  const cancels = () => fetcher.mock.calls.filter(([, init]) => String(init?.body ?? "").includes("cancel_start")).length;
  const checks = () => fetcher.mock.calls.filter(([url, init]) => (init?.method ?? "GET") === "GET"
    && /\/(commands|sessions)\//.test(String(url))).length;
  return { control, posts, checks, cancels };
}
const foreground = () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
};
/** One page loses the reply of its start; the record of it stays on the device. */
async function lostStart(page: LearningPageStarts, lose: "before" | "after") {
  const s = server(); render(<App learningPage={page} />);
  const start = await screen.findByRole("button", { name: /Новая группа слов/ }, exchange); await settled();
  s.control.lose = lose; fireEvent.click(start); await settled(10);
  expect(s.posts()).toHaveLength(1);
  const stored = JSON.parse(lsPendingRaw(LSLOT)!);
  expect(stored.intent.kind).toBe("session.start");
  return { s, first: s.posts()[0] };
}
const retryButton = () => screen.queryByRole("button", { name: RETRY });

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "200000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState(null, "", "/");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("App Learning 35.1-А: the start of another page is only checked", () => {
  it("a full reload (a new page) checks the start by its ID and never offers or sends it again", async () => {
    const { s, first } = await lostStart(new LearningPageStarts(), "before");
    cleanup();
    const checksBefore = s.checks();
    render(<StrictMode><App learningPage={new LearningPageStarts()} /></StrictMode>); await settled(20);
    expect(s.checks()).toBeGreaterThan(checksBefore);
    expect(retryButton()).toBeNull();
    expect(screen.getByRole("button", { name: "Проверить состояние" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await settled(10);
    expect(retryButton()).toBeNull();
    expect(s.posts()).toEqual([first]);
    // The record waits for a definite answer: not_found clears nothing.
    expect(JSON.parse(lsPendingRaw(LSLOT)!).intent.command_id).toBe(first.split(":")[1]);
  });

  it("a full reload restores the session its check finds, by the same ID, without a POST", async () => {
    const { s, first } = await lostStart(new LearningPageStarts(), "after");
    cleanup(); render(<App learningPage={new LearningPageStarts()} />); await settled(20);
    expect(s.posts()).toEqual([first]);
    expect(retryButton()).toBeNull();
    expect(await screen.findByRole("button", { name: "Дальше" }, exchange)).toBeTruthy();
    expect(lsPendingRaw(LSLOT)).toBeNull();
  });

  it("an App remount in the same page (StrictMode, new storage wrapper) is no reload: the explicit retry stays", async () => {
    const page = new LearningPageStarts();
    const { s, first } = await lostStart(page, "before");
    cleanup(); render(<StrictMode><App learningPage={page} /></StrictMode>); await settled(20);
    const retry = await screen.findByRole("button", { name: RETRY }, exchange);
    fireEvent.click(retry); await settled(10);
    expect(s.posts()).toEqual([first, first]);
  });

  it("production default without the prop: an App remount keeps the module page, a fresh module graph (reload) has none", async () => {
    // The app itself passes no page: the module instance of this JS document. A reload is modelled by a new module graph.
    const s = server(); render(<App />);
    const start = await screen.findByRole("button", { name: /Новая группа слов/ }, exchange); await settled();
    s.control.lose = "before"; fireEvent.click(start); await settled(10);
    const first = s.posts()[0];
    cleanup(); render(<App />); await settled(15);
    expect(await screen.findByRole("button", { name: RETRY }, exchange)).toBeTruthy();
    cleanup();
    const checksBefore = s.checks();
    vi.resetModules();
    const RTL = await import("@testing-library/react"), React = await import("react"), fresh = await import("./App");
    // C163 integration: the fresh module graph gets the same installation database (a reload keeps the origin's IndexedDB).
    (await import("./installationApp.test-support")).installAppInstallationStore((await import("./installationProvider")).installationProvider);
    const pause = async (n: number) => { for (let i = 0; i < n; i++) await RTL.act(async () => { await new Promise(done => setTimeout(done, 20)); }); };
    const view = RTL.render(React.createElement(fresh.App)); await pause(25);
    expect(s.checks()).toBeGreaterThan(checksBefore);
    expect(RTL.screen.queryByRole("button", { name: RETRY })).toBeNull();
    RTL.fireEvent.click(RTL.screen.getByRole("button", { name: "Проверить состояние" })); await pause(10);
    expect(RTL.screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(s.posts()).toEqual([first]);
    view.unmount();
  });

  it("C229: «Выйти» for the start of another page refused as SESSION_CLOSED without a closed projection says nothing of a closure", async () => {
    const { s, first } = await lostStart(new LearningPageStarts(), "before");
    cleanup(); render(<App learningPage={new LearningPageStarts()} />); await settled(20);
    const record = lsPendingRaw(LSLOT);
    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }, exchange)); await settled(15);
    expect(s.posts().filter(post => post.startsWith("session.stop"))).toHaveLength(1);
    // The core never had Y (current not_found): its refusal proves no closure, so the existing neutral text is shown.
    expect(screen.queryByText("Занятие завершено.")).toBeNull();
    expect(screen.getByText("Не удалось обновить занятие.")).toBeTruthy();
    // The start record, its ID, the rights and the route stay; no start, no cancel, no navigation.
    expect(lsPendingRaw(LSLOT)).toBe(record);
    expect(s.posts().filter(post => post.startsWith("session.start"))).toEqual([first]);
    expect(s.cancels()).toBe(0);
    expect(screen.getByRole("heading", { name: "Изучение слов" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    expect(retryButton()).toBeNull();
  });

  it("C229 control: a refusal carrying the closed projection of Y keeps today's closure (the view ends, Today follows)", async () => {
    const { s } = await lostStart(new LearningPageStarts(), "before");
    cleanup(); render(<App learningPage={new LearningPageStarts()} />); await settled(20);
    s.control.stopClosed = true;
    fireEvent.click(await screen.findByRole("button", { name: "Выйти" }, exchange)); await settled(15);
    expect(s.posts().filter(post => post.startsWith("session.stop"))).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /Новая группа слов/ }, exchange)).toBeTruthy();
    expect(screen.queryByText("Не удалось обновить занятие.")).toBeNull();
    expect(s.cancels()).toBe(0);
  });

  // P03 M-P03-10 (§4.13 В, AC-102): after the 403 (Z5: session and document reset) the window's «Попробовать ещё раз»
  // is blocked until Я19 — the same page signs in and opens no more; the lost start stays pending (nothing is resent).
  it("after a 403 in the same page the retry is blocked until Я19: no re-entry, the lost start is not resent", async () => {
    const page = new LearningPageStarts();
    const { s, first } = await lostStart(page, "before");
    s.control.refuse = true; foreground(); await settled(10);
    const again = await screen.findByRole("button", { name: "Попробовать ещё раз" }, exchange) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again); await settled(15);
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    expect(s.posts()).toEqual([first]);
  });
});
