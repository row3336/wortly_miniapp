// «Шаг назад» of the written quiz (M-UNDO): the right, the command, its reply, refusals, the summary and a restart.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WrittenViewController } from "./writtenViewController";
import { id, tick, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function harness(options: ServerOptions = {}, mode: "normal" | "accelerated" = "normal") {
  const f = writtenFixture({ undo: true, ...options });
  const own = (sessionId: string | null = null) => {
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId, transitionMode: () => mode, onUpdate: vi.fn() });
    owners.push(view);
    return view;
  };
  const view = own();
  const kinds = () => f.posts().map(post => post.kind);
  const undos = () => f.posts().filter(post => post.kind === "result.undo");
  const started = async () => { await view.refresh(); await view.start("words"); };
  const answer = async (text: string) => { view.setDraft(text); await view.submit(); };
  return { ...f, view, own, kinds, undos, started, answer };
}
/** The second issue of card n after an undo has a new assignment ID (fixture: +10000). */
const reissued = (n: number) => id(n + 10000);

describe("the «Шаг назад» right", () => {
  it("exists only as the server's undo_target of the answer on screen", async () => {
    const without = harness({ undo: false }); await without.started(); await without.answer("falsch");
    expect(without.server.view(id(706)).capabilities.undo_target).toBeNull();
    expect(without.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true, canUndo: false });
    await without.view.undo(); expect(without.undos()).toHaveLength(0);
    const h = harness(); await h.started(); await h.answer("falsch");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canUndo: true });
  });
  it("is not offered on the question of the next card, only on the result (also as «Предыдущий ответ»)", async () => {
    const h = harness(); await h.started(); await h.answer("Haus"); await h.view.next();
    expect(h.server.view(id(706)).capabilities.undo_target).not.toBeNull();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, canUndo: false });
    await h.view.undo(); expect(h.undos()).toHaveLength(0);
    h.view.previousResult();
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", canUndo: true });
  });
  it("waits while the present of a visible next card is unconfirmed (TA:113)", async () => {
    const h = harness(); await h.started(); await h.answer("Haus");
    const gate = h.hold(); const showing = h.view.next();
    await vi.waitFor(() => expect(h.kinds().at(-1)).toBe("assignment.present"));
    h.view.previousResult();
    expect(h.view.snapshot()).toMatchObject({ phase: "previous_result", canUndo: false });
    gate.resolve(); await showing;
    expect(h.view.snapshot()).toMatchObject({ canUndo: true });
  });
});

describe("result.undo", () => {
  it("sends only the address of the right, then shows the new issue of the card by one present", async () => {
    const h = harness(); await h.started(); await h.answer("falsch");
    await h.view.undo();
    expect(h.undos()).toEqual([{ command_id: expect.any(String), session_id: h.server.state.sessionId, kind: "result.undo",
      assignment_id: id(6), result_id: id(706), expected_result_version: "1", payload: {}, client_instance_id: id(1), document_id: id(2) }]);
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "answer.submit", "result.undo", "assignment.present"]);
    expect(h.posts().at(-1)).toMatchObject({ kind: "assignment.present", assignment_id: reissued(6) });
    expect(h.server.results.get(id(706))).toMatchObject({ status: "undone", version: 2 });
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(6), status: "presented" }, answer: null,
      draft: "", timer: null, canUndo: false, canPrevious: false, canCorrect: false, problem: null });
  });
  it("is one undo, not a chain: only a new answer brings a new right (К05-066)", async () => {
    const h = harness({ cards: [6, 7, 8] }); await h.started(); await h.answer("Haus"); await h.view.next();
    await h.answer("falsch"); await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(7) }, canPrevious: false, canUndo: false });
    // The earlier answer of card 6 keeps its result and gets no right back.
    expect(h.server.view(id(706)).capabilities.undo_target).toBeNull();
    await h.answer("Haus");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { assignment_id: reissued(7) } }, canUndo: true });
    await h.view.undo();
    expect(h.undos().map(post => post.assignment_id)).toEqual([id(7), reissued(7)]);
  });
  it("from «Предыдущий ответ» the shown next card and its draft are withdrawn", async () => {
    const h = harness(); await h.started(); await h.answer("falsch"); await h.view.next();
    h.view.setDraft("B draft"); h.view.previousResult();
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(6) }, draft: "" });
    // The withdrawn card comes later under a new ID.
    await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(7) }, draft: "" });
  });
  it("stops the result timer: the removed result neither advances nor shows a timer", async () => {
    const h = harness({}, "accelerated"); await h.started(); await h.answer("Haus");
    expect(h.view.snapshot().timer).not.toBeNull();
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(6) }, timer: null });
  });
  it("shows that the undo is being saved and offers no other action meanwhile", async () => {
    const h = harness(); await h.started(); await h.answer("falsch");
    const gate = h.hold(); const undoing = h.view.undo();
    await vi.waitFor(() => expect(h.kinds().at(-1)).toBe("result.undo"));
    expect(h.view.snapshot()).toMatchObject({ phase: "undoing", canUndo: false, canCorrect: false, canNext: false });
    await h.view.undo(); expect(h.undos()).toHaveLength(1);
    gate.resolve(); await undoing;
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(6) } });
  });
});

