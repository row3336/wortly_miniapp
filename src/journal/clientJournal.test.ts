import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientEventBatch } from "../api/generated";
import { createJsonTransport, TRACE_HEADER } from "../api/http";
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import { ClientJournal, installClientJournal, JOURNAL_LIMITS, journalRecord, RETRY_AFTER_MAX_MS, CHANNEL_MISSING_PAUSE_MS,
  type ClientJournalOptions, type JournalClock, type JournalReply } from "./clientJournal";
import { acceptedEvent, BATCH_MAX_BYTES, BATCH_MAX_EVENTS, jsonBytes } from "./events";
import { IdbJournalStore, JOURNAL_DATABASE, JOURNAL_STORE, JournalStoreError, type JournalStore, type StoredBuffer } from "./journalStore";
import { createPageJournal, watchPage } from "./pageJournal";
import { testGate } from "../commands/testGate.test-support";

const profileA = "11111111-1111-4111-8111-111111111111";
const profileB = "66666666-6666-4666-8666-666666666666";
const instance = "22222222-2222-4222-8222-222222222222";
const cmd = "55555555-5555-4555-8555-555555555555";
const credentials = { token: "MARKER-TOKEN-value", proof: "MARKER-PROOF-value", clientInstanceId: instance };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A clock the test moves by hand; timers run only when advance() passes their time. */
function manualClock(start = Date.parse("2026-10-13T10:00:00.000Z")) {
  let now = start;
  const timers: Array<{ at: number; action: () => void; live: boolean }> = [];
  const clock: JournalClock = {
    now: () => now,
    schedule(action, delayMs) { const timer = { at: now + Math.max(0, delayMs), action, live: true }; timers.push(timer); return timer; },
    cancel(handle) { (handle as { live: boolean }).live = false; },
  };
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  return {
    clock, settle,
    get now() { return now; },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        await settle();
        const due = timers.filter(timer => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.live = false;
        now = Math.max(now, due.at);
        due.action();
      }
      now = end;
      await settle();
    },
  };
}

function memoryStore(): JournalStore & { rows: Map<string, StoredBuffer> } {
  const rows = new Map<string, StoredBuffer>();
  return {
    rows,
    async load(profileId) { return rows.has(profileId) ? structuredClone(rows.get(profileId)!) : null; },
    async save(buffer) { rows.set(buffer.profileId, structuredClone(buffer)); },
    async keepOnly(profileId) { for (const key of [...rows.keys()]) if (key !== profileId) rows.delete(key); },
  };
}

function journal(options: Partial<ClientJournalOptions> = {}, replies: JournalReply[] = []) {
  const time = manualClock();
  const sent: ClientEventBatch[] = [];
  const send = vi.fn(async (batch: ClientEventBatch) => {
    sent.push(structuredClone(batch));
    return replies.shift() ?? { status: 200 };
  });
  const store = memoryStore();
  const subject = new ClientJournal({ clientVersion: "0.0.0", send, openStore: async () => store, clock: time.clock, ...options });
  return { subject, time, sent, send, store };
}

const error = { ev: "c.error", err: "TypeError" } as const;

afterEach(() => { installClientJournal(null); });

