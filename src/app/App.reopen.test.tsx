// Relaunch of the same installation through the real App (M-REOPEN): the cross-window lock of the browser,
// the explicit replacement and the old window, over /client/open as core answers it after C-REOPEN.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRequest, OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { bindDocument, conflictSession, documentConflict, invalidOpen } from "./openRules.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";
const confirmName = "Завершить там и продолжить здесь";
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

function today(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-10-06", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "ready",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 3, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "completed", ready: 0, preview: 0, next_due_at: null, new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
const oral = (): OralSessionProjection => ({ session_id: id(3), status: "active", mode: "oral", pair: "ru-de", direction: "de-l1",
  local_date: "2026-10-06", bucket: "words", close_reason: null, progress: { completed: 0, total: 2, correct: 0, wrong: 0 },
  assignment: { id: id(6), card_id: id(7), status: "presented", kind: "original",
    prompt: { text: "wenn", language: "de", conjunction_hint: null }, revealed: false },
  summary: null, practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-06", time_zone: "UTC", count: 0 },
  capabilities: { reveal_target: id(6), grade_target: null, stop: true, summary_home: false } });

/** navigator.locks of one browser profile: an ifAvailable request gets null while another window holds the name. */
function installLocks() {
  const held = new Set<string>();
  const request = vi.fn(async (name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name, mode: "exclusive" } as Lock); } finally { held.delete(name); }
  });
  Object.defineProperty(window.navigator, "locks", { configurable: true, value: { request } });
  return { request, held };
}

/**
 * One device over one synthetic core: the installation's live document is replaced only with the held lock or a
 * confirmation of its epoch (identity/clients.py); every write or session read of another document is SESSION_BUSY.
 */
function device(options: { locks?: boolean; session?: boolean } = {}) {
  const server = { document: null as string | null, epoch: 0, version: 8, session: options.session ? id(3) : null };
  const locks = options.locks ? installLocks() : null;
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: String(server.version), access: { status: "admitted", version: "1", reason: null } });
  const refused: string[] = [];
  const open = (body: OpenRequest) => {
    if (invalidOpen(body)) return response({ error: { code: "VALIDATION_FAILED" } }, 422);
    if (documentConflict(server.document, server.epoch, body)) return response({ status: "SESSION_BUSY", profile: account(),
      compatibility, session: conflictSession(server.epoch) });
    if (bindDocument(server, body)) server.version += 1;
    return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
      document_id: body.document_id, document_epoch: String(server.epoch), proof_version: "1",
      session: server.session === null ? null : { id: server.session, phase: "active" } });
  };
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const address = new URL(String(url), "http://localhost"), path = address.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-07T00:00:00Z",
      profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return open(body);
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(server.version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(server.version) });
    const document = body?.document_id ?? address.searchParams.get("document_id");
    if (document !== server.document) {
      refused.push(path);
      // A command of the replaced document: the core answers with the command envelope, not a bare error
      // (study/coordinator.py: rejected fact, unavailable projection, error SESSION_BUSY).
      if (path.endsWith("/commands") && body?.command_id) return response({ command: { id: body.command_id, status: "rejected" },
        current: { session_id: server.session, status: "unavailable" }, state_version: String(server.version),
        error: { code: "SESSION_BUSY" } }, 409);
      return response({ error: { code: "SESSION_BUSY" } }, 409);
    }
    if (path.includes("/sessions/")) return response({ current: oral(), state_version: String(server.version) });
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  const opens = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/client/open"))
    .map(([, init]) => JSON.parse(String(init!.body)) as OpenRequest);
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"));
  const calls = (suffix: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(suffix));
  return { server, locks, opens, posts, calls, refused };
}
const foreground = () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
};

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => {
  cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  Reflect.deleteProperty(window.navigator, "locks");
});

