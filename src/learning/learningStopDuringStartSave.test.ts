import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonTransport } from "../api/http";
import { tick } from "../commands/recoveryTime.test-support";
import { action, current, deferred, fact, id, original, pending, primaryKey, profile, response } from "./learningFixtures.test-support";
import { previewContent } from "./learningPreview.test-support";
import { learningViewFixture } from "./learningView.test-support";
import type { LearningViewController } from "./learningViewController";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

type Outcome = "changed" | "invalid" | "unavailable" | "saved";
/**
 * Owner decision 21.1-А (C156): after a new «Начать», while the start is being stored on this device and nothing of it
 * was transmitted, «Выйти» is off; a direct stop() then sends nothing and is not remembered. On real localStorage this
 * window is a few microtasks; here the slot read of the start's save is held so taps land inside it. The outcome decided
 * after the taps: another window's record ("changed"), an unreadable record ("invalid"), a failed write ("unavailable")
 * or a stored start that is then sent ("saved").
 */
async function exitDuringStartSave(outcome: Outcome) {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", null); owners.push(f.view); await f.view.refresh();
  const gate = deferred<void>(); let holding = true;
  const get = vi.mocked(f.storage.get).getMockImplementation()!, set = vi.mocked(f.storage.set).getMockImplementation()!;
  vi.mocked(f.storage.get).mockImplementation(async key => {
    if (holding && key === primaryKey) {
      holding = false; await gate.promise;
      if (outcome === "changed") f.values.set(primaryKey, JSON.stringify(pending(original(action(), 777))));
      if (outcome === "invalid") f.values.set(primaryKey, "{not json");
    }
    return get(key);
  });
  vi.mocked(f.storage.set).mockImplementation(async (key, value) => {
    if (outcome === "unavailable" && key === primaryKey) throw new Error("quota");
    return set(key, value);
  });
  const updates = () => f.onUpdate.mock.calls.length;
  const starting = f.view.start(); await tick();
  const tapped = f.view.snapshot(), y = tapped.sessionId!, from = updates();
  // The public right and a direct call share one boundary: neither sends anything while the start is being stored.
  const early = f.view.stop(); await tick(); await early;
  const during = f.view.snapshot();
  gate.resolve(); await starting; await tick(); await tick(5000);
  const seen = f.onUpdate.mock.calls.slice(from).map(([snapshot]) => snapshot as ReturnType<typeof f.view.snapshot>);
  const kinds = () => f.posts().map(post => `${post.kind}:${post.session_id}`);
  const stopsOfY = () => f.posts().filter(post => post.kind === "session.stop" && post.session_id === y);
  const startsOfY = () => f.posts().filter(post => post.kind === "session.start" && post.session_id === y);
  return { f, y, tapped, during, seen, kinds, stopsOfY, startsOfY };
}

