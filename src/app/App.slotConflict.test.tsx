// M-SLOT-CONFLICT-LC through the actual App: a live window, and the record X of an old window written into the shared slot.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, SettingsResponse, TodayResponse } from "../api/generated";
import { conjugationId, conjugationServer, FORMS, type ModelSession } from "../conjugation/conjugationModel.test-support";
import { learningViewFixture } from "../learning/learningView.test-support";
import { id, profile, response } from "../learning/learningFixtures.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const compatibility = { compatible: true, contract_version: "1" };
const exchange = { timeout: 5000 };
const LSLOT = "wortly.pending.learning_session", CSLOT = "wortly.pending.conjugation_session";
const settled = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(done => setTimeout(done, 20)); }); };

function learningToday(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 4, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
function conjToday(): TodayResponse {
  return { ...learningToday(), learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    local_date: "2026-10-01", conjugation: { ready: 2, openable: 2, next_due_date: null } };
}
function shell(fetcherTail: Fetch, today: () => TodayResponse, account: () => Profile, version: () => string) {
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-02T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
      document_id: body.document_id, proof_version: "1", document_epoch: "1", session: shellState.session === null ? null : { id: shellState.session, phase: "active" } });
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: version() });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: version() } as SettingsResponse);
    return fetcherTail(url, init);
  });
  const shellState = { session: null as string | null };
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  const study = () => fetcher.mock.calls.map(([url, init]) => {
    const u = new URL(String(url), "http://localhost"), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (init?.method === "POST" && u.pathname.endsWith("/commands")) return `POST ${body.kind} ${String(body.command_id).slice(-4)}`;
    if (u.pathname.includes("/commands/")) return `GET status ${u.pathname.split("/").pop()!.slice(-4)}`;
    if (u.pathname.includes("/sessions/") || u.pathname.includes("/results/") || u.pathname.includes("/conjugation")) return `GET ${u.pathname.split("/").slice(-2).join("/").slice(-30)}`;
    return null;
  }).filter((x): x is string => x !== null && !x.includes("setting"));
  const client = () => { const call = fetcher.mock.calls.find(([u]) => String(u).endsWith("/client/open")); return JSON.parse(String(call![1]!.body)).client_instance_id as string; };
  return { fetcher, shellState, study, client };
}
async function editable() {
  const input = await screen.findByRole("textbox", undefined, exchange);
  await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
  return input as HTMLInputElement;
}
/** The false lines of an unknown outcome: none of them is true of an action that was never stored or sent. */
const falseLines = ["Проверяем, сохранилось ли действие.", "Нет связи с сервером. Ждём, когда связь восстановится…",
  "Ответ ещё не подтверждён. Проверь статус.", "Действие ещё не подтверждено. Проверь статус."];
const shown = (text: string) => screen.queryAllByText(text).length > 0;

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "200000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function learning(session: string | null) {
  const f = learningViewFixture("normal", null); f.view.dispose(); f.owner.dispose();
  let version = 1n;
  const observe = async (reply: Response, init?: RequestInit) => {
    const value = await reply.clone().json().catch(() => null) as { state_version?: unknown } | null;
    if (typeof value?.state_version !== "string") return reply;
    if (init?.method === "POST") version++;
    if (BigInt(value.state_version) > version) version = BigInt(value.state_version);
    return response({ ...value, state_version: String(version) }, reply.status);
  };
  const s = shell(async (url, init) => observe(await f.handler(url, init), init), learningToday, () => profile(String(version)), () => String(version));
  s.shellState.session = session;
  return s;
}
const lx = (client: string, intent: object) => JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: client, pair: "ru-de", intent });

