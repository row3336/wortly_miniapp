import { withJournalIntake } from "../journal/intake.test-support";
// M-ORAL-STUCK-A (AQ): an applied oral step whose reply was lost, its session closed by a pair change elsewhere. On
// return the check by the same ID proves it applied and carries the closed projection of the old pair: that closure is
// a fact of the own session, so the document leaves for Today instead of an unknown outcome (CT §6.1 п. 5, п. 7).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import type { OralCommand } from "../oral/oralIntent";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Served = Record<string, any>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };

function today(pair: string): TodayResponse {
  return { state_version: "1", pair: pair as TodayResponse["pair"], local_date: "2026-10-01", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "ready",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 3, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 2, next_due_date: null } } },
    learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
/** The oral session of the old pair; its closed form carries numbers that must never reach the new pair. */
function oral(step: "presented" | "closed"): OralSessionProjection {
  const active = step === "presented";
  return { session_id: id(3), status: active ? "active" : "closed", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-10-01", bucket: "words", close_reason: active ? null : "pair_changed",
    progress: { completed: 7, total: 9, correct: 5, wrong: 2 },
    assignment: active ? { id: id(6), card_id: id(7), status: "presented", kind: "original",
      prompt: { text: "wenn", language: "de", conjunction_hint: null }, revealed: false } : null,
    summary: active ? null : { completed: 7, correct: 5, wrong: 2, ratio: { numerator: 5, denominator: 7 } },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: active ? id(6) : null, grade_target: null, stop: active, summary_home: false } };
}

/**
 * The real App over one synthetic server. The reveal is applied but its reply is lost; then the session closes and,
 * when changed, the pair becomes uk-de. The check by the same ID answers already_applied with the closed projection.
 */
function app() {
  const state = { pair: "ru", lose: true, closed: false };
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: state.pair as Profile["dictionary_language"],
    time_zone: "UTC", state_version: state.closed ? "9" : "8", access: { status: "admitted", version: "1", reason: null } });
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const target = new URL(String(url), "http://localhost"), path = target.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null, version = state.closed ? "9" : "8";
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-02T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return response({ status: "opened", profile: account(), compatibility,
      client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1",
      session: state.closed ? null : { id: id(3), phase: "active" } });
    if (path.endsWith("/today")) return response(today(`${state.pair}-de`));
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: version });
    if (path.endsWith("/settings")) {
      const settings = structuredClone(stored) as Served; settings.settings.dictionary_language.value = state.pair;
      return response({ ...settings, state_version: version });
    }
    if (path.endsWith("/commands") && init?.method === "POST") {
      if ((body as OralCommand).kind === "oral.reveal" && state.lose) throw new TypeError("network");
      return response({ error: { code: "UNEXPECTED" } }, 500);
    }
    if (path.includes("/commands/")) return response({ command: { id: path.split("/").at(-1), kind: "oral.reveal", status: "already_applied",
      applied_at: "2026-10-01T12:00:00Z", target_id: id(6), action_id: null, result_id: null, context_id: null, object_version: null },
      current: oral("closed"), state_version: "20", verified_intent_hash: target.searchParams.get("expected_intent_hash") });
    if (path.includes("/sessions/")) return response({ current: oral(state.closed ? "closed" : "presented"), state_version: version });
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  const backHandlers = new Set<() => void>();
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() },
    BackButton: { show() {}, hide() {}, onClick(handler: () => void) { backHandlers.add(handler); }, offClick(handler: () => void) { backHandlers.delete(handler); } } } });
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))
    .map(([, init]) => JSON.parse(String(init!.body)) as OralCommand);
  return { state, posts, fetcher };
}
const settled = async () => { for (let i = 0; i < 15; i++) await act(async () => { await new Promise(done => setTimeout(done, 0)); }); };
const foreground = () => act(async () => { window.dispatchEvent(new Event("pageshow")); });

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("M-ORAL-STUCK-A: an applied step of a session closed by a pair change", () => {
  // Q32 вар.1, R4-03 (tz_app.md:295, SHA-16 7d949301; Codex C520): before M1a the same-pair case left for Today by itself;
  // the open window now shows the reason and leaves only by «На Сегодня». The numbers of the old pair still never show (C178).
  it("same pair: the reason, its own-pair numbers and «На Сегодня»; Today only after the press", async () => {
    const a = app(); render(<App />);
    await screen.findByText("wenn");
    await waitFor(() => expect((screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Раскрыть" }));
    await settled();
    a.state.lose = false; a.state.closed = true;
    await foreground(); await settled();
    await screen.findByText("Занятие закрыто: изменилась языковая пара");
    expect(screen.queryByText("Активная пара: Русский ↔ Немецкий")).toBeNull();
    expect(screen.queryByText("Действие ещё не подтверждено. Проверь состояние.")).toBeNull();
    expect(screen.queryByText("Не удалось обновить занятие. Проверь состояние.")).toBeNull();
    // Its projection names this same pair: its numbers are of this pair and may show (C178 bars only another pair's).
    expect(Array.from(document.querySelectorAll("dd"), e => e.textContent)).toEqual(["7", "5", "2", "2"]);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText("Активная пара: Русский ↔ Немецкий");
    expect(screen.queryByRole("region", { name: "Итог занятия" })).toBeNull();
    expect(a.posts().map(post => post.kind)).toEqual(["oral.reveal"]);
  });
  // P2-B (Codex C537; Q32 вар.1, R4-03, tz_app.md:295): the pair moved and the document follows it, but the fresh receipt of
  // its own reveal proves the closure of its earlier session: the window shows that reason with «На Сегодня» and leaves
  // only by the press — before v3 it left for Today by itself. The old pair's numbers never show (C178); nothing is sent.
  it("new pair: the reason of the earlier session's closure and «На Сегодня», no old numbers, no request; Today only after the press", async () => {
    const a = app(); render(<App />);
    await screen.findByText("wenn");
    await waitFor(() => expect((screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Раскрыть" }));
    await settled();
    a.state.lose = false; a.state.closed = true; a.state.pair = "uk";
    await foreground(); await settled();
    await screen.findByText("Занятие закрыто: изменилась языковая пара");
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(screen.queryByText("Активная пара: Украинский ↔ Немецкий")).toBeNull();
    expect(screen.queryByText("Действие ещё не подтверждено. Проверь состояние.")).toBeNull();
    expect(screen.queryByText("Не удалось обновить занятие. Проверь состояние.")).toBeNull();
    // The closure of the old pair grants no numbers here, and no check of it.
    expect(document.querySelectorAll("dd")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Проверить состояние" })).toBeNull();
    const sent = () => a.posts().map(post => post.kind);
    expect(sent()).toEqual(["oral.reveal"]);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText("Активная пара: Украинский ↔ Немецкий");
    await settled();
    expect(screen.queryByText("Занятие закрыто: изменилась языковая пара")).toBeNull();
    // Nothing is sent again: the only command is the original reveal; no notice is read or acknowledged (R22).
    expect(sent()).toEqual(["oral.reveal"]);
    expect(a.fetcher.mock.calls.filter(([url]) => /\/notices/.test(String(url)))).toEqual([]);
  });
});
