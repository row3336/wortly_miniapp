import { afterEach, describe, expect, it, vi } from "vitest";
import { id } from "../learning/learningFixtures.test-support";
import { FeedbackPendingStore } from "./feedbackPending";
import { feedbackWorld, makeController, pendingRecord, slot, TEXT } from "./feedbackFixtures.test-support";

afterEach(() => { vi.restoreAllMocks(); });
async function ready(world = feedbackWorld()) {
  const made = makeController(world);
  await made.controller.refresh();
  return { world, ...made };
}

describe("an empty message is never sent", () => {
  it.each(["", " ", "  \n\t ", "  "])("%j: no command, no stored intent, the button state stays off", async text => {
    const { world, controller } = await ready();
    controller.edit(text);
    expect(controller.snapshot().canSend).toBe(false);
    await controller.send();
    expect(world.posts).toHaveLength(0); expect(world.f.values.has(slot)).toBe(false);
    expect(controller.snapshot().phase).toBe("idle");
  });
  it("sends the text as typed, without card_id, as one feedback.send command of this document", async () => {
    const { world, controller } = await ready();
    controller.edit(`  ${TEXT}\n`);
    await controller.send();
    expect(world.posts).toEqual([{ command_id: id(100), kind: "feedback.send", client_instance_id: id(1), document_id: id(2),
      payload: { text: `  ${TEXT}\n` } }]);
  });
});

describe("success is shown only after the server confirms the message", () => {
  it("keeps the text, the pending record and no success while the reply is awaited", async () => {
    const { world, controller } = await ready(); controller.edit(TEXT);
    const gate = world.hold();
    const sending = controller.send();
    await vi.waitFor(() => expect(world.posts).toHaveLength(1));
    expect(controller.snapshot()).toMatchObject({ phase: "sending", confirmed: false, text: TEXT, canSend: false, canEdit: false });
    expect(JSON.parse(world.f.values.get(slot)!).intent.payload.text).toBe(TEXT);
    gate.resolve(); await sending;
    expect(controller.snapshot()).toMatchObject({ phase: "idle", confirmed: true, text: "", problem: null, refusal: null, canEdit: true });
    expect(world.f.values.has(slot)).toBe(false);
  });
  it("a reply that is not a valid applied fact of this command is not a success", async () => {
    const { world, controller } = await ready(feedbackWorld(["garbage"])); controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ confirmed: false, problem: "network", text: TEXT, canRetry: true });
    expect(world.f.values.has(slot)).toBe(true);
  });
  it("a second tap while sending does not start a second command", async () => {
    const { world, controller } = await ready(); controller.edit(TEXT);
    const gate = world.hold();
    const first = controller.send(), second = controller.send();
    await vi.waitFor(() => expect(world.posts).toHaveLength(1));
    gate.resolve(); await Promise.all([first, second]);
    expect(world.posts).toHaveLength(1);
  });
  it("editing after a confirmed message clears the confirmation and starts a new text", async () => {
    const { controller } = await ready(); controller.edit(TEXT); await controller.send();
    expect(controller.snapshot().confirmed).toBe(true);
    controller.edit("Noch eins");
    expect(controller.snapshot()).toMatchObject({ confirmed: false, text: "Noch eins", canSend: true });
  });
});

describe("a failed send keeps the text and the same command_id", () => {
  it("a lost reply of an applied command: retry checks the same id and confirms without sending again", async () => {
    const { world, controller } = await ready(feedbackWorld(["lose-after"])); controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "network", text: TEXT, confirmed: false,
      canEdit: false, canSend: false, canRetry: true });
    expect(world.f.values.has(slot)).toBe(true);
    await controller.retry();
    expect(world.gets).toEqual([id(100)]); expect(world.posts).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ confirmed: true, text: "", problem: null });
    expect(world.facts.size).toBe(1); expect(world.f.values.has(slot)).toBe(false);
  });
  it("a lost request: retry finds no command and sends exactly the retained intent under the same id", async () => {
    const { world, controller } = await ready(feedbackWorld(["lose-before"])); controller.edit(TEXT);
    await controller.send();
    await controller.retry();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100), id(100)]);
    expect(world.posts[1].payload).toEqual(world.posts[0].payload);
    expect(controller.snapshot()).toMatchObject({ confirmed: true, text: "" }); expect(world.facts.size).toBe(1);
  });
  it("a failed check sends nothing and leaves the intent retryable", async () => {
    const { world, controller } = await ready(feedbackWorld(["lose-before"])); controller.edit(TEXT);
    await controller.send(); world.state.statusFailures = 1;
    await controller.retry();
    expect(world.posts).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "network", canRetry: true, text: TEXT });
    await controller.retry();
    expect(world.posts).toHaveLength(2); expect(controller.snapshot().confirmed).toBe(true);
  });
  it("a server error is an unknown outcome, not a refusal", async () => {
    const { world, controller } = await ready(feedbackWorld(["500"])); controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ problem: "network", refusal: null, canRetry: true });
    expect(world.f.values.has(slot)).toBe(true);
  });
  it("the text cannot be edited while its outcome is unknown", async () => {
    const { controller } = await ready(feedbackWorld(["lose-before"])); controller.edit(TEXT);
    await controller.send(); controller.edit("other");
    expect(controller.snapshot().text).toBe(TEXT);
  });
});

