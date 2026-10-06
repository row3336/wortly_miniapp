// The correction right of a result is offered only on its own result view (moved from the independent QA of M-WCORR, QA-01).
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { id, writtenFixture } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); });

describe("written correction right", () => {
  it("the live right of A is not offered on the question of B: only a result view revises", async () => {
    const f = writtenFixture({ cards: [6, 7, 8] });
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view);
    await view.refresh(); await view.start("words");
    view.setDraft("falsch"); await view.submit(); await view.next();
    // The server still grants the right of A while B is asked.
    expect(f.server.view(id(706)).capabilities.correct_target).not.toBeNull();
    expect(view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, canCorrect: false });
    await view.correct();
    expect(f.posts().filter(post => post.kind === "result.correct")).toHaveLength(0);
  });
});