function conjugation(sessions: ModelSession[], reported: string | null) {
  const model = conjugationServer({ sessions, version: "10", profileId: conjugationId(50) });
  const account = (): Profile => ({ profile_id: conjugationId(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: model.version(), access: { status: "admitted", version: "1", reason: null } });
  const s = shell(async (url, init) => await model.handle(url, init) ?? response({ error: { code: "UNEXPECTED" } }, 500), conjToday, account, () => model.version());
  s.shellState.session = reported;
  return s;
}
const cx = (client: string, intent: object) => JSON.stringify({ schemaVersion: 1, profileId: conjugationId(50), clientInstanceId: client, pair: "ru-de", intent });
const S1 = conjugationId(3);

describe("Learning: a new action meets the old window's record", () => {
  it("an answer: no false lines, the draft stays editable, nothing of Y is sent or checked", async () => {
    const s = learning(id(3)); render(<App />);
    const input = await editable(); await settled();
    const x = lx(s.client(), { command_id: id(777), kind: "answer.submit", session_id: id(3), assignment_id: id(6), payload: { text: "Alt" } });
    localStorage.setItem(LSLOT, x);
    const from = s.study().length;
    fireEvent.change(input, { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await settled(10);
    for (const line of falseLines) expect(shown(line)).toBe(false);
    expect((screen.getByRole("textbox") as HTMLInputElement)).toMatchObject({ value: "Haus", readOnly: false });
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await settled(10);
    expect(s.study().slice(from).filter(line => line.startsWith("POST") || line.startsWith("GET status"))).toEqual([]);
    expect(localStorage.getItem(LSLOT)).toBe(x);
  });
  it("a start: the view stays before the start; the check asks for nothing", async () => {
    const s = learning(null); render(<App />);
    const start = await screen.findByRole("button", { name: /Новая группа слов/ }, exchange); await settled();
    localStorage.setItem(LSLOT, lx(s.client(), { command_id: id(777), kind: "answer.submit", session_id: id(3), assignment_id: id(6), payload: { text: "Alt" } }));
    const from = s.study().length;
    fireEvent.click(start); await settled(10);
    for (const line of falseLines) expect(shown(line)).toBe(false);
    expect(shown("Занятие ещё не началось.")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await settled(10);
    expect(s.study().slice(from)).toEqual([]);
  });
});

describe("Conjugation: a new action meets the old window's record", () => {
  /** X lands in the slot between the new owner's load and its save: the only way this lane meets the conflict. */
  const race = (value: string) => {
    let reads = -1;
    const original = Storage.prototype.getItem, set = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, key: string) {
      if (key === CSLOT && reads >= 0 && ++reads === 2) set.call(this, CSLOT, value);
      return original.call(this, key);
    });
    return { arm: () => { reads = 0; } };
  };
  it("an answer (X written between the owner's load and save): no unknown line, nothing of Y is sent or checked", async () => {
    const s = conjugation([{ id: S1, status: "active", assignment: FORMS[0], presented: true, results: [] }], S1); render(<App />);
    const input = await editable(); await settled();
    const x = cx(s.client(), { command_id: conjugationId(777), kind: "answer.submit", session_id: S1, assignment_id: FORMS[0], payload: { text: "alt" } });
    const r = race(x), from = s.study().length;
    fireEvent.change(input, { target: { value: "kommst" } });
    r.arm(); fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await settled(10);
    for (const line of falseLines) expect(shown(line)).toBe(false);
    expect(screen.queryByRole("button", { name: "Повторить действие" })).toBeNull();
    expect(s.study().slice(from)).toEqual([]);
    expect(localStorage.getItem(CSLOT)).toBe(x);
  });
  it("a start (X written between load and save): no session of Y is read; only X is checked by its own ID", async () => {
    const s = conjugation([], null); render(<App />);
    const start = await screen.findByRole("button", { name: /Тест спряжений/ }, exchange);
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false)); await settled();
    const r = race(cx(s.client(), { command_id: conjugationId(777), kind: "answer.submit", session_id: S1, assignment_id: FORMS[0], payload: { text: "alt" } }));
    const from = s.study().length;
    r.arm(); fireEvent.click(start); await settled(10);
    const after = s.study().slice(from);
    expect(after.filter(line => line.startsWith("POST"))).toEqual([]);
    // The only status check is X's (the existing take-over of a record by a new document); Y's session ID is never read.
    expect(after.filter(line => line.startsWith("GET status")).every(line => line === "GET status 0777")).toBe(true);
    expect(after.filter(line => line.startsWith("GET ") && !line.startsWith("GET status")).every(line => line.endsWith(S1.slice(-30)))).toBe(true);
  });
});
