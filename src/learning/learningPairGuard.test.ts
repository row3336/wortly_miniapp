// M-LANE-PAIR-GUARD (C108): a Learning session the server applied in another pair (R1) in the Learning view.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningViewController } from "./learningViewController";
import { response } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";

const owners: LearningViewController[] = [];
/** The published fact that the server proved the session open in another pair (C151), never the shown problem. */
const mismatch = (view: { snapshot(): { pairMismatch: string | null } }) => view.snapshot().pairMismatch !== null;
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

/** As the written harness: the server's pair moved to uk elsewhere, this window still holds ru (no re-open). */
function harness() {
  const f = learningViewFixture("normal", null); owners.push(f.view);
  const server = { otherPair: false, lose: false };
  f.fetcher.mockImplementation(async (url, init) => {
    const reply = await f.handler(url, init);
    if (init?.method === "POST" && server.lose) { server.lose = false; throw new TypeError("network"); }
    if (!server.otherPair || !/\/commands|\/sessions\//.test(String(url))) return reply;
    const raw = (await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
    return response(JSON.parse(raw), reply.status);
  });
  const kinds = () => f.posts().map(post => post.kind);
  return { ...f, kinds, serverPair: server };
}

describe("R1 in Learning: the window of the old pair starts a session the server creates in the new pair", () => {
  it("LG1: a direct reply keeps the started session as applied; it shows the reason and no step", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true;
    await f.view.start();
    expect(f.kinds()).toEqual(["session.start"]);
    // A known mismatch, not a failed update: no shown problem (C149); the lanes keep their reason.
    expect(f.view.snapshot()).toMatchObject({ phase: "stale", problem: null, current: null, question: null,
      canAdvancePreview: false, canSubmit: false,
      commands: { primary: { outcome: "accepted", pending: false, problem: "pair_changed", resolved: { kind: "session.start" } } } });
    // «Проверить состояние»: the read shows the session open in uk-de; the reason stays, still no step and no POST.
    await f.view.refresh();
    expect(mismatch(f.view)).toBe(true);
    expect(f.view.snapshot()).toMatchObject({ phase: "stale", problem: null, current: null,
      commands: { primary: { outcome: "accepted", problem: null } } });
    expect(f.kinds()).toEqual(["session.start"]);
  });
  it("LG2: a lost reply keeps Stop as before until the check by ID proves the other pair", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true; f.serverPair.lose = true;
    await f.view.start();
    expect(f.view.snapshot()).toMatchObject({ commands: { primary: { pending: true, outcome: null } }, canStop: true });
    await f.view.refresh();
    expect(f.view.snapshot()).toMatchObject({ phase: "stale", problem: null,
      commands: { primary: { outcome: "accepted", pending: false } } });
    expect(mismatch(f.view)).toBe(true);
    expect(f.kinds()).toEqual(["session.start"]);
  });
  it("LG3: this pair is unchanged: the started session shows its preview and keeps Stop", async () => {
    const f = harness(); await f.view.refresh();
    await f.view.start();
    expect(f.view.snapshot()).toMatchObject({ phase: "preview", problem: null, canStop: true });
  });
});

describe("Learning Stop of that session from the window of the old pair (owner answer 888·17.2-А)", () => {
  it("LG4: Stop is not offered for the R1 session and sends nothing; a check does not restore it", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true;
    await f.view.start();
    expect(f.view.snapshot().canStop).toBe(false);
    await f.view.stop();
    expect(f.kinds()).toEqual(["session.start"]);
    await f.view.refresh();
    expect(f.view.snapshot().canStop).toBe(false);
  });
});
