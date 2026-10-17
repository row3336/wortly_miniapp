import type { AsyncStorage } from "../platform/storage";
import { createdHere, noteCreatedHere } from "./pageOrigin";
import { journalRecord } from "../journal/clientJournal";

export class PendingStoreError extends Error {
  /**
   * lost_envelope (project_pending_profile_slots.md §3.1/§3.2): the profile's pointer is there, its payload (the text and
   * envelope of the command, Е02) is not — the command is known by its ID only: never «no command», never a new
   * command_id or budget, never a resend of a guessed body. legacy (§4): a key of an earlier shared-slot build is on this
   * device, or reading it failed — a NEW intent of this kind is not stored (fail-closed until a cutover); nothing is
   * written to or removed from the legacy key.
   */
  constructor(public readonly kind: "unavailable" | "invalid" | "changed" | "cancelled" | "lost_envelope" | "legacy",
    /** lost_envelope only: what the pointer still knows — enough to read the status of the same command_id (Q27). */
    public readonly lost?: LostEnvelope) { super(kind); }
}

/**
 * The service data of a command whose content is gone (project_pending_profile_slots.md §3.1, Q27, CON §6.1 п.5): no
 * user's content, never an intent that could be sent, never an answer «restored». `record` is the stored service
 * projection of the owner's record — `intent.payload` without its content (CONTENT: the answer, the self-assessment,
 * the grade, the message text; a card_id of a message stays); `commandId`/`kind` are its intent's. The projection was
 * checked locally by the owner's validator (C464/C467). An owner reads the status of exactly this command_id and,
 * after a proven outcome, removes it with clearLost.
 */
export type LostEnvelope = Readonly<{
  profileId: string;
  commandId: string;
  kind: string;
  record: Readonly<Record<string, unknown>>;
}>;

/**
 * The slot refused to store a NEW intent before anything was written: another window's record is there ("changed"), or
 * the record there, or the intent itself, cannot be read ("invalid"). Nothing was stored, so nothing was or can be sent:
 * the one proof every lane uses to drop such an intent instead of keeping it as an unknown outcome. "unavailable" and
 * "cancelled" carry no such proof (the write itself may have happened), so they never drop anything.
 */
export function refusedUnsent(error: unknown): error is PendingStoreError {
  return error instanceof PendingStoreError && (error.kind === "changed" || error.kind === "invalid");
}

export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function active(signal: AbortSignal): void {
  if (signal.aborted) throw new PendingStoreError("cancelled");
}

/** A profile's stored record could not be read or written (events TZ §4.5 c.storage): only the class, never the key or value. */
function journalStorage(kind: "storage_read" | "storage_write", error: unknown): void {
  if (!(error instanceof PendingStoreError && error.kind === "cancelled")) journalRecord({ ev: "c.storage", kind });
}

/**
 * The content of the user's input in `intent.payload` (Е02 «текст и конверт ответа», canon §2: the pointer holds only
 * service data — IDs, versions, kind and context), by kind (C466, C467). Content is split by its keys, never by value:
 * `false` and `0` are content as well.
 * - answer.submit: the whole payload is the answer — `{text}` or `{forgot: true}` (a «Забыл» is an answer too);
 * - oral.grade: the whole payload — `{correct}`, the user's self-assessment (oralIntent.ts);
 * - result.grade: the whole payload — `{grade}`, the grade the user chose (writtenIntent.ts, learning, conjugation);
 * - feedback.send: `text` is the message; `card_id` is the service ID of its card (the status check of the same ID
 *   compares it).
 * Service data only, no payload key: session.start (mode, bucket, verb and tense — what session to open), session.stop
 * (reason, unsaved_command_id), session.cancel_start, the remote stop, the manual card selection (card_id,
 * expected_pair); assignment.present, oral.reveal, result.correct, result.undo carry an empty payload, which stays empty.
 */
