import { describe, expect, it, vi } from "vitest";
import type { DictionaryCardView } from "../api/generated";
import {
  DictionaryIntervalController, dictionaryIntervalPort, type DictionaryIntervalSnapshot, type IntervalClock,
} from "./dictionaryIntervalController";
import { createDictionaryIntervalApi } from "./intervalApi";
import { testGate } from "../commands/testGate.test-support";

// Synthetic server shaped after core dictionary_interval.py / coordinator.py (fact fields, refusal codes,
// state bump only on acceptance, version+1 on undo, A01 row insert/delete). Steps: CORE_HANDOFF_CP2 §5.
// Core C-INTV: one interval state, the written L1->De; the oral direction is never increased.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CARD = id(1), OTHER_CARD = id(2), CLIENT = id(3), DOCUMENT = id(4), PROFILE = id(5);
const TODAY = "2026-09-29";
const BIG = 9007199254740993n;
const LADDER: Array<[number, number]> = [[1, 15], [2, 23], [3, 36], [4, 58], [5, 94], [6, 155], [7, 259], [8, 438]];
const A01_FORWARD: Array<[number, number]> = [[2, 3], [3, 5], [4, 8]];
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
// Enough for a command, its status check (the intent hash is WebCrypto, a macrotask) and the automatic offer command behind it.
const settle = async () => {
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await new Promise(done => setTimeout(done, 0));
  }
};

type Written = { version: bigint | null; days: number; due: string; options: Array<[number, number]> };
const SAVED = (): Written => ({ version: BIG, days: 10, due: "2026-10-05", options: LADDER });
const A01 = (): Written => ({ version: null, days: 1, due: TODAY, options: A01_FORWARD });
// Core default_option_id: +5, the last when fewer (synthetic server copy of the server rule).
const defaultOption = (options: Array<{ option_id: number }>) =>
  options.filter(option => option.option_id <= 5).at(-1)?.option_id ?? options[0]?.option_id ?? null;
type Route = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;

