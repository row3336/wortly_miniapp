// Automatic recovery of a written study action (M-RECOV-AUTO CP2, CT §6.1, D-RECOV table 8) through the real view,
// document lanes and HTTP transport over the synthetic written server, on fake time.
import { installTestSendBudget } from "../commands/budget.test-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenIntent } from "./writtenIntent";
import { WrittenDocumentCommands } from "./writtenDocumentCommands";
import { WrittenViewController } from "./writtenViewController";
import { deferred, id, profile, response, tick, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";
import { createOpenedAccess } from "../app/openedAccess";
import { staleCommand } from "../app/openRules.test-support";
import { writtenPrimaryKey } from "./writtenPending";
import { cancelDue } from "../commands/startCancel";
import { pageMarks } from "../commands/budget.test-support";
import { pendingRaw, hasPending } from "../commands/pendingSeed.test-support";

/** The core's DOCUMENT_STALE envelope of this command (study/coordinator.py; an answer kind is flattened). */
const stale = (request: Request) => response(staleCommand(request.body!.command_id, request.body!.session_id, 1, request.kind!), 409);

type Request = { method: string; path: string; kind: string | null;
  body: { command_id: string; session_id: string; document_id: string } | null };
/** undefined passes the request to the server; "drop" fails it before the server, "lose" after its commit. */
type Route = (request: Request) => undefined | "drop" | "lose" | Response;

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness(options: ServerOptions & { saved?: Partial<Record<"primary" | "stop", WrittenIntent>> } = {}, sessionId: string | null = null,
  minimumStateVersion?: () => string | null) {
  vi.useFakeTimers();
  const f = writtenFixture(options);
  const own = () => {
    const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
      sessionId, transitionMode: () => "normal", minimumStateVersion, onUpdate: vi.fn() });
    owners.push(view);
    return view;
  };
  const view = own();
  const begun = performance.now();
  /** Fake times (ms since the harness began) of every answer POST that reached the transport. */
  const sentAt: number[] = [];
  /** Every request with its fake time. */
  const log: { at: number; method: string; path: string; kind: string | null }[] = [];
  let route: Route = () => undefined;
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
    const body = method === "POST" ? JSON.parse(String(init!.body)) : null, kind = body ? body.kind as string : null;
    if (kind === "answer.submit") sentAt.push(performance.now() - begun);
    log.push({ at: performance.now() - begun, method, path, kind });
    const decision = route({ method, path, kind, body });
    if (decision === "drop") throw new TypeError("network");
    if (decision === "lose") { await f.server.handle(url as RequestInfo, init); throw new TypeError("network"); }
    return decision ?? f.server.handle(url as RequestInfo, init);
  });
  const answers = () => f.posts().filter(post => post.kind === "answer.submit");
  const kinds = () => f.posts().map(post => post.kind as string);
  const checks = (commandId: string) => f.gets(`/commands/${commandId}`).length;
  const started = async (text = "Haus") => { await view.refresh(); await view.start("words"); view.setDraft(text); };
  /** Moves fake time in steps, so every check and send of the machine runs at its own moment. */
  const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); };
  const recovery = () => view.snapshot().commands.recovery;
  return { ...f, view, own, answers, kinds, checks, started, run, recovery, sentAt, log, since: () => performance.now() - begun,
    route: (next: Route) => { route = next; } };
}
const lostAnswers: Route = request => request.kind === "answer.submit" ? "drop" : undefined;

describe("lost reply, then the same command (8.1, 8.2)", () => {
  it("the same command_id and body are sent again only after a check that confirmed absence", async () => {
    const h = harness(); await h.started();
    let drops = 1; h.route(request => request.kind === "answer.submit" && drops-- > 0 ? "drop" : undefined);
    await h.view.submit(); await tick();
    const [first] = h.answers();
    expect(h.checks(first.command_id)).toBe(1);
    await h.run(2000); await tick();
    const [, second] = h.answers();
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(h.checks(first.command_id)).toBe(2);
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } } });
    expect(h.recovery()).toMatchObject({ state: { name: "settled", outcome: "accepted" }, sends: 2, transmitted: 2 });
  });
});

describe("a read during the first send", () => {
  it("waits for that send: an accepted reply below a newer confirmed version is shown by its exact result", async () => {
    let floor: string | null = null;
    const h = harness({}, null, () => floor); await h.started();
    // The answer commits now; its reply (with the version of that moment) arrives only after a newer version is known.
    const gate = deferred<void>();
    h.fetcher.mockImplementationOnce(async (...call) => { const reply = await h.server.handle(...call); await gate.promise; return reply; });
    const sending = h.view.submit(); await tick();
    expect(h.answers()).toHaveLength(1);
    h.server.state.version += 5; floor = String(h.server.state.version);
    const reading = h.view.refresh(); await tick();
    gate.resolve(); await sending; await reading; await tick();
    expect(h.view.snapshot()).toMatchObject({ phase: "result_correct", answer: { result: { grade: 4 } } });
    expect(h.fetcher.mock.calls.some(call => new URL(String(call[0]), "http://localhost").searchParams.has("result_id"))).toBe(true);
    expect(h.answers()).toHaveLength(1);
  });
});

