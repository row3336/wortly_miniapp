// Automatic recovery of a Learning study action (M-RECOV-AUTO CP2b, CT §6.1, D-RECOV table 8) through the real view,
// document lanes and transport over the synthetic Learning server, on fake time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { current, id, missing, primaryKey, response } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import type { LearningViewController } from "./learningViewController";

type Request = { method: string; path: string; kind: string | null };
/** undefined: the synthetic server answers; "drop": the request fails before the server; a Response replaces the answer. */
type Route = (request: Request) => undefined | "drop" | Response;

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness(sessionId: string | null = id(3)) {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", sessionId); owners.push(f.view);
  const begun = performance.now(), sentAt: { kind: string; at: number }[] = [];
  let route: Route = () => undefined;
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
    const kind = method === "POST" ? JSON.parse(String(init!.body)).kind as string : null;
    if (kind) sentAt.push({ kind, at: performance.now() - begun });
    const decision = route({ method, path, kind });
    if (decision === "drop") throw new TypeError("network");
    if (decision) return decision;
    try { return await f.handler(url, init); } catch (error) {
      // The synthetic server answers a status only for a command it holds: any other ID is not found (core command_status).
      if (method !== "GET" || !path.startsWith("/api/v1/commands/")) throw error;
      return response(missing({ command_id: path.split("/").at(-1)!, session_id: id(3) } as never, f.view.snapshot().commands.stateVersion));
    }
  });
  const sends = (kind: string) => f.posts().filter(post => post.kind === kind);
  const times = (kind: string) => sentAt.filter(entry => entry.kind === kind).map(entry => entry.at);
  const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); };
  const recovery = () => f.view.snapshot().commands.recovery;
  return { ...f, sends, times, run, recovery, route: (next: Route) => { route = next; } };
}
const preview = async (h: ReturnType<typeof harness>) => { await h.view.refresh(); await h.view.start(); await tick(); };

describe("the budget of one Learning action (Я15.5, Я15.6)", () => {
  it("six lost answers: exactly six POSTs 2, 5, 10, 20, 30 s apart with one body, then nothing", async () => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await h.view.submit(); await tick();
    await h.run(70_000); await h.run(9 * 60_000, 30_000);
    const times = h.times("answer.submit");
    expect(times.map(at => at - times[0])).toEqual([0, 2000, 7000, 17000, 37000, 67000]);
    expect(new Set(h.sends("answer.submit").map(post => JSON.stringify(post))).size).toBe(1);
    expect(h.recovery()).toMatchObject({ state: { name: "exhausted" }, sends: 6, transmitted: 6 });
    expect(h.posts().map(post => post.kind)).toEqual(Array(6).fill("answer.submit"));
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", canRetryPrimary: false, canStop: true });
  });
  it("a lost answer committed on the server is shown by its ID, with its timer from the confirmation, never sent again", async () => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    let lost = false;
    h.fetcher.mockImplementationOnce(async (url, init) => { await h.handler(url, init); lost = true; throw new TypeError("network"); });
    await h.view.submit(); await tick();
    expect(lost).toBe(true);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", timer: { durationMs: 3000 } });
    await tick(2999); expect(h.posts().map(post => post.kind)).toEqual(["answer.submit"]);
    await tick(1); expect(h.posts().map(post => post.kind)).toEqual(["answer.submit", "assignment.present"]);
  });
  it("in the background nothing is requested; the return checks and goes on with the same budget (Я15.3)", async () => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    h.route(request => request.kind === "answer.submit" && h.sends("answer.submit").length === 1 ? "drop" : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    h.view.suspend(); const calls = h.fetcher.mock.calls.length;
    await h.run(5 * 60_000, 5000);
    expect(h.fetcher.mock.calls.length).toBe(calls);
    h.replace(); await h.view.resume(); await tick();
    const [first, second] = h.sends("answer.submit");
    expect(second).toEqual(first);
    expect(h.recovery()).toMatchObject({ state: { name: "settled" }, sends: 2 });
    expect(h.view.snapshot().phase).toBe("result_correct");
  });
  it("another route or unconfirmed settings stop the view, not the recovery (Я15.7, RESULTS_VP 9.1.5)", async () => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    h.route(request => request.kind === "answer.submit" && h.sends("answer.submit").length === 1 ? "drop" : undefined);
    await h.view.submit(); await tick();
    h.view.suspend("disabled"); await h.run(3000);
    expect(h.sends("answer.submit")).toHaveLength(2);
    expect(h.recovery()).toMatchObject({ state: { name: "settled" }, sends: 2 });
  });
});

