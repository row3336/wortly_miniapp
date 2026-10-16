// Q27 (CON §6.1 п.5, project_pending_profile_slots.md ред.1.1 §3.1–§3.2, C458/C466/C467) in Learning: the pointer of an
// answer or a grade is kept while its content payload was deleted (Е02). The lane reads the status of the SAME command_id
// — never a resend, never a new ID or budget — through the real view, document lanes and transport over the synthetic
// Learning server, on fake time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { id, missing, primaryKey, response } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import { LearningViewController } from "./learningViewController";
import { pageSendCounter } from "../commands/laneRecovery";
import { hasPending, readPending } from "../commands/pendingSeed.test-support";
import { testGate } from "../commands/testGate.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", id(3)); owners.push(f.view);
  let route: (method: string, kind: string | null, path: string) => "drop" | "lose" | undefined = () => undefined;
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
    const kind = method === "POST" ? JSON.parse(String(init!.body)).kind as string : null;
    const decision = route(method, kind, path);
    if (decision === "drop") throw new TypeError("network");
    if (decision === "lose") { await f.handler(url, init); throw new TypeError("network"); }
    try { return await f.handler(url, init); } catch (error) {
      // The synthetic server answers a status only for a command it holds: any other ID is not found (core command_status).
      if (method !== "GET" || !path.startsWith("/api/v1/commands/")) throw error;
      return response(missing({ command_id: path.split("/").at(-1)!, session_id: id(3) } as never, String(f.view.snapshot().commands.stateVersion)));
    }
  });
  const updates: { commands: { primary: { outcome: string | null; resolved: { commandId: string; restored?: true } | null } } }[] = [];
  const own = () => {
    const view = new LearningViewController({ access: f.access, storage: f.storage, newId: f.newId,
      transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() }, sessionId: id(3),
      transitionMode: () => "normal", onUpdate: state => { updates.push(state as never); } });
    owners.push(view);
    return view;
  };
  /** Whether the lane of the new owner settled commandId as an accepted, restored outcome in some update. */
  const restored = (commandId: string) => updates.some(state => state.commands.primary.outcome === "accepted"
    && state.commands.primary.resolved?.commandId === commandId && state.commands.primary.resolved.restored === true);
  const deletePayloads = () => {
    const keys = [...f.values.keys()].filter(key => key.startsWith("wortly.payload.learning_session:"));
    for (const key of keys) f.values.delete(key);
    return keys.length;
  };
  const statusReads = (commandId: string, from: number) => f.fetcher.mock.calls.slice(from)
    .filter(call => (call[1]?.method ?? "GET") === "GET" && String(call[0]).includes(`/commands/${commandId}`));
  const postsSince = (from: number) => f.fetcher.mock.calls.slice(from).filter(call => call[1]?.method === "POST")
    .map(call => JSON.parse(String(call[1]!.body)));
  const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); };
  return { ...f, own, restored, deletePayloads, statusReads, postsSince, run, route: (next: typeof route) => { route = next; } };
}

/** An answer whose outcome stays unknown in its first window: its POST and every check by its ID fail. */
async function unknownAnswer(h: ReturnType<typeof harness>, mode: "lose" | "drop", forgot = false) {
  await h.view.refresh();
  if (!forgot) h.view.setDraft("Haus");
  h.route((method, kind, path) => kind === "answer.submit" ? mode : method === "GET" && path.includes("/commands/") ? "drop" : undefined);
  await h.view.submit(forgot ? { forgot: true } : {}); await tick();
  const sent = h.posts().find(post => post.kind === "answer.submit")!;
  expect(sent).toBeDefined();
  expect(readPending(h.values, primaryKey, id(50))).toMatchObject({ intent: { command_id: sent.command_id } });
  h.view.dispose(); h.route(() => undefined);
  return sent as { command_id: string };
}

