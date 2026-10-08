import { learningViewFixture } from "./learningView.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningSessionProjection } from "../api/generated";
import { tick } from "../commands/recoveryTime.test-support";
import { LearningViewController } from "./learningViewController";
import { current, deferred, id, missing, original, pending, primaryKey, response } from "./learningFixtures.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
function harness(mode: "normal" | "accelerated" = "normal", sessionId: string | null = id(3)) {
  const f = learningViewFixture(mode, sessionId); owners.push(f.view); return f;
}
type Fixture = ReturnType<typeof harness>;
/**
 * A revision that never reached the server: the check before the background cannot reach it; after the return its
 * receipt is not found, so the machine sends the same ID again, and that retry is rejected.
 */
async function lostRevisionRejectedAfterReturn(f: Fixture, revise: () => Promise<void>, kind: "result.grade" | "result.correct") {
  const before = f.view.snapshot();
  // The synthetic server answers no unknown ID by itself: the first check fails like an unreachable server.
  f.fetcher.mockRejectedValueOnce(new Error("lost before the server")); await revise(); await tick();
  expect(f.view.snapshot()).toMatchObject({ phase: "unknown", canRetryPrimary: false, commands: { primary: { kind } } });
  const sent = f.posts().at(-1)!;
  f.view.suspend(); await tick(10000); f.replace();
  let refused = false;
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "GET" && String(url).includes(`/commands/${sent.command_id}`)) return response(missing(sent, before.commands.stateVersion));
    if (init?.method === "POST" && !refused) {
      refused = true;
      return response({ ...before.answer, step: before.current, state_version: before.commands.stateVersion,
        command: { id: JSON.parse(String(init.body)).command_id, status: "rejected" }, error: { code: "VERSION_CONFLICT" } }, 409);
    }
    return f.handler(url, init);
  });
  await f.view.resume(); await tick();
}