describe("the budget of one action (Я15.5, Я15.6, 8.3)", () => {
  it("six losses in a row: exactly six POSTs, 2, 5, 10, 20 and 30 s apart, then only the closure C naming X", async () => {
    const h = harness(); await h.started(); h.route(lostAnswers);
    await h.view.submit(); await tick();
    // One-second steps for the exact moments, then coarse steps for the rest of ten minutes.
    await h.run(70_000); await h.run(9 * 60_000, 30_000);
    expect(h.sentAt.map(at => at - h.sentAt[0])).toEqual([0, 2000, 7000, 17000, 37000, 67000]);
    const ids = new Set(h.answers().map(post => JSON.stringify(post)));
    expect(ids.size).toBe(1);
    // The six sends are spent; the automatic closure below then ends the machine with its session (CT §6.1 п.7).
    expect(h.recovery()).toMatchObject({ state: { name: "terminated", reason: "session_closed" }, sends: 6, transmitted: 6, remaining: 0 });
    // CP4b (CON §6.1 п.8; project notices §4.1; before M1b nothing followed here): the session is closed automatically
    // — one session.stop save_failed naming X, its own new command_id — and nothing else is sent.
    expect(h.kinds()).toEqual(["session.start", "assignment.present", ...Array(6).fill("answer.submit"), "session.stop"]);
    const close = h.posts().at(-1)!, x = h.answers()[0].command_id;
    expect(close.payload).toEqual({ reason: "save_failed", unsaved_command_id: x });
    expect(close.command_id).not.toBe(x);
    expect(h.server.lostAnswers).toEqual([{ sessionId: close.session_id, commandId: x, reason: "save_failed" }]);
    expect(h.view.snapshot()).toMatchObject({ phase: "closed" });
  });
  it("whatever the server answers, one action never goes out more than six times (random replies, 40 runs)", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      // Every run is a page of its own with its own durable store (CP5b): the harness gives each run the same IDs.
      installTestSendBudget();
      let state = seed;
      const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
      const h = harness(); await h.started();
      const replies = ["drop", "lose", "maintenance", "unavailable", "pass"] as const;
      // Every answer send with what the server held at that moment: the independent evidence of how a settled one was told.
      const sent: { committedBefore: boolean; reply: (typeof replies)[number] }[] = [];
      h.route(request => {
        if (request.method === "GET" && request.path.startsWith("/api/v1/commands/")) return random() < 0.3 ? "drop" : undefined;
        if (request.kind !== "answer.submit") return undefined;
        const reply = replies[Math.floor(random() * replies.length)];
        sent.push({ committedBefore: h.server.receipts.has(request.body!.command_id), reply });
        if (reply === "maintenance") return response({ error: { code: "MAINTENANCE", wait_seconds: Math.floor(random() * 40) } }, 503);
        if (reply === "unavailable") return response({ error: { code: "WRITE_UNAVAILABLE" } }, 503);
        return reply === "pass" ? undefined : reply;
      });
      await h.view.submit(); await h.run(15 * 60_000, 5000);
      const answers = h.answers();
      expect(answers.length).toBeLessThanOrEqual(6);
      expect(new Set(answers.map(post => JSON.stringify(post))).size).toBe(1);
      // A confirmed answer is shown; never sent again after the confirmation. The server told it as "recorded now" only
      // if the last send passed and nothing held the answer before that send: then the next card follows after its 3 s.
      // Told in any other way (a status check of its ID, or the reply to a repeated send, «уже записан»), it waits for
      // «Далее» (Q03). The branch is fixed by the traffic above, not by the flag under test.
      if (h.recovery()?.state.name === "settled") {
        expect(h.server.receipts.has(answers[0].command_id)).toBe(true);
        const last = sent.at(-1)!, live = last.reply === "pass" && !last.committedBefore;
        expect(h.view.snapshot().commands.primary.resolved?.checked).toBe(live ? undefined : true);
        expect(h.view.snapshot()).toMatchObject(live ? { phase: "question", question: { id: id(7) } }
          : { phase: "result_correct", timer: null, canNext: true });
      }
      owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers();
    }
  }, 60_000);
});

describe("the mark that a question was shown (assignment.present; owner answers Q25.1, Q25.2 of 08.10.2026)", () => {
  const presents = (h: ReturnType<typeof harness>) => h.posts().filter(post => post.kind === "assignment.present");
  it("a lost present goes again by itself with the same ID after a check; meanwhile the question is typed, its answer waits", async () => {
    const h = harness(); await h.view.refresh();
    let drops = 1; h.route(request => request.kind === "assignment.present" && drops-- > 0 ? "drop" : undefined);
    await h.view.start("words"); await tick();
    const [lost] = presents(h);
    expect(h.recovery()).toMatchObject({ commandId: lost.command_id, state: { name: "retry_wait" }, sends: 1 });
    expect(h.checks(lost.command_id)).toBe(1);
    // The question the server issued is shown and typed; it is not confirmed by being issued (Q25.1, Q25.2).
    expect(h.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", question: { id: lost.assignment_id, status: "prefetched" },
      canEditDraft: true, canSubmit: false, canForget: false, canRetryPrimary: false, commands: { automaticPrimary: true } });
    h.view.setDraft("Haus"); await h.view.submit(); await h.view.submit({ forgot: true }); await h.view.retry();
    expect(h.kinds()).toEqual(["session.start", "assignment.present"]);
    await h.run(2000); await tick();
    expect(presents(h).map(post => JSON.stringify(post))).toEqual([JSON.stringify(lost), JSON.stringify(lost)]);
    expect(h.checks(lost.command_id)).toBe(2);
    expect(h.recovery()).toMatchObject({ commandId: lost.command_id, state: { name: "settled", outcome: "accepted" }, sends: 2 });
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { status: "presented" }, draft: "Haus", canSubmit: true });
    await h.view.submit(); await tick();
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "assignment.present", "answer.submit"]);
  });
  it("six lost presents: exactly six POSTs, 2, 5, 10, 20 and 30 s apart, then nothing; the answer is never sent", async () => {
    const h = harness(); await h.view.refresh();
    h.route(request => request.kind === "assignment.present" ? "drop" : undefined);
    await h.view.start("words"); await tick(); h.view.setDraft("Haus");
    await h.run(70_000); await h.run(9 * 60_000, 30_000);
    const times = h.log.filter(entry => entry.kind === "assignment.present").map(entry => entry.at);
    expect(times.map(at => at - times[0])).toEqual([0, 2000, 7000, 17000, 37000, 67000]);
    expect(new Set(presents(h).map(post => JSON.stringify(post))).size).toBe(1);
    // CP4b (CON §6.1 п.8; before M1b nothing followed): the spent present closes the session with save_failed naming it.
    expect(h.recovery()).toMatchObject({ state: { name: "terminated", reason: "session_closed" }, sends: 6, transmitted: 6, remaining: 0 });
    await h.view.submit();
    expect(h.kinds()).toEqual(["session.start", ...Array(6).fill("assignment.present"), "session.stop"]);
    expect(h.posts().at(-1)!.payload).toEqual({ reason: "save_failed", unsaved_command_id: presents(h)[0].command_id });
    expect(h.view.snapshot()).toMatchObject({ phase: "closed", canSubmit: false, canRetryPrimary: false });
  });
});