describe("Learning: «Выйти» while the new start is being stored and nothing was transmitted (21.1-А)", () => {
  it.each(["changed", "invalid"] as const)("a start the slot then refuses (%s): «Выйти» off all along, no POST, no «stopping»",
    async outcome => {
      const { f, tapped, during, seen, stopsOfY, startsOfY } = await exitDuringStartSave(outcome);
      expect(tapped.canStop).toBe(false); expect(during.canStop).toBe(false); expect(during.phase).not.toBe("stopping");
      expect(seen.some(snapshot => snapshot.phase === "stopping")).toBe(false);
      expect(startsOfY()).toEqual([]); expect(stopsOfY()).toEqual([]);
      expect(f.view.snapshot()).toMatchObject({ phase: "idle", sessionId: null, canStop: false });
      // «Проверить состояние» sends nothing for Y either.
      await f.view.refresh(); await tick(5000);
      expect(stopsOfY()).toEqual([]);
    });
  it("a start stored and then sent: the early tap is not remembered; the start goes alone, no Stop by itself", async () => {
    const { f, y, tapped, during, kinds } = await exitDuringStartSave("saved");
    expect(tapped.canStop).toBe(false); expect(during.canStop).toBe(false);
    // Trace 1.1 of trace_ed94.log (stop before start) cannot happen in the local window any more.
    expect(kinds()).toEqual([`session.start:${y}`]);
    for (let second = 0; second < 30; second += 5) await tick(5000);
    expect(kinds()).toEqual([`session.start:${y}`]);
    expect(f.view.snapshot()).toMatchObject({ sessionId: y, canStop: true });
    expect(f.view.snapshot().phase).not.toBe("stopping");
  });
  it("after the start was transmitted a new tap sends exactly one Stop by the current rights", async () => {
    const { f, y, kinds } = await exitDuringStartSave("saved");
    await f.view.stop(); await tick();
    expect(kinds()).toEqual([`session.start:${y}`, `session.stop:${y}`]);
  });
  // 17.2 (C151): a start whose write failed is no proof of anything unsent: after the save the old rights hold.
  it("a start whose write failed (unavailable): off during the save, then Stop is sent as before", async () => {
    const { f, y, during, stopsOfY, startsOfY } = await exitDuringStartSave("unavailable");
    expect(during.canStop).toBe(false); expect(startsOfY()).toEqual([]); expect(stopsOfY()).toEqual([]);
    // A failed write proves nothing stored: it stays the unknown start of 17.2, not «stored, not sent».
    expect(f.view.snapshot()).toMatchObject({ canStop: true, commands: { primary: { pending: true, startNotSent: false } } });
    await f.view.stop(); await tick();
    expect(stopsOfY()).toHaveLength(1); expect(stopsOfY()[0].session_id).toBe(y);
  });
});

describe("Learning: Stop around a transmitted start keeps its rules (17.2)", () => {
  it("a transmitted start whose reply is lost: «Выйти» stays on while it waits and sends Stop as before", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", null); owners.push(f.view); await f.view.refresh();
    const reply = deferred<Response>();
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).kind === "session.start") return reply.promise;
      return f.handler(url, init);
    });
    const starting = f.view.start(); await tick();
    const y = f.view.snapshot().sessionId!;
    expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
    expect(f.view.snapshot().canStop).toBe(true);
    const stopping = f.view.stop(); await tick();
    expect(f.posts().map(post => `${post.kind}:${post.session_id}`)).toEqual([`session.start:${y}`, `session.stop:${y}`]);
    reply.reject(new TypeError("network")); await starting; await stopping.catch(() => undefined); await tick();
  });
  it("a stalled answer of an open session never blocks «Выйти»", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", id(3)); owners.push(f.view); await f.view.refresh(); await tick();
    const reply = deferred<Response>();
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).kind === "answer.submit") return reply.promise;
      return f.handler(url, init);
    });
    f.view.setDraft("Haus"); const submitting = f.view.submit(); await tick();
    expect(f.view.snapshot().canStop).toBe(true);
    const stopping = f.view.stop(); await tick();
    expect(f.posts().filter(post => post.kind === "session.stop")).toHaveLength(1);
    reply.reject(new TypeError("network")); await submitting; await stopping.catch(() => undefined); await tick();
  });
});

/** Hold the slot read of the start's save (QA-CHAIN-L2 probes S1–S6, reused with assertions). */
async function holdStartSave(sessionId: string | null = null) {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", sessionId); owners.push(f.view); await f.view.refresh(); await tick();
  const state = { gate: deferred<void>(), holding: true };
  const get = vi.mocked(f.storage.get).getMockImplementation()!;
  vi.mocked(f.storage.get).mockImplementation(async key => {
    if (state.holding && key === primaryKey) { state.holding = false; await state.gate.promise; }
    return get(key);
  });
  const kinds = () => f.posts().map(post => `${post.kind}:${post.session_id}`);
  /** Hold the next read of the slot again (e.g. the save of a retry); returns its gate. */
  const hold = () => { state.gate = deferred<void>(); state.holding = true; return state.gate; };
  return { f, gate: { resolve: () => state.gate.resolve() }, kinds, hold };
}

