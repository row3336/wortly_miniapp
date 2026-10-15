import { afterEach, describe, expect, it, vi } from "vitest";
import { hashInPlace, tick } from "../commands/recoveryTime.test-support";
import { action, id, original, pending, primaryKey, stop } from "./learningFixtures.test-support";
import { learningUndoServer } from "./learningUndo.test-support";
import { learningViewFixture } from "./learningView.test-support";
import { LearningViewController } from "./learningViewController";
import { testGate } from "../commands/testGate.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function harness(sessionId: string | null = id(3)) { const f = learningViewFixture("normal", sessionId); owners.push(f.view); return f; }
/** X: another window's record in the shared slot. */
const other = () => JSON.stringify(pending(original(action(), 777)));

// M-SLOT-CONFLICT-LC: every Learning action that meets X sends nothing, keeps what the person sees and typed, starts no
// timer, advances nothing and grades nothing; the block names the reason (the lane's pending_changed).
describe("Learning view: a new action meets another window's record in the shared slot", () => {
  it("an answer keeps the question and its draft, sends nothing and never waits for an answer that cannot come", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); await tick();
    f.view.setDraft("Haus"); f.values.set(primaryKey, other());
    await f.view.submit(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "Haus", question: { id: id(6) }, problem: "pending_changed",
      canEditDraft: true, canSubmit: false, timer: null, commands: { recovery: null, primary: { pending: false } } });
    for (let second = 0; second < 60; second += 5) await tick(5000);
    expect(f.posts()).toEqual([]);
  });
  it("a grade keeps the result on screen; no old timer advances to the next question", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    const before = f.posts().length; f.values.set(primaryKey, other());
    await f.view.grade(5); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, timer: null, problem: "pending_changed" });
    for (let second = 0; second < 30; second += 5) await tick(5000);
    expect(f.posts()).toHaveLength(before);
  });
  it("«Дальше» to the next question keeps the result on screen, sends no present and waits for an explicit «Дальше»", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    const before = f.posts().length; f.values.set(primaryKey, other());
    await f.view.next(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", problem: "pending_changed", timer: null });
    for (let second = 0; second < 30; second += 5) await tick(5000);
    expect(f.posts()).toHaveLength(before);
  });
  it("a start keeps the view as it was: no session ID of it is read or checked", async () => {
    const f = harness(null); await f.view.refresh();
    expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null });
    f.values.set(primaryKey, other()); const calls = f.fetcher.mock.calls.length;
    await f.view.start();
    expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null, problem: "pending_changed" });
    await f.view.refresh();
    expect(f.fetcher.mock.calls.length).toBe(calls);
    expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null, commands: { canBegin: true } });
  });
  it("Stop of the open session meets another window's Stop record: nothing is sent, the question and its draft come back", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus");
    const xs = JSON.stringify(pending(original(stop, 778)));
    f.values.set("wortly.pending.learning_stop", xs);
    expect(f.view.snapshot().canStop).toBe(true);
    await f.view.stop();
    // As any Stop refused before a request (unsentStop): the screen returns to where Stop was tapped, nothing exited.
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "Haus", commands: { stop: { pending: false } } });
    expect(f.values.get("wortly.pending.learning_stop")).toBe(xs);
  });
});

describe("Learning «Шаг назад» meets another window's record", () => {
  it("keeps the result it would remove, sends no undo and no present", async () => {
    hashInPlace();
    const s = learningUndoServer();
    const view = new LearningViewController({ access: s.access, storage: s.storage, newId: s.newId,
      transport: { fetcher: s.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() }, sessionId: id(3), transitionMode: () => "normal",
      onUpdate: vi.fn() });
    owners.push(view);
    await view.refresh(); view.setDraft("falsch"); await view.submit();
    expect(view.snapshot()).toMatchObject({ phase: "result_wrong", canUndo: true });
    const before = s.posts().length; s.values.set(primaryKey, other());
    await view.undo();
    expect(view.snapshot()).toMatchObject({ phase: "result_wrong", problem: "pending_changed", answer: { result: { status: "active" } } });
    expect(s.posts()).toHaveLength(before);
  });
});
