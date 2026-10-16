import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, SettingsResponse, TodayResponse } from "../api/generated";
import { App } from "../app/App";
import { withJournalIntake } from "../journal/intake.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const X = id(1), Y = id(2);

type DeleteStep = (body: { command_id: string }) => Response | Promise<Response>;
function core(deletes: DeleteStep[], later: { openDelayMs?: number; openProfile?: string; openStale?: true; openDeleted?: true } = {}) {
  let opens = 0;
  const accounts = [X];
  const profileOf = (profileId: string): Profile => ({ profile_id: profileId, access: { status: "admitted", version: "1", reason: null },
    role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: "10" });
  const data: SettingsResponse = settingsResponse();
  data.state_version = "10";
  data.settings.dictionary_language = { value: "uk", version: "2" };
  data.constraints.dictionary_language = { type: "enum", values: ["uk"] };
  const deleteBodies: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(init.body as string) : null;
    const current = accounts[0];
    if (path.endsWith("/auth/telegram")) return json({ access_token: `token-${current}`, expires_at: "2026-10-16T12:00:00Z",
      profile: profileOf(current), compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) return json({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open") && ++opens > 1 && later.openDelayMs) await new Promise(r => setTimeout(r, later.openDelayMs));
    // A newer window of this installation took the document (409 DOCUMENT_STALE on the foreground): ВР-7, closedWindow.
    if (path.endsWith("/client/open") && opens > 1 && later.openStale) return json({ error: { code: "DOCUMENT_STALE" } }, 409);
    // The profile was deleted elsewhere (another device, the server command §3.9): the session answers PROFILE_DELETED.
    if (path.endsWith("/client/open") && opens > 1 && later.openDeleted) return json({ error: { code: "PROFILE_DELETED" } }, 403);
    if (path.endsWith("/client/open")) return json({ status: "opened", profile: profileOf(opens > 1 && later.openProfile ? later.openProfile : current),
      compatibility: { compatible: true, contract_version: "1" }, client_instance_id: body.client_instance_id,
      document_id: body.document_id, proof_version: "1", document_epoch: "1", session: null });
    if (path.endsWith("/today")) return json({ state_version: "10", pair: "uk-de", local_date: "2026-10-16", status: "no_material",
      base: { total: 0, words: 0, phrases: 0 }, ordinary_status: "done",
      ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
        phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
      learning: { status: "no_material", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0,
        automatic_eligible: 0 }, conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null } satisfies TodayResponse);
    if (path.endsWith("/settings/topics")) return json({ topics: [], state_version: "10" });
    if (path.endsWith("/settings")) return json(data);
    if (path.endsWith("/profile/delete")) {
      deleteBodies.push(body);
      const step = deletes.shift();
      if (!step) throw new Error("no more deletion replies");
      return step(body);
    }
    throw new Error(`Unexpected synthetic endpoint ${path}`);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  return { fetcher, deleteBodies, accounts, opens: () => opens, calls: (suffix: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(suffix)).length };
}
const applied = (status = "applied") => (body: { command_id: string }) => json({
  command: { id: body.command_id, kind: "profile.delete", status, applied_at: "2026-10-16T10:00:00Z" },
  deletion: { request_id: id(900), working_data: "deleted", archive: "pending", archive_deadline: "2026-10-23T10:00:00Z", fully_deleted: false },
  session: "revoked" });

async function openDeletion() {
  // The first App of a file pays the cold module start: network-sized waits, as App.settings does.
  fireEvent.click(await screen.findByRole("button", { name: "Настройки" }, { timeout: 5_000 }));
  fireEvent.click(await screen.findByRole("button", { name: "Удалить профиль" }, { timeout: 5_000 }));
  const confirm = screen.getByRole("button", { name: "Удалить навсегда" });
  expect(confirm.hasAttribute("disabled")).toBe(true);
  await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(false), { timeout: 7_000 });
  fireEvent.click(confirm);
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "3000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "20000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); localStorage.clear(); });