function server(start = 41n, written: Written = SAVED()) {
  const s = {
    state: start, zone: true as boolean, written,
    contexts: new Map<string, { card: string; status: "open" | "closed" }>(),
    right: null as null | { action: string; context: string; version: bigint; status: "available" | "used" | "expired"; before: Written;
      offer: { status: "pending" | "offered" | "closed" | "consumed"; version: bigint } },
    commands: new Map<string, { semantic: string; fact: Record<string, unknown> }>(),
    routes: [] as Route[], next: 500,
  };
  const view = (card: string): DictionaryCardView => ({
    status: "available",
    content: { pair: "ru-de", card: { id: card, revision: "3", lemma: "Haus", type: "noun", cefr: "A1" },
      translations: { common: ["дом"], personal: null }, grammar: null, reference_conjugations: [],
      examples: { common: [], personal: null }, association: null, field_versions: { translation: "1", example: "1", association: "1" } },
    study: { status: "available", card_id: card, card_revision: "3", pair: "ru-de", card_type: "noun", local_date: s.zone ? TODAY : null,
      facts: { common_translation_present: true, exclusion: { excluded: false, version: null }, manual: { selected: false, selection_version: "1" },
        learning: { ever_selected: true, finished_or_skipped: true, current: null }, non_learning_history: false },
      directions: [
        s.written.version === null
          ? { direction: "l1-de", introduced: true, progress_present: false, progress_version: null, schedule: null, interval_preview: null }
          : { direction: "l1-de", introduced: true, progress_present: true, progress_version: String(s.written.version),
            schedule: { interval_days: s.written.days, next_due_date: s.written.due },
            interval_preview: s.zone ? s.written.options.map(([step_id, days]) => ({ step_id, interval_days: days, next_due_date: addDays(TODAY, days) })) : null },
        { direction: "de-l1", introduced: true, progress_present: false, progress_version: null, schedule: null, interval_preview: null },
      ] },
    card_actions: { exclude: true, return: false, relearn: true },
  });
  const project = (contextId: string) => {
    const context = s.contexts.get(contextId);
    if (!context) return { status: "unavailable" };
    const reference = { id: contextId, kind: "dictionary", card_id: context.card };
    if (context.status === "closed") return { status: "closed", context: reference };
    const w = s.written, options = w.options.map(([option_id, days]) => ({ option_id, interval_days: days, next_due_date: addDays(TODAY, days) }));
    const interval = s.zone ? { local_date: TODAY, expected_pair: "ru-de", direction: "l1-de", applicable: true,
      current_schedule: w.version === null ? { interval_days: 1, next_due_date: TODAY, persisted: false }
        : { interval_days: w.days, next_due_date: w.due, persisted: true },
      expected_progress_version: w.version === null ? null : String(w.version), options, default_option_id: defaultOption(options) } : null;
    // Core C-INTV-OFFER: a live offer is pending until action.undo_offer.open; undo_target only while offered.
    const live = s.right && s.right.context === contextId && s.right.status === "available"
      && (s.right.offer.status === "pending" || s.right.offer.status === "offered") ? s.right : null;
    const undo_offer = live ? { action_id: live.action, context_id: contextId, status: live.offer.status, version: String(live.offer.version) } : null;
    const undo_target = live && live.offer.status === "offered"
      ? { action_id: live.action, kind: "interval.increase", version: String(live.version), context_id: contextId } : null;
    return { status: "open", context: reference, view: view(context.card), interval,
      capabilities: { interval_increase: interval && options.length ? { direction: "l1-de" } : null, undo_offer, undo_target } };
  };
  const reply = (command: unknown, contextId: string | null, extra: Record<string, unknown> = {}, status = 200) =>
    json({ command, current: contextId ? project(contextId) : { status: "unavailable" }, state_version: String(s.state), ...extra }, status);
  const refuse = (commandId: string, code: string, contextId: string | null) =>
    reply({ id: commandId, status: "rejected" }, contextId, { error: { code } }, code === "VALIDATION_FAILED" ? 422 : 409);
  const fact = (body: any, fields: Record<string, unknown>) => ({ id: body.command_id, kind: body.kind, status: "applied",
    applied_at: "2026-09-29T12:00:00Z", target_id: CARD, action_id: null, result_id: null, context_id: body.context_id ?? null, object_version: null, ...fields });
  const apply = (body: any): Response => {
    const contextId: string | null = body.context_id ?? null, context = contextId ? s.contexts.get(contextId) : undefined;
    if (body.kind === "context.open") {
      if (body.payload.card_id !== CARD) return refuse(body.command_id, "ASSIGNMENT_STALE", null);
      for (const other of s.contexts.values()) other.status = "closed";
      if (s.right?.status === "available") s.right.status = "expired";
      const created = id(s.next++); s.contexts.set(created, { card: CARD, status: "open" });
      s.state++; return remember(body, fact(body, { context_id: created }), created);
    }
    if (!context || context.status !== "open") return refuse(body.command_id, "DOCUMENT_STALE", contextId);
    if (body.kind === "context.close") {
      context.status = "closed"; if (s.right?.context === contextId && s.right.status === "available") s.right.status = "expired";
      s.state++; return remember(body, fact(body, {}), contextId);
    }
    if (body.kind === "interval.increase") {
      if (!s.zone) return refuse(body.command_id, "SETUP_REQUIRED", contextId);
      if (body.payload.expected_local_date !== TODAY) return refuse(body.command_id, "VERSION_CONFLICT", contextId);
      const payload = body.payload, expected = body.expected_progress_version, w = s.written;
      if (payload.direction !== "l1-de") return refuse(body.command_id, "VALIDATION_FAILED", contextId);
      const option = w.options.find(([option_id]) => option_id === payload.option_id);
      if ((w.version === null ? expected !== null : expected !== String(w.version)) || !option || option[1] !== payload.interval_days
        || addDays(TODAY, option[1]) !== payload.next_due_date) return refuse(body.command_id, "VERSION_CONFLICT", contextId);
      const before = structuredClone(w);
      // The longer steps stay offered, renumbered from the new state.
      s.written = { version: (w.version ?? 0n) + 1n, days: payload.interval_days, due: payload.next_due_date,
        options: w.options.filter(([, days]) => days > payload.interval_days).map(([, days], index) => [index + 1, days]) };
      const action = id(s.next++);
      s.right = { action, context: contextId!, version: 1n, status: "available", before, offer: { status: "pending", version: 1n } };
      s.state++; return remember(body, fact(body, { action_id: action, object_version: "1" }), contextId);
    }
    const right = s.right;
    if (body.kind === "action.undo_offer.open" || body.kind === "action.undo_offer.close") {
      const offer = right?.offer;
      if (!right || right.action !== body.action_id || right.status !== "available" || right.context !== contextId
        || !offer || (offer.status !== "pending" && offer.status !== "offered")) return refuse(body.command_id, "CAPABILITY_EXPIRED", contextId);
      if (String(offer.version) !== body.expected_offer_version
        || body.kind === "action.undo_offer.open" && offer.status !== "pending") return refuse(body.command_id, "VERSION_CONFLICT", contextId);
      offer.version++; offer.status = body.kind === "action.undo_offer.open" ? "offered" : "closed";
      if (offer.status === "closed") right.status = "expired";
      s.state++; return remember(body, fact(body, { target_id: right.action, object_version: String(offer.version) }), contextId);
    }
    if (!right || right.action !== body.action_id || right.status !== "available" || right.context !== contextId) return refuse(body.command_id, "CAPABILITY_EXPIRED", contextId);
    if (right.offer.status !== "offered") return refuse(body.command_id, "CAPABILITY_EXPIRED", contextId);
    if (String(right.version) !== body.expected_action_version) return refuse(body.command_id, "VERSION_CONFLICT", contextId);
    const was = right.before;
    s.written = was.version === null ? was : { ...was, version: s.written.version! + 1n };
    right.status = "used"; right.version += 1n; right.offer.status = "consumed";
    s.state++; return remember(body, fact(body, { action_id: right.action, object_version: String(right.version) }), contextId);
  };
  function remember(body: any, stored: Record<string, unknown>, contextId: string | null): Response {
    s.commands.set(body.command_id, { semantic: JSON.stringify({ ...body, command_id: null }), fact: stored });
    return reply(stored, contextId);
  }
  const handle = (path: string, init: RequestInit): Response => {
    const url = new URL(path, "http://local");
    if (url.pathname === "/api/v1/commands" && init.method === "POST") {
      const body = JSON.parse(String(init.body)), stored = s.commands.get(body.command_id);
      if (stored && stored.semantic !== JSON.stringify({ ...body, command_id: null })) return refuse(body.command_id, "COMMAND_PAYLOAD_MISMATCH", body.context_id ?? null);
      if (stored) return reply({ ...stored.fact, status: "already_applied" }, (stored.fact.context_id as string) ?? null);
      return apply(body);
    }
    const contextMatch = /^\/api\/v1\/dictionary\/contexts\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (contextMatch && init.method === "GET") return json({ current: project(contextMatch[1]), state_version: String(s.state) });
    const statusMatch = /^\/api\/v1\/commands\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (statusMatch && init.method === "GET") {
      const stored = s.commands.get(statusMatch[1]);
      // Core echoes the verified hash of the stored fact (command_status.py:192-204).
      return stored ? reply({ ...stored.fact, status: "already_applied" }, (stored.fact.context_id as string) ?? null,
        { verified_intent_hash: url.searchParams.get("expected_intent_hash") })
        : json({ command: { id: statusMatch[1], status: "not_found" }, state_version: String(s.state),
          current: { profile_id: PROFILE, access: { status: "admitted", version: "1", reason: null }, role: "user",
            ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: String(s.state) } });
    }
    throw new Error(`unexpected ${init.method} ${path}`);
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const route = s.routes.shift(), path = String(input);
    return (route && await route(path, init!)) ?? handle(path, init!);
  });
  return Object.assign(s, { fetcher, handle, project });
}

/** Monotonic test time: timers run only when the test moves the time (CT 2.1.2 p.3). */
function manualClock() {
  let time = 1000;
  const timers = new Map<number, { at: number; run(): void }>();
  let serial = 0;
  const clock: IntervalClock = {
    now: () => time,
    setTimeout: (run, ms) => { const handle = ++serial; timers.set(handle, { at: time + ms, run }); return handle; },
    clearTimeout: handle => { timers.delete(handle as number); },
  };
  /** run=false moves the time only: a click may land exactly at the deadline before its callback runs. */
  const advance = (ms: number, run = true) => {
    time += ms;
    if (!run) return;
    for (const [handle, timer] of [...timers]) if (timer.at <= time) { timers.delete(handle); timer.run(); }
  };
  return { clock, advance, pending: () => timers.size };
}

