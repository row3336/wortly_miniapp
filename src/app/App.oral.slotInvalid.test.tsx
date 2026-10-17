import { withJournalIntake } from "../journal/intake.test-support";
// M-SLOT-INVALID, oral: a live window taps a new action Y while the shared slot holds a record nobody can read. Y is neither stored
// nor sent: it is never checked by its ID, never offered for a retry, and the unreadable record stays as it is.
import { cleanup, fireEvent, isInaccessible, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRequest, OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { openDocument, staleDocument, staleRefusal } from "./openRules.test-support";
import { lsPendingRaw, lsSeedRaw, lsRemovePointer } from "../commands/lsPending.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const SLOT = "wortly.pending.oral_session";
const BLOCKED = "Действие нельзя повторить. Проверь состояние занятия.";

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

function device() {
  const server = { document: null as string | null, epoch: 0, version: 8, session: id(3) as string | null };
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  const account = (): Profile => ({ profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: String(server.version), access: { status: "admitted", version: "1", reason: null } });
  const open = async (body: OpenRequest) => {
    const changed = openDocument(server, body);
    if (changed === "stale") return response(staleRefusal, 409);
    if (changed) server.version += 1;
    return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
      document_id: body.document_id, document_epoch: String(server.epoch), proof_version: "1",
      session: server.session === null ? null : { id: server.session, phase: "active" } });
  };
  const log: string[] = [];
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const address = new URL(String(url), "http://localhost"), path = address.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-07T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return open(body);
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(server.version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(server.version) });
    if (staleDocument(server, body?.document_id ?? address.searchParams.get("document_id"))) return response(staleRefusal, 409);
    if (path.includes("/commands/") && init?.method !== "POST") {
      log.push(`GET status ${path.split("/").pop()!.slice(-4)}`);
      return response({ command: { id: path.split("/").pop(), status: "not_found" }, current: account(), state_version: String(server.version) });
    }
    if (path.endsWith("/commands") && init?.method === "POST") {
      log.push(`POST ${body.kind} ${String(body.command_id).slice(-4)}`);
      return response({ command: { id: body.command_id, kind: body.kind, status: "applied", applied_at: "2026-10-06T10:00:00Z", target_id: id(6),
        action_id: null, result_id: null, context_id: null, object_version: null },
        // A valid revealed step (its translations, the grade as its right): since M1d (Q19) an unreadable reply of the reveal
        // is a lost one, which its machine checks by the ID at once; this reply is the accepted one.
        current: { ...oral(), assignment: { ...oral().assignment!, revealed: true, translations: ["если"] },
          capabilities: { ...oral().capabilities, reveal_target: null, grade_target: id(6) } }, state_version: String(++server.version) });
    }
    if (path.includes("/sessions/")) { log.push("GET session"); return response({ current: oral(), state_version: String(server.version) }); }
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() }, close: vi.fn() } });
  return { log };
}
function seen(container: HTMLElement): { lines: string[]; buttons: string[] } {
  const lines = [...container.querySelectorAll("p, h1, h2")].filter(e => !isInaccessible(e as HTMLElement) && e.textContent).map(e => e.textContent!.trim());
  const buttons = [...container.querySelectorAll("button")].filter(e => !isInaccessible(e as HTMLElement))
    .map(e => `${e.textContent}${(e as HTMLButtonElement).disabled ? " (off)" : ""}`);
  return { lines, buttons };
}
const button = (container: HTMLElement, name: string) => within(container).queryAllByRole("button").find(e => e.textContent === name && !isInaccessible(e)) as HTMLButtonElement | undefined;

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function openedWindow() {
  const d = device();
  const view = render(<App />); await within(view.container).findByText("wenn");
  const reveal = button(view.container, "Раскрыть")!;
  await waitFor(() => { if (reveal.disabled) throw new Error("wait"); });
  return { d, view };
}

describe("oral: an unreadable record in the slot meets a new action", () => {
  it.each([["not JSON", "{not json"], ["JSON of another shape", "{\"a\":1}"]])("%s: only the block is named; Y is not checked, not offered for a retry, not sent", async (_name, raw) => {
    const { d, view } = await openedWindow();
    lsSeedRaw(SLOT, raw, id(50));
    d.log.length = 0;
    fireEvent.click(button(view.container, "Раскрыть")!); await settle(); await settle(1500);
    const screen = seen(view.container);
    expect(screen.lines).toContain(BLOCKED);
    for (const text of ["Действие ещё не подтверждено. Проверь состояние.", "Учебное действие ещё не подтверждено.",
      "Не удалось обновить занятие. Проверь состояние."]) expect(screen.lines).not.toContain(text);
    expect(button(view.container, "Повторить действие")).toBeUndefined();
    expect(d.log).toEqual([]);
    fireEvent.click(button(view.container, "Проверить состояние")!); await settle(); await settle();
    // The check may read the session; it never asks for the dropped action and never sends.
    expect(d.log.filter(entry => entry.startsWith("GET status") || entry.startsWith("POST"))).toEqual([]);
    expect(button(view.container, "Повторить действие")).toBeUndefined();
    expect(lsPendingRaw(SLOT)).toBe(raw);
  });

  it("after the check the same tap is refused again, still without a request about a command", async () => {
    const { d, view } = await openedWindow();
    lsSeedRaw(SLOT, "{not json", id(50));
    fireEvent.click(button(view.container, "Раскрыть")!); await settle();
    fireEvent.click(button(view.container, "Проверить состояние")!); await settle(); await settle();
    d.log.length = 0;
    fireEvent.click(button(view.container, "Раскрыть")!); await settle(); await settle(1000);
    expect(d.log.filter(entry => entry.startsWith("GET status") || entry.startsWith("POST"))).toEqual([]);
    expect(seen(view.container).lines).toContain(BLOCKED);
    expect(lsPendingRaw(SLOT)).toBe("{not json");
  });

  it("once the record is gone the action goes out exactly once", async () => {
    const { d, view } = await openedWindow();
    lsSeedRaw(SLOT, "{not json", id(50));
    fireEvent.click(button(view.container, "Раскрыть")!); await settle();
    lsRemovePointer(SLOT, id(50));
    fireEvent.click(button(view.container, "Проверить состояние")!); await settle(); await settle();
    d.log.length = 0;
    fireEvent.click(button(view.container, "Раскрыть")!); await settle(); await settle(300);
    expect(d.log.filter(entry => entry.startsWith("POST"))).toHaveLength(1);
    expect(d.log.filter(entry => entry.startsWith("GET status"))).toEqual([]);
  });
});