describe("waiting for the server (Я15.4, Я15.7, 8.4)", () => {
  it("no connection for three minutes: checks at 5, 15, 35, 65, 95, 125, 155 s, no POST; then the check and the retry", async () => {
    const h = harness(); await h.started();
    let online = false;
    h.route(request => !online && request.method === "GET" ? "drop" : request.kind === "answer.submit" && h.answers().length === 1 ? "drop" : undefined);
    await h.view.submit(); await tick();
    const [first] = h.answers();
    expect(h.recovery()?.state).toMatchObject({ name: "unreachable" });
    const attempts: number[] = [];
    for (let second = 1; second <= 180; second++) {
      const before = h.checks(first.command_id);
      await tick(1000);
      if (h.checks(first.command_id) > before) attempts.push(second);
    }
    expect(attempts).toEqual([5, 15, 35, 65, 95, 125, 155]);
    expect(h.answers()).toHaveLength(1);
    online = true; await h.run(10_000);
    // The pause of retry №1 has long passed: the check that confirms absence sends at once.
    expect(h.answers()).toHaveLength(2);
    expect(h.answers()[1]).toEqual(first);
    // The confirmed result was shown and its timer moved on to the next card.
    expect(h.kinds()).toEqual(["session.start", "assignment.present", "answer.submit", "answer.submit", "assignment.present"]);
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
  });
});

describe("background and return (Я15.3, 8.5)", () => {
  it.each(["retry_wait", "unreachable"] as const)("in the background during %s nothing is requested; the return checks and keeps the budget", async waiting => {
    const h = harness(); await h.started();
    let online = waiting === "retry_wait";
    h.route(request => !online && request.method === "GET" ? "drop" : request.kind === "answer.submit" && h.answers().length === 1 ? "drop" : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe(waiting);
    h.view.suspend();
    const calls = h.fetcher.mock.calls.length;
    await h.run(5 * 60_000, 5000);
    expect(h.fetcher.mock.calls.length).toBe(calls);
    expect(h.recovery()).toMatchObject({ state: { name: "suspended" }, sends: 1 });
    online = true; h.replace(); await h.view.resume(); await tick();
    const [first, second] = h.answers();
    expect(second).toEqual(first);
    expect(h.recovery()).toMatchObject({ state: { name: "settled" }, sends: 2 });
    expect(h.view.snapshot().phase).toBe("result_correct");
  });
});

describe("activity is the visible window with a live document (Я15.7, RESULTS_VP 9.1.5; QA CP2 Н1)", () => {
  it("another route or unconfirmed settings stop the view, not the recovery: the retry goes out on time", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1 ? "drop" : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    h.view.suspend("disabled");
    await h.run(3000);
    expect(h.answers()).toHaveLength(2);
    expect(h.recovery()).toMatchObject({ state: { name: "settled" }, sends: 2 });
  });
});

describe("a reload with stage 1 counting (CT §6.1 п. 4, 8.6)", () => {
  it("after a reload (new page memory) the count is unknown: only checks, never a POST or an exhaustion", async () => {
    const saved: WrittenIntent = { command_id: id(400), session_id: id(3), kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } };
    const h = harness({ active: true, saved: { primary: saved } }, id(3));
    await h.view.refresh(); await h.run(60_000);
    expect(h.answers()).toEqual([]);
    expect(h.recovery()).toMatchObject({ state: { name: "counter_unknown", cause: "unknown" }, sends: null, remaining: null });
  });
});

