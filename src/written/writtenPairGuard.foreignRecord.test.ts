// CONTRACT control of MQ8 (C158, C12, Codex C234): the sameId check of the resolved session in
// StudyView.recoverAcceptedResult. A view whose own session S is known open in another pair (R1) meets the accepted
// result of ANOTHER session S2; that result must not be settled as S's pair change, so S's published pairMismatch stays.
// This is not a trace of the App: a regular App path to this state is not shown (D-FOREIGN-RESULT/REPORT.md). The state
// is reached on real lanes and the real view only through these artificial adjustments of the test:
//   1. the record Y of S2 is written straight into the shared slot (as if another window had left it);
//   2. a new view owner is created with sessionId S directly (no App remount);
//   3. the synthetic server keeps one session, so its replies about Y and S2 are rewritten: S2 shown closed, in the
//      other pair (uk-de), with no rights, and the result detail set to null (a closed step requires it);
//   4. the start of S resets the server's old close reason by hand (the synthetic start keeps it otherwise).
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { writtenPrimaryKey } from "./writtenPending";
import { pending, response, writtenFixture } from "./writtenFixtures.test-support";
import type { WrittenIntent } from "./writtenIntent";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

/** One server whose pair can move to uk elsewhere; replies about `older` (its commands, its results) show it closed. */
function harness() {
  const f = writtenFixture({ cards: [6, 7] });
  const world = { otherPair: false, older: null as null | { sessionId: string; commandId: string } };
  f.fetcher.mockImplementation(async (url, init) => {
    const reply = await f.server.handle(url, init);
    if (!world.otherPair || !/\/commands|\/sessions\//.test(String(url))) return reply;
    const body = JSON.parse((await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"'));
    const older = world.older;
    // The synthetic server keeps one session: a reply about a command or a result of the older session shows that
    // session as core does, closed, with no rights left.
    if (older && body.step && (String(url).includes(older.commandId) || String(url).includes(older.sessionId))) {
      body.step = { ...body.step, session_id: older.sessionId, status: "closed", close_reason: "remote_stop", assignment: null,
        summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } };
      body.capabilities = { answer_target: null, grades: null, correct_target: null, undo_target: null, stop: false, summary_home: false };
      if (body.result) body.result = { ...body.result, detail: null };
    }
    return response(body, reply.status);
  });
  const owner = (sessionId: string | null = null) => {
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId, transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view);
    return view;
  };
  return { ...f, owner, world };
}

describe("MQ8 contract control (not an App trace): sameId of the resolved session in recoverAcceptedResult", () => {
  it("keeps its own session's pair change: the result of the older session is no proof about this one", async () => {
    const h = harness();
    // S2 and its answer Y: the server applied Y; the window that sent it kept its record (its reply was lost).
    const a = h.owner(); await a.refresh();
    await a.start("words");
    const s2 = h.server.state.sessionId!;
    a.setDraft("Haus"); await a.submit();
    const { client_instance_id: _client, document_id: _document, ...y } = h.posts().find(post => post.kind === "answer.submit")!;
    a.dispose();
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    // R1: the pair moved to uk elsewhere; this window of ru starts S, which the server creates in uk.
    const b = h.owner(); await b.refresh();
    h.world.otherPair = true; h.server.state.closeReason = null; // the synthetic start keeps the old reason otherwise
    await b.start("words");
    const s = h.server.state.sessionId!;
    expect(s).not.toBe(s2);
    expect(b.snapshot().pairMismatch).toBe(s);
    b.dispose();
    // A new owner of S on this page (a remount with the open session) finds Y in the shared slot.
    h.world.older = { sessionId: s2, commandId: y.command_id as string };
    h.values.set(writtenPrimaryKey, JSON.stringify(pending(y as WrittenIntent)));
    const c = h.owner(s);
    const mark = h.fetcher.mock.calls.length;
    await c.refresh();
    const reads = h.fetcher.mock.calls.slice(mark).map(([url]) => new URL(String(url), "http://localhost").pathname);
    // Y is only checked by its ID (2.3 А) and confirmed: the lanes hold the accepted result of S2.
    expect(reads).toContain(`/api/v1/commands/${y.command_id as string}`);
    expect(h.posts().filter(post => post.command_id === y.command_id)).toHaveLength(1);
    expect(c.snapshot().commands.primary).toMatchObject({ outcome: "accepted", resolved: { commandId: y.command_id, sessionId: s2 } });
    // The view's own session is still the one the server proved open in uk: that fact stays published.
    expect(c.snapshot().pairMismatch).toBe(s);
    expect(c.snapshot().problem).toBeNull();
  });
});
