import { withJournalIntake } from "../journal/intake.test-support";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse } from "../api/generated";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown) => new Response(JSON.stringify(value));
const today: TodayResponse = { state_version: "2", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
  base: { total: 5, words: 4, phrases: 1 }, ordinary_status: "ready",
  ordinary: { words: { "l1-de": { ready: 2, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
  learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 },
  conjugation: { ready: 1, openable: 1, next_due_date: null }, next_repeat_date: null };

/** A second device: open is SESSION_BUSY with a remote-stop target; any study command would be a failure here. */
function fixture() {
  const handlers = new Set<() => void>(), log: string[] = [];
  let visible = false;
  const back = { show() { visible = true; log.push("show"); }, hide() { visible = false; log.push("hide"); },
    onClick(handler: () => void) { handlers.add(handler); log.push("on"); },
    offClick(handler: () => void) { handlers.delete(handler); log.push("off"); } };
  const profile = { profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: "2", access: { status: "admitted", version: "1", reason: null } };
  const commands: unknown[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url), body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "synthetic-token", expires_at: "2026-10-01T00:00:00Z",
      profile, compatibility: { compatible: true, contract_version: "1" } });
    if (path.endsWith("/client/register")) return json({ status: "registered", client_instance_id: body.client_instance_id,
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return json({ profile, compatibility: { compatible: true, contract_version: "1" },
      status: "SESSION_BUSY", session: { status: "busy", stop_remote_target: id(50) } });
    if (path.endsWith("/settings")) { const data = settingsResponse(); data.state_version = "2"; return json(data); }
    if (path.endsWith("/today")) return json(today);
    commands.push({ path, body });
    throw new Error("Unexpected synthetic endpoint");
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", BackButton: back } });
  return { commands, log, get visible() { return visible; }, get handlers() { return handlers.size; },
    click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}

beforeEach(() => {
  localStorage.clear(); vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "1000");
  vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "10000"); vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// R17-14: the remote-stop confirmation is a modal step; native Back closes it like «Отмена» (tz_app:86).
describe("R17 native Back on the remote-stop confirmation", () => {
  it("R17-14: Back cancels the confirmation without any command and is hidden on busy", async () => {
    const f = fixture(); render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" }));
    await screen.findByRole("heading", { name: "Завершить занятие?" });
    expect(f.visible).toBe(true); expect(f.handlers).toBe(1);
    await f.click(); await f.click();
    await screen.findByRole("button", { name: "Завершить занятие на другом устройстве" });
    expect(screen.queryByRole("heading", { name: "Завершить занятие?" })).toBeNull();
    expect(f.visible).toBe(false); expect(f.handlers).toBe(0); expect(f.commands).toEqual([]);
    expect(f.log.filter(event => event === "show")).toHaveLength(1);
  });
});