describe("a reload resolves the stored intent by its own command_id and never sends by itself", () => {
  it("restores the text and confirms an applied command", async () => {
    const world = feedbackWorld(); world.facts.set(id(300), { text: TEXT, card_id: null, inbox: id(901) });
    world.f.values.set(slot, pendingRecord(id(300)));
    const { controller } = await ready(world);
    expect(world.gets).toEqual([id(300)]); expect(world.posts).toHaveLength(0);
    expect(controller.snapshot()).toMatchObject({ confirmed: true, text: "", phase: "idle" });
    expect(world.f.values.has(slot)).toBe(false);
  });
  it("a command the server does not know stays unsent until an explicit retry of the same intent", async () => {
    const world = feedbackWorld(); world.f.values.set(slot, pendingRecord(id(300)));
    const { controller } = await ready(world);
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "not_sent", text: TEXT, canRetry: true, confirmed: false });
    expect(world.posts).toHaveLength(0);
    await controller.retry();
    expect(world.posts.map(post => post.command_id)).toEqual([id(300)]); expect(controller.snapshot().confirmed).toBe(true);
  });
  it("an unreachable check leaves the text and the intent", async () => {
    const world = feedbackWorld(); world.f.values.set(slot, pendingRecord(id(300))); world.state.statusFailures = 1;
    const { controller } = await ready(world);
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "network", text: TEXT, canRetry: true });
    expect(world.posts).toHaveLength(0); expect(world.f.values.has(slot)).toBe(true);
  });
  it("a record of another profile is dropped and never checked", async () => {
    const world = feedbackWorld();
    world.f.values.set(slot, JSON.stringify({ ...JSON.parse(pendingRecord(id(300))), profileId: id(51) }));
    const { controller } = await ready(world);
    expect(world.gets).toHaveLength(0); expect(world.f.values.has(slot)).toBe(false);
    expect(controller.snapshot()).toMatchObject({ phase: "idle", canEdit: true });
  });
  it("a damaged record blocks sending and is neither deleted nor replaced", async () => {
    const world = feedbackWorld(); world.f.values.set(slot, "broken");
    const { controller } = await ready(world);
    expect(controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending", canSend: false, canEdit: false, canRetry: false });
    controller.edit(TEXT); await controller.send();
    expect(world.posts).toHaveLength(0); expect(world.f.values.get(slot)).toBe("broken");
  });
  it("a storage failure on load can be retried", async () => {
    const world = feedbackWorld();
    vi.spyOn(world.f.storage, "get").mockRejectedValueOnce(new Error("local failure"));
    const { controller } = await ready(world);
    expect(controller.snapshot()).toMatchObject({ phase: "blocked", problem: "storage", canRetry: true, canSend: false });
    await controller.retry();
    expect(controller.snapshot()).toMatchObject({ phase: "idle", problem: null, canEdit: true });
  });
});

