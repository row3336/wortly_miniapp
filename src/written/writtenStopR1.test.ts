// Owner answer 888·17.2-А: only the R1 session (this owner's start confirmed, the session shown open in another pair,
// the window without that pair yet) has no Stop. Every other case keeps the rights it had (C129).
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { profile, response, writtenFixture } from "./writtenFixtures.test-support";
import type { WrittenViewSnapshot } from "./writtenViewController";
import { hasPending } from "../commands/pendingSeed.test-support";

const owners: WrittenViewController[] = [];
const mismatch = (view: { snapshot(): { pairMismatch: string | null } }) => view.snapshot().pairMismatch !== null;
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

/** The server's pair can move to uk on another device; this window still holds ru until its access is replaced. */
function harness(options: { active?: boolean; sessionId?: string | null } = {}) {
  const f = writtenFixture({ cards: [6, 7], active: options.active });
  const server = { otherPair: false, lose: false, checksDown: false, offline: false };
  f.fetcher.mockImplementation(async (url, init) => {
    if (server.offline || server.checksDown && init?.method === "GET" && String(url).includes("/commands/")) throw new TypeError("network");
    const reply = await f.server.handle(url, init);
    if (init?.method === "POST" && server.lose) { server.lose = false; throw new TypeError("network"); }
    if (!server.otherPair || !/\/commands|\/sessions\//.test(String(url))) return reply;
    const raw = (await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"');
    return response(JSON.parse(raw), reply.status);
  });
  const updates: WrittenViewSnapshot[] = [];
  const owner = (sessionId: string | null) => {
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId, transitionMode: () => "normal", onUpdate: snapshot => { updates.push(snapshot); } });
    owners.push(view); return view;
  };
  const kinds = () => f.posts().map(post => post.kind);
  return { ...f, view: owner(options.sessionId ?? null), owner, kinds, updates, serverPair: server };
}

describe("17.2-А: the R1 Stop gate", () => {
  it("SR1: a lost start reply is no confirmed R1 session: Stop is offered until the check by ID confirms it", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true; h.serverPair.lose = true;
    await h.view.start("words");
    expect(h.view.snapshot()).toMatchObject({ canStop: true, commands: { primary: { pending: true, outcome: null } } });
    await h.view.refresh();
    expect(h.view.snapshot()).toMatchObject({ canStop: false, commands: { primary: { outcome: "accepted" } } });
    await h.view.stop();
    expect(h.kinds()).toEqual(["session.start"]);
  });
  it("SR2: an unknown start keeps its Stop: the record of a lost start is stopped as before", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true; h.serverPair.lose = true;
    await h.view.start("words");
    const started = h.posts()[0].session_id;
    await h.view.stop();
    expect(h.kinds()).toEqual(["session.start", "session.stop"]);
    expect(h.posts()[1]).toMatchObject({ kind: "session.stop", session_id: started });
  });
  it("SR3: a session this view took in its own pair keeps Stop when the server later shows it in another pair", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    h.serverPair.otherPair = true;
    await h.view.refresh();
    expect(h.view.snapshot().canStop).toBe(true);
    await h.view.stop();
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "session.stop"]);
  });
  it("SR4: a session this owner did not start (a resumed one) shown in another pair keeps Stop", async () => {
    const h = harness({ active: true, sessionId: "00000000-0000-4000-8000-000000000003" });
    h.serverPair.otherPair = true;
    await h.view.refresh();
    expect(mismatch(h.view)).toBe(true);
    expect(h.view.snapshot()).toMatchObject({ problem: null, canStop: true });
    await h.view.stop();
    expect(h.kinds()).toEqual(["session.stop"]);
  });
  it("SR5: a start confirmed in this pair is the ordinary session: Stop as always", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    expect(h.view.snapshot()).toMatchObject({ phase: "question", canStop: true });
  });
  it("SR6: a later closure shows its summary; leaving it is local, no Stop is sent", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    await h.view.start("words");
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    await h.view.refresh();
    await vi.waitFor(() => expect(h.view.snapshot().closed?.summaryRead).not.toBe("reading"));
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", canStop: false, canStart: true, closed: { reason: "remote_stop" } });
    expect(h.kinds()).toEqual(["session.start"]);
  });
  it("SR7: the window got the new pair (a new handle, a new owner of uk-de): the session is its own, Stop as before", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    await h.view.start("words");
    const started = h.posts()[0].session_id;
    expect(h.view.snapshot().canStop).toBe(false);
    // The point where the window gets the pair: a new open handle of uk; the old owner dies with its handle.
    h.replace({ profile: { ...profile(), dictionary_language: "uk" } });
    expect(h.view.snapshot().phase).toBe("disposed");
    const owner = h.owner(started);
    await owner.refresh();
    expect(owner.snapshot()).toMatchObject({ problem: null, canStop: true });
    await owner.stop();
    // The new owner shows the session (its one present) and stops exactly that session.
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "session.stop"]);
    expect(h.posts()[2]).toMatchObject({ kind: "session.stop", session_id: started });
  });
  it("SR8: an accepted command of another kind (an answer recovered by a new owner) is no start: Stop stays", async () => {
    const h = harness(); await h.view.refresh(); await h.view.start("words");
    // The answer commits, its reply is lost and no check reaches the server: its record waits for the next owner.
    h.serverPair.lose = true; h.serverPair.checksDown = true;
    h.view.setDraft("Haus"); await h.view.submit();
    await vi.waitFor(() => expect(hasPending(h.values, "wortly.pending.written_session")).toBe(true));
    h.view.dispose();
    h.serverPair.checksDown = false; h.serverPair.otherPair = true;
    const owner = h.owner(null);
    await owner.refresh();
    expect(mismatch(owner)).toBe(true);
    expect(owner.snapshot()).toMatchObject({ problem: null,
      commands: { primary: { outcome: "accepted", resolved: { kind: "answer.submit" } } } });
    expect(owner.snapshot().canStop).toBe(true);
  });
  it("SR9: a start still unknown (its check failed) keeps Stop even when a read shows the session in another pair", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true; h.serverPair.lose = true;
    await h.view.start("words");
    h.serverPair.checksDown = true;
    await h.view.refresh();
    // The failed check stays a failed update (its own problem); the read proved the mismatch.
    expect(mismatch(h.view)).toBe(true);
    expect(h.view.snapshot()).toMatchObject({ problem: "network", commands: { primary: { pending: true, outcome: null } } });
    expect(h.view.snapshot().canStop).toBe(true);
  });
  it("SR10: no published state of the R1 session ever offers Stop, not even for one update", async () => {
    const h = harness(); await h.view.refresh();
    h.serverPair.otherPair = true;
    const mark = h.updates.length;
    await h.view.start("words");
    await h.view.refresh();
    const confirmed = h.updates.slice(mark).filter(update => update.commands.primary.outcome === "accepted"
      && update.commands.primary.resolved?.kind === "session.start");
    expect(confirmed.length).toBeGreaterThan(1);
    expect(confirmed.filter(update => update.canStop || update.canSummaryHome)).toEqual([]);
  });
});