describe("Learning: the 21.1-А boundary is the start of the request itself (QA-CHAIN-L2 F1, F3, F4, F5)", () => {
  it("S1 (F4): no update offers Stop before the start's request began; a Stop from that update goes after the start", async () => {
    const { f, gate, kinds } = await holdStartSave();
    const early: string[][] = []; let tapped = false;
    f.onUpdate.mockImplementation((snapshot: ReturnType<typeof f.view.snapshot>) => {
      if (!snapshot.canStop || snapshot.sessionId === null) return;
      if (!kinds().some(kind => kind.startsWith("session.start"))) early.push(kinds());
      if (!tapped) { tapped = true; void f.view.stop(); }
    });
    const starting = f.view.start(); await tick();
    const y = f.view.snapshot().sessionId!;
    gate.resolve(); await starting; await tick(); await tick(5000);
    expect(early).toEqual([]);
    expect(kinds()).toEqual([`session.start:${y}`, `session.stop:${y}`]);
  });
  it("S4 (F3): stop() in the same tick as start() sends nothing and is not remembered", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", null); owners.push(f.view); await f.view.refresh();
    const starting = f.view.start();
    const sync = f.view.snapshot();
    const early = f.view.stop();
    await tick(); await starting; await early; await tick(5000);
    expect(sync.canStop).toBe(false); expect(sync.commands.primary.preparingStart).toBe(true);
    expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
  });
  it("S3: fetch of the start throws synchronously: the request began, so Stop is sent as after a lost start (17.2)", async () => {
    const { f, gate, kinds } = await holdStartSave();
    const handler = f.fetcher.getMockImplementation()!;
    let first = true;
    f.fetcher.mockImplementation((url, init) => {
      if (init?.method === "POST" && first && JSON.parse(String(init.body)).kind === "session.start") { first = false; throw new TypeError("sync failure"); }
      return handler(url, init);
    });
    const starting = f.view.start(); await tick();
    const y = f.view.snapshot().sessionId!;
    gate.resolve(); await starting; await tick(); await tick(5000);
    expect(f.view.snapshot().canStop).toBe(true);
    expect(f.view.snapshot().commands.primary.startNotSent).toBe(false);
    await f.view.stop(); await tick(5000);
    expect(kinds()).toEqual([`session.start:${y}`, `session.stop:${y}`]);
  });
  it("S5: the start's reply is lost after the request began: «Выйти» on, exactly one Stop (17.2)", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", null); owners.push(f.view); await f.view.refresh();
    const handler = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).kind === "session.start") throw new TypeError("lost");
      return handler(url, init);
    });
    await f.view.start(); await tick();
    expect(f.view.snapshot().canStop).toBe(true);
    // A transmitted start with an unknown outcome is never the stored-but-unsent one.
    expect(f.view.snapshot().commands.primary).toMatchObject({ pending: true, startNotSent: false });
    void f.view.stop(); await tick(5000);
    expect(f.posts().filter(post => post.kind === "session.stop")).toHaveLength(1);
  });
  it("S6 (F5): only a new start turns «Выйти» off: while an answer is being stored Stop is offered and sent", async () => {
    const { f, gate } = await holdStartSave(id(3));
    f.view.setDraft("Haus"); const submitting = f.view.submit(); await tick();
    const during = f.view.snapshot();
    expect(during.commands.primary.preparingStart).toBe(false); expect(during.canStop).toBe(true);
    const stopping = f.view.stop(); await tick();
    gate.resolve(); await submitting; await stopping.catch(() => undefined); await tick(5000);
    expect(f.posts().filter(post => post.kind === "session.stop")).toHaveLength(1);
  });
});

/**
 * The server of these tests for a start it never received: its status by ID is not_found and its session number reads
 * not_found (both under the current state version); with knows, the status reports it applied instead.
 */