describe("only an admitted profile has a journal (P1-2)", () => {
  it("keeps, stores and sends nothing before admission, after a revoke or for a pending profile", async () => {
    const opened = vi.fn(async () => memoryStore());
    const { subject, time, send } = journal({ openStore: opened });
    subject.setCredentials(credentials);
    subject.record(error);
    subject.record({ ev: "c.cmd.send", cmd, trace: cmd, kind: "answer.submit", attempt: 1 });
    await time.advance(60_000);
    expect(subject.pending()).toEqual({ events: [], lost: 0 });
    expect(subject.admitted()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();

    subject.admit(profileA);
    subject.revoke(true);
    subject.record(error);
    await time.advance(60_000);
    expect(subject.pending().events).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("the global sink writes nothing without an installed journal or an admitted profile", async () => {
    const { subject, time } = journal();
    journalRecord(error);
    installClientJournal(subject);
    journalRecord(error);
    await time.settle();
    expect(subject.pending().events).toEqual([]);
    subject.admit(profileA);
    journalRecord(error);
    await time.settle();
    expect(subject.pending().events).toHaveLength(1);
  });
});

describe("buffer bounds (events TZ §6)", () => {
  it("keeps at most 500 events: the oldest go first and are counted as lost", async () => {
    const { subject, time } = journal();
    subject.admit(profileA);
    await time.settle();
    for (let i = 0; i < 510; i++) subject.record({ ev: "c.budget", cmd, n: i % 100, outcome: "failed" });
    const { events, lost } = subject.pending();
    expect(events).toHaveLength(JOURNAL_LIMITS.maxEvents);
    expect(lost).toBe(10);
    expect(events[0]).toMatchObject({ n: 10 });
  });

  it("keeps at most the byte bound and drops events older than seven days", async () => {
    const { subject, time } = journal({ limits: { maxBytes: 1_000 } });
    subject.admit(profileA);
    await time.settle();
    for (let i = 0; i < 40; i++) subject.record(error);
    const kept = subject.pending().events;
    expect(kept.reduce((sum, event) => sum + jsonBytes(event), 0)).toBeLessThanOrEqual(1_000);
    expect(subject.pending().lost).toBe(40 - kept.length);

    const fresh = journal();
    fresh.subject.admit(profileA);
    await fresh.time.settle();
    fresh.subject.record(error);
    await fresh.time.advance(7 * 24 * 3600 * 1000 + 1);
    fresh.subject.record({ ev: "c.storage", kind: "storage_read" });
    expect(fresh.subject.pending()).toEqual({ events: [expect.objectContaining({ ev: "c.storage" })], lost: 1 });
  });

  it("never keeps an event off the closed lists or with an unknown field; counts it", async () => {
    const { subject, time } = journal();
    subject.admit(profileA);
    await time.settle();
    subject.record({ ...error, message: "MARKER-message" } as never);
    subject.record({ ev: "c.error", err: "MARKER-class" } as never);
    subject.record({ ev: "c.screen", kind: "result_shown", grade: "MARKER-answer" } as never);
    subject.record({ ev: "c.reset", cmd, kind: "settings.reset", outcome: "sent" } as never);
    subject.record({ ev: "c.cmd.send", cmd: "not-a-uuid", trace: cmd, kind: "answer.submit", attempt: 1 } as never);
    expect(subject.pending()).toEqual({ events: [], lost: 5 });
    expect(acceptedEvent({ ev: "c.error", err: "Error", cts: "2026-10-13T10:00:00.000Z" })).not.toBeNull();
  });

  it("keeps at most 20 c.recovery transitions of one command", async () => {
    const { subject, time } = journal();
    subject.admit(profileA);
    await time.settle();
    for (let i = 0; i < 25; i++) subject.record({ ev: "c.recovery", cmd, from: "checking", to: "unreachable" });
    expect(subject.pending().events).toHaveLength(20);
  });
});

describe("batches to the intake", () => {
  it("sends at most 50 events and 32 KiB per batch, oldest first, with the lost count as dropped", async () => {
    const { subject, time, sent } = journal({ limits: { maxEvents: 3 } });
    subject.admit(profileA);
    await time.settle();
    subject.record(error); subject.record(error); subject.record(error); subject.record({ ev: "c.storage", kind: "storage_write" });
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ client_instance_id: instance, client_version: "0.0.0", dropped: 1 });
    expect(sent[0].events).toHaveLength(3);
    expect(subject.pending()).toEqual({ events: [], lost: 0 });

    const many = journal();
    many.subject.admit(profileA);
    await many.time.settle();
    for (let i = 0; i < 120; i++) many.subject.record({ ev: "c.cmd.reply", cmd, trace: cmd, status: 200, outcome: "applied", ms: i });
    many.subject.setCredentials(credentials);
    await many.time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(many.sent.map(batch => batch.events.length)).toEqual([50]);
    await many.time.advance(JOURNAL_LIMITS.minIntervalMs - 1);
    expect(many.sent).toHaveLength(1);
    await many.time.advance(1);
    await many.time.advance(JOURNAL_LIMITS.minIntervalMs);
    expect(many.sent.map(batch => batch.events.length)).toEqual([50, 50, 20]);
    for (const batch of many.sent) {
      expect(batch.events.length).toBeLessThanOrEqual(BATCH_MAX_EVENTS);
      expect(jsonBytes(batch)).toBeLessThanOrEqual(BATCH_MAX_BYTES);
    }
    expect(many.sent.flatMap(batch => batch.events).map(event => (event as { ms: number }).ms)).toEqual([...Array(120).keys()]);

    const small = journal({ limits: { batchBytes: 600 } });
    small.subject.admit(profileA);
    await small.time.settle();
    for (let i = 0; i < 10; i++) small.subject.record(error);
    small.subject.setCredentials(credentials);
    await small.time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(jsonBytes(small.sent[0])).toBeLessThanOrEqual(600);
    expect(small.sent[0].events.length).toBeLessThan(10);
  });

  it("429 waits for its Retry-After, then sends the same events", async () => {
    const { subject, time, sent } = journal({}, [{ status: 429, code: "RATE_LIMITED", retryAfter: 45 }]);
    subject.admit(profileA);
    await time.settle();
    subject.record(error);
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(sent).toHaveLength(1);
    await time.advance(44_999);
    expect(sent).toHaveLength(1);
    await time.advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1].events).toEqual(sent[0].events);
    expect(subject.pending().events).toEqual([]);
  });

  it("429 without Retry-After or with a short one never sends faster than the rate", async () => {
    const { subject, time, sent } = journal({}, [{ status: 429 }, { status: 429, retryAfter: 1 }]);
    subject.admit(profileA);
    await time.settle();
    subject.record(error);
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    await time.advance(JOURNAL_LIMITS.retryMs - 1);
    expect(sent).toHaveLength(1);
    await time.advance(1);
    expect(sent).toHaveLength(2);
    await time.advance(JOURNAL_LIMITS.minIntervalMs - 1);
    expect(sent).toHaveLength(2);
    await time.advance(1);
    expect(sent).toHaveLength(3);
  });

  it("422 drops that batch for good, counts it, and does not loop", async () => {
    const { subject, time, sent } = journal({ limits: { batchEvents: 2 } }, [{ status: 422, code: "VALIDATION_FAILED" }]);
    subject.admit(profileA);
    await time.settle();
    subject.record(error); subject.record(error); subject.record({ ev: "c.storage", kind: "storage_read" });
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(sent).toHaveLength(1);
    expect(subject.refusedBatches).toBe(1);
    expect(subject.pending()).toEqual({ events: [expect.objectContaining({ ev: "c.storage" })], lost: 2 });
    await time.advance(JOURNAL_LIMITS.minIntervalMs);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ dropped: 2, events: [expect.objectContaining({ ev: "c.storage" })] });
    await time.advance(10 * 60_000);
    expect(sent).toHaveLength(2);
  });

  it("a refused admission or a deleted profile clears the buffer; an expired sign-in only stops sending", async () => {
    const deleted = journal({}, [{ status: 403, code: "PROFILE_DELETED" }]);
    deleted.subject.admit(profileA);
    await deleted.time.settle();
    deleted.subject.record(error);
    deleted.subject.setCredentials(credentials);
    await deleted.time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(deleted.subject.admitted()).toBeNull();
    expect(deleted.store.rows.size).toBe(0);
    deleted.subject.record(error);
    expect(deleted.subject.pending().events).toEqual([]);

    const expired = journal({}, [{ status: 401, code: "AUTH_EXPIRED" }]);
    expired.subject.admit(profileA);
    await expired.time.settle();
    expired.subject.record(error);
    expired.subject.setCredentials(credentials);
    await expired.time.advance(JOURNAL_LIMITS.flushDelayMs);
    await expired.time.advance(10 * 60_000);
    expect(expired.sent).toHaveLength(1);
    expect(expired.subject.pending().events).toHaveLength(1);
  });

  it("network failures wait and retry; a client version the core refuses keeps its buffer to itself", async () => {
    const failing = journal();
    failing.send.mockRejectedValueOnce(new TypeError("network"));
    failing.subject.admit(profileA);
    await failing.time.settle();
    failing.subject.record(error);
    failing.subject.setCredentials(credentials);
    await failing.time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(failing.subject.pending().events).toHaveLength(1);
    await failing.time.advance(JOURNAL_LIMITS.retryMs - 1);
    expect(failing.send).toHaveBeenCalledTimes(1);
    await failing.time.advance(1);
    expect(failing.send).toHaveBeenCalledTimes(2);
    expect(failing.sent).toHaveLength(1);
    expect(failing.subject.pending().events).toEqual([]);

    const odd = journal({ clientVersion: "1.0.0-beta" });
    odd.subject.admit(profileA);
    await odd.time.settle();
    odd.subject.record(error);
    odd.subject.setCredentials(credentials);
    await odd.time.advance(10 * 60_000);
    expect(odd.send).not.toHaveBeenCalled();
  });
});

