import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import type { OralCommand } from "../oral/oralIntent";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-10-01", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "ready",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 3, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 2, next_due_date: null } } },
    learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
function oral(step: "presented" | "closed", reason: OralSessionProjection["close_reason"] = "stop"): OralSessionProjection {
  const active = step !== "closed";
  return { session_id: id(3), status: active ? "active" : "closed", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-10-01", bucket: "words", close_reason: active ? null : reason,
    progress: { completed: 0, total: 2, correct: 0, wrong: 0 },
    assignment: active ? { id: id(6), card_id: id(7), status: "presented", kind: "original",
      prompt: { text: "wenn", language: "de", conjunction_hint: null }, revealed: false } : null,
    summary: active ? null : { completed: 0, correct: 0, wrong: 0, ratio: null },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: active ? id(6) : null, grade_target: null, stop: active, summary_home: false } };
}
/** Telegram BackButton double: records click handlers. */
function fakeBack() {
  const handlers = new Set<() => void>();
  return { api: { show() {}, hide() {}, onClick(handler: () => void) { handlers.add(handler); }, offClick(handler: () => void) { handlers.delete(handler); } },
    get bound() { return handlers.size; }, click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}

/** The real App over one synthetic server: entry, Settings, Today and one oral session of this client. */
function app(options: { session?: boolean } = {}) {
  let version = 8n, current: OralSessionProjection | null = options.session ? oral("presented") : null;
  const server = { session: options.session ? id(3) : null as string | null };
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: String(version), access: { status: "admitted", version: "1", reason: null } });
  const openReply = vi.fn(async (body: { client_instance_id: string; document_id: string }) => response({ status: "opened", profile: account(),
    compatibility, client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1",
    session: server.session === null ? null : { id: server.session, phase: "active" } }));
  const todayReply = vi.fn(async () => response(today()));
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-02T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return openReply(body);
    if (path.endsWith("/today")) return todayReply();
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(version) });
    if (path.endsWith("/commands") && init?.method === "POST") {
      const command = body as OralCommand;
      if (command.kind !== "session.stop" || current === null) return response({ error: { code: "UNEXPECTED" } }, 500);
      current = { ...oral("closed", command.payload.reason) }; server.session = null; version++;
      return response({ command: { id: command.command_id, kind: command.kind, status: "applied", applied_at: "2026-10-01T12:00:00Z",
        target_id: command.session_id, action_id: null, result_id: null, context_id: null, object_version: null },
        current, state_version: String(version) });
    }
    if (path.includes("/sessions/")) return response({ current: current ?? { session_id: path.split("/").at(-1), status: "unavailable" },
      state_version: String(version) });
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  const back = fakeBack();
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() }, BackButton: back.api } });
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))
    .map(([, init]) => JSON.parse(String(init!.body)) as OralCommand);
  return { server, openReply, todayReply, fetcher, posts, back,
    close(reason: OralSessionProjection["close_reason"]) { current = oral("closed", reason); server.session = null; version++; },
    /** Another write of the profile (another window's open, an accepted command, calendar maintenance): the version moves. */
    bump() { version++; } };
}
const dd = () => Array.from(screen.getByRole("region", { name: "Итог занятия" }).querySelectorAll("dd"), e => e.textContent);

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Oral host through the actual App document", () => {
  it("A1 an open oral session of this client continues on the oral screen; Back is Exit; the own summary leads to a fresh Today", async () => {
    const a = app({ session: true }); render(<App />);
    await screen.findByText("wenn");
    await waitFor(() => expect((screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(pairText)).toBeNull(); expect(a.back.bound).toBe(1);
    await a.back.click();
    await waitFor(() => expect(dd()).toEqual(["0", "0", "0", "2"]));
    expect(a.posts().map(post => [post.kind, post.payload])).toEqual([["session.stop", { reason: "stop" }]]);
    const opens = a.openReply.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText);
    expect(a.openReply.mock.calls.length).toBeGreaterThan(opens); expect(a.posts()).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Итог занятия" })).toBeNull();
  });

  it("A2 a foreground on the oral route keeps the same session and question without a new start", async () => {
    const a = app({ session: true }); render(<App />);
    await screen.findByText("wenn");
    const opens = a.openReply.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await waitFor(() => expect(a.openReply.mock.calls.length).toBeGreaterThan(opens));
    await waitFor(() => expect((screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("wenn")).toBeTruthy(); expect(screen.queryByText("Занятие ещё не началось.")).toBeNull();
    expect(a.posts()).toEqual([]);
  });

  it("A3 a closure by another cause while on the oral route returns to Today once, without a summary or Stop", async () => {
    const a = app({ session: true }); render(<App />);
    await screen.findByText("wenn");
    a.close("midnight");
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await screen.findByText(pairText);
    expect(screen.queryByRole("region", { name: "Итог занятия" })).toBeNull(); expect(a.posts()).toEqual([]);
  });

  // CP14 bound B-ENTRY is lifted by M-ORAL-ENTRY (editors M-EDIT, card actions M-ACTIONS); the start itself — App.oralEntry.test.tsx E1.
  it("A4 Today offers both De→L1 rows once the oral owner may start; nothing is sent before a tap", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText);
    for (const name of [/Слова: перевод с немецкого/, /Фразы: перевод с немецкого/]) {
      await waitFor(() => expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false));
    }
    await act(async () => {}); expect(a.posts()).toEqual([]); expect(screen.getByText(pairText)).toBeTruthy();
  });
});

// M-NAV: the bottom navigation is hidden during the session (К09-040) and returns with Today.
describe("M-NAV bottom navigation around the oral session", () => {
  it("N-O1 the oral screen shows no navigation panel; Today after the summary shows it again", async () => {
    const a = app({ session: true }); render(<App />);
    await screen.findByText("wenn");
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    await a.back.click();
    await waitFor(() => expect(dd()).toEqual(["0", "0", "0", "2"]));
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText);
    expect(screen.getByRole("navigation", { name: "Основная навигация" })).toBeTruthy();
  });
});

// race_fix (A-SETTINGS-RACE, ApplicationDocument: Settings are read at least as new as every mode seed, C153/C159; QA-FINAL
// Q3, C245): a fresh document of an open oral session reads Settings and the session separately, and another write of the
// profile can land between those reads. The pair stays the chosen one; only the version moves.
describe("Oral: a profile write between the Settings read and the session read of a new document (race_fix)", () => {
  it("re-reads Settings and keeps the resumed question answerable, without a settings refusal", async () => {
    const a = app({ session: true });
    const base = a.fetcher.getMockImplementation()!;
    let bumped = false, settingsReads = 0;
    a.fetcher.mockImplementation(async (url, init) => {
      const reply = await base(url, init);
      if ((init?.method ?? "GET") === "GET" && new URL(String(url), "http://localhost").pathname.endsWith("/settings")) {
        settingsReads++;
        if (!bumped) { bumped = true; a.bump(); }
      }
      return reply;
    });
    render(<App />);
    await screen.findByText("wenn", undefined, { timeout: 5000 });
    await waitFor(() => expect((screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
    expect(bumped).toBe(true);
    expect(settingsReads).toBeGreaterThanOrEqual(2);
    expect(a.posts()).toEqual([]);
  });
});
