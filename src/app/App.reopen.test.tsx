// Two windows of one installation through the real App after decision 2.3 (M-REOPEN-2): the new window takes the
// document over at once; the old one closes itself on DOCUMENT_STALE or on the lost lock, over /client/open as core
// answers it after C-REOPEN-2.
import { cleanup, fireEvent, isInaccessible, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRequest, OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { keysOf, openDocument, openRequestKeys, staleCommand, staleDocument, staleRefusal } from "./openRules.test-support";
import { watchFlash } from "./flashWatch.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";
const busyTitle = "Wortly уже открыт";
const busyText = "Вернись в другое открытое окно или на другое устройство.";
const unconfirmed = "Учебное действие ещё не подтверждено.";
const oralRefusal = "Не удалось обновить занятие. Проверь состояние.";
const checkingTitle = "Обновляем Wortly";
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

/** navigator.locks of one browser profile: a steal request takes the name and ends the holder's request with AbortError. */
function installLocks() {
  const held = new Map<string, (error: Error) => void>();
  const request = vi.fn((name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      held.get(name)?.(new DOMException("The lock was stolen", "AbortError"));
      held.set(name, reject);
      void callback({ name, mode: "exclusive" } as Lock).then(() => {
        if (held.get(name) === reject) held.delete(name);
        resolve();
      });
    }));
  Object.defineProperty(window.navigator, "locks", { configurable: true, value: { request } });
  return { request, held };
}

/**
 * One device over one synthetic core: every open makes its document the live one; a foreground, a write or a session
 * read of a replaced document is DOCUMENT_STALE (identity/clients.py, study/coordinator.py after C-REOPEN-2).
 */
function device(options: { locks?: boolean; session?: boolean; close?: boolean; holdForeground?: boolean } = {}) {
  const server = { document: null as string | null, epoch: 0, version: 8, session: options.session ? id(3) : null, refuseReads: 0 };
  const locks = options.locks ? installLocks() : null;
  const close = vi.fn();
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: String(server.version), access: { status: "admitted", version: "1", reason: null } });
  const refused: string[] = [];
  // holdForeground: every foreground open waits until release(), so a test can look at the window while it checks.
  const waiting: Array<() => void> = [];
  const release = () => { waiting.splice(0).forEach(resume => resume()); };
  const open = async (body: OpenRequest) => {
    if (options.holdForeground && body.event === "foreground") await new Promise<void>(resume => waiting.push(resume));
    const changed = openDocument(server, body);
    if (changed === "stale") return response(staleRefusal, 409);
    if (changed) server.version += 1;
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
    if (staleDocument(server, body?.document_id ?? address.searchParams.get("document_id"))) {
      refused.push(path);
      if (path.endsWith("/commands") && body?.command_id) return response(staleCommand(body.command_id, server.session, server.version, body.kind), 409);
      return response(staleRefusal, 409);
    }
    // A live document's session read refused as DOCUMENT_STALE, as the core answers a closed context of the live document.
    if (path.includes("/sessions/") && init?.method !== "POST" && server.refuseReads > 0) {
      server.refuseReads -= 1; refused.push(path); return response(staleRefusal, 409);
    }
    if (path.includes("/sessions/")) return response({ current: oral(), state_version: String(server.version) });
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() }, ...(options.close === false ? {} : { close }) } });
  const opens = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/client/open"))
    .map(([, init]) => JSON.parse(String(init!.body)) as OpenRequest);
  const posts = () => fetcher.mock.calls.filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands"));
  const calls = (suffix: string) => fetcher.mock.calls.filter(([url]) => String(url).endsWith(suffix));
  /** The events of every open that named this document. */
  const eventsOf = (document: string) => opens().filter(body => body.document_id === document).map(body => body.event);
  return { server, locks, close, opens, posts, calls, refused, eventsOf, release, held: () => waiting.length };
}
/** The intents of the commands the document sent. */
const sentIntents = (d: ReturnType<typeof device>, document: string) => d.posts()
  .map(([, init]) => JSON.parse(String(init!.body))).filter(body => body.document_id === document)
  .map(({ client_instance_id: _client, document_id: _document, ...intent }) => intent);