type Split = { service: Record<string, unknown>; content: Record<string, unknown> };
const whole = (payload: Record<string, unknown>): Split => ({ service: {}, content: { ...payload } });
const CONTENT: Readonly<Record<string, (payload: Record<string, unknown>) => Split>> = {
  "answer.submit": whole,
  "oral.grade": whole,
  "result.grade": whole,
  "feedback.send": payload => {
    const { text: _text, ...service } = payload;
    return { service, content: Object.hasOwn(payload, "text") ? { text: payload.text } : {} };
  },
};
/**
 * The local check of the service projection of a lost pointer (C464, C467): it stands in place of the gone content
 * only while the owner's validator checks the other fields. It is never returned (not in LostEnvelope), stored, sent,
 * logged or kept for a later send; the result of that copy is compared without it.
 */
const VALIDATION_PROBES: Readonly<Record<string, Record<string, unknown>>> = {
  "answer.submit": { text: "q27-validation-probe" },
  "feedback.send": { text: "q27-validation-probe" },
  "oral.grade": { correct: true },
  "result.grade": { grade: 3 },
};
const PAYLOAD_KINDS: ReadonlySet<string> = new Set(Object.keys(CONTENT));
/** The split of an intent's payload into the pointer's service part and the content kept apart; null: no content. */
function splitIntent(intent: unknown): Split | null {
  if (!record(intent) || typeof intent.kind !== "string" || !Object.hasOwn(CONTENT, intent.kind) || !record(intent.payload)) return null;
  const split = CONTENT[intent.kind]!(intent.payload);
  return Object.keys(split.content).length === 0 ? null : split;
}
const SHARED_PREFIX = "wortly.pending.";
export const PAYLOAD_PREFIX = "wortly.payload.";

/**
 * The stored form of one record under the profile addressing (§2): the pointer key and value, and the payload key and
 * value when the record carries the user's text. The one encoder of the format (PendingSlot uses it; tests seed with it).
 * record must already be the canonical form of its store.
 */
export function encodePending(baseKey: string, value: { profileId: string } & Record<string, unknown>): {
  pointerKey: string; pointer: string; payloadKey?: string; payload?: string } {
  const intent = value.intent as Record<string, unknown> | undefined;
  const pointerKey = pointerKeyOf(baseKey, value.profileId);
  const split = splitIntent(intent);
  if (!split || typeof intent!.command_id !== "string") return { pointerKey, pointer: JSON.stringify({ schemaVersion: 2, record: value }) };
  const payloadKey = payloadKeyOf(baseKey, value.profileId, intent!.command_id);
  return { pointerKey, pointer: JSON.stringify({ schemaVersion: 2, record: { ...value, intent: { ...intent, payload: split.service } }, payloadKey }),
    payloadKey, payload: JSON.stringify(split.content) };
}

/** The pointer key of one profile for the shared base key of a kind (§2): `wortly.pending.<L>:profile:<pid>`. */
export function pointerKeyOf(baseKey: string, profileId: string): string {
  if (!validId(profileId)) throw new PendingStoreError("invalid");
  return `${baseKey}:profile:${profileId.toLowerCase()}`;
}
/** The write-once payload key of one command (§2): `wortly.payload.<L>:<pid>:<command_id>`. */
export function payloadKeyOf(baseKey: string, profileId: string, commandId: string): string {
  if (!validId(profileId) || !validId(commandId) || !baseKey.startsWith(SHARED_PREFIX)) throw new PendingStoreError("invalid");
  return `${PAYLOAD_PREFIX}${baseKey.slice(SHARED_PREFIX.length)}:${profileId.toLowerCase()}:${commandId.toLowerCase()}`;
}

type Intentful = { profileId: string; mismatch?: true; intent?: { command_id?: unknown; kind?: unknown; payload?: unknown } };
type Stored = { schemaVersion: 2; record: Record<string, unknown>; payloadKey?: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON form independent of the property order: the decoder compares meaning, not the order a seed wrote. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${canonicalJson(value[name])}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * One temporary intent per profile and kind. Share the instance across document controllers; Entry owns the window lease.
 *
 * Addressing (project_pending_profile_slots.md ред.1.1 §2–§3): `profile` (the kinds of the former shared slots) — the
 * record of profile P lives in its pointer `<key>:profile:<p>`; a user's input (`intent.payload` of answer.submit and
 * feedback.send) lives apart in the write-once payload `wortly.payload.<L>:<p>:<command_id>`. No operation of P reads,
 * writes or removes another profile's key, and none touches the former shared key `<key>` itself (it is only read, by
 * the preflight of a NEW intent, §4). `fixed` (settings and the P02 reset: keys that are already per profile, R3-02) —
 * the record at `key` itself, in its own unchanged form.
 *
 * save: payload first, then the pointer; the send is allowed only after save resolved (the pointer is stored). clear:
 * the pointer first, then the payload. A payload is never rewritten: a repeat of the same command_id reads it.
 */
