// M-LANE-PAIR-GUARD (C108): a session the server applied in another pair (R1, and the P7 result source) in the written view.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { deferred, profile, response, writtenFixture } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
/** The published fact that the server proved the session open in another pair (C151), never the shown problem. */
const mismatch = (view: { snapshot(): { pairMismatch: string | null } }) => view.snapshot().pairMismatch !== null;
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

/**
 * The server's pair moved to uk on another device; this window still holds ru (no re-open), so the session the server
 * keeps or creates is projected in uk-de. lose: the next POST commits, its reply is lost.
 */
function harness() {
  const f = writtenFixture({ cards: [6, 7] });
  const server = { otherPair: false, lose: false };
  f.fetcher.mockImplementation(async (url, init) => {
    const reply = await f.server.handle(url, init);
    if (init?.method === "POST" && server.lose) { server.lose = false; throw new TypeError("network"); }
    if (!server.otherPair || !/\/commands|\/sessions\//.test(String(url))) return reply;
    // The prompt language follows the pair (the wire validator holds them together): a real uk-de projection.
    const raw = (await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
    return response(JSON.parse(raw), reply.status);
  });
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
    sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
  owners.push(view);
  const kinds = () => f.posts().map(post => post.kind);
  return { ...f, view, kinds, serverPair: server };
}

describe("R1: the window of the old pair starts a session the server creates in the new pair", () => {
  it("G1: a direct reply keeps the started session as applied; nothing of it is shown or answered", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    await h.view.start("words");
    expect(h.kinds()).toEqual(["session.start"]);
    // A known mismatch, not a failed update: no shown problem (C149); the lanes keep their reason.
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", problem: null, question: null, current: null, answer: null,
      canSubmit: false, canStart: false,
      commands: { primary: { outcome: "accepted", pending: false, problem: "pair_changed", resolved: { kind: "session.start" } } } });
    // «Проверить состояние»: the read shows the same session open in uk-de; still nothing of it and no POST.
    const reads = h.gets("/sessions/").length;
    await h.view.refresh();
    expect(h.gets("/sessions/").length).toBe(reads + 1);
    expect(h.kinds()).toEqual(["session.start"]);
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", problem: null, question: null,
      commands: { primary: { outcome: "accepted", problem: null } } });
    expect(mismatch(h.view)).toBe(true);
  });
  it("G2: a lost reply keeps Stop as before until the check by ID proves the other pair; the fact stays applied", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true; h.serverPair.lose = true;
    await h.view.start("words");
    // Nothing proves another pair yet: an unknown start keeps its existing Stop.
    expect(h.view.snapshot()).toMatchObject({ commands: { primary: { pending: true, outcome: null } }, canStop: true });
    await h.view.refresh();
    expect(h.gets("/commands/")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", problem: null, question: null,
      commands: { primary: { outcome: "accepted", pending: false } } });
    expect(mismatch(h.view)).toBe(true);
    expect(h.values.has("wortly.pending.written_session")).toBe(false);
    expect(h.kinds()).toEqual(["session.start"]);
  });
  it("G3: a closure of that session proven later closes the view with its reason; its own facts are not lost", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    await h.view.start("words");
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", canStop: false, closed: { reason: "remote_stop" } });
    expect(h.kinds()).toEqual(["session.start"]);
  });
});

describe("Stop of that session from the window of the old pair (owner answer 888·17.2-А)", () => {
  it("G7: Stop is not offered for the R1 session and sends nothing; a check does not restore it", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    await h.view.start("words");
    expect(h.view.snapshot()).toMatchObject({ canStop: false, canSummaryHome: false });
    await h.view.stop();
    expect(h.kinds()).toEqual(["session.start"]);
    await h.view.refresh();
    expect(h.view.snapshot().canStop).toBe(false);
  });
});

describe("P7 source (a): an accepted answer whose step names another pair", () => {
  it("G5: its result is not shown; the session this view took in its own pair keeps its Stop", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    expect(h.view.snapshot()).toMatchObject({ phase: "question", canStop: true });
    // Synthetic (impossible on the real core, where the session closes with pair_changed): the server projects the
    // same session open in uk-de, and the answer's reply is lost.
    h.serverPair.otherPair = true; h.serverPair.lose = true;
    h.view.setDraft("Haus"); await h.view.submit();
    await vi.waitFor(() => expect(h.gets("result_id=")).toHaveLength(1));
    await vi.waitFor(() => expect(h.view.snapshot().phase).toBe("stale"));
    expect(mismatch(h.view)).toBe(true);
    expect(h.view.snapshot()).toMatchObject({ phase: "stale", problem: null, answer: null, canNext: false,
      commands: { primary: { outcome: "accepted", resolved: { kind: "answer.submit" } } } });
    expect(h.view.snapshot().canStop).toBe(true);
    expect(h.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
  });
});

describe("an old reply formed before the change, delivered after it (C108)", () => {
  it("G6: a session GET of the replaced owner, delivered after re-open in the new pair, changes neither owner", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    const handle = h.fetcher.getMockImplementation()!, gate = deferred<void>();
    h.fetcher.mockImplementationOnce(async (url, init) => { const early = await handle(url, init); await gate.promise; return early; });
    const reading = h.view.refresh();
    await vi.waitFor(() => expect(h.gets("/sessions/").length).toBeGreaterThan(0));
    // The pair changed elsewhere; the server closed the old session; this document re-opens in uk.
    Object.assign(h.server.state, { status: "closed", closeReason: "pair_changed", assignment: null, version: h.server.state.version + 1 });
    h.view.dispose(); h.replace({ profile: { ...profile(), dictionary_language: "uk" } });
    const owner = new WrittenViewController({ access: h.access, storage: h.storage, transport: h.transport, newId: h.newId,
      sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(owner); await owner.refresh();
    const before = owner.snapshot();
    gate.resolve(); await reading.catch(() => undefined);
    expect(h.view.snapshot()).toMatchObject({ phase: "disposed", question: null, closed: null });
    expect(owner.snapshot()).toEqual(before);
    expect(owner.snapshot()).toMatchObject({ phase: "idle", problem: null, canStop: false });
  });
});