describe("a definite refusal keeps the text and frees the form for a new command", () => {
  it.each([["422", "VALIDATION_FAILED"], ["409", "ASSIGNMENT_STALE"]] as const)("%s", async (fate, code) => {
    const { world, controller } = await ready(feedbackWorld([fate])); controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ phase: "idle", refusal: { code }, text: TEXT, confirmed: false, canEdit: true, canSend: true, canRetry: false });
    expect(world.f.values.has(slot)).toBe(false);
    await controller.send();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100), id(101)]);
    expect(controller.snapshot()).toMatchObject({ confirmed: true, refusal: null });
  });
  // root decision, pending owner: any 4xx but 401/403/408/429 is a definite refusal, so a permanent 400/404/413 cannot lock the form.
  it.each(["400", "404", "413"] as const)("HTTP %s is a refusal: the text stays editable and the record is dropped", async fate => {
    const { world, controller } = await ready(feedbackWorld([fate])); controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ phase: "idle", refusal: { code: "REFUSED" }, problem: null, text: TEXT,
      canEdit: true, canSend: true, canRetry: false });
    expect(world.f.values.has(slot)).toBe(false);
    controller.edit(`${TEXT}!`);
    expect(controller.snapshot().text).toBe(`${TEXT}!`);
    await controller.send();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100), id(101)]); expect(controller.snapshot().confirmed).toBe(true);
  });
  it.each(["429", "408"] as const)("HTTP %s stays an unknown outcome: the intent and the retry remain", async fate => {
    const { world, controller } = await ready(feedbackWorld([fate])); controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ problem: "network", refusal: null, text: TEXT, canEdit: false, canRetry: true });
    expect(world.f.values.has(slot)).toBe(true);
    await controller.retry();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100), id(100)]); expect(controller.snapshot().confirmed).toBe(true);
  });
  it.each([["403", "forbidden"], ["401", "expired"]] as const)("%s is denied before anything is written", async (fate, problem) => {
    const { world, controller } = await ready(feedbackWorld([fate])); controller.edit(TEXT);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ problem, refusal: null, text: TEXT, confirmed: false, canRetry: false });
    expect(world.f.values.has(slot)).toBe(false); expect(world.facts.size).toBe(0);
  });
});

describe("local storage failures never create a second command", () => {
  it("a failed write of the intent sends nothing; the retry checks the same id and sends it", async () => {
    const { world, controller } = await ready(); controller.edit(TEXT);
    vi.spyOn(world.f.storage, "set").mockRejectedValueOnce(new Error("local failure"));
    await controller.send();
    expect(world.posts).toHaveLength(0);
    expect(controller.snapshot()).toMatchObject({ problem: "storage", text: TEXT, canRetry: true });
    await controller.retry();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100)]); expect(controller.snapshot().confirmed).toBe(true);
  });
  it("a failed cleanup after a confirmed message shows only the storage error; retry cleans up without sending and then confirms", async () => {
    const { world, controller } = await ready(); controller.edit(TEXT);
    vi.spyOn(world.f.storage, "remove").mockRejectedValueOnce(new Error("local failure"));
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ confirmed: false, problem: "storage", canRetry: true, text: TEXT });
    await controller.retry();
    expect(controller.snapshot()).toMatchObject({ confirmed: true, problem: null, text: "", phase: "idle" });
    expect(world.posts).toHaveLength(1); expect(world.f.values.has(slot)).toBe(false);
  });
});

describe("lifetime", () => {
  it("a disposed owner publishes nothing and cannot send", async () => {
    const { world, controller, updates } = await ready(); controller.edit(TEXT);
    controller.dispose(); updates.mockClear();
    await controller.send();
    expect(world.posts).toHaveLength(0); expect(updates).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ phase: "disposed", text: "", canSend: false });
  });
  it("a reply that arrives after the handle was replaced does not confirm anything", async () => {
    const { world, controller } = await ready(); controller.edit(TEXT);
    const gate = world.hold(); const sending = controller.send();
    await vi.waitFor(() => expect(world.posts).toHaveLength(1));
    world.f.replace(); gate.resolve(); await sending;
    expect(controller.snapshot()).toMatchObject({ confirmed: false, problem: "network", text: TEXT });
    await controller.retry();
    expect(controller.snapshot().confirmed).toBe(true); expect(world.facts.size).toBe(1);
  });
});

it("uses one store slot beside the settings slot", async () => {
  const world = feedbackWorld(["lose-before"]); const store = new FeedbackPendingStore(world.f.storage);
  const { controller } = makeController(world, store); await controller.refresh(); controller.edit(TEXT); await controller.send();
  expect([...world.f.values.keys()].filter(key => key.startsWith("wortly.pending."))).toEqual([slot]);
});
