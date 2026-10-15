import { describe, expect, it, vi } from "vitest";
import { id } from "../learning/learningFixtures.test-support";
import { createFeedbackApi } from "./feedbackApi";
import { FeedbackController } from "./feedbackController";
import { memoryFeedbackPendingStore } from "./feedbackPending";
import { feedbackWorld, slot, TEXT } from "./feedbackFixtures.test-support";
import { testGate } from "../commands/testGate.test-support";

const CARD = "00000000-0000-4000-8000-000000000901";

function complaint(world = feedbackWorld(), store = memoryFeedbackPendingStore(), cardId = CARD.toUpperCase()) {
  let next = 100;
  const controller = new FeedbackController({ api: createFeedbackApi({ fetcher: world.f.fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() }),
    pendingStore: store, cardId, access: () => world.f.access(), newId: () => id(next++), onUpdate: vi.fn() });
  return { world, controller, store };
}

describe("«Что не так?»: the complaint attaches its card (К07-051, К07-052)", () => {
  it("F1 sends feedback.send with card_id and confirms only by the inbox record of that card", async () => {
    const { world, controller } = complaint();
    await controller.refresh();
    controller.edit(TEXT);
    await controller.send();
    expect(world.posts).toEqual([expect.objectContaining({ kind: "feedback.send", payload: { text: TEXT, card_id: CARD } })]);
    expect(controller.snapshot()).toMatchObject({ confirmed: true, text: "" });
  });

  it("F2 a failure keeps the text and retries the same command; nothing reaches the application storage (Р7)", async () => {
    const { world, controller } = complaint(feedbackWorld(["lose-before"]));
    await controller.refresh();
    controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", text: TEXT, confirmed: false, canRetry: true });
    expect(world.f.values.has(slot)).toBe(false);
    await controller.retry();
    expect(world.gets).toEqual([id(100)]);
    expect(world.posts.map(post => post.command_id)).toEqual([id(100), id(100)]);
    expect(controller.snapshot()).toMatchObject({ confirmed: true, text: "" });
  });

  it("F3 a refusal keeps the text in the field; the next send is a new command", async () => {
    const { world, controller } = complaint(feedbackWorld(["409"]));
    await controller.refresh();
    controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ phase: "idle", text: TEXT, refusal: { code: "COMMAND_PAYLOAD_MISMATCH" }, canSend: true });
    await controller.send();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100), id(101)]);
  });

  it("F4 the memory slot is per card host: a new store does not see an earlier complaint", async () => {
    const store = memoryFeedbackPendingStore();
    const first = complaint(feedbackWorld(["lose-before"]), store);
    await first.controller.refresh();
    first.controller.edit(TEXT);
    await first.controller.send();
    expect(await store.load(id(50), new AbortController().signal)).not.toBeNull();
    expect(await memoryFeedbackPendingStore().load(id(50), new AbortController().signal)).toBeNull();
  });
});
