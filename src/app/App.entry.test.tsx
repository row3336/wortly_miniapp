// Acceptance checks by the independent QA of entry and access (A-QA-E01E03), kept as regression tests:
// entry, access and remote stop through the real App and HTTP client.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

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
      // identity/clients.py after C-REOPEN: another document replaces the bound one only with the held lock or
      // a confirmation of the current epoch.
      const replacing = server.bindDocuments && server.boundDocument !== null && server.boundDocument !== body.document_id;
      const conflicting = replacing && body.holds_document_lock !== true
        && !(body.confirm_document_replacement === true && body.expected_document_epoch === String(server.epoch));
      if (server.busy || conflicting) return json({ profile: profile(), compatibility: { compatible: true, contract_version: "1" },
        status: "SESSION_BUSY", session: { status: "busy", ...(conflicting
          ? { stop_remote_target: null, document_conflict: true, document_epoch: String(server.epoch) }
          : { stop_remote_target: server.target }) } });
      if (server.boundDocument === null || replacing) { server.boundDocument = body.document_id; server.epoch += 1; }
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
      data.settings.ui_language.value = language; data.settings.dictionary_language.value = "ru";
      return json(data);
    }
    if (path.endsWith("/today")) return json({ ...today, state_version: String(server.version) });
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  });
  vi.stubGlobal("fetch", fetcher);
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

  it("retry after a network loss before the first answer authenticates again and opens Today", async () => {
    const f = fixture("uk", { auth: "network" }); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Спробувати ще раз" }));
    f.server.auth = "ok";
    fireEvent.click(await screen.findByRole("button", { name: "Спробувати ще раз" }));
    await screen.findByRole("heading", { name: "Сьогодні", level: 1 });
    expect(f.calls("/auth/telegram")).toHaveLength(3);
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
    ["ru", "Wortly уже открыт", "Вернись в другое открытое окно или на другое устройство.",
      "Wortly не может проверить, закрыто ли другое окно. Если продолжить здесь, там изменения сохраняться не будут.",
      "Завершить там и продолжить здесь", "Отмена", "Сегодня"],
    ["uk", "Wortly вже відкрито", "Повернися до іншого відкритого вікна або пристрою.",
      "Wortly не може перевірити, чи закрите інше вікно. Якщо продовжити тут, там зміни не зберігатимуться.",
      "Завершити там і продовжити тут", "Скасувати", "Сьогодні"],
    ["en", "Wortly is already open", "Return to the other open window or device.",
      "Wortly cannot check whether the other window is closed. If you continue here, changes there will not be saved.",
      "End there and continue here", "Cancel", "Today"],
  ] as const)("Н1/Н3 after M-REOPEN (%s): a relaunch without the lock asks; cancel keeps the server, coming back asks again, the confirmation enters", async (language, title, busy, question, confirm, cancel, today) => {
    const f = fixture(language, { bindDocuments: true });
    const first = render(<App />); await waitFor(() => expect(f.server.boundDocument).not.toBeNull());
    first.unmount();
    render(<App />);
    await screen.findByRole("heading", { name: title });
    expect(screen.getByText(question)).toBeTruthy();
    const bound = f.server.boundDocument;
    fireEvent.click(screen.getByRole("button", { name: cancel }));
    await screen.findByText(busy);
    expect(screen.queryByRole("button")).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.calls("/client/open")).toHaveLength(2);
    expect(f.server).toMatchObject({ boundDocument: bound, epoch: 1 });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.click(await screen.findByRole("button", { name: confirm }));
    await screen.findByRole("heading", { name: today, level: 1 });
    const opens = f.calls("/client/open").map(call => JSON.parse(String(call[1]?.body)));
    expect(opens).toHaveLength(4);
    expect(opens[2]).toEqual(opens[1]);
    expect(opens[3]).toEqual({ ...opens[1], confirm_document_replacement: true, expected_document_epoch: "1" });
    expect(f.server).toMatchObject({ boundDocument: opens[1].document_id, epoch: 2 });
    expect(f.calls("/client/register")).toHaveLength(1);
  });
});
