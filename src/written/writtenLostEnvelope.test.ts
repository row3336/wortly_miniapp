// Q27 (CON §6.1 п.5, project_pending_profile_slots.md ред.1.1 §3.1–§3.2, C458/C466/C467) in the written quiz: the
// pointer of an answer or a grade is kept while its content payload was deleted (Е02). The lane reads the status of the
// SAME command_id — never a resend, never a new ID or budget — through the real view, document lanes and HTTP transport
// over the synthetic written server, on fake time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { tick, writtenFixture } from "./writtenFixtures.test-support";
import { writtenPrimaryKey } from "./writtenPending";
import { pageMarks } from "../commands/budget.test-support";
import { hasPending, readPending } from "../commands/pendingSeed.test-support";
import { freshTestGate } from "../commands/testGate.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  const f = writtenFixture();
  const own = () => {
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view);
    return view;
  };
  /** Е02: every content payload of the written lane is deleted; its pointer, command_id and budget stay. */
  const deletePayloads = () => {
    const keys = [...f.values.keys()].filter(key => key.startsWith("wortly.payload.written_session:"));
    for (const key of keys) f.values.delete(key);
    return keys.length;
  };
  const answers = () => f.posts().filter(post => post.kind === "answer.submit");
  /** GET of the status of commandId since the call index `from` (the reads of the new owner only). */
  const statusReads = (commandId: string, from = 0) => f.fetcher.mock.calls.slice(from)
    .filter(call => (call[1]?.method ?? "GET") === "GET" && String(call[0]).includes(`/commands/${commandId}`)).map(call => String(call[0]));
  const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); };
  return { ...f, own, deletePayloads, answers, statusReads, run };
}

/** A written answer whose outcome stays unknown in its first window: its POST and every check by its ID fail. */
async function unknownAnswer(h: ReturnType<typeof harness>, mode: "committed" | "dropped", draft: { text?: string; forgot?: true }) {
  const view = h.own(); await view.refresh(); await view.start("words");
  if (draft.text) view.setDraft(draft.text);
  h.fetcher.mockImplementation(async (url, init) => {
    const body = init?.method === "POST" ? JSON.parse(String(init.body)) : null;
    if (body?.kind === "answer.submit") {
      if (mode === "committed") await h.server.handle(url as RequestInfo, init);
      throw new TypeError("network");
    }
    if ((init?.method ?? "GET") === "GET" && String(url).includes("/commands/")) throw new TypeError("network");
    return h.server.handle(url as RequestInfo, init);
  });
  await view.submit(draft.forgot ? { forgot: true } : {}); await tick();
  const [sent] = h.answers();
  expect(sent).toBeDefined();
  expect(readPending(h.values, writtenPrimaryKey, h.access().profile.profile_id)).toMatchObject({ intent: { command_id: sent.command_id } });
  view.dispose();
  h.fetcher.mockImplementation(h.server.handle);
  return sent as { command_id: string; payload: Record<string, unknown> };
}