function fixture(start?: bigint, minimum?: () => string | null, written?: Written) {
  const srv = server(start, written);
  let next = 100;
  const newId = vi.fn(() => id(next++));
  const seen: DictionaryIntervalSnapshot[] = [];
  let live = true;
  const time = manualClock();
  const api = createDictionaryIntervalApi({ fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() });
  const controller = new DictionaryIntervalController({
    port: dictionaryIntervalPort(api, "synthetic-token", "synthetic-proof", { client_instance_id: CLIENT, document_id: DOCUMENT }),
    isLive: () => live, newId, minimumStateVersion: minimum, onUpdate: snapshot => { seen.push(snapshot); }, clock: time.clock,
  });
  const calls = () => srv.fetcher.mock.calls.map(([url, init]) => `${init!.method} ${new URL(String(url), "http://local").pathname}`);
  const posts = () => srv.fetcher.mock.calls.filter(([, init]) => init!.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
  return { srv, controller, newId, seen, calls, posts, time, end: () => { live = false; } };
}
/** An accepted increase and its one automatic action.undo_offer.open (CT 2.1.2 p.2). */
async function increased(f: ReturnType<typeof fixture>, option_id: number) {
  await f.controller.increase({ option_id });
  await settle();
}
async function ready(f: ReturnType<typeof fixture>) {
  await f.controller.open(CARD);
  expect(f.controller.snapshot()).toMatchObject({ phase: "ready", canIncrease: true, canUndo: false, pending: null });
}
const lost = (s: ReturnType<typeof server>, apply: boolean): Route => (path, init) => {
  if (apply) s.handle(path, init);
  throw new TypeError("connection reset");
};

describe("B1/B9: open, increase and undo from the server offer", () => {
  it("one POST per action; A01 sends version null and then shows the saved row as version 1", async () => {
    const f = fixture(undefined, undefined, A01());
    await ready(f);
    expect(f.controller.snapshot().interval).toMatchObject({ direction: "l1-de", expected_progress_version: null, default_option_id: 4 });
    await increased(f, 2);
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.posts()[2]).toMatchObject({ context_id: id(500), expected_offer_version: "1", payload: {} });
    expect(f.posts()[1]).toMatchObject({ expected_progress_version: null,
      payload: { direction: "l1-de", option_id: 2, interval_days: 3, next_due_date: "2026-10-02" } });
    expect(f.posts()[1]).not.toHaveProperty("expected_progress_versions");
    expect(f.posts()[1].payload).not.toHaveProperty("selections");
    const after = f.controller.snapshot();
    expect(after).toMatchObject({ phase: "ready", canUndo: true, problem: null,
      capabilities: { undo_target: { kind: "interval.increase", version: "1" } } });
    expect(after.interval!).toMatchObject({ expected_progress_version: "1",
      current_schedule: { interval_days: 3, next_due_date: "2026-10-02", persisted: true } });
    await f.controller.undo();
    expect(f.posts()).toHaveLength(4);
    expect(f.posts()[3]).toMatchObject({ kind: "action.undo", expected_action_version: "1" });
    expect(f.controller.snapshot()).toMatchObject({ canUndo: false, capabilities: { undo_target: null } });
    expect(f.controller.snapshot().interval!.current_schedule).toEqual({ interval_days: 1, next_due_date: TODAY, persisted: false });
    expect(f.calls().filter(call => call.startsWith("GET"))).toEqual([]);
  });
});

describe("B2: one pending intent", () => {
  it("a second tap while sending creates no second POST", async () => {
    const f = fixture();
    await ready(f);
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    const first = f.controller.increase({ option_id: 2 });
    expect(f.controller.snapshot()).toMatchObject({ pending: { kind: "interval.increase", status: "sending" }, canIncrease: false, canUndo: false });
    await f.controller.increase({ option_id: 1 });
    await f.controller.undo();
    held.resolve(); await first; await settle();
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
  });
});

