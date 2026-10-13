// М20 through the real App and HTTP client (TA:44, RA §6.1.5): the entry runs independently of the launch screen.
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { LAUNCH_BUILD_MS, LAUNCH_EXIT_MS } from "./LaunchScreen";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const today: TodayResponse = { state_version: "2", pair: "ru-de", local_date: "2026-10-05", status: "work_now",
  base: { total: 5, words: 4, phrases: 1 }, ordinary_status: "ready",
  ordinary: { words: { "l1-de": { ready: 2, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
  learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 },
  conjugation: { ready: 1, openable: 1, next_due_date: null }, next_repeat_date: null };

type Server = { auth: "ok" | 500; access: "admitted" | "pending" | "rejected"; gate: Promise<void> | null; reapplyGate: Promise<void> | null;
  busy: boolean; incompatible: boolean; todayGate: Promise<void> | null };

/** A synthetic server: /auth/telegram may be held by `gate`, so the test decides when the API becomes ready. */
function fixture(initial: Partial<Server> = {}) {
  const server: Server = { auth: "ok", access: "admitted", gate: null, reapplyGate: null, busy: false, incompatible: false, todayGate: null, ...initial };
  const profile = () => ({ profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: "1", access: { status: server.access, version: "1", reason: null } });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) {
      if (server.gate) await server.gate;
      if (server.auth !== "ok") return json({ error: { code: "INTERNAL_ERROR" } }, 500);
      return json({ access_token: "synthetic-token", expires_at: "2026-10-06T00:00:00Z", profile: profile(),
        compatibility: { compatible: !server.incompatible, contract_version: "1" } });
    }
    if (path.endsWith("/access/reapply")) {
      if (server.reapplyGate) await server.reapplyGate;
      server.access = "pending";
      return json({ command: { id: body.command_id, status: "applied", applied_at: "2026-10-05T12:00:00Z", target_id: id(1),
        object_version: "2" }, current: { ...profile(), access: { status: "pending", version: "2", reason: null } } });
    }
    if (path.endsWith("/client/register")) return json({ status: "registered", client_instance_id: body.client_instance_id,
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open") && server.busy) return json({ profile: profile(), compatibility: { compatible: true, contract_version: "1" },
      status: "SESSION_BUSY", session: { status: "busy", stop_remote_target: null } });
    if (path.endsWith("/client/open")) return json({ profile: profile(), compatibility: { compatible: true, contract_version: "1" },
      status: "opened", client_instance_id: body.client_instance_id, document_id: body.document_id, document_epoch: "1",
      proof_version: "1", session: null });
    if (path.endsWith("/settings")) {
      const data = settingsResponse(); data.state_version = "1";
      for (const field of Object.values(data.settings)) field.version = "1";
      // The dictionary language is already chosen (19.3-А); the first choice has its own tests (App.firstChoice).
      data.settings.dictionary_language.version = "2";
      data.settings.ui_language.value = "ru"; data.settings.dictionary_language.value = "ru";
      return json(data);
    }
    if (path.endsWith("/today")) { if (server.todayGate) await server.todayGate; return json(today); }
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init", initDataUnsafe: { user: { language_code: "ru" } }, colorScheme: "light" } });
  return { server, fetcher, auths: () => fetcher.mock.calls.filter(call => String(call[0]).endsWith("/auth/telegram")).length };
}

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const phase = () => document.querySelector<HTMLElement>(".launch")?.dataset.phase ?? null;
const host = () => document.querySelector<HTMLElement>(".launch-host")!;
const todayShown = () => screen.queryByRole("heading", { name: "Сегодня", level: 1 }) !== null;

beforeEach(() => {
  localStorage.clear(); vi.useFakeTimers();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "1000000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "10000"); vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("М20 with a fast API", () => {
  it("the entry starts at once and Today is under the launch screen long before the assembly ends", async () => {
    const f = fixture();
    render(<App />);
    await advance(0);
    expect(f.auths()).toBe(1);
    await advance(100);
    expect(todayShown()).toBe(true);
    expect(phase()).toBe("building");
    expect(host().hasAttribute("inert")).toBe(true);
  });

  it("assembly 2400 ms, then exit 700 ms, then Today is live", async () => {
    fixture();
    render(<App />);
    await advance(LAUNCH_BUILD_MS - 1);
    expect(phase()).toBe("building");
    await advance(1);
    expect(phase()).toBe("leaving");
    expect(host().className).toContain("launch-host--entering");
    await advance(LAUNCH_EXIT_MS - 1);
    expect(phase()).toBe("leaving");
    await advance(1);
    expect(phase()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
    expect(todayShown()).toBe(true);
  });
});

describe("М20 with a slow API: the timer does not confirm the entry (RA:155)", () => {
  it("the logo and the spinner wait for the entry past 2400 ms; the exit starts only when it is decided", async () => {
    let release = () => {};
    const f = fixture({ gate: new Promise<void>(resolve => { release = resolve; }) });
    render(<App />);
    await advance(0);
    expect(f.auths()).toBe(1);
    await advance(LAUNCH_BUILD_MS);
    expect(phase()).toBe("waiting");
    await advance(30_000);
    expect(phase()).toBe("waiting");
    expect(todayShown()).toBe(false);
    expect(host().hasAttribute("inert")).toBe(true);
    release();
    await advance(0);
    expect(phase()).toBe("leaving");
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    expect(todayShown()).toBe(true);
  });
});

describe("М20 and refusals lead to the entry screens (Д01/Д04)", () => {
  it("an unavailable entry waits for the end of the assembly, leaves in 700 ms and offers a retry; retry brings no new launch", async () => {
    const f = fixture({ auth: 500 });
    render(<App />);
    await advance(100);
    expect(phase()).toBe("building");
    expect(screen.getByRole("heading", { name: "Не удалось открыть Wortly" })).toBeTruthy();
    await advance(LAUNCH_BUILD_MS - 100);
    expect(phase()).toBe("leaving");
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    f.server.auth = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Попробовать ещё раз" }));
    await advance(0);
    expect(phase()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
    await advance(50);
    expect(todayShown()).toBe(true);
    expect(f.auths()).toBe(2);
  });

  it("a pending request is a decided entry too: the access screen after the exit", async () => {
    fixture({ access: "pending" });
    render(<App />);
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    expect(screen.getByRole("heading", { name: "Заявка отправлена" })).toBeTruthy();
  });
});

describe("М20 while a reapply is being saved", () => {
  it("the entry shows its own wait again, so the launch screen keeps waiting after the assembly and leaves once it is answered", async () => {
    let release = () => {};
    fixture({ access: "rejected", reapplyGate: new Promise<void>(resolve => { release = resolve; }) });
    render(<App />);
    await advance(100);
    // fireEvent ignores inert: it stands for the entry changing state on its own under the launch screen.
    fireEvent.click(screen.getByRole("button", { name: "Подать заявку ещё раз" }));
    await advance(LAUNCH_BUILD_MS);
    expect(phase()).toBe("waiting");
    release();
    await advance(0);
    expect(phase()).toBe("leaving");
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    expect(screen.getByRole("heading", { name: "Заявка отправлена" })).toBeTruthy();
  });
});

describe("М20 with reduced motion: the still logo until the entry is decided", () => {
  it("shows the finished logo without motion, keeps the application inert, then changes the screen at once", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener() {}, removeEventListener() {} })));
    let release = () => {};
    fixture({ gate: new Promise<void>(resolve => { release = resolve; }) });
    render(<App />);
    await advance(LAUNCH_BUILD_MS + 5000);
    expect(phase()).toBe("still");
    expect(document.querySelector(".launch--still .launch-word")).not.toBeNull();
    expect(host().hasAttribute("inert")).toBe(true);
    expect(todayShown()).toBe(false);
    release();
    await advance(0);
    // No 700 ms exit and no entering motion: the logo is simply gone.
    expect(phase()).toBeNull();
    expect(host().className).toBe("launch-host");
    expect(host().hasAttribute("inert")).toBe(false);
    await advance(50);
    expect(todayShown()).toBe(true);
  });

  it("a refusal removes the still logo at once too", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)",
      addEventListener() {}, removeEventListener() {} })));
    fixture({ auth: 500 });
    render(<App />);
    await advance(50);
    expect(phase()).toBeNull();
    expect(screen.getByRole("heading", { name: "Не удалось открыть Wortly" })).toBeTruthy();
  });
});

