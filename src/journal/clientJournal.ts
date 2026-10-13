import type { ClientEventBatch } from "../api/generated";
import { acceptedEvent, BATCH_MAX_BYTES, BATCH_MAX_EVENTS, CLIENT_BUILD_VERSION, EVENT_MAX_BYTES, journalId, jsonBytes,
  type ClientEvent, type JournalEvent } from "./events";
import type { JournalStore } from "./journalStore";

/**
 * The buffer of the client journal and its way to the core (events TZ §4.5, §6; R3-03 step 6).
 *
 * - Only an admitted profile has a journal (P1-2, P04 r9 §2.7): until admit() nothing is kept, and the screens of a
 *   pending or rejected profile never call it. revoke(true) — a lost admission, a deleted profile, a pending or rejected
 *   sign-in — clears every buffer of this installation, in memory and stored, also on a fresh page that never admitted
 *   anyone. revoke(false) — an expired sign-in (401) — only pauses sending: the profile's journal goes on.
 * - One buffer per profile, in memory and in IndexedDB (journalStore.ts). Admitting another profile drops the buffer of
 *   every other profile, in memory and stored: a buffer is never sent under another profile.
 * - Bounds (§6): at most 500 events, 256 KiB and 7 days; the oldest go first and are counted in `lost`, which the next
 *   batch reports as `dropped`. An event over 512 bytes or off the closed lists is never kept (counted as well).
 * - Batches of at most 50 events and 32 KiB, never closer than the intake's rate allows (6 a minute per installation);
 *   429 waits for its Retry-After (at most RETRY_AFTER_MAX_MS); 422 and any other refusal of the batch itself (4xx but
 *   401, 403, 404, 405, 408, 429) drop that batch for good (counted), so a refused batch is never sent again. 404 and
 *   405 mean the intake is not deployed yet: the batch stays and the journal waits CHANNEL_MISSING_PAUSE_MS.
 */
export type JournalLimits = {
  maxEvents: number;
  maxBytes: number;
  maxAgeMs: number;
  batchEvents: number;
  batchBytes: number;
  /** The least time between two batches: 60 s / 6 batches of the intake's limit per installation. */
  minIntervalMs: number;
  /** How long a new event waits for others before a batch goes. */
  flushDelayMs: number;
  /** The wait after a failed exchange without a Retry-After. */
  retryMs: number;
  /** c.recovery transitions kept per command (§6: protection against a loop). */
  recoveriesPerCommand: number;
};
export const JOURNAL_LIMITS: JournalLimits = {
  maxEvents: 500, maxBytes: 256 * 1024, maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  batchEvents: BATCH_MAX_EVENTS, batchBytes: BATCH_MAX_BYTES,
  minIntervalMs: 10_000, flushDelayMs: 5_000, retryMs: 60_000, recoveriesPerCommand: 20,
};

/**
 * The longest wait a Retry-After can impose: 10 minutes. The intake's own window is one minute (core RATE_WINDOW), so its
 * 429 never asks for more; a longer value can only come from a planned pause (503 MAINTENANCE, whose end is an estimate)
 * or a misconfigured proxy. Ten minutes keeps such a journal at no more than six attempts an hour, while a value of days
 * cannot silence it until the page reloads; the buffer itself keeps events for 7 days.
 */
export const RETRY_AFTER_MAX_MS = 10 * 60_000;
/**
 * 404 or 405 on the intake: the channel is not deployed yet (a client released before its core; root decision, r3).
 * The batch is kept and the journal waits an hour; the buffer's own bounds (7 days, size, count) still apply.
 */
export const CHANNEL_MISSING_PAUSE_MS = 60 * 60_000;

export type JournalCredentials = { token: string; proof: string; clientInstanceId: string };
/** What the intake answered: status, the error code of a refusal, the whole seconds of Retry-After. */
export type JournalReply = { status: number; code?: string; retryAfter?: number };
export type JournalClock = { now(): number; schedule(action: () => void, delayMs: number): unknown; cancel(handle: unknown): void };

