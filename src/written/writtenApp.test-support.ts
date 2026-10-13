import { withJournalIntake } from "../journal/intake.test-support";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { id, response, writtenServer, type ServerOptions } from "./writtenFixtures.test-support";

// The real App over one synthetic server, shared by the App-level written tests.
type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
export const compatibility = { compatible: true, contract_version: "1" };
/** The written host refusal; shared so a positive control in one test keeps the absence checks of another from going vacuous. */
export const settingsRefusalText = "Для занятия нужно подтвердить настройки и текущую словарную пару.";
export const pairText = "Активная пара: Русский ↔ Немецкий";

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
export function app(options: ServerOptions & { transitionMode?: "normal" | "accelerated" } = {}) {
  const server = writtenServer(options);
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru";
  stored.settings.transition_mode.value = options.transitionMode ?? "normal";
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
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: haptic }, BackButton: back.api } });
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))
    .map(([, init]) => JSON.parse(String(init!.body)));
  return { server, openReply, todayReply, fetcher, posts, kinds: () => posts().map(post => post.kind), back, haptic };
}
export const row = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
export const field = () => screen.getByRole("textbox") as HTMLTextAreaElement;
/** A wait for a screen that follows server exchanges (open, Today, session start): a network-sized bound, not the default 1 s. */
export const exchange = { timeout: 5000 };
export async function startWords() {
  await screen.findByText(pairText, undefined, exchange);
  await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false), exchange);
  fireEvent.click(row(/Слова: перевод на немецкий/));
  await screen.findByText("слово 6", undefined, exchange);
  await waitFor(() => expect(field().readOnly).toBe(false), exchange);
}
export async function answer(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByText(text === "Haus" ? "Верно" : "Есть ошибка", undefined, exchange);
}
/** The server commits the next command of this kind, but its reply is lost (a timeout after commit). */
export function loseReply(a: ReturnType<typeof app>, kind: string) {
  const base = a.fetcher.getMockImplementation()!;
  let lost = false;
  a.fetcher.mockImplementation(async (url, init) => {
    if (lost || init?.method !== "POST" || JSON.parse(String(init.body)).kind !== kind) return base(url, init);
    lost = true; await a.server.handle(url as RequestInfo, init); throw new TypeError("network");
  });
}
/** Requests of the document rendered after `mark` calls, as «METHOD path». */
export const requests = (a: ReturnType<typeof app>, mark: number) => a.fetcher.mock.calls.slice(mark)
  .map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`);

/** Registers the environment every App-level written test needs: clean storage, stubbed limits, unmounted trees. */
export function useWrittenAppEnvironment() {
  beforeEach(() => {
    localStorage.clear();
    vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "200000");
    vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
}
/** The next command of this kind never reaches the server (a timeout before commit). */
export function dropRequest(a: ReturnType<typeof app>, kind: string) {
  const base = a.fetcher.getMockImplementation()!;
  let dropped = false;
  a.fetcher.mockImplementation(async (url, init) => {
    if (dropped || init?.method !== "POST" || JSON.parse(String(init.body)).kind !== kind) return base(url, init);
    dropped = true; throw new TypeError("network");
  });
}

/** Study reads (status checks by ID, session reads) fail like a lost connection until the returned restore is called. */
export function offlineStudy(a: ReturnType<typeof app>) {
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if ((init?.method ?? "GET") === "GET" && (path.includes("/commands/") || path.includes("/sessions/"))) throw new TypeError("network");
    return base(url, init);
  });
  return () => { a.fetcher.mockImplementation(base); };
}
