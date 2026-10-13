// A Learning answer the server committed but whose result the user never saw, then a full reload (owner decision
// 20.1-А) or a re-entry after an access error in the same window (22.1-А): the new document shows the confirmed result
// for the first time and waits for «Далее» in every transition mode. A result confirmed live in the same window, also
// after a lost reply, keeps the auto-advance (3 s, accelerated 2 s).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import type { LearningCommandIntent } from "../learning/learningCommandIntent";
import { id, profile, response } from "../learning/learningFixtures.test-support";
import { learningViewFixture } from "../learning/learningView.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Mode = "normal" | "accelerated";
const compatibility = { compatible: true, contract_version: "1" };
const exchange = { timeout: 5000 };

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 4, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}

/** The real App over one synthetic server (entry, Settings, Today) and the Learning view fixture as its study core. */
function app(mode: Mode) {
  const f = learningViewFixture("normal", null); f.view.dispose(); f.owner.dispose();
  let version = 1n, session: string | null = null;
  const observe = async (reply: Response, init?: RequestInit) => {
    const value = await reply.clone().json().catch(() => null) as { state_version?: unknown } | null;
    if (typeof value?.state_version !== "string") return reply;
    if (init?.method === "POST") version++;
    if (BigInt(value.state_version) > version) version = BigInt(value.state_version);
    return response({ ...value, state_version: String(version) }, reply.status);
  };
  let learning: Fetch = async (url, init) => observe(await f.handler(url, init), init);
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = mode;
  const account = (): Profile => ({ ...profile(String(version)), ui_language: "ru", dictionary_language: "ru" });
  const settingsReply = vi.fn(async () => response({ ...structuredClone(stored), state_version: String(version) }));
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-01T00:00:00Z",
      profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return response({ status: "opened", profile: account(), compatibility,
      client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1",
      session: session === null ? null : { id: session, phase: "active" } });
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) return settingsReply();
    return learning(url, init);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  const posts = (): (LearningCommandIntent & Record<string, unknown>)[] => fetcher.mock.calls
    .filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands")).map(([, init]) => JSON.parse(String(init!.body)));
  return { f, fetcher, posts, settingsReply, kinds: () => posts().map(post => post.kind as string),
    bind(id: string) { session = id; },
    /** The server commits the next answer, but its reply is lost (a timeout after commit). */
    loseAnswerReply() {
      const base = learning;
      let lost = false;
      learning = async (url, init) => {
        if (lost || init?.method !== "POST" || JSON.parse(String(init.body)).kind !== "answer.submit") return base(url, init);
        lost = true; await base(url, init); throw new TypeError("network");
      };
    },
    /** The server commits the next correction, but its reply is lost (a timeout after commit). */
    loseCorrectionReply() {
      const base = learning;
      let lost = false;
      learning = async (url, init) => {
        if (lost || init?.method !== "POST" || JSON.parse(String(init.body)).kind !== "result.correct") return base(url, init);
        lost = true; await base(url, init); throw new TypeError("network");
      };
    },
    /** Every later status check by command ID answers ms late (QA-RESULT-RESTORE-V2 W-slowCommand). */
    slowCommandChecks(ms: number) {
      if (ms === 0) return;
      const base = learning;
      learning = async (url, init) => {
        const path = new URL(String(url), "http://localhost").pathname;
        if ((init?.method ?? "GET") === "GET" && path.includes("/commands/")) await new Promise(resolve => setTimeout(resolve, ms));
        return base(url, init);
      };
    },
    /** The first study read after this call is refused with 403: the page re-enters in place (no reload). */
    denyNextRead() {
      const base = learning;
      let denied = false;
      learning = async (url, init) => {
        const path = new URL(String(url), "http://localhost").pathname;
        if (!denied && (init?.method ?? "GET") === "GET" && (path.includes("/commands/") || path.includes("/sessions/"))) {
          denied = true; return new Response("", { status: 403 });
        }
        return base(url, init);
      };
    },
    /** Study reads (status by ID, session reads) fail like a lost connection until the returned restore is called. */
    offlineStudy() {
      const base = learning;
      learning = async (url, init) => {
        const path = new URL(String(url), "http://localhost").pathname;
        if ((init?.method ?? "GET") === "GET" && (path.includes("/commands/") || path.includes("/sessions/"))) throw new TypeError("network");
        return base(url, init);
      };
      return () => { learning = base; };
    } };
}
type Server = ReturnType<typeof app>;

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const sleep = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const tree = (strict: boolean) => strict ? <StrictMode><App /></StrictMode> : <App />;
const presents = (a: Server) => a.kinds().filter(kind => kind === "assignment.present").length;
const submits = (a: Server, commandId: string) => a.posts().filter(post => post.command_id === commandId);
async function editable() {
  const input = await screen.findByRole("textbox", undefined, exchange);
  await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false), exchange);
  return input as HTMLInputElement;
}
/** Start a new group in a fresh App and reach its first question. */
async function startToQuestion(a: Server, strict: boolean) {
  render(tree(strict));
  const start = await screen.findByRole("button", { name: /Новая группа слов/ }, exchange);
  await waitFor(() => expect(a.settingsReply).toHaveBeenCalled());
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false), exchange);
  fireEvent.click(start);
  fireEvent.click(await screen.findByRole("button", { name: "Дальше" }, exchange));
  const input = await editable();
  a.bind(a.posts()[0].session_id as string);
  return input;
}
/** Answer with a lost reply; returns its command and the result the server committed. */
async function answerWithLostReply(a: Server, input: HTMLInputElement, text: string) {
  a.loseAnswerReply(); const online = a.offlineStudy();
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await waitFor(() => expect(a.kinds()).toContain("answer.submit"));
  const command = a.posts().find(post => post.kind === "answer.submit")!;
  await sleep(50);
  return { commandId: command.command_id as string, assignmentId: command.assignment_id as string, online };
}
/** The result was never shown in the first page; a full reload then finds it by its command ID. */
async function reloadAfterLostAnswer(mode: Mode, text: string, strict: boolean, delay = 0) {
  const a = app(mode); if (text !== "Haus") a.f.wrong();
  const input = await startToQuestion(a, strict);
  const { commandId, assignmentId, online } = await answerWithLostReply(a, input, text);
  cleanup(); online(); a.slowCommandChecks(delay);
  const mark = a.fetcher.mock.calls.length;
  render(tree(strict));
  await waitFor(() => expect(a.fetcher.mock.calls.slice(mark).some(([url]) => String(url).includes(`/commands/${commandId}`))).toBe(true), exchange);
  return { a, commandId, assignmentId };
}
const label = (mode: Mode, strict: boolean) => `${mode}${strict ? ", StrictMode" : ""}`;
const cases = ([["normal", false], ["accelerated", false], ["normal", true], ["accelerated", true]] as [Mode, boolean][]);
/** How late the reload's status check of the old command answers: 0, 400 or 1500 ms. */
const delays = [0, 400, 1500];