function absentStart(f: ReturnType<typeof learningViewFixture>, knows = false) {
  const handler = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (url, init) => {
    const parsed = new URL(String(url), "http://localhost"), v = f.view.snapshot().commands.stateVersion;
    const pending = f.view.snapshot().commands.primary;
    const startId = pending.pendingIntent?.kind === "session.start" ? pending.pendingIntent.command_id : null;
    const y = pending.pendingIntent?.session_id;
    if (init?.method === "GET" && startId && parsed.pathname.endsWith(`/commands/${startId}`) && !knows) {
      return response({ state_version: v, current: profile(v), command: { id: startId, status: "not_found" } });
    }
    if (init?.method === "GET" && y && parsed.pathname.endsWith(`/sessions/${y}`) && !knows) {
      return response({ state_version: v, current: { session_id: y, status: "not_found" } });
    }
    return handler(url, init);
  });
}
/** A start stored under one open handle while a new handle of the same key replaced it: its send never started. */
async function storedNotSent() {
  const { f, gate, kinds, hold } = await holdStartSave();
  const starting = f.view.start(); await tick();
  const y = f.view.snapshot().sessionId!, startId = f.view.snapshot().commands.primary.pendingIntent!.command_id;
  f.replace();
  gate.resolve(); await starting; await tick(); await tick(5000);
  return { f, kinds, y, startId, hold };
}
const startsOf = (f: ReturnType<typeof learningViewFixture>) => f.posts().filter(post => post.kind === "session.start");

describe("Learning: a start stored but never sent because the open handle was replaced (33.1-А, C194)", () => {
  it("no Stop of Y is offered or sent; the check under the new handle sends the same start once and lands in it", async () => {
    const { f, kinds, y, startId } = await storedNotSent();
    const after = f.view.snapshot();
    expect(after.canStop).toBe(false);
    expect(after.commands.primary).toMatchObject({ pending: true, preparingStart: false, startNotSent: true });
    expect(kinds()).toEqual([]);
    expect(JSON.parse(f.values.get(primaryKey)!).intent).toMatchObject({ kind: "session.start", session_id: y, command_id: startId });
    await f.view.stop(); await tick();
    expect(kinds()).toEqual([]);
    // What the host does on a new open handle: one check of the record, then the one send of the very same start.
    absentStart(f); await f.view.refresh(); await tick(); await tick(5000);
    expect(startsOf(f)).toEqual([expect.objectContaining({ command_id: startId, session_id: y })]);
    expect(kinds()).toEqual([`session.start:${y}`]);
    expect(f.view.snapshot()).toMatchObject({ sessionId: y, canStop: true, commands: { primary: { pending: false, startNotSent: false } } });
    expect(f.values.has(primaryKey)).toBe(false);
    // Nothing more by itself, and a second check sends nothing again.
    await f.view.refresh(); for (let second = 0; second < 30; second += 5) await tick(5000);
    expect(startsOf(f)).toHaveLength(1);
  });
  it("the check finds the start applied: it is settled from the check, no POST at all", async () => {
    const { f, y, startId } = await storedNotSent();
    const handler = f.fetcher.getMockImplementation()!;
    // The session S of this number exists on the server (created before this check): its status and its read show it.
    const step = { ...current(y), group: { ...current().group, status: "assembling" as const, preview_position: 0 }, assignment: null,
      preview: { id: id(20), card_id: id(21), position: 1, total: 1, content: previewContent(id(21)) } };
    f.fetcher.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url), "http://localhost"), v = f.view.snapshot().commands.stateVersion;
      if (init?.method === "GET" && parsed.pathname.endsWith(`/commands/${startId}`)) {
        return response({ state_version: v, current: step, command: { ...fact({ command_id: startId, kind: "session.start", session_id: y, payload: { mode: "learning" } } as never), status: "already_applied" } });
      }
      if (init?.method === "GET" && parsed.pathname.endsWith(`/sessions/${y}`)) return response({ state_version: v, current: step });
      return handler(url, init);
    });
    await f.view.refresh(); await tick(); await tick(5000);
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot()).toMatchObject({ sessionId: y, phase: "preview", commands: { primary: { pending: false, outcome: "accepted", startNotSent: false } } });
  });
  it("two checks at once (a second foreground during the first) and a manual retry still send the start once", async () => {
    const { f, startId } = await storedNotSent();
    absentStart(f);
    const first = f.view.refresh(), second = f.view.refresh(), manual = f.view.retry("primary");
    await Promise.all([first, second, manual]); await tick(); await tick(5000);
    await f.view.retry("primary"); await f.view.refresh(); await tick(5000);
    expect(startsOf(f).map(post => post.command_id)).toEqual([startId]);
  });
  it("a check that cannot prove absence (status not found, session still unreadable) sends nothing", async () => {
    const { f } = await storedNotSent();
    const handler = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "GET") throw new TypeError("offline");
      return handler(url, init);
    });
    await f.view.refresh(); await tick(); await tick(5000);
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot()).toMatchObject({ canStop: false, commands: { primary: { startNotSent: true } } });
  });
});

