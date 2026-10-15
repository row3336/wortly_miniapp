// «Шаг назад» of Learning (M-UNDO CP2) over a synthetic server with core's C-UNDO-L behavior (C-UNDO-L/REPORT.md).
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashInPlace, tick } from "../commands/recoveryTime.test-support";
import { createLearningResultApi } from "./learningAnswerApi";
import { id, response } from "./learningFixtures.test-support";
import { learningUndoServer, type LearningUndoOptions as Options } from "./learningUndo.test-support";
import { LearningViewController } from "./learningViewController";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
async function harness(options: Options = {}, mode: "normal" | "accelerated" = "normal") {
  hashInPlace();
  const s = learningUndoServer(options);
  const own = () => {
    const view = new LearningViewController({ access: s.access, storage: s.storage, newId: s.newId,
      transport: { fetcher: s.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() }, sessionId: id(3), transitionMode: () => mode,
      onUpdate: vi.fn() });
    owners.push(view);
    return view;
  };
  const view = own();
  await view.refresh();
  const answer = async (text: string) => { view.setDraft(text); await view.submit(); };
  const kinds = () => s.posts().map(post => post.kind);
  const undos = () => s.posts().filter(post => post.kind === "result.undo");
  return { ...s, view, own, answer, kinds, undos };
}
const again = (n: number) => id(n + 10000);

describe("Learning «Шаг назад»: the right", () => {
  it("exists only as the server's undo_target of the answer on screen", async () => {
    const without = await harness({ undo: false }); await without.answer("falsch");
    expect(without.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true, canUndo: false });
    await without.view.undo(); expect(without.undos()).toHaveLength(0);
    const h = await harness(); await h.answer("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canUndo: true });
  });
});

describe("Learning result.undo", () => {
  it("sends the address of the right with its current version, then shows the same card again by one present", async () => {
    const h = await harness(); await h.answer("falsch");
    await h.view.undo();
    expect(h.undos()).toEqual([{ command_id: expect.any(String), session_id: id(3), kind: "result.undo", assignment_id: id(6),
      result_id: id(706), expected_result_version: "1", payload: {}, client_instance_id: id(1), document_id: id(2) }]);
    expect(h.kinds()).toEqual(["assignment.present", "answer.submit", "result.undo", "assignment.present"]);
    expect(h.posts().at(-1)).toMatchObject({ assignment_id: again(6) });
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: again(6), status: "presented" }, answer: null,
      draft: "", canUndo: false, canPrevious: false });
  });
  it("withdraws the shown next card and resets its draft", async () => {
    const h = await harness(); await h.answer("falsch"); await h.view.next();
    h.view.setDraft("B draft"); h.view.previousResult();
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", canUndo: true });
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: again(6) }, draft: "" });
    await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: again(7) }, draft: "" });
  });
  it("from the phase summary the session is active again and the card returns (summary_home off)", async () => {
    const h = await harness({ cards: [6] }); await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", canUndo: true });
    await h.view.undo();
    expect(h.kinds().slice(-2)).toEqual(["result.undo", "assignment.present"]);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: again(6), status: "presented" },
      current: { status: "active" } });
  });
  it("a lost undo from the phase summary is resolved by its ID by itself: the session is active again, nothing sent twice", async () => {
    vi.useFakeTimers();
    const h = await harness({ cards: [6] }); await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", canUndo: true });
    h.fetcher.mockImplementationOnce(async (...call) => { await h.fetcher.getMockImplementation()!(...call); throw new TypeError("network"); });
    await h.view.undo(); await tick();
    expect(h.undos()).toHaveLength(1);
    expect(h.kinds().slice(-2)).toEqual(["result.undo", "assignment.present"]);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: again(6), status: "presented" }, current: { status: "active" } });
  });
  it("after a correction that finished the phase (К05-151) the undo of version 2 returns to A", async () => {
    const h = await harness({ correctionEndsPhase: true }); await h.answer("falsch"); await h.view.next();
    h.view.setDraft("B draft"); h.view.previousResult(); await h.view.correct();
    expect(h.state.status).toBe("summary");
    expect(h.view.snapshot()).toMatchObject({ answer: { result: { grade: 4, version: "2" } }, canUndo: true });
    await h.view.undo();
    expect(h.undos()[0]).toMatchObject({ result_id: id(706), expected_result_version: "2" });
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: again(6) }, draft: "", answer: null });
  });
});

