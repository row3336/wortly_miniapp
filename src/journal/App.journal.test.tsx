import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientEventBatch, Profile, TodayResponse } from "../api/generated";
import { App } from "../app/App";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { clientJournal } from "./clientJournal";

// The client journal through the real App (R3-03 step 6). It is on in every App test (their synthetic servers answer the
// intake through withJournalIntake); here the server records the batches. VITE_WORTLY_CLIENT_JOURNAL=off is only a build
// switch.
const profileId = "11111111-1111-4111-8111-111111111111";
const profile = (status: "admitted" | "pending" = "admitted"): Profile => ({ profile_id: profileId,
  access: { status, version: "1", reason: null }, role: "user", ui_language: "ru", dictionary_language: "uk", time_zone: "UTC", state_version: "10" });
const today = (): TodayResponse => ({ state_version: "11", pair: "uk-de", local_date: "2026-09-30", status: "work_now",
  base: { total: 5, words: 4, phrases: 1 }, ordinary_status: "ready",
  ordinary: { words: { "l1-de": { ready: 2, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
  learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 },
  conjugation: { ready: 1, openable: 1, next_due_date: null }, next_repeat_date: null });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function server(status: "admitted" | "pending" = "admitted") {
  const batches: Array<{ body: ClientEventBatch; headers: Record<string, string> }> = [];
  let instance = "";
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(init.body as string) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "MARKER-token", expires_at: "2026-10-01T00:00:00Z",
      profile: profile(status), compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) {
      instance = body.client_instance_id;
      return json({ client_instance_id: instance, status: "registered", origin_proof: "MARKER-proof", proof_version: "1", activated: false });
    }
    if (path.endsWith("/client/open")) return json({ status: "opened", profile: profile(), compatibility: { compatible: true, contract_version: "1" },
      client_instance_id: body.client_instance_id, document_id: body.document_id, proof_version: "1", document_epoch: "1", session: null });
    if (path.endsWith("/settings")) {
      const data = settingsResponse(); data.state_version = "10";
      for (const field of Object.values(data.settings)) field.version = "1";
      data.settings.dictionary_language.version = "2";
      data.settings.ui_language.value = "ru"; data.settings.dictionary_language.value = "uk";
      return json(data);
    }
    if (path.endsWith("/today")) return json(today());
    if (path.endsWith("/client/events")) {
      batches.push({ body, headers: init!.headers as Record<string, string> });
      return json({ accepted: body.events.length });
    }
    throw new Error("Unexpected synthetic endpoint");
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "MARKER-init-data", initDataUnsafe: { user: { language_code: "en" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  return { fetcher, batches, instance: () => instance };
}
async function hide() {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "1000");
  vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "10000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the App's client journal", () => {
  it("is on by default; only the build switch VITE_WORTLY_CLIENT_JOURNAL=off leaves it out", async () => {
    expect(import.meta.env.VITE_WORTLY_CLIENT_JOURNAL).toBeUndefined();
    vi.stubEnv("VITE_WORTLY_CLIENT_JOURNAL", "off");
    const f = server();
    render(<App />);
    await screen.findByText("В базе");
    expect(clientJournal()).toBeNull();
    await hide();
    expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith("/client/events"))).toBe(false);
  });

  it("an admitted profile's page sends its open to the intake when it goes to the background, with its own installation", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = server();
    render(<App />);
    await screen.findByText("В базе");
    expect(clientJournal()?.admitted()).toBe(profileId);
    await hide();
    await waitFor(() => expect(f.batches).toHaveLength(1));
    const [{ body, headers }] = f.batches;
    expect(body).toMatchObject({ client_instance_id: f.instance(), client_version: "0.0.0", dropped: 0 });
    expect(body.events).toContainEqual(expect.objectContaining({ ev: "c.app.open", kind: "open" }));
    expect(headers).toMatchObject({ Authorization: "Bearer MARKER-token", "X-Origin-Proof": "MARKER-proof", "X-Wortly-Contract-Version": "1" });
    expect(JSON.stringify(f.batches.map(batch => batch.body))).not.toMatch(/MARKER|init/);
  });

  it("a pending profile's page keeps no journal and sends nothing", async () => {
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const f = server("pending");
    render(<App />);
    await waitFor(() => expect(f.fetcher).toHaveBeenCalled());
    await waitFor(() => expect(clientJournal()).not.toBeNull());
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    await hide();
    expect(clientJournal()?.admitted()).toBeNull();
    expect(clientJournal()?.pending()).toEqual({ events: [], lost: 0 });
    expect(f.batches).toEqual([]);
  });
});
