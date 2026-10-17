import { withJournalIntake } from "../journal/intake.test-support";
// Notice M1a (project notices ed.2.4 §5, §6, §6.1, §10 M1; CON §7.2 п.4): the real App over one synthetic core of
// a2c29f4 — client.open carries the pending notices, GET /notices reads them, POST /notices/{id}/ack acknowledges one,
// session.start is refused NOTICE_PENDING while one waits (T5). An oral session of this window closed at midnight shows
// its summary with the reason and «На Сегодня» (Q32) and acknowledges its oral_forced_close by that press.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeView, OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import type { OralCommand } from "../oral/oralIntent";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";
const exchange = { timeout: 5000 };
const LINE_9_2_7 = "Не удалось сохранить последнее действие. Занятие завершено. Ранее сохранённый прогресс не потерян.";
const MIDNIGHT = "Занятие закрыто: начался новый день";
// R2-05: «если ... проблема нашей разработки то надо указать что мы знаем о ошибке и работаем над ней» — never with defect_class null.
const KNOWN_DEFECT = /знаем|работаем/i;
// Д4, R4-03 (§6): one and the same screen for the open window and for the next open after a closed Mini App (C523).
// The open window has the progress (TZA М19 :83: «Осталось», C525); the notice of core a2c29f4 has none yet (M1b dependency):
// without it the notice screen is the same frame without that one line, never with a 0; with it, the very same screen.
const SAME_SCREEN = "Устное занятиеЗанятие завершено.Итог занятияЗанятие закрыто: начался новый деньПройдено4Верно3Ошибки1Осталось2На Сегодня";
const SAME_WITHOUT_PROGRESS = SAME_SCREEN.replace("Осталось2", "");
const oralMain = () => screen.getByRole("main", { name: "Устное занятие" }).textContent;

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-10-07", status: "work_now",
    base: { total: 5, words: 3, phrases: 2 }, ordinary_status: "ready",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 3, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 2, next_due_date: null } } },
    learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
type Step = "prefetched" | "presented" | "closed";
function oral(session: string, step: Step, closeReason: OralSessionProjection["close_reason"] = "stop"): OralSessionProjection {
  const active = step !== "closed", assignmentId = id(80);
  return { session_id: session, status: active ? "active" : "closed", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-10-07", bucket: "words", close_reason: active ? null : closeReason,
    progress: { completed: active ? 0 : 4, total: 6, correct: active ? 0 : 3, wrong: active ? 0 : 1 },
    assignment: active ? { id: assignmentId, card_id: id(70), status: step === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: "das Haus", language: "de", conjunction_hint: null }, revealed: false } : null,
    summary: active ? null : { completed: 4, correct: 3, wrong: 1, ratio: { numerator: 3, denominator: 4 } },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-07", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: step === "presented" ? assignmentId : null, grade_target: null, stop: active, summary_home: false } };
}
export function notice(n: number, kind: NoticeView["kind"], closeReason: NoticeView["close_reason"], createdAt: string,
  session = id(200 + n)): NoticeView {
  return { notice_id: id(100 + n), kind, session_id: session, mode: kind === "oral_forced_close" ? "oral" : "written",
    close_reason: closeReason, defect_class: null, created_at: createdAt,
    summary: { completed: 5 + n, correct: 4, wrong: 1 + n, ratio: { numerator: 4, denominator: 5 + n } } };
}