/** The intent of the record in the shared slot, as a list for comparison with sentIntents. */
const keptIntent = (key: string) => { const raw = localStorage.getItem(key); return raw === null ? [] : [JSON.parse(raw).intent]; };
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

describe("relaunch through the actual App (M-REOPEN-2)", () => {
  it("first launch, close, relaunch: Today at once, never «already open», the next epoch, no legacy field", async () => {
    const d = device({ locks: true });
    const first = render(<App />); await screen.findByText(pairText);
    first.unmount();
    await waitFor(() => expect(d.locks!.held.size).toBe(0));
    render(<App />); await screen.findByText(pairText);
    expect(screen.queryByText(busyTitle)).toBeNull();
    const [a, b] = d.opens();
    expect(a).toMatchObject({ event: "open" });
    expect(b).toEqual({ ...a, document_id: b.document_id });
    expect(keysOf(a)).toEqual(openRequestKeys); expect(keysOf(b)).toEqual(openRequestKeys);
    expect(b.document_id).not.toBe(a.document_id);
    expect(d.server).toMatchObject({ document: b.document_id, epoch: 2 });
    expect(d.calls("/client/register")).toHaveLength(1);
    expect(d.close).not.toHaveBeenCalled();
  });

  it("a relaunch continues the active session without a question or a new start", async () => {
    const d = device({ locks: true, session: true });
    const first = render(<App />); await screen.findByText("wenn");
    first.unmount();
    await waitFor(() => expect(d.locks!.held.size).toBe(0));
    render(<App />); await screen.findByText("wenn");
    expect(screen.queryByText(pairText)).toBeNull();
    expect(screen.queryByText(busyTitle)).toBeNull();
    expect(d.posts()).toHaveLength(0);
    expect(d.server.epoch).toBe(2);
    expect(d.refused).toEqual([]);
  });
});

