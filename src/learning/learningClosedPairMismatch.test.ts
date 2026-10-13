// N1 of guard_v3 on F3 (C193): the published pair mismatch of an own session this view shows closed, Learning. The R1 session S (17.1-А/17.2-А) is stopped
// on another device through the synthetic core's own session.stop (its version goes up), then this window reads it.
// C193: the closed own S publishes no "open in another pair" fact, and acceptedForeignStart gives null for it. The
// harness is the one of learningStopR1.test.ts (F3); the unchanged F3 fixtures are used.
import { afterEach, describe, expect, it } from "vitest";
import { acceptedForeignStart } from "../commands/foreignStart";
import { LearningViewController } from "./learningViewController";
import { id, response } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); });

function harness() {
  const f = learningViewFixture("normal", null); owners.push(f.view);
  const server = { otherPair: false };
  f.fetcher.mockImplementation(async (url, init) => {
    const reply = await f.handler(url, init);
    if (!server.otherPair || !/\/commands|\/sessions\//.test(String(url))) return reply;
    const raw = (await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
    return response(JSON.parse(raw), reply.status);
  });
  /** Another device stops S: the same synthetic core applies it; this window sends nothing. */
  const stopElsewhere = (sessionId: string) => f.handler("http://localhost/api/v1/commands", { method: "POST", body: JSON.stringify({
    client_instance_id: id(90), document_id: id(91), command_id: id(92), kind: "session.stop", session_id: sessionId,
    payload: { reason: "stop" } }) });
  return { ...f, serverPair: server, stopElsewhere, kinds: () => f.posts().map(post => post.kind) };
}
const foreign = (view: LearningViewController) => acceptedForeignStart(view.snapshot().commands.primary, view.snapshot());

describe("a closed own session publishes no pair mismatch, Learning (N1, C193)", () => {
  it("L1 (17.1-А, control): the open R1 session is published as a mismatch and as this owner's foreign start", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true;
    await f.view.start();
    const started = f.posts()[0].session_id;
    expect(f.view.snapshot()).toMatchObject({ canStop: false, pairMismatch: started });
    expect(foreign(f.view)).toBe(started.toLowerCase());
  });
  it("L2 (C193): after S is stopped elsewhere and read above the floor, nothing names it open in another pair", async () => {
    const f = harness(); await f.view.refresh();
    f.serverPair.otherPair = true;
    await f.view.start();
    const started = f.posts()[0].session_id, floor = f.view.snapshot().commands.stateVersion;
    await f.stopElsewhere(started);
    await f.view.refresh();
    const after = f.view.snapshot();
    expect(BigInt(after.commands.stateVersion)).toBeGreaterThan(BigInt(floor));
    expect(after).toMatchObject({ phase: "closed", sessionId: started, closed: { sessionId: started, reason: "stop" }, canStop: false });
    expect(f.kinds()).toEqual(["session.start"]);
    // The published field and what the hosts derive from it.
    expect(after.pairMismatch).toBeNull();
    expect(foreign(f.view)).toBeNull();
  });
});
