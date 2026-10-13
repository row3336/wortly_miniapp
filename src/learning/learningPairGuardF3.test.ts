// QA F3 / C158 in the Learning view over its real lanes (as writtenPairGuardF3): an older closed step of another pair
// is refused before the view (DocumentLanes.acceptRead), the own result stays, a fresh read recovers the new one, and
// an own closure at the floor ends the view without new rights.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningSessionProjection } from "../api/generated";
import type { LearningViewController } from "./learningViewController";
import { response } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

type Body = Record<string, any>;
function harness() {
  const f = learningViewFixture(); owners.push(f.view);
  const plan = { staleAnswerReply: false, resultRead: null as null | "stale_closed_other" | "closed_other_at_floor" };
  f.fetcher.mockImplementation(async (url, init) => {
    const isAnswer = init?.method === "POST" && JSON.parse(String(init.body)).kind === "answer.submit";
    if (plan.resultRead && init?.method === "GET" && String(url).includes("result_id=")) {
      // The same result read as the server projects it for a closed session, named in uk-de.
      const sessionUrl = String(url).split("?")[0];
      const current = (await (await f.handler(sessionUrl, { method: "GET" })).json() as Body).current as LearningSessionProjection;
      f.setStep({ ...current, status: "closed", close_reason: "pair_changed", assignment: null, preview: null });
      const closed = await f.handler(url, init);
      f.setStep(current);
      const raw = (await closed.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
      const body = JSON.parse(raw) as Body, mode = plan.resultRead; plan.resultRead = null;
      return response(mode === "stale_closed_other" ? { ...body, state_version: "1" } : body, closed.status);
    }
    const reply = await f.handler(url, init);
    if (isAnswer && plan.staleAnswerReply) {
      // The accepted answer arrives older than what the lanes already saw: its result is not built by the lane.
      plan.staleAnswerReply = false;
      return response({ ...await reply.json() as Body, state_version: "1" }, reply.status);
    }
    return reply;
  });
  const kinds = () => f.posts().map(post => post.kind);
  return { ...f, kinds, plan };
}
const internalAnswer = (view: LearningViewController) =>
  (view as unknown as { answer: { result: { result_id: string } } | null }).answer;
async function secondAnswerWith(f: ReturnType<typeof harness>, read: "stale_closed_other" | "closed_other_at_floor") {
  await f.view.refresh();
  f.view.setDraft("Haus"); await f.view.submit();
  expect(f.view.snapshot().phase).toBe("result_correct");
  const own = internalAnswer(f.view)!.result.result_id;
  await f.view.next();
  expect(f.view.snapshot().phase).toBe("question");
  f.plan.staleAnswerReply = true; f.plan.resultRead = read;
  f.view.setDraft("Hund"); await f.view.submit();
  await f.view.refresh();
  return own;
}

describe("F3 Learning: a result met only with an older closed step of another pair (C158)", () => {
  it("LF1: the older closed step is refused as a failed read: no new result, no Next, no reason; the own result stays", async () => {
    const f = harness();
    const own = await secondAnswerWith(f, "stale_closed_other");
    expect(f.view.snapshot()).toMatchObject({ phase: "stale", problem: "load", pairMismatch: null, closed: null,
      canNext: false, grades: [], canCorrect: false, canUndo: false,
      commands: { primary: { outcome: "accepted", resolved: { kind: "answer.submit" } } } });
    expect(internalAnswer(f.view)?.result.result_id).toBe(own);
    expect(f.kinds().filter(kind => kind === "answer.submit")).toHaveLength(2);
  });
  it("LF2: a fresh read then recovers that result with its current version and rights", async () => {
    const f = harness();
    const own = await secondAnswerWith(f, "stale_closed_other");
    await f.view.refresh();
    const after = f.view.snapshot();
    expect(after).toMatchObject({ phase: "result_correct", problem: null });
    expect(after.answer?.result?.result_id).not.toBe(own);
    expect(after.answer?.capabilities.grades?.expected_result_version).toBe(after.answer?.result?.version);
  });
  it("LF3: an own closure at the floor ends the view as before, with no grade or undo", async () => {
    const f = harness();
    await secondAnswerWith(f, "closed_other_at_floor");
    expect(f.view.snapshot()).toMatchObject({ phase: "closed", grades: [], canUndo: false, canCorrect: false, canNext: false });
  });
});
