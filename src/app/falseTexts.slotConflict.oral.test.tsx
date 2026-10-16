import { withJournalIntake } from "../journal/intake.test-support";
// D-FALSE-TEXTS part B, oral: a live window B taps a new action while the unconfirmed record X of the old window A sits in the
// shared slot. The new action Y is neither stored nor sent, never checked or retried. Decision 24.1 А (owner, C167): at that
// block B checks X on the server at once; 23.1 А: X is never sent from B; an unknown outcome lets nothing continue.
// Texts 2.2 are not chosen: no assertion names a status line.
import { cleanup, fireEvent, isInaccessible, render, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenRequest, OralSessionProjection, Profile, TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { openDocument, staleCommand, staleDocument, staleRefusal } from "./openRules.test-support";
import { lsPendingRaw } from "../commands/lsPending.test-support";

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
const oral = (revealed = false): OralSessionProjection => ({ session_id: id(3), status: "active", mode: "oral", pair: "ru-de", direction: "de-l1",
  local_date: "2026-10-06", bucket: "words", close_reason: null, progress: { completed: 0, total: 2, correct: 0, wrong: 0 },
  assignment: { id: id(6), card_id: id(7), status: "presented", kind: "original",
    prompt: { text: "wenn", language: "de", conjunction_hint: null }, ...(revealed ? { revealed: true, translations: ["если"] } : { revealed: false }) },
  summary: null, practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-06", time_zone: "UTC", count: 0 },
  capabilities: { reveal_target: revealed ? null : id(6), grade_target: revealed ? id(6) : null, stop: true, summary_home: false } });

function device(statusMode: "not_found" | "500") {
  const server = { document: null as string | null, epoch: 0, version: 8, session: id(3) as string | null, loseFrom: null as string | null, failReads: false,
    /** The command_id whose fact the core holds (A's reveal reached it although its reply was lost). */
    recorded: null as string | null };
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
    if (path.includes("/commands/") && init?.method !== "POST" && path.split("/").pop() === server.recorded) {
      log.push(`GET status ${path.split("/").pop()!.slice(-4)} -> applied`);
      return response({ command: { id: server.recorded, kind: "oral.reveal", status: "already_applied", applied_at: "2026-10-06T12:00:00Z",
        target_id: id(6), action_id: null, result_id: null, context_id: null, object_version: null },
        current: oral(true), state_version: String(server.version), verified_intent_hash: address.searchParams.get("expected_intent_hash") });
    }
    if (path.includes("/commands/") && init?.method !== "POST") {
      log.push(`GET status ${path.split("/").pop()!.slice(-4)} -> ${statusMode}`);
      if (statusMode === "500") return response({ error: { code: "UNEXPECTED" } }, 500);
      return response({ command: { id: path.split("/").pop(), status: "not_found" }, current: account(), state_version: String(server.version) });
    }
    if (path.endsWith("/commands") && init?.method === "POST") {
      return response({ command: { id: body.command_id, status: "rejected" }, current: oral(), state_version: String(server.version), error: { code: "PROBE_UNEXPECTED_POST" } }, 409);
    }
    if (path.includes("/sessions/")) {
      if (server.failReads) return response({ error: { code: "UNEXPECTED" } }, 500);
      return response({ current: oral(server.recorded !== null), state_version: String(server.version) });
    }
    return response({ error: { code: "UNEXPECTED" } }, 500);
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() }, close } });
  const opens = () => fetcher.mock.calls.filter(([u]) => String(u).endsWith("/client/open")).map(([, i]) => JSON.parse(String(i!.body)) as OpenRequest);
  return { server, close, opens, log };
}
/** What a person sees in a window: visible status lines and buttons with their state. */
function seen(container: HTMLElement): string {
  const lines = [...container.querySelectorAll("p, h1, h2")].filter(e => !isInaccessible(e as HTMLElement) && e.textContent)
    .map(e => e.textContent!.trim());
  const buttons = [...container.querySelectorAll("button")].filter(e => !isInaccessible(e as HTMLElement))
    .map(e => `[${e.textContent}${(e as HTMLButtonElement).disabled ? " (off)" : ""}]`);
  return JSON.stringify({ lines, buttons });
}
const slot = () => { const raw = lsPendingRaw(SLOT); return raw === null ? "empty" : `${JSON.parse(raw).intent.kind} id=${JSON.parse(raw).intent.command_id.slice(-4)}`; };
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