describe("one buffer per profile, in memory and IndexedDB", () => {
  it("restores the stored buffer of the same profile and drops every other profile's", async () => {
    const store = memoryStore();
    store.rows.set(profileB, { profileId: profileB, events: [{ ev: "c.error", err: "Error", cts: "2026-10-13T09:59:00.000Z" }], lost: 0 });
    store.rows.set(profileA, { profileId: profileA, events: [
      { ev: "c.storage", kind: "storage_read", cts: "2026-10-13T09:59:00.000Z" },
      { ev: "c.error", err: "MARKER-class", cts: "2026-10-13T09:59:00.000Z" } as never,
    ], lost: 3 });
    const { subject, time, sent } = journal({ openStore: async () => store });
    subject.admit(profileA);
    subject.record(error);
    await time.settle();
    expect(store.rows.has(profileB)).toBe(false);
    expect(subject.pending()).toEqual({ events: [expect.objectContaining({ ev: "c.storage" }), expect.objectContaining({ ev: "c.error", err: "TypeError" })], lost: 4 });
    expect(store.rows.get(profileA)!.events).toHaveLength(2);

    subject.admit(profileB);
    await time.settle();
    expect(subject.pending()).toEqual({ events: [], lost: 0 });
    expect(store.rows.has(profileA)).toBe(false);
    subject.setCredentials(credentials);
    await time.advance(60_000);
    expect(sent).toEqual([]);
  });

  it("IndexedDB unavailable: no failure, the buffer lives in memory and says so once", async () => {
    await expect(IdbJournalStore.open(undefined)).rejects.toEqual(new JournalStoreError("missing"));
    const { subject, time, sent } = journal({ openStore: () => IdbJournalStore.open(undefined) });
    subject.admit(profileA);
    subject.record(error);
    await time.settle();
    expect(subject.idbOk()).toBe(false);
    expect(subject.pending().events).toEqual([expect.objectContaining({ ev: "c.error" }), { ev: "c.storage", kind: "idb_unavailable", cts: expect.any(String) }]);
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(sent).toHaveLength(1);

    const throwing = new FakeIndexedDb();
    throwing.openBehaviour = "throw";
    const other = journal({ openStore: () => IdbJournalStore.open(throwing.factory) });
    other.subject.admit(profileA);
    other.subject.record(error);
    await other.time.settle();
    expect(other.subject.idbOk()).toBe(false);
    expect(other.subject.pending().events).toHaveLength(2);
  });

  it("a failing store write is reported once, never in a loop", async () => {
    const store = memoryStore();
    store.save = vi.fn(async () => { throw new JournalStoreError("failed"); });
    const { subject, time } = journal({ openStore: async () => store });
    subject.admit(profileA);
    for (let i = 0; i < 5; i++) { subject.record(error); await time.settle(); }
    const reports = subject.pending().events.filter(event => event.ev === "c.storage");
    expect(reports).toEqual([expect.objectContaining({ kind: "storage_write" })]);
  });

  it("the IndexedDB store keeps one record per profile and clears the others", async () => {
    const idb = new FakeIndexedDb();
    const first = journal({ openStore: () => IdbJournalStore.open(idb.factory) });
    first.subject.admit(profileA);
    first.subject.record(error);
    await first.time.settle();
    await first.time.settle();
    expect([...idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).keys()]).toEqual([profileA]);

    const second = journal({ openStore: () => IdbJournalStore.open(idb.factory) });
    second.subject.admit(profileA);
    await second.time.settle();
    await second.time.settle();
    expect(second.subject.pending().events).toEqual([expect.objectContaining({ ev: "c.error", err: "TypeError" })]);

    const third = journal({ openStore: () => IdbJournalStore.open(idb.factory) });
    third.subject.admit(profileB);
    await third.time.settle();
    await third.time.settle();
    expect(idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).size).toBe(0);
    expect(third.subject.pending().events).toEqual([]);
  });
});