describe("from the summary (К10-127, Т10)", () => {
  it("the summary of an open session keeps «Шаг назад»; the undo returns to the card", async () => {
    const h = harness({ cards: [6] }); await h.started(); await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", summary: { completed: 1 }, canSummaryHome: true, canUndo: true });
    await h.view.undo();
    expect(h.kinds().slice(-2)).toEqual(["result.undo", "assignment.present"]);
    expect(h.server.state.status).toBe("active");
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(6), status: "presented" }, canSummaryHome: false });
    await h.answer("Haus"); await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", summary: { completed: 1, correct: 1 } });
  });
  it("«На Сегодня» closes the session and its right: no undo afterwards (К10-128, К10-129)", async () => {
    const h = harness({ cards: [6] }); await h.started(); await h.answer("Haus"); await h.view.next();
    await h.view.stop("summary_home");
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", canUndo: false });
    await h.view.undo(); expect(h.undos()).toHaveLength(0);
  });
  it("a refused undo from the summary returns to the summary", async () => {
    const h = harness({ cards: [6], refuseUndo: { code: "CAPABILITY_EXPIRED" } }); await h.started(); await h.answer("Haus"); await h.view.next();
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "summary", problem: "CAPABILITY_EXPIRED", canUndo: false, canSummaryHome: true });
    expect(h.kinds().at(-1)).toBe("result.undo");
  });
});

describe("refusals (CT 2.2)", () => {
  it.each([["FORBIDDEN", 403], ["CAPABILITY_EXPIRED", 409], ["ASSIGNMENT_STALE", 409], ["VERSION_CONFLICT", 409]] as const)(
    "%s keeps the result with its code, re-reads the state and the gone right hides the button", async (code, status) => {
      const h = harness({ refuseUndo: { code, status } }); await h.started(); await h.answer("falsch");
      const reads = h.gets(`/sessions/${h.server.state.sessionId}`).length;
      await h.view.undo();
      expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", problem: code, answer: { result: { result_id: id(706), grade: 2 } },
        canUndo: false, timer: null });
      expect(h.gets(`/sessions/${h.server.state.sessionId}`).length).toBeGreaterThan(reads);
      expect(h.kinds().at(-1)).toBe("result.undo");
    });
  it("after a refusal a correct result waits for «Далее»: its timer is not armed again (normal mode)", async () => {
    const h = harness({ refuseUndo: { code: "CAPABILITY_EXPIRED" } }); await h.started(); await h.answer("Haus");
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", problem: "CAPABILITY_EXPIRED", timer: null, canNext: true });
    expect(h.kinds().at(-1)).toBe("result.undo");
    await h.view.next();
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
  });
  it("a refusal without a result projection re-reads the result, which still waits for «Далее»", async () => {
    const h = harness(); await h.started(); await h.answer("Haus");
    h.fetcher.mockImplementationOnce(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ action: null, result: null, step: h.server.step(),
        capabilities: { answer_target: null, grades: null, correct_target: null, undo_target: null, stop: true, summary_home: false },
        command: { id: body.command_id, status: "rejected" }, state_version: String(h.server.state.version), error: { code: "FORBIDDEN" } }),
      { status: 403 });
    });
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", problem: "FORBIDDEN", timer: null, canNext: true });
    expect(h.kinds().at(-1)).toBe("result.undo");
  });
  it("a right ended elsewhere is refused by the server and the button disappears (CAPABILITY_EXPIRED)", async () => {
    const h = harness(); await h.started(); await h.answer("falsch");
    h.server.revokeRights(id(706));
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", problem: "CAPABILITY_EXPIRED", canUndo: false });
    expect(h.server.results.get(id(706))).toMatchObject({ status: "active" });
  });
  it("SESSION_CLOSED: a session closed elsewhere stays closed", async () => {
    const h = harness(); await h.started(); await h.answer("falsch");
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", canUndo: false });
    expect(h.kinds().at(-1)).toBe("result.undo");
  });
});

