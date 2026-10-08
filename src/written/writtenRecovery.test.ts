// Automatic recovery of a written study action (M-RECOV-AUTO CP2, CT §6.1, D-RECOV table 8) through the real view,
// document lanes and HTTP transport over the synthetic written server, on fake time.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WrittenIntent } from "./writtenIntent";
import { WrittenDocumentCommands } from "./writtenDocumentCommands";
import { WrittenViewController } from "./writtenViewController";
import { deferred, id, response, tick, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

type Request = { method: string; path: string; kind: string | null };
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
    const kind = method === "POST" ? JSON.parse(String(init!.body)).kind as string : null;
    if (kind === "answer.submit") sentAt.push(performance.now() - begun);
    log.push({ at: performance.now() - begun, method, path, kind });
    const decision = route({ method, path, kind });
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
  it("six losses in a row: exactly six POSTs, 2, 5, 10, 20 and 30 s apart, then the exhausted state without more sends", async () => {
    const h = harness(); await h.started(); h.route(lostAnswers);
    await h.view.submit(); await tick();
    // One-second steps for the exact moments, then coarse steps for the rest of ten minutes.
    await h.run(70_000); await h.run(9 * 60_000, 30_000);
    expect(h.sentAt.map(at => at - h.sentAt[0])).toEqual([0, 2000, 7000, 17000, 37000, 67000]);
    const ids = new Set(h.answers().map(post => JSON.stringify(post)));
    expect(ids.size).toBe(1);
    expect(h.recovery()).toMatchObject({ state: { name: "exhausted" }, sends: 6, transmitted: 6, remaining: 0 });
    // CP4 closes the session; until then nothing else is sent (Stop stays manual).
    expect(h.kinds()).toEqual(["session.start", "assignment.present", ...Array(6).fill("answer.submit")]);
    expect(h.view.snapshot()).toMatchObject({ phase: "unknown", canRetryPrimary: false, canStop: true });
  });
  it("whatever the server answers, one action never goes out more than six times (random replies, 40 runs)", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      let state = seed;
      const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
      const h = harness(); await h.started();
      const replies = ["drop", "lose", "maintenance", "unavailable", "pass"] as const;
      h.route(request => {
        if (request.method === "GET" && request.path.startsWith("/api/v1/commands/")) return random() < 0.3 ? "drop" : undefined;
        if (request.kind !== "answer.submit") return undefined;
        const reply = replies[Math.floor(random() * replies.length)];
        if (reply === "maintenance") return response({ error: { code: "MAINTENANCE", wait_seconds: Math.floor(random() * 40) } }, 503);
        if (reply === "unavailable") return response({ error: { code: "WRITE_UNAVAILABLE" } }, 503);
        return reply === "pass" ? undefined : reply;
      });
      await h.view.submit(); await h.run(15 * 60_000, 5000);
      const answers = h.answers();
      expect(answers.length).toBeLessThanOrEqual(6);
      expect(new Set(answers.map(post => JSON.stringify(post))).size).toBe(1);
      // A confirmed answer is shown (and, after its 3 s, the next card); never sent again after the confirmation.
      if (h.recovery()?.state.name === "settled") {
        expect(h.server.receipts.has(answers[0].command_id)).toBe(true);
        expect(h.view.snapshot()).toMatchObject({ phase: "question", question: { id: id(7) } });
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
    expect(h.recovery()).toMatchObject({ state: { name: "exhausted" }, sends: 6, transmitted: 6, remaining: 0 });
    await h.view.submit();
    expect(h.kinds()).toEqual(["session.start", ...Array(6).fill("assignment.present")]);
    expect(h.view.snapshot()).toMatchObject({ phase: "visible_unconfirmed", canSubmit: false, canRetryPrimary: false, canStop: true });
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
      : h.answers().length === 1 ? "drop" : response({ error: { code: "DOCUMENT_STALE" } }, 409));
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
    expect(other.values.has("wortly.pending.written_session")).toBe(true);
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
    expect(h.recovery()).toMatchObject({ state: { name: "exhausted" }, sends: 6, transmitted: 6 });
  });
  it("DOCUMENT_STALE on a retry of a live window: nothing for 5 s, then a check and the rest of the budget", async () => {
    // A wrong answer waits for «Далее»: no timer shows the next question, whose present would take over the recovery view.
    const h = harness(); await h.started("falsch");
    let stale = 1;
    h.route(request => request.kind !== "answer.submit" ? undefined : h.answers().length === 1 ? "drop"
      : stale-- > 0 ? response({ error: { code: "DOCUMENT_STALE" } }, 409) : undefined);
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
    expect(h.values.has("wortly.pending.written_session")).toBe(false);
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
