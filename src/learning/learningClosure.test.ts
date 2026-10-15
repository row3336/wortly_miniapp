// A study record after the confirmed closure of its session, and the closure record C in the Stop slot
// (M-RECOV-AUTO CP4a-1, D-CP4 3.1.1–3.1.4 and 4.6.1, tests 4.8.6–4.8.11): the real view, document lanes and transport
// over the synthetic Learning server, on fake time. Ported from the QA CP2b probes H1, P6.1 and S3.3.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaveFailedStopIntent } from "../commands/closeIntent";
import { tick } from "../commands/recoveryTime.test-support";
import { closed, current, fact, id, missing, pending, primaryKey, response, stopKey } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import { LearningViewController } from "./learningViewController";
import { testGate } from "../commands/testGate.test-support";

type Request = { method: string; path: string; kind: string | null; commandId: string | null };
/** undefined: the synthetic server answers; "drop": fails before the server; "lose": the server applies, the reply is lost. */
type Route = (request: Request) => undefined | "drop" | "lose" | Response;

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

const mismatch = () => response({ error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
const isCheck = (request: Request) => request.method === "GET" && request.path.startsWith("/api/v1/commands/");

function harness() {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", id(3)); owners.push(f.view);
  const begun = performance.now(), log: (Request & { at: number })[] = [];
  let route: Route = () => undefined, closedOnServer = false;
  const serve = async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1], request: Request) => {
    let reply: Response;
    try { reply = await f.handler(url, init); } catch (error) {
      // The synthetic server answers a status only for a command it holds: any other ID is not found (core command_status).
      if (!isCheck(request)) throw error;
      reply = response(missing({ command_id: request.commandId!, session_id: id(3) } as never, f.view.snapshot().commands.stateVersion));
    }
    if (request.kind === "session.stop" && reply.ok) closedOnServer = true;
    if (!isCheck(request) || !reply.ok || !closedOnServer) return reply;
    // Core adds the closure of the asked session to a not_found status (command_status._closed_session).
    const body = await reply.clone().json();
    return body.command?.status !== "not_found" ? reply
      : response({ ...body, closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } });
  };
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
    const body = method === "POST" ? JSON.parse(String(init!.body)) : null;
    const request: Request = { method, path, kind: body?.kind ?? null,
      commandId: body?.command_id ?? (path.startsWith("/api/v1/commands/") ? path.split("/").at(-1)! : null) };
    log.push({ ...request, at: performance.now() - begun });
    const decision = route(request);
    if (decision === "drop") throw new TypeError("network");
    if (decision === "lose") { await serve(url, init, request); throw new TypeError("network"); }
    return decision ?? serve(url, init, request);
  });
  const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); };
  const own = () => {
    const view = new LearningViewController({ access: f.access, storage: f.storage, newId: f.newId,
      transport: { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() }, sessionId: id(3), transitionMode: () => "normal",
      onUpdate: vi.fn() });
    owners.push(view);
    return view;
  };
  return { ...f, log, run, own, since: () => performance.now() - begun,
    posts: (kind?: string) => log.filter(entry => entry.method === "POST" && (!kind || entry.kind === kind)),
    checks: (commandId?: string) => log.filter(entry => isCheck(entry) && (!commandId || entry.commandId === commandId)),
    setClosedOnServer: () => { closedOnServer = true; },
    route: (next: Route) => { route = next; } };
}
type Harness = ReturnType<typeof harness>;
async function answer(h: Harness) {
  await h.view.refresh(); h.view.setDraft("Haus");
  void h.view.submit(); await tick();
}

