import { withJournalIntake } from "../journal/intake.test-support";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import { cardView, reviewing } from "../dictionary/card/cardTestData.test-support";
import { oralIntentHash, type OralCommand, type OralIntent } from "../oral/oralIntent";
import { settingsResponse } from "../settings/settingsRead.test-support";
import type { WrittenCardAction } from "../written/useWrittenHost";
import { App } from "./App";

/**
 * Card actions reported to the written owner. The written quiz itself shows nothing while the oral one runs, so the report
 * is observed at the document seam: only a card of the written quiz may report (movesWrittenQuiz, M-ACTIONS Р4).
 */
const writtenReports = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../written/useWrittenHost", async importOriginal => {
  const original = await importOriginal<typeof import("../written/useWrittenHost")>();
  return { ...original, useWrittenHost: (options: Parameters<typeof original.useWrittenHost>[0]) => {
    const host = original.useWrittenHost(options);
    return { ...host, cardActionApplied: (event: WrittenCardAction) => { writtenReports.calls.push(event); host.cardActionApplied(event); } };
  } };
});

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";
const CARD = id(70);

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-10-07", status: "work_now",
    base: { total: 5, words: 3, phrases: 2 }, ordinary_status: "ready",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 3, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 2, next_due_date: null } } },
    learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
type Step = "prefetched" | "presented" | "revealed" | "closed";
function oral(session: string, bucket: "words" | "phrases", step: Step, completed = 0, correct = 0): OralSessionProjection {
  const active = step !== "closed", assignmentId = id(80 + completed);
  return { session_id: session, status: active ? "active" : "closed", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-10-07", bucket, close_reason: active ? null : "stop",
    progress: { completed, total: 2, correct, wrong: completed - correct },
    assignment: active ? { id: assignmentId, card_id: completed === 0 ? CARD : id(71), status: step === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: completed === 0 ? "das Haus" : "die Straße", language: "de", conjunction_hint: null },
      ...(step === "revealed" ? { status: "presented" as const, revealed: true as const, translations: ["дом"] } : { revealed: false as const }) } : null,
    summary: active ? null : { completed, correct, wrong: completed - correct, ratio: completed ? { numerator: correct, denominator: completed } : null },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-07", time_zone: "UTC", count: completed },
    capabilities: { reveal_target: step === "presented" ? assignmentId : null, grade_target: step === "revealed" ? assignmentId : null,
      stop: active, summary_home: false } };
}

