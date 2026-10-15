// QA-CHAIN-L2 п. 3, C180 F2, owner answer 30.1-А (C184): a grade, a correction or an undo the shared slot refused leaves the
// earlier result waiting for «Далее» after the check (the timer the tap cancelled never resumes, F2-а). That wait must not
// leak onto a later ACCEPTED result, which follows its own rule (F2-б).
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { action, id, original, pending, primaryKey } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import { learningUndoServer } from "./learningUndo.test-support";
import { LearningViewController } from "./learningViewController";
import { hashInPlace } from "../commands/recoveryTime.test-support";
import { testGate } from "../commands/testGate.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
const foreign = () => JSON.stringify(pending(original(action(), 777)));
async function answered(wrong = false) {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", id(3)); owners.push(f.view); if (wrong) f.wrong();
  await f.view.refresh(); await tick();
  f.view.setDraft(wrong ? "falsch" : "Haus"); await f.view.submit(); await tick();
  return f;
}
/** The slot refuses the next action, then the other window's record goes and the person checks. */
async function droppedThenChecked(f: Awaited<ReturnType<typeof answered>>, act: () => Promise<void>) {
  f.values.set(primaryKey, foreign()); await act(); await tick();
  f.values.delete(primaryKey); await f.view.refresh(); await tick();
}
const kinds = (f: Awaited<ReturnType<typeof answered>>, from: number) => f.posts().slice(from).map(post => post.kind);
async function wait(seconds: number) { for (let s = 0; s < seconds; s += 5) await tick(5000); }

describe("a later accepted result after a refused action follows its own rule", () => {
  it("W7: a refused correction, then an accepted one: its normal timer runs and advances once, as without the refusal (W8)", async () => {
    const f = await answered(true);
    await droppedThenChecked(f, () => f.view.correct());
    const before = f.posts().length;
    await f.view.correct(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, timer: { durationMs: 3000 } });
    await wait(10);
    expect(kinds(f, before)).toEqual(["result.correct", "assignment.present"]);
  });
  it("W8 control: an accepted correction without any refusal", async () => {
    const f = await answered(true);
    const before = f.posts().length;
    await f.view.correct(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await wait(10);
    expect(kinds(f, before)).toEqual(["result.correct", "assignment.present"]);
  });
  it("a refused «Далее», then an accepted correction: its normal timer runs", async () => {
    const f = await answered(true);
    await droppedThenChecked(f, () => f.view.next());
    expect(f.view.snapshot().phase).toBe("result_wrong");
    const before = f.posts().length;
    await f.view.correct(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await wait(10);
    expect(kinds(f, before)).toEqual(["result.correct", "assignment.present"]);
  });
  it("a refused grade, then an accepted grade: it advances once by its own path (pendingGradeAdvance)", async () => {
    const f = await answered();
    await droppedThenChecked(f, () => f.view.grade(5));
    const before = f.posts().length;
    await f.view.grade(3); await tick(); await wait(10);
    expect(kinds(f, before)).toEqual(["result.grade", "assignment.present"]);
  });
});

describe("30.1-А: after a refused revision and the check the earlier result waits for «Далее»", () => {
  it.each(["grade", "correct"] as const)("a refused %s: no present without a tap for 30 s; «Далее» sends exactly one", async kind => {
    const f = await answered(kind === "correct");
    await droppedThenChecked(f, () => kind === "grade" ? f.view.grade(5) : f.view.correct());
    const before = f.posts().length; await wait(30);
    expect(f.view.snapshot()).toMatchObject({ phase: kind === "grade" ? "result_correct" : "result_wrong", timer: null, canNext: true });
    expect(f.posts()).toHaveLength(before);
    await f.view.next(); await tick(); await wait(10);
    expect(kinds(f, before)).toEqual(["assignment.present"]);
  });
  it("a refused undo: no present without a tap for 30 s; «Далее» sends exactly one", async () => {
    vi.useFakeTimers(); hashInPlace();
    const s = learningUndoServer();
    const view = new LearningViewController({ access: s.access, storage: s.storage, newId: s.newId,
      transport: { fetcher: s.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() }, sessionId: id(3), transitionMode: () => "normal",
      onUpdate: vi.fn() });
    owners.push(view);
    await view.refresh(); await tick(); view.setDraft("Haus"); await view.submit(); await tick();
    expect(view.snapshot()).toMatchObject({ phase: "result_correct", canUndo: true });
    s.values.set(primaryKey, foreign()); await view.undo(); await tick();
    s.values.delete(primaryKey); await view.refresh(); await tick();
    const before = s.posts().length; await wait(30);
    expect(view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    expect(s.posts()).toHaveLength(before);
    await view.next(); await tick(); await wait(10);
    expect(s.posts().slice(before).map(post => post.kind)).toEqual(["assignment.present"]);
  });
});

describe("unchanged: the other reasons to wait", () => {
  it("a refused grade, checked, no new action: the result stays, no timer, nothing sent in 30 s", async () => {
    const f = await answered();
    await droppedThenChecked(f, () => f.view.grade(5));
    const before = f.posts().length; await wait(30);
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, timer: null });
    expect(f.posts()).toHaveLength(before);
  });
  it("a refused correction, checked, no new action: the error stays, nothing sent in 30 s", async () => {
    const f = await answered(true);
    await droppedThenChecked(f, () => f.view.correct());
    const before = f.posts().length; await wait(30);
    expect(f.view.snapshot()).toMatchObject({ phase: "result_wrong", timer: null });
    expect(f.posts()).toHaveLength(before);
  });
  it("a refused «Далее» on a correct result, checked: it still waits for «Далее»", async () => {
    const f = await answered();
    await droppedThenChecked(f, () => f.view.next());
    const before = f.posts().length; await wait(30);
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null });
    expect(f.posts()).toHaveLength(before);
  });
  it("background before: the accepted correction after a refused one still waits for «Далее» (the background reason stays)", async () => {
    const f = await answered(true);
    f.view.suspend(); f.replace(); await f.view.resume(); await tick();
    await droppedThenChecked(f, () => f.view.correct());
    const before = f.posts().length;
    await f.view.correct(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await wait(10);
    expect(kinds(f, before)).toEqual(["result.correct"]);
  });
  it("background control without a refusal: the same wait", async () => {
    const f = await answered(true);
    f.view.suspend(); f.replace(); await f.view.resume(); await tick();
    const before = f.posts().length;
    await f.view.correct(); await tick(); await wait(10);
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null });
    expect(kinds(f, before)).toEqual(["result.correct"]);
  });
  it("previous_result: an accepted grade after a refused one keeps previous_result and advances nothing", async () => {
    const f = await answered();
    await f.view.next(); await tick(); f.view.previousResult(); await tick();
    expect(f.view.snapshot().phase).toBe("previous_result");
    await droppedThenChecked(f, () => f.view.grade(5));
    const before = f.posts().length;
    await f.view.grade(3); await tick(); await wait(10);
    expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", answer: { result: { grade: 3 } } });
    expect(kinds(f, before)).toEqual(["result.grade"]);
  });
  it("a wrong answer in normal mode: no timer after the refusal and the check, as without it", async () => {
    const f = await answered(true);
    expect(f.view.snapshot().timer).toBeNull();
    await droppedThenChecked(f, () => f.view.correct());
    expect(f.view.snapshot().timer).toBeNull();
  });
});
