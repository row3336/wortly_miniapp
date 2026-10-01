import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile, TodayResponse } from "../api/generated";
import { App } from "./App";
import { settingsResponse } from "../settings/settingsRead.test-support";

const profileId = "11111111-1111-4111-8111-111111111111";
const profile = (): Profile => ({ profile_id: profileId, access: { status: "admitted", version: "1", reason: null },
  role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: "10" });
const today = (): TodayResponse => ({ state_version: "11", pair: "uk-de", local_date: "2026-09-30", status: "work_now",
  base: { total: 5, words: 4, phrases: 1 }, ordinary_status: "ready",
  ordinary: { words: { "l1-de": { ready: 2, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
  learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null,
    new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 },
  conjugation: { ready: 1, openable: 1, next_due_date: null }, next_repeat_date: null });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function fixture(options: { profile?: Profile; session?: OpenedClient["session"]; busy?: boolean } = {}) {
  const user = options.profile ?? profile();
  const todayReply = vi.fn(async () => json(today()));
  const haptic = vi.fn();
  const openReply = vi.fn(async (body: { client_instance_id: string; document_id: string }) => json(options.busy
    ? { status: "SESSION_BUSY", profile: user, compatibility: { compatible: true, contract_version: "1" }, session: { status: "busy" } }
    : { status: "opened", profile: user, compatibility: { compatible: true, contract_version: "1" },
      client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1",
      session: options.session ?? null }));
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "synthetic-token",
      expires_at: "2026-10-01T00:00:00Z", profile: user, compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) return json({ client_instance_id: body.client_instance_id,
      status: "registered", origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return openReply(body);
    if (path.endsWith("/settings")) {
      const data = settingsResponse(); data.state_version = user.state_version;
      for (const field of Object.values(data.settings)) field.version = "1";
      data.settings.ui_language.value = user.ui_language; data.settings.dictionary_language.value = user.dictionary_language;
      return json(data);
    }
    if (path.endsWith("/today")) {
      expect(init?.headers).toEqual({ Authorization: "Bearer synthetic-token" });
      return todayReply();
    }
    throw new Error("Unexpected synthetic endpoint");
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "en" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: haptic } } });
  return { fetcher, todayReply, openReply, haptic };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "1000");
  vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "10000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("ordinary Entry to Today integration", () => {
  it("uses confirmed profile language and independent dictionary pair to load Today", async () => {
    const f = fixture(); render(<App />);
    await screen.findByRole("heading", { name: "Сегодня", level: 1 });
    await screen.findByText("Активная пара: Украинский ↔ Немецкий");
    expect(document.documentElement.lang).toBe("ru");
    expect(f.fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      "/api/v1/auth/telegram", "/api/v1/client/register", "/api/v1/client/open", "/api/v1/today", "/api/v1/settings",
    ]);
    expect(f.haptic).toHaveBeenCalledExactlyOnceWith("success");
    expect(document.body.textContent).not.toMatch(/synthetic-token|synthetic-proof|synthetic-init-data/);
    expect([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!)).join(" "))
      .not.toContain("synthetic-token");
  });

  it("does not invent a zero plan while Today is pending", async () => {
    const f = fixture(); let complete!: (response: Response) => void;
    f.todayReply.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    render(<App />);
    await screen.findByText("Загружаем план на сегодня");
    expect(screen.queryByText("На сегодня всё")).toBeNull();
    expect(screen.queryByText("В базе")).toBeNull();
    await waitFor(() => expect(f.todayReply).toHaveBeenCalledOnce());
    complete(json(today())); await screen.findByText("В базе");
  });

  it("does not invoke fake navigation or mutate when a route has no handler yet", async () => {
    const f = fixture(); render(<App />);
    await screen.findByText("В базе");
    const buttons = screen.getAllByRole("button");
    for (const button of buttons.filter(item => item.textContent !== "Настройки")) {
      expect(button.hasAttribute("disabled")).toBe(true); fireEvent.click(button);
    }
    expect(screen.getByRole("button", { name: "Настройки" }).hasAttribute("disabled")).toBe(false);
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    expect(screen.queryByText("Не удалось подтвердить запуск занятия")).toBeNull();
  });

  it.each(["pending", "rejected"] as const)("does not fetch Today before admission (%s)", async status => {
    const user = profile(); user.access.status = status;
    const f = fixture({ profile: user }); render(<App />);
    await screen.findByRole("heading", { name: status === "pending" ? "Заявка отправлена" : "Доступ пока не предоставлен" });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.todayReply).not.toHaveBeenCalled();
    expect(f.haptic).not.toHaveBeenCalled();
  });

  it("preserves busy rather than loading another screen", async () => {
    const f = fixture({ busy: true }); render(<App />);
    await screen.findByText("Wortly уже открыт");
    expect(f.todayReply).not.toHaveBeenCalled(); expect(f.haptic).not.toHaveBeenCalled();
  });

  it.each(["active", "summary"] as const)("does not discard an existing %s session into a new Today route", async phase => {
    const f = fixture({ session: { id: "22222222-2222-4222-8222-222222222222", phase } }); render(<App />);
    await screen.findByText("Вход подтверждён");
    expect(f.todayReply).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Сегодня" })).toBeNull();
  });

  it("HTTP401 closes application access and explains the actual reopening action", async () => {
    const f = fixture(); f.todayReply.mockResolvedValueOnce(json({ error: { code: "UNAUTHORIZED" } }, 401));
    render(<App />);
    await screen.findByText("Закрой приложение и снова нажми кнопку Wortly в боте.");
    expect(screen.queryByText("В базе")).toBeNull();
    expect(screen.queryByRole("button", { name: "Попробовать ещё раз" })).toBeNull();
  });

  it("HTTP403 returns to access verification without stale plan data", async () => {
    const f = fixture(); f.todayReply.mockResolvedValueOnce(json({ error: { code: "FORBIDDEN" } }, 403));
    render(<App />);
    await screen.findByText("Не удалось открыть Wortly");
    expect(screen.getByRole("button", { name: "Попробовать ещё раз" })).toBeTruthy();
    expect(screen.queryByText("В базе")).toBeNull();
  });

  it("retries a failed Today read without registering a second installation or opening again", async () => {
    const f = fixture(); f.todayReply.mockResolvedValueOnce(json({ error: { code: "WRITE_UNAVAILABLE" } }, 503));
    render(<App />);
    await screen.findByText("Не удалось загрузить план");
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByText("В базе");
    expect(f.fetcher).toHaveBeenCalledTimes(6); expect(f.todayReply).toHaveBeenCalledTimes(2);
    expect(f.haptic).toHaveBeenCalledOnce();
  });

  it("refreshes on visible/pageshow and removes handlers at unmount", async () => {
    const f = fixture(); const visible = vi.spyOn(document, "visibilityState", "get");
    const view = render(<App />); await screen.findByText("В базе");
    visible.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("pageshow"));
    expect(f.todayReply).toHaveBeenCalledOnce();
    expect(f.openReply).toHaveBeenCalledOnce();
    visible.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(f.todayReply).toHaveBeenCalledTimes(2));
    fireEvent(window, new Event("pageshow"));
    await waitFor(() => expect(f.todayReply).toHaveBeenCalledTimes(3));
    expect(f.haptic).toHaveBeenCalledOnce();
    view.unmount(); fireEvent(window, new Event("pageshow")); fireEvent(document, new Event("visibilitychange"));
    expect(f.todayReply).toHaveBeenCalledTimes(3);
    expect(f.openReply).toHaveBeenCalledTimes(3);
  });

  it("confirms the device time zone on foreground before reading the new day's plan", async () => {
    const f = fixture(); render(<App />); await screen.findByText("В базе");
    const original = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ ...original, timeZone: "Asia/Tokyo" });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const before = f.fetcher.mock.calls.length;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(f.todayReply).toHaveBeenCalledTimes(2));
    const following = f.fetcher.mock.calls.slice(before);
    expect(following.map(call => String(call[0]))).toEqual(["/api/v1/client/open", "/api/v1/today", "/api/v1/settings"]);
    expect(JSON.parse(following[0][1]?.body as string)).toMatchObject({ event: "foreground", time_zone: "Asia/Tokyo" });
    expect(f.haptic).toHaveBeenCalledOnce();
  });

  it("waits for foreground confirmation and coalesces simultaneous browser events", async () => {
    const f = fixture(); render(<App />); await screen.findByText("В базе");
    let complete!: (response: Response) => void;
    f.openReply.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange")); fireEvent(window, new Event("pageshow"));
    await waitFor(() => expect(f.openReply).toHaveBeenCalledTimes(2));
    expect(f.todayReply).toHaveBeenCalledOnce();
    expect(screen.getByText("В базе")).toBeTruthy();
    const request = f.openReply.mock.calls[1][0];
    expect(request).toEqual({ ...f.openReply.mock.calls[0][0], event: "foreground" });
    const openCalls = f.fetcher.mock.calls.filter(call => String(call[0]).endsWith("/client/open"));
    expect(openCalls[1][1]?.headers).toEqual(openCalls[0][1]?.headers);
    complete(json({ status: "opened", ...request, profile: profile(),
      compatibility: { compatible: true, contract_version: "1" }, proof_version: "1", document_epoch: "1", session: null }));
    await waitFor(() => expect(f.todayReply).toHaveBeenCalledTimes(2));
    expect(f.fetcher.mock.calls.map(call => String(call[0]))).toEqual([
      "/api/v1/auth/telegram", "/api/v1/client/register", "/api/v1/client/open", "/api/v1/today", "/api/v1/settings",
      "/api/v1/client/open", "/api/v1/today", "/api/v1/settings",
    ]);
    expect(f.haptic).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 503])("does not read Today through a refused foreground (%s)", async status => {
    const f = fixture(); render(<App />); await screen.findByText("В базе");
    f.openReply.mockResolvedValueOnce(json({ error: { code: "SYNTHETIC_REFUSAL" } }, status));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(window, new Event("pageshow"));
    await screen.findByText(status === 401 ? "Нужно снова подтвердить вход" : "Не удалось открыть Wortly");
    expect(screen.queryByText("В базе")).toBeNull();
    fireEvent(document, new Event("visibilitychange"));
    expect(f.openReply).toHaveBeenCalledTimes(2); expect(f.todayReply).toHaveBeenCalledOnce();
    expect(f.haptic).toHaveBeenCalledOnce();
  });

  it.each(["pending", "rejected"] as const)("does not expose Today through an opened reply with %s access", async status => {
    const f = fixture(); render(<App />); await screen.findByText("В базе");
    f.openReply.mockImplementationOnce(async body => json({ status: "opened", ...body,
      profile: { ...profile(), state_version: "11", access: { status, version: "2", reason: null } },
      compatibility: { compatible: true, contract_version: "1" }, proof_version: "1", document_epoch: "1", session: null }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(window, new Event("pageshow")); await screen.findByText("Не удалось открыть Wortly");
    expect(f.todayReply).toHaveBeenCalledOnce(); expect(screen.queryByText("В базе")).toBeNull();
    expect(f.haptic).toHaveBeenCalledOnce();
  });

  it("returns from an existing session to Today only after the server confirms it is closed", async () => {
    const f = fixture({ session: { id: "22222222-2222-4222-8222-222222222222", phase: "active" } });
    render(<App />); await screen.findByText("Вход подтверждён");
    f.openReply.mockImplementationOnce(async body => json({ status: "opened", ...body,
      profile: { ...profile(), state_version: "11" }, compatibility: { compatible: true, contract_version: "1" },
      proof_version: "1", document_epoch: "1", session: null }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(window, new Event("pageshow")); await screen.findByText("В базе");
    expect(f.todayReply).toHaveBeenCalledOnce(); expect(f.openReply).toHaveBeenCalledTimes(2);
    expect(f.haptic).toHaveBeenCalledOnce();
  });

  it("preserves the server's newly reported session instead of fetching Today", async () => {
    const f = fixture(); render(<App />); await screen.findByText("В базе");
    f.openReply.mockImplementationOnce(async body => json({ status: "opened", ...body,
      profile: { ...profile(), state_version: "11" }, compatibility: { compatible: true, contract_version: "1" },
      proof_version: "1", document_epoch: "1", session: { id: "22222222-2222-4222-8222-222222222222", phase: "summary" } }));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(window, new Event("pageshow")); await screen.findByText("Вход подтверждён");
    expect(f.todayReply).toHaveBeenCalledOnce();
    expect(screen.queryByText("В базе")).toBeNull(); expect(f.haptic).toHaveBeenCalledOnce();
  });

  it("a broken optional haptic API cannot prevent a confirmed entry", async () => {
    const f = fixture(); f.haptic.mockImplementation(() => { throw new Error("unsupported haptics"); });
    render(<App />); await screen.findByText("В базе");
    expect(f.todayReply).toHaveBeenCalledOnce();
  });

  it("does not replace a mismatching server pair with the profile's expected pair", async () => {
    const f = fixture(); f.todayReply.mockResolvedValueOnce(json({ ...today(), pair: "ru-de" }));
    render(<App />); await screen.findByText("Не удалось загрузить план");
    expect(screen.queryByText("В базе")).toBeNull();
  });

  it("does not invent transport limits when configuration is absent", async () => {
    const f = fixture(); vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "");
    render(<App />); await screen.findByText("Wortly could not open");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