describe("refusals during recovery (8.10–8.14)", () => {
  it("8.10 a planned pause: the send counts, nothing is probed or sent before its end, then the check and the retry", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1
      ? response({ error: { code: "MAINTENANCE", wait_seconds: 120 } }, 503) : undefined);
    await h.view.submit(); await tick();
    const [first] = h.answers();
    expect(h.recovery()).toMatchObject({ state: { name: "maintenance", pauseSeconds: 120 }, sends: 1 });
    const checks = h.checks(first.command_id);
    await h.run(119_000);
    expect(h.checks(first.command_id)).toBe(checks); expect(h.answers()).toHaveLength(1);
    await h.run(2000);
    expect(h.sentAt.map(at => at - h.sentAt[0])).toEqual([0, 120_000]);
    expect(h.view.snapshot().phase).toBe("result_correct");
  });
  it("8.11 WRITE_UNAVAILABLE counts the send and is checked like a lost reply", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1 ? response({ error: { code: "WRITE_UNAVAILABLE" } }, 503) : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()).toMatchObject({ state: { name: "retry_wait" }, sends: 1 });
    await h.run(3000);
    expect(h.answers()).toHaveLength(2); expect(h.recovery()).toMatchObject({ state: { name: "settled" }, sends: 2 });
  });
  it("8.12 the session closed meanwhile: the check before the retry stops it, nothing more is sent", async () => {
    const h = harness(); await h.started(); h.route(lostAnswers);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    Object.assign(h.server.state, { status: "closed", closeReason: "remote_stop", assignment: null, version: h.server.state.version + 1 });
    await h.run(60_000);
    expect(h.answers()).toHaveLength(1);
    expect(h.recovery()?.state).toEqual({ name: "terminated", reason: "session_closed" });
    expect(h.view.snapshot().phase).toBe("closed");
  });
  it("8.13 a lost admission during the wait stops the sends", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind === "answer.submit" ? "drop"
      : request.method === "GET" && h.answers().length === 1 && h.since() > 1000 ? response({ error: { code: "AUTH_EXPIRED" } }, 401) : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    await h.run(30_000);
    expect(h.answers()).toHaveLength(1);
    // The denial closes this access handle: the document shows nothing of the old session any more.
    expect(h.view.snapshot().phase).toBe("disposed");
  });
  it("8.14 DOCUMENT_STALE on a retry: nothing is sent until the window check; a replaced window ends without a send", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind !== "answer.submit" ? undefined
      : h.answers().length === 1 ? "drop" : stale(request));
    await h.view.submit(); await h.run(2000); await tick();
    expect(h.answers()).toHaveLength(2);
    expect(h.recovery()?.state.name).toBe("window_check");
    h.revoke(); await h.run(10_000);
    expect(h.answers()).toHaveLength(2);
    expect(h.recovery()).toBeNull();
    expect(h.view.snapshot().phase).toBe("disposed");
  });
  it("8.9 another payload under a saved ID is a conflict: never resent, no budget spent", async () => {
    const h = harness({ active: true }, id(3)); await h.view.refresh(); h.view.setDraft("Haus"); await h.view.submit();
    const sent = h.answers().at(-1)!;
    const other = harness({ active: true, saved: { primary: { ...sent, client_instance_id: undefined, document_id: undefined,
      payload: { text: "anders" } } as never } }, id(3));
    other.fetcher.mockImplementation(h.fetcher.getMockImplementation()!);
    await other.view.refresh(); await other.run(60_000);
    expect(other.answers()).toEqual([]);
    expect(other.recovery()).toMatchObject({ state: { name: "conflict" } });
    // The conflicting record stays until a confirmed closure (Я17, CP4): the lane keeps it, no new action starts.
    expect(other.view.snapshot()).toMatchObject({ problem: "mismatch", canRetryPrimary: false, canSubmit: false,
      commands: { canBegin: false, primary: { pending: true } } });
    expect(hasPending(other.values, "wortly.pending.written_session")).toBe(true);
  });
});