describe("Н2: the record of a conflict after the confirmed closure (D-CP4 3.1.1)", () => {
  // Like the core: both the POST and the status of the same ID answer 409 COMMAND_PAYLOAD_MISMATCH.
  const conflict = (h: Harness) => {
    let answerId: string | null = null;
    h.route(request => {
      if (request.kind === "answer.submit") { answerId = request.commandId; return mismatch(); }
      return answerId && isCheck(request) && request.commandId === answerId ? mismatch() : undefined;
    });
  };
  it("4.8.7 «Выйти» confirmed: the record goes, a new session starts, and a reload finds nothing (QA H1)", async () => {
    const h = harness(); conflict(h); await answer(h);
    expect(h.view.snapshot().commands.recovery?.state.name).toBe("conflict");
    expect(h.values.has(primaryKey)).toBe(true);
    await h.view.stop(); await tick();
    const s = h.view.snapshot();
    expect(s.phase).toBe("closed");
    expect({ pending: s.commands.primary.pending, record: h.values.has(primaryKey), canBegin: s.commands.canBegin })
      .toEqual({ pending: false, record: false, canBegin: true });
    // No check, no send of the conflicting action after the closure.
    expect(h.posts().map(entry => entry.kind)).toEqual(["answer.submit", "session.stop"]);
    await h.view.start(); await tick();
    expect(h.posts().at(-1)?.kind).toBe("session.start");
    const reloaded = h.own(); await reloaded.refresh(); await tick();
    expect(reloaded.snapshot().commands.primary.pending).toBe(false);
  });
  // A full-body 409 (command, current, state_version, error: core's error envelope with the projection) makes the lane
  // mark the record itself; the mark write may fail, leaving the mark only in memory (QA CP4a-1 Ф1, probe Q-N2d).
  const fullConflict = (h: Harness, markFails: boolean) => {
    const base = h.handler;
    let answerId: string | null = null;
    h.fetcher.mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET", body = method === "POST" ? JSON.parse(String(init!.body)) : null;
      const path = new URL(String(url), "http://localhost").pathname;
      h.log.push({ method, path, kind: body?.kind ?? null, at: 0,
        commandId: body?.command_id ?? (path.startsWith("/api/v1/commands/") ? path.split("/").at(-1)! : null) });
      if (body?.kind === "answer.submit") {
        answerId = body.command_id;
        // The projection of the synthetic server's own answer envelope, refused for this ID.
        const applied = await (await base(url, { ...init, body: JSON.stringify({ ...body, command_id: id(990) }) })).json();
        return response({ ...applied, command: { id: body.command_id, status: "rejected" }, error: { code: "COMMAND_PAYLOAD_MISMATCH" } }, 409);
      }
      if (method === "GET" && answerId && path.endsWith(`/commands/${answerId}`)) return mismatch();
      return base(url, init);
    });
    if (markFails) {
      const set = vi.mocked(h.storage.set), original = set.getMockImplementation()!;
      set.mockImplementation(async (key, value) => {
        if (key === primaryKey && JSON.parse(value).mismatch) throw new Error("io");
        return original(key, value);
      });
    }
  };
  for (const markFails of [false, true]) {
    it(`4.8.7 a full-body conflict${markFails ? " whose mark could not be stored" : ""}: «Выйти» confirmed clears the record (QA Q-N2d${markFails ? 2 : 1})`, async () => {
      const h = harness(); fullConflict(h, markFails);
      await answer(h); await h.run(10_000);
      expect(h.view.snapshot().commands.primary).toMatchObject({ pending: true, conflict: true });
      expect(JSON.parse(h.values.get(primaryKey)!).mismatch).toBe(markFails ? undefined : true);
      await h.view.stop(); await tick(); await h.run(60_000);
      const s = h.view.snapshot();
      expect({ phase: s.phase, record: h.values.has(primaryKey), pending: s.commands.primary.pending, canBegin: s.commands.canBegin,
        checking: s.commands.closedAction?.state === "checking" }).toEqual({ phase: "closed", record: false, pending: false, canBegin: true, checking: false });
      expect(h.log.filter(entry => entry.method === "POST").map(entry => entry.kind)).toEqual(["answer.submit", "session.stop"]);
      await h.view.start(); await tick();
      expect(h.log.filter(entry => entry.method === "POST").at(-1)?.kind).toBe("session.start");
    });
  }
  it("a conflict record of another session stays after the own session closes (QA Q-N2a)", async () => {
    const h = harness();
    const foreign = { command_id: id(400), session_id: id(9), assignment_id: id(6), kind: "answer.submit", payload: { text: "x" } };
    h.values.set(primaryKey, JSON.stringify({ ...pending(foreign as never), mismatch: true }));
    await h.view.refresh(); await tick();
    await h.view.stop(); await tick(); await h.run(10_000);
    expect(h.values.has(primaryKey)).toBe(true);
    expect(JSON.parse(h.values.get(primaryKey)!).intent.session_id).toBe(id(9));
  });
  it("4.8.8 «Выйти» not confirmed (its reply lost, no check yet): the record of the conflict stays", async () => {
    const h = harness(); conflict(h); await answer(h);
    const answerId = h.posts("answer.submit")[0].commandId;
    h.route(request => {
      if (isCheck(request) && request.commandId === answerId) return mismatch();
      // Stop is lost and its status stays unreachable: the closure is never confirmed.
      return request.kind === "session.stop" || isCheck(request) ? "drop" : undefined;
    });
    await h.view.stop(); await tick(); await h.run(60_000);
    const s = h.view.snapshot();
    expect(s.phase).not.toBe("closed");
    expect({ pending: s.commands.primary.pending, record: h.values.has(primaryKey) }).toEqual({ pending: true, record: true });
  });
  it("a failed clear after the closure is tried again by the next refresh, not in a loop", async () => {
    const h = harness(); conflict(h); await answer(h);
    const remove = vi.mocked(h.storage.remove), base = remove.getMockImplementation()!;
    let failures = 1;
    remove.mockImplementation(async key => { if (key === primaryKey && failures-- > 0) throw new Error("io"); return base(key); });
    await h.view.stop(); await tick(); await h.run(30_000);
    expect(h.values.has(primaryKey)).toBe(true);
    expect(remove.mock.calls.filter(([key]) => key === primaryKey)).toHaveLength(1);
    await h.view.refresh(); await tick();
    expect({ pending: h.view.snapshot().commands.primary.pending, record: h.values.has(primaryKey) }).toEqual({ pending: false, record: false });
  });
});

