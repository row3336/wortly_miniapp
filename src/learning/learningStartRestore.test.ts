import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { action, deferred, id, original, pending, primaryKey, profile } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import type { LearningViewController } from "./learningViewController";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
const other = () => JSON.stringify(pending(original(action(), 777)));

/**
 * C135 п. 4: a start dropped over another window's record returns the view to what it itself showed before the tap, never
 * to rights of an old copy, and only while nothing newer replaced the start. The slot read of the start's save is held,
 * so events can happen between the beginning and the end of its await.
 */
const reads = (f: { fetcher: { mock: { calls: [string | URL | Request, RequestInit?][] } } }) => () =>
  f.fetcher.mock.calls.filter(([url]) => String(url).includes(`/sessions/`) || String(url).includes("/commands/"));
function held(sessionId: string | null = null) {
  const f = learningViewFixture("normal", sessionId); owners.push(f.view);
  const gate = deferred<void>();
  let holding = false;
  const base = vi.mocked(f.storage.get).getMockImplementation()!;
  vi.mocked(f.storage.get).mockImplementation(async key => {
    if (holding && key === primaryKey) { holding = false; f.values.set(primaryKey, other()); await gate.promise; }
    return base(key);
  });
  return { ...f, reads: reads(f), hold: () => { holding = true; }, release: () => gate.resolve() };
}
const ySession = (f: { newId: { mock: { results: { value: unknown }[] } } }) => String(f.newId.mock.results.at(-1)?.value);

describe("Learning: the view after a start dropped over another window's record", () => {
  it("a raised version floor during the await: idle again, no session of Y read, nothing shown from before", async () => {
    vi.useFakeTimers(); const f = held(); await f.view.refresh(); const before = f.reads().length;
    f.hold(); const starting = f.view.start(); await tick();
    f.replace({ profile: profile("20"), session: null });
    f.release(); await starting; await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null, current: null, question: null, answer: null });
    await f.view.refresh();
    expect(f.reads().slice(before).some(([url]) => String(url).includes(ySession(f)))).toBe(false);
    expect(f.posts()).toEqual([]);
  });
  it("the owner disposed during the await (a repeated mount): no late update, the next owner sees only X", async () => {
    vi.useFakeTimers(); const f = held(); await f.view.refresh();
    f.hold(); const starting = f.view.start(); await tick();
    const updates = f.onUpdate.mock.calls.length;
    f.view.dispose(); f.release(); await starting; await tick();
    expect(f.onUpdate.mock.calls.length).toBe(updates);
    expect(f.posts()).toEqual([]); expect(f.values.get(primaryKey)).toBe(other());
  });
  it("Stop during the await: «Выйти» is off while the start is stored (21.1-А); the dropped start returns to idle", async () => {
    vi.useFakeTimers(); const f = held(); await f.view.refresh();
    f.hold(); const starting = f.view.start(); await tick();
    expect(f.view.snapshot().canStop).toBe(false);
    const stopping = f.view.stop();
    f.release(); await starting; await stopping; await tick(); await tick(5000);
    expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null });
    expect(f.posts()).toEqual([]);
  });
  it("after the block is cleared nothing advances by itself: no timer sends a new action without a tap", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", id(3)); owners.push(f.view); await f.view.refresh(); await tick();
    f.view.setDraft("Haus"); await f.view.submit(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct" });
    const before = f.posts().length; f.values.set(primaryKey, other());
    await f.view.grade(5); await tick();
    f.values.delete(primaryKey); await f.view.refresh(); await tick();
    for (let second = 0; second < 60; second += 5) await tick(5000);
    expect(f.posts()).toHaveLength(before);
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } } });
  });
  it("a start refused over an unreadable record: idle again; «check» reads no session of Y", async () => {
    vi.useFakeTimers();
    const v = learningViewFixture("normal", null), f = { ...v, reads: reads(v) }; owners.push(f.view); await f.view.refresh();
    f.values.set(primaryKey, "{not json");
    const before = f.reads().length;
    await f.view.start(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null, problem: "invalid_pending" });
    await f.view.refresh(); await tick();
    expect(f.reads().slice(before)).toEqual([]);
    expect(f.posts()).toEqual([]); expect(f.values.get(primaryKey)).toBe("{not json");
  });
});