describe("Learning undo refusals", () => {
  it.each(["CAPABILITY_EXPIRED", "VERSION_CONFLICT", "ASSIGNMENT_STALE"])("%s keeps the result, re-reads and hides the button", async code => {
    const h = await harness({ refuseUndo: { code } }); await h.answer("Haus");
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", problem: code, canUndo: false, timer: null });
    expect(h.kinds().at(-1)).toBe("result.undo");
  });
  it("WRITE_UNAVAILABLE (503 without a projection) leaves the undo unknown: the machine resends the same ID, six times at most", async () => {
    vi.useFakeTimers();
    const h = await harness({ refuseUndo: { code: "WRITE_UNAVAILABLE", status: 503 } }); await h.answer("falsch");
    await h.view.undo(); await tick();
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", canUndo: false, canRetryPrimary: false });
    expect(h.undos()).toHaveLength(1);
    // The right still holds: after each check that confirms absence, the same ID goes again (2, 5, 10, 20, 30 s).
    for (let second = 0; second < 120; second++) await tick(1000);
    const undos = h.undos();
    expect(undos).toHaveLength(6);
    expect(new Set(undos.map(post => JSON.stringify(post))).size).toBe(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", canRetryPrimary: false, commands: { recovery: { state: { name: "exhausted" } } } });
    await h.view.retry(); await tick(60_000); expect(h.undos()).toHaveLength(6);
  });
});

describe("Learning undo: same ID and restart", () => {
  it("503 keeps the undo durable: after a restart it is checked by the same command_id, never as a new one", async () => {
    vi.useFakeTimers();
    const h = await harness({ refuseUndo: { code: "WRITE_UNAVAILABLE", status: 503 } }); await h.answer("falsch");
    await h.view.undo();
    const [first] = h.undos();
    h.view.dispose();
    const restarted = h.own(); await restarted.refresh(); await tick();
    const checks = h.fetcher.mock.calls.filter(call => call[1]?.method === "GET" && String(call[0]).includes(`/commands/${first.command_id}`));
    expect(checks.length).toBeGreaterThan(0);
    // The same storage, the same page: its count of that ID goes on (1 of 6), so the restart resends only the same ID.
    expect(restarted.snapshot()).toMatchObject({ phase: "unknown", canRetryPrimary: false });
    await tick(2000); await tick();
    expect(h.undos().map(post => post.command_id)).toEqual([first.command_id, first.command_id]);
  });
  it("a lost reply is resolved by the same ID", async () => {
    vi.useFakeTimers();
    const h = await harness(); await h.answer("falsch");
    h.fetcher.mockImplementationOnce(async (...call) => { await h.fetcher.getMockImplementation()!(...call); throw new TypeError("network"); });
    await h.view.undo(); await tick();
    expect(h.undos()).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: again(6) } });
  });
  it("a restart does not bring the right back", async () => {
    const h = await harness(); await h.answer("Haus");
    h.view.dispose(); h.newDocument(); h.replace({ document_id: id(9) });
    const restarted = h.own(); await restarted.refresh();
    expect(restarted.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, answer: null, canUndo: false });
  });
});

describe("Learning result API: result.undo", () => {
  it("sends exactly the undo address and accepts only its undone fact with an empty detail", async () => {
    const h = await harness(); await h.answer("falsch");
    const api = createLearningResultApi({ fetcher: h.fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    const command = { command_id: id(400), session_id: id(3), kind: "result.undo" as const, assignment_id: id(6), result_id: id(706),
      expected_result_version: "1", payload: {}, client_instance_id: id(1), document_id: id(2) };
    await expect(api.send("t", "p", { ...command, action_id: id(806) } as typeof command)).rejects.toThrow("invalid Learning result command");
    const undone = await api.send("t", "p", command);
    expect(undone).toMatchObject({ outcome: "accepted", command: { kind: "result.undo", object_version: "2" },
      result: { status: "undone", version: "2", detail: null }, capabilities: { undo_target: null, summary_home: false },
      step: { status: "active", assignment: { id: id(10006), status: "prefetched" } } });
    expect(await readWithTicket(command, (__command, __ticket) => api.status("t", "p", __command, __ticket))).toMatchObject({ outcome: "accepted", command: { status: "already_applied" } });
    // A fact at another version is not this undo.
    const reply = await (await h.fetcher.getMockImplementation()!(`/api/v1/commands/${id(400)}?session_id=${id(3)}`, { method: "GET" })).json();
    h.fetcher.mockResolvedValueOnce(response({ ...reply, command: { ...reply.command, object_version: "3" } }));
    await expect(readWithTicket(command, (__command, __ticket) => api.status("t", "p", __command, __ticket))).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