describe("Н3: a refused action whose record could not be cleared (D-CP4 3.1.2)", () => {
  it("4.8.9 422 and a failed cleanup: no timer retries it; the next refresh clears it and the question takes an answer (QA S3.3)", async () => {
    const h = harness();
    h.route(request => request.kind === "answer.submit" ? response({ error: { code: "VALIDATION_FAILED" } }, 422) : undefined);
    const remove = vi.mocked(h.storage.remove), base = remove.getMockImplementation()!;
    let failures = 1;
    remove.mockImplementation(async key => { if (key === primaryKey && failures-- > 0) throw new Error("io"); return base(key); });
    await answer(h); await h.run(60_000);
    expect(h.view.snapshot().commands.recovery?.state.name).toBe("refused");
    expect({ record: h.values.has(primaryKey), canBegin: h.view.snapshot().commands.canBegin }).toEqual({ record: true, canBegin: false });
    // Event-driven only: a minute without events tries the cleanup once, never on a timer.
    expect(remove.mock.calls.filter(([key]) => key === primaryKey)).toHaveLength(1);
    const posts = h.posts().length;
    await h.view.refresh(); await tick();
    expect(h.values.has(primaryKey)).toBe(false);
    h.view.setDraft("Haus");
    expect(h.view.snapshot()).toMatchObject({ phase: "question", canSubmit: true });
    expect(h.posts()).toHaveLength(posts);
  });
  it("a return from the background clears it too", async () => {
    const h = harness();
    h.route(request => request.kind === "answer.submit" ? response({ error: { code: "VALIDATION_FAILED" } }, 422) : undefined);
    const remove = vi.mocked(h.storage.remove), base = remove.getMockImplementation()!;
    let failures = 1;
    remove.mockImplementation(async key => { if (key === primaryKey && failures-- > 0) throw new Error("io"); return base(key); });
    await answer(h); await tick();
    expect(h.values.has(primaryKey)).toBe(true);
    h.view.suspend(); h.view.resumeRecovery(); await tick();
    expect(h.values.has(primaryKey)).toBe(false);
  });
});

