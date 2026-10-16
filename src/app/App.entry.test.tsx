import { withJournalIntake } from "../journal/intake.test-support";
// Acceptance checks by the independent QA of entry and access (A-QA-E01E03), kept as regression tests:
// entry, access and remote stop through the real App and HTTP client.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { activeButton } from "./gateButton.test-support";
import { keysOf, openDocument, openRequestKeys, staleRefusal } from "./openRules.test-support";
import { pageGateOpen } from "./pageGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const today: TodayResponse = { state_version: "2", pair: "ru-de", local_date: "2026-10-05", status: "work_now",
  base: { total: 5, words: 4, phrases: 1 }, ordinary_status: "ready",
  ordinary: { words: { "l1-de": { ready: 2, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
  learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 },
  conjugation: { ready: 1, openable: 1, next_due_date: null }, next_repeat_date: null };

type Access = "admitted" | "pending" | "rejected";
type Server = {
  access: Access; accessVersion: number; version: number; reason: string | null;
  busy: boolean; target: string | null; boundDocument: string | null; epoch: number; bindDocuments: boolean;
  auth: "ok" | 401 | 403 | 500 | "network"; stop: "applied" | "closed"; holdReapply: boolean;
};

function fixture(language: "ru" | "uk" | "en", initial: Partial<Server> = {}) {
  const server: Server = { access: "admitted", accessVersion: 1, version: 1, reason: null, busy: false, target: null,
    boundDocument: null, epoch: 0, bindDocuments: false, auth: "ok", stop: "applied", holdReapply: false, ...initial };
  const facts = new Set<string>();
  let releaseReapply: (() => void) | null = null;
  const profile = () => ({ profile_id: id(1), role: "user", ui_language: language, dictionary_language: "ru", time_zone: "UTC",
    state_version: String(server.version), access: { status: server.access, version: String(server.accessVersion),
      reason: server.access === "rejected" ? server.reason : null } });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) {
      if (server.auth === "network") throw new TypeError("synthetic network loss");
      if (server.auth !== "ok") return json({ error: { code: server.auth === 500 ? "INTERNAL_ERROR" : server.auth === 401 ? "AUTH_EXPIRED" : "FORBIDDEN" } }, server.auth);
      return json({ access_token: "synthetic-token", expires_at: "2026-10-06T00:00:00Z", profile: profile(),
        compatibility: { compatible: true, contract_version: "1" } });
    }
    if (path.endsWith("/access/reapply")) {
      if (server.holdReapply) await new Promise<void>(resolve => { releaseReapply = resolve; });
      if (!facts.has(body.command_id)) {
        if (String(server.accessVersion) !== body.expected_access_version) return json({ error: { code: "VERSION_CONFLICT" } }, 409);
        facts.add(body.command_id); server.access = "pending"; server.accessVersion += 1; server.version += 1;
      }
      return json({ command: { id: body.command_id, status: "applied", applied_at: "2026-10-05T12:00:00Z", target_id: id(1),
        object_version: String(server.accessVersion) }, current: profile() });
    }
    if (path.endsWith("/client/register")) return json({ status: "registered", client_instance_id: body.client_instance_id,
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) {
      // Documents are bound only when the test asks for it; then the core's open rules apply (C-REOPEN-2).
      const bound = { document: server.boundDocument, epoch: server.epoch };
      const changed = server.bindDocuments ? openDocument(bound, body) : server.boundDocument === null && openDocument(bound, body);
      if (changed === "stale") return json(staleRefusal, 409);
      server.boundDocument = bound.document; server.epoch = bound.epoch;
      if (server.busy) return json({ profile: profile(), compatibility: { compatible: true, contract_version: "1" },
        status: "SESSION_BUSY", session: { status: "busy", stop_remote_target: server.target } });
      return json({ profile: profile(), compatibility: { compatible: true, contract_version: "1" }, status: "opened",
        client_instance_id: body.client_instance_id, document_id: body.document_id, document_epoch: String(server.epoch),
        proof_version: "1", session: null });
    }
    if (path.endsWith("/commands")) {
      server.version += 1;
      if (server.stop === "closed") {
        server.busy = false;
        return json({ command: { id: body.command_id, status: "rejected" }, error: { code: "SESSION_CLOSED" },
          current: { session_id: body.session_id, status: "closed", close_reason: "stop" }, state_version: String(server.version) }, 409);
      }
      server.busy = false;
      return json({ command: { id: body.command_id, kind: body.kind, status: "applied", target_id: body.session_id,
        applied_at: "2026-10-05T12:00:00Z", action_id: null, result_id: null, context_id: null, object_version: null },
        current: { session_id: body.session_id, status: "closed", close_reason: "remote_stop" }, state_version: String(server.version) });
    }
    if (path.endsWith("/settings")) {
      const data = settingsResponse(); data.state_version = String(server.version);
      for (const field of Object.values(data.settings)) field.version = "1";
      // The dictionary language is already chosen (19.3-А); the first choice has its own tests (App.firstChoice).
      data.settings.dictionary_language.version = "2";
      data.settings.ui_language.value = language; data.settings.dictionary_language.value = "ru";
      return json(data);
    }
    if (path.endsWith("/today")) return json({ ...today, state_version: String(server.version) });
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init", initDataUnsafe: { user: { language_code: language } }, colorScheme: "light" } });
  const calls = (suffix: string) => fetcher.mock.calls.filter(call => String(call[0]).includes(suffix));
  return { server, fetcher, calls, release: () => releaseReapply?.() };
}

beforeEach(() => {
  localStorage.clear(); vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "1000");
  vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "10000"); vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("QA access screens (Т38, К02-030…046)", () => {
  it("shows the owner's reason as text and the reapply button (kills M6, M8, M9b)", async () => {
    fixture("ru", { access: "rejected", reason: "<b>Не сейчас</b>" }); render(<App />);
    await screen.findByRole("heading", { name: "Доступ пока не предоставлен" });
    expect(screen.getByText("<b>Не сейчас</b>")).toBeTruthy();
    expect(document.querySelector(".entry-card b")).toBeNull();
    expect(screen.getByRole("button", { name: "Подать заявку ещё раз" })).toBeTruthy();
  });

  it("a plain refusal shows the ordinary message and still offers reapply (kills M9)", async () => {
    fixture("ru", { access: "rejected", reason: null }); render(<App />);
    await screen.findByText("Ты можешь подать заявку ещё раз.");
    expect(document.querySelector(".access-reason")).toBeNull();
    expect(screen.getByRole("button", { name: "Подать заявку ещё раз" })).toBeTruthy();
  });

  it("a double tap on reapply sends one command and shows «Заявка отправлена» only after commit", async () => {
    const f = fixture("ru", { access: "rejected", reason: "Причина", holdReapply: true }); render(<App />);
    const button = await screen.findByRole("button", { name: "Подать заявку ещё раз" });
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(f.calls("/access/reapply")).toHaveLength(1));
    expect(screen.queryByText("Заявка отправлена")).toBeNull();
    expect(screen.queryByRole("button", { name: "Подать заявку ещё раз" })).toBeNull();
    f.server.holdReapply = false; f.release();
    await screen.findByRole("heading", { name: "Заявка отправлена" });
    expect(f.calls("/access/reapply")).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a failed reapply save never shows «Заявка отправлена» (К02-036)", async () => {
    const f = fixture("ru", { access: "rejected", reason: null });
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).endsWith("/access/reapply")
      ? json({ error: { code: "WRITE_UNAVAILABLE" } }, 503) : original(url, init));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Подать заявку ещё раз" }));
    await screen.findByRole("button", { name: "Подать заявку ещё раз" });
    expect(screen.queryByText("Заявка отправлена")).toBeNull();
    expect(document.body.textContent).not.toMatch(/WRITE_UNAVAILABLE|503/);
  });

  it("approval while the pending screen is hidden: foreground does not poll; the next launch opens Today without reapply", async () => {
    const f = fixture("ru", { access: "pending" }); const first = render(<App />);
    await screen.findByRole("heading", { name: "Заявка отправлена" });
    const before = f.fetcher.mock.calls.length;
    f.server.access = "admitted"; f.server.accessVersion += 1; f.server.version += 1;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange")); fireEvent(window, new Event("pageshow"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.fetcher.mock.calls.length).toBe(before);
    expect(screen.getByRole("heading", { name: "Заявка отправлена" })).toBeTruthy();
    first.unmount();
    render(<App />); await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    expect(f.calls("/access/reapply")).toHaveLength(0);
  });
});

