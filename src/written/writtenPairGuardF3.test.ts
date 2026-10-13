// QA F3 / C158 in the written view over its real lanes. These lanes refuse a read below their floor before the view
// sees it (DocumentLanes.acceptRead: invalid_response), so an older closed step of another pair ends as a failed read:
// no new result, the own confirmed result stays, a fresh own read recovers it; an own closure at the floor ends the view.
// The view's own rule for an older step that does reach it (a floor raised in between) is pinned in studyView.test.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { response, writtenFixture } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

type Body = Record<string, any>;
function harness() {
  const f = writtenFixture({ cards: [6, 7, 8] });
  const plan = { staleAnswerReply: false, resultRead: null as null | "stale_closed_other" | "closed_other_at_floor" };
  f.fetcher.mockImplementation(async (url, init) => {
    const reply = await f.server.handle(url, init);
    const isAnswer = init?.method === "POST" && JSON.parse(String(init.body)).kind === "answer.submit";
    if (isAnswer && plan.staleAnswerReply) {
      // The accepted answer arrives older than what the lanes already saw: its result is not built by the lane.
      plan.staleAnswerReply = false;
      return response({ ...await reply.json() as Body, state_version: "1" }, reply.status);
    }
    if (plan.resultRead && init?.method === "GET" && String(url).includes("result_id=")) {
      // The same result read as the server projects it for a closed session (valid rights and detail), named in uk-de.
      const state = f.server.state, kept = { status: state.status, closeReason: state.closeReason, assignment: state.assignment };
      Object.assign(state, { status: "closed", closeReason: "pair_changed", assignment: null });
      const closed = await f.server.handle(url, init);
      Object.assign(state, kept);
      const raw = (await closed.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
      const body = JSON.parse(raw) as Body, mode = plan.resultRead; plan.resultRead = null;
      return response(mode === "stale_closed_other" ? { ...body, state_version: "1" } : body, closed.status);
    }
    return reply;
  });
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
    sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
  owners.push(view);
  const kinds = () => f.posts().map(post => post.kind);
  const answerFirst = async () => { view.setDraft("Haus"); await view.submit(); };
  return { ...f, view, kinds, plan, answerFirst };
}
const internalAnswer = (view: WrittenViewController) =>
  (view as unknown as { answer: { result: { result_id: string } } | null }).answer;

describe("F3 written: a result met only with an older closed step of another pair (C158)", () => {
  it("WF1: the older closed step of another pair is refused as a failed read: no new result, no Next, no reason", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    await h.answerFirst();
    expect(h.view.snapshot().phase).toBe("result_correct");
    const own = internalAnswer(h.view)!.result.result_id;
    await h.view.next();
    h.plan.staleAnswerReply = true; h.plan.resultRead = "stale_closed_other";
    h.view.setDraft("Hund"); await h.view.submit();
    await h.view.refresh();
    const after = h.view.snapshot();
    expect(after.closed).toBeNull();
    // A failed read keeps its own reason (C149), never the pair change and never a closure by the old version.
    expect(after).toMatchObject({ phase: "stale", problem: "load", pairMismatch: null, canNext: false, grades: [], canCorrect: false,
      canUndo: false, commands: { primary: { outcome: "accepted", resolved: { kind: "answer.submit" } } } });
    expect(internalAnswer(h.view)?.result.result_id).toBe(own);
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(2);
  });
  it("WF2: a fresh own read then recovers that result with its current version and rights", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    await h.answerFirst(); await h.view.next();
    h.plan.staleAnswerReply = true; h.plan.resultRead = "stale_closed_other";
    h.view.setDraft("Hund"); await h.view.submit();
    await h.view.refresh();
    await h.view.refresh();
    const after = h.view.snapshot();
    expect(after).toMatchObject({ phase: "result_wrong", problem: null, canCorrect: true });
    expect(after.answer?.result).toMatchObject({ grade: 2 });
    expect(after.answer?.capabilities.correct_target?.expected_result_version).toBe(after.answer?.result?.version);
  });
  it("WF3: an own closure at the floor ends the view as before, with no grade or undo", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    await h.answerFirst(); await h.view.next();
    h.plan.staleAnswerReply = true; h.plan.resultRead = "closed_other_at_floor";
    h.view.setDraft("Hund"); await h.view.submit();
    await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", grades: [], canUndo: false, canCorrect: false, canNext: false,
      closed: { reason: "pair_changed" } });
  });
});