describe("B3: unknown outcome is resolved by one status and only an explicit retry repeats the same command", () => {
  it("lost reply of an applied increase: one status GET, no repeat POST", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(lost(f.srv, true));
    await increased(f, 2);
    // The status check names the same offer; it is opened once, as after a delivered reply (CT 2.1.2 p.1).
    expect(f.calls().slice(-3)).toEqual(["POST /api/v1/commands", `GET /api/v1/commands/${id(101)}`, "POST /api/v1/commands"]);
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, problem: null, canUndo: true });
  });

  it("not_found keeps the intent; status current is a profile and is not shown; retry sends the same ID and payload", async () => {
    const f = fixture();
    await ready(f);
    const shown = f.controller.snapshot();
    f.srv.routes.push(lost(f.srv, false));
    await f.controller.increase({ option_id: 2 });
    const waiting = f.controller.snapshot();
    expect(waiting).toMatchObject({ pending: { kind: "interval.increase", commandId: id(101), status: "unknown" },
      problem: { reason: "not_found" }, canRetry: true, canIncrease: false, canUndo: false, context: shown.context });
    expect(waiting.view).toEqual(shown.view);
    expect(f.posts()).toHaveLength(2);
    await f.controller.retry(); await settle();
    expect(f.posts()).toHaveLength(4);
    expect(f.posts()[2]).toEqual(f.posts()[1]);
    expect(f.posts()[3].kind).toBe("action.undo_offer.open");
    expect(f.newId).toHaveBeenCalledTimes(3);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canUndo: true, canRetry: false });
  });

  it("a status that also fails stays unknown and is checked again only by refresh", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(lost(f.srv, true), () => { throw new TypeError("still offline"); });
    await f.controller.increase({ option_id: 2 });
    expect(f.controller.snapshot()).toMatchObject({ pending: { status: "unknown" }, problem: { reason: "network" }, canRetry: true });
    const count = f.calls().length;
    await f.controller.refresh(); await settle();
    expect(f.calls().slice(count)).toEqual([`GET /api/v1/commands/${id(101)}`, "POST /api/v1/commands",
      `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canUndo: true });
  });

  it("5xx and an invalid 200 are unknown too; an HTTP 4xx without fact is a known refusal", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(() => json({ error: { code: "WRITE_UNAVAILABLE" } }, 503));
    await f.controller.increase({ option_id: 2 });
    expect(f.calls().at(-1)).toBe(`GET /api/v1/commands/${id(101)}`);
    expect(f.controller.snapshot()).toMatchObject({ canRetry: true, problem: { reason: "not_found" } });
    await f.controller.retry(); await settle();
    f.srv.routes.push(() => json({ error: { code: "VALIDATION_FAILED" } }, 422));
    await f.controller.undo();
    expect(f.calls().at(-1)).toBe("POST /api/v1/commands");
    expect(f.controller.snapshot()).toMatchObject({ pending: null, problem: { reason: "invalid", code: "VALIDATION_FAILED" }, canRetry: false });
  });
});

describe("B4 and refusals: no automatic command", () => {
  it("VERSION_CONFLICT: exactly one context read, the new preview, and the choice is not applied silently", async () => {
    const f = fixture();
    await ready(f);
    f.srv.written = { ...f.srv.written, version: BIG + 1n }; // another installation answered
    await f.controller.increase({ option_id: 1 });
    expect(f.calls().slice(-2)).toEqual(["POST /api/v1/commands", `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.posts()).toHaveLength(2);
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "rejected", code: "VERSION_CONFLICT" }, pending: null, canIncrease: true });
    expect(f.controller.snapshot().interval!.expected_progress_version).toBe("9007199254740994");
  });

  it("CAPABILITY_EXPIRED: undo disappears and the context is read once", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    f.srv.right!.status = "expired"; // the next accepted action elsewhere ended it
    await f.controller.undo();
    expect(f.calls().slice(-2)).toEqual(["POST /api/v1/commands", `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.controller.snapshot()).toMatchObject({ problem: { code: "CAPABILITY_EXPIRED" }, canUndo: false, capabilities: { undo_target: null } });
  });

  it("DOCUMENT_STALE: a context closed elsewhere shows no offer", async () => {
    const f = fixture();
    await ready(f);
    f.srv.contexts.get(id(500))!.status = "closed";
    await f.controller.increase({ option_id: 2 });
    expect(f.calls().at(-1)).toBe(`GET /api/v1/dictionary/contexts/${id(500)}`);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", problem: { code: "DOCUMENT_STALE" }, canIncrease: false, canUndo: false });
  });

  it("SETUP_REQUIRED: no interval, no read and no repeat", async () => {
    const f = fixture();
    await ready(f);
    f.srv.zone = false;
    await f.controller.increase({ option_id: 2 });
    expect(f.calls().at(-1)).toBe("POST /api/v1/commands");
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "setup_required", code: "SETUP_REQUIRED" }, interval: null,
      canIncrease: false, canRetry: false, capabilities: { interval_increase: null } });
    expect(() => f.controller.increase({ option_id: 2 })).toThrow("interval increase is not offered");
    expect(f.posts()).toHaveLength(2);
  });

  it("an open refusal showing another card's earlier context is not published", async () => {
    const f = fixture();
    f.srv.routes.push(() => json({ command: { id: id(100), status: "rejected" }, error: { code: "COMMAND_PAYLOAD_MISMATCH" },
      state_version: "50", current: { status: "closed", context: { id: id(900), kind: "dictionary", card_id: OTHER_CARD } } }, 409));
    await f.controller.open(CARD);
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", context: null, view: null, problem: { reason: "mismatch" }, canIncrease: false });
  });
});

describe("B5/B10: no response older than a known state replaces it", () => {
  it("a read sent before increase+undo and answered after them keeps the undone state (BigInt floor)", async () => {
    // The late read carries 9007199254740996, the undo 9007199254740997: both are the same Number
    // (9007199254740996), so only the BigInt floor sees the read as older.
    const f = fixture(9007199254740993n, undefined, A01());
    await ready(f);
    expect(f.controller.snapshot().stateVersion).toBe("9007199254740994");
    await increased(f, 2); // increase 9007199254740995, its offer open 9007199254740996
    const held = deferred<void>();
    let early!: Response;
    f.srv.routes.push(async (path, init) => { early = f.srv.handle(path, init); await held.promise; return early; });
    const reading = f.controller.refresh();
    await settle();
    await f.controller.undo();
    expect(f.controller.snapshot()).toMatchObject({ stateVersion: "9007199254740997", canUndo: false });
    held.resolve(); await reading;
    const after = f.controller.snapshot();
    expect(after).toMatchObject({ stateVersion: "9007199254740997", canUndo: false, capabilities: { undo_target: null } });
    expect(after.interval!.current_schedule).toEqual({ interval_days: 1, next_due_date: TODAY, persisted: false });
  });

  it("int64 progress versions are sent as exact strings", async () => {
    const f = fixture();
    await ready(f);
    await f.controller.increase({ option_id: 1 });
    expect(JSON.stringify(f.posts()[1].expected_progress_version)).toBe('"9007199254740993"');
    expect(f.controller.snapshot().interval!.expected_progress_version).toBe("9007199254740994");
  });
});

describe("B6: close and dispose", () => {
  it("close during a pending undo hides undo at once; the late undo reply does not bring it back", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    const undoing = f.controller.undo();
    const closing = f.controller.close();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", canUndo: false, canIncrease: false, capabilities: { undo_target: null, interval_increase: null } });
    held.resolve(); await undoing; await closing;
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "action.undo",
      "context.close"]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", canUndo: false, canIncrease: false });
    await f.controller.close();
    expect(f.posts()).toHaveLength(5);
  });

  it("dispose sends nothing and drops a late reply", async () => {
    const f = fixture();
    await ready(f);
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    const sending = f.controller.increase({ option_id: 2 });
    const count = f.calls().length, updates = f.seen.length;
    f.controller.dispose();
    await f.controller.close(); await f.controller.refresh(); await f.controller.retry(); await f.controller.open(CARD);
    held.resolve(); await sending;
    expect(f.calls()).toHaveLength(count);
    expect(f.seen).toHaveLength(updates);
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", context: null, capabilities: { undo_target: null } });
  });
});

describe("B7: only the server offer, checked before any request", () => {
  it("an option or direction outside the capability throws synchronously; nothing is sent", async () => {
    const f = fixture();
    await ready(f);
    const count = f.calls().length;
    expect(() => f.controller.increase({ option_id: 9 })).toThrow("option is not offered");
    expect(() => f.controller.increase([] as any)).toThrow("invalid interval choice");
    // CON:94: no oral direction and no batch of choices.
    expect(() => f.controller.increase({ direction: "de-l1", option_id: 1 } as any)).toThrow("invalid interval choice");
    expect(() => f.controller.increase([{ option_id: 1 }, { option_id: 2 }] as any)).toThrow("invalid interval choice");
    // No shown offer: the click does nothing and sends nothing (CT 2.1.2 p.4).
    await f.controller.undo();
    expect(() => f.controller.open("not-a-card")).toThrow("dictionary card ID required");
    // K07-063: the top step leaves nothing to offer.
    await increased(f, 8);
    expect(f.controller.snapshot()).toMatchObject({ canIncrease: false, capabilities: { interval_increase: null } });
    expect(f.controller.snapshot().interval).toMatchObject({ options: [], default_option_id: null });
    expect(() => f.controller.increase({ option_id: 1 })).toThrow("interval increase is not offered");
    expect(f.posts().slice(-2).map(body => body.kind)).toEqual(["interval.increase", "action.undo_offer.open"]);
    expect(f.calls()).toHaveLength(count + 2);
  });
});

describe("CP5 F-L1: an own late reply below a state already shown is not a stale problem", () => {
  it("accepted increase answered after a newer read: no stale_response; a really stale view still masks the offer", async () => {
    let floor: string | null = null;
    const f = fixture(41n, () => floor);
    await ready(f);
    const held = deferred<void>();
    // The server applies the increase at once (sv 43); its reply is delivered late.
    f.srv.routes.push(async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const sending = f.controller.increase({ option_id: 2 });
    await settle();
    f.srv.state++; // a neutral action elsewhere (A34): state 44, the same projection
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ stateVersion: "44", pending: { kind: "interval.increase" } });
    held.resolve(); await sending;
    expect(f.controller.snapshot()).toMatchObject({ stateVersion: "44", pending: null, problem: null, canIncrease: true });
    await settle(); // the offer's open: state 45
    expect(f.controller.snapshot()).toMatchObject({ stateVersion: "45", pending: null, problem: null, canUndo: true, canIncrease: true });
    // A confirmed version above the shown one: the offer is masked and the problem is reported.
    floor = "46";
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "stale_response" }, canUndo: false, canIncrease: false,
      undoOffer: null, capabilities: { undo_target: null, interval_increase: null } });
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
  });

  it("a refusal problem is kept when the own reply is older than the shown state", async () => {
    const f = fixture();
    await ready(f);
    f.srv.written = { ...f.srv.written, version: BIG + 1n };
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const sending = f.controller.increase({ option_id: 1 });
    await settle();
    f.srv.state++;
    await f.controller.refresh();
    held.resolve(); await sending;
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "rejected", code: "VERSION_CONFLICT" }, stateVersion: "43" });
  });
});

describe("CP6 Q1: an unresolved initial open continues as the same command after a same-document rebind", () => {
  /** The next binding of the same document: a new controller over a new handle, same origin. */
  function rebound(f: ReturnType<typeof fixture>) {
    const api = createDictionaryIntervalApi({ fetcher: f.srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() });
    return new DictionaryIntervalController({
      port: dictionaryIntervalPort(api, "synthetic-token-2", "synthetic-proof-2", { client_instance_id: CLIENT, document_id: DOCUMENT }),
      isLive: () => true, newId: f.newId, onUpdate: () => undefined,
    });
  }
  const tokens = (f: ReturnType<typeof fixture>) => f.srv.fetcher.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).Authorization);

  it("found: status of the original ID decides; no second open, and the late first reply changes nothing", async () => {
    const f = fixture(), held = deferred<void>();
    // The server applies the first open at once; its reply reaches the old binding only after the rebind.
    f.srv.routes.push(async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const opening = f.controller.open(CARD);
    await settle();
    const handoff = f.controller.handoff();
    expect(handoff).toMatchObject({ cardId: CARD, contextId: null, pending: { kind: "context.open", command_id: id(100), card_id: CARD } });
    f.end(); f.controller.dispose();
    const next = rebound(f), count = f.calls().length;
    await next.resume(handoff!);
    expect(f.calls().slice(count)).toEqual([`GET /api/v1/commands/${id(100)}`, `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(tokens(f).slice(count)).toEqual(["Bearer synthetic-token-2", "Bearer synthetic-token-2"]);
    expect(next.snapshot()).toMatchObject({ phase: "ready", context: { id: id(500) }, pending: null, problem: null, canIncrease: true });
    held.resolve(); await opening; await settle();
    expect(f.posts().map(body => body.command_id)).toEqual([id(100)]);
    expect(next.snapshot()).toMatchObject({ phase: "ready", context: { id: id(500) } });
    expect(f.newId).toHaveBeenCalledTimes(1);
  });

  it("not_found: no automatic open; an explicit retry sends the same ID and payload, then the context is ready", async () => {
    const f = fixture(), held = deferred<void>();
    // The first open never reached the server.
    f.srv.routes.push(async () => { await held.promise; throw new TypeError("connection reset"); });
    const opening = f.controller.open(CARD);
    await settle();
    const handoff = f.controller.handoff()!;
    f.end(); f.controller.dispose();
    const next = rebound(f), count = f.calls().length;
    await next.resume(handoff);
    expect(f.calls().slice(count)).toEqual([`GET /api/v1/commands/${id(100)}`]);
    expect(next.snapshot()).toMatchObject({ phase: "opening", context: null, canRetry: true, canIncrease: false,
      pending: { kind: "context.open", commandId: id(100), status: "unknown" }, problem: { reason: "not_found" } });
    held.resolve(); await opening; await settle();
    expect(f.posts()).toHaveLength(1);
    await next.retry();
    expect(f.posts()).toHaveLength(2);
    expect(f.posts()[1]).toEqual(f.posts()[0]);
    expect(tokens(f).at(-1)).toBe("Bearer synthetic-token-2");
    expect(next.snapshot()).toMatchObject({ phase: "ready", context: { id: id(500) }, pending: null, canRetry: false });
    expect(f.newId).toHaveBeenCalledTimes(1);
  });

  it("a handoff never carries an open of another card, and close ends the continuation", async () => {
    const f = fixture(), held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    void f.controller.open(CARD);
    await settle();
    const handoff = f.controller.handoff()!;
    await expect(rebound(f).resume({ ...handoff, cardId: OTHER_CARD })).rejects.toThrow("dictionary context required");
    await expect(rebound(f).resume({ ...handoff, pending: null })).rejects.toThrow("dictionary context required");
    void f.controller.close();
    expect(f.controller.handoff()).toBeNull();
    held.resolve(); await settle();
  });
});