describe("two windows of one installation (decision 2.3)", () => {
  it("with Web Locks: B enters at once while A lives; A learns it from the stolen lock and closes without a request", async () => {
    const d = device({ locks: true });
    const a = render(<App />); await within(a.container).findByText(pairText);
    const old = d.opens()[0].document_id;
    const b = render(<App />); await within(b.container).findByText(pairText);
    expect(within(b.container).queryByText(busyTitle)).toBeNull();
    await waitFor(() => expect(d.close).toHaveBeenCalledOnce());
    // Where the close does not take effect, A shows «already open» without buttons.
    await within(a.container).findByRole("heading", { name: busyTitle });
    expect(within(a.container).queryByRole("button")).toBeNull();
    expect(d.eventsOf(old)).toEqual(["open"]);
    expect(d.server).toMatchObject({ document: d.opens()[1].document_id, epoch: 2 });
    expect(d.locks!.request.mock.calls.map(call => call[1])).toEqual([{ steal: true }, { steal: true }]);
    expect(d.locks!.held.size).toBe(1);
  });

  it("without Web Locks: B enters at once; A coming back gets DOCUMENT_STALE and closes, B keeps the document", async () => {
    const d = device();
    const a = render(<App />); await within(a.container).findByText(pairText);
    const old = d.opens()[0].document_id;
    const b = render(<App />); await within(b.container).findByText(pairText);
    await settle();
    expect(d.close).not.toHaveBeenCalled();
    foreground();
    await waitFor(() => expect(d.close).toHaveBeenCalledOnce());
    await within(a.container).findByRole("heading", { name: busyTitle });
    await within(b.container).findByText(pairText);
    expect(d.eventsOf(old)).toEqual(["open", "foreground"]);
    expect(d.server).toMatchObject({ document: d.opens()[1].document_id, epoch: 2 });
  });

  it("Ф1: A with an open oral session taps «Раскрыть» after B took over: A closes; its record stays, B sends nothing of it", async () => {
    const d = device({ session: true });
    const a = render(<App />); await within(a.container).findByText("wenn");
    const old = d.opens()[0].document_id;
    const b = render(<App />); await within(b.container).findByText("wenn");
    expect(d.server.epoch).toBe(2);
    const reveal = within(a.container).getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement;
    await waitFor(() => expect(reveal.disabled).toBe(false));
    fireEvent.click(reveal);
    await waitFor(() => expect(d.close).toHaveBeenCalledOnce());
    await within(a.container).findByRole("heading", { name: busyTitle });
    expect(within(a.container).queryByText("wenn")).toBeNull();
    expect(within(a.container).queryByText("Не удалось обновить занятие. Проверь состояние.")).toBeNull();
    expect(d.refused.filter(path => path.endsWith("/commands"))).toHaveLength(1);
    // DOCUMENT_STALE refuses this window's attempt, not the action (C091 §1, Р2): its record stays as sent.
    expect(keptIntent("wortly.pending.oral_session")).toEqual(sentIntents(d, old));
    expect(d.eventsOf(old)).toEqual(["open", "foreground"]);
    // B keeps the document. Its next reconcile meets A's kept action in the shared slot and offers only its check: what
    // B shows for it is the owner's question В-1 (D-STALE-WINDOW 5); this pins the current answer, not a decision.
    foreground();
    await settle();
    await within(b.container).findByText(unconfirmed);
    expect(within(b.container).getByRole("button", { name: "Проверить состояние" })).toBeTruthy();
    expect(within(b.container).queryByText(busyTitle)).toBeNull();
    expect(d.server).toMatchObject({ document: d.opens()[1].document_id, epoch: 2 });
    expect(d.eventsOf(old)).toEqual(["open", "foreground"]);
    // A new document_id never sends the old window's action (CT §6.1 п. 5, Codex C093 п. 5, question В-2).
    expect(d.posts()).toHaveLength(1);
    expect(keptIntent("wortly.pending.oral_session")).toEqual(sentIntents(d, old));
  });

  it("outside Telegram's close (until Q54): A shows «already open» without buttons and sends nothing more on return", async () => {
    const d = device({ close: false });
    const a = render(<App />); await within(a.container).findByText(pairText);
    const old = d.opens()[0].document_id;
    const b = render(<App />); await within(b.container).findByText(pairText);
    await settle();
    foreground();
    await within(a.container).findByRole("heading", { name: busyTitle });
    expect(within(a.container).getByText(busyText)).toBeTruthy();
    expect(within(a.container).queryByRole("button")).toBeNull();
    await settle();
    foreground();
    await settle();
    expect(d.eventsOf(old)).toEqual(["open", "foreground"]);
    expect(within(a.container).getByRole("heading", { name: busyTitle })).toBeTruthy();
    await within(b.container).findByText(pairText);
  });
});

describe("a live window's read refused as DOCUMENT_STALE", () => {
  it("one window with an oral session: a session read refused as DOCUMENT_STALE asks a foreground, and the window stays", async () => {
    const d = device({ session: true });
    d.server.refuseReads = 1;
    const a = render(<App />);
    await waitFor(() => expect(d.refused.length).toBe(1));
    await settle(); await settle();
    const own = d.opens()[0].document_id;
    expect(d.eventsOf(own)).toEqual(["open", "foreground"]);
    expect(d.close).not.toHaveBeenCalled();
    expect(within(a.container).queryByRole("heading", { name: busyTitle })).toBeNull();
    expect(d.server.document).toBe(own);
  });
});

/** Every element with the text is hidden from the user (display: none keeps the module mounted but out of sight). */
const unseen = (container: HTMLElement, text: string) =>
  within(container).queryAllByText(text).every(element => isInaccessible(element));

