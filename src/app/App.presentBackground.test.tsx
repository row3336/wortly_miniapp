// C190: the actual App, Learning. «Далее» meets another window's record X; a real background and return around it; then a
// new accepted correction. Rule: after a return to the result it waits for «Далее» (К05-152, ui_spec 6.1.8, tz_app:109, 2.19).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, SettingsResponse, TodayResponse } from "../api/generated";
import { learningViewFixture } from "../learning/learningView.test-support";
import { id, profile, response } from "../learning/learningFixtures.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const compatibility = { compatible: true, contract_version: "1" };
const exchange = { timeout: 5000 };
const LSLOT = "wortly.pending.learning_session";
const settled = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(done => setTimeout(done, 20)); }); };

function learningToday(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 4, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
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
  return { ...s, f };
}
const lx = (client: string, intent: object) => JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: client, pair: "ru-de", intent });

const visibility = (state: "hidden" | "visible") => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event(state === "hidden" ? "pagehide" : "pageshow"));
};
const posts = (s: { fetcher: { mock: { calls: [string | URL | Request, RequestInit?][] } } }) => s.fetcher.mock.calls
  .filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands")).map(([, init]) => JSON.parse(String(init!.body)).kind as string)
  .filter(kind => kind !== "setting.save");
async function wrongResult() {
  const s = learning(id(3)); s.f.wrong(); render(<App />);
  const input = await editable(); await settled();
  fireEvent.change(input, { target: { value: "falsch" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByRole("region", { name: "Есть ошибка" }, exchange); await settled();
  return s;
}
async function checkedThenCorrected(s: Awaited<ReturnType<typeof wrongResult>>) {
  localStorage.removeItem(LSLOT);
  // The return's own read may already have lifted the block; then there is no check button left to press.
  const check = screen.queryByRole("button", { name: "Проверить состояние" });
  if (check) { fireEvent.click(check); await settled(10); }
  const before = posts(s).length;
  fireEvent.click(await screen.findByRole("button", { name: "Исправить ответ" }, exchange)); await settled(10);
  await act(async () => { await new Promise(done => setTimeout(done, 4500)); }); await settled();
  return posts(s).slice(before);
}

const xRecord = (s: { client(): string }) => lx(s.client(), { command_id: id(777), kind: "answer.submit", session_id: id(3), assignment_id: id(6), payload: { text: "Alt" } });
const wait = (ms: number) => act(async () => { await new Promise(done => setTimeout(done, ms)); });

describe("C190: background around a refused «Далее» on the actual App", () => {
  it("background in the same task as the tap: the present never reaches the slot; after the return the machine meets X and B is shown, never the old result", async () => {
    const s = await wrongResult();
    const sent = posts(s).length;
    localStorage.setItem(LSLOT, xRecord(s));
    // Earlier than any real background can come (a browser event waits for the microtasks of the tap).
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Далее" })); visibility("hidden"); });
    await settled(10);
    expect(posts(s).slice(sent)).toEqual([]);
    await act(async () => { visibility("visible"); }); await settled(20);
    // The automatic recovery of the present resumes on its probe schedule and is refused over X.
    await wait(8000); await settled();
    expect(posts(s).slice(sent)).toEqual([]);
    expect(screen.queryByRole("region", { name: "Есть ошибка" })).toBeNull();
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    localStorage.removeItem(LSLOT);
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await settled(10);
    expect(posts(s).slice(sent)).toEqual(["assignment.present"]);
  }, 40000);
  it("background after the refusal restored the result: after the return and the check an accepted correction waits for «Далее»", async () => {
    const s = await wrongResult();
    const sent = posts(s).length;
    localStorage.setItem(LSLOT, xRecord(s));
    fireEvent.click(screen.getByRole("button", { name: "Далее" })); await settled(10);
    expect(screen.getByRole("region", { name: "Есть ошибка" })).toBeTruthy();
    await act(async () => { visibility("hidden"); }); await act(async () => { visibility("visible"); }); await settled(10);
    expect(screen.getByRole("region", { name: "Есть ошибка" })).toBeTruthy();
    expect(posts(s).slice(sent)).toEqual([]);
    expect(await checkedThenCorrected(s)).toEqual(["result.correct"]);
  }, 30000);
  it("contrast without a background: the accepted correction after the refused «Далее» gets its own timer", async () => {
    const s = await wrongResult();
    localStorage.setItem(LSLOT, xRecord(s));
    fireEvent.click(screen.getByRole("button", { name: "Далее" })); await settled(10);
    expect(await checkedThenCorrected(s)).toEqual(["result.correct", "assignment.present"]);
  }, 30000);
});