describe("Н4: the check of an action after the closure (D-CP4 3.1.3)", () => {
  it("4.8.6 six lost sends, «Выйти», the first check fails: the next one at 5 s clears the record (QA P6.1)", async () => {
    const h = harness();
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await answer(h); await h.run(70_000);
    expect(h.view.snapshot().commands.recovery?.state.name).toBe("exhausted");
    let failChecks = 1;
    h.route(request => isCheck(request) && failChecks-- > 0 ? "drop" : undefined);
    await h.view.stop(); await tick();
    const stopAt = h.posts("session.stop")[0].at;
    expect(h.view.snapshot().phase).toBe("closed");
    expect(h.values.has(primaryKey)).toBe(true);
    expect(h.view.snapshot().commands.closedAction?.state).toBe("checking");
    await h.run(4000);
    expect(h.checks().filter(entry => entry.at >= stopAt)).toHaveLength(1);
    await h.run(2000);
    const checks = h.checks().filter(entry => entry.at >= stopAt).map(entry => Math.round((entry.at - stopAt) / 1000));
    expect(checks).toEqual([0, 5]);
    expect({ pending: h.view.snapshot().commands.primary.pending, record: h.values.has(primaryKey) }).toEqual({ pending: false, record: false });
    // Nothing more is sent: no answer after the closure.
    expect(h.posts("answer.submit")).toHaveLength(6);
    expect(h.view.snapshot().commands.closedAction?.state).toBe("ended");
  });
  it("the checks after the closure follow 5, 10, 20, 30 s while offline and request nothing in the background", async () => {
    const h = harness();
    h.route(request => request.kind === "answer.submit" ? "drop" : undefined);
    await answer(h); await h.run(70_000);
    h.route(request => isCheck(request) ? "drop" : undefined);
    await h.view.stop(); await tick();
    const stopAt = h.posts("session.stop")[0].at;
    await h.run(66_000);
    const offsets = h.checks().filter(entry => entry.at >= stopAt).map(entry => Math.round((entry.at - stopAt) / 1000));
    expect(offsets).toEqual([0, 5, 15, 35, 65]);
    h.view.suspend(); const requests = h.log.length;
    await h.run(10 * 60_000, 10_000);
    expect(h.log).toHaveLength(requests);
    h.route(() => undefined);
    h.view.resumeRecovery(); await tick();
    expect({ pending: h.view.snapshot().commands.primary.pending, record: h.values.has(primaryKey) }).toEqual({ pending: false, record: false });
    expect(h.posts("answer.submit")).toHaveLength(6);
  });
  it("9.2.8: an answer found saved after this document's own Stop is named so (D-CP4 2.6.4)", async () => {
    const h = harness();
    let lost = true;
    h.route(request => {
      if (request.kind === "answer.submit") return "lose";
      return lost && isCheck(request) ? "drop" : undefined;
    });
    await answer(h);
    expect(h.view.snapshot().commands.recovery?.state.name).toBe("unreachable");
    await h.view.stop(); await tick();
    expect(h.view.snapshot().commands.closedAction?.state).toBe("checking");
    lost = false; await h.run(31_000);
    const s = h.view.snapshot();
    expect({ pending: s.commands.primary.pending, closed: s.commands.closedAction?.state }).toEqual({ pending: false, closed: "saved" });
    expect(h.posts("answer.submit")).toHaveLength(1);
  });
  it("9.2.8 only after this document's own Stop: a closure from elsewhere ends with the plain closed text", async () => {
    const h = harness();
    let lost = true;
    h.route(request => {
      if (request.kind === "answer.submit") return "lose";
      return lost && isCheck(request) ? "drop" : undefined;
    });
    await answer(h);
    // Midnight or another device closes the session; this document sent no Stop.
    h.setStep(closed()); h.setClosedOnServer();
    await h.view.refresh(); await tick();
    expect(h.view.snapshot().phase).toBe("closed");
    lost = false; await h.run(31_000);
    const s = h.view.snapshot();
    expect({ pending: s.commands.primary.pending, outcome: s.commands.primary.outcome, closed: s.commands.closedAction?.state })
      .toEqual({ pending: false, outcome: "accepted", closed: "ended" });
    expect(h.posts().map(entry => entry.kind)).toEqual(["answer.submit"]);
  });
});