describe("the transport's part: trace and command attempts", () => {
  it("sends a new X-Wortly-Trace-Id on every request and reads its echo", async () => {
    const seen: string[] = [];
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const trace = (init!.headers as Record<string, string>)[TRACE_HEADER];
      seen.push(trace);
      return new Response("{}", { headers: { [TRACE_HEADER]: trace.toUpperCase() } });
    }) as unknown as typeof fetch;
    const request = createJsonTransport({ fetcher, timeoutMs: 1_000, maxResponseBytes: 1_000, gate: testGate() });
    const first = await request("/today", { method: "GET", token: "t" });
    const second = await request("/today", { method: "GET", token: "t" });
    expect(seen).toHaveLength(2);
    seen.forEach(trace => expect(trace).toMatch(UUID));
    expect(seen[0]).not.toBe(seen[1]);
    expect(first.trace).toBe(seen[0]);
    expect(second.trace).toBe(seen[1]);
    const bare = await createJsonTransport({ fetcher: (async () => new Response("{}")) as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate: testGate() })("/today", { method: "GET" });
    expect(bare).not.toHaveProperty("trace");
  });

  it("journals each command attempt with its trace and never a word, a token, initData or a message", async () => {
    const { subject, time, sent } = journal();
    installClientJournal(subject);
    subject.admit(profileA);
    await time.settle();
    const headers: Record<string, string>[] = [];
    let calls = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      headers.push(init!.headers as Record<string, string>);
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ command: { id: cmd, status: "applied" }, current: { word: "MARKER-lemma" } }));
      if (calls === 2) return new Response(JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "MARKER-message" } }), { status: 422 });
      throw new TypeError("MARKER-network-message");
    }) as unknown as typeof fetch;
    const request = createJsonTransport({ fetcher, timeoutMs: 1_000, maxResponseBytes: 10_000, gate: testGate() });
    const command = { command_id: cmd, kind: "answer.submit", payload: { text: "MARKER-answer" }, init_data: "MARKER-initData" };
    await request("/commands", { method: "POST", token: "MARKER-TOKEN", proof: "MARKER-PROOF", body: command });
    await request("/commands", { method: "POST", token: "MARKER-TOKEN", proof: "MARKER-PROOF", body: command });
    await expect(request("/commands", { method: "POST", token: "MARKER-TOKEN", proof: "MARKER-PROOF", body: command })).rejects.toBeTruthy();
    // Not a command: never journalled here, and a read never makes a c.cmd.* event.
    await expect(request("/auth", { method: "POST", body: { init_data: "MARKER-initData" } })).rejects.toBeTruthy();
    await expect(request(`/commands/${cmd}`, { method: "GET", token: "MARKER-TOKEN" })).rejects.toBeTruthy();
    // A page double: jsdom's own window reports a dispatched error to the test runner as uncaught.
    const handlers = new Map<string, (event: unknown) => void>();
    const page = { addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
      removeEventListener: (name: string) => handlers.delete(name),
      document: { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() } } as unknown as Window;
    const stop = watchPage(page, () => subject);
    handlers.get("error")!({ error: new RangeError("MARKER-error-message") });
    handlers.get("unhandledrejection")!({ reason: Object.assign(new Error("MARKER-rejection"), { name: "MARKER-name" }) });
    stop();
    expect(handlers.size).toBe(0);
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);

    const events = sent.flatMap(batch => batch.events);
    expect(events.map(event => event.ev)).toEqual(["c.cmd.send", "c.cmd.reply", "c.cmd.send", "c.cmd.reply", "c.cmd.send", "c.cmd.reply", "c.error", "c.error"]);
    const traces = headers.slice(0, 3).map(sentHeaders => sentHeaders[TRACE_HEADER]);
    expect(events.filter(event => event.ev === "c.cmd.send").map(event => (event as { trace: string }).trace)).toEqual(traces);
    expect(events.filter(event => event.ev === "c.cmd.send").map(event => (event as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    expect(events.filter(event => event.ev === "c.cmd.reply")).toEqual([
      expect.objectContaining({ cmd, trace: traces[0], status: 200, outcome: "applied" }),
      expect.objectContaining({ cmd, trace: traces[1], status: 422, code: "VALIDATION_FAILED", outcome: "refused" }),
      expect.objectContaining({ cmd, trace: traces[2], outcome: "network" }),
    ]);
    expect(events.slice(-2)).toEqual([expect.objectContaining({ err: "RangeError" }), expect.objectContaining({ err: "Error" })]);
    const text = JSON.stringify(sent);
    expect(text).not.toMatch(/MARKER|init_?[dD]ata|payload|lemma|Bearer/);
  });
});