describe("Learning: the check of a stored, never sent start (QA-STOPY-R4 F6, F7)", () => {
  it("F6: its status is not found but the session read finds S: S is recovered, no POST, Stop by the rights of S", async () => {
    const { f, y } = await storedNotSent();
    const step = { ...current(y), group: { ...current().group, status: "assembling" as const, preview_position: 0 }, assignment: null,
      preview: { id: id(20), card_id: id(21), position: 1, total: 1, content: previewContent(id(21)) } };
    const handler = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url), "http://localhost"), v = f.view.snapshot().commands.stateVersion;
      const startId = f.view.snapshot().commands.primary.pendingIntent?.command_id;
      if (init?.method === "GET" && startId && parsed.pathname.endsWith(`/commands/${startId}`)) {
        return response({ state_version: v, current: profile(v), command: { id: startId, status: "not_found" } });
      }
      if (init?.method === "GET" && parsed.pathname.endsWith(`/sessions/${y}`)) return response({ state_version: v, current: step });
      return handler(url, init);
    });
    await f.view.refresh(); await tick(); await tick(5000);
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot()).toMatchObject({ sessionId: y, phase: "preview", canStop: true, commands: { primary: { startNotSent: false } } });
    await f.view.stop(); await tick(5000);
    expect(f.posts().map(post => `${post.kind}:${post.session_id}`)).toEqual([`session.stop:${y}`]);
  });
  // Q15, Q16 of QA-STOPY-R4: a retry of the lanes started by a subscriber of the very update that ends the check, past
  // the view's own gates; in Q16 its save is slow, so the check's automatic send meets it mid-flight.
  const commandsOf = (view: LearningViewController) => (view as unknown as { commands: { retry(lane: "primary"): Promise<void> } }).commands;
  it("F7 (Q15): a lanes retry fired by a subscriber of the update that ends the check still gives one POST", async () => {
    const { f } = await storedNotSent(); absentStart(f);
    let fired = false;
    f.onUpdate.mockImplementation((snapshot: ReturnType<typeof f.view.snapshot>) => {
      if (!fired && snapshot.commands.primary.canRetry && snapshot.commands.primary.startNotSent) { fired = true; void commandsOf(f.view).retry("primary"); }
    });
    await f.view.refresh(); await tick(); await tick(5000); await f.view.refresh(); await tick(5000);
    expect(fired).toBe(true);
    expect(startsOf(f)).toHaveLength(1);
  });
  it("F7 (Q16): the same with the retry's own save held: still one POST", async () => {
    const { f, hold } = await storedNotSent(); absentStart(f);
    const gate = hold();
    let fired = false;
    f.onUpdate.mockImplementation((snapshot: ReturnType<typeof f.view.snapshot>) => {
      if (!fired && snapshot.commands.primary.canRetry && snapshot.commands.primary.startNotSent) { fired = true; void commandsOf(f.view).retry("primary"); }
    });
    const checking = f.view.refresh(); await tick(); await tick(20);
    gate.resolve(); await checking; await tick(); await tick(5000);
    await f.view.refresh(); await tick(5000);
    expect(fired).toBe(true);
    expect(startsOf(f)).toHaveLength(1);
  });
});

describe("Learning: a start refused by the API's local checks right before its request (QA r3)", () => {
  it("the request never started: «stored, not sent» stays, no Stop is offered, and no POST of anything", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", null); owners.push(f.view); await f.view.refresh();
    // An open handle whose token the session API refuses (prepareCommand throws before request): same key, live owner.
    f.replace({ session: null }, "");
    await f.view.start(); await tick(); await tick(5000);
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot()).toMatchObject({ canStop: false, commands: { live: true, primary: { pending: true, startNotSent: true } } });
    await f.view.stop(); await tick();
    expect(f.posts()).toEqual([]);
  });
});