describe("a preview step: «Дальше» and «Уже знаю»", () => {
  it.each([false, true])("a lost preview transition (known: %s) is checked by its ID and sent again with it; the preview stays its step", async known => {
    const h = harness(null); await preview(h);
    const kind = known ? "learning.known" : "learning.preview_next";
    h.route(request => request.kind === kind && h.sends(kind).length === 1 ? "drop" : undefined);
    await h.view.advancePreview(known); await tick();
    // Still the same preview on the server: a confirmed absence, not a changed step.
    expect(h.recovery()?.state.name).toBe("retry_wait");
    expect(h.view.snapshot()).toMatchObject({ canAdvancePreview: false, canRetryPrimary: false });
    await h.run(2000); await tick();
    const [first, second] = h.sends(kind);
    expect(second).toEqual(first);
    // Each send follows a check by the same ID: one after the loss, one right before the retry (Я15.6).
    expect(h.fetcher.mock.calls.filter(call => call[1]?.method === "GET" && String(call[0]).includes(`/commands/${first.command_id}`))).toHaveLength(2);
    expect(h.posts().map(post => post.kind)).toEqual(["session.start", kind, kind, "assignment.present"]);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { status: "presented" } });
  });
  it("«Уже знаю» refused for good: the record goes, the preview takes a new tap with a new ID, the old one is never sent again", async () => {
    const h = harness(null); await preview(h);
    let refuse = true;
    h.route(request => request.kind === "learning.known" && refuse ? response({ error: { code: "VALIDATION_FAILED" } }, 422) : undefined);
    await h.view.advancePreview(true); await tick();
    const [old] = h.sends("learning.known");
    expect(h.recovery()?.state).toEqual({ name: "refused", code: "VALIDATION_FAILED" });
    expect(h.view.snapshot()).toMatchObject({ phase: "preview", canAdvancePreview: true, problem: null,
      commands: { primary: { pending: false } } });
    expect(h.values.has(primaryKey)).toBe(false);
    await h.run(60_000);
    expect(h.sends("learning.known")).toHaveLength(1);
    refuse = false; await h.view.advancePreview(true); await tick();
    const known = h.sends("learning.known");
    expect(known).toHaveLength(2); expect(known[1].command_id).not.toBe(old.command_id);
    expect(h.view.snapshot().phase).toBe("question");
  });
});

describe("refusals and Stop", () => {
  it("another payload under the same ID is a conflict: never resent, the record stays (Я17)", async () => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    h.route(request => request.kind === "answer.submit" ? response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409) : undefined);
    await h.view.submit(); await tick(); await h.run(60_000);
    expect(h.sends("answer.submit")).toHaveLength(1);
    expect(h.recovery()?.state.name).toBe("conflict");
    expect(h.view.snapshot()).toMatchObject({ canSubmit: false, canStop: true, commands: { canBegin: false, primary: { pending: true } } });
    expect(h.values.has(primaryKey)).toBe(true);
  });
  it("Stop with summary_home stays manual: a lost one is never repeated by itself, only by its explicit retry", async () => {
    const h = harness(); h.setStep({ ...current(), status: "summary", assignment: null });
    await h.view.refresh();
    let dropStop = true;
    h.route(request => request.kind === "session.stop" && dropStop ? "drop" : undefined);
    expect(h.view.snapshot().phase).toBe("summary");
    await h.view.stop("summary_home"); await tick(); await h.run(60_000);
    expect(h.sends("session.stop")).toHaveLength(1);
    expect(h.recovery()).toBeNull();
    await h.view.refresh(); expect(h.view.snapshot().commands.stop.canRetry).toBe(true);
    dropStop = false; await h.view.retry("stop"); await tick();
    expect(h.sends("session.stop").map(post => post.payload)).toEqual([{ reason: "summary_home" }, { reason: "summary_home" }]);
    expect(h.view.snapshot().phase).toBe("closed");
  });
});

describe("a step that moved on elsewhere (step_stale) and the commands that stay manual (QA CP2b P5)", () => {
  it.each([false, true])("a lost preview transition (known: %s) whose preview moved on: the record goes, the server's question is shown", async known => {
    const h = harness(null); await preview(h);
    const kind = known ? "learning.known" : "learning.preview_next";
    h.route(request => request.kind === kind ? "drop" : undefined);
    await h.view.advancePreview(known); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    // Another window went past the preview: the current step is a question, not yet shown.
    const sessionId = h.view.snapshot().sessionId!;
    h.setStep({ ...current(sessionId), assignment: { ...current().assignment!, status: "prefetched" } });
    await h.run(5000);
    expect(h.recovery()?.state).toEqual({ name: "terminated", reason: "step_stale" });
    expect(h.values.has(primaryKey)).toBe(false);
    expect(h.sends(kind)).toHaveLength(1);
    expect(h.sends("assignment.present")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { status: "presented" }, problem: null,
      commands: { primary: { pending: false } } });
  });
  it("a lost answer whose card was answered elsewhere: the record goes, the next card is presented as usual", async () => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    h.setStep({ ...current(), assignment: { ...current().assignment!, id: id(7), status: "prefetched" } });
    await h.run(5000);
    expect(h.recovery()?.state).toEqual({ name: "terminated", reason: "step_stale" });
    expect(h.values.has(primaryKey)).toBe(false);
    expect(h.sends("answer.submit")).toHaveLength(1);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7), status: "presented" }, problem: null,
      commands: { primary: { pending: false } } });
  });
  it("session.start and assignment.present stay manual (4.6-В1, 4.6-В2): lost ones are never resent by themselves", async () => {
    const start = harness(null); await start.view.refresh(); await tick();
    start.route(request => request.kind === "session.start" ? "drop" : undefined);
    await start.view.start(); await tick(); await start.run(5 * 60_000, 5000);
    expect(start.sends("session.start")).toHaveLength(1);
    expect(start.view.snapshot().commands).toMatchObject({ automaticPrimary: false, recovery: null });
    const shown = harness();
    shown.setStep({ ...current(), assignment: { ...current().assignment!, status: "prefetched" } });
    shown.route(request => request.kind === "assignment.present" ? "drop" : undefined);
    await shown.view.refresh(); await tick(); await shown.run(5 * 60_000, 5000);
    expect(shown.sends("assignment.present")).toHaveLength(1);
    expect(shown.view.snapshot().commands).toMatchObject({ automaticPrimary: false, recovery: null });
  });
});
