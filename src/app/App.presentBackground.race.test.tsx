import { withJournalIntake } from "../journal/intake.test-support";
// C561: the race behind C190 on the actual App, Learning, made deterministic. «Далее» starts the present of B while another
// window's record X sits in the shared slot, and the window goes to the background in the same task. After the return the
// write of the present's reservation is held until the document's foreground read of the session has been answered, so the
// present reaches the lane only then, is refused over X and dropped (14.8.8.1 А) — before the view's own read after the
// return. Rule: B stays shown, no POST, no new present over X; after X is gone, one explicit check sends one present.
// The hold sits on the write of the reservation, whichever store the build has: the page count (before CP5b) or the
// durable budget (CP5b). Nothing here counts microtasks.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile, SettingsResponse, TodayResponse } from "../api/generated";
import { learningViewFixture } from "../learning/learningView.test-support";
import { id, profile, response } from "../learning/learningFixtures.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { App } from "./App";
import { lsSeedRaw, lsRemovePointer } from "../commands/lsPending.test-support";

/** The hold of one reservation write after the return; armed by the test, opened once the session read was answered. */
const hold = vi.hoisted(() => {
  const state = { armed: false, held: 0, creates: 0, open: null as (() => void) | null, gate: null as Promise<void> | null };
  return {
    state,
    arm() { state.armed = true; state.gate = new Promise<void>(resolve => { state.open = resolve; }); },
    release() { state.armed = false; state.open?.(); },
    /** Awaited by the write of a reservation: holds it only while armed. */
    async pass(): Promise<void> {
      if (!state.armed || !state.gate) return;
      state.held++;
      await state.gate;
    },
  };
});
// Before CP5b: the page count of the lanes (laneRecovery.pageSendCounter). With CP5b the module has no such export.
vi.mock("../commands/laneRecovery", async importOriginal => {
  const original = await importOriginal<Record<string, unknown>>();
  const pageSendCounter = original.pageSendCounter as ((storage: object) => { save(id: string, marks: { reserved: number }): Promise<void> }) | undefined;
  if (!pageSendCounter) return original;
  const wrapped = new WeakSet<object>();
  return { ...original, pageSendCounter: (storage: object) => {
    const counter = pageSendCounter(storage);
    if (!wrapped.has(counter)) {
      wrapped.add(counter);
      const save = counter.save.bind(counter);
      counter.save = async (commandId, marks) => { await hold.pass(); return save(commandId, marks); };
    }
    return counter;
  } };
});
// CP5b: the durable budget of the page (the memory model in tests); absent before CP5b.
const budgetModules = import.meta.glob(["../commands/intentBudget.ts", "../commands/budget.test-support.ts"]);
async function holdDurableReservations(): Promise<void> {
  const intent = budgetModules["../commands/intentBudget.ts"], support = budgetModules["../commands/budget.test-support.ts"];
  if (!intent || !support) return;
  const { sendBudgetProvider } = await intent() as typeof import("../commands/intentBudget");
  const { TestSendBudget } = await support() as typeof import("../commands/budget.test-support");
  class Held extends TestSendBudget {
    override async reserve(...args: Parameters<InstanceType<typeof TestSendBudget>["reserve"]>) { await hold.pass(); return super.reserve(...args); }
    /** Every new intent creates its record first: the count of new command IDs that tried to go out. */
    override async createAndReserve(...args: Parameters<InstanceType<typeof TestSendBudget>["createAndReserve"]>) {
      hold.state.creates++; return super.createAndReserve(...args);
    }
  }
  sendBudgetProvider.make = () => Promise.resolve(new Held());
}

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const compatibility = { compatible: true, contract_version: "1" };
const exchange = { timeout: 5000 };
const LSLOT = "wortly.pending.learning_session";
const settled = async (n = 5) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(done => setTimeout(done, 20)); }); };