type Ack = "ok" | "network" | "not_found" | "deleted";
/** The synthetic core. `pending` is the server's table of unacknowledged notices. */
function app(initial: NoticeView[] = []) {
  const version = 8n;
  const server = { pending: [...initial], acked: new Set<string>(), ack: [] as Ack[], noticeReads: [] as ("ok" | "fail")[],
    current: null as OralSessionProjection | null, midnight: false, stale: null as NoticeView[] | null };
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: String(version), access: { status: "admitted", version: "1", reason: null } });
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-08T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) {
      const listed = server.stale ?? server.pending;
      server.stale = null;
      return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
        document_id: body.document_id, proof_version: "1", document_epoch: "1", session: null, notices: listed });
    }
    if (path === "/api/v1/notices" && (init?.method ?? "GET") === "GET") {
      if (server.noticeReads.shift() === "fail") return response({ error: { code: "INTERNAL_ERROR" } }, 500);
      return response({ notices: server.pending });
    }
    const ack = /^\/api\/v1\/notices\/([^/]+)\/ack$/.exec(path);
    if (ack && init?.method === "POST") {
      const fate = server.ack.shift() ?? "ok", noticeId = ack[1];
      if (fate === "network") throw new TypeError("network");
      if (fate === "deleted") return response({ error: { code: "PROFILE_DELETED" } }, 403);
      const known = server.pending.some(n => n.notice_id === noticeId) || server.acked.has(noticeId);
      if (fate === "not_found" || !known) return response({ error: { code: "NOT_FOUND" } }, 404);
      const first = !server.acked.has(noticeId);
      server.acked.add(noticeId); server.pending = server.pending.filter(n => n.notice_id !== noticeId);
      return response({ notice_id: noticeId, status: first ? "applied" : "already_applied", acked_at: "2026-10-07T10:00:00Z" });
    }
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(version) });
    if (path.endsWith("/learning/current")) return response({ pair: "ru-de", state_version: String(version),
      manual_selection_version: "1", group: null, manual_selection: [], learning: { status: "completed", ready: 0, preview: 0,
        next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 } });
    if (path.endsWith("/commands") && init?.method === "POST") {
      const command = body as OralCommand;
      const fact = { id: command.command_id, kind: command.kind, status: "applied", applied_at: "2026-10-07T09:00:00Z",
        target_id: "assignment_id" in command ? command.assignment_id : command.session_id, action_id: null, result_id: null,
        context_id: null, object_version: null };
      if (command.kind === "session.start") {
        // T5 (core a2c29f4 new_session_start): an unacknowledged notice refuses a new start, kept by its command_id.
        if (server.pending.length > 0) return response({ current: { session_id: command.session_id, status: "not_found" },
          command: { id: command.command_id, status: "rejected" }, state_version: String(version), error: { code: "NOTICE_PENDING" } }, 409);
        server.current = oral(command.session_id, "prefetched");
      } else if (command.kind === "assignment.present") {
        server.current = oral(command.session_id, "presented");
      } else if (command.kind === "oral.reveal" && server.midnight) {
        // The calendar closed the active oral session at midnight in this very request, and its notice with it (N2a).
        server.current = oral(command.session_id, "closed", "midnight");
        return response({ current: server.current, command: { id: command.command_id, status: "rejected" },
          state_version: String(version), error: { code: "SESSION_CLOSED" } }, 409);
      } else return response({ error: { code: "UNEXPECTED" } }, 500);
      return response({ command: fact, current: server.current, state_version: String(version) });
    }
    if (path.includes("/sessions/")) return response({ current: server.current ?? { session_id: path.split("/").at(-1), status: "unavailable" },
      state_version: String(version) });
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() },
    BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} } } });
  const calls = (match: (path: string, method: string, body: Record<string, unknown> | null) => boolean) =>
    fetcher.mock.calls.filter(([url, init]) => match(new URL(String(url), "http://localhost").pathname, init?.method ?? "GET",
      init?.body ? JSON.parse(String(init.body)) : null));
  return {
    server, fetcher,
    acks: () => calls((path, method) => method === "POST" && /\/notices\/[^/]+\/ack$/.test(path)),
    noticeReads: () => calls((path, method) => method === "GET" && path === "/api/v1/notices"),
    starts: () => calls((path, method, body) => method === "POST" && path.endsWith("/commands") && body?.kind === "session.start")
      .map(([, init]) => JSON.parse(String(init!.body)) as OralCommand),
    commandPosts: () => calls((path, method) => method === "POST" && path.endsWith("/commands")),
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const summaries = () => screen.queryAllByRole("region", { name: "Итог занятия" });
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
async function oralButton() {
  return waitFor(() => { const e = screen.getByRole("button", { name: /Слова: перевод с немецкого/ }) as HTMLButtonElement;
    expect(e.disabled).toBe(false); return e; }, exchange);
}

describe("notice M1a: a closed Mini App shows the pending notices before any start, one at a time", () => {
  it("client.open notices: oldest first, one screen, no Today and no start until the press; ack only after it", async () => {
    // Given in the other order: the client orders by created_at, then id (§6).
    const later = notice(2, "oral_forced_close", "midnight", "2026-10-07T00:00:05Z");
    const earlier = notice(1, "answer_loss", "save_failed", "2026-10-07T00:00:01Z");
    const a = app([later, earlier]); render(<App />);
    await screen.findByText(LINE_9_2_7, undefined, exchange);
    await settle();
    expect(summaries()).toHaveLength(1);
    expect(screen.queryByText(MIDNIGHT)).toBeNull();
    // In place of Today: no Today, no start of any mode while a notice waits (CON §7.2 п.4: before session.start).
    expect(screen.queryByText(pairText)).toBeNull();
    expect(screen.queryByRole("button", { name: /Слова: перевод с немецкого/ })).toBeNull();
    // Showing is no acknowledgement (§5).
    expect(a.acks()).toHaveLength(0);
    expect(screen.queryByText(KNOWN_DEFECT)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText(MIDNIGHT, undefined, exchange);
    expect(a.acks()).toHaveLength(1);
    expect(String(a.acks()[0][0])).toContain(`/notices/${earlier.notice_id}/ack`);
    const ackBody = JSON.parse(String(a.acks()[0][1]!.body));
    expect(Object.keys(ackBody).sort()).toEqual(["client_instance_id", "command_id"]);
    expect(new Headers(a.acks()[0][1]!.headers).get("X-Origin-Proof")).toBe("synthetic-proof");
    expect(summaries()).toHaveLength(1);
    expect(screen.queryByText(LINE_9_2_7)).toBeNull();
    expect(screen.queryByText(pairText)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(a.acks()).toHaveLength(2);
    expect(String(a.acks()[1][0])).toContain(`/notices/${later.notice_id}/ack`);
    // Today without any notice line (R2-06, R3-01 А).
    expect(screen.queryByText(LINE_9_2_7)).toBeNull();
    expect(screen.queryByText(MIDNIGHT)).toBeNull();
    expect(summaries()).toHaveLength(0);
    expect(a.starts()).toHaveLength(0);
    expect(a.noticeReads()).toHaveLength(0);
  }, 20_000);

  it("a failed acknowledgement keeps the notice on screen; the next press acknowledges it (§5: shown again until ack)", async () => {
    const one = notice(1, "answer_loss", "stop", "2026-10-07T00:00:01Z");
    const a = app([one]); a.server.ack.push("network"); render(<App />);
    await screen.findByText("Последний ответ не сохранился. Остальные ответы сохранены.", undefined, exchange);
    expect(screen.getByText("Занятие завершено.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await waitFor(() => expect(a.acks()).toHaveLength(1), exchange);
    await settle();
    expect(screen.getByText("Последний ответ не сохранился. Остальные ответы сохранены.")).toBeTruthy();
    expect(screen.queryByText(pairText)).toBeNull();
    fireEvent.click(await waitFor(() => { const b = screen.getByRole("button", { name: "Далее" }) as HTMLButtonElement;
      expect(b.disabled).toBe(false); return b; }, exchange));
    await screen.findByText(pairText, undefined, exchange);
    expect(a.acks()).toHaveLength(2);
    // The same service command_id for the same notice in this page; the server deduplicates nothing by it (T4).
    expect(JSON.parse(String(a.acks()[1][1]!.body)).command_id).toBe(JSON.parse(String(a.acks()[0][1]!.body)).command_id);
    expect(a.commandPosts()).toHaveLength(0);
  }, 20_000);

  it("acknowledged here, an older list of a later open does not bring it back; 404 ends a notice as well", async () => {
    const one = notice(1, "answer_loss", "save_failed", "2026-10-07T00:00:01Z");
    const gone = notice(2, "answer_loss", "save_failed", "2026-10-07T00:00:02Z");
    const a = app([one, gone]); a.server.ack.push("ok", "not_found"); render(<App />);
    await screen.findByText(LINE_9_2_7, undefined, exchange);
    // The next open (e.g. a return to the window) answers a list from before the acknowledgement.
    a.server.stale = [one, gone];
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await waitFor(() => expect(a.acks()).toHaveLength(1), exchange);
    await waitFor(() => expect(summaries()).toHaveLength(1), exchange);
    expect(document.querySelector(`[data-notice="${gone.notice_id}"]`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(a.acks()).toHaveLength(2);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pageshow")); });
    await settle();
    expect(summaries()).toHaveLength(0);
    expect(screen.getByText(pairText)).toBeTruthy();
  }, 20_000);

  it("PROFILE_DELETED on the acknowledgement ends the document as a deleted profile (P04 §8)", async () => {
    const a = app([notice(1, "answer_loss", "save_failed", "2026-10-07T00:00:01Z")]); a.server.ack.push("deleted"); render(<App />);
    await screen.findByText(LINE_9_2_7, undefined, exchange);
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await waitFor(() => expect(summaries()).toHaveLength(0), exchange);
    expect(a.acks()).toHaveLength(1);
    expect(screen.queryByText(pairText)).toBeNull();
    expect(a.commandPosts()).toHaveLength(0);
  }, 20_000);
});

describe("notice M1a: NOTICE_PENDING (§6.1 «Восстановление клиента»)", () => {
  it("a refused start reads GET /notices and shows the notice; after ack no POST follows; a new press is a new command_id", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    // Another device closed a session with a notice after this window's open (§6.1 race).
    const waiting = notice(1, "answer_loss", "save_failed", "2026-10-07T00:00:01Z");
    a.server.pending = [waiting];
    fireEvent.click(await oralButton());
    await screen.findByText(LINE_9_2_7, undefined, exchange);
    expect(a.starts()).toHaveLength(1);
    expect(a.noticeReads().length).toBeGreaterThanOrEqual(1);
    expect(a.acks()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText(pairText, undefined, exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 600)); });
    // No silent new ID and no automatic POST after the acknowledgement.
    expect(a.starts()).toHaveLength(1);
    expect(a.commandPosts()).toHaveLength(1);
    fireEvent.click(await oralButton());
    await waitFor(() => expect(a.starts()).toHaveLength(2), exchange);
    const [first, second] = a.starts();
    expect(second.command_id).not.toBe(first.command_id);
    expect(second.session_id).not.toBe(first.session_id);
  }, 20_000);

  it("Т2: a failed GET /notices repeats only the read — no Stop, no answer, no start", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    a.server.pending = [notice(1, "answer_loss", "save_failed", "2026-10-07T00:00:01Z")];
    a.server.noticeReads.push("fail");
    // The foreground open after the refusal must not answer the list either: only the read shows it here.
    a.server.stale = [];
    fireEvent.click(await oralButton());
    const retry = await screen.findByRole("button", { name: "Повторить" }, exchange);
    const posts = a.commandPosts().length, reads = a.noticeReads().length;
    expect(posts).toBe(1);
    expect(screen.queryByText(pairText)).toBeNull();
    fireEvent.click(retry);
    await screen.findByText(LINE_9_2_7, undefined, exchange);
    expect(a.noticeReads()).toHaveLength(reads + 1);
    expect(a.commandPosts()).toHaveLength(posts);
  }, 20_000);
});

describe("notice M1a: Д4 — the closed Mini App shows the very screen of the open window", () => {
  it.each([[false], [true]])("oral_forced_close after a closed Mini App (progress sent: %s): the frame of the open window", async withProgress => {
    const closedAtMidnight = { ...notice(1, "oral_forced_close", "midnight", "2026-10-07T00:00:01Z"),
      summary: { completed: 4, correct: 3, wrong: 1, ratio: { numerator: 3, denominator: 4 } },
      ...(withProgress ? { progress: { completed: 4, total: 6, correct: 3, wrong: 1 } } : {}) } as NoticeView;
    const a = app([closedAtMidnight]); render(<App />);
    await screen.findByText(MIDNIGHT, undefined, exchange);
    expect(oralMain()).toBe(withProgress ? SAME_SCREEN : SAME_WITHOUT_PROGRESS);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(a.acks()).toHaveLength(1);
  }, 20_000);
});

describe("notice M1a: Q32 — the open oral window closed at midnight", () => {
  it("shows the summary with the reason and «На Сегодня», reads GET /notices, acknowledges by that press only", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    fireEvent.click(await oralButton());
    const reveal = await waitFor(() => { const e = screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement;
      expect(e.disabled).toBe(false); return e; }, exchange);
    a.server.midnight = true;
    const sessionId = a.starts()[0].session_id;
    a.server.pending = [notice(1, "oral_forced_close", "midnight", "2026-10-07T00:00:01Z", sessionId)];
    fireEvent.click(reveal);
    await screen.findByText(MIDNIGHT, undefined, exchange);
    await waitFor(() => expect(oralMain()).toBe(SAME_SCREEN), exchange);
    await settle();
    // The oral screen stays: no return to Today by itself, no acknowledgement by showing.
    expect(screen.getByRole("main", { name: "Устное занятие" })).toBeTruthy();
    expect(screen.queryByText(pairText)).toBeNull();
    await waitFor(() => expect(a.noticeReads().length).toBeGreaterThanOrEqual(1), exchange);
    expect(a.acks()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(a.acks()).toHaveLength(1);
    expect(String(a.acks()[0][0])).toContain(`/notices/${id(101)}/ack`);
    // The same notice is not shown again on Today: one summary, one acknowledgement (Д4).
    await settle();
    expect(summaries()).toHaveLength(0);
    expect(screen.queryByText(MIDNIGHT)).toBeNull();
  }, 20_000);
});
