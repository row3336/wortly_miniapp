import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import { cardView, reviewing } from "../dictionary/card/cardTestData.test-support";
import type { OralCommand } from "../oral/oralIntent";
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
function app(options: { settings?: Promise<void> } = {}) {
  let version = 8n, current: OralSessionProjection | null = null;
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
      if (options.settings) await options.settings;
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
      return response({ command: fact({ target_id: "assignment_id" in command ? command.assignment_id : command.session_id,
        action_id: grade ? id(90) : null, result_id: grade ? id(91) : null, context_id: null, object_version: grade ? "1" : null }),
        current, state_version: String(version) });
    }
    if (path.includes("/sessions/")) return response({ current: current ?? { session_id: path.split("/").at(-1), status: "unavailable" },
      state_version: String(version) });
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() },
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} } } });
  return { card, oralKinds: () => oralPosts.map(post => post.kind), oralPosts };
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
async function startFromToday(row: RegExp) {
  await screen.findByText(pairText);
  const tap = await waitFor(() => {
    const element = screen.getByRole("button", { name: row }) as HTMLButtonElement;
    expect(element.disabled).toBe(false);
    return element;
  });
  fireEvent.click(tap);
  await screen.findByText("das Haus");
  await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
}

beforeEach(() => {
  localStorage.clear(); writtenReports.calls = [];
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("M-ORAL-ENTRY: the oral quiz from Today and the card in М18 through the actual App", () => {
  it.each([[/Слова: перевод с немецкого/, "words"], [/Фразы: перевод с немецкого/, "phrases"]] as const)(
    "E1 the De→L1 row %s starts the oral quiz with its bucket (CP14 B-ENTRY lifted)", async (row, bucket) => {
      const a = app(); render(<App />);
      await startFromToday(row);
      expect(a.oralKinds()).toEqual(["session.start", "assignment.present"]);
      expect(a.oralPosts[0]).toMatchObject({ kind: "session.start", payload: { mode: "oral", bucket } });
      expect(screen.queryByText(pairText)).toBeNull();
    });

  it("E2 «Уточнить поля» on the hidden question opens the card with its editors and only the De→L1 direction; Back returns to the same question", async () => {
    const a = app(); render(<App />);
    await startFromToday(/Слова: перевод с немецкого/);
    fireEvent.click(button("Уточнить поля"));
    const pencil = await screen.findByRole("button", { name: "Изменить личный перевод" }) as HTMLButtonElement;
    await waitFor(() => expect(pencil.disabled).toBe(false));
    // The oral origin shows only its own direction (M-CARD Р7, К07-056).
    await screen.findByText("Интервал: 8 дн.");
    expect(screen.queryByText("Интервал: 3 дн.")).toBeNull();
    expect(screen.queryByText("das Haus")).toBeNull();
    fireEvent.click(button("Назад"));
    await screen.findByText("das Haus");
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
    expect(screen.queryByText("дом")).toBeNull();
    expect(a.oralKinds()).toEqual(["session.start", "assignment.present"]);
    await waitFor(() => expect(a.card.posts.map(post => post.kind)).toEqual(["context.open", "context.close"]));
  });

  it("E3 a card action from the revealed question keeps the card open and the oral quiz on the same question (К07-080, Т88)", async () => {
    const a = app(); render(<App />);
    await startFromToday(/Слова: перевод с немецкого/);
    fireEvent.click(button("Раскрыть"));
    await waitFor(() => expect(button("Правильно").disabled).toBe(false));
    fireEvent.click(button("Уточнить поля"));
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }));
    await screen.findByRole("button", { name: "Вернуть в повторы" });
    // Still the card: no exit into the quiz and no oral command.
    expect(screen.queryByText("das Haus")).toBeNull();
    expect(a.card.posts.map(post => post.kind)).toEqual(["context.open", "card.exclude"]);
    expect(a.oralKinds()).toEqual(["session.start", "assignment.present", "oral.reveal"]);
    fireEvent.click(button("Назад"));
    await screen.findByText("das Haus");
    await waitFor(() => expect(button("Правильно").disabled).toBe(false));
    expect(screen.getByText("дом")).toBeTruthy();
    expect(a.oralKinds()).toEqual(["session.start", "assignment.present", "oral.reveal"]);
    // The self-assessment stays the only way on (К05-083).
    fireEvent.click(button("Правильно"));
    await screen.findByText("die Straße");
    expect(a.oralKinds()).toEqual(["session.start", "assignment.present", "oral.reveal", "oral.grade", "assignment.present"]);
  });

  it("E4 a card action from the oral card reports nothing to the written quiz, so it never arms its own «Далее» (M-ACTIONS Р4)", async () => {
    const a = app(); render(<App />);
    await startFromToday(/Слова: перевод с немецкого/);
    fireEvent.click(button("Уточнить поля"));
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }));
    await screen.findByRole("button", { name: "Вернуть в повторы" });
    await waitFor(() => expect(a.card.posts.map(post => post.kind)).toEqual(["context.open", "card.exclude"]));
    await act(async () => {});
    expect(writtenReports.calls).toEqual([]);
    fireEvent.click(button("Назад"));
    await screen.findByText("das Haus");
    expect(writtenReports.calls).toEqual([]);
  });

  it("E5 De→L1 rows stay inert and send no start while the oral owner may not start (settings not confirmed), then become available", async () => {
    let release!: () => void;
    const a = app({ settings: new Promise<void>(done => { release = done; }) }); render(<App />);
    try {
      await screen.findByText(pairText);
      const rows = [/Слова: перевод с немецкого/, /Фразы: перевод с немецкого/];
      const shown = rows.map(name => screen.getByRole("button", { name }) as HTMLButtonElement);
      expect(shown.map(row => row.disabled)).toEqual([true, true]);
      shown.forEach(row => fireEvent.click(row));
      await act(async () => {});
      expect(a.oralKinds()).toEqual([]); expect(screen.getByText(pairText)).toBeTruthy();
      release();
      await waitFor(() => expect(rows.map(name => (screen.getByRole("button", { name }) as HTMLButtonElement).disabled)).toEqual([false, false]));
      expect(a.oralKinds()).toEqual([]);
    } finally { release(); }
  });
});