describe("the closure record C in the Stop slot (D-CP4 4.6.1, 7.3)", () => {
  const closure = (n = 300): SaveFailedStopIntent => ({ command_id: id(n), session_id: id(3), kind: "session.stop",
    payload: { reason: "save_failed", unsaved_command_id: id(100) } });
  const seed = (h: Harness, intent = closure()) => { h.values.set(stopKey, JSON.stringify(pending(intent as never))); return intent; };
  const appliedStatus = (intent: SaveFailedStopIntent) => response({ current: closed(), state_version: "12",
    command: fact(intent as never, false, "already_applied") });

  it("4.8.10 the core does not know C, the session is open: the record stays, is never sent, only checked", async () => {
    const h = harness(); const c = seed(h);
    await h.view.refresh(); await tick();
    let s = h.view.snapshot();
    expect(s.commands.stop.pending).toBe(true);
    expect(s.commands.stop.problem).not.toBe("invalid_pending");
    expect(s.commands.stop.canRetry).toBe(false);
    expect(h.checks(c.command_id).length).toBeGreaterThan(0);
    await h.view.retry("stop"); await h.view.refresh(); await tick();
    s = h.view.snapshot();
    expect(s.commands.stop.pending).toBe(true);
    expect(h.values.has(stopKey)).toBe(true);
    expect(h.posts()).toEqual([]);
  });
  it("4.8.10a the session then closes and the check after the closure is not_found: the record goes", async () => {
    const h = harness(); seed(h);
    await h.view.refresh(); await tick();
    expect(h.values.has(stopKey)).toBe(true);
    h.setStep(closed()); h.setClosedOnServer();
    await h.view.refresh(); await tick();
    expect({ pending: h.view.snapshot().commands.stop.pending, record: h.values.has(stopKey) }).toEqual({ pending: false, record: false });
    expect(h.posts()).toEqual([]);
  });
  it("4.8.10b / 4.8.11 a check finds C applied: the ordinary outcome of a Stop, the record goes", async () => {
    const h = harness(); const c = seed(h);
    let applied = false;
    h.route(request => applied && isCheck(request) && request.commandId === c.command_id ? appliedStatus(c) : undefined);
    await h.view.refresh(); await tick();
    expect(h.values.has(stopKey)).toBe(true);
    applied = true; h.setStep(closed());
    await h.view.refresh(); await tick();
    const s = h.view.snapshot();
    expect({ phase: s.phase, pending: s.commands.stop.pending, outcome: s.commands.stop.outcome, record: h.values.has(stopKey) })
      .toEqual({ phase: "closed", pending: false, outcome: "accepted", record: false });
    expect(h.posts()).toEqual([]);
  });
  it("even where an ordinary Stop could be retried (the session summary), C is never offered or sent again", async () => {
    const h = harness(); seed(h);
    h.setStep({ ...current(), status: "summary", assignment: null });
    await h.view.refresh(); await tick();
    const s = h.view.snapshot();
    expect({ pending: s.commands.stop.pending, canRetry: s.commands.stop.canRetry }).toEqual({ pending: true, canRetry: false });
    await h.view.retry("stop"); await tick();
    expect(h.posts()).toEqual([]);
    expect(h.values.has(stopKey)).toBe(true);
  });
  it("a record that names itself as the unsaved action is not a closure record", async () => {
    const h = harness();
    const own = closure(); own.payload.unsaved_command_id = own.command_id; seed(h, own);
    await h.view.refresh(); await tick();
    expect(h.view.snapshot().commands.stop.problem).toBe("invalid_pending");
    expect(h.posts()).toEqual([]);
  });
});

describe("a closure record is never sent by any path", () => {
  it("the Learning session API refuses to send it, but checks it", async () => {
    const { createLearningSessionApi } = await import("./learningSessionApi");
    const fetcher = vi.fn<typeof fetch>(async () => response(missing({ command_id: id(300), session_id: id(3) } as never)));
    const api = createLearningSessionApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() });
    const command = { command_id: id(300), session_id: id(3), kind: "session.stop" as const,
      payload: { reason: "save_failed" as const, unsaved_command_id: id(100) }, client_instance_id: id(1), document_id: id(2) };
    await expect(api.send("token", "proof", command)).rejects.toThrow("invalid Learning command");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(api.status("token", "proof", command)).resolves.toMatchObject({ outcome: "not_found" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