describe("r2: QA P2-1 and P3", () => {
  it("QA GAP probe: a fresh page that meets a pending, rejected or deleted profile clears every stored buffer", async () => {
    const idb = new FakeIndexedDb();
    const first = journal({ openStore: () => IdbJournalStore.open(idb.factory) });
    first.subject.admit(profileA);
    first.subject.record(error);
    await first.time.settle(); await first.time.settle();
    expect(idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).size).toBe(1);
    // A new page: its journal never admitted anyone; the entry meets a refused admission.
    const second = journal({ openStore: () => IdbJournalStore.open(idb.factory) });
    second.subject.revoke(true);
    await second.time.settle(); await second.time.settle();
    expect(idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).size).toBe(0);
    // A later admission of the same profile finds nothing of it.
    second.subject.admit(profileA);
    await second.time.settle(); await second.time.settle();
    expect(second.subject.pending()).toEqual({ events: [], lost: 0 });
  });

  it("a clearing revoke right after a write is not undone by that write", async () => {
    const idb = new FakeIndexedDb();
    const { subject, time } = journal({ openStore: () => IdbJournalStore.open(idb.factory) });
    subject.admit(profileA);
    subject.record(error);
    subject.revoke(true);
    await time.settle(); await time.settle(); await time.settle();
    expect(idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).size).toBe(0);
  });

  it.each([400, 409, 410, 413])("any other refusal of the batch (%s) drops it once, counted, never resent", async (status) => {
    const { subject, time, sent } = journal({}, [{ status }]);
    subject.admit(profileA);
    await time.settle();
    subject.record(error);
    subject.setCredentials(credentials);
    await time.advance(60 * 60_000);
    expect(sent).toHaveLength(1);
    expect(subject.refusedBatches).toBe(1);
    expect(subject.pending()).toEqual({ events: [], lost: 1 });
  });

  it("408 and 5xx are temporary: the same batch goes again later", async () => {
    const { subject, time, sent } = journal({}, [{ status: 408 }, { status: 500 }]);
    subject.admit(profileA);
    await time.settle();
    subject.record(error);
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs + 2 * JOURNAL_LIMITS.retryMs);
    expect(sent).toHaveLength(3);
    expect(sent[2].events).toEqual(sent[0].events);
    expect(subject.refusedBatches).toBe(0);
  });

  it("a Retry-After beyond ten minutes waits ten minutes (RETRY_AFTER_MAX_MS), on 429 and on 503", async () => {
    expect(RETRY_AFTER_MAX_MS).toBe(600_000);
    for (const status of [429, 503]) {
      const { subject, time, sent } = journal({}, [{ status, retryAfter: 1_000_000 }]);
      subject.admit(profileA);
      await time.settle();
      subject.record(error);
      subject.setCredentials(credentials);
      await time.advance(JOURNAL_LIMITS.flushDelayMs);
      await time.advance(RETRY_AFTER_MAX_MS - 1);
      expect(sent).toHaveLength(1);
      await time.advance(1);
      expect(sent).toHaveLength(2);
    }
  });

  it("a lost admission seen on any route (403 in /commands) clears the journal at once; another 403 does not", async () => {
    const idb = new FakeIndexedDb();
    const { subject, time } = journal({ openStore: () => IdbJournalStore.open(idb.factory) });
    installClientJournal(subject);
    subject.admit(profileA);
    subject.record(error);
    await time.settle(); await time.settle();
    const reply = (code: string) => (async () => new Response(JSON.stringify({ error: { code } }), { status: 403 })) as unknown as typeof fetch;
    await createJsonTransport({ fetcher: reply("FORBIDDEN"), timeoutMs: 1_000, maxResponseBytes: 1_000, gate: testGate() })("/commands",
      { method: "POST", token: "t", proof: "p", body: { command_id: cmd, kind: "answer.submit" } });
    expect(subject.admitted()).toBe(profileA);
    await createJsonTransport({ fetcher: reply("ACCESS_REJECTED"), timeoutMs: 1_000, maxResponseBytes: 1_000, gate: testGate() })("/commands",
      { method: "POST", token: "t", proof: "p", body: { command_id: cmd, kind: "answer.submit" } });
    expect(subject.admitted()).toBeNull();
    expect(subject.pending()).toEqual({ events: [], lost: 0 });
    await time.settle(); await time.settle();
    expect(idb.rows(JOURNAL_DATABASE, JOURNAL_STORE).size).toBe(0);
  });

  it("401 only pauses: the same profile keeps recording, in memory even without IndexedDB, and sends with the next sign-in", async () => {
    const { subject, time, sent } = journal({ openStore: () => IdbJournalStore.open(undefined) });
    subject.admit(profileA);
    subject.record(error);
    subject.setCredentials(credentials);
    subject.revoke(false);
    subject.record({ ev: "c.storage", kind: "storage_write" });
    await time.advance(60 * 60_000);
    expect(sent).toEqual([]);
    expect(subject.admitted()).toBe(profileA);
    expect(subject.pending().events.map(event => event.ev)).toEqual(["c.error", "c.storage", "c.storage"]);
    subject.admit(profileA);
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(sent).toHaveLength(1);
    expect(sent[0].events).toHaveLength(3);
  });

  it("a client version the core refuses, or none, is said once in the developer console", () => {
    const warn = vi.fn();
    const transport = { fetcher: vi.fn() as unknown as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 1_000, gate: testGate() };
    createPageJournal(transport, "1.2.3+abcdef0", {}, warn);
    expect(warn).not.toHaveBeenCalled();
    createPageJournal(transport, "1.0.0-rc1", {}, warn);
    expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/VITE_WORTLY_CLIENT_VERSION is not X\.Y\.Z.*not sent/));
    expect(warn.mock.calls[0][0]).not.toContain("rc1");
    createPageJournal(transport, "0.0.0", {}, warn);
    expect(warn).toHaveBeenLastCalledWith(expect.stringMatching(/unset.*0\.0\.0/));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("r3: the intake not deployed yet, the order of a clear and a restore, the end of a page", () => {
  it.each([404, 405])("%s keeps the batch and waits an hour (CHANNEL_MISSING_PAUSE_MS); the buffer's own bounds still apply", async (status) => {
    const { subject, time, sent } = journal({}, Array.from({ length: 400 }, () => ({ status })));
    subject.admit(profileA);
    await time.settle();
    subject.record(error);
    subject.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    expect(sent).toHaveLength(1);
    expect(subject.refusedBatches).toBe(0);
    expect(subject.pending()).toEqual({ events: [expect.objectContaining({ ev: "c.error" })], lost: 0 });
    await time.advance(CHANNEL_MISSING_PAUSE_MS - 1);
    expect(sent).toHaveLength(1);
    await time.advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1].events).toEqual(sent[0].events);
    // Seven days without a channel: the event ages out like any other, counted as lost.
    await time.advance(7 * 24 * 3600 * 1000);
    subject.record({ ev: "c.storage", kind: "storage_read" });
    expect(subject.pending()).toEqual({ events: [expect.objectContaining({ ev: "c.storage" })], lost: 1 });
  });

  it("410 is a refusal of the batch like 422: dropped once and counted", async () => {
    const { subject, time, sent } = journal({}, [{ status: 410 }]);
    subject.admit(profileA);
    await time.settle();
    subject.record(error);
    subject.setCredentials(credentials);
    await time.advance(60 * 60_000);
    expect(sent).toHaveLength(1);
    expect(subject.pending()).toEqual({ events: [], lost: 1 });
  });

  it("R8: a restore right after a clearing revoke waits for the clear: the revoked buffer never comes back", async () => {
    // A store whose clear answers only when the test lets it: the order of the two operations becomes visible.
    const store = memoryStore();
    let releaseClear!: () => void;
    const clearing = new Promise<void>(resolve => { releaseClear = resolve; });
    const keepOnly = store.keepOnly.bind(store);
    store.keepOnly = async (profileId) => { if (profileId === null) await clearing; return keepOnly(profileId); };
    const { subject, time } = journal({ openStore: async () => store });
    subject.admit(profileA);
    subject.record(error);
    await time.settle();
    expect(store.rows.get(profileA)!.events).toHaveLength(1);
    subject.revoke(true);
    subject.admit(profileA);
    await time.settle();
    expect(subject.pending().events).toEqual([]);
    releaseClear();
    await time.settle(); await time.settle();
    expect(store.rows.size).toBe(0);
    expect(subject.pending()).toEqual({ events: [], lost: 0 });
  });

  it("a disposed journal (the App unmounted) records and sends nothing and leaves no timer; its buffer stays stored", async () => {
    const { subject, time, sent, store } = journal();
    subject.admit(profileA);
    await time.settle();
    subject.record(error);
    subject.setCredentials(credentials);
    subject.dispose();
    subject.record(error);
    subject.admit(profileB);
    await time.advance(60 * 60_000);
    expect(sent).toEqual([]);
    expect(subject.admitted()).toBeNull();
    expect(store.rows.get(profileA)!.events).toHaveLength(1);
  });

  it("the journal's own exchange never asks the window check of a DOCUMENT_STALE", async () => {
    const onDocumentStale = vi.fn();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: "DOCUMENT_STALE" } }), { status: 409 })) as unknown as typeof fetch;
    const time = manualClock();
    const page = createPageJournal({ fetcher, timeoutMs: 1_000, maxResponseBytes: 1_000, gate: testGate(), onDocumentStale }, "0.0.0",
      { clock: time.clock, openStore: async () => memoryStore() }, () => undefined);
    page.admit(profileA);
    await time.settle();
    page.record(error);
    page.setCredentials(credentials);
    await time.advance(JOURNAL_LIMITS.flushDelayMs);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onDocumentStale).not.toHaveBeenCalled();
  });
});