describe("D-STALE-WINDOW: the core's DOCUMENT_STALE envelope on a send (C091 §1)", () => {
  const intentOf = (post: Record<string, unknown>) => { const { client_instance_id: _c, document_id: _d, ...intent } = post; return intent; };
  const kept = (h: ReturnType<typeof harness>) => hasPending(h.values, writtenPrimaryKey) ? JSON.parse(pendingRaw(h.values, writtenPrimaryKey)!).intent : null;
  it("3.1.4 / 3.1.5 the first send refused, the window replaced: the record stays as sent, nothing more goes out", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind === "answer.submit" ? stale(request) : undefined);
    vi.mocked(h.storage.remove).mockClear();
    await h.view.submit(); await tick();
    const raw = pendingRaw(h.values, writtenPrimaryKey);
    expect(kept(h)).toEqual(intentOf(h.answers()[0]));
    expect(h.view.snapshot().commands.primary).toMatchObject({ phase: "unresolved", pending: true, outcome: null, problem: "window_stale" });
    expect(h.recovery()).toMatchObject({ state: { name: "window_check" }, sends: 1, transmitted: 1 });
    const recovery = h.view.snapshot().commands.recovery!;
    h.revoke(); await h.run(10 * 60_000, 5000);
    expect(h.answers()).toHaveLength(1);
    expect(pendingRaw(h.values, writtenPrimaryKey)).toBe(raw);
    expect(h.storage.remove).not.toHaveBeenCalledWith(writtenPrimaryKey);
    // The replaced window keeps the count of its send too (D-CP5 9.2.6: window_replaced keeps the budget).
    expect(await pageMarks(h.storage, recovery.commandId!)).toMatchObject({ reserved: 1, transmitted: 1 });
  });
  it("3.1.11 a start refused as DOCUMENT_STALE never settles rejected: even the widest cancel policy sees nothing to cancel", async () => {
    const h = harness();
    h.route(request => request.kind === "session.start" ? stale(request) : undefined);
    await h.view.refresh(); await h.view.start("words"); await tick();
    // The lane keeps the start unresolved, never settled rejected: the cancel policy's «settled rejected» is not reached.
    expect(h.view.snapshot().commands.primary).toMatchObject({ outcome: null, pending: true, kind: "session.start", problem: "window_stale" });
    for (const state of [{ name: "window_check" }, { name: "terminated", reason: "window_replaced" }]) {
      expect(cancelDue({ recovery: { state, sends: 1, transmitted: 1 } as never, rejectionCode: null }, () => true)).toBe(false);
    }
    h.revoke(); await h.run(60_000, 5000);
    expect(h.kinds()).toEqual(["session.start"]);
    expect(kept(h)).toMatchObject({ kind: "session.start" });
  });
  it("3.1.6 the window check keeps a live window: a check by ID, then the rest of the budget; the refused send stays counted", async () => {
    const h = harness(); await h.started("falsch");
    let refusals = 1;
    h.route(request => request.kind === "answer.submit" && refusals-- > 0 ? stale(request) : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()).toMatchObject({ state: { name: "window_check" }, sends: 1 });
    await h.run(20_000, 500);
    const sent = h.answers();
    expect(sent).toHaveLength(2);
    expect(sent[1].command_id).toBe(sent[0].command_id);
    expect(h.checks(sent[0].command_id)).toBeGreaterThanOrEqual(1);
    expect(h.recovery()).toMatchObject({ state: { name: "settled" }, sends: 2, transmitted: 2 });
    expect(hasPending(h.values, writtenPrimaryKey)).toBe(false);
  });
  /** W2: another page (its own page memory over the same shared storage) with another live document of this installation. */
  function otherPage(h: ReturnType<typeof harness>, documentId: string) {
    const storage = { get: (key: string) => h.storage.get(key), set: (key: string, value: string) => h.storage.set(key, value),
      remove: (key: string) => h.storage.remove(key) };
    const handle = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: documentId, document_epoch: "2",
      proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } },
    token: "synthetic-token", proof: "synthetic-proof", generation: 2, isLive: () => true, onDenied: vi.fn() });
    const view = new WrittenViewController({ access: () => handle, storage, transport: h.transport, newId: h.newId,
      sessionId: id(3), transitionMode: () => "normal", onUpdate: vi.fn() });
    owners.push(view);
    return view;
  }
  /**
   * W1's №1 is held until the client gives up on it; W1 checks (not found) and waits to retry. `applied` lets №1 reach
   * the server before W2 takes the document; otherwise it never arrives (the core would refuse it as DOCUMENT_STALE
   * now). From then on every request of W1's document meets the core's refusal, its retry №2 included.
   */
  async function replaced(applied: boolean) {
    const h = harness(); await h.started();
    const w1 = h.access().document.documentId;
    let live = w1;
    h.route(request => request.body?.document_id === w1 && live !== w1 ? stale(request) : undefined);
    const gate = h.hold();
    void h.view.submit(); await tick();
    await h.run(31_000, 1000);
    expect(h.recovery()?.state.name).toBe("retry_wait");
    if (applied) { gate.resolve(); await tick(); }
    live = id(77);
    // Step until W1 either met the refusal (its window check starts) or settled by the fact its own check found.
    for (let spent = 0; spent < 30_000 && !["window_check", "settled"].includes(h.recovery()?.state.name ?? ""); spent += 250) await h.run(250, 250);
    const x = intentOf(h.answers()[0]);
    if (!applied) {
      // W1's retry №2 met the refusal: it keeps X and sends nothing more; its window check finds the document replaced.
      expect(h.answers().filter(post => post.document_id === w1)).toHaveLength(2);
      expect(h.recovery()?.state.name).toBe("window_check");
      expect(kept(h)).toEqual(x);
    }
    h.revoke(); await h.run(10_000);
    expect(h.answers().filter(post => post.document_id === w1)).toHaveLength(applied ? 1 : 2);
    const w2 = otherPage(h, id(77)); await w2.refresh(); await h.run(60_000, 1000);
    return { h, w1, w2, x };
  }
  it("3.1.7 i the early send applied before the replacement: a check finds the fact (core 1.4.1), nothing is sent again", async () => {
    const { h, w2 } = await replaced(true);
    expect(h.answers().filter(post => post.document_id === id(77))).toEqual([]);
    expect(h.server.results.size).toBe(1);
    // W1's own check by ID found the fact before any retry; the fact stays a fact and the record is settled.
    expect(h.view.snapshot().phase).toBe("disposed");
    expect(w2.snapshot().commands.primary).toMatchObject({ pending: false });
    expect(hasPending(h.values, writtenPrimaryKey)).toBe(false);
  });
  it("3.1.7 ii the early send never arrived: W2 loads X and only checks it; X is never sent with W2's document", async () => {
    const { h, w2, x } = await replaced(false);
    // CT §6.1 п. 5 asks for the same working document: until the owner answers В-2 (Codex C093 п. 5) no window sends X
    // with another document_id; X and its count stay. With the durable count of CP5b W2 knows the count of X (the
    // IndexedDB of the installation), and 2.3 А still lets it only check: origin_elsewhere, never a send.
    expect(h.answers().filter(post => post.document_id === id(77))).toEqual([]);
    expect(h.server.results.size).toBe(0);
    expect(kept(h)).toEqual(x);
    expect(w2.snapshot().commands.primary).toMatchObject({ pending: true, outcome: null });
    expect(w2.snapshot().commands.recovery).toMatchObject({ state: { name: "origin_elsewhere" } });
  });
  it("3.1.8 a late copy applies after W1 was replaced: W2's check finds it once; the record was not cleared before", async () => {
    const h = harness(); await h.started();
    const w1 = h.access().document.documentId, gate = h.hold();
    void h.view.submit(); await tick();
    expect(kept(h)).toEqual(intentOf(h.answers()[0]));
    h.revoke();
    // Owner rule CT §6.4: an explicit action may return the work to W1; then its delayed №1 is applied by the core.
    gate.resolve(); await h.run(5000);
    expect(kept(h)).toEqual(intentOf(h.answers()[0]));
    const w2 = otherPage(h, id(78)); await w2.refresh(); await h.run(30_000);
    expect(h.answers().map(post => post.document_id)).toEqual([w1]);
    expect(h.server.results.size).toBe(1);
    expect(w2.snapshot().commands.primary).toMatchObject({ outcome: "accepted" });
  });
});

