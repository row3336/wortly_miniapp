// fix1 (QA-Q2): the result timer of the written quiz under a write gate that shuts for a moment — the timer is paused
// (its deadline kept), comes back once the gate lets writes through, and still advances to the next question.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { writtenFixture } from "./writtenFixtures.test-support";
import { gateWith } from "../commands/writeGate.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness() {
  const f = writtenFixture({});
  const g = gateWith([{ status: "ready" }, { status: "ready" }, { status: "ready" }]);
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: { ...f.transport, gate: g.gate },
    newId: f.newId, sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
  owners.push(view);
  return { ...f, ...g, view, kinds: () => f.posts().map(post => post.kind) };
}

describe("fix1: the result timer and a short closure of the write gate (QA-Q2)", () => {
  it("paused while the gate holds, armed again after ready with the rest of its time, then the next question", async () => {
    const h = harness();
    await h.view.refresh(); await h.view.start("words");
    h.view.setDraft("Haus"); await h.view.submit();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    h.gate.closeByFailure(); // a background request broke: net closed until the probe's ready in 5 s
    expect(h.view.snapshot().timer).toBeNull();
    expect(h.view.snapshot().canNext).toBe(false);
    await h.clock.advanceTo(5_000);
    expect(h.gate.mayWrite()).toBe(true);
    const timer = h.view.snapshot().timer;
    expect(timer).not.toBeNull();
    expect(timer!.durationMs).toBeLessThanOrEqual(3000);
    await vi.waitFor(() => expect(h.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2), { timeout: 4_000 });
  });
});