describe("Learning question, result and presentation lifecycle", () => {
  it("retries Stop with its original ID while the answer request is still pending", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus");
    const answerReply = deferred<Response>(); f.fetcher.mockReturnValueOnce(answerReply.promise);
    const sending = f.view.submit(); await vi.waitFor(() => expect(f.posts()).toHaveLength(1));
    const answerCall = f.fetcher.mock.calls.at(-1)!;
    f.fetcher.mockRejectedValueOnce(new Error("Stop not delivered")); await f.view.stop();
    const stop = f.posts()[1];
    f.fetcher.mockResolvedValueOnce(response(missing(stop, "1")));
    const refreshing = f.view.refresh();
    await vi.waitFor(() => expect(f.view.snapshot().commands.stop.canRetry).toBe(true));
    const retry = f.view.retry("stop"), duplicate = f.view.retry("stop");
    try {
      await vi.waitFor(() => expect(f.posts().filter(post => post.kind === "session.stop")).toEqual([stop, stop]));
      await retry;
      expect(f.view.snapshot()).toMatchObject({ phase: "closed", question: null, draft: "", timer: null });
    } finally {
      answerReply.resolve(await f.handler(...answerCall));
      await Promise.all([sending, refreshing, retry, duplicate]);
    }
    expect(f.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
    expect(f.view.snapshot()).toMatchObject({ phase: "closed", question: null, draft: "", timer: null });
  });
  it("suspension blocks preview transitions without treating background as Stop", async () => {
    const f = harness("normal", null); await f.view.refresh(); await f.view.start();
    f.view.suspend(); await f.view.advancePreview(); await f.view.advancePreview(true);
    expect(f.view.snapshot()).toMatchObject({ phase: "preview", canAdvancePreview: false, canStop: true });
    expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
    f.replace(); await f.view.resume(); expect(f.view.snapshot().canAdvancePreview).toBe(true);
    await f.view.advancePreview(); expect(f.view.snapshot().phase).toBe("question");
  });
  it("hidden correction keeps the result; after return it waits for «Далее» without a timer", async () => {
    vi.useFakeTimers(); const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("wrong"); await f.view.submit();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const correcting = f.view.correct();
    await vi.waitFor(() => expect(f.posts()).toHaveLength(2)); const reply = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.view.suspend(); gate.resolve(reply); await correcting;
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null });
    f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct"]);
  });
  it.each([{ mode: "normal", wrong: false }, { mode: "accelerated", wrong: false }, { mode: "accelerated", wrong: true },
    { mode: "normal", wrong: true }] as const)(
    "$mode mode, wrong answer $wrong: after background the result waits for «Далее»; no card turns in the background or on return (Т90)",
    async ({ mode, wrong }) => {
      vi.useFakeTimers(); const spy = vi.spyOn(globalThis, "setTimeout");
      const f = harness(mode); if (wrong) f.wrong();
      await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
      const phase = wrong ? "result_wrong" : "result_correct", duration = mode === "accelerated" ? 2000 : wrong ? null : 3000;
      expect(f.view.snapshot().timer?.durationMs ?? null).toBe(duration);
      const stale = duration === null ? null : spy.mock.calls.find(call => call[1] === duration)![0] as () => void;
      f.view.suspend(); expect(f.view.snapshot().timer).toBeNull();
      await vi.advanceTimersByTimeAsync(10000); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
      f.replace(); await f.view.resume();
      expect(f.view.snapshot()).toMatchObject({ phase, timer: null, canNext: true });
      // The callback of the timer cancelled by the background must not switch the card, nor may the clock.
      stale?.(); await vi.advanceTimersByTimeAsync(10000);
      expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
      expect(f.view.snapshot()).toMatchObject({ phase, timer: null, canNext: true });
      await f.view.next();
      expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
      expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, timer: null });
      spy.mockRestore();
    });
  it("a result accepted while hidden also waits for «Далее» after return", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus");
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const sending = f.view.submit();
    await vi.waitFor(() => expect(f.posts()).toHaveLength(1)); const reply = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.view.suspend(); gate.resolve(reply); await sending; await vi.advanceTimersByTimeAsync(10000);
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null });
    f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]);
  });
  it("an explicit grade chosen after return advances right after its commit, without a timer", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    f.view.suspend(); f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, grades: [3, 4, 5] });
    await f.view.grade(5);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
    expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, answer: { result: { grade: 5 } }, timer: null });
  });
  it("«Далее» after return ends the wait: the next answer gets its normal timer again", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    f.view.suspend(); f.replace(); await f.view.resume(); await f.view.next();
    f.view.setDraft("Haus"); await f.view.submit();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present", "answer.submit", "assignment.present"]);
  });
  it("«Исправить ответ» pressed after return starts no timer: the result waits, «Далее» then works", async () => {
    vi.useFakeTimers(); const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("x"); await f.view.submit();
    f.view.suspend(); f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_wrong", timer: null, canCorrect: true });
    await f.view.correct();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct"]);
    await f.view.next(); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct", "assignment.present"]);
  });
  it("a correction acknowledged only after the return has begun also starts no timer", async () => {
    vi.useFakeTimers(); const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("x"); await f.view.submit();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const correcting = f.view.correct();
    await vi.waitFor(() => expect(f.posts()).toHaveLength(2)); const reply = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.view.suspend(); f.replace(); const resuming = f.view.resume(); gate.resolve(reply); await correcting; await resuming; await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct"]);
    await f.view.next(); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct", "assignment.present"]);
  });
  it("background on a question, not a result: the answer given after return is timed normally", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus");
    f.view.suspend(); f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "Haus" });
    await f.view.submit(); expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("a correction whose reply was lost keeps the old result on screen: after background and return it waits for «Далее»", async () => {
    vi.useFakeTimers(); const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("x"); await f.view.submit();
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost reply"); });
    await f.view.correct();
    expect(f.view.snapshot()).toMatchObject({ phase: "unknown", answer: { result: { grade: 2 } }, commands: { primary: { kind: "result.correct" } } });
    f.view.suspend(); await vi.advanceTimersByTimeAsync(10000); f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null, canNext: true });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct"]);
    await f.view.next(); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct", "assignment.present"]);
  });
  it("a grade lost before the server, settled as rejected only after the return, leaves the old result waiting for «Далее»", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    await lostRevisionRejectedAfterReturn(f, () => f.view.grade(5), "result.grade");
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } }, problem: "VERSION_CONFLICT", canNext: true, timer: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade", "result.grade"]);
    expect(f.view.snapshot().timer).toBeNull();
    await f.view.next(); expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade", "result.grade", "assignment.present"]);
  });
  it("a correction lost before the server, settled as rejected only after the return, leaves the old result waiting for «Далее»", async () => {
    vi.useFakeTimers(); const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("x"); await f.view.submit();
    await lostRevisionRejectedAfterReturn(f, () => f.view.correct(), "result.correct");
    expect(f.view.snapshot()).toMatchObject({ phase: "result_wrong", answer: { result: { grade: 2 } }, problem: "VERSION_CONFLICT", canNext: true, timer: null });
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct", "result.correct"]);
    await f.view.next();
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.correct", "result.correct", "assignment.present"]);
    expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
  });
  // OPEN QUESTION TO THE OWNER (QA-09): pins today's behavior, not a decided requirement. An answer whose reply was lost shows its
  // result for the first time after return and gets the normal timer; the same result delivered in the background waits
  // (see "a result accepted while hidden also waits…"). The timer comes from acceptResult() clearing waitNext on answer.submit.
  it("OPEN QUESTION: an answer whose reply was lost before background shows its first-seen result with the normal timer after return", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus");
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost reply"); });
    // The check right after the loss cannot reach the server either: the result is first seen after the return.
    f.fetcher.mockRejectedValueOnce(new Error("offline"));
    await f.view.submit(); await tick(); expect(f.view.snapshot().phase).toBe("unknown");
    f.view.suspend(); f.replace(); await f.view.resume(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 }, canNext: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("recovered grade intent survives hidden receipt checking without replaying its command", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost reply"); });
    await f.view.grade(3); f.view.suspend(); await f.view.retry();
    await f.view.refresh(); expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", timer: null });
    expect(f.posts()).toHaveLength(2);
    f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "question", answer: { result: { grade: 3 } }, timer: null });
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
  });
  it("a previous-result grade acknowledged while hidden retains the unfinished next question", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit(); await f.view.next();
    f.view.setDraft("B draft"); f.view.previousResult();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const grading = f.view.grade(5);
    await vi.waitFor(() => expect(f.posts()).toHaveLength(3)); const reply = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.view.suspend(); gate.resolve(reply); await grading; f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", draft: "B draft", timer: null });
    await f.view.next(); expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "B draft" });
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present", "result.grade"]);
  });
  it("suspension during a present barrier preserves B draft and blocks previous-result navigation", async () => {
    const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("wrong"); await f.view.submit();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const showing = f.view.next();
    await vi.waitFor(() => expect(f.posts()).toHaveLength(2)); const reply = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.view.setDraft("B draft"); f.view.suspend(); f.view.previousResult(); f.view.setDraft("overwritten");
    expect(f.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", draft: "B draft", canPrevious: false, canEditDraft: false });
    gate.resolve(reply); await showing; f.replace(); await f.view.resume();
    expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "B draft", canEditDraft: true });
    expect(f.posts()).toHaveLength(2);
  });
  it("loads a presented question without sending a command and keeps input until acceptance", async () => {
    const f = harness(); await f.view.refresh(); expect(f.view.snapshot().phase).toBe("question");
    expect(f.posts()).toEqual([]); f.view.setDraft("Haus"); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.view.submit(); await vi.waitFor(() => expect(f.posts()).toHaveLength(1));
    expect(f.view.snapshot()).toMatchObject({ phase: "submitting", draft: "Haus", canSubmit: false, submittedText: "Haus" });
    f.view.setDraft("changed"); await f.view.submit(); expect(f.posts()).toHaveLength(1);
    gate.resolve(await f.handler(f.fetcher.mock.calls.at(-1)![0], f.fetcher.mock.calls.at(-1)![1])); await send;
    expect(f.view.snapshot()).toMatchObject({ phase: "result_correct", draft: "", answer: { result: { grade: 4 } } });
  });
  it("does not send blank input or an unfinished IME composition", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft(" \n "); await f.view.submit();
    f.view.setDraft("Haus"); await f.view.submit({ composing: true }); expect(f.posts()).toHaveLength(0);
    f.wrong(); await f.view.submit({ forgot: true }); expect(f.posts()[0].payload).toEqual({ forgot: true });
    expect(f.view.snapshot()).toMatchObject({ phase: "result_wrong", timer: null });
  });
  it.each(["normal", "accelerated"] as const)("%s correct-answer timer only shows and presents the next question", async mode => {
    vi.useFakeTimers(); const f = harness(mode); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    expect(f.view.snapshot().timer?.durationMs).toBe(mode === "normal" ? 3000 : 2000);
    await vi.advanceTimersByTimeAsync(mode === "normal" ? 3000 : 2000);
    expect(f.posts().map(x => x.kind)).toEqual(["answer.submit", "assignment.present"]);
    expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, draft: "", timer: null });
  });
  it.each(["normal", "accelerated"] as const)("%s wrong-answer transition follows the selected timer mode", async mode => {
    vi.useFakeTimers(); const f = harness(mode); f.wrong(); await f.view.refresh(); f.view.setDraft("wrong"); await f.view.submit();
    expect(f.view.snapshot().timer?.durationMs ?? null).toBe(mode === "normal" ? null : 2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.posts().map(x => x.kind)).toEqual(mode === "normal" ? ["answer.submit"] : ["answer.submit", "assignment.present"]);
  });
  it("present barrier keeps B draft and blocks correction/answer until the original present is confirmed", async () => {
    const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("wrong"); await f.view.submit();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const showing = f.view.next();
    await vi.waitFor(() => expect(f.posts()).toHaveLength(2));
    expect(f.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", canSubmit: false });
    f.view.setDraft("B draft"); f.view.previousResult(); expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", draft: "B draft", canCorrect: false, timer: null });
    await f.view.correct(); await f.view.submit(); expect(f.posts()).toHaveLength(2);
    await f.view.next(); expect(f.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", draft: "B draft" });
    const presentCall = f.fetcher.mock.calls.find(call => call[1]?.method === "POST" && JSON.parse(String(call[1].body)).kind === "assignment.present")!;
    gate.resolve(await f.handler(...presentCall)); await showing;
    f.view.previousResult(); expect(f.view.snapshot().canCorrect).toBe(true);
    await f.view.correct(); expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", draft: "B draft", answer: { result: { grade: 4 } }, timer: null });
    await f.view.grade(5); expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", draft: "B draft", timer: null });
    await f.view.next(); expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "B draft", question: { id: id(7) } });
    expect(f.posts().filter(x => x.kind === "assignment.present")).toHaveLength(1);
  });
  it("a selected grade advances only after acknowledgement and never uses an old timer", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const grading = f.view.grade(5);
    await vi.advanceTimersByTimeAsync(5000); expect(f.posts().map(x => x.kind)).toEqual(["answer.submit", "result.grade"]);
    expect(f.view.snapshot()).toMatchObject({ phase: "changing_result", timer: null, canNext: false });
    const call = f.fetcher.mock.calls.at(-1)!; gate.resolve(await f.handler(...call)); await grading;
    expect(f.view.snapshot()).toMatchObject({ phase: "question", answer: { result: { grade: 5 } } });
    expect(f.posts().map(x => x.kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
  });
  it("lost accepted grade is recovered by GET and advances without another grade POST", async () => {
    vi.useFakeTimers(); const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost response"); });
    await f.view.grade(5); expect(f.view.snapshot()).toMatchObject({ canNext: false, timer: null });
    // The machine checks by the same ID at once and shows the confirmed grade, which advances once.
    await tick(); expect(f.view.snapshot()).toMatchObject({ phase: "question", answer: { result: { grade: 5 } } });
    expect(f.posts().map(x => x.kind)).toEqual(["answer.submit", "result.grade", "assignment.present"]);
  });
  it("Stop during an answer discards the local draft and prevents late data from reopening the screen", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const sending = f.view.submit(); await vi.waitFor(() => expect(f.posts()).toHaveLength(1));
    const call = f.fetcher.mock.calls.at(-1)!; const old = await f.handler(...call);
    await f.view.stop(); expect(f.view.snapshot()).toMatchObject({ phase: "closed", draft: "", question: null, timer: null });
    gate.resolve(old); await sending;
    expect(f.view.snapshot()).toMatchObject({ phase: "closed", answer: null, question: null });
    await f.view.next(); await f.view.submit(); expect(f.posts()).toHaveLength(2);
  });
  it("reload retains only the exact submitted text and never inserts it into another assignment", async () => {
    const f = harness(), command = original(); f.values.set(primaryKey, JSON.stringify(pending(command)));
    f.setStep({ ...current(), assignment: { ...current().assignment!, id: id(90) } });
    f.fetcher.mockResolvedValueOnce(response(missing(command, "1")))
      .mockResolvedValueOnce(response({ current: { ...current(), assignment: { ...current().assignment!, id: id(90) } }, state_version: "1" }));
    await f.view.refresh(); expect(f.view.snapshot()).toMatchObject({ phase: "unknown", submittedText: "Haus", question: null, canSubmit: false });
    expect(f.posts()).toEqual([]);
  });
  it("new Learning starts only explicitly and the last preview presents the first question once", async () => {
    const f = harness("normal", null); await f.view.refresh(); expect(f.posts()).toEqual([]); expect(f.view.snapshot().phase).toBe("idle");
    await f.view.start(); expect(f.view.snapshot().phase).toBe("preview");
    expect(f.posts().map(x => x.kind)).toEqual(["session.start"]);
    await f.view.advancePreview(); expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { status: "presented" } });
    expect(f.posts().map(x => x.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
  });
  it("a prefetched question is never exposed as visible before the present command exists", async () => {
    const f = harness(); f.setStep({ ...current(), assignment: { ...current().assignment!, status: "prefetched" } });
    const seen: { phase: string; status?: string; ids: number }[] = [];
    f.onUpdate.mockImplementation(snapshot => {
      if (snapshot.question) seen.push({ phase: snapshot.phase, status: snapshot.question.status, ids: f.newId.mock.calls.length });
    });
    await f.view.refresh();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(x => x.ids === 1 && (x.phase !== "question" || x.status === "presented"))).toBe(true);
    expect(seen[0].phase).toBe("visible_unconfirmed");
    expect(f.posts().map(x => x.kind)).toEqual(["assignment.present"]);
  });
  it("a missing original present reloads with its barrier and permits typing; with an unknown count it is only checked (Q25.1, CT §6.1 п. 4)", async () => {
    vi.useFakeTimers();
    const f = harness(), intent = { command_id: id(100), session_id: id(3), kind: "assignment.present" as const, assignment_id: id(6), payload: {} };
    f.values.set(primaryKey, JSON.stringify(pending(intent)));
    const question = { ...current(), assignment: { ...current().assignment!, status: "prefetched" as const } }; f.setStep(question);
    f.fetcher.mockImplementation(async (url, init) => init?.method === "GET" && String(url).includes(`/commands/${id(100)}`)
      ? response(missing(intent, "1")) : f.handler(url, init));
    await f.view.refresh(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", question: { id: id(6) }, canEditDraft: true, canForget: false,
      canRetryPrimary: false, commands: { automaticPrimary: true, recovery: { state: { name: "counter_unknown" } } } });
    f.view.setDraft("retained B"); await f.view.submit(); await f.view.retry();
    for (let second = 0; second < 120; second += 5) await tick(5000);
    // Nothing goes out by itself or by hand: no manual retry of the mark remains (Q25.1), and an unknown count resends nothing.
    expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", draft: "retained B", canSubmit: false });
  });
  it("a missing submitted answer reloads the same text; with an unknown count it is only checked, never resent (CT §6.1 п. 4)", async () => {
    vi.useFakeTimers();
    const f = harness(), intent = original(); f.values.set(primaryKey, JSON.stringify(pending(intent)));
    f.fetcher.mockImplementation(async (url, init) => init?.method === "GET" && String(url).includes(`/commands/${id(100)}`)
      ? response(missing(intent, "1")) : f.handler(url, init));
    await f.view.refresh(); await tick();
    expect(f.view.snapshot()).toMatchObject({ phase: "unknown", submittedText: "Haus", draft: "Haus", question: { id: id(6) }, canSubmit: false,
      canRetryPrimary: false, commands: { recovery: { state: { name: "counter_unknown" } } } });
    f.view.setDraft("must not replace saved input"); await f.view.submit(); await f.view.retry();
    for (let second = 0; second < 120; second += 5) await tick(5000);
    expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    expect(f.view.snapshot()).toMatchObject({ phase: "unknown", submittedText: "Haus" });
  });
  it.each(["pair", "client", "profile"])("pending text from another %s is never inserted into the current question", async source => {
    const f = harness(), saved = pending();
    if (source === "pair") saved.pair = "en-de";
    if (source === "client") saved.clientInstanceId = id(90);
    if (source === "profile") saved.profileId = id(90);
    f.values.set(primaryKey, JSON.stringify(saved));
    if (source !== "profile") f.fetcher.mockResolvedValueOnce(response(missing(saved.intent, "1")));
    await f.view.refresh(); expect(f.view.snapshot().submittedText).toBeNull(); expect(f.view.snapshot().draft).toBe("");
    expect(f.posts()).toEqual([]);
  });
  it("unavailable current removes the question without assigning the old draft to another card", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("my draft");
    f.fetcher.mockResolvedValueOnce(response({ current: { session_id: id(3), status: "unavailable" }, state_version: "2" }));
    await f.view.refresh(); expect(f.view.snapshot()).toMatchObject({ phase: "stale", question: null, canSubmit: false, draft: "my draft" });
    expect(f.posts()).toEqual([]);
  });
  it.each([false, true])("restored assignment keeps only its own draft (different assignment: %s)", async different => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("unfinished A");
    f.fetcher.mockResolvedValueOnce(response({ current: { session_id: id(3), status: "unavailable" }, state_version: "1" }));
    await f.view.refresh();
    if (different) f.setStep({ ...current(), assignment: { ...current().assignment!, id: id(90) } });
    await f.view.refresh();
    expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { id: different ? id(90) : id(6) },
      draft: different ? "" : "unfinished A" });
    expect(f.posts()).toEqual([]);
  });
  it.each(["reply", "failure"])("an older foreground read %s cannot leave a pending Stop", async completion => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("A");
    const reading = deferred<Response>(), stopping = deferred<Response>();
    f.fetcher.mockReturnValueOnce(reading.promise);
    const refresh = f.view.refresh(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    f.fetcher.mockReturnValueOnce(stopping.promise);
    const stop = f.view.stop(); await vi.waitFor(() => expect(f.posts()).toHaveLength(1));
    if (completion === "reply") reading.resolve(response({ current: current(), state_version: "1" }));
    else reading.reject(new Error("offline"));
    await refresh;
    expect(f.view.snapshot()).toMatchObject({ phase: "stopping", question: null, draft: "", canSubmit: false, timer: null });
    f.view.setDraft("must not return"); expect(f.view.snapshot().draft).toBe("");
    const call = f.fetcher.mock.calls.at(-1)!; stopping.resolve(await f.handler(...call)); await stop;
    expect(f.view.snapshot().phase).toBe("closed");
  });
  it.each([false, true])("foreground refresh preserves B and its draft (previous result: %s)", async previous => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit(); await f.view.next();
    f.view.setDraft("B draft"); if (previous) f.view.previousResult();
    await f.view.refresh();
    expect(f.view.snapshot()).toMatchObject({ phase: previous ? "previous_result" : "question", draft: "B draft", timer: null });
    if (previous) await f.view.next();
    expect(f.view.snapshot()).toMatchObject({ question: { id: id(7) }, draft: "B draft" });
    expect(f.posts().map(x => x.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it.each([false, true])("new foreground access during a read gets its own fresh reply (previous result: %s)", async previous => {
    const f = harness(); await f.view.refresh();
    if (previous) { f.wrong(); f.view.setDraft("wrong A"); await f.view.submit(); await f.view.next(); }
    f.view.setDraft("own draft"); if (previous) f.view.previousResult();
    const postsBefore = f.posts().length, getsBefore = f.fetcher.mock.calls.length;
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const old = f.view.refresh(); await vi.waitFor(() => expect(f.fetcher.mock.calls.length).toBe(getsBefore + 1));
    const call = f.fetcher.mock.calls.at(-1)!; const oldReply = await f.handler(...call);
    f.replace({}, "new-synthetic-token"); const fresh = f.view.refresh();
    gate.resolve(oldReply); await Promise.all([old, fresh]);
    expect(f.view.snapshot()).toMatchObject({ phase: previous ? "previous_result" : "question", draft: "own draft" });
    expect(f.fetcher.mock.calls.length).toBeGreaterThan(getsBefore + 1);
    const latest = f.fetcher.mock.calls.at(-1)!;
    expect(new Headers(latest[1]?.headers).get("Authorization")).toBe("Bearer new-synthetic-token");
    expect(f.posts()).toHaveLength(postsBefore);
  });
  it("coalesces repeated foreground refreshes and follows another access change during the queued read", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("keep");
    const first = deferred<Response>(), second = deferred<Response>(); f.fetcher.mockReturnValueOnce(first.promise);
    const old = f.view.refresh(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    const replyA = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.replace({}, "synthetic-b"); const queued = f.view.refresh(), duplicate = f.view.refresh();
    f.fetcher.mockReturnValueOnce(second.promise); first.resolve(replyA);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    const replyB = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.replace({}, "synthetic-c"); const latest = f.view.refresh(); second.resolve(replyB);
    await Promise.all([old, queued, duplicate, latest]);
    expect(f.fetcher).toHaveBeenCalledTimes(4); expect(f.posts()).toEqual([]);
    expect(new Headers(f.fetcher.mock.calls.at(-1)![1]?.headers).get("Authorization")).toBe("Bearer synthetic-c");
    expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "keep", canSubmit: true });
  });
  it("the same live foreground handle shares its pending read without an extra GET", async () => {
    const f = harness(); await f.view.refresh(); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const first = f.view.refresh(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    const second = f.view.refresh(); gate.resolve(await f.handler(...f.fetcher.mock.calls.at(-1)!));
    await Promise.all([first, second]); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.posts()).toEqual([]);
  });
  it("a subscriber-started read between foreground handles cannot make the refresh queue await itself", async () => {
    const f = harness(); await f.view.refresh();
    const first = deferred<Response>(), second = deferred<Response>(); f.fetcher.mockReturnValueOnce(first.promise);
    const old = f.view.refresh(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    const replyA = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.replace({}, "synthetic-b"); const queued = f.view.refresh();
    let intervening: Promise<void> | undefined;
    f.onUpdate.mockImplementation(snapshot => {
      if (snapshot.phase !== "stale" || intervening) return;
      // Mark first: refresh itself can publish synchronously.
      intervening = Promise.resolve(); f.fetcher.mockReturnValueOnce(second.promise);
      intervening = f.view.refresh(); f.replace({}, "synthetic-c");
    });
    first.resolve(replyA); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(3));
    second.resolve(await f.handler(...f.fetcher.mock.calls.at(-1)!)); await Promise.all([old, queued, intervening]);
    expect(f.view.snapshot().phase).toBe("question"); expect(f.fetcher).toHaveBeenCalledTimes(4); expect(f.posts()).toEqual([]);
  });
  it("late authorization refusal from the old foreground handle cannot revoke the queued fresh read", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("keep");
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const old = f.view.refresh(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    f.replace({}, "synthetic-new"); const fresh = f.view.refresh();
    gate.resolve(response({ error: { code: "ACCESS_DENIED", message: "synthetic" } }, 403));
    await Promise.all([old, fresh]); expect(f.onDenied).not.toHaveBeenCalled();
    expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "keep" }); expect(f.posts()).toEqual([]);
  });
  it.each(["stop", "dispose", "document"] as const)("queued foreground read cannot reopen a lesson after %s", async ending => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("discarded");
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const old = f.view.refresh(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    const oldReply = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.replace({}, "synthetic-new"); const fresh = f.view.refresh();
    if (ending === "stop") await f.view.stop();
    else if (ending === "dispose") f.view.dispose();
    else f.replace({ document_id: id(91) });
    const calls = f.fetcher.mock.calls.length; gate.resolve(oldReply); await Promise.all([old, fresh]);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(f.view.snapshot()).toMatchObject({ phase: ending === "stop" ? "closed" : "disposed", question: null, draft: "" });
  });
  it("pending answer receipt follows the new handle without another submission", async () => {
    vi.useFakeTimers(); const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("exact answer");
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost response"); });
    // The machine's check by ID goes through the old handle and is held there.
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    await f.view.submit(); await tick(); expect(f.view.snapshot().phase).toBe("unknown");
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    const oldReply = await f.handler(...f.fetcher.mock.calls.at(-1)!);
    f.replace({}, "synthetic-new"); const fresh = f.view.refresh(); gate.resolve(oldReply);
    await fresh; await tick(5000);
    expect(f.view.snapshot()).toMatchObject({ phase: "result_wrong", draft: "", answer: { result: { grade: 2 } } });
    const checks = f.fetcher.mock.calls.filter(call => call[1]?.method === "GET" && String(call[0]).includes("/commands/"));
    expect(checks.at(-1)![1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-new" });
    expect(f.posts().map(post => post.kind)).toEqual(["answer.submit"]); expect(f.values.has(primaryKey)).toBe(false);
  });
  it("a lost correction is recovered without changing the next question's draft", async () => {
    vi.useFakeTimers();
    const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("wrong"); await f.view.submit(); await f.view.next();
    f.view.setDraft("B draft"); f.view.previousResult();
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost response"); });
    await f.view.correct(); expect(f.view.snapshot()).toMatchObject({ draft: "B draft", canCorrect: false, timer: null });
    await tick(); expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", draft: "B draft", answer: { result: { grade: 4 } } });
    await f.view.next(); expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) }, draft: "B draft" });
    expect(f.posts().filter(x => x.kind === "result.correct")).toHaveLength(1);
  });
  it("Known during preview presents the first assignment using the acknowledged projection", async () => {
    const f = harness("normal", null); await f.view.refresh(); await f.view.start(); await f.view.advancePreview(true);
    expect(f.posts().map(x => x.kind)).toEqual(["session.start", "learning.known", "assignment.present"]);
    expect(f.view.snapshot()).toMatchObject({ phase: "question", question: { status: "presented" } });
  });
  it.each([false, true])("a rejected grade retains the addressed result (previous result: %s)", async previous => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    if (previous) { await f.view.next(); f.view.setDraft("B draft"); f.view.previousResult(); }
    const before = f.view.snapshot();
    f.fetcher.mockImplementationOnce(async (_url, init) => response({ ...before.answer, step: before.current,
      state_version: before.commands.stateVersion, command: { id: JSON.parse(String(init?.body)).command_id, status: "rejected" },
      error: { code: "VALIDATION_FAILED" } }, 422));
    await f.view.grade(5);
    expect(f.view.snapshot()).toMatchObject({ phase: previous ? "previous_result" : "result_correct", timer: null,
      answer: { result: { grade: 4 } }, draft: previous ? "B draft" : "", problem: "VALIDATION_FAILED", canNext: true });
    expect(f.posts().filter(x => x.kind === "assignment.present")).toHaveLength(previous ? 1 : 0);
  });
  it("a rejected correction remains on the wrong result without sending another answer", async () => {
    const f = harness(); f.wrong(); await f.view.refresh(); f.view.setDraft("wrong"); await f.view.submit();
    const before = f.view.snapshot();
    f.fetcher.mockImplementationOnce(async (_url, init) => response({ ...before.answer, step: before.current,
      state_version: before.commands.stateVersion, command: { id: JSON.parse(String(init?.body)).command_id, status: "rejected" },
      error: { code: "VALIDATION_FAILED" } }, 422));
    await f.view.correct(); expect(f.view.snapshot()).toMatchObject({ phase: "result_wrong", canCorrect: true,
      answer: { result: { grade: 2 } }, timer: null, problem: "VALIDATION_FAILED" });
    expect(f.posts().map(x => x.kind)).toEqual(["answer.submit", "result.correct"]);
  });
  it("a lost accepted Stop is recovered by reading its original outcome", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("unfinished");
    f.fetcher.mockImplementationOnce(async (...call) => { await f.handler(...call); throw new Error("lost response"); });
    await f.view.stop(); expect(f.view.snapshot()).toMatchObject({ phase: "stopping", draft: "", canSubmit: false });
    await f.view.refresh(); expect(f.view.snapshot()).toMatchObject({ phase: "closed", question: null, answer: null });
    expect(f.posts().map(x => x.kind)).toEqual(["session.stop"]);
  });
  it("Stop closes while B presentation is delayed and its late acknowledgement cannot return B", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise); const present = f.view.next();
    await vi.waitFor(() => expect(f.posts()).toHaveLength(2));
    const old = await f.handler(...f.fetcher.mock.calls.at(-1)!); f.view.setDraft("B draft");
    await f.view.stop(); gate.resolve(old); await present;
    expect(f.view.snapshot()).toMatchObject({ phase: "closed", question: null, answer: null, draft: "", timer: null });
    expect(f.posts().map(x => x.kind)).toEqual(["answer.submit", "assignment.present", "session.stop"]);
  });
  it("a confirmed rejection preserves the input and exposes the actual reason", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("bad input");
    f.fetcher.mockImplementationOnce(async (_url, init) => {
      const command = JSON.parse(String(init?.body));
      return response({ command: { id: command.command_id, status: "rejected" }, action: null, result: null, step: current(), state_version: "1",
        capabilities: { answer_target: id(6), grades: null, correct_target: null, undo_target: null, stop: true, summary_home: false },
        error: { code: "VALIDATION_FAILED" } }, 422);
    });
    await f.view.submit(); expect(f.view.snapshot()).toMatchObject({ phase: "question", draft: "bad input", problem: "VALIDATION_FAILED", canSubmit: true });
    expect(f.values.has(primaryKey)).toBe(false);
  });
  it.each(["stop", "dispose", "revoke", "previous"])("an old timer callback cannot act after %s", async change => {
    vi.useFakeTimers(); const f = harness(); const spy = vi.spyOn(globalThis, "setTimeout");
    await f.view.refresh(); f.view.setDraft("Haus"); await f.view.submit();
    const old = spy.mock.calls.find(call => call[1] === 3000)![0] as () => void;
    if (change === "stop") await f.view.stop();
    else if (change === "dispose") f.view.dispose();
    else if (change === "revoke") f.revoke();
    else { await f.view.next(); f.view.setDraft("B"); f.view.previousResult(); }
    const count = f.posts().length; old(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.posts()).toHaveLength(count);
    if (change === "previous") expect(f.view.snapshot()).toMatchObject({ phase: "previous_result", timer: null, draft: "B" });
    spy.mockRestore();
  });
  it("end-of-pass is a summary view; only its explicit Home action closes the session", async () => {
    const f = harness(); await f.view.refresh(); f.view.setDraft("Haus");
    f.fetcher.mockImplementationOnce(async (...call) => {
      const sent = await f.handler(...call), data = await sent.json();
      const summary: LearningSessionProjection = { ...data.step, status: "summary", assignment: null };
      f.setStep(summary); data.step = summary; data.capabilities.answer_target = null; data.capabilities.summary_home = true;
      return response(data);
    });
    await f.view.submit(); await f.view.next(); expect(f.view.snapshot().phase).toBe("summary");
    expect(f.posts().map(x => x.kind)).toEqual(["answer.submit"]); await f.view.stop("summary_home");
    expect(f.posts()[1]).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } });
    expect(f.view.snapshot().phase).toBe("closed");
  });
});
