import { describe, expect, it, vi } from "vitest";
import type { DictionaryCardView } from "../api/generated";
import { DictionaryIntervalController, dictionaryIntervalPort, type DictionaryIntervalSnapshot } from "./dictionaryIntervalController";
import { createDictionaryIntervalApi } from "./intervalApi";

// Synthetic server shaped after core dictionary_interval.py / coordinator.py (fact fields, refusal codes,
// state bump only on acceptance, version+1 on undo, A01 row insert/delete). Steps: CORE_HANDOFF_CP2 §5.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CARD = id(1), OTHER_CARD = id(2), CLIENT = id(3), DOCUMENT = id(4), PROFILE = id(5);
const TODAY = "2026-09-29";
const BIG = 9007199254740993n;
const LADDER: Array<[number, number]> = [[1, 15], [2, 23], [3, 36], [4, 58], [5, 94], [6, 155], [7, 259], [8, 438]];
const A01_REVERSE: Array<[number, number]> = [[2, 3], [3, 4], [4, 6]];
const addDays = (day: string, days: number) => {
  const date = new Date(`${day}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10);
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

type Direction = { version: bigint | null; days: number; due: string; options: Array<[number, number]> };
type Route = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;

function server(start = 41n) {
  const s = {
    state: start, zone: true as boolean,
    dirs: { "l1-de": { version: BIG, days: 10, due: "2026-10-05", options: LADDER } as Direction,
      "de-l1": { version: null, days: 1, due: TODAY, options: A01_REVERSE } as Direction },
    contexts: new Map<string, { card: string; status: "open" | "closed" }>(),
    right: null as null | { action: string; context: string; version: bigint; status: "available" | "used" | "expired"; before: Record<string, Direction> },
    commands: new Map<string, { semantic: string; fact: Record<string, unknown> }>(),
    routes: [] as Route[], next: 500,
  };
  const directions = ["l1-de", "de-l1"] as const;
  const view = (card: string): DictionaryCardView => ({
    status: "available",
    content: { pair: "ru-de", card: { id: card, revision: "3", lemma: "Haus", type: "noun", cefr: "A1" },
      translations: { common: ["дом"], personal: null }, grammar: null, reference_conjugations: [],
      examples: { common: [], personal: null }, association: null, field_versions: { translation: "1", example: "1", association: "1" } },
    study: { status: "available", card_id: card, card_revision: "3", pair: "ru-de", card_type: "noun", local_date: s.zone ? TODAY : null,
      facts: { common_translation_present: true, exclusion: { excluded: false, version: null }, manual: { selected: false, selection_version: "1" },
        learning: { ever_selected: true, finished_or_skipped: true, current: null }, non_learning_history: false },
      directions: directions.map(direction => {
        const d = s.dirs[direction];
        return d.version === null
          ? { direction, introduced: true, progress_present: false, progress_version: null, schedule: null, interval_preview: null }
          : { direction, introduced: true, progress_present: true, progress_version: String(d.version),
            schedule: { interval_days: d.days, next_due_date: d.due },
            interval_preview: s.zone ? d.options.map(([step_id, days]) => ({ step_id, interval_days: days, next_due_date: addDays(TODAY, days) })) : null };
      }) },
  });
  const project = (contextId: string) => {
    const context = s.contexts.get(contextId);
    if (!context) return { status: "unavailable" };
    const reference = { id: contextId, kind: "dictionary", card_id: context.card };
    if (context.status === "closed") return { status: "closed", context: reference };
    const interval = s.zone ? { local_date: TODAY, expected_pair: "ru-de", directions: directions.map(direction => {
      const d = s.dirs[direction], options = d.options.map(([option_id, days]) => ({ option_id, interval_days: days, next_due_date: addDays(TODAY, days) }));
      return d.version === null
        ? { direction, applicable: true, current_schedule: { interval_days: 1, next_due_date: TODAY, persisted: false }, expected_progress_version: null, options }
        : { direction, applicable: true, current_schedule: { interval_days: d.days, next_due_date: d.due, persisted: true },
          expected_progress_version: String(d.version), options };
    }) } : null;
    const offered = interval ? interval.directions.filter(d => d.options.length > 0).map(d => d.direction) : [];
    const right = s.right && s.right.context === contextId && s.right.status === "available"
      ? { action_id: s.right.action, kind: "interval.increase", version: String(s.right.version), context_id: contextId } : null;
    return { status: "open", context: reference, view: view(context.card), interval,
      capabilities: { interval_increase: offered.length ? { directions: offered } : null, undo_target: right } };
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
      for (const selection of body.payload.selections) {
        const d = s.dirs[selection.direction as "l1-de"], expected = body.expected_progress_versions.find((v: any) => v.direction === selection.direction).version;
        const option = d.options.find(([option_id]) => option_id === selection.option_id);
        if ((d.version === null ? expected !== null : expected !== String(d.version)) || !option || option[1] !== selection.interval_days
          || addDays(TODAY, option[1]) !== selection.next_due_date) return refuse(body.command_id, "VERSION_CONFLICT", contextId);
      }
      const before = structuredClone(s.dirs);
      for (const selection of body.payload.selections) {
        const d = s.dirs[selection.direction as "l1-de"];
        s.dirs[selection.direction as "l1-de"] = { version: (d.version ?? 0n) + 1n, days: selection.interval_days, due: selection.next_due_date, options: [] };
      }
      const action = id(s.next++); s.right = { action, context: contextId!, version: 1n, status: "available", before };
      s.state++; return remember(body, fact(body, { action_id: action, object_version: "1" }), contextId);
    }
    const right = s.right;
    if (!right || right.action !== body.action_id || right.status !== "available" || right.context !== contextId) return refuse(body.command_id, "CAPABILITY_EXPIRED", contextId);
    if (String(right.version) !== body.expected_action_version) return refuse(body.command_id, "VERSION_CONFLICT", contextId);
    for (const direction of directions) {
      const was = right.before[direction];
      if (JSON.stringify(was, (_k, v) => typeof v === "bigint" ? String(v) : v) === JSON.stringify(s.dirs[direction], (_k, v) => typeof v === "bigint" ? String(v) : v)) continue;
      s.dirs[direction] = was.version === null ? was : { ...was, version: s.dirs[direction].version! + 1n };
    }
    right.status = "used"; right.version += 1n;
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

function fixture(start?: bigint, minimum?: () => string | null) {
  const srv = server(start);
  let next = 100;
  const newId = vi.fn(() => id(next++));
  const seen: DictionaryIntervalSnapshot[] = [];
  let live = true;
  const api = createDictionaryIntervalApi({ fetcher: srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 });
  const controller = new DictionaryIntervalController({
    port: dictionaryIntervalPort(api, "synthetic-token", "synthetic-proof", { client_instance_id: CLIENT, document_id: DOCUMENT }),
    isLive: () => live, newId, minimumStateVersion: minimum, onUpdate: snapshot => { seen.push(snapshot); },
  });
  const calls = () => srv.fetcher.mock.calls.map(([url, init]) => `${init!.method} ${new URL(String(url), "http://local").pathname}`);
  const posts = () => srv.fetcher.mock.calls.filter(([, init]) => init!.method === "POST").map(([, init]) => JSON.parse(String(init!.body)));
  return { srv, controller, newId, seen, calls, posts, end: () => { live = false; } };
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
    const f = fixture();
    await ready(f);
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase"]);
    expect(f.posts()[1]).toMatchObject({ expected_progress_versions: [{ direction: "de-l1", version: null }],
      payload: { selections: [{ direction: "de-l1", option_id: 2, interval_days: 3, next_due_date: "2026-10-02" }] } });
    const after = f.controller.snapshot();
    expect(after).toMatchObject({ phase: "ready", canUndo: true, problem: null,
      capabilities: { undo_target: { kind: "interval.increase", version: "1" } } });
    expect(after.interval!.directions[1]).toMatchObject({ expected_progress_version: "1",
      current_schedule: { interval_days: 3, next_due_date: "2026-10-02", persisted: true } });
    await f.controller.undo();
    expect(f.posts()).toHaveLength(3);
    expect(f.posts()[2]).toMatchObject({ kind: "action.undo", expected_action_version: "1" });
    expect(f.controller.snapshot()).toMatchObject({ canUndo: false, capabilities: { undo_target: null } });
    expect(f.controller.snapshot().interval!.directions[1].current_schedule).toEqual({ interval_days: 1, next_due_date: TODAY, persisted: false });
    expect(f.calls().filter(call => call.startsWith("GET"))).toEqual([]);
  });
});

describe("B2: one pending intent", () => {
  it("a second tap while sending creates no second POST", async () => {
    const f = fixture();
    await ready(f);
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    const first = f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    expect(f.controller.snapshot()).toMatchObject({ pending: { kind: "interval.increase", status: "sending" }, canIncrease: false, canUndo: false });
    await f.controller.increase([{ direction: "l1-de", option_id: 1 }]);
    await f.controller.undo();
    held.resolve(); await first;
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase"]);
  });
});

describe("B3: unknown outcome is resolved by one status and only an explicit retry repeats the same command", () => {
  it("lost reply of an applied increase: one status GET, no repeat POST", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(lost(f.srv, true));
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    expect(f.calls().slice(-2)).toEqual(["POST /api/v1/commands", `GET /api/v1/commands/${id(101)}`]);
    expect(f.posts()).toHaveLength(2);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, problem: null, canUndo: true });
  });

  it("not_found keeps the intent; status current is a profile and is not shown; retry sends the same ID and payload", async () => {
    const f = fixture();
    await ready(f);
    const shown = f.controller.snapshot();
    f.srv.routes.push(lost(f.srv, false));
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    const waiting = f.controller.snapshot();
    expect(waiting).toMatchObject({ pending: { kind: "interval.increase", commandId: id(101), status: "unknown" },
      problem: { reason: "not_found" }, canRetry: true, canIncrease: false, canUndo: false, context: shown.context });
    expect(waiting.view).toEqual(shown.view);
    expect(f.posts()).toHaveLength(2);
    await f.controller.retry();
    expect(f.posts()).toHaveLength(3);
    expect(f.posts()[2]).toEqual(f.posts()[1]);
    expect(f.newId).toHaveBeenCalledTimes(2);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canUndo: true, canRetry: false });
  });

  it("a status that also fails stays unknown and is checked again only by refresh", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(lost(f.srv, true), () => { throw new TypeError("still offline"); });
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    expect(f.controller.snapshot()).toMatchObject({ pending: { status: "unknown" }, problem: { reason: "network" }, canRetry: true });
    const count = f.calls().length;
    await f.controller.refresh();
    expect(f.calls().slice(count)).toEqual([`GET /api/v1/commands/${id(101)}`, `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.posts()).toHaveLength(2);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canUndo: true });
  });

  it("5xx and an invalid 200 are unknown too; an HTTP 4xx without fact is a known refusal", async () => {
    const f = fixture();
    await ready(f);
    f.srv.routes.push(() => json({ error: { code: "WRITE_UNAVAILABLE" } }, 503));
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    expect(f.calls().at(-1)).toBe(`GET /api/v1/commands/${id(101)}`);
    expect(f.controller.snapshot()).toMatchObject({ canRetry: true, problem: { reason: "not_found" } });
    await f.controller.retry();
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
    f.srv.dirs["l1-de"] = { ...f.srv.dirs["l1-de"], version: BIG + 1n }; // another installation answered
    await f.controller.increase([{ direction: "l1-de", option_id: 1 }]);
    expect(f.calls().slice(-2)).toEqual(["POST /api/v1/commands", `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.posts()).toHaveLength(2);
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "rejected", code: "VERSION_CONFLICT" }, pending: null, canIncrease: true });
    expect(f.controller.snapshot().interval!.directions[0].expected_progress_version).toBe("9007199254740994");
  });

  it("CAPABILITY_EXPIRED: undo disappears and the context is read once", async () => {
    const f = fixture();
    await ready(f);
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    f.srv.right!.status = "expired"; // the next accepted action elsewhere ended it
    await f.controller.undo();
    expect(f.calls().slice(-2)).toEqual(["POST /api/v1/commands", `GET /api/v1/dictionary/contexts/${id(500)}`]);
    expect(f.controller.snapshot()).toMatchObject({ problem: { code: "CAPABILITY_EXPIRED" }, canUndo: false, capabilities: { undo_target: null } });
  });

  it("DOCUMENT_STALE: a context closed elsewhere shows no offer", async () => {
    const f = fixture();
    await ready(f);
    f.srv.contexts.get(id(500))!.status = "closed";
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    expect(f.calls().at(-1)).toBe(`GET /api/v1/dictionary/contexts/${id(500)}`);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", problem: { code: "DOCUMENT_STALE" }, canIncrease: false, canUndo: false });
  });

  it("SETUP_REQUIRED: no interval, no read and no repeat", async () => {
    const f = fixture();
    await ready(f);
    f.srv.zone = false;
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    expect(f.calls().at(-1)).toBe("POST /api/v1/commands");
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "setup_required", code: "SETUP_REQUIRED" }, interval: null,
      canIncrease: false, canRetry: false, capabilities: { interval_increase: null } });
    expect(() => f.controller.increase([{ direction: "de-l1", option_id: 2 }])).toThrow("interval increase is not offered");
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
    const f = fixture(9007199254740994n);
    await ready(f);
    expect(f.controller.snapshot().stateVersion).toBe("9007199254740995");
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
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
    expect(after.interval!.directions[1].current_schedule).toEqual({ interval_days: 1, next_due_date: TODAY, persisted: false });
  });

  it("int64 progress versions are sent as exact strings", async () => {
    const f = fixture();
    await ready(f);
    await f.controller.increase([{ direction: "l1-de", option_id: 1 }]);
    expect(JSON.stringify(f.posts()[1].expected_progress_versions)).toBe('[{"direction":"l1-de","version":"9007199254740993"}]');
    expect(f.controller.snapshot().interval!.directions[0].expected_progress_version).toBe("9007199254740994");
  });
});

describe("B6: close and dispose", () => {
  it("close during a pending undo hides undo at once; the late undo reply does not bring it back", async () => {
    const f = fixture();
    await ready(f);
    await f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    const undoing = f.controller.undo();
    const closing = f.controller.close();
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", canUndo: false, canIncrease: false, capabilities: { undo_target: null, interval_increase: null } });
    held.resolve(); await undoing; await closing;
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase", "action.undo", "context.close"]);
    expect(f.controller.snapshot()).toMatchObject({ phase: "closed", canUndo: false, canIncrease: false });
    await f.controller.close();
    expect(f.posts()).toHaveLength(4);
  });

  it("dispose sends nothing and drops a late reply", async () => {
    const f = fixture();
    await ready(f);
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { await held.promise; return f.srv.handle(path, init); });
    const sending = f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
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
    expect(() => f.controller.increase([{ direction: "de-l1", option_id: 1 }])).toThrow("option is not offered");
    expect(() => f.controller.increase([])).toThrow("invalid interval choice");
    expect(() => f.controller.undo()).toThrow("undo is not offered");
    expect(() => f.controller.open("not-a-card")).toThrow("dictionary card ID required");
    await f.controller.increase([{ direction: "l1-de", option_id: 8 }]);
    expect(() => f.controller.increase([{ direction: "l1-de", option_id: 1 }])).toThrow("direction is not offered");
    expect(f.calls()).toHaveLength(count + 1);
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
    const sending = f.controller.increase([{ direction: "de-l1", option_id: 2 }]);
    await settle();
    f.srv.state++; // a neutral action elsewhere (A34): state 44, the same projection
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ stateVersion: "44", pending: { kind: "interval.increase" } });
    held.resolve(); await sending;
    expect(f.controller.snapshot()).toMatchObject({ stateVersion: "44", pending: null, problem: null, canUndo: true, canIncrease: true });
    // A confirmed version above the shown one: the offer is masked and the problem is reported.
    floor = "45";
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "stale_response" }, canUndo: false, canIncrease: false,
      capabilities: { undo_target: null, interval_increase: null } });
    expect(f.posts().map(body => body.kind)).toEqual(["context.open", "interval.increase"]);
  });

  it("a refusal problem is kept when the own reply is older than the shown state", async () => {
    const f = fixture();
    await ready(f);
    f.srv.dirs["l1-de"] = { ...f.srv.dirs["l1-de"], version: BIG + 1n };
    const held = deferred<void>();
    f.srv.routes.push(async (path, init) => { const early = f.srv.handle(path, init); await held.promise; return early; });
    const sending = f.controller.increase([{ direction: "l1-de", option_id: 1 }]);
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
    const api = createDictionaryIntervalApi({ fetcher: f.srv.fetcher, timeoutMs: 5000, maxResponseBytes: 1_000_000 });
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