export type ClientJournalOptions = {
  clientVersion: string;
  send(batch: ClientEventBatch, credentials: JournalCredentials): Promise<JournalReply>;
  /** The durable store; absent or rejected: the buffer lives in memory only (c.storage idb_unavailable). */
  openStore?: () => Promise<JournalStore>;
  clock?: JournalClock;
  limits?: Partial<JournalLimits>;
};

const systemClock: JournalClock = {
  now: () => Date.now(),
  schedule: (action, delayMs) => setTimeout(action, Math.max(0, delayMs)),
  cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Entry = { seq: number; at: number; bytes: number; event: ClientEvent };

/** The refusals after which this profile has no journal any more (P04 r9 §3.8: a late batch is refused, the client clears). */
const ENDS_ADMISSION = new Set(["PROFILE_DELETED", "ACCESS_PENDING", "ACCESS_REJECTED"]);

export class ClientJournal {
  private readonly limits: JournalLimits;
  private readonly clock: JournalClock;
  private profileId: string | null = null;
  private credentials: JournalCredentials | null = null;
  private entries: Entry[] = [];
  private bytes = 0;
  private lost = 0;
  private seq = 0;
  /** Every admit and revoke starts a new generation: a late store or intake answer of an older one changes nothing. */
  private generation = 0;
  private storePromise: Promise<JournalStore | null> | null = null;
  private idb: boolean | null = null;
  private restoring: Promise<void> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private writeQueued = false;
  private reported = new Set<string>();
  private sending = false;
  private notBefore = 0;
  private timer: { handle: unknown; at: number } | null = null;
  private recoveries = new Map<string, number>();
  private attempts = new Map<string, { noted?: number; last: number }>();
  /** Batches the intake refused as invalid (422) and that were dropped. */
  refusedBatches = 0;
  private disposed = false;

  constructor(private readonly options: ClientJournalOptions) {
    this.limits = { ...JOURNAL_LIMITS, ...options.limits };
    this.clock = options.clock ?? systemClock;
  }

  /** The admitted profile whose journal is kept now (null: none, nothing is recorded). */
  admitted(): string | null { return this.profileId; }
  /** Whether IndexedDB holds the buffer: null until known. */
  idbOk(): boolean | null { return this.idb; }
  /** The buffer as it would be sent next: tests and diagnostics only. */
  pending(): { events: ClientEvent[]; lost: number } {
    return { events: this.entries.map(entry => ({ ...entry.event })), lost: this.lost };
  }

  /** The profile is admitted: its journal starts (or goes on); another profile's buffer is dropped everywhere. */
  admit(profileId: string): void {
    if (this.disposed) return;
    const id = journalId(profileId);
    if (id === null || id === this.profileId) return;
    this.reset();
    this.profileId = id;
    const generation = this.generation;
    // After every store operation already queued (a clearing revoke among them), so it never reads what is being removed.
    this.restoring = this.restore(generation, id, this.writes);
  }

  /** The sign-in this journal may send with; null stops sending (the buffer stays). */
  setCredentials(credentials: JournalCredentials | null): void {
    if (credentials !== null && (journalId(credentials.clientInstanceId) === null || !credentials.token || !credentials.proof)) credentials = null;
    this.credentials = credentials === null ? null : { ...credentials, clientInstanceId: credentials.clientInstanceId.toLowerCase() };
    if (this.credentials) this.schedule(this.limits.flushDelayMs);
  }

  /**
   * The journal of this profile ends. clear: the profile lost its admission or was deleted (nothing of it is sent any
   * more, the stored buffer goes too); otherwise only the sign-in ended (401): the stored buffer waits for the next one.
   */
  revoke(clear: boolean): void {
    if (clear) {
      // Also when nothing is admitted in this page: a buffer an earlier page stored for a profile that is now pending,
      // rejected or deleted must not wait for a later admission (events TZ §4.5; P04 r9 §8). Queued after every
      // earlier store operation, so no earlier write can bring it back.
      this.reset();
      const cleared = this.writes.then(() => this.store()).then(store => store?.keepOnly(null)).catch(() => undefined);
      this.writes = cleared;
      return;
    }
    // 401: only the sign-in ended, not the admission. The journal of the same profile goes on (in memory and stored)
    // and is sent with the next sign-in; another profile's admission or a lost admission clears it.
    if (this.profileId === null) return;
    this.credentials = null;
    if (this.timer) this.clock.cancel(this.timer.handle);
    this.timer = null;
    this.persist();
  }

  /** One event of the admitted profile; without an admitted profile nothing at all happens. Never throws. */
  record(event: JournalEvent): void {
    if (this.profileId === null) return;
    if (event.ev === "c.recovery") {
      const cmd = journalId(event.cmd) ?? "";
      const seen = this.recoveries.get(cmd) ?? 0;
      if (seen >= this.limits.recoveriesPerCommand) return;
      this.recoveries.set(cmd, seen + 1);
      if (this.recoveries.size > this.limits.maxEvents) this.recoveries.clear();
    }
    const now = this.clock.now();
    const accepted = acceptedEvent({ ...event, cts: new Date(now).toISOString() });
    const bytes = accepted === null ? 0 : jsonBytes(accepted);
    if (accepted === null || bytes > EVENT_MAX_BYTES) { this.lost++; return; }
    this.entries.push({ seq: ++this.seq, at: now, bytes, event: accepted });
    this.bytes += bytes;
    this.trim(now);
    this.persist();
    this.schedule(this.limits.flushDelayMs);
  }

  /** The number of this send of command cmd (1–100), as the recovery machine counts it, else as this page counted it. */
  attempt(cmd: string): number {
    const id = cmd.toLowerCase();
    const known = this.attempts.get(id) ?? { last: 0 };
    const attempt = known.noted ?? Math.min(100, known.last + 1);
    this.attempts.set(id, { last: attempt });
    if (this.attempts.size > this.limits.maxEvents) this.attempts.clear();
    return attempt;
  }
  /** The recovery machine is about to make send number attempt of cmd. */
  noteAttempt(cmd: string, attempt: number): void {
    const id = cmd.toLowerCase();
    this.attempts.set(id, { last: this.attempts.get(id)?.last ?? 0, noted: Math.max(1, Math.min(100, attempt)) });
  }

  /** Send what is buffered as soon as the rate allows (the page goes to the background). */
  flushSoon(): void { this.schedule(0); }

  /**
   * The page's App is gone (unmounted): nothing is recorded or sent any more and no timer is left. What is buffered is
   * written once more, so the next page of this installation finds it; nothing stored is removed.
   */
  dispose(): void {
    if (this.disposed) return;
    const profileId = this.profileId;
    const snapshot = profileId === null ? null : { profileId, events: this.entries.map(entry => entry.event), lost: this.lost };
    const restoring = this.restoring;
    this.reset();
    this.disposed = true;
    if (snapshot) {
      this.writes = this.writes.then(() => restoring).then(() => this.store())
        .then(store => store?.save(snapshot)).catch(() => undefined);
    }
  }

  private reset(): void {
    this.generation++;
    if (this.timer) this.clock.cancel(this.timer.handle);
    this.timer = null;
    this.profileId = null;
    this.credentials = null;
    this.entries = [];
    this.bytes = 0;
    this.lost = 0;
    this.notBefore = 0;
    this.sending = false;
    this.writeQueued = false;
    this.reported.clear();
    this.recoveries.clear();
    this.attempts.clear();
  }

  private store(): Promise<JournalStore | null> {
    if (!this.storePromise) {
      const open = this.options.openStore;
      this.storePromise = (open ? Promise.resolve().then(open) : Promise.reject(new Error("no store"))).then(store => {
        this.idb = true;
        return store;
      }, () => {
        this.idb = false;
        return null;
      });
    }
    return this.storePromise;
  }

  /** A storage failure of this profile, reported once per admission: the report itself must not fail in a loop. */
  private report(kind: "storage_read" | "storage_write" | "idb_unavailable"): void {
    if (this.reported.has(kind)) return;
    this.reported.add(kind);
    this.record({ ev: "c.storage", kind });
  }

  private async restore(generation: number, profileId: string, before: Promise<void>): Promise<void> {
    await before;
    const store = await this.store();
    if (generation !== this.generation) return;
    if (store === null) { this.report("idb_unavailable"); return; }
    let stored;
    try {
      await store.keepOnly(profileId);
      stored = await store.load(profileId);
    } catch {
      if (generation === this.generation) this.report("storage_read");
      return;
    }
    if (generation !== this.generation || stored === null) return;
    const restored: Entry[] = [];
    let invalid = 0;
    for (const value of stored.events) {
      const event = acceptedEvent(value);
      const bytes = event === null ? 0 : jsonBytes(event);
      if (event === null || bytes > EVENT_MAX_BYTES) { invalid++; continue; }
      restored.push({ seq: 0, at: Date.parse(event.cts), bytes, event });
    }
    // The stored events are older than everything recorded meanwhile: they go first, in their own order.
    const merged = [...restored, ...this.entries];
    merged.forEach(entry => { entry.seq = ++this.seq; });
    this.entries = merged;
    this.bytes = merged.reduce((sum, entry) => sum + entry.bytes, 0);
    this.lost += stored.lost + invalid;
    this.trim(this.clock.now());
    this.persist();
    if (this.entries.length > 0) this.schedule(this.limits.flushDelayMs);
  }

  private trim(now: number): void {
    const { maxEvents, maxBytes, maxAgeMs } = this.limits;
    while (this.entries.length > 0 && (this.entries.length > maxEvents || this.bytes > maxBytes
      || now - this.entries[0].at > maxAgeMs)) {
      this.bytes -= this.entries.shift()!.bytes;
      this.lost++;
    }
  }

  /** Writes the buffer as it is when the write runs; writes queue one after another and coalesce. */
  private persist(): void {
    if (this.writeQueued || this.profileId === null) return;
    this.writeQueued = true;
    const generation = this.generation, restoring = this.restoring;
    // The restore of this generation, taken now: a later admission's restore waits for this chain, never the reverse.
    this.writes = this.writes.then(() => restoring).then(async () => {
      if (generation !== this.generation) return;
      this.writeQueued = false;
      const store = await this.store();
      if (store === null || generation !== this.generation || this.profileId === null) return;
      try {
        await store.save({ profileId: this.profileId, events: this.entries.map(entry => entry.event), lost: this.lost });
      } catch {
        if (generation === this.generation) this.report("storage_write");
      }
    }).catch(() => undefined);
  }

  private schedule(delayMs: number): void {
    if (this.profileId === null || this.credentials === null || this.entries.length === 0) return;
    const now = this.clock.now();
    const at = Math.max(now + delayMs, this.notBefore);
    if (this.timer && this.timer.at <= at) return;
    if (this.timer) this.clock.cancel(this.timer.handle);
    const generation = this.generation;
    const timer = { at, handle: null as unknown };
    timer.handle = this.clock.schedule(() => {
      if (this.timer !== timer) return;
      this.timer = null;
      if (generation === this.generation) void this.flush();
    }, at - now);
    this.timer = timer;
  }

  /** One batch: the oldest events that fit the intake's bounds. */
  private batch(credentials: JournalCredentials): { body: ClientEventBatch; last: number; lost: number } | null {
    const base = { client_instance_id: credentials.clientInstanceId, client_version: this.options.clientVersion, dropped: this.lost };
    let size = jsonBytes({ ...base, events: [] });
    const events: ClientEvent[] = [];
    let last = 0;
    for (const entry of this.entries) {
      if (events.length >= this.limits.batchEvents) break;
      const added = entry.bytes + (events.length > 0 ? 1 : 0);
      if (size + added > this.limits.batchBytes) break;
      size += added;
      events.push(entry.event);
      last = entry.seq;
    }
    return events.length === 0 ? null : { body: { ...base, events }, last, lost: this.lost };
  }

  private async flush(): Promise<void> {
    await this.restoring;
    const generation = this.generation, credentials = this.credentials;
    if (this.sending || this.profileId === null || credentials === null) return;
    // The core refuses every batch of a client version it does not accept; such a build keeps its buffer to itself.
    if (!CLIENT_BUILD_VERSION.test(this.options.clientVersion)) return;
    const now = this.clock.now();
    if (now < this.notBefore) { this.schedule(0); return; }
    this.trim(now);
    const batch = this.batch(credentials);
    if (batch === null) return;
    this.sending = true;
    let reply: JournalReply | null;
    try { reply = await this.options.send(batch.body, credentials); }
    catch { reply = null; }
    if (generation !== this.generation) return;
    this.sending = false;
    const after = this.clock.now();
    this.notBefore = after + this.limits.minIntervalMs;
    if (reply === null) {
      this.notBefore = after + Math.max(this.limits.retryMs, this.limits.minIntervalMs);
    } else if (reply.status >= 200 && reply.status < 300) {
      this.drop(batch.last);
      this.lost = Math.max(0, this.lost - batch.lost);
      this.persist();
    } else if (reply.status === 429) {
      this.notBefore = after + this.wait(reply.retryAfter);
    } else if (reply.status === 404 || reply.status === 405) {
      // No intake on this core yet: nothing of the batch is dropped; the next try waits an hour.
      this.notBefore = after + CHANNEL_MISSING_PAUSE_MS;
    } else if (reply.status >= 400 && reply.status < 500 && reply.status !== 401 && reply.status !== 403 && reply.status !== 408) {
      // 422 and any other refusal of the batch itself (400, 409, 410, 413, ...): sent again it is refused again, so it
      // is dropped for good and counted; the next batch goes after the usual interval.
      this.refusedBatches++;
      this.lost += this.drop(batch.last);
      this.persist();
    } else if (reply.status === 403 && reply.code !== undefined && ENDS_ADMISSION.has(reply.code)) {
      this.revoke(true);
      return;
    } else if (reply.status === 401 || reply.status === 403) {
      // This sign-in or proof does not serve the intake: wait for the next one; the buffer stays.
      this.credentials = null;
      return;
    } else {
      this.notBefore = after + this.wait(reply.retryAfter);
    }
    this.schedule(0);
  }

  /** The wait a refusal asks for: its Retry-After, else retryMs; never below the rate, never above RETRY_AFTER_MAX_MS. */
  private wait(retryAfter: number | undefined): number {
    const asked = retryAfter !== undefined ? retryAfter * 1000 : this.limits.retryMs;
    return Math.min(RETRY_AFTER_MAX_MS, Math.max(this.limits.minIntervalMs, asked));
  }

  /** Removes the entries up to seq (those that were in the batch and are still here); returns how many. */
  private drop(seq: number): number {
    let removed = 0;
    while (this.entries.length > 0 && this.entries[0].seq <= seq) {
      this.bytes -= this.entries.shift()!.bytes;
      removed++;
    }
    return removed;
  }
}

let installed: ClientJournal | null = null;

/** The journal of this page (App installs it); tests install their own and remove it again. */
export function installClientJournal(journal: ClientJournal | null): void { installed = journal; }
export function clientJournal(): ClientJournal | null { return installed; }

/** Records one event when a journal is installed and a profile admitted; a failure of the journal never reaches the caller. */
export function journalRecord(event: JournalEvent): void {
  try { installed?.record(event); } catch { /* the journal never breaks the app */ }
}
/**
 * Any answer of the core that ends this profile's admission (403 PROFILE_DELETED, ACCESS_PENDING, ACCESS_REJECTED), on
 * any route: the journal is cleared at once, not only after its own intake is refused (QA P3-4).
 */
export function journalRefusal(status: number, code: string | undefined): void {
  if (status !== 403 || code === undefined || !ENDS_ADMISSION.has(code)) return;
  try { installed?.revoke(true); } catch { /* the journal never breaks the app */ }
}
export function journalNoteAttempt(cmd: string, attempt: number): void {
  try { installed?.noteAttempt(cmd, attempt); } catch { /* the journal never breaks the app */ }
}
/** Entry's view of the journal: who is admitted, with which sign-in, and when it ends. None of these ever throws. */
export const journalAccess = {
  admit(profileId: string): void { try { installed?.admit(profileId); } catch { /* never breaks the entry */ } },
  credentials(credentials: JournalCredentials | null): void { try { installed?.setCredentials(credentials); } catch { /* idem */ } },
  revoke(clear: boolean): void { try { installed?.revoke(clear); } catch { /* idem */ } },
  idbOk(): boolean | null { try { return installed?.idbOk() ?? null; } catch { return null; } },
};