function learningToday(): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null, new_group_size: 4, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}
function learning(session: string) {
  const f = learningViewFixture("normal", null); f.view.dispose(); f.owner.dispose();
  let version = 1n;
  const observe = async (reply: Response, init?: RequestInit) => {
    const value = await reply.clone().json().catch(() => null) as { state_version?: unknown } | null;
    if (typeof value?.state_version !== "string") return reply;
    if (init?.method === "POST") version++;
    if (BigInt(value.state_version) > version) version = BigInt(value.state_version);
    return response({ ...value, state_version: String(version) }, reply.status);
  };
  const account = (): Profile => profile(String(version));
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru"; stored.settings.transition_mode.value = "normal";
  /** Set by the test: the first answered session read after it opens the held reservation. */
  const afterSessionRead = { armed: false };
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-02T00:00:00Z", profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
      document_id: body.document_id, proof_version: "1", document_epoch: "1", session: { id: session, phase: "active" } });
    if (path.endsWith("/today")) return response(learningToday());
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) return response({ ...structuredClone(stored), state_version: String(version) } as SettingsResponse);
    const reply = await observe(await f.handler(url, init), init);
    // The boundary of the race: the document's foreground read of the session has been answered; the held write goes on
    // after the task that handles this answer.
    if (afterSessionRead.armed && (init?.method ?? "GET") === "GET" && path.includes("/sessions/")) {
      afterSessionRead.armed = false;
      setTimeout(() => hold.release(), 0);
    }
    return reply;
  });
  vi.stubGlobal("fetch", withJournalIntake(fetcher));
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() } } });
  const client = () => { const call = fetcher.mock.calls.find(([u]) => String(u).endsWith("/client/open")); return JSON.parse(String(call![1]!.body)).client_instance_id as string; };
  return { fetcher, f, client, afterSessionRead };
}
const posts = (s: { fetcher: { mock: { calls: [string | URL | Request, RequestInit?][] } } }) => s.fetcher.mock.calls
  .filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands")).map(([, init]) => JSON.parse(String(init!.body)).kind as string)
  .filter(kind => kind !== "setting.save");
const visibility = (state: "hidden" | "visible") => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event(state === "hidden" ? "pagehide" : "pageshow"));
};
const xRecord = (client: string) => JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: client, pair: "ru-de",
  intent: { command_id: id(777), kind: "answer.submit", session_id: id(3), assignment_id: id(6), payload: { text: "Alt" } } });

beforeEach(async () => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "200000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
  hold.state.armed = false; hold.state.held = 0;
  await holdDurableReservations();
});
afterEach(() => { hold.release(); cleanup(); localStorage.clear(); window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function wrongResult() {
  const s = learning(id(3)); s.f.wrong(); render(<App />);
  const input = await screen.findByRole("textbox", undefined, exchange) as HTMLInputElement;
  await waitFor(() => expect(input.readOnly).toBe(false));
  await settled();
  fireEvent.change(input, { target: { value: "falsch" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByRole("region", { name: "Есть ошибка" }, exchange); await settled();
  return s;
}

describe("C561: the present of B dropped over X after the return, before the view's own read", () => {
  it("B stays shown, nothing is sent or begun anew over X; once X is gone one check sends one present", async () => {
    const s = await wrongResult();
    const sent = posts(s).length;
    lsSeedRaw(LSLOT, xRecord(s.client()), id(50));
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Далее" })); visibility("hidden"); });
    await settled(10);
    expect(posts(s).slice(sent)).toEqual([]);
    // The return: the write of the present's reservation waits until the foreground read of the session was answered.
    hold.arm(); s.afterSessionRead.armed = true;
    const creates = hold.state.creates;
    await act(async () => { visibility("visible"); }); await settled(20);
    expect(hold.state.held).toBeGreaterThan(0);
    await act(async () => { await new Promise(done => setTimeout(done, 8000)); }); await settled();
    // QA stage 2 P3: no new command ID while the slot holds the block (CP5b: each new intent first creates its record;
    // before CP5b the build has no such store and this count stays 0 by construction).
    expect(hold.state.creates).toBe(creates);
    expect(posts(s).slice(sent)).toEqual([]);
    expect(screen.queryByRole("region", { name: "Есть ошибка" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    // B is shown as its present began (never the old result, never a false «stale» screen without B).
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    lsRemovePointer(LSLOT, id(50));
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await settled(10);
    expect(posts(s).slice(sent)).toEqual(["assignment.present"]);
  }, 40000);
});