describe("Stop keeps its manual rules (CT §6.1 п. 1)", () => {
  it("a lost Stop is checked and retried only by hand; the automatic retry of the answer never overtakes it", async () => {
    const h = harness({ cards: [6, 7] }); await h.started();
    let dropStop = true;
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1 ? "drop"
      : request.kind === "session.stop" && dropStop ? "drop" : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    await h.view.stop(); await tick();
    expect(h.view.snapshot().commands.stop).toMatchObject({ pending: true, outcome: null });
    // The answer's pause passes, but no answer goes out while Stop is unresolved.
    await h.run(60_000);
    expect(h.answers()).toHaveLength(1);
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    await h.view.refresh();
    expect(h.view.snapshot().commands.stop.canRetry).toBe(true);
    dropStop = false; await h.view.retry("stop"); await tick();
    expect(h.kinds().filter(kind => kind === "session.stop")).toHaveLength(2);
    expect(h.view.snapshot().phase).toBe("closed");
    await h.run(60_000);
    expect(h.answers()).toHaveLength(1);
  });
});

describe("the document owner of the lanes", () => {
  function owner() {
    vi.useFakeTimers();
    const f = writtenFixture({ active: true });
    const commands = new WrittenDocumentCommands({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId, onUpdate: vi.fn() });
    const answer = { kind: "answer.submit" as const, session_id: id(3), assignment_id: id(6), payload: { text: "Haus" } };
    return { ...f, commands, answer };
  }
  it("begin resolves once the machine has the first answer: the next action may start at once", async () => {
    const h = owner(); await h.commands.refresh();
    await h.commands.begin(h.answer);
    expect(h.commands.snapshot()).toMatchObject({ canBegin: true, recovery: { state: { name: "settled" } }, primary: { outcome: "accepted" } });
    h.commands.dispose();
  });
  it("a manual retry of a study result is refused even when the lane itself would allow it (Я15)", async () => {
    const h = owner(); await h.commands.refresh();
    h.dropRequest(); await h.commands.begin(h.answer); await tick();
    expect(h.commands.snapshot()).toMatchObject({ recovery: { state: { name: "retry_wait" } }, primary: { canRetry: false } });
    await h.commands.retry("primary"); await tick();
    expect(h.posts()).toHaveLength(1);
    await tick(2000); await tick();
    expect(h.posts()).toHaveLength(2);
    h.commands.dispose();
  });
});

describe("cases the independent QA found uncovered (QA CP2 QM05b, QM11, QM22)", () => {
  it("a handle replaced while the lane saves its pending: the refused send gives the reservation back (six real POSTs)", async () => {
    const h = harness(); await h.started(); h.route(lostAnswers);
    // Hold the storage read of the third send's pending save; meanwhile a foreground gives a new open handle, so the
    // open handle of that send refuses before the request (ClosedAccessError): nothing went out.
    const get = vi.mocked(h.storage.get), base = get.getMockImplementation()!;
    const gate = deferred<void>(); let held = 0;
    get.mockImplementation(async (key: string) => {
      if (key.includes("written_session") && h.answers().length === 2 && h.recovery()?.state.name === "sending" && held++ === 0) await gate.promise;
      return base(key);
    });
    await h.view.submit(); await tick();
    await h.run(8000);
    expect(held).toBe(1);
    h.replace(); gate.resolve(); await tick();
    await h.run(10 * 60_000, 5000);
    expect(h.answers()).toHaveLength(6);
    // Spent, then closed by the automatic closure C (CP4b).
    expect(h.recovery()).toMatchObject({ state: { name: "terminated", reason: "session_closed" }, sends: 6, transmitted: 6 });
  });
  it("DOCUMENT_STALE on a retry of a live window: nothing for 5 s, then a check and the rest of the budget", async () => {
    // A wrong answer waits for «Далее»: no timer shows the next question, whose present would take over the recovery view.
    const h = harness(); await h.started("falsch");
    let refusals = 1;
    h.route(request => request.kind !== "answer.submit" ? undefined : h.answers().length === 1 ? "drop"
      : refusals-- > 0 ? stale(request) : undefined);
    await h.view.submit(); await h.run(2000); await tick();
    expect(h.answers()).toHaveLength(2);
    const staleAt = h.sentAt[1];
    expect(h.recovery()?.state.name).toBe("window_check");
    await h.run(4000, 500);
    expect(h.log.filter(entry => entry.at > staleAt + 1)).toEqual([]);
    await h.run(10_000, 500);
    const next = h.log.filter(entry => entry.at > staleAt + 1);
    expect(next[0].path.startsWith("/api/v1/commands/")).toBe(true);
    expect(next[0].at - staleAt).toBe(5000);
    expect(h.recovery()).toMatchObject({ state: { name: "settled" }, sends: 3 });
  });
  it("a planned pause that runs on through the background: after the return nothing is checked by ID or sent before its end", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind === "answer.submit" && h.answers().length === 1
      ? response({ error: { code: "MAINTENANCE", wait_seconds: 120 } }, 503) : undefined);
    await h.view.submit(); await tick();
    const t0 = h.sentAt[0];
    h.view.suspend(); await h.run(30_000);
    h.replace(); await h.view.resume(); await tick();
    await h.run(80_000);
    // Only the view's own session read on resume may go out.
    expect(h.log.filter(entry => entry.at > t0 + 1 && entry.at < t0 + 120_000
      && (entry.method === "POST" || entry.path.startsWith("/api/v1/commands/")))).toEqual([]);
    await h.run(15_000);
    expect(h.answers()).toHaveLength(2);
  });
});