describe("no false error while the window checks its document (2.33, contracts §6.4)", () => {
  it("Ф1: the replaced window hides its module's refusal during the foreground check and then closes", async () => {
    const d = device({ session: true, holdForeground: true });
    const a = render(<App />); await within(a.container).findByText("wenn");
    const b = render(<App />); await within(b.container).findByText("wenn");
    const reveal = within(a.container).getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement;
    await waitFor(() => expect(reveal.disabled).toBe(false));
    // Every screen update of A is watched: not one commit may show the refusal (a check announced late would).
    const watch = watchFlash(a.container);
    fireEvent.click(reveal);
    await waitFor(() => expect(d.held()).toBe(1));
    await settle();
    // The module keeps its record (C091 §1, Р2), and the user sees no refusal while the window checks.
    expect(keptIntent("wortly.pending.oral_session")).toHaveLength(1);
    expect(within(a.container).queryAllByText(oralRefusal)).not.toHaveLength(0);
    expect(unseen(a.container, oralRefusal)).toBe(true);
    expect(unseen(a.container, "wenn")).toBe(true);
    expect(within(a.container).getByRole("heading", { name: checkingTitle })).toBeTruthy();
    expect(d.close).not.toHaveBeenCalled();
    d.release();
    await waitFor(() => expect(d.close).toHaveBeenCalledOnce());
    await within(a.container).findByRole("heading", { name: busyTitle });
    expect(within(a.container).queryAllByText(oralRefusal)).toHaveLength(0);
    watch.stop();
    expect(watch.seen).toEqual([]);
    await within(b.container).findByText("wenn");
    expect(unseen(b.container, "wenn")).toBe(false);
  });

  it("a live window's refused read: the module is hidden only while the check runs, then shown again", async () => {
    const d = device({ session: true, holdForeground: true });
    d.server.refuseReads = 1;
    const a = render(<App />);
    await waitFor(() => expect(d.held()).toBe(1));
    await settle();
    expect(within(a.container).getByRole("heading", { name: checkingTitle })).toBeTruthy();
    d.release();
    await waitFor(() => expect(within(a.container).queryByRole("heading", { name: checkingTitle })).toBeNull());
    await within(a.container).findByText("wenn");
    expect(unseen(a.container, "wenn")).toBe(false);
    expect(d.close).not.toHaveBeenCalled();
    expect(d.eventsOf(d.opens()[0].document_id)).toEqual(["open", "foreground"]);
  });

  it("a replaced window coming back from the background shows no module error before it closes", async () => {
    const d = device({ session: true, holdForeground: true });
    const a = render(<App />); await within(a.container).findByText("wenn");
    const b = render(<App />); await within(b.container).findByText("wenn");
    await settle();
    foreground(); // Both windows of the test share one document: B checks too and keeps its document.
    await waitFor(() => expect(d.held()).toBe(2));
    await settle();
    expect(unseen(a.container, oralRefusal)).toBe(true);
    d.release();
    await waitFor(() => expect(d.close).toHaveBeenCalledOnce());
    await within(a.container).findByRole("heading", { name: busyTitle });
  });

  it("a live window coming back: while its foreground runs the oral screen loads, it reports no failed refresh", async () => {
    const d = device({ session: true, holdForeground: true });
    const a = render(<App />); await within(a.container).findByText("wenn");
    await settle();
    foreground();
    await waitFor(() => expect(d.held()).toBe(1));
    await settle();
    expect(within(a.container).queryAllByText(oralRefusal)).toHaveLength(0);
    expect(within(a.container).getByText("Загружаем занятие…")).toBeTruthy();
    d.release();
    await within(a.container).findByText("wenn");
    expect(within(a.container).queryAllByText(oralRefusal)).toHaveLength(0);
    expect(d.close).not.toHaveBeenCalled();
  });
});