/** The real App over one synthetic server: Today, the oral session and the card endpoints of core (view, context, card.exclude). */
function app() {
  let version = 8n, current: OralSessionProjection | null = null;
  // A held Settings read: set by a test after the entry, it holds every following read until released.
  let settingsGate: Promise<void> | null = null;
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: String(version), access: { status: "admitted", version: "1", reason: null } });
  const card = { excluded: false, next: 700, posts: [] as Record<string, any>[], contexts: new Map<string, "open" | "closed">() };
  const view = (localDate: string | null = "2026-10-07") => {
    const value = reviewing(cardView(CARD));
    if (card.excluded) {
      value.study.facts.exclusion = { excluded: true, version: "1" };
      Object.assign(value.study.directions[0], { schedule: null, interval_preview: null });
      value.card_actions = { exclude: false, return: true, relearn: false };
    }
    value.study.local_date = localDate;
    if (localDate === null) value.study.directions.forEach(direction => { direction.interval_preview = null; });
    return value;
  };
  const context = (contextId: string) => {
    const status = card.contexts.get(contextId), reference = { id: contextId, kind: "dictionary", card_id: CARD };
    return status === "open" ? { status, context: reference, view: view(null), interval: null,
      capabilities: { interval_increase: null, undo_offer: null, undo_target: null } } : { status: "closed", context: reference };
  };
  const oralPosts: OralCommand[] = [];
  // Applied oral commands by ID, for the status read by ID (GET /commands/{id}) as core answers it.
  const receipts = new Map<string, { intent: OralIntent; reply: Record<string, unknown> }>();
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-08T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return response({ status: "opened", profile: account(), compatibility,
      client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1", session: null });
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) {
      if (settingsGate) await settingsGate;
      return response({ ...structuredClone(stored), state_version: String(version) });
    }
    if (path.endsWith(`/dictionary/cards/${CARD}/view`)) return response({ state_version: String(version), current: view() });
    if (path.includes("/dictionary/contexts/")) return response({ state_version: String(version), current: context(path.split("/").at(-1)!) });
    if (path.endsWith("/learning/current")) return response({ pair: "ru-de", state_version: String(version),
      manual_selection_version: "1", group: null, manual_selection: [], learning: { status: "completed", ready: 0, preview: 0,
        next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 } });
    if (path.endsWith("/commands") && init?.method === "POST") {
      const fact = (extra: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied",
        applied_at: "2026-10-07T09:00:00Z", result_id: null, ...extra });
      if (String(body.kind).startsWith("context.")) {
        card.posts.push(body);
        const contextId: string = body.kind === "context.open" ? id(card.next++) : body.context_id;
        card.contexts.set(contextId, body.kind === "context.open" ? "open" : "closed"); version++;
        return response({ command: fact({ target_id: CARD, action_id: null, context_id: contextId, object_version: null }),
          current: context(contextId), state_version: String(version) });
      }
      if (body.kind === "card.exclude") {
        card.posts.push(body); card.excluded = true; version++;
        return response({ command: fact({ target_id: CARD, action_id: id(777), context_id: null, object_version: "1" }),
          current: { status: "available", card_id: CARD, pair: "ru-de", excluded: true, version: "1",
            actions: { exclude: false, return: true, relearn: false } }, state_version: String(version) });
      }
      const command = body as OralCommand; oralPosts.push(command);
      const progress = current?.progress ?? { completed: 0, correct: 0 }, bucket = current?.bucket ?? "words";
      if (command.kind === "session.start") current = oral(command.session_id, command.payload.bucket, "prefetched");
      else if (command.kind === "assignment.present") current = oral(command.session_id, bucket, "presented", progress.completed, progress.correct);
      else if (command.kind === "oral.reveal") current = oral(command.session_id, bucket, "revealed", progress.completed, progress.correct);
      else if (command.kind === "oral.grade") current = oral(command.session_id, bucket, "prefetched", progress.completed + 1,
        progress.correct + Number(command.payload.correct));
      else return response({ error: { code: "UNEXPECTED" } }, 500);
      version++;
      const grade = command.kind === "oral.grade";
      const reply = { command: fact({ target_id: "assignment_id" in command ? command.assignment_id : command.session_id,
        action_id: grade ? id(90) : null, result_id: grade ? id(91) : null, context_id: null, object_version: grade ? "1" : null }),
        current, state_version: String(version) };
      const { client_instance_id: _client, document_id: _document, ...intent } = command;
      receipts.set(command.command_id, { intent, reply });
      return response(reply);
    }
    if (path.includes("/commands/") && (init?.method ?? "GET") === "GET") {
      const commandId = path.split("/").at(-1)!, receipt = receipts.get(commandId);
      const expected = new URL(String(url), "http://localhost").searchParams.get("expected_intent_hash");
      if (!receipt) return response({ command: { id: commandId, status: "not_found" }, current: account(), state_version: String(version) });
      if (expected !== await oralIntentHash(receipt.intent)) return response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
      return response({ command: { ...receipt.reply.command as object, status: "already_applied" }, current,
        state_version: String(version), verified_intent_hash: expected });
    }
    if (path.includes("/sessions/")) return response({ current: current ?? { session_id: path.split("/").at(-1), status: "unavailable" },
      state_version: String(version) });
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() },
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} } } });
  // Full card reads with their query: the origin of the opening (2.26б.1).
  const views = () => fetcher.mock.calls.map(([url]) => new URL(String(url), "http://localhost"))
    .filter(url => url.pathname.endsWith(`/dictionary/cards/${CARD}/view`)).map(url => url.search);
  return { card, fetcher, oralKinds: () => oralPosts.map(post => post.kind), oralPosts, views,
    holdSettings(gate: Promise<void>) { settingsGate = gate; } };
}