export class PendingSlot<T extends { profileId: string; mismatch?: true }> {
  private queue: Promise<unknown> = Promise.resolve();

  /** copy validates and returns a canonical, detached value, or throws PendingStoreError. */
  constructor(
    private readonly storage: AsyncStorage,
    private readonly key: string,
    private readonly copy: (value: unknown) => T,
    private readonly addressing: "profile" | "fixed" = key.startsWith(SHARED_PREFIX) && !/:profile:/.test(key) ? "profile" : "fixed",
  ) {}

  private same(left: T, right: T): boolean {
    return JSON.stringify(this.copy(left)) === JSON.stringify(this.copy(right));
  }

  private run<R>(action: () => Promise<R>): Promise<R> {
    const task = this.queue.then(action).catch((error: unknown) => {
      if (error instanceof PendingStoreError) throw error;
      throw new PendingStoreError("unavailable");
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async get(key: string): Promise<string | null> {
    try { return await this.storage.get(key); } catch (error) { journalStorage("storage_read", error); throw error; }
  }
  private async set(key: string, value: string): Promise<void> {
    try { await this.storage.set(key, value); } catch (error) { journalStorage("storage_write", error); throw error; }
  }
  private async remove(key: string): Promise<void> {
    try { await this.storage.remove(key); } catch (error) { journalStorage("storage_write", error); throw error; }
  }

  private pointerKey(profileId: string): string {
    return this.addressing === "profile" ? pointerKeyOf(this.key, profileId) : this.key;
  }
  /** The body kept apart: the content of the user's input (CONTENT, Е02); null for a kind with service data only. */
  private bodyOf(value: T): { payloadKey: string; body: Record<string, unknown> } | null {
    if (this.addressing !== "profile") return null;
    const intent = (value as Intentful).intent;
    const split = splitIntent(intent);
    if (!split || typeof intent!.command_id !== "string") return null;
    return { payloadKey: payloadKeyOf(this.key, value.profileId, intent!.command_id), body: split.content };
  }
  /** The pointer form: the canonical record, its content kept apart when there is one (encodePending). */
  private stored(value: T): Stored {
    const canonical = this.copy(value) as unknown as { profileId: string } & Record<string, unknown>;
    return JSON.parse(encodePending(this.key, canonical).pointer) as Stored;
  }
  /**
   * The strict decoder of a pointer of profileId that names a payload (C464), before the payload is read or removed:
   * a kind with the user's input, a valid command_id, a payload without text, the exact payload key of this kind,
   * profile and command — and the owner's own validator accepts every other field, the stored form being exactly its
   * canonical form. Anything else is damage ("invalid"): never a LostEnvelope, never a read or removal of that key.
   */
  private decodeNamed(pointer: Stored, profileId: string): LostEnvelope {
    const intent = pointer.record.intent;
    if (!record(intent) || typeof intent.kind !== "string" || !PAYLOAD_KINDS.has(intent.kind) || !validId(intent.command_id)
      || !record(intent.payload) || splitIntent(intent) !== null
      || pointer.payloadKey !== payloadKeyOf(this.key, profileId, intent.command_id)) throw new PendingStoreError("invalid");
    // The probe stands for whichever content was there (a text or a «Забыл», a self-assessment, a grade).
    const probe = { ...pointer.record, intent: { ...intent, payload: { ...intent.payload, ...VALIDATION_PROBES[intent.kind] } } };
    let canonical: T;
    try { canonical = this.copy(probe); } catch { throw new PendingStoreError("invalid"); }
    const form = this.stored(canonical);
    if (form.payloadKey !== pointer.payloadKey || canonicalJson(form.record) !== canonicalJson(pointer.record)) {
      throw new PendingStoreError("invalid");
    }
    return Object.freeze({ profileId: canonical.profileId, commandId: intent.command_id, kind: intent.kind,
      record: Object.freeze(form.record) });
  }

  /**
   * The pointer of profileId, decoded: "none", the full record, or a pointer whose payload is gone ("lost": its pointer
   * form only). A record of another profile under this profile's key is damage — "invalid", never removed.
   */
  private async readFor(profileId: string, signal: AbortSignal): Promise<{ kind: "none" } | { kind: "full"; value: T }
    | { kind: "lost"; pointer: Stored; lost: LostEnvelope }> {
    active(signal);
    if (!validId(profileId)) throw new PendingStoreError("invalid");
    const raw = await this.get(this.pointerKey(profileId));
    active(signal);
    if (raw === null) return { kind: "none" };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { journalStorage("storage_read", null); throw new PendingStoreError("invalid"); }
    if (this.addressing === "fixed") {
      let value: T;
      try { value = this.copy(parsed); } catch (error) { journalStorage("storage_read", error); throw error; }
      if (value.profileId.toLowerCase() !== profileId.toLowerCase()) throw new PendingStoreError("invalid");
      return { kind: "full", value };
    }
    if (!record(parsed) || parsed.schemaVersion !== 2 || !record(parsed.record)
      || (Object.hasOwn(parsed, "payloadKey") && typeof parsed.payloadKey !== "string")
      || Object.keys(parsed).some(name => !["schemaVersion", "record", "payloadKey"].includes(name))) {
      journalStorage("storage_read", null);
      throw new PendingStoreError("invalid");
    }
    const pointer = parsed as Stored;
    if (typeof pointer.record.profileId !== "string" || pointer.record.profileId.toLowerCase() !== profileId.toLowerCase()) {
      throw new PendingStoreError("invalid");
    }
    let candidate: unknown = pointer.record;
    if (pointer.payloadKey !== undefined) {
      let lost: LostEnvelope;
      try { lost = this.decodeNamed(pointer, profileId); } catch (error) { journalStorage("storage_read", null); throw error; }
      const payloadRaw = await this.get(pointer.payloadKey);
      active(signal);
      if (payloadRaw === null) return { kind: "lost", pointer, lost };
      let body: unknown;
      try { body = JSON.parse(payloadRaw); } catch { journalStorage("storage_read", null); throw new PendingStoreError("invalid"); }
      const intent = pointer.record.intent as Record<string, unknown>;
      const service = intent.payload as Record<string, unknown>;
      // The payload holds content only: no service field, none of the pointer's own fields.
      if (!record(body) || Object.keys(body).length === 0
        || Object.keys(CONTENT[intent.kind as string]!(body).service).length !== 0
        || Object.keys(body).some(name => Object.hasOwn(service, name))) throw new PendingStoreError("invalid");
      candidate = { ...pointer.record, intent: { ...intent, payload: { ...service, ...body } } };
    }
    let value: T;
    try { value = this.copy(candidate); } catch (error) { journalStorage("storage_read", error); throw error; }
    // The pointer must name exactly the payload of this record (or none): a payload key of another command is damage;
    // and be exactly its stored form: content in the pointer itself (a «Забыл» or a text) is damage as well.
    if ((this.bodyOf(value)?.payloadKey ?? null) !== (pointer.payloadKey ?? null)
      || canonicalJson(this.stored(value).record) !== canonicalJson(pointer.record)) throw new PendingStoreError("invalid");
    return { kind: "full", value };
  }

  /**
   * The page this slot belongs to (its storage): the key of the page's send budget store and of the IDs it created
   * (intentBudget pageBudgetSource, pageOrigin). An owner that is given only the slots (oral, M1d) reaches the page here.
   */
  get page(): AsyncStorage { return this.storage; }
  /** This page created the intent of commandId (decision 2.3 А): only such a record may be retried by hand. */
  noteCreated(commandId: string): void { noteCreatedHere(this.storage, commandId); }
  created(commandId: string | null | undefined): boolean { return createdHere(this.storage, commandId); }

  /** The record of profileId; a pointer without its payload is lost_envelope (§3.1). Writes and removes nothing. */
  load(profileId: string, signal: AbortSignal): Promise<T | null> {
    return this.run(async () => {
      const current = await this.readFor(profileId, signal);
      if (current.kind === "lost") throw new PendingStoreError("lost_envelope", current.lost);
      return current.kind === "full" ? current.value : null;
    });
  }

  /** The service data of a pointer whose payload is gone (Q27), else null. Writes and removes nothing. */
  loadLost(profileId: string, signal: AbortSignal): Promise<LostEnvelope | null> {
    return this.run(async () => {
      const current = await this.readFor(profileId, signal);
      return current.kind === "lost" ? current.lost : null;
    });
  }

  /**
   * After the outcome of a lost command is proven by its ID: removes exactly that pointer (and a payload that came back
   * meanwhile, which it names). Another record of the profile now: "changed", nothing removed.
   */
  clearLost(lost: LostEnvelope, signal: AbortSignal): Promise<void> {
    return this.run(async () => {
      const current = await this.readFor(lost.profileId, signal);
      if (current.kind === "none") return;
      const pointer = current.kind === "lost" ? current.pointer : this.stored(current.value);
      if (!record(lost) || canonicalJson(pointer.record) !== canonicalJson(lost.record)) throw new PendingStoreError("changed");
      await this.remove(this.pointerKey(lost.profileId));
      active(signal);
      if (pointer.payloadKey) { await this.remove(pointer.payloadKey); active(signal); }
    });
  }

  /**
   * The preflight of a NEW intent (§4): the former shared key of this kind must be reliably absent. Present, or not
   * readable: "legacy" — nothing stored, the kind stays closed for new intents; the legacy key is never written or removed.
   */
  private async preflight(signal: AbortSignal): Promise<void> {
    if (this.addressing !== "profile") return;
    let raw: string | null;
    try { raw = await this.storage.get(this.key); } catch { legacyFound(this.key, "unreadable"); throw new PendingStoreError("legacy"); }
    active(signal);
    if (raw !== null) { legacyFound(this.key, "present"); throw new PendingStoreError("legacy"); }
  }

  async save(value: T, signal: AbortSignal): Promise<void> {
    const pending = this.copy(value);
    return this.run(async () => {
      const current = await this.readFor(pending.profileId, signal);
      // The same command_id with its payload deleted (Е02): no new payload, no new body — known by its ID only.
      if (current.kind === "lost") throw new PendingStoreError("lost_envelope", current.lost);
      if (current.kind === "full") {
        if (!this.same(current.value, pending)) throw new PendingStoreError("changed");
        return; // a repeat of the same command: nothing is written (write-once)
      }
      await this.preflight(signal);
      const body = this.bodyOf(pending);
      if (body) {
        const existing = await this.get(body.payloadKey);
        active(signal);
        const serialized = JSON.stringify(body.body);
        // Write-once: an existing payload of this command is never rewritten; another content is a conflict.
        if (existing !== null && existing !== serialized) throw new PendingStoreError("changed");
        if (existing === null) { await this.set(body.payloadKey, serialized); active(signal); }
      }
      await this.set(this.pointerKey(pending.profileId), JSON.stringify(this.addressing === "fixed" ? pending : this.stored(pending)));
      active(signal);
    });
  }

  /** Removes the record after a proven outcome: the pointer first, then its payload. Another record: "changed". */
  private async removeIf(value: T, signal: AbortSignal, matches: (stored: Stored | T) => boolean): Promise<void> {
    const current = await this.readFor(value.profileId, signal);
    if (current.kind === "none") return;
    if (current.kind === "full" ? !matches(current.value) : !matches(current.pointer)) throw new PendingStoreError("changed");
    const payloadKey = current.kind === "full" ? this.bodyOf(current.value)?.payloadKey : current.pointer.payloadKey;
    await this.remove(this.pointerKey(value.profileId));
    active(signal);
    if (payloadKey) { await this.remove(payloadKey); active(signal); }
  }

  async clear(value: T, signal: AbortSignal): Promise<void> {
    const pending = this.copy(value);
    return this.run(() => this.removeIf(pending, signal, stored => "schemaVersion" in stored && stored.schemaVersion === 2
      && "record" in stored ? JSON.stringify(stored) === JSON.stringify(this.stored(pending)) : this.same(stored as T, pending)));
  }

  /**
   * Clear the record of a conflict (Я17) after its session was closed: the stored copy may still lack the conflict
   * mark when its write failed, so the comparison leaves that one field out; every other field must match exactly.
   */
  async clearMarked(value: T, signal: AbortSignal): Promise<void> {
    const unmarked = (item: T): T => { const { mismatch: _mark, ...rest } = item; return rest as T; };
    const pending = unmarked(this.copy(value));
    const unmarkedStored = (stored: Stored): string => {
      const { mismatch: _mark, ...rest } = stored.record;
      return JSON.stringify({ ...stored, record: rest });
    };
    return this.run(() => this.removeIf(pending, signal, stored => "schemaVersion" in stored && stored.schemaVersion === 2
      && "record" in stored ? unmarkedStored(stored) === unmarkedStored(this.stored(pending)) : this.same(unmarked(stored as T), pending)));
  }

  /** A mark of the same intent changes only the pointer; the body (payload) must be the same and is never rewritten. */
  private async rewritePointer(next: T, signal: AbortSignal): Promise<void> {
    const body = this.bodyOf(next);
    if (body) {
      const existing = await this.get(body.payloadKey);
      active(signal);
      if (existing === null) throw new PendingStoreError("lost_envelope");
      if (existing !== JSON.stringify(body.body)) throw new PendingStoreError("changed");
    }
    await this.set(this.pointerKey(next.profileId), JSON.stringify(this.addressing === "fixed" ? next : this.stored(next)));
    active(signal);
  }

  /**
   * One write that replaces the stored `expected` record by `next` (the same intent with a further mark). A record that is
   * neither of them fails as "changed"; an absent record is not recreated; `next` already stored is left as it is.
   */
  async replace(expected: T, next: T, signal: AbortSignal): Promise<void> {
    const before = this.copy(expected), after = this.copy(next);
    return this.run(async () => {
      const current = await this.readFor(before.profileId, signal);
      if (current.kind === "none") return;
      if (current.kind === "lost") throw new PendingStoreError("lost_envelope");
      if (this.same(current.value, after)) return;
      if (!this.same(current.value, before)) throw new PendingStoreError("changed");
      await this.rewritePointer(after, signal);
    });
  }

  async markMismatch(value: T, signal: AbortSignal): Promise<void> {
    const marked = this.copy({ ...value, mismatch: true });
    return this.run(async () => {
      const current = await this.readFor(marked.profileId, signal);
      if (current.kind === "lost") throw new PendingStoreError("lost_envelope");
      if (current.kind === "full" && !this.same({ ...current.value, mismatch: true }, marked)) throw new PendingStoreError("changed");
      if (current.kind === "full" && current.value.mismatch) return;
      if (current.kind === "none") {
        // As before, an absent record is stored marked; its body, if any, is written once and never over another content.
        const body = this.bodyOf(marked);
        if (body) {
          const existing = await this.get(body.payloadKey);
          active(signal);
          if (existing !== null && existing !== JSON.stringify(body.body)) throw new PendingStoreError("changed");
          if (existing === null) { await this.set(body.payloadKey, JSON.stringify(body.body)); active(signal); }
        }
      }
      await this.rewritePointer(marked, signal);
    });
  }
}

/** §4: only the technical name of one of the fixed legacy keys and the kind of problem; no envelope, profile or text. */
function legacyFound(key: string, problem: "present" | "unreadable"): void {
  // The closed event list of the journal has no field for a key name: the class only; the name goes to the console.
  journalRecord({ ev: "c.storage", kind: "storage_read" });
  try { console.warn(`pending preflight: legacy key ${key} ${problem}; new intents of this kind stay closed`); } catch { /* never breaks */ }
}