describe("M-INTV: the one undo offer of an increase (CT 2.1.2, К07-122, Т83)", () => {
  const kinds = (f: ReturnType<typeof fixture>) => f.posts().map(body => body.kind);
  /** The next binding of the same live document: same origin, server, IDs and monotonic clock. */
  function rebound(f: ReturnType<typeof fixture>) {
    const api = createDictionaryIntervalApi({ fetcher: f.srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() });
    return new DictionaryIntervalController({
      port: dictionaryIntervalPort(api, "synthetic-token-2", "synthetic-proof-2", { client_instance_id: CLIENT, document_id: DOCUMENT }),
      isLive: () => true, newId: f.newId, onUpdate: () => undefined, clock: f.time.clock,
    });
  }

  it("pending offer: no undo before the open is confirmed; then 3 s from that confirmation, a click before it sends one undo", async () => {
    const f = fixture();
    await ready(f);
    const held = deferred<void>();
    f.srv.routes.push(undefined as unknown as Route, async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    await f.controller.increase({ option_id: 2 });
    await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.controller.snapshot()).toMatchObject({ capabilities: { undo_offer: { status: "pending", version: "1" }, undo_target: null },
      undoOffer: null, canUndo: false, applied: { kind: "interval.increase", commandId: id(101) } });
    await f.controller.undo(); // not shown yet: nothing
    // A delayed open confirmation does not eat the window (Т83): the deadline starts at the confirmation.
    f.time.advance(10_000);
    held.resolve(); await settle();
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: { remainingMs: 3000, durationMs: 3000 }, canUndo: true,
      capabilities: { undo_offer: { status: "offered", version: "2" }, undo_target: { action_id: id(501) } } });
    f.time.advance(2999);
    expect(f.controller.snapshot().undoOffer).toEqual({ remainingMs: 1, durationMs: 3000 });
    await f.controller.undo();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "action.undo"]);
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, applied: { kind: "action.undo", commandId: id(103) },
      capabilities: { undo_offer: null, undo_target: null } });
    f.time.advance(10_000); await settle();
    // An undo is never followed by a close: two intents never coexist (CT 2.1.2 p.4).
    expect(kinds(f)).toHaveLength(4);
    expect(f.time.pending()).toBe(0);
  });

  it("no click: at the deadline the strip hides and one hidden close of the current offer version goes; the increase stays", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    f.time.advance(3000);
    await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "action.undo_offer.close"]);
    expect(f.posts()[3]).toMatchObject({ action_id: id(501), expected_offer_version: "2", payload: {} });
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false, capabilities: { undo_offer: null, undo_target: null } });
    expect(f.controller.snapshot().interval!.current_schedule).toMatchObject({ interval_days: 23 });
    await f.controller.refresh(); await f.controller.undo();
    expect(kinds(f)).toHaveLength(4);
    expect(f.controller.snapshot().undoOffer).toBeNull();
  });

  it("a click exactly at the deadline is not taken: it hides the strip and closes instead of undoing", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    f.time.advance(3000, false);
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false });
    await f.controller.undo();
    await settle();
    expect(kinds(f).slice(3)).toEqual(["action.undo_offer.close"]);
    f.time.advance(0); await settle();
    expect(kinds(f).slice(3)).toEqual(["action.undo_offer.close"]);
  });

  it("a read, a status or a repeated refresh never extends the deadline", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    f.time.advance(2000);
    await f.controller.refresh();
    expect(f.controller.snapshot().undoOffer).toEqual({ remainingMs: 1000, durationMs: 3000 });
    f.time.advance(1000); await settle();
    expect(kinds(f).at(-1)).toBe("action.undo_offer.close");
  });

  it("unknown open: the status of the same ID allows the first showing; not_found sends the same ID once more", async () => {
    const applied = fixture();
    await ready(applied);
    applied.srv.routes.push(undefined as unknown as Route, lost(applied.srv, true));
    await increased(applied, 2);
    expect(applied.calls().slice(-2)).toEqual(["POST /api/v1/commands", `GET /api/v1/commands/${id(102)}`]);
    expect(applied.controller.snapshot()).toMatchObject({ undoOffer: { remainingMs: 3000 }, canUndo: true });

    const missing = fixture();
    await ready(missing);
    missing.srv.routes.push(undefined as unknown as Route, lost(missing.srv, false));
    await increased(missing, 2);
    expect(missing.posts().slice(2).map(body => body.command_id)).toEqual([id(102), id(102)]);
    expect(missing.posts()[3]).toEqual(missing.posts()[2]);
    expect(missing.controller.snapshot()).toMatchObject({ undoOffer: { remainingMs: 3000 }, canUndo: true });
  });

  it("an open whose status also fails stays hidden; the next refresh checks the same ID and only then counts 3 s", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(undefined as unknown as Route, lost(f.srv, true), () => { throw new TypeError("offline"); });
    await increased(f, 2);
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false, pending: null });
    f.time.advance(60_000);
    await f.controller.refresh(); await settle();
    expect(f.calls().filter(call => call === `GET /api/v1/commands/${id(102)}`)).toHaveLength(2);
    expect(f.controller.snapshot().undoOffer).toEqual({ remainingMs: 3000, durationMs: 3000 });
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
  });

  it("an open refused by the server (the offer already ended) shows nothing and closes nothing", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(undefined as unknown as Route, (path, init) => { f.srv.right!.status = "expired"; return f.srv.handle(path, init); });
    await increased(f, 2);
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false, problem: null });
    f.time.advance(5000); await settle();
    expect(kinds(f)).toHaveLength(3);
  });

  it("unknown close: hidden, checked by status, the same ID once more; the strip never comes back", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    f.srv.routes.push(lost(f.srv, false));
    f.time.advance(3000); await settle();
    const closes = f.posts().filter(body => body.kind === "action.undo_offer.close");
    expect(closes.map(body => body.command_id)).toEqual([id(103), id(103)]);
    expect(f.calls()).toContain(`GET /api/v1/commands/${id(103)}`);
    expect(f.srv.right!.offer.status).toBe("closed");
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false });
  });

  it("an offer the server no longer names (another action ended it) hides at once, without a close", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    f.srv.right!.status = "expired";
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false });
    f.time.advance(5000); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
  });

  it("leaving the context: context.close only; no offer close follows", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    await f.controller.close();
    f.time.advance(5000); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "context.close"]);
    expect(f.controller.handoff()).toBeNull();
  });

  it("a second increase while the strip is shown replaces the offer: the new one is opened, the old one is not closed", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 1);
    f.time.advance(1000);
    await increased(f, 1);
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.posts()[4]).toMatchObject({ action_id: id(502), expected_offer_version: "1" });
    expect(f.controller.snapshot().undoOffer).toEqual({ remainingMs: 3000, durationMs: 3000 });
    f.time.advance(3000); await settle();
    expect(kinds(f).at(-1)).toBe("action.undo_offer.close");
    expect(f.posts().at(-1)).toMatchObject({ action_id: id(502) });
  });

  it("foreground: a new handle of the same document keeps the same deadline; it is not shown again after it passed", async () => {
    const f = fixture();
    await ready(f);
    await increased(f, 2);
    f.time.advance(1000);
    const handoff = f.controller.handoff()!;
    expect(handoff.offer).toMatchObject({ actionId: id(501), phase: "shown", deadline: 4000 });
    f.end(); f.controller.dispose();
    const next = rebound(f);
    await next.resume(handoff);
    expect(next.snapshot().undoOffer).toEqual({ remainingMs: 2000, durationMs: 3000 });
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    f.time.advance(2000); await settle();
    expect(kinds(f).at(-1)).toBe("action.undo_offer.close");

    const late = fixture();
    await ready(late);
    await increased(late, 2);
    const away = late.controller.handoff()!;
    late.end(); late.controller.dispose();
    late.time.advance(60_000); // in the background the deadline passed
    const back = rebound(late);
    await back.resume(away); await settle();
    expect(back.snapshot()).toMatchObject({ undoOffer: null, canUndo: false });
    expect(kinds(late).at(-1)).toBe("action.undo_offer.close");
  });

  it("an unknown increase resolved on a new handle opens its offer there once", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(lost(f.srv, true), () => { throw new TypeError("offline"); });
    await f.controller.increase({ option_id: 2 });
    const handoff = f.controller.handoff()!;
    expect(handoff).toMatchObject({ pending: { kind: "interval.increase" }, offer: null });
    f.end(); f.controller.dispose();
    const next = rebound(f);
    await next.resume(handoff); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(next.snapshot()).toMatchObject({ undoOffer: { remainingMs: 3000 }, canUndo: true, applied: { kind: "interval.increase" } });
  });
});