describe("one command_id per undo (Т02)", () => {
  it("a lost reply is resolved by the same ID: the committed undo shows the new card, nothing is sent again", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("falsch");
    h.loseReply(); await h.view.undo();
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", canUndo: false });
    const first = h.undos()[0];
    await tick();
    expect(h.gets(`/commands/${first.command_id}`)).toHaveLength(1);
    expect(h.undos()).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(6), status: "presented" }, answer: null });
  });
  it("a request that never arrived is checked, then retried by itself with the same ID while the right still holds", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("falsch");
    h.dropRequest(); await h.view.undo(); await tick();
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", canRetryPrimary: false, commands: { recovery: { state: { name: "retry_wait" } } } });
    await tick(2000); await tick();
    const [first, second] = h.undos();
    expect(second).toEqual(first);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: reissued(6) } });
  });
  it("an unknown undo whose right is gone is never retried: the right is not created again (CT 2.3)", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("falsch");
    // The right ends before the check of the lost request can see it.
    h.dropRequest(); h.server.newDocument(); await h.view.undo(); await tick();
    // The screen then shows the server's state: the answer whose undo ended stays, nothing claims the undo (CT §6.1 п. 7).
    expect(h.view.snapshot()).toMatchObject({ phase: "result_wrong", canRetryPrimary: false, canUndo: false, problem: null,
      commands: { primary: { pending: false }, recovery: { state: { name: "terminated", reason: "step_stale" } } } });
    await tick(60_000); await h.view.retry(); expect(h.undos()).toHaveLength(1);
    expect(h.server.results.get(id(706))).toMatchObject({ status: "active" });
  });
});

describe("restart and background (К05-073, К05-074)", () => {
  it("background keeps the right; a restart does not bring it back", async () => {
    const h = harness({ cards: [6, 7] }); await h.started(); await h.answer("Haus");
    h.view.suspend(); await h.view.resume();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", canUndo: true });
    const sessionId = h.server.state.sessionId!;
    h.view.dispose(); h.server.newDocument(); h.replace({ document_id: id(9) });
    const restarted = h.own(sessionId); await restarted.refresh();
    expect(restarted.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, answer: null, canUndo: false, canPrevious: false });
    expect(h.undos()).toHaveLength(0);
  });
  it("a restart on the summary keeps the summary without «Шаг назад»", async () => {
    const h = harness({ cards: [6] }); await h.started(); await h.answer("Haus"); await h.view.next();
    const sessionId = h.server.state.sessionId!;
    h.view.dispose(); h.server.newDocument(); h.replace({ document_id: id(9) });
    const restarted = h.own(sessionId); await restarted.refresh();
    expect(restarted.snapshot()).toMatchObject({ phase: "summary", canSummaryHome: true, canUndo: false });
  });
  it("an undo left unknown before the restart is checked by its ID and not resent after its right ended", async () => {
    vi.useFakeTimers(); const h = harness(); await h.started(); await h.answer("falsch");
    // The old document is closed before its own recovery could check.
    h.dropRequest(); await h.view.undo();
    const sessionId = h.server.state.sessionId!, [first] = h.undos();
    h.view.dispose(); h.server.newDocument(); h.replace({ document_id: id(9) });
    const restarted = h.own(sessionId); await restarted.refresh(); await tick(60_000);
    expect(h.gets(`/commands/${first.command_id}`).length).toBeGreaterThanOrEqual(1);
    expect(restarted.snapshot()).toMatchObject({ canRetryPrimary: false, canUndo: false });
    await restarted.retry(); expect(h.undos()).toHaveLength(1);
  });
});
