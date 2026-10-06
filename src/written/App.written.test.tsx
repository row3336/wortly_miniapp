import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import { App } from "../app/App";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { deferred, id, profile, response, writtenServer, type ServerOptions } from "./writtenFixtures.test-support";

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
/** The server commits the next command of this kind, but its reply is lost (a timeout after commit). */
function loseReply(a: ReturnType<typeof app>, kind: string) {
  const base = a.fetcher.getMockImplementation()!;
  let lost = false;
  a.fetcher.mockImplementation(async (url, init) => {
    if (lost || init?.method !== "POST" || JSON.parse(String(init.body)).kind !== kind) return base(url, init);
    lost = true; await a.server.handle(url as RequestInfo, init); throw new TypeError("network");
  });
}
/** Requests of the document rendered after `mark` calls, as «METHOD path». */
const requests = (a: ReturnType<typeof app>, mark: number) => a.fetcher.mock.calls.slice(mark)
  .map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`);

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

  it("В02 a new document of the same client continues the open session at its server step, without the old correction", async () => {
    const a = app({ cards: [6, 7, 8] });
    const first = render(<App />);
    await startWords(); await answer("falsch");
    expect(screen.getByRole("button", { name: "Исправить ответ" })).toBeTruthy();
    first.unmount();
    const mark = a.fetcher.mock.calls.length, sessionId = a.server.state.sessionId!, posts = a.posts().length;
    render(<App />);
    await screen.findByText("слово 7");
    await waitFor(() => expect(field().readOnly).toBe(false));
    // The step comes from the projection; no result, correction or undo of the old document comes with it (TA:48).
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Предыдущий ответ" })).toBeNull();
    expect(screen.queryByText(pairText)).toBeNull(); expect(screen.queryByText("Вход подтверждён")).toBeNull();
    expect(requests(a, mark)).toContain(`GET /api/v1/sessions/${sessionId}`);
    expect(a.posts().slice(posts).map(post => [post.kind, post.session_id, post.assignment_id]))
      .toEqual([["assignment.present", sessionId, id(7)]]);
    expect(a.back.bound).toBe(1);
  });

  it("В02 a closed written session is never resumed, even when an open still reports it", async () => {
    const a = app(); const first = render(<App />);
    await startWords(); await a.back.click();
    await screen.findByText("Занятие прервано.");
    first.unmount();
    const mark = a.fetcher.mock.calls.length, sessionId = a.server.state.sessionId!, posts = a.posts().length;
    const opened = a.openReply.getMockImplementation()!;
    a.openReply.mockImplementationOnce(async body => response({ ...await (await opened(body)).json(), session: { id: sessionId, phase: "active" } }));
    render(<App />);
    await screen.findByText(pairText);
    expect(screen.queryByText("Занятие прервано.")).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
    expect(a.posts()).toHaveLength(posts);
    expect(requests(a, mark).filter(request => request.includes("/commands/"))).toEqual([]);
    expect(requests(a, mark).filter(request => request.endsWith("/client/open")).length).toBeGreaterThan(1);
  });

  it("В02 an unknown present of the old document is resolved by its own ID before any change; nothing is issued again (CT:109)", async () => {
    const a = app({ cards: [6, 7] }); const first = render(<App />);
    await startWords(); await answer("Haus");
    loseReply(a, "assignment.present");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    // B stays visible and unconfirmed; only a check of the same ID is offered.
    await screen.findByRole("button", { name: "Проверить состояние" });
    expect(screen.getByText("слово 7")).toBeTruthy();
    const lost = a.posts().at(-1)!;
    expect([lost.kind, lost.assignment_id]).toEqual(["assignment.present", id(7)]);
    first.unmount();
    const mark = a.fetcher.mock.calls.length, posts = a.posts().length;
    render(<App />);
    await screen.findByText("слово 7");
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(a.posts()).toHaveLength(posts);
    await answer("Haus");
    const later = requests(a, mark), check = later.indexOf(`GET /api/v1/commands/${lost.command_id}`);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(later.indexOf("POST /api/v1/commands"));
    expect(a.posts().slice(posts).map(post => post.kind)).toEqual(["answer.submit"]);
    expect(a.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });

  it("В02 an unknown correction of the old document is resolved by its own ID before any change, never sent again (CT:109)", async () => {
    const a = app({ cards: [6, 7] }); const first = render(<App />);
    await startWords(); await answer("falsch");
    loseReply(a, "result.correct");
    fireEvent.click(screen.getByRole("button", { name: "Исправить ответ" }));
    await screen.findByText("Проверяем изменение");
    const lost = a.posts().at(-1)!;
    expect(lost.kind).toBe("result.correct");
    first.unmount();
    const mark = a.fetcher.mock.calls.length, posts = a.posts().length;
    render(<App />);
    await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/commands/${lost.command_id}`));
    await screen.findByText("слово 7");
    await waitFor(() => expect(field().readOnly).toBe(false));
    const later = requests(a, mark);
    expect(later.indexOf(`GET /api/v1/commands/${lost.command_id}`)).toBeLessThan(later.indexOf("POST /api/v1/commands"));
    expect(a.posts().slice(posts).map(post => post.kind)).toEqual(["assignment.present"]);
    expect(a.kinds().filter(kind => kind === "result.correct")).toHaveLength(1);
    expect([...a.server.results.values()].map(item => item.grade)).toEqual([4]);
  });

  it("В02 a start refused as SESSION_BUSY leads to the busy Today; a confirmed remote stop there returns to a fresh Today", async () => {
    const a = app({ refuseStart: "SESSION_BUSY" }), other = id(60), remote = { busy: false };
    const base = a.fetcher.getMockImplementation()!;
    a.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith("/client/open") && remote.busy) return response({ status: "SESSION_BUSY", profile: profile(String(a.server.state.version)),
        compatibility, session: { status: "busy", stop_remote_target: other } });
      if (!path.endsWith("/commands") || body?.kind !== "session.stop_remote") return base(url, init);
      remote.busy = false; a.server.state.version++;
      return response({ command: { id: body.command_id, kind: body.kind, status: "applied", target_id: other, applied_at: "2026-10-05T12:00:00Z",
        action_id: null, result_id: null, context_id: null, object_version: null },
        current: { session_id: other, status: "closed", close_reason: "remote_stop" }, state_version: String(a.server.state.version) });
    });
    render(<App />);
    await screen.findByText(pairText);
    await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false));
    // Another device opened its session after this document entered.
    remote.busy = true;
    fireEvent.click(row(/Слова: перевод на немецкий/));
    await screen.findByText("Занятие открыто на другом устройстве");
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByRole("heading", { name: "Занятие на другом устройстве" });
    expect(a.kinds()).toEqual(["session.start"]);
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" }));
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие" }));
    await screen.findByText(pairText);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Занятие на другом устройстве" })).toBeNull());
    expect(a.posts().map(post => [post.kind, post.session_id, post.payload]))
      .toEqual([["session.start", expect.any(String), { mode: "written", bucket: "words" }], ["session.stop_remote", other, { confirmed: true }]]);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
