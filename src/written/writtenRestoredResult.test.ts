// Decisions 20.1-А and 22.1-А at the level of one owner: an old answer result that a new owner finds on the server by
// its command ID (the intent came from the durable slot, this owner never sent it) waits for «Далее». A result this
// owner confirmed itself by the same check after a lost reply («уже записан») waits too (Q03 вариант 1).
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { writtenFixture } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); });
type Fixture = ReturnType<typeof writtenFixture>;
function own(f: Fixture, mode: "normal" | "accelerated" = "normal") {
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
    sessionId: null, transitionMode: () => mode, onUpdate: vi.fn() });
  owners.push(view);
  return view;
}
/** The first owner answers «Haus»; the server commits it but the reply is lost. */
async function answered(f: Fixture) {
  const first = own(f); await first.refresh(); await first.start("words"); first.setDraft("Haus");
  f.loseReply();
  await first.submit();
  const commandId = f.posts().find(post => post.kind === "answer.submit")!.command_id as string;
  return { first, commandId };
}
const submits = (f: Fixture, commandId: string) => f.posts().filter(post => post.command_id === commandId);

describe("old answer result restored by a new owner", () => {
  for (const mode of ["normal", "accelerated"] as const) it(`waits for «Далее» with the committed result (${mode})`, async () => {
    const f = writtenFixture({ cards: [6, 7] }); const { first, commandId } = await answered(f);
    first.dispose();
    const next = own(f, mode); await next.refresh();
    const state = next.snapshot(), resultId = f.server.receipts.get(commandId)!.fact.result_id;
    expect(state.commands.primary.resolved).toMatchObject({ commandId, kind: "answer.submit", restored: true, resultId });
    expect([state.phase, state.answer?.result?.result_id, state.answer?.result?.version, state.answer?.result?.grade])
      .toEqual(["result_correct", resultId, "1", 4]);
    expect(state.timer).toBeNull(); expect(state.canNext).toBe(true);
    // A later read of the same owner keeps it waiting.
    await next.refresh();
    expect(next.snapshot().timer).toBeNull(); expect(next.snapshot().phase).toBe("result_correct");
    expect(submits(f, commandId)).toHaveLength(1);
  });

  // The status reply is older than the lane's floor: its result is not taken and the view reads it by its ID
  // (recoverAcceptedResult). No resume runs here, so the wait comes from restored alone.
  for (const mode of ["normal", "accelerated"] as const) it(`the result read by its ID after a stale status waits too (${mode})`, async () => {
    const f = writtenFixture({ cards: [6, 7] }); const { first, commandId } = await answered(f);
    first.dispose();
    f.fetcher.mockImplementation(async (url, init) => {
      const reply = await f.server.handle(url as RequestInfo, init);
      if ((init?.method ?? "GET") !== "GET" || !String(url).includes(`/commands/${commandId}`)) return reply;
      const value = await reply.clone().json() as Record<string, unknown>;
      return new Response(JSON.stringify({ ...value, state_version: "1" }), { status: reply.status, headers: { "Content-Type": "application/json" } });
    });
    const next = own(f, mode); await next.refresh();
    const resultId = f.server.receipts.get(commandId)!.fact.result_id as string;
    expect(f.gets(`result_id=${resultId}`).length).toBeGreaterThan(0);
    const state = next.snapshot();
    expect(state.commands.primary.resolved).toMatchObject({ commandId, restored: true });
    expect([state.phase, state.answer?.result?.result_id, state.answer?.result?.version]).toEqual(["result_correct", resultId, "1"]);
    expect(state.timer).toBeNull(); expect(state.canNext).toBe(true);
    expect(submits(f, commandId)).toHaveLength(1);
  });

  it("a lost reply confirmed by the same owner's check («уже записан») waits for «Далее» (Q03)", async () => {
    const f = writtenFixture({ cards: [6, 7] }); const { first, commandId } = await answered(f);
    await first.refresh();
    const state = first.snapshot();
    expect(state.commands.primary.resolved).toMatchObject({ commandId, kind: "answer.submit", checked: true });
    expect(state.commands.primary.resolved?.restored).toBeUndefined();
    expect(state.phase).toBe("result_correct");
    // Once the check's read has settled, still no timer.
    await first.refresh();
    expect(first.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    expect(submits(f, commandId)).toHaveLength(1);
  });
});