describe("an ended recovery shows the server's state (CT §6.1 п. 7, QA CP2 Н2)", () => {
  it("a definite refusal without a projection: the record goes, the question takes a new answer with a new ID", async () => {
    const h = harness(); await h.started();
    let refuse = true;
    h.route(request => request.kind === "answer.submit" && refuse ? response({ error: { code: "VALIDATION_FAILED" } }, 422) : undefined);
    await h.view.submit(); await tick();
    const [old] = h.answers();
    expect(h.recovery()?.state).toEqual({ name: "refused", code: "VALIDATION_FAILED" });
    expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(6), status: "presented" }, problem: null,
      canRetryPrimary: false, canForget: true, canStop: true, commands: { primary: { pending: false } } });
    expect(hasPending(h.values, "wortly.pending.written_session")).toBe(false);
    await h.run(60_000);
    expect(h.answers()).toHaveLength(1);
    refuse = false; h.view.setDraft("Haus"); await h.view.submit(); await tick();
    const answers = h.answers();
    expect(answers).toHaveLength(2);
    expect(answers[1].command_id).not.toBe(old.command_id);
    expect(answers.filter(post => post.command_id === old.command_id)).toHaveLength(1);
    expect(h.view.snapshot().phase).toBe("result_correct");
  });
});

// CP4b / T1 (core 35c3844 N2/N3; CON table 2.1 :82, table 2.2 :152; project notices ed.2.4 §4.1; C543).
describe("the automatic closure C and the Stop with X", () => {
  it("ACTION_ALREADY_SAVED: X landed after all — nothing closes, X is read again by its own ID, the quiz goes on, no second C", async () => {
    const h = harness(); await h.started();
    let landX: (() => Promise<void>) | null = null;
    h.route(request => {
      if (request.kind === "answer.submit") {
        const answer = h.posts().filter(post => post.kind === "answer.submit").at(-1)!;
        landX = async () => { await h.server.handle("/api/v1/commands" as unknown as RequestInfo,
          { method: "POST", body: JSON.stringify(answer) }); };
        return "drop";
      }
      return undefined;
    });
    // C finds X saved: the answer committed just before the closure (DS 2.3.1).
    const base = h.fetcher.getMockImplementation()!;
    h.fetcher.mockImplementation(async (url, init) => {
      const body = init?.method === "POST" ? JSON.parse(String(init.body)) : null;
      if (body?.kind === "session.stop" && body.payload.reason === "save_failed" && landX) { await landX(); landX = null; }
      return base(url, init);
    });
    await h.view.submit(); await tick();
    await h.run(70_000); await h.run(3 * 60_000, 30_000);
    const x = h.answers()[0].command_id;
    const closes = h.posts().filter(post => post.kind === "session.stop");
    expect(closes).toHaveLength(1);
    expect(closes[0].payload).toEqual({ reason: "save_failed", unsaved_command_id: x });
    // Nothing closed and no notice; X was read by GET /commands/{X} after the refusal, with its own intent.
    expect(h.server.state.status).not.toBe("closed");
    expect(h.server.lostAnswers).toEqual([]);
    const stopAt = h.log.findIndex(entry => entry.kind === "session.stop");
    expect(h.log.slice(stopAt + 1).some(entry => entry.method === "GET" && entry.path === `/api/v1/commands/${x}`)).toBe(true);
    // C543 / QA M1b P3: only X itself is read again by its ID — no other command, no new ID.
    const stopId = closes[0].command_id;
    expect(h.log.slice(stopAt + 1).filter(entry => entry.method === "GET" && entry.path.startsWith("/api/v1/commands/"))
      .map(entry => entry.path.split("/").at(-1)).every(read => read === x || read === stopId)).toBe(true);
    expect(h.answers()).toHaveLength(6);
    expect(new Set(h.answers().map(post => post.command_id))).toEqual(new Set([x]));
    expect(h.view.snapshot().commands.primary).toMatchObject({ outcome: "accepted" });
    expect(h.view.snapshot().commands.stop).toMatchObject({ outcome: null, rejectionCode: null });
    expect(h.view.snapshot().phase).not.toBe("closed");
  });
  it("the person's Stop while X is unconfirmed names X; the server writes the loss of X", async () => {
    const h = harness({ cards: [6, 7] }); await h.started();
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await h.view.submit(); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    await h.view.stop(); await tick();
    const x = h.answers()[0].command_id, stop = h.posts().find(post => post.kind === "session.stop")!;
    expect(stop.payload).toEqual({ reason: "stop", unsaved_command_id: x });
    expect(h.server.lostAnswers).toEqual([{ sessionId: stop.session_id, commandId: x, reason: "stop" }]);
  });
  // C545 (б): an unconfirmed non-answer step (assignment.present) and the person's Stop. X stays unnamed (ANSWER_KINDS): the
  // payload is the former {reason}; the core writes no answer_loss, so no false «Последний ответ не сохранился»; the
  // present is then only checked by its own ID after the closure (reconcileClosedPrimary), never sent again.
  it("a Stop while only a present is unconfirmed names no X: {reason}, no notice, the present checked after the closure", async () => {
    const h = harness({ cards: [6, 7] }); await h.view.refresh();
    h.route(request => request.kind === "assignment.present" ? "drop" : undefined);
    await h.view.start("words"); await tick();
    expect(h.recovery()?.state.name).toBe("retry_wait");
    const present = h.posts().find(post => post.kind === "assignment.present")!;
    h.route(() => undefined);
    await h.view.stop(); await tick(); await h.run(6000);
    const stop = h.posts().find(post => post.kind === "session.stop")!;
    expect(JSON.stringify(stop.payload)).toBe('{"reason":"stop"}');
    expect(h.server.lostAnswers).toEqual([]);
    expect(h.view.snapshot().phase).toBe("closed");
    expect(h.checks(present.command_id)).toBeGreaterThanOrEqual(1);
    expect(h.posts().filter(post => post.kind === "assignment.present")).toHaveLength(1);
  });
  it("a Stop without an unconfirmed action keeps the payload byte for byte {reason}", async () => {
    const h = harness({ cards: [6, 7] }); await h.started();
    await h.view.stop(); await tick();
    const stop = h.posts().find(post => post.kind === "session.stop")!;
    expect(JSON.stringify(stop.payload)).toBe('{"reason":"stop"}');
    expect(h.server.lostAnswers).toEqual([]);
  });
});