describe("Learning result first shown after a full reload (decision 20.1-А)", () => {
  for (const delay of delays) for (const [mode, strict] of cases) it(`a confirmed correct answer waits for «Далее»; then exactly one present; status check ${delay} ms late (${label(mode, strict)})`, async () => {
    const { a, commandId } = await reloadAfterLostAnswer(mode, "Haus", strict, delay);
    await screen.findByRole("region", { name: "Верно" }, exchange);
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByRole("region", { name: "Верно" })).toBeTruthy();
    expect(presents(a)).toBe(before);
    expect(submits(a, commandId)).toHaveLength(1);
    // The result shown is the one the server committed for the lost answer: its grades are still offered.
    expect(screen.getByRole("button", { name: "Легко" })).toBeTruthy();
    expect(a.kinds().filter(kind => kind.startsWith("result."))).toEqual([]);
    const next = await screen.findByRole("button", { name: "Далее" }, exchange);
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false), exchange);
    fireEvent.click(next);
    await waitFor(() => expect(presents(a)).toBe(before + 1), exchange);
    await editable(); await sleep(500);
    expect(presents(a)).toBe(before + 1);
    expect(a.kinds().filter(kind => kind.startsWith("result."))).toEqual([]);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const [mode, strict] of cases) it(`a grade on the reloaded result targets exactly that result (${label(mode, strict)})`, async () => {
    const { a, commandId, assignmentId } = await reloadAfterLostAnswer(mode, "Haus", strict);
    await screen.findByRole("region", { name: "Верно" }, exchange);
    await sleep(3500);
    // The fixture names the result of an answer by its assignment.
    const resultId = id(700 + Number(assignmentId.slice(-3)));
    const easy = await screen.findByRole("button", { name: "Легко" }, exchange);
    await waitFor(() => expect((easy as HTMLButtonElement).disabled).toBe(false), exchange);
    fireEvent.click(easy);
    await waitFor(() => expect(a.kinds()).toContain("result.grade"));
    const grade = a.posts().find(post => post.kind === "result.grade")!;
    expect([grade.result_id, grade.expected_result_version, grade.payload]).toEqual([resultId, "1", { grade: 5 }]);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const strict of [false, true]) it(`a confirmed error after a reload waits as before (${label("normal", strict)})`, async () => {
    const { a, commandId } = await reloadAfterLostAnswer("normal", "falsch", strict);
    await screen.findByRole("region", { name: "Есть ошибка" }, exchange);
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByRole("region", { name: "Есть ошибка" })).toBeTruthy();
    expect(presents(a)).toBe(before);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const strict of [false, true]) it(`an error after a reload in the accelerated mode advances after 2 s as before (${label("accelerated", strict)})`, async () => {
    const { a, commandId } = await reloadAfterLostAnswer("accelerated", "falsch", strict);
    await screen.findByRole("region", { name: "Есть ошибка" }, exchange);
    const before = presents(a), shown = Date.now();
    await waitFor(() => expect(presents(a)).toBe(before + 1), { timeout: 6000 });
    expect(Date.now() - shown).toBeGreaterThanOrEqual(1800);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const [mode, strict] of cases) it(`control: the first show in the live window advances after ${mode === "accelerated" ? 2 : 3} s (${label(mode, strict)})`, async () => {
    const a = app(mode); const input = await startToQuestion(a, strict);
    fireEvent.change(input, { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByRole("region", { name: "Верно" }, exchange);
    const before = presents(a), shown = Date.now();
    await waitFor(() => expect(presents(a)).toBe(before + 1), { timeout: 6000 });
    const elapsed = Date.now() - shown;
    expect(elapsed).toBeGreaterThanOrEqual(mode === "accelerated" ? 1800 : 2800);
    expect(elapsed).toBeLessThan(mode === "accelerated" ? 2900 : 3900);
  }, 40_000);

  for (const [mode, strict] of cases) it(`control: a lost reply recovered in the live window advances after ${mode === "accelerated" ? 2 : 3} s (${label(mode, strict)})`, async () => {
    const a = app(mode); const input = await startToQuestion(a, strict);
    const { commandId, online } = await answerWithLostReply(a, input, "Haus");
    online();
    await screen.findByRole("region", { name: "Верно" }, { timeout: 10_000 });
    const before = presents(a), shown = Date.now();
    await waitFor(() => expect(presents(a)).toBe(before + 1), { timeout: 6000 });
    const elapsed = Date.now() - shown;
    expect(elapsed).toBeGreaterThanOrEqual(mode === "accelerated" ? 1800 : 2800);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const [mode, strict] of cases) it(`a 403 re-entry in the same window (no reload) shows the old result and waits for «Далее» (decision 22.1-А, ${label(mode, strict)})`, async () => {
    const a = app(mode); const input = await startToQuestion(a, strict);
    a.loseAnswerReply(); a.denyNextRead();
    fireEvent.change(input, { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(a.kinds()).toContain("answer.submit"));
    const command = a.posts().find(post => post.kind === "answer.submit")!, commandId = command.command_id as string;
    fireEvent.click(await screen.findByRole("button", { name: "Попробовать ещё раз" }, { timeout: 10_000 }));
    await screen.findByRole("region", { name: "Верно" }, { timeout: 10_000 });
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByRole("region", { name: "Верно" })).toBeTruthy();
    expect(presents(a)).toBe(before);
    const easy = screen.getByRole("button", { name: "Легко" }) as HTMLButtonElement;
    await waitFor(() => expect(easy.disabled).toBe(false), exchange);
    fireEvent.click(easy);
    await waitFor(() => expect(a.kinds()).toContain("result.grade"));
    const grade = a.posts().find(post => post.kind === "result.grade")!;
    expect([grade.result_id, grade.expected_result_version, grade.payload])
      .toEqual([id(700 + Number((command.assignment_id as string).slice(-3))), "1", { grade: 5 }]);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  // 32.1-А is the written quiz's. A Learning correction restored after a reload is not held: the view goes on to the next
  // question by the usual transition and offers «Предыдущий ответ» (behaviour of restore v2, recorded here, unchanged).
  for (const [mode, strict] of cases) it(`a correction restored after a reload leaves the next question on screen (32.1-А is written only, ${label(mode, strict)})`, async () => {
    const a = app(mode); a.f.wrong();
    const input = await startToQuestion(a, strict);
    fireEvent.change(input, { target: { value: "falsch" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByRole("region", { name: "Есть ошибка" }, exchange);
    a.loseCorrectionReply(); const online = a.offlineStudy();
    const fix = await screen.findByRole("button", { name: "Исправить ответ" }, exchange) as HTMLButtonElement;
    await waitFor(() => expect(fix.disabled).toBe(false), exchange);
    fireEvent.click(fix);
    await waitFor(() => expect(a.kinds()).toContain("result.correct"));
    const lost = a.posts().find(post => post.kind === "result.correct")!;
    await sleep(50);
    cleanup(); online();
    const mark = a.fetcher.mock.calls.length, before = presents(a);
    render(tree(strict));
    await waitFor(() => expect(a.fetcher.mock.calls.slice(mark).some(([url]) => String(url).includes(`/commands/${lost.command_id}`))).toBe(true), exchange);
    await editable();
    expect(presents(a)).toBe(before + 1);
    expect(screen.queryByText("Ответ исправлен")).toBeNull();
    expect(screen.getByRole("button", { name: "Предыдущий ответ" })).toBeTruthy();
    expect(a.kinds().filter(kind => kind === "result.correct")).toHaveLength(1);
  }, 40_000);
});
