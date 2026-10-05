import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import { App } from "../app/App";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { deferred, id, response, writtenServer, type ServerOptions } from "./writtenFixtures.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-10-05", status: "work_now",
    base: { total: 5, words: 4, phrases: 1 }, ordinary_status: "ready",
    ordinary: { words: { "l1-de": { ready: 2, next_due_date: null }, "de-l1": { ready: 3, next_due_date: null } },
      phrases: { "l1-de": { ready: 1, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
function fakeBack() {
  const handlers = new Set<() => void>();
  return { api: { show() {}, hide() {}, onClick(handler: () => void) { handlers.add(handler); }, offClick(handler: () => void) { handlers.delete(handler); } },
    get bound() { return handlers.size; }, click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}

/** The real App over one synthetic server: entry, Settings, Today and the written study endpoints. */
function app(options: ServerOptions = {}) {
  const server = writtenServer(options);
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: String(server.state.version), access: { status: "admitted", version: "1", reason: null } });
  const openReply = vi.fn(async (body: { client_instance_id: string; document_id: string }) => response({ status: "opened", profile: account(),
    compatibility, client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1",
    session: server.state.sessionId && server.state.status !== "closed" ? { id: server.state.sessionId, phase: server.state.status } : null }));
  const todayReply = vi.fn(async () => response(today()));
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-06T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return openReply(body);
    if (path.endsWith("/today")) return todayReply();
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(server.state.version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(server.state.version) });
    if (path.includes("/commands") || path.includes("/sessions/")) return server.handle(url as RequestInfo, init);
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  const back = fakeBack(), haptic = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: haptic }, BackButton: back.api } });
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))
    .map(([, init]) => JSON.parse(String(init!.body)));
  return { server, openReply, todayReply, fetcher, posts, kinds: () => posts().map(post => post.kind), back, haptic };
}
const row = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
async function startWords() {
  await screen.findByText(pairText);
  await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false));
  fireEvent.click(row(/Слова: перевод на немецкий/));
  await screen.findByText("слово 6");
  await waitFor(() => expect(field().readOnly).toBe(false));
}
async function answer(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByText(text === "Haus" ? "Верно" : "Есть ошибка");
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "200000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Written quiz through the actual App document", () => {
  it("W1 a tap on the L1→De count starts the written quiz at once; De→L1 rows stay inert", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText);
    expect(row(/Слова: перевод с немецкого/).disabled).toBe(true);
    await startWords();
    expect(a.posts()[0]).toMatchObject({ kind: "session.start", payload: { mode: "written", bucket: "words" } });
    expect(a.kinds()).toEqual(["session.start", "assignment.present"]);
    // The bottom navigation is hidden during the session.
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    expect(a.haptic).toHaveBeenCalledTimes(2); // entry, then the confirmed quiz start
  });

  it("W2 native Back is Exit without confirmation; the own summary (Д02) waits for «На Сегодня», then a fresh Today", async () => {
    const a = app({ cards: [6, 7, 8] }); render(<App />);
    await startWords(); await answer("Haus");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("слово 7");
    await a.back.click();
    await screen.findByText("Занятие прервано.");
    expect(a.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "stop" } });
    expect(Array.from(document.querySelectorAll(".written-summary dd"), item => item.textContent).slice(0, 3)).toEqual(["1", "1", "0"]);
    const reads = a.todayReply.mock.calls.length;
    await a.back.click();
    await screen.findByText(pairText);
    expect(a.todayReply.mock.calls.length).toBeGreaterThan(reads);
    expect(a.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
  });

  it("W3 the natural summary closes with summary_home and returns to Today; completion is signalled once", async () => {
    const a = app({ cards: [6] }); render(<App />);
    await startWords(); await answer("falsch");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Занятие завершено.");
    expect(a.haptic).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText);
    expect(a.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } });
    expect(a.haptic).toHaveBeenCalledTimes(3);
  });

  it("W4 while a sent Stop is awaited, Back stays bound and creates no second Stop (Т96)", async () => {
    const a = app(); render(<App />);
    await startWords();
    const gate = deferred<void>();
    a.fetcher.mockImplementationOnce(async (...call) => { await gate.promise; return a.server.handle(call[0] as RequestInfo, call[1]); });
    await a.back.click();
    await screen.findByText("Завершаем занятие…");
    await a.back.click(); await a.back.click();
    expect(a.back.bound).toBe(1);
    expect(a.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    gate.resolve();
    await screen.findByText("Занятие прервано.");
    expect(a.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
  });

  it("W5 a refused start shows its reason on the written route, signals nothing and Today stays reachable", async () => {
    const a = app({ refuseStart: "SESSION_BUSY" }); render(<App />);
    await screen.findByText(pairText);
    await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false));
    fireEvent.click(row(/Слова: перевод на немецкий/));
    await screen.findByText("Занятие открыто на другом устройстве");
    // Only an accepted start is a haptic milestone (TA §3): the entry signal stays the only one.
    expect(a.haptic).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText);
  });
});