// Q30 of 08.10 (CON §6.1 п.8 :260; TZA §12.3 :234; C546/C547): the closure C has its own budget of six sends with the
// pauses 2/5/10/20/30 s and a check before each; X is never sent again; after the budget ran out and the session is
// proved open, «Повторить завершение» sends the same C once per press. An unknown outcome only checks.
describe("the closure C's own budget and «Повторить завершение» (Q30)", () => {
  async function exhaustX(h: ReturnType<typeof harness>) {
    await h.started(); await h.view.submit(); await tick();
    for (let spent = 0; spent < 80_000 && !h.posts().some(post => post.kind === "session.stop"); spent += 1000) await tick(1000);
  }
  const closures = (h: ReturnType<typeof harness>) => h.posts().filter(post => post.kind === "session.stop");
  it("six sends of the same C 2, 5, 10, 20, 30 s apart; X not refilled; then the button sends the same C once per press", async () => {
    const h = harness();
    h.route(request => request.kind === "answer.submit" || request.kind === "session.stop" ? "drop" : undefined);
    await exhaustX(h);
    const first = h.since();
    await h.run(70_000); await h.run(3 * 60_000, 30_000);
    const stops = h.log.filter(entry => entry.kind === "session.stop").map(entry => Math.round((entry.at - first) / 1000));
    expect(stops).toEqual([0, 2, 7, 17, 37, 67]);
    const c = closures(h);
    expect(new Set(c.map(post => JSON.stringify(post))).size).toBe(1);
    expect(c[0].payload).toEqual({ reason: "save_failed", unsaved_command_id: h.answers()[0].command_id });
    expect(h.answers()).toHaveLength(6);
    // Absence of C and the open session are proved by the last check: the manual retry is offered (9.2.12 + Q30 button).
    expect(h.view.snapshot().commands).toMatchObject({ closureFailed: true, stop: { pending: true, canRetry: true } });
    expect(h.view.snapshot().commands.stop.canRetry).toBe(true);
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await h.view.retry("stop"); await tick();
    expect(closures(h)).toHaveLength(7);
    expect(JSON.stringify(closures(h).at(-1))).toBe(JSON.stringify(c[0]));
    expect(h.view.snapshot().phase).toBe("closed");
    expect(h.answers()).toHaveLength(6);
  });
  it("an unknown outcome of C (its checks fail) only checks: no button, no seventh send", async () => {
    const h = harness();
    h.route(request => request.kind === "answer.submit" || request.kind === "session.stop" ? "drop"
      : request.method === "GET" && request.path.startsWith("/api/v1/commands/") && h.posts().some(post => post.kind === "session.stop")
        ? "drop" : undefined);
    await exhaustX(h);
    await h.run(10 * 60_000, 5000);
    expect(closures(h).length).toBeLessThanOrEqual(1);
    expect(h.view.snapshot().commands.closureFailed).toBeUndefined();
    expect(h.view.snapshot().commands.stop.canRetry).toBe(false);
    await h.view.retry("stop"); await tick();
    expect(closures(h).length).toBeLessThanOrEqual(1);
  });
  it("a C of another page (a reload: its count unknown) is only checked even with the session open: no button, no send", async () => {
    const c = { command_id: id(300), session_id: id(3), kind: "session.stop" as const,
      payload: { reason: "save_failed" as const, unsaved_command_id: id(100) } };
    const h = harness({ active: true, saved: { stop: c } }, id(3));
    await h.view.refresh(); await h.run(70_000);
    expect(h.checks(c.command_id)).toBeGreaterThan(0);
    expect(h.view.snapshot().commands.stop).toMatchObject({ pending: true, canRetry: false });
    expect(h.view.snapshot().commands.closureFailed).toBeUndefined();
    await h.view.retry("stop"); await tick();
    expect(h.posts()).toEqual([]);
  });
});

describe("the closure C refused otherwise (QA M1b P3)", () => {
  it("a C refused VALIDATION_FAILED is not sent again and X is not resent", async () => {
    const h = harness(); await h.started();
    h.route(request => request.kind === "answer.submit" ? "drop"
      // The core's attributed refusal of exactly this C (study/coordinator.py envelope).
      : request.kind === "session.stop" ? response({ current: h.server.projection(), command: { id: request.body!.command_id, status: "rejected" },
        state_version: String(h.server.state.version), error: { code: "VALIDATION_FAILED" } }, 422) : undefined);
    await h.view.submit(); await tick();
    await h.run(70_000); await h.run(5 * 60_000, 30_000);
    expect(h.posts().filter(post => post.kind === "session.stop")).toHaveLength(1);
    expect(h.answers()).toHaveLength(6);
  });
});
