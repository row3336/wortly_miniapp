import { afterEach, describe, expect, it, vi } from "vitest";
import { id } from "../learning/learningFixtures.test-support";
import { createFeedbackApi, FEEDBACK_TEXT_MAX_UTF16, feedbackTextLength, overFeedbackLimit, type FeedbackIntent } from "./feedbackApi";
import { feedbackWorld, makeController, pendingRecord, slot } from "./feedbackFixtures.test-support";
import { testGate } from "../commands/testGate.test-support";

// R7-01 (К19-042, П5-022): 3700 UTF-16 code units, the unit of String.length and of the server (core TEXT_MAX_UTF16).
afterEach(() => { vi.restoreAllMocks(); });
async function ready(world = feedbackWorld()) {
  const made = makeController(world);
  await made.controller.refresh();
  return { world, ...made };
}
const emoji = "\u{1F600}"; // one code point, two UTF-16 units
const cases: Array<[string, string, boolean]> = [
  ["3700 ASCII", "a".repeat(3700), true],
  ["3701 ASCII", "a".repeat(3701), false],
  ["3700 Cyrillic", "я".repeat(3700), true],
  ["3701 Cyrillic", "я".repeat(3701), false],
  ["3700 CJK (BMP)", "漢".repeat(3700), true],
  ["3701 CJK (BMP)", "漢".repeat(3701), false],
  ["1850 emoji = 3700 units", emoji.repeat(1850), true],
  ["1851 emoji = 3702 units", emoji.repeat(1851), false],
  ["3698 ASCII + emoji = 3700", "a".repeat(3698) + emoji, true],
  ["3699 ASCII + emoji = 3701 (surrogate pair across the limit)", "a".repeat(3699) + emoji, false],
  ["1850 emoji + 1 ASCII = 3701", emoji.repeat(1850) + "a", false],
  ["3700 control characters", "\u0001".repeat(3700), true],
  ["3701 line feeds", "\n".repeat(3699) + "ab", false],
];

describe("the unit is UTF-16 code units, never code points", () => {
  it("counts like String.length: an emoji is two, a BMP character one", () => {
    expect(FEEDBACK_TEXT_MAX_UTF16).toBe(3700);
    expect([...emoji]).toHaveLength(1);
    expect(feedbackTextLength(emoji)).toBe(2); expect(feedbackTextLength("я")).toBe(1); expect(feedbackTextLength("漢")).toBe(1);
    expect(feedbackTextLength("\u{1F468}‍\u{1F469}")).toBe(5); // a ZWJ sequence: units, not graphemes
    expect(feedbackTextLength("\ud83d")).toBe(1); // a lone surrogate is one unit (the server refuses it as invalid text)
  });
  it.each(cases)("%s: over the limit is %s", (_name, text, allowed) => {
    expect(overFeedbackLimit(text)).toBe(!allowed);
  });
});

describe("the controller never sends a text over the limit", () => {
  it.each(cases)("%s", async (_name, text, allowed) => {
    const { world, controller } = await ready();
    controller.edit(text);
    expect(controller.snapshot()).toMatchObject({ text, canSend: allowed, canEdit: true });
    await controller.send();
    if (allowed) {
      expect(world.posts).toHaveLength(1); expect(world.posts[0].payload.text).toBe(text);
      expect(controller.snapshot()).toMatchObject({ confirmed: true, text: "" });
    } else {
      expect(world.posts).toHaveLength(0); expect(world.f.values.has(slot)).toBe(false);
      expect(controller.snapshot()).toMatchObject({ phase: "idle", text, refusal: null, problem: null, canEdit: true, canSend: false });
    }
  });
  it("shortening the text frees the button; the long text is kept until then", async () => {
    const { world, controller } = await ready();
    controller.edit("a".repeat(3701));
    expect(controller.snapshot().canSend).toBe(false);
    controller.edit("a".repeat(3700));
    expect(controller.snapshot()).toMatchObject({ canSend: true, text: "a".repeat(3700) });
    await controller.send();
    expect(world.posts).toHaveLength(1);
  });
  it("a complaint is limited the same way and keeps its card", async () => {
    const world = feedbackWorld();
    const { controller } = makeControllerWithCard(world, id(7));
    await controller.refresh();
    controller.edit("a".repeat(3701)); await controller.send();
    expect(world.posts).toHaveLength(0);
    controller.edit("a".repeat(3700)); await controller.send();
    expect(world.posts).toEqual([expect.objectContaining({ payload: { text: "a".repeat(3700), card_id: id(7) } })]);
  });
});

function makeControllerWithCard(world: ReturnType<typeof feedbackWorld>, cardId: string) {
  return makeController(world, undefined, cardId);
}

describe("the api layer is a second guard", () => {
  const intent = (text: string): FeedbackIntent => ({ command_id: id(100), kind: "feedback.send", payload: { text } });
  const origin = { clientInstanceId: id(1), documentId: id(2) };
  it("sends nothing over the limit: a definite VALIDATION_FAILED refusal without a request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const api = createFeedbackApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    expect(await api.send("token", "proof", origin, intent("a".repeat(3701)))).toEqual({ outcome: "refused", code: "VALIDATION_FAILED" });
    expect(await api.send("token", "proof", origin, intent(emoji.repeat(1851)))).toEqual({ outcome: "refused", code: "VALIDATION_FAILED" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("an old stored intent over the limit does not lock the form", () => {
  it("the retry is refused without a request, the record is dropped, the text stays to be shortened", async () => {
    const world = feedbackWorld();
    world.f.values.set(slot, pendingRecord(id(300), "a".repeat(3701)));
    const { controller } = makeController(world);
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "not_sent", canRetry: true });
    await controller.retry();
    expect(world.posts).toHaveLength(0); expect(world.f.values.has(slot)).toBe(false);
    expect(controller.snapshot()).toMatchObject({ phase: "idle", refusal: { code: "VALIDATION_FAILED" }, text: "a".repeat(3701), canEdit: true, canSend: false });
    controller.edit("a".repeat(3700));
    await controller.send();
    expect(world.posts).toHaveLength(1);
    expect(world.posts[0].command_id).not.toBe(id(300));
  });
});

describe("the server's 422 VALIDATION_FAILED for a text the client let through", () => {
  it("is a definite refusal: the text stays, nothing is stored, the next send is a new command", async () => {
    const lone = "ab\ud83dcd"; // a lone surrogate: counted as short, refused by the server as not encodable
    const { world, controller } = await ready(feedbackWorld(["422"]));
    controller.edit(lone);
    expect(controller.snapshot().canSend).toBe(true);
    await controller.send();
    expect(controller.snapshot()).toMatchObject({ phase: "idle", text: lone, refusal: { code: "VALIDATION_FAILED" }, problem: null, canEdit: true });
    expect(world.f.values.has(slot)).toBe(false); expect(world.facts.size).toBe(0);
    controller.edit("abcd"); await controller.send();
    expect(world.posts.map(post => post.command_id)).toEqual([id(100), id(101)]);
    expect(controller.snapshot().confirmed).toBe(true);
  });
});