describe("QA screens before a successful server answer (п.4, RA:344)", () => {
  const texts = {
    ru: { title: "Не удалось открыть Wortly", retry: "Попробовать ещё раз" },
    uk: { title: "Не вдалося відкрити Wortly", retry: "Спробувати ще раз" },
    en: { title: "Wortly could not open", retry: "Try again" },
  } as const;
  it.each((["ru", "uk", "en"] as const).flatMap(language => ([403, 500, "network"] as const).map(auth => ({ language, auth }))))(
    "auth $auth in $language: local text and retry, no technical key", async ({ language, auth }) => {
      fixture(language, { auth }); render(<App />);
      await screen.findByRole("heading", { name: texts[language].title });
      expect(screen.getByRole("button", { name: texts[language].retry })).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/FORBIDDEN|INTERNAL_ERROR|403|500|TypeError|network/);
      expect(document.documentElement.lang).toBe(language);
    });

  // P03 M-P03-10 (§4.13 В, AC-99/AC-102; P02-W К-5а (г)): a window that never opened a document, with no other
  // installation's occupancy known, keeps its «Спробувати ще раз» visible and blocked until Я19 — also after ready and
  // the end of the hold; no sign-in, registration or open leaves by it. The way out is a new launch of the Mini App.
  it("a network loss before the first answer: the retry is visible and blocked until Я19; nothing is sent by it", async () => {
    const f = fixture("uk", { auth: "network" }); render(<App />);
    const retry = await screen.findByRole("button", { name: "Спробувати ще раз" }) as HTMLButtonElement;
    f.server.auth = "ok";
    await pageGateOpen();
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(screen.queryByRole("heading", { name: "Сьогодні", level: 1 })).toBeNull();
    expect(f.calls("/auth/telegram")).toHaveLength(1);
    expect(f.calls("/client/open")).toHaveLength(0);
  });

  it("Н4: an expired Telegram login (401 on auth) asks to confirm sign-in again and offers no retry with the same data", async () => {
    const f = fixture("ru", { auth: 401 }); render(<App />);
    await screen.findByRole("heading", { name: "Нужно снова подтвердить вход" });
    expect(screen.getByText("Закрой приложение и снова нажми кнопку Wortly в боте.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).not.toMatch(/AUTH_EXPIRED|401/);
    expect(f.calls("/auth/telegram")).toHaveLength(1);
  });
});

describe("QA occupancy and remote stop through HTTP (Т03 client part)", () => {
  it("cancel by button and by Escape sends no command and stores no pending stop", async () => {
    const f = fixture("ru", { busy: true, target: id(50) }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Отмена" }), { key: "Escape" });
    await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" });
    expect(f.calls("/commands")).toHaveLength(0);
    expect(localStorage.getItem("wortly.pending.remote_stop")).toBeNull();
  });

  it("«session already closed» answer to the confirmed stop: one POST, no status check, then the actual Today", async () => {
    const f = fixture("ru", { busy: true, target: id(50), stop: "closed" }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" }));
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие" }));
    await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    expect(f.calls("/commands")).toHaveLength(1);
    expect(f.fetcher.mock.calls.filter(call => String(call[0]).includes("/commands/"))).toHaveLength(0);
    expect(localStorage.getItem("wortly.pending.remote_stop")).toBeNull();
  });

  it.each([
    ["ru", "Wortly уже открыт", "Вернись в другое открытое окно или на другое устройство.", "Сегодня"],
    ["uk", "Wortly вже відкрито", "Повернися до іншого відкритого вікна або пристрою.", "Сьогодні"],
    ["en", "Wortly is already open", "Return to the other open window or device.", "Today"],
  ] as const)("Н1/Н3 after M-REOPEN-2 (%s): a second window enters at once; the first one coming back cannot close here and shows «already open» without buttons", async (language, title, busy, today) => {
    const f = fixture(language, { bindDocuments: true });
    const first = render(<App />); await within(first.container).findByRole("heading", { name: today, level: 1 });
    const second = render(<App />); await within(second.container).findByRole("heading", { name: today, level: 1 });
    expect(within(second.container).queryByRole("heading", { name: title })).toBeNull();
    const opens = () => f.calls("/client/open").map(call => JSON.parse(String(call[1]?.body)));
    expect(f.server).toMatchObject({ boundDocument: opens()[1].document_id, epoch: 2 });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await within(first.container).findByRole("heading", { name: title });
    expect(within(first.container).getByText(busy)).toBeTruthy();
    expect(within(first.container).queryByRole("button")).toBeNull();
    // The live window stays where it was; nothing took the document back.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(within(second.container).getByRole("heading", { name: today, level: 1 })).toBeTruthy();
    expect(f.server).toMatchObject({ boundDocument: opens()[1].document_id, epoch: 2 });
    expect(opens().filter(body => body.document_id === opens()[0].document_id).map(body => body.event)).toEqual(["open", "foreground"]);
    for (const body of opens()) expect(keysOf(body)).toEqual(openRequestKeys);
    expect(f.calls("/client/register")).toHaveLength(1);
  });
});

describe("M-COMPAT-HDR: the contract version on the wire and the new refusals through the real App", () => {
  const headerOf = (call: unknown[]) => new Headers((call[1] as RequestInit | undefined)?.headers).get("X-Wortly-Contract-Version");
  const respondTo = (f: ReturnType<typeof fixture>, suffix: string, reply: () => Response) => {
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).endsWith(suffix) ? reply() : original(url, init));
  };

  it("every POST names the same contract version that sign-in and open report; reads do not", async () => {
    vi.stubEnv("VITE_WORTLY_CONTRACT_VERSION", "7");
    const f = fixture("ru", { access: "rejected", reason: null }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Подать заявку ещё раз" }));
    await screen.findByRole("heading", { name: "Заявка отправлена" });
    const auth = f.calls("/auth/telegram"), reapply = f.calls("/access/reapply");
    expect(JSON.parse(String((auth[0][1] as RequestInit).body)).contract_version).toBe("7");
    expect([...auth, ...reapply].map(headerOf)).toEqual(["7", "7"]);
    // The pending screen reads nothing; the next launch opens and reads Today.
    cleanup();
    const g = fixture("ru"); render(<App />);
    await screen.findByRole("heading", { name: /./, level: 1 });
    await waitFor(() => expect(g.calls("/today").length).toBeGreaterThan(0));
    const posts = g.fetcher.mock.calls.filter(call => (call[1] as RequestInit).method === "POST");
    const reads = g.fetcher.mock.calls.filter(call => (call[1] as RequestInit).method === "GET");
    expect(posts.map(call => String(call[0]).split("/api/v1")[1])).toEqual(expect.arrayContaining(["/auth/telegram", "/client/register", "/client/open"]));
    expect(posts.map(headerOf)).toEqual(posts.map(() => "7"));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.map(headerOf)).toEqual(reads.map(() => null));
  });

  it("an open answered with status incompatible shows the update message, not an error, and no Today", async () => {
    const f = fixture("ru");
    respondTo(f, "/client/open", () => json({ status: "incompatible", client_instance_id: id(77), profile: {
      profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "1",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: false, contract_version: "2" } }));
    // The installation id is generated by the app: answer with whatever it asked for.
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).endsWith("/client/open")) return response;
      const value = await response.json(); value.client_instance_id = JSON.parse(String(init?.body)).client_instance_id;
      return json(value);
    });
    render(<App />);
    await screen.findByRole("heading", { name: "Нужно обновить Wortly" });
    expect(document.body.textContent).not.toMatch(/Не удалось открыть|invalid_response/);
    expect(screen.queryByRole("button")).toBeNull();
    expect(f.calls("/today")).toHaveLength(0);
  });

  it("a paused reapply says so and lets the user come back; a refused-for-version reapply says to update", async () => {
    const f = fixture("ru", { access: "rejected", reason: null });
    let paused = true; const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => paused && String(url).endsWith("/access/reapply")
      ? new Response(JSON.stringify({ error: { code: "MAINTENANCE", estimated_end_at: "2026-10-07T12:00:00Z", wait_seconds: 40 } }),
        { status: 503, headers: { "Retry-After": "40" } })
      : original(url, init));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Подать заявку ещё раз" }));
    await screen.findByRole("heading", { name: "Идёт плановое обновление" });
    expect(screen.getByText(/около 40 с/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Не удалось открыть|MAINTENANCE|503/);
    // The pause is over: the same button sends the same saved command and it goes through. P03 (L2, K13): the 503 closed
    // the page gate with the announced hold, so the press comes after ready and the end of the hold.
    paused = false;
    // M-P03-10 (K13, C335): meanwhile the button is visible and inactive; it is active again once the gate lets it.
    expect((screen.getByRole("button", { name: "Подать заявку ещё раз" }) as HTMLButtonElement).disabled).toBe(true);
    await pageGateOpen();
    fireEvent.click(await activeButton("Подать заявку ещё раз"));
    await screen.findByRole("heading", { name: "Заявка отправлена" });
    const sent = f.calls("/access/reapply").map(call => JSON.parse(String((call[1] as RequestInit).body)).command_id);
    expect(sent).toHaveLength(2); expect(sent[1]).toBe(sent[0]);
    cleanup();

    const g = fixture("ru", { access: "rejected", reason: null });
    respondTo(g, "/access/reapply", () => json({ error: { code: "CLIENT_INCOMPATIBLE" } }, 409));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Подать заявку ещё раз" }));
    await screen.findByRole("heading", { name: "Нужно обновить Wortly" });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