describe("the profile deletion in the actual App (P04 §8, S-A07, PD-28)", () => {
  it("applied: S-A07 without a button, the records of X gone, no automatic sign-in or open afterwards", async () => {
    const c = core([applied()]);
    render(<App />);
    await openDeletion();
    await screen.findByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.", {}, { timeout: 3_000 });
    expect(screen.queryByRole("button")).toBeNull();
    expect(c.deleteBodies).toEqual([{ command_id: expect.any(String), confirmed_profile_id: X, confirmation: "delete_profile",
      client_instance_id: expect.any(String) }]);
    expect(Object.keys(localStorage).filter(key => key.includes(X))).toEqual([]);
    const opens = c.calls("/client/open");
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    expect(c.calls("/auth/telegram")).toBe(1);
    expect(c.calls("/client/open")).toBe(opens);
  }, 15_000);

  it("PD-28: lost answer, then AUTH_EXPIRED on the repeat — «исход неизвестен», the sign-in only by the button; another profile then means deleted", async () => {
    const c = core([() => { throw new TypeError("offline"); }, () => json({ error: { code: "AUTH_EXPIRED" } }, 401)]);
    // A third profile Z of this device (another account earlier): its records are not X's and stay (TZA:291).
    const Z = id(3);
    localStorage.setItem(`wortly.installation:${Z}`, "{}");
    localStorage.setItem(`wortly.pending.settings-reset:profile:${Z}`, "{}");
    localStorage.setItem("wortly.pending.feedback", JSON.stringify({ profileId: Z }));
    render(<App />);
    await openDeletion();
    await screen.findByText("Исход удаления неизвестен", {}, { timeout: 8_000 });
    expect(c.deleteBodies).toHaveLength(2);
    expect(c.deleteBodies[1]).toEqual(c.deleteBodies[0]);
    expect(c.calls("/auth/telegram")).toBe(1);
    // The deletion did apply: the explicit sign-in names a new profile.
    c.accounts[0] = Y;
    fireEvent.click(screen.getByRole("button", { name: "Войти" }));
    await screen.findByText("Прежний профиль удалён из приложения.");
    expect(c.calls("/auth/telegram")).toBe(2);
    expect(Object.keys(localStorage).filter(key => key.includes(X))).toEqual([]);
    expect(localStorage.getItem(`wortly.installation:${Z}`)).toBe("{}");
    expect(localStorage.getItem(`wortly.pending.settings-reset:profile:${Z}`)).toBe("{}");
    expect(JSON.parse(localStorage.getItem("wortly.pending.feedback") ?? "null")).toEqual({ profileId: Z });
    fireEvent.click(screen.getByRole("button", { name: "Продолжить" }));
    await screen.findByRole("button", { name: "Настройки" });
  }, 20_000);
});

/** The page as Telegram shows it: document.visibilityState and its event, which the App and the deletion screen both read. */
function page() {
  let state: DocumentVisibilityState = "visible";
  const spy = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  const set = async (next: DocumentVisibilityState) => {
    state = next;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  };
  return { hide: () => set("hidden"), show: () => set("visible"), restore: () => spy.mockRestore() };
}
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

