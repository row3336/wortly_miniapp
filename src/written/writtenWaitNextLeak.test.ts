// Owner answer 30.1-А (C184) for the written quiz, and the leak of QA-CHAIN-L2 п. 3 (б): a grade or correction the shared
// slot refused leaves the earlier result waiting for «Далее» after the check; a later ACCEPTED one follows its own rule.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenIntent } from "./writtenIntent";
import { writtenPrimaryKey } from "./writtenPending";
import { WrittenViewController } from "./writtenViewController";
import { id, pending, tick, writtenFixture } from "./writtenFixtures.test-support";
import { seedRaw, pointerKeyOf } from "../commands/pendingSeed.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
async function answered(text: string) {
  vi.useFakeTimers();
  const f = writtenFixture();
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
    sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
  owners.push(view);
  await view.refresh(); await view.start("words"); await tick();
  view.setDraft(text); await view.submit(); await tick();
  // X: another window's record of the same kind of action, with its own ID.
  const { client_instance_id: _c, document_id: _d, ...sent } = f.posts().at(-1)!;
  const foreign = JSON.stringify(pending({ ...sent, command_id: id(777) } as WrittenIntent));
  const kinds = (from: number) => f.posts().slice(from).map(post => post.kind);
  const droppedThenChecked = async (act: () => Promise<void>) => {
    seedRaw(f.values, writtenPrimaryKey, foreign, id(1)); await act(); await tick();
    f.values.delete(pointerKeyOf(writtenPrimaryKey, id(1))); await view.refresh(); await tick();
  };
  return { ...f, view, kinds, droppedThenChecked };
}
async function wait(seconds: number) { for (let s = 0; s < seconds; s += 5) await tick(5000); }

describe("written: a refused revision, the check, and what follows", () => {
  it("30.1-А: a refused correction: the error waits for «Далее» (no present in 30 s); «Далее» sends exactly one", async () => {
    const h = await answered("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true });
    await h.droppedThenChecked(() => h.view.correct());
    const before = h.posts().length; await wait(30);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", timer: null });
    expect(h.posts()).toHaveLength(before);
    await h.view.next(); await tick(); await wait(10);
    expect(h.kinds(before)).toEqual(["assignment.present"]);
  });
  it("30.1-А: a refused grade on a correct result: no present in 30 s; «Далее» sends exactly one", async () => {
    const h = await answered("Haus");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct" });
    const grade = h.view.snapshot().grades.find(value => value !== 4) ?? 5;
    await h.droppedThenChecked(() => h.view.grade(grade));
    const before = h.posts().length; await wait(30);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null });
    expect(h.posts()).toHaveLength(before);
    await h.view.next(); await tick(); await wait(10);
    expect(h.kinds(before)).toEqual(["assignment.present"]);
  });
  it("W7: after a refused correction an accepted one gets its normal timer, as without the refusal", async () => {
    const h = await answered("falsch");
    await h.droppedThenChecked(() => h.view.correct());
    const before = h.posts().length;
    await h.view.correct(); await tick();
    const after = h.view.snapshot();
    await wait(10);
    const control = await answered("falsch");
    const c0 = control.posts().length;
    await control.view.correct(); await tick();
    const ctl = control.view.snapshot();
    await wait(10);
    expect(ctl.timer?.durationMs).toBe(3000);
    expect(after.timer?.durationMs).toBe(ctl.timer?.durationMs);
    expect(after.phase).toBe(ctl.phase);
    expect(h.kinds(before)).toEqual(control.kinds(c0));
  });
});
