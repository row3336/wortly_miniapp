import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { tick, writtenFixture } from "./writtenFixtures.test-support";
import { writtenAutomaticKinds } from "./writtenDocumentCommands";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

describe("written session.start keeps its manual recovery (Q26 is its own package; QA CP2c З1)", () => {
  it("is not among the automatic kinds", () => {
    expect(writtenAutomaticKinds).not.toContain("session.start");
    expect(writtenAutomaticKinds).not.toContain("session.stop");
  });
  it("a lost start is sent once, never resent by itself and owns no automatic recovery", async () => {
    vi.useFakeTimers();
    const f = writtenFixture({});
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view);
    await view.refresh(); await tick();
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).kind === "session.start") throw new TypeError("network");
      return f.server.handle(url as RequestInfo, init);
    });
    await view.start("words"); await tick();
    for (let spent = 0; spent < 5 * 60_000; spent += 5000) await tick(5000);
    expect(f.posts().filter(post => post.kind === "session.start")).toHaveLength(1);
    expect(view.snapshot().commands).toMatchObject({ automaticPrimary: false, recovery: null });
  });
});
