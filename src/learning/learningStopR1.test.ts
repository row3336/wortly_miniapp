// Owner answer 888·17.2-А in Learning: only the R1 session (this owner's start confirmed, the session shown open in
// another pair, the window without that pair yet) has no Stop. Every other case keeps the rights it had (C129).
import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningViewController } from "./learningViewController";
import { id, profile, response } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";

const owners: LearningViewController[] = [];
const mismatch = (view: { snapshot(): { pairMismatch: string | null } }) => view.snapshot().pairMismatch !== null;
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness(sessionId: string | null = null) {
  const f = learningViewFixture("normal", sessionId); owners.push(f.view);
  const server = { otherPair: false, lose: false };
  f.fetcher.mockImplementation(async (url, init) => {
    const reply = await f.handler(url, init);
    if (init?.method === "POST" && server.lose) { server.lose = false; throw new TypeError("network"); }
    if (!server.otherPair || !/\/commands|\/sessions\//.test(String(url))) return reply;
    const raw = (await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
    return response(JSON.parse(raw), reply.status);
  });
  const owner = (session: string | null) => {
    const view = new LearningViewController({ access: f.access, storage: f.storage, newId: f.newId,
      transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000 }, sessionId: session,
      transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view); return view;
  };
  const kinds = () => f.posts().map(post => post.kind);
  return { ...f, owner, kinds, serverPair: server };
}

describe("17.2-А in Learning: the R1 Stop gate", () => {
  it("LSR1: a lost start reply keeps Stop until the check by ID confirms the R1 session", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true; f.serverPair.lose = true;
    await f.view.start();
    expect(f.view.snapshot().canStop).toBe(true);
    await f.view.refresh();
    expect(f.view.snapshot()).toMatchObject({ canStop: false, commands: { primary: { outcome: "accepted" } } });
    await f.view.stop();
    expect(f.kinds()).toEqual(["session.start"]);
  });
  it("LSR2: an unknown start keeps its Stop: the session of a lost start is stopped as before", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true; f.serverPair.lose = true;
    await f.view.start();
    const started = f.posts()[0].session_id;
    await f.view.stop();
    expect(f.kinds()).toEqual(["session.start", "session.stop"]);
    expect(f.posts()[1]).toMatchObject({ kind: "session.stop", session_id: started });
  });
  it("LSR3: a session this owner did not start (a resumed one) shown in another pair keeps Stop", async () => {
    const f = harness(id(3));
    f.serverPair.otherPair = true;
    await f.view.refresh();
    expect(mismatch(f.view)).toBe(true);
    expect(f.view.snapshot()).toMatchObject({ problem: null, canStop: true });
    await f.view.stop();
    expect(f.kinds()).toEqual(["session.stop"]);
  });
  it("LSR4: a start confirmed in this pair is the ordinary session: Stop as always", async () => {
    const f = harness(); await f.view.refresh(); await f.view.start();
    expect(f.view.snapshot()).toMatchObject({ phase: "preview", canStop: true });
  });
  it("LSR5: the window got the new pair (a new handle, a new owner of uk-de): the session is its own, Stop as before", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true;
    await f.view.start();
    const started = f.posts()[0].session_id;
    expect(f.view.snapshot().canStop).toBe(false);
    f.replace({ profile: { ...profile(), dictionary_language: "uk" }, session: { id: started, phase: "active" } });
    expect(f.view.snapshot().phase).toBe("disposed");
    const owner = f.owner(started);
    await owner.refresh();
    expect(owner.snapshot()).toMatchObject({ problem: null, canStop: true, phase: "preview" });
    await owner.stop();
    expect(f.kinds()).toEqual(["session.start", "session.stop"]);
    expect(f.posts()[1]).toMatchObject({ kind: "session.stop", session_id: started });
  });
  it("LSR6: no published state of the R1 session offers Stop: from the confirmed start through a check", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true;
    const mark = f.onUpdate.mock.calls.length;
    await f.view.start();
    await f.view.refresh();
    const published = f.onUpdate.mock.calls.slice(mark).map(call => call[0] as ReturnType<LearningViewController["snapshot"]>);
    const confirmed = published.filter(update => update.commands.primary.outcome === "accepted"
      && update.commands.primary.resolved?.kind === "session.start");
    expect(confirmed.length).toBeGreaterThan(1);
    expect(confirmed.filter(update => update.canStop)).toEqual([]);
    // Before the confirmation (the start in flight) Stop keeps its existing rule; nothing was sent but the start.
    expect(f.kinds()).toEqual(["session.start"]);
  });
});
