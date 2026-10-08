import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStopRemoteCommand, TodayResponse } from "../api/generated";
import { App } from "./App";
import { settingsResponse } from "../settings/settingsRead.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown) => new Response(JSON.stringify(value));
const today: TodayResponse = { state_version: "20", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
  base: { total: 5, words: 4, phrases: 1 }, ordinary_status: "ready",
  ordinary: { words: { "l1-de": { ready: 2, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
  learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null,
    new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 },
  conjugation: { ready: 1, openable: 1, next_due_date: null }, next_repeat_date: null };

function fixture() {
  const state = { busy: true, target: id(50), version: 1, lose: "none" as "none" | "before" | "after", replace: false, refuseWithNew: false,
    dictionary: "ru" as "ru" | "en" };
  const readToday = vi.fn(async () => json({ ...today, state_version: String(state.version), pair: `${state.dictionary}-de` }));
  const commands: SessionStopRemoteCommand[] = [];
  const facts = new Map<string, SessionStopRemoteCommand>();
  const profile = () => ({ profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: state.dictionary,
    time_zone: "UTC", state_version: String(state.version), access: { status: "admitted", version: "1", reason: null } });
  const reply = (command: SessionStopRemoteCommand, status: "applied" | "already_applied") => ({
    command: { id: command.command_id, kind: command.kind, status, target_id: command.session_id,
      applied_at: "2026-09-30T12:00:00Z", action_id: null, result_id: null, context_id: null, object_version: null },
    current: { session_id: command.session_id, status: "closed", close_reason: "remote_stop" }, state_version: String(state.version),
  });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "synthetic-token", expires_at: "2026-10-01T00:00:00Z",
      profile: profile(), compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) return json({ status: "registered", client_instance_id: body.client_instance_id,
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) {
      state.version += 1;
      return json({ profile: profile(), compatibility: { compatible: true, contract_version: "1" },
        ...(state.busy ? { status: "SESSION_BUSY", session: { status: "busy", stop_remote_target: state.target } }
          : { status: "opened", client_instance_id: body.client_instance_id, document_id: body.document_id,
            document_epoch: "1", proof_version: "1", session: null }) });
    }
    if (path.endsWith("/commands")) {
      expect(body.kind).toBe("session.stop_remote"); expect(body.payload).toEqual({ confirmed: true });
      expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" });
      commands.push(body);
      if (state.lose === "before") { state.lose = "none"; throw new TypeError("synthetic loss before commit"); }
      if (state.refuseWithNew) {
        // The core refuses a stop of a session that is already closed, while another one occupies the account.
        state.refuseWithNew = false; state.target = id(51); state.version += 1;
        return new Response(JSON.stringify({ command: { id: body.command_id, status: "rejected" },
          error: { code: "SESSION_CLOSED" }, state_version: String(state.version),
          current: { session_id: body.session_id, status: "closed", close_reason: "stop" } }), { status: 409 });
      }
      facts.set(body.command_id, body); state.version += 1;
      state.busy = state.replace;
      if (state.replace) state.target = id(51);
      if (state.lose === "after") { state.lose = "none"; throw new TypeError("synthetic lost reply"); }
      return json(reply(body, "applied"));
    }
    if (path.includes("/commands/")) {
      expect(init?.method).toBe("GET"); expect(init?.headers).toMatchObject({ "X-Origin-Proof": "synthetic-proof" });
      const parsed = new URL(path, "http://localhost");
      const commandId = parsed.pathname.split("/").at(-1)!;
      const fact = facts.get(commandId);
      return json(fact ? reply(fact, "already_applied")
        : { command: { id: commandId, status: "not_found" }, current: profile(), state_version: String(state.version) });
    }
    if (path.endsWith("/settings")) {
      const data = settingsResponse(); data.state_version = String(state.version);
      for (const field of Object.values(data.settings)) field.version = "1";
      data.settings.dictionary_language.value = state.dictionary;
      return json(data);
    }
    if (path.endsWith("/today")) {
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer synthetic-token" });
      expect(new Headers(init?.headers).has("X-Origin-Proof")).toBe(false);
      return readToday();
    }
    throw new Error("Unexpected synthetic endpoint");
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init", initDataUnsafe: { user: { language_code: "ru" } }, colorScheme: "light" } });
  return { state, commands, facts, fetcher, readToday };
}
async function confirm() {
  fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" }));
  fireEvent.click(screen.getByRole("button", { name: "Завершить занятие" }));
}
beforeEach(() => {
  localStorage.clear(); vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "1000");
  vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "10000"); vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("remote stop through the actual App and HTTP client", () => {
  it("shows aggregates in one main landmark and disables all learning on the second device", async () => {
    const f = fixture(); render(<App />);
    await screen.findByText("В базе");
    expect(screen.getByRole("heading", { name: "В базе" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Занятие на другом устройстве", level: 2 })).toBeTruthy();
    expect(screen.getAllByRole("main")).toHaveLength(1);
    for (const name of [/Новая группа слов/, /Слова: перевод на немецкий/, /Тест спряжений/, /Открыть спряжения/]) {
      const button = screen.getByRole("button", { name });
      expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button);
    }
    expect(f.commands).toEqual([]); expect(f.readToday).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toMatch(/synthetic|00000000/);
    expect(f.fetcher.mock.calls.some(call => /\/sessions/.test(String(call[0])))).toBe(false);
  });

  it("foreground refreshes the profile and pair before reloading the aggregate plan", async () => {
    const f = fixture(); render(<App />); await screen.findByRole("heading", { name: "В базе" });
    const count = f.fetcher.mock.calls.length; f.state.dictionary = "en";
    fireEvent(window, new Event("pageshow"));
    await screen.findByText("Активная пара: Английский ↔ Немецкий");
    expect(f.fetcher.mock.calls.slice(count).map(call => String(call[0])))
      .toEqual(["/api/v1/client/open", "/api/v1/today"]);
    expect(f.commands).toEqual([]);
  });

  it("explicit refresh sees an owner stop and opens Today without starting a quiz", async () => {
    const f = fixture(); render(<App />); await screen.findByRole("heading", { name: "В базе" });
    f.state.busy = false;
    fireEvent.click(screen.getByRole("button", { name: "Обновить прогресс" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Занятие на другом устройстве" })).toBeNull());
    await screen.findByRole("heading", { name: "В базе" });
    expect(f.commands).toEqual([]);
    expect(f.readToday).toHaveBeenCalledTimes(2);
  });

  it("a late older open cannot roll back an observed aggregate version and retry still uses the cached login", async () => {
    const f = fixture(); f.readToday.mockResolvedValueOnce(json(today)); // Aggregate version 20, profile version 2.
    render(<App />); await screen.findByRole("heading", { name: "В базе" });
    fireEvent.click(screen.getByRole("button", { name: "Обновить прогресс" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Занятие на другом устройстве" })).toBeNull());
    expect(screen.queryByRole("heading", { name: "В базе" })).toBeNull();
    f.state.version = 20;
    fireEvent.click(screen.getByRole("button", { name: "Попробовать ещё раз" }));
    await screen.findByRole("heading", { name: "В базе" });
    expect(f.fetcher.mock.calls.filter(call => String(call[0]).endsWith("/auth/telegram"))).toHaveLength(1);
    expect(f.commands).toEqual([]);
  });

  it("a failed aggregate read keeps remote stop available and retries through a fresh open", async () => {
    const f = fixture(); f.readToday.mockRejectedValueOnce(new TypeError("synthetic loss")); render(<App />);
    await screen.findByText("Не удалось загрузить план");
    expect(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("heading", { name: "В базе" });
    expect(f.fetcher.mock.calls.filter(call => String(call[0]).endsWith("/client/open"))).toHaveLength(2);
    expect(f.commands).toEqual([]);
  });

  it("an obsolete failed read cannot dismiss confirmation or the fresh plan after cancel", async () => {
    const f = fixture(); let finish!: (reply: Response) => void;
    f.readToday.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<App />); await waitFor(() => expect(f.readToday).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await screen.findByRole("heading", { name: "В базе" });
    finish(new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED" } }), { status: 401 }));
    await waitFor(() => expect(f.readToday.mock.settledResults[0]?.type).toBe("fulfilled"));
    expect(screen.getByRole("heading", { name: "В базе" })).toBeTruthy(); expect(f.commands).toEqual([]);
  });

  it.each([401, 403])("aggregate HTTP%s removes progress and the remote action", async status => {
    const f = fixture(); f.readToday.mockResolvedValueOnce(new Response("{}", { status })); render(<App />);
    await waitFor(() => expect(f.readToday).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("button", { name: "Завершить занятие на другом устройстве" })).toBeNull());
    expect(screen.queryByRole("heading", { name: "В базе" })).toBeNull(); expect(f.commands).toEqual([]);
  });

  it("cancels without POST, confirms explicitly and opens Today without starting a quiz", async () => {
    const f = fixture(); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" }));
    fireEvent.click(screen.getByRole("button", { name: "Отмена" })); expect(f.commands).toEqual([]);
    await confirm(); await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    expect(f.commands).toHaveLength(1); expect(f.commands[0].session_id).toBe(id(50));
    expect(localStorage.getItem("wortly.pending.remote_stop")).toBeNull();
    expect(document.body.textContent).not.toMatch(/synthetic|00000000/);
  });

  it("checks a lost reply without another POST", async () => {
    const f = fixture(); f.state.lose = "after"; render(<App />);
    await confirm(); await screen.findByRole("heading", { name: "Завершение пока не подтверждено" });
    expect(localStorage.getItem("wortly.pending.remote_stop")).toContain(f.commands[0].command_id);
    fireEvent.click(screen.getByRole("button", { name: "Проверить результат" }));
    await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    expect(f.commands).toHaveLength(1);
  });

  it("restores pending after remount through GET before exposing Today", async () => {
    const f = fixture(); f.state.lose = "after";
    const first = render(<App />); await confirm();
    await screen.findByRole("heading", { name: "Завершение пока не подтверждено" });
    first.unmount(); const count = f.fetcher.mock.calls.length;
    render(<App />); await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    const paths = f.fetcher.mock.calls.slice(count).map(call => String(call[0]));
    expect(paths[1]).toContain(`/commands/${f.commands[0].command_id}?`);
    expect(paths[2]).toBe("/api/v1/client/open"); expect(f.commands).toHaveLength(1);
  });

  it("requires explicit retry after not-found and preserves the complete original command", async () => {
    const f = fixture(); f.state.lose = "before"; render(<App />);
    await confirm(); await screen.findByRole("heading", { name: "Завершение пока не подтверждено" });
    fireEvent.click(screen.getByRole("button", { name: "Проверить результат" }));
    await screen.findByRole("button", { name: "Повторить завершение" });
    expect(f.commands).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Повторить завершение" }));
    await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    expect(f.commands).toHaveLength(2); expect(f.commands[1]).toEqual(f.commands[0]);
  });

  it("asks again if another session has started before reopening", async () => {
    const f = fixture(); f.state.replace = true; render(<App />);
    await confirm(); await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" });
    expect(f.commands).toHaveLength(1);
    f.state.replace = false; await confirm();
    await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    expect(f.commands[1].session_id).toBe(id(51)); expect(f.commands[1].command_id).not.toBe(f.commands[0].command_id);
  });

  it("explains that the session changed after «already closed» and asks separately for the new one", async () => {
    const f = fixture(); f.state.refuseWithNew = true; render(<App />);
    await confirm();
    await screen.findByText("На другом устройстве теперь идёт другое занятие. Завершить это занятие?");
    expect(f.commands).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" });
    expect(screen.queryByText("На другом устройстве теперь идёт другое занятие. Завершить это занятие?")).toBeNull();
    // The plain question comes back for the same session; only the refused tap carried the explanation.
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" }));
    expect(screen.getByRole("heading", { name: "Завершить занятие?" })).toBeTruthy();
    expect(f.commands).toHaveLength(1);
  });

  it("answers the «session changed» question for the new session only after its own button", async () => {
    const f = fixture(); f.state.refuseWithNew = true; render(<App />);
    await confirm();
    await screen.findByText("На другом устройстве теперь идёт другое занятие. Завершить это занятие?");
    f.state.busy = false;
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие" }));
    await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    expect(f.commands).toHaveLength(2);
    expect(f.commands[1].session_id).toBe(id(51));
    expect(f.commands[1].command_id).not.toBe(f.commands[0].command_id);
  });
});