describe("Q27 Learning: a lost answer is read by its own ID only", () => {
  it("recorded by the server: the result is restored by its ID; no new ID, budget or answer POST; the pointer goes", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "lose");
    const ids = h.newId.mock.calls.length, budget = await pageSendCounter(h.storage).load(sent.command_id);
    expect(h.deletePayloads()).toBe(1);
    const from = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await tick();
    expect(h.statusReads(sent.command_id, from).length).toBeGreaterThan(0);
    expect(next.snapshot().commands.primary).toMatchObject({ outcome: "accepted", resolved: { commandId: sent.command_id, restored: true } });
    expect(next.snapshot()).toMatchObject({ phase: "result_correct" });
    expect(hasPending(h.values, primaryKey)).toBe(false);
    expect(h.postsSince(from).filter(post => post.kind === "answer.submit")).toEqual([]);
    expect(h.newId.mock.calls.length).toBe(ids);
    expect(await pageSendCounter(h.storage).load(sent.command_id)).toEqual(budget);
  });

  it.each([["a typed answer", false], ["«Забыл»", true]])(
    "never reached the server (%s): not_found → unresolved, never resent; Stop only once the open session is read", async (_name, forgot) => {
      const h = harness();
      const sent = await unknownAnswer(h, "drop", forgot);
      const ids = h.newId.mock.calls.length, budget = await pageSendCounter(h.storage).load(sent.command_id);
      expect(h.deletePayloads()).toBe(1);
      const from = h.fetcher.mock.calls.length;
      const next = h.own(); await next.refresh(); await h.run(60_000, 5000);
      expect(next.snapshot().commands.primary).toMatchObject({ pending: true, outcome: null, problem: "lost_envelope",
        canRetry: false, pendingIntent: null, lost: { commandId: sent.command_id, sessionOpen: true } });
      expect(next.snapshot().commands.canStop).toBe(true);
      expect(h.statusReads(sent.command_id, from).length).toBeGreaterThan(0);
      expect(h.postsSince(from)).toEqual([]);
      expect(h.newId.mock.calls.length).toBe(ids);
      expect(await pageSendCounter(h.storage).load(sent.command_id)).toEqual(budget);
      await next.stop("stop"); await h.run(10_000);
      expect(h.postsSince(from).map(post => post.kind)).toEqual(["session.stop"]);
    });

  it("result.grade (C467): a lost grade is read by its ID and restored; the grade is never sent again", async () => {
    const h = harness();
    await h.view.refresh(); h.view.setDraft("Haus"); await h.view.submit(); await tick();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct" });
    h.route((method, kind, path) => kind === "result.grade" ? "lose" : method === "GET" && path.includes("/commands/") ? "drop" : undefined);
    await h.view.grade(5); await tick();
    const grade = h.posts().find(post => post.kind === "result.grade")!;
    expect(grade).toBeDefined();
    h.view.dispose(); h.route(() => undefined);
    const grades = h.posts().filter(post => post.kind === "result.grade").length;
    const budget = await pageSendCounter(h.storage).load(grade.command_id);
    expect(h.deletePayloads()).toBe(1);
    const from = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await tick();
    expect(h.statusReads(grade.command_id, from).length).toBeGreaterThan(0);
    // Settled as an accepted, restored outcome; the view then goes on as after any confirmed grade (its own new step).
    expect(h.restored(grade.command_id)).toBe(true);
    expect(h.postsSince(from).filter(post => post.kind === "result.grade" || post.command_id === grade.command_id)).toEqual([]);
    expect(h.posts().filter(post => post.kind === "result.grade")).toHaveLength(grades);
    expect(await pageSendCounter(h.storage).load(grade.command_id)).toEqual(budget);
    expect(hasPending(h.values, primaryKey)).toBe(false);
  });

  it("an accepted fact naming another result than the one its reply shows is refused: nothing is settled or sent", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "lose");
    h.deletePayloads();
    const base = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) => {
      const reply = await base(url, init);
      if ((init?.method ?? "GET") !== "GET" || !String(url).includes(`/commands/${sent.command_id}`)) return reply;
      const value = await reply.json();
      return new Response(JSON.stringify({ ...value, command: { ...value.command, result_id: id(999) } }), { status: 200 });
    });
    const from = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await tick();
    expect(next.snapshot().commands.primary).toMatchObject({ pending: true, outcome: null });
    expect(h.postsSince(from)).toEqual([]);
    expect(hasPending(h.values, primaryKey)).toBe(true);
  });

  it("Я17: a lost answer whose record carries the conflict mark is never read as this lane's fact", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "lose");
    const pointerKey = [...h.values.keys()].find(key => key.startsWith(`${primaryKey}:profile:`))!;
    const pointer = JSON.parse(h.values.get(pointerKey)!); pointer.record.mismatch = true; h.values.set(pointerKey, JSON.stringify(pointer));
    expect(h.deletePayloads()).toBe(1);
    const from = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await h.run(30_000, 5000);
    expect(h.statusReads(sent.command_id, from)).toEqual([]);
    expect(next.snapshot().commands.primary).toMatchObject({ pending: true, outcome: null, problem: "mismatch", conflict: true });
    expect(h.restored(sent.command_id)).toBe(false);
    expect(h.postsSince(from)).toEqual([]);
    expect(h.values.get(pointerKey)).toBe(JSON.stringify(pointer));
  });
});