describe("М20: every answer of the entry is a decided one", () => {
  it("SESSION_BUSY before 2400 ms: the whole assembly, the exit, then the busy screen", async () => {
    fixture({ busy: true });
    render(<App />);
    await advance(300);
    expect(phase()).toBe("building");
    await advance(LAUNCH_BUILD_MS - 301);
    expect(phase()).toBe("building");
    await advance(1);
    expect(phase()).toBe("leaving");
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    expect(host().hasAttribute("inert")).toBe(false);
    expect(document.body.textContent).toMatch(/другом устройстве|уже открыт/);
  });

  it("an incompatible client before 2400 ms: the same sequence, then the update message", async () => {
    fixture({ incompatible: true });
    render(<App />);
    await advance(LAUNCH_BUILD_MS - 1);
    expect(phase()).toBe("building");
    await advance(1);
    expect(phase()).toBe("leaving");
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    expect(screen.getByRole("heading", { name: "Нужно обновить Wortly" })).toBeTruthy();
  });

  it("a refused access is decided: the access screen after the exit", async () => {
    fixture({ access: "rejected" });
    render(<App />);
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    expect(screen.getByRole("heading", { name: "Доступ пока не предоставлен" })).toBeTruthy();
  });

  it("Q-L1 (open): the launch screen leaves on the opened entry, Today then shows its own loading status while /today is held", async () => {
    let release = () => {};
    fixture({ todayGate: new Promise<void>(resolve => { release = resolve; }) });
    render(<App />);
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    expect(document.body.textContent).toContain("Загружаем план на сегодня");
    release();
    await advance(50);
    expect(todayShown()).toBe(true);
  });
});

describe("М20 under StrictMode and foreground", () => {
  it("StrictMode doubles no timer: building at 2399 ms, leaving at 2400, gone at 3100", async () => {
    fixture();
    render(<StrictMode><App /></StrictMode>);
    await advance(LAUNCH_BUILD_MS - 1);
    expect(phase()).toBe("building");
    await advance(1);
    expect(phase()).toBe("leaving");
    await advance(LAUNCH_EXIT_MS - 1);
    expect(phase()).toBe("leaving");
    await advance(1);
    expect(phase()).toBeNull();
  });

  it("coming back to the foreground after the exit brings no launch screen back", async () => {
    fixture();
    render(<App />);
    await advance(LAUNCH_BUILD_MS);
    await advance(LAUNCH_EXIT_MS);
    expect(phase()).toBeNull();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("pageshow")); });
    for (let i = 0; i < 5; i++) {
      await advance(100);
      expect(phase()).toBeNull();
      expect(host().hasAttribute("inert")).toBe(false);
    }
  });
});