beforeEach(() => {
  localStorage.clear(); writtenReports.calls = [];
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// fix5 (Q29, C386/C388): a refused oral start (SESSION_BUSY) through the real App → OralHost → Entry → gate → R10. The
// harness above is the one of QA probe qa7_oral (r7). The refusal stays on the oral screen until the person leaves it.
function busyCore(a: ReturnType<typeof app>) {
  const other = id(60), remote = { busy: false, stopId: null as string | null };
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/client/open") && remote.busy) return response({ status: "SESSION_BUSY", profile: { profile_id: id(50), role: "user",
      ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "8", access: { status: "admitted", version: "1", reason: null } },
      compatibility, session: { status: "busy", stop_remote_target: other } });
    if (path.endsWith("/commands") && body?.kind === "session.start") {
      remote.busy = true;
      return response({ current: { session_id: body.session_id, status: "not_found" }, command: { id: body.command_id, status: "rejected" },
        state_version: "8", error: { code: "SESSION_BUSY" } }, 409);
    }
    if (path.endsWith("/commands") && body?.kind === "session.stop_remote") {
      remote.busy = false; remote.stopId = body.command_id; throw new TypeError("network"); // applied, reply lost
    }
    if (remote.stopId && path.endsWith(`/commands/${remote.stopId}`)) return response({ command: { id: remote.stopId,
      kind: "session.stop_remote", status: "already_applied", target_id: other, applied_at: "2026-10-07T12:00:00Z", action_id: null,
      result_id: null, context_id: null, object_version: null },
    current: { session_id: other, status: "closed", close_reason: "remote_stop" }, state_version: "8" }); // the harness core stays at 8 (its version moves only on its own commands)
    return base(url, init);
  });
  return remote;
}
const exchange = { timeout: 5000 };
async function refuseOralStart(a: ReturnType<typeof app>) {
  await screen.findByText(pairText, undefined, exchange);
  const tap = await waitFor(() => { const e = screen.getByRole("button", { name: /Слова: перевод с немецкого/ }) as HTMLButtonElement;
    expect(e.disabled).toBe(false); return e; }, exchange);
  fireEvent.click(tap);
  await screen.findByText("Занятие открыто на другом устройстве", undefined, exchange);
  expect(starts(a)).toBe(1);
}
const starts = (a: ReturnType<typeof app>) => a.fetcher.mock.calls.filter(([, init]) => init?.method === "POST" && init.body
  && JSON.parse(String(init.body)).kind === "session.start").length;
const opens = (a: ReturnType<typeof app>) => a.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/client/open")).length;

describe("fix5 (Q29): a refused oral start stays on the oral screen until the person leaves it", () => {
  it("without a human action nothing follows: no return to Today, no foreground, no GET; the oral screen offers «На Сегодня»", async () => {
    const a = app(); const remote = busyCore(a); render(<App />);
    await refuseOralStart(a);
    const calls = a.fetcher.mock.calls.length, opened = opens(a);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
    expect(screen.getByRole("main", { name: "Устное занятие" })).toBeTruthy();
    expect(screen.getByText("Занятие открыто на другом устройстве")).toBeTruthy();
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Завершить занятие на другом устройстве" })).toBeNull();
    expect(opens(a)).toBe(opened);
    expect(a.fetcher.mock.calls.length).toBe(calls);
    expect(remote.stopId).toBeNull();
  }, 20_000);

  it("its «На Сегодня» spends the П01 episode: busy Today, Stop applied with its reply lost, «Проверить результат» — one GET, one POST", async () => {
    const a = app(); const remote = busyCore(a); render(<App />);
    await refuseOralStart(a);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" }, exchange));
    fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие" }, exchange));
    const check = await screen.findByRole("button", { name: "Проверить результат" }, exchange);
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false), exchange);
    fireEvent.click(check);
    await screen.findByText(pairText, undefined, exchange);
    const reads = a.fetcher.mock.calls.filter(([url, init]) => (init?.method ?? "GET") === "GET"
      && String(url).includes(`/commands/${remote.stopId}`));
    expect(reads).toHaveLength(1);
    expect(a.fetcher.mock.calls.filter(([, init]) => init?.method === "POST" && init.body
      && JSON.parse(String(init.body)).kind === "session.stop_remote")).toHaveLength(1);
    expect(localStorage.getItem("wortly.pending.remote_stop")).toBeNull();
  }, 20_000);
});
