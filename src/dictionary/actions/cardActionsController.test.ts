import { describe, expect, it, vi } from "vitest";
import { createCardActionApi } from "./cardActionApi";
import { CardActionsController, type CardActionApplied, type CardActionsCard } from "./cardActionsController";
import { aid, CARD, cardActionServer, origin, rights, type Fate } from "./actionTestData.test-support";
import { readWithTicket, testGate } from "../../commands/testGate.test-support";

function setup(fates: Fate[] = [], live = { current: true }) {
  const server = cardActionServer(fates);
  const api = createCardActionApi({ fetcher: server.fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
  const applied = vi.fn<(event: CardActionApplied) => void>();
  const refused = vi.fn<(code: string) => void>();
  let next = 100;
  const controller = new CardActionsController({ gate: testGate(),
    port: { origin: () => live.current ? origin : null, send: command => api.send("token", "proof", command),
      status: command => readWithTicket(command, (__command, __ticket) => api.status("token", "proof", __command, __ticket)) },
    newId: () => aid(next++), onUpdate: () => {}, onApplied: applied, onRefused: refused });
  const show = (change: Partial<CardActionsCard> = {}) => controller.setCard({ cardId: CARD, stateVersion: String(server.state.stateVersion),
    exclusionVersion: server.state.version, actions: rights(server.state.excluded), ...change });
  show();
  return { server, controller, applied, refused, show };
}

describe("card study actions (TA:153, К07-068…087)", () => {
  it("C1 exclude sends the shown exclusion version; the transition follows only the accepted fact", async () => {
    const { server, controller, applied, show } = setup();
    expect(controller.snapshot().offered).toEqual({ exclude: true, return: false, relearn: true });
    await controller.exclude();
    expect(server.posts[0]).toMatchObject({ kind: "card.exclude", expected_card_state_version: null, payload: { card_id: CARD } });
    expect(applied).toHaveBeenCalledWith({ kind: "card.exclude", cardId: CARD, stateVersion: "11" });
    // The spent hint is not offered again until a card read at least as new as the reply.
    expect(controller.snapshot()).toMatchObject({ status: "applied", offered: { exclude: false, return: false, relearn: false } });
    show();
    expect(controller.snapshot().offered).toEqual({ exclude: false, return: true, relearn: false });
    await controller.restore();
    expect(server.posts[1]).toMatchObject({ kind: "card.return", expected_card_state_version: "1" });
    expect(applied).toHaveBeenLastCalledWith({ kind: "card.return", cardId: CARD, stateVersion: "12" });
  });

  it("C2 relearn needs its own confirmation; a cancel sends nothing (К07-077, К07-082)", async () => {
    const { server, controller, applied } = setup();
    controller.askRelearn();
    expect(controller.snapshot()).toMatchObject({ confirming: true, offered: { exclude: false, relearn: false } });
    controller.cancelRelearn();
    expect(controller.snapshot().confirming).toBe(false);
    expect(server.posts).toHaveLength(0);
    await controller.confirmRelearn();
    expect(server.posts).toHaveLength(0);
    controller.askRelearn();
    await controller.confirmRelearn();
    expect(server.posts).toEqual([expect.objectContaining({ kind: "card.relearn", payload: { card_id: CARD, confirmed: true } })]);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ kind: "card.relearn" }));
  });

  it("C3 a refusal changes nothing on the client and asks for a new read; the next tap is a new command", async () => {
    const { server, controller, applied, refused } = setup(["conflict"]);
    await controller.exclude();
    expect(controller.snapshot()).toMatchObject({ status: "refused", problem: { reason: "refused", code: "VERSION_CONFLICT" },
      offered: { exclude: true } });
    expect(refused).toHaveBeenCalledWith("VERSION_CONFLICT");
    expect(applied).not.toHaveBeenCalled();
    await controller.exclude();
    expect(server.posts.map(post => post.command_id)).toEqual([aid(100), aid(101)]);
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("C4 a lost reply is checked once by the same ID and never becomes a new command (К07-075, CON:149)", async () => {
    const { server, controller, applied } = setup(["lose-after"]);
    await controller.exclude();
    // Applied on the server; the automatic status check found it.
    expect(server.gets).toHaveLength(1);
    expect(server.gets[0]).toContain(`/commands/${aid(100)}?`);
    expect(applied).toHaveBeenCalledTimes(1);
    expect(server.posts).toHaveLength(1);
    expect(server.state.version).toBe("1");
  });

  it("C5 «Повторить» after an unresolved check: status first, then exactly the same command", async () => {
    const { server, controller, applied } = setup(["lose-before"]);
    server.state.statusFailures = 1;
    await controller.exclude();
    expect(controller.snapshot()).toMatchObject({ status: "unknown", canRetry: true, offered: { exclude: false, relearn: false } });
    // While the outcome is unknown no other action may start (Р2).
    await controller.restore(); controller.askRelearn();
    expect(server.posts).toHaveLength(1);
    expect(controller.snapshot().confirming).toBe(false);
    await controller.retry();
    expect(server.gets).toHaveLength(2);
    expect(server.posts).toHaveLength(2);
    expect(server.posts[1]).toEqual(server.posts[0]);
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("C6 a repeat of an applied command does not apply it twice (already_applied)", async () => {
    const { server, controller, applied } = setup(["lose-after"]);
    server.state.statusFailures = 1;
    await controller.exclude();
    expect(controller.snapshot().status).toBe("unknown");
    await controller.retry();
    // The status check finds the fact: no second POST, one flag change.
    expect(server.posts).toHaveLength(1);
    expect(server.state.version).toBe("1");
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it("C7 a server error and a foreign reply stay unknown; a mismatch on status forbids repeating that ID", async () => {
    const { server, controller } = setup(["500"]);
    server.state.statusFailures = 1;
    await controller.exclude();
    expect(controller.snapshot().status).toBe("unknown");
    server.fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }), { status: 409 }));
    await controller.retry();
    expect(controller.snapshot()).toMatchObject({ status: "refused", problem: { reason: "mismatch" }, canRetry: false });
    expect(server.posts).toHaveLength(1);
  });

  it("C8 without a live document nothing is sent and the outcome stays checkable", async () => {
    const live = { current: false };
    const { server, controller } = setup([], live);
    await controller.exclude();
    expect(server.posts).toHaveLength(0);
    expect(controller.snapshot().status).toBe("unknown");
    live.current = true;
    await controller.resume();
    expect(server.gets).toHaveLength(1);
    await controller.retry();
    expect(server.posts).toHaveLength(1);
    expect(controller.snapshot().status).toBe("applied");
  });

  it("C9 an older read adds nothing; another card starts over; dispose stops everything", async () => {
    const { controller, show } = setup();
    show({ stateVersion: "12" });
    show({ stateVersion: "9", actions: { exclude: false, return: true, relearn: false } });
    expect(controller.snapshot().offered.exclude).toBe(true);
    controller.askRelearn();
    controller.setCard({ cardId: aid(902), stateVersion: "12", exclusionVersion: "2", actions: rights(true) });
    expect(controller.snapshot()).toMatchObject({ confirming: false, offered: { return: true } });
    controller.dispose();
    expect(controller.snapshot()).toMatchObject({ disposed: true, offered: { exclude: false, return: false, relearn: false } });
  });
});