describe("Q27 written: a lost answer is read by its own ID only", () => {
  it("recorded by the server: the same ID is read without a fingerprint, the result is restored; no new ID, budget or POST", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "committed", { text: "Haus" });
    const budget = await pageMarks(h.storage, sent.command_id);
    const ids = h.newId.mock.calls.length, posts = h.answers().length;
    expect(h.deletePayloads()).toBe(1);
    const from = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await h.run(5000);
    const reads = h.statusReads(sent.command_id, from);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(url => !url.includes("expected_intent_hash"))).toBe(true);
    expect(next.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } } });
    expect(next.snapshot().commands.primary).toMatchObject({ pending: false, outcome: "accepted",
      resolved: { commandId: sent.command_id, restored: true } });
    expect(hasPending(h.values, writtenPrimaryKey)).toBe(false);
    expect(h.answers()).toHaveLength(posts); expect(h.newId.mock.calls.length).toBe(ids);
    expect(await pageMarks(h.storage, sent.command_id)).toEqual(budget);
  });

  it.each([["a typed answer", { text: "Haus" }], ["«Забыл»", { forgot: true as const }]])(
    "never reached the server (%s): not_found → unresolved without a resend; Stop only once the open session is read", async (_name, draft) => {
      const h = harness();
      const sent = await unknownAnswer(h, "dropped", draft);
      const ids = h.newId.mock.calls.length, posts = h.answers().length;
      const budget = await pageMarks(h.storage, sent.command_id);
      expect(h.deletePayloads()).toBe(1);
      const from = h.fetcher.mock.calls.length;
      const next = h.own(); await next.refresh(); await h.run(60_000, 5000);
      const state = next.snapshot();
      expect(state.commands.primary).toMatchObject({ pending: true, outcome: null, problem: "lost_envelope", canRetry: false,
        pendingIntent: null, lost: { commandId: sent.command_id, sessionOpen: true } });
      expect(state.commands.canStop).toBe(true);
      expect(h.answers()).toHaveLength(posts); expect(h.newId.mock.calls.length).toBe(ids);
      expect(await pageMarks(h.storage, sent.command_id)).toEqual(budget);
      const reads = h.statusReads(sent.command_id, from);
      expect(reads.length).toBeGreaterThan(0);
      expect(reads.every(url => !url.includes("expected_intent_hash"))).toBe(true);
      // The voluntary Stop of the open session; after its confirmed closure the lost answer is proven never to apply.
      await next.stop("stop"); await h.run(10_000);
      expect(h.posts().filter(post => post.kind === "session.stop")).toHaveLength(1);
      expect(h.answers()).toHaveLength(posts);
      expect(hasPending(h.values, writtenPrimaryKey)).toBe(false);
      expect(next.snapshot().commands.primary).toMatchObject({ pending: false, lost: null });
    });

  it("a closed window reads nothing and sends nothing for the lost answer", async () => {
    const h = harness();
    // A gate of its own: the shared test gate of this file must not stay closed for the next test.
    (h.transport as { gate: ReturnType<typeof freshTestGate> }).gate = freshTestGate();
    const sent = await unknownAnswer(h, "committed", { text: "Haus" });
    h.deletePayloads();
    h.transport.gate.closeWindow();
    const calls = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await h.run(30_000, 5000);
    expect(h.fetcher.mock.calls.length).toBe(calls);
    expect(h.statusReads(sent.command_id, calls)).toHaveLength(0);
    expect(hasPending(h.values, writtenPrimaryKey)).toBe(true);
  });

  it("the normal path with its payload is unchanged: the same ID is checked with its fingerprint", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "committed", { text: "Haus" });
    const from = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await h.run(5000);
    expect(h.statusReads(sent.command_id, from).some(url => url.includes("expected_intent_hash"))).toBe(true);
    expect(next.snapshot().commands.primary).toMatchObject({ outcome: "accepted", resolved: { commandId: sent.command_id } });
    expect(next.snapshot().commands.primary.lost ?? null).toBeNull();
  });

  it("result.grade (C467): the chosen grade is content — its lost command is read by its ID and restored, never resent", async () => {
    const h = harness();
    const view = h.own(); await view.refresh(); await view.start("words"); view.setDraft("Haus");
    await view.submit(); await h.run(2000);
    expect(view.snapshot()).toMatchObject({ phase: "result_correct" });
    // The grade commits on the server, its reply and every check of its ID are lost in this window.
    h.fetcher.mockImplementation(async (url, init) => {
      const body = init?.method === "POST" ? JSON.parse(String(init.body)) : null;
      if (body?.kind === "result.grade") { await h.server.handle(url as RequestInfo, init); throw new TypeError("network"); }
      if ((init?.method ?? "GET") === "GET" && String(url).includes("/commands/")) throw new TypeError("network");
      return h.server.handle(url as RequestInfo, init);
    });
    await view.grade(5); await tick();
    const grade = h.posts().find(post => post.kind === "result.grade")!;
    expect(grade).toBeDefined();
    view.dispose(); h.fetcher.mockImplementation(h.server.handle);
    const gradesBefore = h.posts().filter(post => post.kind === "result.grade").length;
    const ids = h.newId.mock.calls.length, budget = await pageMarks(h.storage, grade.command_id);
    expect(h.deletePayloads()).toBe(1);
    const from = h.fetcher.mock.calls.length;
    const next = h.own(); await next.refresh(); await h.run(5000);
    const reads = h.statusReads(grade.command_id, from);
    expect(reads.length).toBeGreaterThan(0); expect(reads.every(url => !url.includes("expected_intent_hash"))).toBe(true);
    // Recovered as accepted: its pointer is gone and the quiz goes on by itself as after any confirmed grade (the next
    // step's own command, assignment.present, gets its own new ID); nothing of the grade is ever sent again.
    const sinceReload = h.fetcher.mock.calls.slice(from).filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1]!.body)));
    expect(sinceReload.filter(post => post.kind === "result.grade" || post.command_id === grade.command_id)).toEqual([]);
    expect(h.posts().filter(post => post.kind === "result.grade")).toHaveLength(gradesBefore);
    const after = sinceReload;
    expect(after.every(post => post.kind === "assignment.present")).toBe(true);
    expect(h.newId.mock.calls.length - ids).toBe(after.length);
    expect(await pageMarks(h.storage, grade.command_id)).toEqual(budget);
    expect(hasPending(h.values, writtenPrimaryKey)).toBe(false);
  });

  it("Stop waits for the confirmation of the open session: a failed session read leaves the lost answer without Stop", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "dropped", { text: "Haus" });
    h.deletePayloads();
    h.fetcher.mockImplementation(async (url, init) => {
      if ((init?.method ?? "GET") === "GET" && String(url).includes("/sessions/")) throw new TypeError("network");
      return h.server.handle(url as RequestInfo, init);
    });
    const next = h.own(); await next.refresh(); await h.run(5000);
    expect(next.snapshot().commands.primary).toMatchObject({ pending: true, outcome: null, lost: { commandId: sent.command_id, sessionOpen: false } });
    expect(next.snapshot().commands.canStop).toBe(false);
    await next.stop("stop"); await h.run(5000);
    expect(h.posts().filter(post => post.kind === "session.stop")).toEqual([]);
  });

  it("a reply that claims a verified fingerprint it was never asked for is refused: nothing is settled, nothing is sent", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "committed", { text: "Haus" });
    h.deletePayloads();
    h.fetcher.mockImplementation(async (url, init) => {
      const reply = await h.server.handle(url as RequestInfo, init);
      if ((init?.method ?? "GET") !== "GET" || !String(url).includes(`/commands/${sent.command_id}`)) return reply;
      return new Response(JSON.stringify({ ...await reply.json(), verified_intent_hash: "0".repeat(64) }), { status: 200 });
    });
    const posts = h.posts().length;
    const next = h.own(); await next.refresh(); await h.run(5000);
    expect(next.snapshot().commands.primary).toMatchObject({ pending: true, outcome: null });
    expect(h.posts()).toHaveLength(posts);
    expect(hasPending(h.values, writtenPrimaryKey)).toBe(true);
  });

  it("Я17: a lost answer whose record carries the conflict mark is never read as this lane's fact; it waits for the closure", async () => {
    const h = harness();
    const sent = await unknownAnswer(h, "committed", { text: "Haus" });
    // The record was marked as a conflict (another payload under this ID, Я17) before its content went (Е02).
    const pointerKey = [...h.values.keys()].find(key => key.startsWith(`${writtenPrimaryKey}:profile:`))!;
    const pointer = JSON.parse(h.values.get(pointerKey)!); pointer.record.mismatch = true; h.values.set(pointerKey, JSON.stringify(pointer));
    expect(h.deletePayloads()).toBe(1);
    const from = h.fetcher.mock.calls.length, posts = h.posts().length;
    const next = h.own(); await next.refresh(); await h.run(30_000, 5000);
    expect(h.statusReads(sent.command_id, from)).toEqual([]);
    expect(next.snapshot().commands.primary).toMatchObject({ pending: true, outcome: null, problem: "mismatch", conflict: true });
    expect(h.posts()).toHaveLength(posts);
    expect(h.values.get(pointerKey)).toBe(JSON.stringify(pointer));
  });
});