describe("relaunch through the actual App (M-REOPEN)", () => {
  it("first launch, close, relaunch with the free lock: Today at once, never «already open», the next epoch", async () => {
    const d = device({ locks: true });
    const first = render(<App />); await screen.findByText(pairText);
    first.unmount();
    await waitFor(() => expect(d.locks!.held.size).toBe(0));
    render(<App />); await screen.findByText(pairText);
    expect(screen.queryByText("Wortly уже открыт")).toBeNull();
    expect(screen.queryByRole("button", { name: confirmName })).toBeNull();
    const [a, b] = d.opens();
    expect(a).toMatchObject({ holds_document_lock: true, event: "open" });
    expect(b).toEqual({ ...a, document_id: b.document_id });
    expect(b.document_id).not.toBe(a.document_id);
    expect(d.server).toMatchObject({ document: b.document_id, epoch: 2 });
    expect(d.calls("/client/register")).toHaveLength(1);
  });

  it("a relaunch with the free lock continues the active session without a question or a new start", async () => {
    const d = device({ locks: true, session: true });
    const first = render(<App />); await screen.findByText("wenn");
    first.unmount();
    await waitFor(() => expect(d.locks!.held.size).toBe(0));
    render(<App />); await screen.findByText("wenn");
    expect(screen.queryByText(pairText)).toBeNull();
    expect(screen.queryByText("Wortly уже открыт")).toBeNull();
    expect(d.posts()).toHaveLength(0);
    expect(d.server.epoch).toBe(2);
    expect(d.refused).toEqual([]);
  });

  it("the lock held by another window: «already open» without buttons; once it closes, coming back enters", async () => {
    const d = device({ locks: true });
    const a = render(<App />); await within(a.container).findByText(pairText);
    const first = d.opens()[0].document_id;
    const b = render(<App />);
    await within(b.container).findByRole("heading", { name: "Wortly уже открыт" });
    expect(within(b.container).getByText("Вернись в другое открытое окно или на другое устройство.")).toBeTruthy();
    expect(within(b.container).queryByRole("button")).toBeNull();
    expect(d.opens()).toHaveLength(1);
    // The whole entry can settle within one render; let its effects attach the foreground listener first.
    await settle();
    // Back in the foreground while the other window is still open: the lock is checked, nothing is opened.
    foreground();
    await waitFor(() => expect(d.locks!.request).toHaveBeenCalledTimes(3));
    await within(b.container).findByRole("heading", { name: "Wortly уже открыт" });
    await settle();
    expect(d.opens().filter(body => body.document_id !== first)).toHaveLength(0);
    a.unmount();
    await waitFor(() => expect(d.locks!.held.size).toBe(0));
    foreground();
    await within(b.container).findByText(pairText);
    const last = d.opens().at(-1)!;
    expect(last).toMatchObject({ holds_document_lock: true, event: "open" });
    expect(last.document_id).not.toBe(first);
    expect(d.server).toMatchObject({ document: last.document_id, epoch: 2 });
  });

  it("without the lock a newer conflict to the confirmation is asked again, never confirmed by itself", async () => {
    const d = device();
    const a = render(<App />); await within(a.container).findByText(pairText);
    a.unmount();
    render(<App />);
    const ask = await screen.findByRole("button", { name: confirmName });
    // A third window took the document after this question was shown.
    d.server.document = id(900); d.server.epoch = 2;
    fireEvent.click(ask);
    await waitFor(() => expect(d.opens()).toHaveLength(3));
    await screen.findByRole("button", { name: confirmName });
    await settle();
    expect(d.opens()).toHaveLength(3);
    expect(d.opens()[2]).toMatchObject({ confirm_document_replacement: true, expected_document_epoch: "1" });
    expect(d.server).toMatchObject({ document: id(900), epoch: 2 });
    fireEvent.click(screen.getByRole("button", { name: confirmName }));
    await screen.findByText(pairText);
    expect(d.opens()[3]).toEqual({ ...d.opens()[2], expected_document_epoch: "2" });
    expect(d.server).toMatchObject({ document: d.opens()[3].document_id, epoch: 3 });
  });

  it("the old window after the replacement: its write is refused in place, coming back it asks and confirms nothing", async () => {
    const d = device({ session: true });
    const a = render(<App />); await within(a.container).findByText("wenn");
    const old = d.opens()[0].document_id;
    const b = render(<App />);
    fireEvent.click(await within(b.container).findByRole("button", { name: confirmName }));
    await within(b.container).findByText("wenn");
    expect(d.server.epoch).toBe(2);
    const reveal = within(a.container).getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement;
    await waitFor(() => expect(reveal.disabled).toBe(false));
    const opens = d.opens().length;
    fireEvent.click(reveal);
    await waitFor(() => expect(d.refused.some(path => path.endsWith("/commands"))).toBe(true));
    await settle();
    // The refusal does not reopen or take anything over by itself.
    expect(d.opens()).toHaveLength(opens);
    expect(d.server.document).not.toBe(old);
    foreground();
    await within(a.container).findByRole("button", { name: confirmName });
    expect(within(a.container).queryByText("wenn")).toBeNull();
    await settle();
    const fromOld = d.opens().filter(body => body.document_id === old);
    expect(fromOld.at(-1)).toMatchObject({ event: "foreground" });
    expect(fromOld.some(body => body.confirm_document_replacement)).toBe(false);
    // The new window keeps the document; what its own study screen makes of the shared pending store is the
    // module's existing path, not entry's.
    expect(d.server).toMatchObject({ document: d.opens()[1].document_id, epoch: 2 });
    expect(within(b.container).queryByRole("button", { name: confirmName })).toBeNull();
    expect(within(b.container).queryByText("Wortly уже открыт")).toBeNull();
  });
});