describe("The transport tells «started» only right before fetch (C198)", () => {
  it("a body that cannot be serialized: neither started nor fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response({}));
    const started = vi.fn();
    const request = createJsonTransport({ fetcher, timeoutMs: 1000, maxResponseBytes: 1000 });
    await expect(request("/commands", { method: "POST", body: { value: 1n }, started })).rejects.toThrow();
    expect(started).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("a built request: started once, before fetch is called", async () => {
    const order: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => { order.push("fetch"); return response({}); });
    const request = createJsonTransport({ fetcher, timeoutMs: 1000, maxResponseBytes: 1000 });
    await request("/commands", { method: "POST", body: { value: 1 }, started: () => order.push("started") });
    expect(order).toEqual(["started", "fetch"]);
  });
});

describe("Learning: outside 33.1-А nothing is sent by itself", () => {
  it("a transmitted start whose reply was lost (17.2): no automatic resend on a check; Stop as before", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", null); owners.push(f.view); await f.view.refresh();
    const handler = f.fetcher.getMockImplementation()!;
    let lose = true;
    f.fetcher.mockImplementation(async (url, init) => {
      if (lose && init?.method === "POST" && JSON.parse(String(init.body)).kind === "session.start") { lose = false; throw new TypeError("lost"); }
      return handler(url, init);
    });
    await f.view.start(); await tick();
    absentStart(f); await f.view.refresh(); await tick(); await tick(5000);
    expect(startsOf(f)).toHaveLength(1);
    expect(f.view.snapshot()).toMatchObject({ canStop: true, commands: { primary: { startNotSent: false } } });
  });
  it("a start record of another window (or a reload) is never sent from here (2.3-А)", async () => {
    vi.useFakeTimers();
    const y = id(40), record = { schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de",
      intent: { command_id: id(41), kind: "session.start", session_id: y, payload: { mode: "learning" } } };
    const f = learningViewFixture("normal", null); owners.push(f.view);
    f.values.set(primaryKey, JSON.stringify(record));
    absentStart(f); await f.view.refresh(); await tick(); await tick(5000);
    await f.view.refresh(); await tick(5000);
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot().commands.primary.startNotSent).toBe(false);
  });
  it("a closed or denied owner keeps no «stored, not sent»", async () => {
    const { f, gate } = await holdStartSave();
    const starting = f.view.start(); await tick();
    f.revoke();
    gate.resolve(); await starting; await tick(); await tick(5000);
    expect(f.posts()).toEqual([]);
    expect(f.view.snapshot().commands.primary.startNotSent).toBe(false);
  });
});

/** An open session Y of the fixture's pair, as the core projects a session just started (QA-STOPY-R4 r5 probes). */
const openSession = (y: string, extra: Record<string, unknown> = {}) => ({ ...current(y),
  group: { ...current().group, status: "assembling" as const, preview_position: 0 }, assignment: null,
  preview: { id: id(20), card_id: id(21), position: 1, total: 1, content: previewContent(id(21)) }, ...extra });
/** The status of the start says not_found; the read of Y answers read(version). */
function foundByRead(f: ReturnType<typeof learningViewFixture>, y: string, startId: string, read: (v: string) => unknown) {
  const handler = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (url, init) => {
    const parsed = new URL(String(url), "http://localhost"), v = f.view.snapshot().commands.stateVersion;
    if (init?.method === "GET" && parsed.pathname.endsWith(`/commands/${startId}`)) {
      return response({ state_version: v, current: profile(v), command: { id: startId, status: "not_found" } });
    }
    if (init?.method === "GET" && parsed.pathname.endsWith(`/sessions/${y}`)) return response({ state_version: v, current: read(v) });
    return handler(url, init);
  });
}

