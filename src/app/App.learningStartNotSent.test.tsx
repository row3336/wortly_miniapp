import { withJournalIntake } from "../journal/intake.test-support";
// Learning through the actual App: the start is stored while a foreground open replaces the open handle (same key), so
// its request never starts. Owner decision 33.1-А (C194): no Stop of it; after the check under the new handle the same
// start is sent once, or the session the check found is recovered.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, SettingsResponse, TodayResponse } from "../api/generated";
import { learningViewFixture } from "../learning/learningView.test-support";
import { profile, response } from "../learning/learningFixtures.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

const LSLOT = "wortly.pending.learning_session";
/** The App's real browser storage, with one held read of the Learning slot (the start's save) while armed. */
const hold = vi.hoisted(() => ({ armed: false, release: () => {}, gate: Promise.resolve() }));
vi.mock("../platform/storage", async original => {
  const real = await original<typeof import("../platform/storage")>();
  return { ...real, browserStorage: (storage: Storage) => {
    const base = real.browserStorage(storage);
    return { ...base, get: async (key: string) => {
      if (hold.armed && key === LSLOT) { hold.armed = false; await hold.gate; }
      return base.get(key);
    } };
  } };
});
const arm = () => { hold.gate = new Promise<void>(done => { hold.release = done; }); hold.armed = true; };

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const compatibility = { compatible: true, contract_version: "1" };
const exchange = { timeout: 5000 };
const settled = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(done => setTimeout(done, 20)); }); };

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 4, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
function learning() {
  const f = learningViewFixture("normal", null); f.view.dispose(); f.owner.dispose();
  let version = 1n;
  const account = (): Profile => profile(String(version));
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const opens: string[] = [];
  const sent = new Set<string>(), started = new Set<string>(), knows = new Set<string>();
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-02T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) {
      opens.push(body.event);
      return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
        document_id: body.document_id, proof_version: "1", document_epoch: "1", session: null });
    }
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(version) } as SettingsResponse);
    const parsed = new URL(String(url), "http://localhost");
    if (init?.method === "POST" && path.endsWith("/commands")) { sent.add(body.command_id); started.add(body.session_id); }
    if (!init?.method || init.method === "GET") {
      const v = String(version);
      // A command this server never received, and a session number it never started (core: not_found for both).
      if (parsed.pathname.includes("/commands/")) {
        const commandId = parsed.pathname.split("/").at(-1)!;
        if (!sent.has(commandId) && !knows.has(commandId)) {
          return response({ state_version: v, current: account(), command: { id: commandId, status: "not_found" } });
        }
      }
      const sessionId = parsed.pathname.match(/\/sessions\/([^/]+)$/)?.[1];
      if (sessionId && !started.has(sessionId) && !parsed.searchParams.get("result_id")) {
        return response({ state_version: v, current: { session_id: sessionId, status: "not_found" } });
      }
    }
    const reply = await f.handler(url, init);
    const value = await reply.clone().json().catch(() => null) as { state_version?: unknown } | null;
    if (typeof value?.state_version !== "string") return reply;
    if (init?.method === "POST") version++;
    if (BigInt(value.state_version) > version) version = BigInt(value.state_version);
    return response({ ...value, state_version: String(version) }, reply.status);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))
    .map(([, init]) => { const body = JSON.parse(String(init!.body)); return `${body.kind}:${body.session_id}`; });
  const checks = () => fetcher.mock.calls.filter(([url, init]) => (!init?.method || init.method === "GET") && String(url).includes("/commands/")).length;
  return { fetcher, posts, opens, checks };
}
const foreground = () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
};

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "200000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { hold.release(); hold.armed = false; cleanup(); localStorage.clear(); window.history.replaceState(null, "", "/");
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

/** «Начать» with the start's save held, then a real foreground (a new open handle of the same key) during the save. */
async function storedDuringForeground(extraForeground = false) {
  const s = learning(); render(<App />);
  const start = await screen.findByRole("button", { name: /Новая группа слов/ }, exchange); await settled();
  arm(); fireEvent.click(start); await settled();
  const exit = () => screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement;
  expect(exit().disabled).toBe(true);
  fireEvent.click(exit()); foreground(); await settled(10);
  expect(s.opens).toContain("foreground");
  expect(exit().disabled).toBe(true);
  const record = JSON.parse(localStorage.getItem(LSLOT) ?? "null");
  hold.release();
  if (extraForeground) foreground();
  return { s, exit, record };
}

describe("App Learning: a start stored while a foreground open replaced its handle (33.1-А)", () => {
  it("never a Stop of Y; after the check the same start is sent exactly once and the session opens", async () => {
    const { s, exit } = await storedDuringForeground();
    await settled(20);
    const posts = s.posts();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/^session\.start:/);
    const sentId = JSON.parse(String(s.fetcher.mock.calls.find(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"))![1]!.body)).command_id;
    expect(s.checks()).toBeGreaterThan(0);
    // The old handle never sent it: the one POST went after the check, through the current handle, with the stored ID.
    expect(localStorage.getItem(LSLOT)).toBeNull();
    await waitFor(() => expect(exit().disabled).toBe(false));
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    expect(sentId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("a second foreground during the check still sends the start once", async () => {
    const { s } = await storedDuringForeground(true);
    await settled(5); foreground(); await settled(20);
    expect(s.posts().filter(post => post.startsWith("session.start"))).toHaveLength(1);
    expect(s.posts().filter(post => post.startsWith("session.stop"))).toEqual([]);
  });
  it("a manual «Проверить состояние» / «Повторить» during the automatic send still gives one POST start", async () => {
    const { s } = await storedDuringForeground();
    await settled(1);
    for (const name of ["Проверить состояние", "Повторить"]) {
      const button = screen.queryByRole("button", { name });
      if (button && !(button as HTMLButtonElement).disabled) fireEvent.click(button);
    }
    await settled(20);
    expect(s.posts().filter(post => post.startsWith("session.start"))).toHaveLength(1);
  });
});