describe("M-INTV after QA (M-INTV-QA REPORT: QA-O, QA-O2, QA-T, QA-L, QA-U)", () => {
  const kinds = (f: ReturnType<typeof fixture>) => f.posts().map(body => body.kind);
  async function shown(f: ReturnType<typeof fixture>) {
    await ready(f);
    await increased(f, 2);
    expect(f.controller.snapshot().undoOffer).not.toBeNull();
  }
  /** Hold the next request until released; the server handles it only then. */
  function held(f: ReturnType<typeof fixture>) {
    const gate = deferred<void>();
    return { gate, route: (async (path, init) => { await gate.promise; return f.srv.handle(path, init); }) as Route };
  }

  it("one open per own increase: refreshes while shown, the undo and a refresh after it add none", async () => {
    const f = fixture();
    await shown(f);
    await f.controller.refresh(); await settle();
    await f.controller.refresh(); await settle();
    await f.controller.undo(); await settle();
    await f.controller.refresh(); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "action.undo"]);
    expect(f.controller.snapshot().undoOffer).toBeNull();
  });

  it("after the deadline's close a refresh opens nothing again", async () => {
    const f = fixture();
    await shown(f);
    f.time.advance(3000); await settle();
    await f.controller.refresh(); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "action.undo_offer.close"]);
  });

  it("an open fact naming an action of its own is no confirmation: no strip and no undo", async () => {
    const f = fixture();
    await ready(f);
    const forged: Route = async (path, init) => {
      const reply = await f.srv.handle(path, init).json();
      reply.command.action_id = reply.command.target_id;
      return json(reply);
    };
    f.srv.routes.push(undefined as unknown as Route, forged, forged);
    await increased(f, 2);
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false });
    expect(kinds(f)).not.toContain("action.undo");
  });

  it("a read while the open is on the way (the server still says pending) sends no second open", async () => {
    const f = fixture();
    await ready(f);
    const late = held(f);
    f.srv.routes.push(undefined as unknown as Route, late.route);
    await f.controller.increase({ option_id: 2 }); await settle();
    await f.controller.refresh(); await settle();
    late.gate.resolve(); await settle();
    await f.controller.refresh(); await settle();
    expect(kinds(f).filter(kind => kind === "action.undo_offer.open")).toHaveLength(1);
    expect(f.controller.snapshot().undoOffer).not.toBeNull();
  });

  it("a click 1 ms before the deadline sends only the undo; a click past it (timer not run yet) only the close", async () => {
    const early = fixture();
    await shown(early);
    early.time.advance(2999, false);
    expect(early.controller.snapshot().undoOffer?.remainingMs).toBe(1);
    await early.controller.undo(); await settle();
    early.time.advance(5000); await settle();
    expect(kinds(early).slice(3)).toEqual(["action.undo"]);

    const late = fixture();
    await shown(late);
    late.time.advance(3500, false);
    await late.controller.undo(); await settle();
    expect(kinds(late).slice(3)).toEqual(["action.undo_offer.close"]);
  });

  it("foreground at +2 s: the new handle shows the remaining 1 s, then closes; still one open", async () => {
    const f = fixture();
    await shown(f);
    f.time.advance(2000, false);
    const handoff = f.controller.handoff()!;
    f.end(); f.controller.dispose();
    const api = createDictionaryIntervalApi({ fetcher: f.srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000, gate: testGate() });
    const next = new DictionaryIntervalController({
      port: dictionaryIntervalPort(api, "synthetic-token-2", "synthetic-proof-2", { client_instance_id: CLIENT, document_id: DOCUMENT }),
      isLive: () => true, newId: f.newId, onUpdate: () => undefined, clock: f.time.clock });
    await next.resume(handoff); await settle();
    expect(next.snapshot().undoOffer?.remainingMs).toBe(1000);
    f.time.advance(1000); await settle();
    expect(next.snapshot().undoOffer).toBeNull();
    expect(kinds(f).filter(kind => kind === "action.undo_offer.open")).toHaveLength(1);
    expect(kinds(f).at(-1)).toBe("action.undo_offer.close");
  });

  it("an unknown open whose status comes after the user left: nothing follows context.close (Н2)", async () => {
    const f = fixture();
    await ready(f);
    const late = held(f);
    f.srv.routes.push(undefined as unknown as Route, lost(f.srv, false), late.route);
    await f.controller.increase({ option_id: 2 }); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    await f.controller.close(); await settle();
    late.gate.resolve(); await settle();
    expect(kinds(f).slice(kinds(f).indexOf("context.close") + 1)).toEqual([]);
  });

  it("an unknown close whose status comes after the user left: no second close after context.close (Н2)", async () => {
    const f = fixture();
    await shown(f);
    const late = held(f);
    f.srv.routes.push(lost(f.srv, false), late.route);
    f.time.advance(3000); await settle();
    expect(kinds(f).at(-1)).toBe("action.undo_offer.close");
    await f.controller.close(); await settle();
    late.gate.resolve(); await settle();
    expect(kinds(f).slice(kinds(f).indexOf("context.close") + 1)).toEqual([]);
  });

  it("a refused undo hides the strip and sends no close: the server ends the offer with the next action (Н3)", async () => {
    // root decision, pending owner (M-INTV Н3): CT 2.1.2 p.4 describes only the click before the deadline.
    const f = fixture();
    await shown(f);
    f.srv.routes.push((_path, init) => {
      const body = JSON.parse(String(init.body));
      return json({ command: { id: body.command_id, status: "rejected" }, current: f.srv.project(body.context_id),
        state_version: String(f.srv.state), error: { code: "VERSION_CONFLICT" } }, 409);
    });
    await f.controller.undo(); await settle();
    f.time.advance(5000); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open", "action.undo"]);
    expect(f.srv.right).toMatchObject({ status: "available", offer: { status: "offered" } });
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, problem: { code: "VERSION_CONFLICT" } });
  });

  it("Н7: the server ended the offer (a read shows none) while the open's status is on the way: not_found sends no open again", async () => {
    const f = fixture();
    await ready(f);
    const late = held(f);
    f.srv.routes.push(undefined as unknown as Route, lost(f.srv, false), late.route);
    await f.controller.increase({ option_id: 2 }); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    f.srv.right!.status = "expired"; // another action ended it on the server
    await f.controller.refresh(); await settle();
    expect(f.controller.snapshot().capabilities.undo_offer).toBeNull();
    late.gate.resolve(); await settle();
    expect(kinds(f)).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
    expect(f.controller.snapshot()).toMatchObject({ undoOffer: null, canUndo: false });
  });
});