const slotId = () => slot().split("id=")[1];

describe("D-FALSE-TEXTS B, oral: a new action meets the record of another window", () => {
  const statuses = (d: ReturnType<typeof device>) => d.log.filter(entry => entry.startsWith("GET status"));

  it("24.1 А: the blocked new reveal Y ends unsent, then X alone is checked at once; nothing is sent from B, X stays on not_found", async () => {
    const { d, b } = await lostReplyOfA("not_found");
    const x = slotId(), raw = lsPendingRaw(SLOT), earlier = statuses(d).length;
    fireEvent.click(button(b.container, "Раскрыть")!); await settle(); await settle();
    // At once, with no tap on «Проверить состояние»: a status request of X, and only of X (Y is never read).
    expect(statuses(d).length).toBeGreaterThan(earlier);
    expect(statuses(d).every(entry => entry.startsWith(`GET status ${x} `))).toBe(true);
    // 23.1 А: X is never sent from B; Y is never sent at all. Every POST is A's original one.
    expect(d.log.filter(entry => entry.startsWith("POST"))).toEqual([`POST oral.reveal doc=A id=${x}`]);
    // not_found alone never clears X, and the unknown outcome lets nothing continue.
    expect(lsPendingRaw(SLOT)).toBe(raw);
    const reveal = button(b.container, "Раскрыть");
    expect(reveal === undefined || reveal.disabled).toBe(true);
    expect(button(b.container, "Повторить действие")).toBeUndefined();
    // X is not presented as an accepted reveal of Y: no revealed card, no grading.
    expect(within(b.container).queryByText("если")).toBeNull();
    expect(button(b.container, "Правильно")).toBeUndefined();
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(statuses(d).every(entry => entry.startsWith(`GET status ${x} `))).toBe(true);
    expect(d.log.filter(entry => entry.startsWith("POST"))).toEqual([`POST oral.reveal doc=A id=${x}`]);
    expect(lsPendingRaw(SLOT)).toBe(raw);
    expect(button(b.container, "Повторить действие")).toBeUndefined();
    expect(button(b.container, "Правильно")).toBeUndefined();
  });

  it("once the core holds the fact of X, B's check settles it, and a new action Z passes with a new ID and is sent exactly once", async () => {
    const { d, b } = await lostReplyOfA("not_found");
    const x = slotId();
    fireEvent.click(button(b.container, "Раскрыть")!); await settle(); await settle();
    // A's reveal reached the core although its reply was lost: the check by the same ID now finds it applied.
    d.server.recorded = JSON.parse(lsPendingRaw(SLOT)!).intent.command_id as string; d.server.version += 1;
    fireEvent.click(button(b.container, "Проверить состояние")!); await settle(); await settle();
    expect(statuses(d).every(entry => entry.startsWith(`GET status ${x} `))).toBe(true);
    expect(statuses(d).at(-1)).toBe(`GET status ${x} -> applied`);
    expect(lsPendingRaw(SLOT)).toBeNull();
    fireEvent.click(button(b.container, "Правильно")!); await settle(); await settle();
    const posts = d.log.filter(entry => entry.startsWith("POST") && !entry.includes(`id=${x}`));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("POST oral.grade doc=other");
    expect(d.log.filter(entry => entry.startsWith("POST") && entry.includes(`id=${x}`))).toEqual([`POST oral.reveal doc=A id=${x}`]);
  });
});