describe("the return from the background in the actual App: the foreground replaces the access (P2-2)", () => {
  it.each([["a fast foreground", 0], ["a foreground answered 1.5 s later", 1_500]] as const)(
    "%s: the result check, then the same command_id, then S-A07 — never dropped", async (_name, openDelayMs) => {
      const p = page();
      try {
        const c = core([() => { throw new TypeError("offline"); }, applied("already_applied")], { openDelayMs });
        render(<App />);
        await openDeletion();
        await waitFor(() => expect(c.deleteBodies).toHaveLength(1));
        await p.hide();
        await wait(3_000);
        expect(c.deleteBodies).toHaveLength(1);
        const opensBefore = c.opens();
        await p.show();
        await screen.findByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.", {}, { timeout: 6_000 });
        // The App's own foreground did run (the access was replaced), and the deletion went on with the same ID.
        expect(c.opens()).toBeGreaterThan(opensBefore);
        expect(c.deleteBodies).toHaveLength(2);
        expect(c.deleteBodies[1]).toEqual(c.deleteBodies[0]);
        expect(Object.keys(localStorage).filter(key => key.includes(X))).toEqual([]);
      } finally { p.restore(); }
    }, 25_000);

  it.each([["a fast foreground", 0], ["a foreground answered 1.5 s later", 1_500]] as const)(
    "the gate stays open (an unreadable 200 is a lost answer, RD-2): %s races the result check — still the same ID, S-A07", async (_name, openDelayMs) => {
      const p = page();
      try {
        const c = core([() => new Response("{", { status: 200 }), applied("already_applied")], { openDelayMs });
        render(<App />);
        await openDeletion();
        await waitFor(() => expect(c.deleteBodies).toHaveLength(1));
        await p.hide();
        await wait(3_000);
        expect(c.deleteBodies).toHaveLength(1);
        const opensBefore = c.opens();
        await p.show();
        await screen.findByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.", {}, { timeout: 6_000 });
        expect(c.opens()).toBeGreaterThan(opensBefore);
        expect(c.deleteBodies).toHaveLength(2);
        expect(c.deleteBodies[1]).toEqual(c.deleteBodies[0]);
      } finally { p.restore(); }
    }, 25_000);

  it("closedWindow on the actual parent (M-P03-10 ВР-7): the foreground meets DOCUMENT_STALE — the window closes, no further POST", async () => {
    const p = page();
    try {
      const c = core([() => { throw new TypeError("offline"); }, applied("already_applied")], { openStale: true });
      render(<App />);
      await openDeletion();
      await waitFor(() => expect(c.deleteBodies).toHaveLength(1));
      await p.hide();
      await wait(3_000);
      await p.show();
      await wait(4_000);
      expect(c.opens()).toBeGreaterThan(1);
      expect(c.deleteBodies).toHaveLength(1);
      expect(screen.queryByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.")).toBeNull();
      expect(c.calls("/profile/delete")).toBe(1);
      // ВР-7: the replaced window shows the «already open» line without buttons.
      expect(screen.getByText("Wortly уже открыт")).toBeDefined();
    } finally { p.restore(); }
  }, 25_000);

  it("a foreground of the open document meets 403 PROFILE_DELETED (deleted elsewhere): S-A07 without buttons, X wiped, no sign-in", async () => {
    const p = page();
    try {
      const c = core([], { openDeleted: true });
      render(<App />);
      // The ordinary document of X, nothing of the deletion screen involved.
      await screen.findByRole("button", { name: "Настройки" }, { timeout: 5_000 });
      expect(Object.keys(localStorage).some(key => key.includes(X))).toBe(true);
      await p.hide();
      await p.show();
      await screen.findByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.", {}, { timeout: 5_000 });
      expect(c.opens()).toBeGreaterThan(1);
      expect(screen.queryByRole("button")).toBeNull();
      await waitFor(() => expect(Object.keys(localStorage).filter(key => key.includes(X))).toEqual([]));
      // No sign-in follows by itself, also not on the next return of the page.
      const opens = c.opens();
      await p.hide(); await p.show();
      await act(async () => { window.dispatchEvent(new Event("pageshow")); });
      await wait(500);
      expect(c.calls("/auth/telegram")).toBe(1);
      expect(c.opens()).toBe(opens);
      expect(c.deleteBodies).toEqual([]);
    } finally { p.restore(); }
  }, 25_000);

  it("the foreground names another profile: the document is gone, the intent is not moved — no further POST", async () => {
    const p = page();
    try {
      const c = core([() => { throw new TypeError("offline"); }, applied("already_applied")], { openProfile: Y });
      render(<App />);
      await openDeletion();
      await waitFor(() => expect(c.deleteBodies).toHaveLength(1));
      await p.hide();
      await wait(3_000);
      await p.show();
      await wait(4_000);
      expect(c.deleteBodies).toHaveLength(1);
      expect(screen.queryByText("Профиль удалён из приложения. Архивные копии ещё обрабатываются — до 7 дней.")).toBeNull();
    } finally { p.restore(); }
  }, 25_000);
});