describe("D-CONTEXT-LATE-OPEN: an accepted open answered below a version seen meanwhile", () => {
  const contextGets = (f: ReturnType<typeof fixture>) => f.calls().filter(call => call.startsWith("GET /api/v1/dictionary/contexts/"));
  // The server applies the open at once; its reply is delivered only after a card action elsewhere and the card's new read.
  function lateOpen(f: ReturnType<typeof fixture>, raise: (state: bigint) => void) {
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const opening = f.controller.open(CARD);
    return { opening, deliver: async () => { f.srv.state++; raise(f.srv.state); held.resolve(); await opening; await settle(); } };
  }

  it("the older fact is not shown; its own context is read once and the card's context is ready", async () => {
    let floor: string | null = null;
    const f = fixture(41n, () => floor);
    const late = lateOpen(f, state => { floor = String(state); });
    await settle();
    await late.deliver();
    expect(contextGets(f)).toEqual([`GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", context: { id: id(500) }, pending: null, problem: null,
      stateVersion: floor, canIncrease: true });
    expect(f.posts().map(body => body.kind)).toEqual(["context.open"]);
  });

  it("an unknown open whose status reply is older: the same one read, no second open", async () => {
    let floor: string | null = null;
    const f = fixture(41n, () => floor), held = deferred<void>();
    f.srv.routes.push(lost(f.srv, true), async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const opening = f.controller.open(CARD);
    await settle();
    f.srv.state++; floor = String(f.srv.state);
    held.resolve(); await opening; await settle();
    expect(f.calls().filter(call => call.startsWith("GET"))).toEqual([`GET /api/v1/commands/${id(100)}`,
      `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", problem: null, stateVersion: floor });
    expect(f.posts().map(body => body.command_id)).toEqual([id(100)]);
  });

  it("a read that is still older stays hidden: exactly one read, nothing repeats on its own", async () => {
    let floor: string | null = null;
    const f = fixture(41n, () => floor);
    const late = lateOpen(f, state => { floor = String(state + 5n); });
    await settle();
    await late.deliver();
    await settle();
    expect(contextGets(f)).toHaveLength(1);
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "stale_response" }, canIncrease: false, canUndo: false });
    expect(f.posts().map(body => body.kind)).toEqual(["context.open"]);
  });

  it("a close requested while the open was on the way follows it; no read", async () => {
    let floor: string | null = null;
    const f = fixture(41n, () => floor);
    const late = lateOpen(f, state => { floor = String(state); });
    await settle();
    void f.controller.close();
    await late.deliver();
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "context.close"]);
    expect(contextGets(f)).toEqual([]);
  });
});
