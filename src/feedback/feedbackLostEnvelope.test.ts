import { afterEach, describe, expect, it, vi } from "vitest";
import { id, profile } from "../learning/learningFixtures.test-support";
import type { AsyncStorage } from "../platform/storage";
import { PAYLOAD_PREFIX } from "../commands/pendingSlot";
import { dropForeignPayloads } from "../profile/profileWipe";
import { testGate } from "../commands/testGate.test-support";
import { feedbackWorld, makeController, pendingRecord, seedFeedback, slot, TEXT, type FeedbackWorld } from "./feedbackFixtures.test-support";

/**
 * Q27 for a message (C458 п.4–5): the pointer of a sent message is there, its text was deleted on this device by Е02.
 * Only the status of the stored command_id is read (by its stored profile and card); nothing is sent, no new ID, no
 * new payload; not_found gives no right to a new message.
 */
afterEach(() => { vi.restoreAllMocks(); });

const payloadKeys = (world: FeedbackWorld) => [...world.f.values.keys()].filter(key => key.startsWith(PAYLOAD_PREFIX));
/** Е02 on this device: another profile id(51) is admitted, the payloads of every other profile go. */
async function admitOther(world: FeedbackWorld): Promise<void> {
  const listed: AsyncStorage = { ...world.f.storage, async keys(prefix) { return [...world.f.values.keys()].filter(key => key.startsWith(prefix)); } };
  expect(await dropForeignPayloads(listed, id(51))).toMatchObject({ failed: 0 });
}
/** A complaint of profile id(50) sent as id(300) (maybe recorded by the server), then its text deleted by Е02. */
async function lostWorld(recorded: boolean, cardId?: string): Promise<FeedbackWorld> {
  const world = feedbackWorld();
  const record = JSON.parse(pendingRecord(id(300)));
  if (cardId) record.intent.payload.card_id = cardId;
  seedFeedback(world.f.values, JSON.stringify(record));
  if (recorded) world.facts.set(id(300), { text: TEXT, card_id: cardId ?? null, inbox: id(901) });
  expect(payloadKeys(world)).toHaveLength(1);
  await admitOther(world);
  expect(payloadKeys(world)).toEqual([]);
  expect(world.f.values.has(slot)).toBe(true); // the service IDs stay
  return world;
}
async function opened(world: FeedbackWorld, cardId?: string) {
  const made = makeController(world, undefined, cardId);
  await made.controller.refresh();
  return made;
}

