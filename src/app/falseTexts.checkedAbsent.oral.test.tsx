// D-FALSE-TEXTS part A: the line «could not refresh» is hidden only when a successful check that found the command absent
// (not_found, same open step) is the ONLY current cause. A failed check, a failed session read or a lost connection keep it.
import { cleanup, fireEvent, isInaccessible, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRequest, OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { openDocument, staleCommand, staleDocument, staleRefusal } from "./openRules.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const compatibility = { compatible: true, contract_version: "1" };
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const SLOT = "wortly.pending.oral_session";

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

function device(statusMode: "not_found" | "500") {
  const server = { document: null as string | null, epoch: 0, version: 8, session: id(3) as string | null, loseFrom: null as string | null, failReads: false, readBudget: null as number | null, stop: "ok" as "ok" | "net" | "forbidden" };
  const close = vi.fn();
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
    const doc = body?.document_id ?? address.searchParams.get("document_id");
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-07T00:00:00Z",
      profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return open(body);
    if (path.endsWith("/today")) return response(today());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(server.version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(server.version) });
    if (path.endsWith("/commands") && init?.method === "POST") log.push(`POST ${body.kind} doc=${doc === server.loseFrom ? "A" : "other"} id=${body.command_id.slice(-4)}`);
    // The reply to A's POST is lost (the request may or may not have reached the core).
    if (path.endsWith("/commands") && init?.method === "POST" && server.loseFrom !== null && doc === server.loseFrom) {
      throw new TypeError("Failed to fetch");
    }
    if (staleDocument(server, doc)) {
      log.push(`STALE ${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/commands") && body?.command_id) return response(staleCommand(body.command_id, server.session, server.version), 409);
      return response(staleRefusal, 409);
    }
    if (path.includes("/commands/") && init?.method !== "POST") {
      log.push(`GET status ${path.split("/").pop()!.slice(-4)} -> ${statusMode}`);
      if (statusMode === "500") return response({ error: { code: "UNEXPECTED" } }, 500);
      return response({ command: { id: path.split("/").pop(), status: "not_found" }, current: account(), state_version: String(server.version) });
    }
    if (path.endsWith("/commands") && init?.method === "POST" && body.kind === "session.stop" && server.stop === "net") throw new TypeError("Failed to fetch");
    if (path.endsWith("/commands") && init?.method === "POST" && body.kind === "session.stop" && server.stop === "forbidden") {
      return response({ command: { id: body.command_id, status: "rejected" }, current: oral(), state_version: String(server.version), error: { code: "FORBIDDEN" } }, 403);
    }
    if (path.endsWith("/commands") && init?.method === "POST") {
      return response({ command: { id: body.command_id, status: "rejected" }, current: oral(), state_version: String(server.version), error: { code: "PROBE_UNEXPECTED_POST" } }, 409);
    }
    if (path.includes("/sessions/")) {
      if (server.failReads || server.readBudget !== null && server.readBudget-- <= 0) return response({ error: { code: "UNEXPECTED" } }, 500);
      return response({ current: oral(), state_version: String(server.version) });
    }
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() }, close } });
  const opens = () => fetcher.mock.calls.filter(([u]) => String(u).endsWith("/client/open")).map(([, i]) => JSON.parse(String(i!.body)) as OpenRequest);
  return { server, close, opens, log };
}
const foreground = () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
};
/** What a person sees in a window: visible status lines and buttons with their state. */
function seen(container: HTMLElement): string {
  const lines = [...container.querySelectorAll("p, h1, h2")].filter(e => !isInaccessible(e as HTMLElement) && e.textContent)
    .map(e => e.textContent!.trim());
  const buttons = [...container.querySelectorAll("button")].filter(e => !isInaccessible(e as HTMLElement))
    .map(e => `[${e.textContent}${(e as HTMLButtonElement).disabled ? " (off)" : ""}]`);
  return JSON.stringify({ lines, buttons });
}
const slot = () => { const raw = localStorage.getItem(SLOT); return raw === null ? "empty" : `${JSON.parse(raw).intent.kind} id=${JSON.parse(raw).intent.command_id.slice(-4)}`; };
const button = (container: HTMLElement, name: string) => within(container).queryAllByRole("button").find(e => e.textContent === name && !isInaccessible(e)) as HTMLButtonElement | undefined;

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function lostReplyOfA(statusMode: "not_found" | "500") {
  const d = device(statusMode);
  const a = render(<App />); await within(a.container).findByText("wenn");
  const docA = d.opens()[0].document_id;
  const b = render(<App />); await within(b.container).findByText("wenn");
  d.server.loseFrom = docA;
  const reveal = within(a.container).getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement;
  await waitFor(() => { if (reveal.disabled) throw new Error("wait"); });
  fireEvent.click(reveal);
  await settle(); await settle();
  console.log(`[${statusMode}] after A lost reply: slot=${slot()} A=${seen(a.container)}`);
  console.log(`[${statusMode}] B before anything: ${seen(b.container)}`);
  return { d, a, b };
}

const STALE = "Не удалось обновить занятие. Проверь состояние.";
const UNKNOWN = "Действие ещё не подтверждено. Проверь состояние.";
const lines = (container: HTMLElement) => (JSON.parse(seen(container)) as { lines: string[] }).lines;
const slotId = () => slot().split("id=")[1];

describe("D-FALSE-TEXTS A, oral: the source of the current cause is vouched for", () => {
  it("a successful check that found X absent on the same step is the only cause: no refresh failure, X is the one checked", async () => {
    const { d, b } = await lostReplyOfA("not_found");
    const x = slotId();
    foreground(); await settle(); await settle(); await settle();
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(lines(b.container)).toContain(UNKNOWN);
    expect(lines(b.container)).not.toContain(STALE);
    const statuses = d.log.filter(entry => entry.startsWith("GET status"));
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every(entry => entry.startsWith(`GET status ${x} `))).toBe(true);
    expect(d.log.filter(entry => entry.startsWith("POST"))).toEqual([`POST oral.reveal doc=A id=${x}`]);
  });

  it("the check found X absent, but the session read failed afterwards: the refresh failure stays", async () => {
    const { d, b } = await lostReplyOfA("not_found");
    foreground(); await settle(); await settle(); await settle();
    d.server.failReads = true;
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(lines(b.container)).toContain(STALE);
  });

  it("the lane check read the session fine and found X absent, but the owner's own follow-up read failed: the refresh failure stays", async () => {
    const { d, b } = await lostReplyOfA("not_found");
    foreground(); await settle(); await settle(); await settle();
    // Session reads of the next check: the lane's verification (1) passes, the owner's read of the current step (2) fails.
    d.server.readBudget = 1;
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(d.log.filter(entry => entry.startsWith("GET status")).length).toBeGreaterThan(0);
    expect(lines(b.container)).toContain(UNKNOWN);
    expect(lines(b.container)).toContain(STALE);
  });

  // An older not_found of the study lane must not hide a NEW cause found by the other lane (C116 п. 2).
  it("O7: the study lane holds an older not_found, then Stop fails over the network: the refresh failure stays", async () => {
    const { d, b } = await lostReplyOfA("not_found");
    foreground(); await settle(); await settle(); await settle();
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(lines(b.container)).not.toContain(STALE);
    d.server.stop = "net";
    fireEvent.click(button(b.container, "Выйти")!); await settle(); await settle();
    expect(d.log.filter(entry => entry.startsWith("POST session.stop")).length).toBe(1);
    expect(lines(b.container)).toContain(UNKNOWN);
    expect(lines(b.container)).toContain(STALE);
  });

  it("O10: the study lane holds an older not_found, then Stop is refused by the server: the refresh failure stays", async () => {
    const { d, b } = await lostReplyOfA("not_found");
    foreground(); await settle(); await settle(); await settle();
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(lines(b.container)).not.toContain(STALE);
    d.server.stop = "forbidden";
    fireEvent.click(button(b.container, "Выйти")!); await settle(); await settle();
    expect(d.log.filter(entry => entry.startsWith("POST session.stop")).length).toBe(1);
    expect(lines(b.container)).toContain(STALE);
  });

  it("the check itself failed (HTTP 500): the refresh failure stays", async () => {
    const { b } = await lostReplyOfA("500");
    foreground(); await settle(); await settle(); await settle();
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(lines(b.container)).toContain(STALE);
  });
});
