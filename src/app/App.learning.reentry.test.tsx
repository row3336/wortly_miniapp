import { withJournalIntake } from "../journal/intake.test-support";
// C163 (owner decision 22.1-А) reachable again after P03 M-P03-10 (AC-102 kept): a Learning answer the server committed but
// whose result the user never saw; then a 401 in the same window. The expired screen's own button signs in again (one
// auth — an L2 exception — then the FIRST open of a new document, п.8б (2), P03 AC-104); the restored «Верно» waits for
// «Далее» in normal and accelerated mode, and the old answer is never sent again. The `unavailable` retry() stays as
// M-P03-10 made it: an unknown 403 / an access 403 / a deleted profile / a proof FORBIDDEN never get this button.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, TodayResponse } from "../api/generated";
import type { LearningCommandIntent } from "../learning/learningCommandIntent";
import { profile, response } from "../learning/learningFixtures.test-support";
import { learningViewFixture } from "../learning/learningView.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { latestPageGate, pageGateOpen } from "./pageGate.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Mode = "normal" | "accelerated";
type Access = Profile["access"]["status"];
const compatibility = { compatible: true, contract_version: "1" };
const exchange = { timeout: 5000 };
const envelope = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: code } }), { status });

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
  let version = 1n, session: string | null = null, access: Access = "admitted";
  let authFailure: (() => Promise<Response>) | null = null;
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
  const account = (): Profile => ({ ...profile(String(version)), ui_language: "ru", dictionary_language: "ru",
    access: { status: access, version: access === "admitted" ? "1" : "2", reason: null } });
  const settingsReply = vi.fn(async () => response({ ...structuredClone(stored), state_version: String(version) }));
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) {
      if (authFailure) { const fail = authFailure; authFailure = null; return fail(); }
      return response({ access_token: "synthetic-token", expires_at: "2026-10-01T00:00:00Z", profile: account(), compatibility });
    }
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
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  const calls = () => fetcher.mock.calls.map(([url, init]) => ({ path: new URL(String(url), "http://localhost").pathname,
    method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null }));
  const posts = (): (LearningCommandIntent & Record<string, unknown>)[] => calls()
    .filter(call => call.method === "POST" && call.path.endsWith("/commands")).map(call => call.body as never);
  return { f, fetcher, calls, posts, settingsReply, kinds: () => posts().map(post => post.kind as string),
    opens: () => calls().filter(call => call.path.endsWith("/client/open")).map(call => call.body!),
    auths: () => calls().filter(call => call.path.endsWith("/auth/telegram")).length,
    bind(id: string) { session = id; },
    /** The profile the next auth/open reports (an access change on the server). */
    setAccess(next: Access) { access = next; },
    /** The next auth fails as given (a lost connection, a 503, an expired initData). */
    failNextAuth(reply: () => Promise<Response>) { authFailure = reply; },
    /** The server commits the next answer, but its reply is lost (a timeout after commit). */
    loseAnswerReply() {
      const base = learning;
      let lost = false;
      learning = async (url, init) => {
        if (lost || init?.method !== "POST" || JSON.parse(String(init.body)).kind !== "answer.submit") return base(url, init);
        lost = true; await base(url, init); throw new TypeError("network");
      };
    },
    /** The first study read after this call is refused with this reply (a 401 of the core, an access 403, a bare 403). */
    refuseNextRead(reply: () => Response) {
      const base = learning;
      let refused = false;
      learning = async (url, init) => {
        const path = new URL(String(url), "http://localhost").pathname;
        if (!refused && (init?.method ?? "GET") === "GET" && (path.includes("/commands/") || path.includes("/sessions/"))) {
          refused = true; return reply();
        }
        return base(url, init);
      };
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
/** Answer with a lost reply whose recovery read is refused by `refusal`; returns the answer's command. */
async function answerThenRefusal(a: Server, input: HTMLInputElement, refusal: () => Response) {
  a.loseAnswerReply(); a.refuseNextRead(refusal);
  fireEvent.change(input, { target: { value: "Haus" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await waitFor(() => expect(a.kinds()).toContain("answer.submit"));
  const command = a.posts().find(post => post.kind === "answer.submit")!;
  return { commandId: command.command_id as string, assignmentId: command.assignment_id as string };
}
const label = (mode: Mode, strict: boolean) => `${mode}${strict ? ", StrictMode" : ""}`;
const cases = ([["normal", false], ["accelerated", false], ["normal", true], ["accelerated", true]] as [Mode, boolean][]);
// P2-1 (pre-QA C163): only a revoked session (AUTH_INVALID, core identity/service.py:139–149) is recoverable in the same
// window — its signed initData may still be within max_age (telegram.py:120–121). An expired session (AUTH_EXPIRED,
// service.py:150–151) implies an initData older than max_age: the re-entry's auth answers 401 as well (Н4).
const revoked401 = () => envelope(401, "AUTH_INVALID");
const expired401 = () => envelope(401, "AUTH_EXPIRED");
const expiredTitle = "Нужно снова подтвердить вход";

describe("C163 / 22.1-А: a revoked session (401 AUTH_INVALID) in the same window, re-entry by the expired screen's button (AC-104)", () => {
  for (const [mode, strict] of cases) it(`the restored «Верно» waits for «Далее»; then exactly one present; the old answer is not resent (${label(mode, strict)})`, async () => {
    const a = app(mode); const input = await startToQuestion(a, strict);
    const { commandId } = await answerThenRefusal(a, input, revoked401);
    await screen.findByRole("heading", { name: expiredTitle }, { timeout: 10_000 });
    const again = await screen.findByRole("button", { name: "Попробовать ещё раз" }) as HTMLButtonElement;
    // Nothing leaves by itself from the expired screen: no auth, no open, no command (only an explicit click signs in).
    const quiet = a.fetcher.mock.calls.length, auths = a.auths(), firstOpens = a.opens();
    await sleep(800);
    expect(a.fetcher.mock.calls.length).toBe(quiet);
    await pageGateOpen();
    await waitFor(() => expect(again.disabled).toBe(false), exchange);
    fireEvent.click(again);
    await screen.findByRole("region", { name: "Верно" }, { timeout: 10_000 });
    // One new sign-in and the first open of a new document (п.8б (2)); the old document is never opened again.
    expect(a.auths()).toBe(auths + 1);
    const opens = a.opens(), added = opens.slice(firstOpens.length);
    expect(added.map(open => open.event)).toEqual(["open"]);
    expect(firstOpens.map(open => open.document_id)).not.toContain(added[0].document_id);
    expect(opens.every(open => open.return_marker === undefined)).toBe(true);
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByRole("region", { name: "Верно" })).toBeTruthy();
    expect(presents(a)).toBe(before);
    expect(submits(a, commandId)).toHaveLength(1);
    const next = await screen.findByRole("button", { name: "Далее" }, exchange);
    await waitFor(() => expect((next as HTMLButtonElement).disabled).toBe(false), exchange);
    fireEvent.click(next);
    await waitFor(() => expect(presents(a)).toBe(before + 1), exchange);
    await editable(); await sleep(500);
    expect(presents(a)).toBe(before + 1);
    expect(submits(a, commandId)).toHaveLength(1);
    expect(a.kinds().filter(kind => kind.startsWith("result."))).toEqual([]);
  }, 40_000);

  for (const strict of [false, true]) it(`a re-entry whose auth fails by transport opens nothing; the expired screen and its button come back (${label("normal", strict)})`, async () => {
    const a = app("normal"); const input = await startToQuestion(a, strict);
    const { commandId } = await answerThenRefusal(a, input, revoked401);
    const again = await screen.findByRole("button", { name: "Попробовать ещё раз" }, { timeout: 10_000 }) as HTMLButtonElement;
    await pageGateOpen();
    await waitFor(() => expect(again.disabled).toBe(false), exchange);
    const opens = a.opens().length, gate = latestPageGate()!;
    const attempts = gate.snapshot().openAttempts.length;
    a.failNextAuth(async () => { throw new TypeError("network"); });
    fireEvent.click(again);
    await waitFor(() => expect(a.auths()).toBeGreaterThan(1));
    await screen.findByRole("heading", { name: expiredTitle }, exchange);
    expect(a.opens()).toHaveLength(opens);
    expect(gate.snapshot().openAttempts).toHaveLength(attempts);
    // The button is the same rule of the button: active again once the gate (closed by the lost auth) is open.
    await pageGateOpen();
    const retry = await screen.findByRole("button", { name: "Попробовать ещё раз" }) as HTMLButtonElement;
    await waitFor(() => expect(retry.disabled).toBe(false), exchange);
    fireEvent.click(retry);
    await screen.findByRole("region", { name: "Верно" }, { timeout: 10_000 });
    expect(a.opens().slice(opens).map(open => open.event)).toEqual(["open"]);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  it("an expired session (401 AUTH_EXPIRED): the re-entry's auth answers 401 too — expired without a button (Н4), the new-launch text, no open", async () => {
    const a = app("normal"); const input = await startToQuestion(a, false);
    await answerThenRefusal(a, input, expired401);
    const again = await screen.findByRole("button", { name: "Попробовать ещё раз" }, { timeout: 10_000 }) as HTMLButtonElement;
    await pageGateOpen();
    await waitFor(() => expect(again.disabled).toBe(false), exchange);
    const opens = a.opens().length;
    a.failNextAuth(async () => envelope(401, "AUTH_EXPIRED"));
    fireEvent.click(again);
    await waitFor(() => expect(a.auths()).toBeGreaterThan(1));
    await sleep(300);
    expect(screen.getByRole("heading", { name: expiredTitle })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Попробовать ещё раз" })).toBeNull();
    expect(screen.getByText("Закрой приложение и снова нажми кнопку Wortly в боте.")).toBeTruthy();
    expect(a.opens()).toHaveLength(opens);
    expect(a.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
  }, 40_000);
});

describe("other causes of session=null keep the stop of M-P03-10 (no re-entry button, 0 open)", () => {
  const stops: [string, () => Response][] = [
    ["a bare 403 without the core's envelope (an unknown 403)", () => new Response("", { status: 403 })],
    ["403 FORBIDDEN of a module request (a refused proof, not the first open)", () => envelope(403, "FORBIDDEN")],
    ["403 ACCESS_REJECTED", () => envelope(403, "ACCESS_REJECTED")],
    ["403 ACCESS_PENDING", () => envelope(403, "ACCESS_PENDING")],
  ];
  for (const [name, refusal] of stops) it(`${name}: unavailable, its button blocked, nothing is sent; C163 is not reached this way`, async () => {
    const a = app("normal"); const input = await startToQuestion(a, false);
    const { commandId } = await answerThenRefusal(a, input, refusal);
    const again = await screen.findByRole("button", { name: "Попробовать ещё раз" }, { timeout: 10_000 }) as HTMLButtonElement;
    expect(screen.queryByRole("heading", { name: expiredTitle })).toBeNull();
    await pageGateOpen();
    const calls = a.fetcher.mock.calls.length;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    await sleep(800);
    expect(a.fetcher.mock.calls.length).toBe(calls);
    expect(screen.queryByRole("region", { name: "Верно" })).toBeNull();
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  // Integration with P04 (44f65bc): 403 PROFILE_DELETED shows the deletion's result S-A07 — no button, no re-entry.
  it("403 PROFILE_DELETED: the deletion's result without buttons, nothing is sent; C163 is not reached this way", async () => {
    const a = app("normal"); const input = await startToQuestion(a, false);
    const { commandId } = await answerThenRefusal(a, input, () => envelope(403, "PROFILE_DELETED"));
    await screen.findByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.", {}, { timeout: 10_000 });
    expect(screen.queryByRole("button", { name: "Попробовать ещё раз" })).toBeNull();
    const calls = a.fetcher.mock.calls.length;
    await sleep(800);
    expect(a.fetcher.mock.calls.length).toBe(calls);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);
});