describe("Q27 feedback: a pointer without its payload is read back by its own ID only", () => {
  it("recorded: GET of exactly the old ID, confirmed, the pointer removed after that proof; 0 POST, 0 new ID or payload", async () => {
    const world = await lostWorld(true);
    const { controller } = await opened(world);
    expect(world.gets).toEqual([id(300)]);
    expect(world.posts).toHaveLength(0);
    expect(controller.snapshot()).toMatchObject({ phase: "idle", confirmed: true, text: "", problem: null });
    expect(world.f.values.has(slot)).toBe(false);
    expect(payloadKeys(world)).toEqual([]);
    // The next message is a new command; the ID counter was not used by the readback.
    controller.edit("Noch eins"); await controller.send();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100)]);
  });

  it("not_found: stays closed — no resend, no new message, no field; «Проверить снова» reads the same ID again", async () => {
    const world = await lostWorld(false);
    const { controller } = await opened(world);
    expect(world.gets).toEqual([id(300)]);
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "lost_envelope", text: "", confirmed: false,
      canEdit: false, canSend: false, canRetry: true });
    controller.edit(TEXT); await controller.send();
    await controller.retry();
    expect(world.gets).toEqual([id(300), id(300)]);
    expect(world.posts).toHaveLength(0);
    expect(controller.snapshot()).toMatchObject({ problem: "lost_envelope", text: "", canSend: false });
    expect(world.f.values.has(slot)).toBe(true); // not_found is no proof: the pointer stays
    expect(payloadKeys(world)).toEqual([]); // the payload is never recreated
  });

  it("unavailable (a lost reply): unknown, no resend; a later check that finds it recorded confirms", async () => {
    const world = await lostWorld(true);
    world.state.statusFailures = 1;
    const { controller } = await opened(world);
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "lost_envelope", canRetry: true, canSend: false });
    expect(world.f.values.has(slot)).toBe(true);
    await controller.retry();
    expect(world.gets).toEqual([id(300), id(300)]);
    expect(world.posts).toHaveLength(0);
    expect(controller.snapshot()).toMatchObject({ phase: "idle", confirmed: true });
    expect(world.f.values.has(slot)).toBe(false);
  });

  it("a reload: the next controller reads the same ID again and sends nothing", async () => {
    const world = await lostWorld(false);
    const first = await opened(world);
    first.controller.dispose();
    const second = await opened(world);
    expect(world.gets).toEqual([id(300), id(300)]);
    expect(world.posts).toHaveLength(0);
    expect(second.controller.snapshot()).toMatchObject({ problem: "lost_envelope", canSend: false });
  });

  it("a complaint: read by its stored card_id; a fact of another card is no proof", async () => {
    const world = await lostWorld(true, id(7));
    const { controller } = await opened(world, id(8)); // opened from another card: the stored card decides
    expect(controller.snapshot()).toMatchObject({ confirmed: true });
    const other = await lostWorld(true, id(7));
    other.facts.set(id(300), { text: TEXT, card_id: id(9), inbox: id(901) });
    const made = await opened(other);
    expect(made.controller.snapshot()).toMatchObject({ problem: "lost_envelope", confirmed: false });
    expect(other.f.values.has(slot)).toBe(true);
  });

  it("a not_found whose current profile is another one is no answer (strict checks of status)", async () => {
    const world = await lostWorld(false);
    const base = world.f.fetcher.getMockImplementation()!;
    world.f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).includes("/commands/")) {
        world.gets.push(String(url).split("/commands/")[1]!);
        return new Response(JSON.stringify({ command: { id: id(300), status: "not_found" },
          current: { ...profile("5"), profile_id: id(51) }, state_version: "5" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return base(url, init);
    });
    const { controller } = await opened(world);
    expect(world.gets).toEqual([id(300)]);
    expect(controller.snapshot()).toMatchObject({ problem: "lost_envelope", canSend: false });
    expect(world.posts).toHaveLength(0);
  });

  it("another profile on the page: no readback and no POST for the lost message of id(50); its pointer stays", async () => {
    const world = await lostWorld(true);
    const { controller } = makeController(world);
    world.f.replace({ profile: { ...profile(), profile_id: id(51) } });
    await controller.refresh();
    expect(world.gets).toHaveLength(0); expect(world.posts).toHaveLength(0);
    expect(controller.snapshot().phase).toBe("disposed");
    // The form of id(51) knows nothing of it.
    const theirs = await opened(world);
    expect(theirs.controller.snapshot()).toMatchObject({ phase: "idle", text: "", problem: null });
    expect(world.gets).toHaveLength(0);
    expect(world.f.values.has(slot)).toBe(true);
  });

  it("another profile signs in while the gate issues the ticket: the read runs on no access, nothing is read", async () => {
    const world = await lostWorld(true);
    const gate = testGate();
    const original = gate.runReadback.bind(gate);
    vi.spyOn(gate, "runReadback").mockImplementation(((commandId: string, read: never) => {
      world.f.replace({ profile: { ...profile(), profile_id: id(51) } }); // between the check and the read
      return original(commandId, read);
    }) as typeof gate.runReadback);
    const { controller } = makeController(world);
    await controller.refresh();
    expect(world.gets).toHaveLength(0); expect(world.posts).toHaveLength(0);
    expect(world.f.values.has(slot)).toBe(true);
    expect(controller.snapshot().phase).toBe("disposed");
  });

  it("a replaced document handle: the old form reads nothing", async () => {
    const world = await lostWorld(true);
    const { controller } = makeController(world);
    world.f.replace({ document_id: id(9) });
    await controller.refresh();
    expect(world.gets).toHaveLength(0); expect(world.posts).toHaveLength(0);
    expect(world.f.values.has(slot)).toBe(true);
  });

  it("a message sent while another window's message of this profile became lost: nothing stored or sent, the old ID is read", async () => {
    const world = feedbackWorld();
    const { controller } = await opened(world);
    seedFeedback(world.f.values, pendingRecord(id(300)));
    await admitOther(world);
    controller.edit(TEXT); await controller.send();
    expect(world.posts).toHaveLength(0);
    expect(controller.snapshot()).toMatchObject({ problem: "lost_envelope", text: TEXT, canSend: false, canEdit: false, canRetry: true });
    expect(payloadKeys(world)).toEqual([]);
    await controller.retry();
    expect(world.gets).toEqual([id(300)]); expect(world.posts).toHaveLength(0);
  });

  it("the normal path with its payload is unchanged: a recorded message is confirmed by its stored text", async () => {
    const world = feedbackWorld(); world.facts.set(id(300), { text: TEXT, card_id: null, inbox: id(901) });
    seedFeedback(world.f.values, pendingRecord(id(300)));
    expect(payloadKeys(world)).toHaveLength(1);
    const { controller } = await opened(world);
    expect(controller.snapshot()).toMatchObject({ confirmed: true });
    expect(world.f.values.has(slot)).toBe(false); expect(payloadKeys(world)).toEqual([]);
  });
});
