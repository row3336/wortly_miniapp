// P3 of the delta QA M1c, now on the durable budget (CP5b stage 3): the closure C of Learning (CON §6.1 п.8, Q30 of 08.10,
// C556 В1) — six sends of the same C, X never refilled, then «Повторить завершение» sends the same C once per press
// through the manual cell of its record; a double press sends once; a C in the background sends nothing and keeps its
// budget. Through the real view, document lanes and transport over the synthetic Learning server, on fake time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageStore, storedMarks } from "../commands/budget.test-support";
import { tick } from "../commands/recoveryTime.test-support";
import { id, missing, response } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import type { LearningViewController } from "./learningViewController";

type Request = { method: string; path: string; kind: string | null };
type Route = (request: Request) => undefined | "drop" | Response;

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", id(3)); owners.push(f.view);
  const begun = performance.now(), sentAt: { kind: string; at: number }[] = [];
  let route: Route = () => undefined;
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
    const kind = method === "POST" ? JSON.parse(String(init!.body)).kind as string : null;
    if (kind) sentAt.push({ kind, at: performance.now() - begun });
    const decision = route({ method, path, kind });
    if (decision === "drop") throw new TypeError("network");
    if (decision) return decision;
    try { return await f.handler(url, init); } catch (error) {
      if (method !== "GET" || !path.startsWith("/api/v1/commands/")) throw error;
      return response(missing({ command_id: path.split("/").at(-1)!, session_id: id(3) } as never, f.view.snapshot().commands.stateVersion));
    }
  });
  const sends = (kind: string) => f.posts().filter(post => post.kind === kind);
  const times = (kind: string) => sentAt.filter(entry => entry.kind === kind).map(entry => entry.at);
  const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); };
  return { ...f, sends, times, run, since: () => performance.now() - begun, route: (next: Route) => { route = next; } };
}
/** X (an answer) loses its six sends; the session closes by the C naming X, whose sends are dropped as well. */
async function exhaustX(h: ReturnType<typeof harness>) {
  await h.view.refresh(); h.view.setDraft("Haus");
  h.route(request => request.kind === "answer.submit" || request.kind === "session.stop" ? "drop" : undefined);
  await h.view.submit(); await tick();
  for (let spent = 0; spent < 80_000 && h.sends("session.stop").length === 0; spent += 1000) await tick(1000);
}

describe("Learning: the closure C's own budget and «Повторить завершение» (Q30, C556 В1)", () => {
  it("six sends of the same C 2/5/10/20/30 s apart, X not refilled; one press — one more send of the same C", async () => {
    const h = harness(); await exhaustX(h);
    const first = h.since();
    await h.run(70_000); await h.run(3 * 60_000, 30_000);
    const stops = h.times("session.stop").map(at => Math.round((at - first) / 1000));
    expect(stops).toEqual([0, 2, 7, 17, 37, 67]);
    const c = h.sends("session.stop");
    expect(new Set(c.map(post => JSON.stringify(post))).size).toBe(1);
    expect(c[0].payload).toEqual({ reason: "save_failed", unsaved_command_id: h.sends("answer.submit")[0].command_id });
    expect(h.sends("answer.submit")).toHaveLength(6);
    expect(h.view.snapshot().commands).toMatchObject({ closureFailed: true, stop: { pending: true, canRetry: true } });
    // The six automatic sends of C are spent in its record; X keeps its own six (no refill of X by C).
    const store = await pageStore(h.storage);
    expect(await storedMarks(store, String(c[0].command_id))).toEqual({ reserved: 6, transmitted: 6 });
    expect(await storedMarks(store, String(h.sends("answer.submit")[0].command_id))).toMatchObject({ reserved: 6, transmitted: 6 });
    // A double press: the second one finds the press under way (the machine checks or sends): one send only.
    void h.view.retry("stop"); void h.view.retry("stop"); await tick();
    expect(h.sends("session.stop")).toHaveLength(7);
    expect(JSON.stringify(h.sends("session.stop").at(-1))).toBe(JSON.stringify(c[0]));
    await h.run(10 * 60_000, 30_000);
    // The lost manual send comes back to the spent state: no automatic send follows, the press is offered again.
    expect(h.sends("session.stop")).toHaveLength(7);
    expect(h.sends("answer.submit")).toHaveLength(6);
    expect(h.view.snapshot().commands).toMatchObject({ closureFailed: true });
    expect((store.peek(String(c[0].command_id).toLowerCase()) as { manual?: { state: string } }).manual).toMatchObject({ state: "retryable" });
    // The next press is let through by the server: the session ends as the person asked.
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await h.view.retry("stop"); await tick(); await h.run(5_000);
    expect(h.sends("session.stop")).toHaveLength(8);
    expect(h.view.snapshot().phase).toBe("closed");
  });

  it("a C whose window goes to the background sends nothing there; the return checks first and keeps the spent budget", async () => {
    const h = harness(); await exhaustX(h);
    await h.run(8_000);
    const before = h.sends("session.stop").length;
    expect(before).toBeGreaterThan(0);
    h.view.suspend("background");
    await h.run(5 * 60_000, 30_000);
    expect(h.sends("session.stop")).toHaveLength(before);
    h.view.resumeRecovery();
    await h.run(10 * 60_000, 30_000);
    // Never more than six automatic sends of C over the background and the return.
    expect(h.sends("session.stop").length).toBeLessThanOrEqual(6);
    const store = await pageStore(h.storage), c = h.sends("session.stop")[0];
    expect((await storedMarks(store, String(c.command_id)))?.reserved).toBe(h.sends("session.stop").length);
  });
});

describe("Learning: Q34 — no study send without the page's store (owner 12.10, var. 1)", () => {
  it("«Начать» sends nothing (session.start included) while the store does not open; the view stays as it was", async () => {
    const { sendBudgetProvider } = await import("../commands/intentBudget");
    const { SendBudgetError } = await import("../commands/sendBudget");
    sendBudgetProvider.make = () => Promise.reject(new SendBudgetError("unavailable"));
    vi.useFakeTimers();
    const f = learningViewFixture("normal", null); owners.push(f.view);
    await f.view.refresh(); await tick();
    expect(f.view.snapshot().commands).toMatchObject({ storageUnavailable: true, canBegin: false });
    await f.view.start(); await tick(); await tick(60_000);
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null });
  });
});