describe("Learning: the F6 erase is only for this window's own never sent start (QA-STOPY-R4 r5 N4, N5, N9, N12, N13)", () => {
  it("N4: the record of a previous owner (a new owner on the same storage knows nothing unsent): kept, 0 POST", async () => {
    const { f, y, startId } = await storedNotSent(); foundByRead(f, y, startId, () => openSession(y));
    const next = f.make();
    await next.refresh(); await tick(5000);
    expect(f.values.get(primaryKey)).toBeDefined(); expect(f.posts()).toEqual([]);
    expect(next.snapshot().primary).toMatchObject({ pending: true, startNotSent: false });
    next.dispose();
  });
  it("N5: a transmitted start whose reply was lost is no «not sent» one: its record is kept when S is found", async () => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", null); owners.push(f.view); await f.view.refresh();
    const handler = f.fetcher.getMockImplementation()!; let lose = true;
    f.fetcher.mockImplementation(async (url, init) => {
      if (lose && init?.method === "POST" && JSON.parse(String(init.body)).kind === "session.start") { lose = false; throw new TypeError("lost"); }
      return handler(url, init);
    });
    await f.view.start(); await tick();
    const y = f.view.snapshot().sessionId!, startId = f.view.snapshot().commands.primary.pendingIntent!.command_id;
    foundByRead(f, y, startId, () => openSession(y));
    await f.view.refresh(); await tick(5000);
    expect(f.values.get(primaryKey)).toBeDefined(); expect(startsOf(f)).toHaveLength(1);
  });
  it("N9: another window's record in the slot at the moment of clearing stays untouched", async () => {
    const { f, y, startId } = await storedNotSent(); foundByRead(f, y, startId, () => openSession(y));
    const other = JSON.stringify(pending(original(action(), 777)));
    f.values.set(primaryKey, other);
    await f.view.refresh(); await tick(5000);
    expect(f.values.get(primaryKey)).toBe(other); expect(f.posts()).toEqual([]);
  });
  it("N12: a failed clear keeps the record and the pending start, sends nothing; the next check clears it and recovers S", async () => {
    const { f, y, startId } = await storedNotSent(); foundByRead(f, y, startId, () => openSession(y));
    let broken = true;
    const remove = vi.mocked(f.storage.remove).getMockImplementation()!;
    vi.mocked(f.storage.remove).mockImplementation(async key => { if (broken) throw new Error("quota"); return remove(key); });
    await f.view.refresh(); await tick(5000);
    expect(f.values.get(primaryKey)).toBeDefined(); expect(f.posts()).toEqual([]);
    expect(f.view.snapshot().commands.primary.pending).toBe(true);
    broken = false;
    await f.view.refresh(); await tick(5000);
    expect(f.posts()).toEqual([]); expect(f.values.get(primaryKey)).toBeUndefined();
    expect(f.view.snapshot()).toMatchObject({ sessionId: y, phase: "preview" });
  });
  it("N13: a session read below the version the status raised erases nothing (stale_response)", async () => {
    const { f, y, startId } = await storedNotSent();
    const handler = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => {
      const parsed = new URL(String(url), "http://localhost");
      if (init?.method === "GET" && parsed.pathname.endsWith(`/commands/${startId}`)) {
        return response({ state_version: "5", current: profile("5"), command: { id: startId, status: "not_found" } });
      }
      if (init?.method === "GET" && parsed.pathname.endsWith(`/sessions/${y}`)) return response({ state_version: "3", current: openSession(y) });
      return handler(url, init);
    });
    await f.view.refresh(); await tick(5000);
    expect(f.values.get(primaryKey)).toBeDefined(); expect(f.posts()).toEqual([]);
    expect(f.view.snapshot().commands.primary).toMatchObject({ pending: true, problem: "stale_response" });
  });
  // F9 (C231): an already created session is recovered whatever its open phase (33.1/35.1), the summary included.
  it("F9: an open S in its summary is a found S: record erased, no POST, no automatic summary_home or Stop", async () => {
    const { f, y, startId } = await storedNotSent(); foundByRead(f, y, startId, () => ({ ...current(y), status: "summary", assignment: null }));
    await f.view.refresh(); await tick(5000);
    for (let second = 0; second < 30; second += 5) await tick(5000);
    expect(f.values.get(primaryKey)).toBeUndefined(); expect(f.posts()).toEqual([]);
    expect(f.view.snapshot()).toMatchObject({ sessionId: y, commands: { primary: { pending: false, startNotSent: false } } });
  });
});
