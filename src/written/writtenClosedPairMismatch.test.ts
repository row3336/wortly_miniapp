// N1 of guard_v3 on F3 (C193): the published pair mismatch of an own session this view shows closed. The R1 session S (17.1-А/17.2-А: this owner's start
// confirmed, S open in another pair) is then closed elsewhere and read at a version above the floor. C193: the closed
// own S publishes no "open in another pair" fact, and acceptedForeignStart gives null for it. The harness is the one of
// writtenStopR1.test.ts (F3, SR6 trace); the unchanged F3 fixture is used.
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptedForeignStart } from "../commands/foreignStart";
import { WrittenViewController } from "./writtenViewController";
import { response, writtenFixture } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); });

function harness() {
  const f = writtenFixture({ cards: [6, 7] });
  const server = { otherPair: false };
  f.fetcher.mockImplementation(async (url, init) => {
    const reply = await f.server.handle(url, init);
    if (!server.otherPair || !/\/commands|\/sessions\//.test(String(url))) return reply;
    const raw = (await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
    return response(JSON.parse(raw), reply.status);
  });
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
    sessionId: null, transitionMode: () => "normal", onUpdate: () => {} });
  owners.push(view);
  return { ...f, view, serverPair: server, kinds: () => f.posts().map(post => post.kind) };
}
const foreign = (view: WrittenViewController) => acceptedForeignStart(view.snapshot().commands.primary, view.snapshot());

describe("a closed own session publishes no pair mismatch, written (N1, C193)", () => {
  it("W1 (17.1-А, control): the open R1 session is published as a mismatch and as this owner's foreign start", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    await h.view.start("words");
    const started = h.posts()[0].session_id;
    expect(h.view.snapshot()).toMatchObject({ canStop: false, pairMismatch: started });
    expect(foreign(h.view)).toBe(started.toLowerCase());
  });
  it("W2 (C193): after S is closed elsewhere and read above the floor, nothing names it open in another pair", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    await h.view.start("words");
    const started = h.posts()[0].session_id, floor = h.view.snapshot().commands.stateVersion;
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).not.toBe("reading"));
    const after = h.view.snapshot();
    // The closure itself is the existing F3 behaviour (SR6); the read was above the floor it started from.
    expect(BigInt(after.commands.stateVersion)).toBeGreaterThan(BigInt(floor));
    expect(after).toMatchObject({ phase: "closed", sessionId: started, closed: { reason: "remote_stop" }, canStop: false });
    expect(h.kinds()).toEqual(["session.start"]);
    // The published field and what the hosts derive from it.
    expect(after.pairMismatch).toBeNull();
    expect(foreign(h.view)).toBeNull();
  });
});