describe("c.reset, c.defect and c.delete (DEV-41 M1/M2, events §4.5, C496): only their closed fields and values", () => {
  const cts = "2026-10-16T05:00:00.000Z";
  it.each([
    { ev: "c.reset", cmd, kind: "settings.reset", outcome: "applied" },
    { ev: "c.reset", cmd, kind: "settings.reset_cancel", outcome: "cancelled" },
    { ev: "c.reset", cmd, kind: "settings.reset", outcome: "rejected_stale_epoch", code: "RESET_EPOCH_STALE" },
    { ev: "c.reset", cmd, kind: "settings.reset", outcome: "unknown" },
    { ev: "c.defect", cmd, trace: cmd, status: 422, code: "VALIDATION_FAILED" },
    { ev: "c.defect", cmd, trace: cmd, status: 100 },
    { ev: "c.defect", cmd, trace: cmd, status: 599 },
    { ev: "c.delete", cmd, outcome: "refused", code: "CLIENT_INCOMPATIBLE" },
    { ev: "c.delete", cmd, outcome: "unknown" },
  ])("keeps %o as it is", event => {
    expect(acceptedEvent({ ...event, cts })).toEqual({ ...event, cts });
  });

  it.each([
    { ev: "c.reset", cmd, kind: "settings.reset", outcome: "sent" },
    { ev: "c.reset", cmd, kind: "settings.reset_barrier", outcome: "applied" },
    { ev: "c.reset", cmd, kind: "setting.save", outcome: "applied" },
    { ev: "c.reset", kind: "settings.reset", outcome: "applied" },
    { ev: "c.reset", cmd, kind: "settings.reset", outcome: "applied", prof: cmd },
    { ev: "c.reset", cmd, kind: "settings.reset", outcome: "rejected_invalid", code: "MARKER free text" },
    { ev: "c.defect", trace: cmd, status: 422 },
    { ev: "c.defect", cmd, status: 422 },
    { ev: "c.defect", cmd, trace: "not-a-uuid", status: 422 },
    { ev: "c.defect", cmd, trace: cmd, status: 99 },
    { ev: "c.defect", cmd, trace: cmd, status: 600 },
    { ev: "c.defect", cmd, trace: cmd, status: "422" },
    { ev: "c.defect", cmd, trace: cmd, status: 422, body: "MARKER" },
    { ev: "c.delete", cmd, outcome: "applied" },
    { ev: "c.delete", cmd, outcome: "already_applied" },
    { ev: "c.delete", cmd, outcome: "refused", del: cmd },
    { ev: "c.delete", cmd, outcome: "unknown", trace: cmd },
    { ev: "c.delete", cmd, outcome: "refused", prof: cmd },
  ])("refuses %o whole", event => {
    expect(acceptedEvent({ ...event, cts })).toBeNull();
  });
});
