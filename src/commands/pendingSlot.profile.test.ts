import { afterEach, describe, expect, it, vi } from "vitest";
import { LearningSessionPendingStore, LearningStopPendingStore } from "../learning/learningSessionPending";
import type { LearningSessionPending } from "../learning/learningSessionPending";
import { FeedbackPendingStore } from "../feedback/feedbackPending";
import { OralSessionPendingStore } from "../oral/oralPending";
import type { AsyncStorage } from "../platform/storage";
import { browserStorage } from "../platform/storage";
import { dropForeignPayloads, wipeProfileRecords } from "../profile/profileWipe";
import { encodePending, payloadKeyOf, PendingStoreError, pointerKeyOf } from "./pendingSlot";
import { ClientJournal, installClientJournal } from "../journal/clientJournal";

/**
 * project_pending_profile_slots.md ред.1.1 (C422/C424, P2): the pointer per profile, the write-once payload of the user's
 * text, lost_envelope for a pointer without its payload (Q27), the preflight of the legacy shared key, no operation on
 * another profile's key.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const X = id(50), Y = id(60);
const BASE = "wortly.pending.learning_session", STOP_BASE = "wortly.pending.learning_stop";
const answer = (profileId: string, n = 100, text = "Haus"): LearningSessionPending => ({ schemaVersion: 1, profileId,
  clientInstanceId: id(1), pair: "ru-de",
  intent: { kind: "answer.submit", session_id: id(3), assignment_id: id(6), payload: { text }, command_id: id(n) } } as LearningSessionPending);
const stop = (profileId: string, n = 200): LearningSessionPending => ({ schemaVersion: 1, profileId, clientInstanceId: id(1),
  pair: "ru-de", intent: { kind: "session.stop", session_id: id(3), payload: { reason: "stop" }, command_id: id(n) } } as LearningSessionPending);
const signal = () => new AbortController().signal;

function storage(initial: Record<string, string> = {}, fail: { get?: (key: string) => boolean; set?: (key: string) => boolean } = {}) {
  const values = new Map(Object.entries(initial));
  const log: string[] = [], reads: string[] = [];
  const store: AsyncStorage = {
    async get(key) { reads.push(key); if (fail.get?.(key)) throw new Error("read"); return values.get(key) ?? null; },
    async set(key, value) { if (fail.set?.(key)) throw new Error("write"); log.push(`set ${key}`); values.set(key, value); },
    async remove(key) { log.push(`remove ${key}`); values.delete(key); },
    async keys(prefix) { return [...values.keys()].filter(key => key.startsWith(prefix)); },
  };
  return { store, values, log, reads };
}

describe("profile addresses (§2): the pointer per profile, the text apart, write-once", () => {
  it("an answer: the text in its payload key, the pointer without text; load joins them back exactly", async () => {
    const t = storage();
    const slot = new LearningSessionPendingStore(t.store);
    await slot.save(answer(X), signal());
    const payloadKey = payloadKeyOf(BASE, X, id(100));
    expect(JSON.parse(t.values.get(payloadKey)!)).toEqual({ text: "Haus" });
    const pointer = t.values.get(pointerKeyOf(BASE, X))!;
    expect(pointer).not.toContain("Haus");
    expect(JSON.parse(pointer)).toMatchObject({ schemaVersion: 2, payloadKey, record: { profileId: X, intent: { command_id: id(100), payload: {} } } });
    expect(t.log).toEqual([`set ${payloadKey}`, `set ${pointerKeyOf(BASE, X)}`]); // the payload first, then the pointer
    expect(await slot.load(X, signal())).toEqual(answer(X));
    expect(t.values.has(BASE)).toBe(false); // the former shared key is never written
  });

  it("a stop has no text: only the pointer", async () => {
    const t = storage();
    await new LearningStopPendingStore(t.store).save(stop(X), signal());
    expect([...t.values.keys()]).toEqual([pointerKeyOf(STOP_BASE, X)]);
  });

  it("write-once: a repeat of the same command writes nothing; another text under the same command_id is refused", async () => {
    const t = storage();
    const slot = new LearningSessionPendingStore(t.store);
    await slot.save(answer(X), signal());
    t.log.length = 0;
    await slot.save(answer(X), signal());
    await slot.markMismatch(answer(X), signal());
    expect(t.log.filter(entry => entry.includes("payload"))).toEqual([]);
    expect(JSON.parse(t.values.get(payloadKeyOf(BASE, X, id(100)))!)).toEqual({ text: "Haus" });
    // A second window of the same profile with the same ID can only read it; a different text is a conflict.
    const other = new LearningSessionPendingStore(t.store);
    await expect(other.save(answer(X, 100, "Hund"), signal())).rejects.toMatchObject({ kind: "changed" });
    expect(JSON.parse(t.values.get(payloadKeyOf(BASE, X, id(100)))!)).toEqual({ text: "Haus" });
  });

  it("clear: the pointer first, then the payload; nothing of another profile", async () => {
    const t = storage();
    const slot = new LearningSessionPendingStore(t.store);
    await slot.save(answer(X), signal());
    await slot.save(answer(Y, 101), signal());
    t.log.length = 0;
    await slot.clear(answer(X), signal());
    expect(t.log).toEqual([`remove ${pointerKeyOf(BASE, X)}`, `remove ${payloadKeyOf(BASE, X, id(100))}`]);
    expect(await slot.load(Y, signal())).toEqual(answer(Y, 101));
  });
});

describe("C424: wipe X never removes a pending of Y (the race of C422 is gone by construction)", () => {
  it("Y saved at any moment of the wipe of X stays, also after a reload", async () => {
    window.localStorage.clear();
    const local = browserStorage(window.localStorage);
    const windowX = new LearningSessionPendingStore(local), windowY = new LearningSessionPendingStore(local);
    await windowX.save(answer(X), signal());
    // The window of Y saves exactly between the reads and the removes of the wipe of X.
    const interleaved: AsyncStorage = { ...local, async remove(key) { await windowY.save(answer(Y, 101), signal()); return local.remove(key); } };
    await wipeProfileRecords(interleaved, X);
    expect(await new LearningSessionPendingStore(local).load(Y, signal())).toEqual(answer(Y, 101)); // a reload
    expect(await new LearningSessionPendingStore(local).load(X, signal())).toBeNull();
    window.localStorage.clear();
  });

  it("two profiles: two records; a record of another profile under this profile's key is damage, never removed", async () => {
    const t = storage({ [pointerKeyOf(BASE, X)]: JSON.stringify({ schemaVersion: 2, record: stop(Y) }) });
    const slot = new LearningSessionPendingStore(t.store);
    await expect(slot.load(X, signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(t.log).toEqual([]);
  });

  it("load never cleans: the legacy shared key and other profiles' keys are not touched", async () => {
    const t = storage({ [BASE]: JSON.stringify(answer(Y)), [pointerKeyOf(BASE, Y)]: JSON.stringify({ schemaVersion: 2, record: stop(Y) }) });
    expect(await new LearningSessionPendingStore(t.store).load(X, signal())).toBeNull();
    expect(t.log).toEqual([]);
  });
});

describe("a crash between the phases (§3.1)", () => {
  it("the payload stored, the pointer not: nothing to send (no pointer), the same save goes on with the same payload", async () => {
    let failPointer = true;
    const t = storage({}, { set: key => failPointer && key === pointerKeyOf(BASE, X) });
    const slot = new LearningSessionPendingStore(t.store);
    await expect(slot.save(answer(X), signal())).rejects.toBeInstanceOf(PendingStoreError);
    expect(await slot.load(X, signal())).toBeNull(); // the send is allowed only after the pointer: it never went
    failPointer = false;
    t.log.length = 0;
    await slot.save(answer(X), signal());
    expect(t.log).toEqual([`set ${pointerKeyOf(BASE, X)}`]); // the payload of the same command is reused, not rewritten
  });
});

describe("lost_envelope (Q27): the pointer without its payload", () => {
  async function lost() {
    const t = storage();
    const slot = new LearningSessionPendingStore(t.store);
    await slot.save(answer(X), signal());
    // Е02: Y is admitted on this device — the text of X goes, its pointer (the service IDs) stays.
    expect(await dropForeignPayloads(t.store, Y)).toEqual({ removed: 1, failed: 0 });
    expect(t.values.has(pointerKeyOf(BASE, X))).toBe(true);
    return { t, slot };
  }

  it("load: lost_envelope with the service data of the same command_id, no text and nothing to send", async () => {
    const { slot } = await lost();
    const error = await slot.load(X, signal()).catch((e: unknown) => e) as PendingStoreError;
    expect(error).toBeInstanceOf(PendingStoreError);
    expect(error.kind).toBe("lost_envelope");
    expect(error.lost).toMatchObject({ profileId: X, commandId: id(100), kind: "answer.submit" });
    expect(JSON.stringify(error.lost)).not.toContain("Haus");
    expect((error.lost!.record.intent as { payload: object }).payload).toEqual({});
    expect(await slot.loadLost(X, signal())).toEqual(error.lost);
  });

  it("save of the same command_id: lost_envelope — no new payload, no new body", async () => {
    const { t, slot } = await lost();
    t.log.length = 0;
    await expect(slot.save(answer(X), signal())).rejects.toMatchObject({ kind: "lost_envelope" });
    await expect(slot.save(answer(X, 101), signal())).rejects.toMatchObject({ kind: "lost_envelope" });
    await expect(slot.markMismatch(answer(X), signal())).rejects.toMatchObject({ kind: "lost_envelope" });
    expect(t.log).toEqual([]);
  });

  it("clearLost after a proven outcome removes exactly that pointer; another record now is «changed»", async () => {
    const { t, slot } = await lost();
    const found = (await slot.loadLost(X, signal()))!;
    await slot.clearLost({ ...found, record: { ...found.record, clientInstanceId: id(2) } }, signal()).then(
      () => { throw new Error("expected changed"); }, (error: PendingStoreError) => expect(error.kind).toBe("changed"));
    await slot.clearLost(found, signal());
    expect(t.values.has(pointerKeyOf(BASE, X))).toBe(false);
    expect(await slot.load(X, signal())).toBeNull();
  });

  it("feedback: card_id stays in the pointer, only the text goes", async () => {
    const t = storage();
    const slot = new FeedbackPendingStore(t.store);
    const pending = { schemaVersion: 1 as const, profileId: X,
      intent: { command_id: id(300), kind: "feedback.send" as const, payload: { text: "falsch", card_id: id(7) } } };
    await slot.save(pending, signal());
    await dropForeignPayloads(t.store, Y);
    const error = await slot.load(X, signal()).catch((e: unknown) => e) as PendingStoreError;
    expect(error.lost).toMatchObject({ commandId: id(300), kind: "feedback.send" });
    expect((error.lost!.record.intent as { payload: object }).payload).toEqual({ card_id: id(7) });
  });
});

describe("the preflight of the legacy shared key (§4)", () => {
  it("present: a NEW intent is not stored ('legacy'); the legacy record is not touched", async () => {
    const t = storage({ [BASE]: JSON.stringify(answer(Y)) });
    await expect(new LearningSessionPendingStore(t.store).save(answer(X), signal())).rejects.toMatchObject({ kind: "legacy" });
    expect(t.log).toEqual([]);
    expect(t.values.get(BASE)).toBe(JSON.stringify(answer(Y)));
  });

  it("unreadable: closed as well — an error is never «absent»", async () => {
    const t = storage({}, { get: key => key === BASE });
    await expect(new LearningSessionPendingStore(t.store).save(answer(X), signal())).rejects.toMatchObject({ kind: "legacy" });
    expect(t.log).toEqual([]);
  });

  it("the repeat of an already stored command of the profile is not a new intent: it goes on", async () => {
    const t = storage();
    const slot = new LearningSessionPendingStore(t.store);
    await slot.save(answer(X), signal());
    t.values.set(BASE, "{}");
    await slot.save(answer(X), signal()); // no throw: nothing new is stored
    expect(t.values.get(BASE)).toBe("{}");
  });
});

describe("C464: the strict decoder of a pointer that names a payload — damage is invalid, never a LostEnvelope", () => {
  afterEach(() => { installClientJournal(null); vi.restoreAllMocks(); });
  const FB = "wortly.pending.feedback";
  /** A pointer of X as the encoder writes it, with a change of its stored record or payload key; no payload stored. */
  function damaged(change: (pointer: { schemaVersion: 2; record: Record<string, any>; payloadKey?: string }) => void, extra: Record<string, string> = {}) {
    const pointer = JSON.parse(encodePending(BASE, answer(X) as never).pointer);
    change(pointer);
    return storage({ [pointerKeyOf(BASE, X)]: JSON.stringify(pointer), ...extra });
  }
  async function refusedEverywhere(t: ReturnType<typeof storage>) {
    const slot = new LearningSessionPendingStore(t.store);
    for (const action of [() => slot.load(X, signal()), () => slot.loadLost(X, signal()), () => slot.save(answer(X), signal()),
      () => slot.markMismatch(answer(X), signal()), () => slot.clear(answer(X), signal()),
      () => slot.clearLost({ profileId: X, commandId: id(100), kind: "answer.submit", record: {} }, signal())]) {
      const error = await action().then(() => null, (e: unknown) => e) as PendingStoreError | null;
      expect(error).toBeInstanceOf(PendingStoreError);
      expect(error!.kind).toBe("invalid"); // never lost_envelope: nothing to read back by GET
      expect(error!.lost).toBeUndefined();
    }
    expect(t.log).toEqual([]); // nothing written or removed — the pointer and any other key stay as they are
    expect(t.reads.every(key => key === pointerKeyOf(BASE, X))).toBe(true); // the named key is never read
  }

  it("(1) command_id not a UUID", async () => {
    await refusedEverywhere(damaged(p => { p.record.intent.command_id = "not-a-uuid"; }));
  });
  it("(1) a kind without the user's input names a payload", async () => {
    await refusedEverywhere(damaged(p => { p.record.intent.kind = "session.stop"; }));
  });
  it("(1) a service ID of the record is damaged (the owner's validator decides)", async () => {
    await refusedEverywhere(damaged(p => { p.record.intent.session_id = "bad"; }));
    await refusedEverywhere(damaged(p => { p.record.clientInstanceId = 7; }));
    await refusedEverywhere(damaged(p => { p.record.extra = true; }));
  });
  it("(1) the text is in the pointer itself", async () => {
    await refusedEverywhere(damaged(p => { p.record.intent.payload = { text: "Haus" }; }));
  });
  it("(2) the payload key names the payload of Y — present: neither read nor removed", async () => {
    const theirs = payloadKeyOf(BASE, Y, id(100));
    const t = damaged(p => { p.payloadKey = theirs; }, { [theirs]: JSON.stringify({ text: "Y" }) });
    await refusedEverywhere(t);
    expect(t.values.get(theirs)).toBe(JSON.stringify({ text: "Y" }));
  });
  it("(2) the payload key of another command or kind, or one absent: invalid, not lost", async () => {
    await refusedEverywhere(damaged(p => { p.payloadKey = payloadKeyOf(BASE, X, id(101)); }));
    await refusedEverywhere(damaged(p => { p.payloadKey = payloadKeyOf(FB, X, id(100)); }));
    await refusedEverywhere(damaged(p => { p.payloadKey = "wortly.payload.learning_session"; }));
  });
  it("(3) a valid pointer whose own payload is gone: the LostEnvelope of the old ID, canonical, nothing written", async () => {
    const t = damaged(() => undefined);
    const slot = new LearningSessionPendingStore(t.store);
    const lost = (await slot.loadLost(X, signal()))!;
    expect(lost).toMatchObject({ profileId: X, commandId: id(100), kind: "answer.submit" });
    const pointer = JSON.parse(encodePending(BASE, answer(X) as never).pointer);
    expect(lost.record).toEqual(pointer.record);
    expect(t.log).toEqual([]);
    expect(t.reads).toEqual([pointerKeyOf(BASE, X), payloadKeyOf(BASE, X, id(100))]);
  });
  it("(4) damage is never «repaired» and nothing of the record reaches the journal or console", async () => {
    const events: unknown[] = [];
    installClientJournal({ record: (event: unknown) => events.push(event) } as unknown as ClientJournal);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const t = damaged(p => { p.record.intent.session_id = "Geheim"; });
    await expect(new LearningSessionPendingStore(t.store).load(X, signal())).rejects.toMatchObject({ kind: "invalid" });
    expect(JSON.stringify(events)).not.toContain("Geheim");
    expect(events).toEqual([{ ev: "c.storage", kind: "storage_read" }]);
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.parse(t.values.get(pointerKeyOf(BASE, X))!).record.intent.session_id).toBe("Geheim"); // not rewritten
  });
});

describe("C466: the whole answer is content — a «Забыл» is kept apart as well, never in the pointer", () => {
  const forgot = (profileId: string, n = 100): LearningSessionPending => ({ schemaVersion: 1, profileId, clientInstanceId: id(1),
    pair: "ru-de", intent: { kind: "answer.submit", session_id: id(3), assignment_id: id(6), payload: { forgot: true }, command_id: id(n) } } as LearningSessionPending);

  it("answer.submit{forgot}: the payload holds {forgot:true}, the pointer only service data", async () => {
    const t = storage();
    await new LearningSessionPendingStore(t.store).save(forgot(X), signal());
    const payloadKey = payloadKeyOf(BASE, X, id(100));
    expect(JSON.parse(t.values.get(payloadKey)!)).toEqual({ forgot: true });
    const pointer = JSON.parse(t.values.get(pointerKeyOf(BASE, X))!);
    expect(pointer.record.intent.payload).toEqual({});
    expect(t.values.get(pointerKeyOf(BASE, X))).not.toContain("forgot");
    expect(await new LearningSessionPendingStore(t.store).load(X, signal())).toEqual(forgot(X));
  });

  it("Е02 of an unconfirmed «Забыл» of X: the service IDs stay, the answer is gone — lost_envelope of the old ID, nothing recreated", async () => {
    const t = storage();
    const slot = new LearningSessionPendingStore(t.store);
    await slot.save(forgot(X), signal());
    expect(await dropForeignPayloads(t.store, Y)).toEqual({ removed: 1, failed: 0 }); // Y admitted on this device
    const pointer = JSON.parse(t.values.get(pointerKeyOf(BASE, X))!);
    expect(pointer.record).toMatchObject({ profileId: X, clientInstanceId: id(1), intent: { command_id: id(100), session_id: id(3), assignment_id: id(6) } });
    t.log.length = 0;
    // The return of X: the answer is not available for a resend — only the old ID for the status check (Q27).
    const error = await slot.load(X, signal()).catch((e: unknown) => e) as PendingStoreError;
    expect(error.kind).toBe("lost_envelope");
    expect(error.lost).toMatchObject({ commandId: id(100), kind: "answer.submit" });
    expect((error.lost!.record.intent as { payload: object }).payload).toEqual({});
    await expect(slot.save(forgot(X), signal())).rejects.toMatchObject({ kind: "lost_envelope" });
    await expect(slot.save(answer(X), signal())).rejects.toMatchObject({ kind: "lost_envelope" });
    expect(t.log).toEqual([]); // the payload is not recreated, no new pointer
  });

  it("a pointer that still carries the answer itself (an earlier format or damage) is invalid, never a full record to resend", async () => {
    const pointer = JSON.parse(encodePending(BASE, forgot(X) as never).pointer);
    pointer.record.intent.payload = { forgot: true };
    const t = storage({ [pointerKeyOf(BASE, X)]: JSON.stringify(pointer) });
    await expect(new LearningSessionPendingStore(t.store).load(X, signal())).rejects.toMatchObject({ kind: "invalid" });
    delete pointer.payloadKey;
    const u = storage({ [pointerKeyOf(BASE, X)]: JSON.stringify(pointer) });
    await expect(new LearningSessionPendingStore(u.store).load(X, signal())).rejects.toMatchObject({ kind: "invalid" });
    expect([...t.log, ...u.log]).toEqual([]);
  });

  it("a payload with a service field or a key of the pointer is invalid", async () => {
    const encoded = encodePending("wortly.pending.feedback", { schemaVersion: 1, profileId: X,
      intent: { command_id: id(300), kind: "feedback.send", payload: { text: "falsch", card_id: id(7) } } } as never);
    const t = storage({ [encoded.pointerKey]: encoded.pointer, [encoded.payloadKey!]: JSON.stringify({ text: "falsch", card_id: id(8) }) });
    await expect(new FeedbackPendingStore(t.store).load(X, signal())).rejects.toMatchObject({ kind: "invalid" });
  });
});

describe("C467: raw pointer and payload, hand-written — not through the encoder or the seed", () => {
  afterEach(() => { installClientJournal(null); vi.restoreAllMocks(); });
  const ORAL = "wortly.pending.oral_session";
  const lane = (profileId: string, intent: Record<string, unknown>) => ({ schemaVersion: 1, profileId, clientInstanceId: id(1), pair: "ru-de", intent });
  const oralGrade = (correct: boolean) => lane(X, { command_id: id(400), session_id: id(3), kind: "oral.grade", assignment_id: id(6), payload: { correct } });
  const grade = (value: number) => lane(X, { command_id: id(500), session_id: id(3), assignment_id: id(6), result_id: id(8),
    expected_result_version: "2", kind: "result.grade", payload: { grade: value } });
  const raw = (t: ReturnType<typeof storage>, key: string) => JSON.parse(t.values.get(key)!);

  it("answer.submit text and «Забыл»: the pointer holds only service data, the payload the whole answer", async () => {
    const t = storage();
    await new LearningSessionPendingStore(t.store).save(answer(X), signal());
    expect(raw(t, "wortly.pending.learning_session:profile:" + X)).toEqual({ schemaVersion: 2,
      payloadKey: `wortly.payload.learning_session:${X}:${id(100)}`,
      record: { schemaVersion: 1, profileId: X, clientInstanceId: id(1), pair: "ru-de",
        intent: { kind: "answer.submit", command_id: id(100), session_id: id(3), assignment_id: id(6), payload: {} } } });
    expect(t.values.get(`wortly.payload.learning_session:${X}:${id(100)}`)).toBe('{"text":"Haus"}');
    const u = storage();
    const forgot = { ...answer(X), intent: { ...answer(X).intent, payload: { forgot: true } } } as LearningSessionPending;
    await new LearningSessionPendingStore(u.store).save(forgot, signal());
    expect(u.values.get(`wortly.payload.learning_session:${X}:${id(100)}`)).toBe('{"forgot":true}');
    expect(raw(u, "wortly.pending.learning_session:profile:" + X).record.intent.payload).toEqual({});
  });

  it("oral.grade {correct:false} and result.grade: the value is content — false and a number go to the payload", async () => {
    const t = storage();
    await new OralSessionPendingStore(t.store).save(oralGrade(false) as never, signal());
    expect(t.values.get(`wortly.payload.oral_session:${X}:${id(400)}`)).toBe('{"correct":false}');
    expect(raw(t, `${ORAL}:profile:${X}`)).toEqual({ schemaVersion: 2, payloadKey: `wortly.payload.oral_session:${X}:${id(400)}`,
      record: { ...oralGrade(false), intent: { ...oralGrade(false).intent, payload: {} } } });
    expect(t.values.get(`${ORAL}:profile:${X}`)).not.toContain("correct");
    const u = storage();
    await new LearningSessionPendingStore(u.store).save(grade(4) as never, signal());
    expect(u.values.get(`wortly.payload.learning_session:${X}:${id(500)}`)).toBe('{"grade":4}');
    expect(u.values.get("wortly.pending.learning_session:profile:" + X)).not.toContain("grade\":");
  });

  it("an empty body stays empty: present, reveal, correct and stop have no payload key", async () => {
    const t = storage();
    const present = lane(X, { command_id: id(401), session_id: id(3), kind: "oral.reveal", assignment_id: id(6), payload: {} });
    await new OralSessionPendingStore(t.store).save(present as never, signal());
    expect([...t.values.keys()]).toEqual([`${ORAL}:profile:${X}`]);
    expect(raw(t, `${ORAL}:profile:${X}`)).toEqual({ schemaVersion: 2, record: present });
    const u = storage();
    const correct = lane(X, { command_id: id(501), session_id: id(3), assignment_id: id(6), result_id: id(8),
      expected_result_version: "2", kind: "result.correct", payload: {} });
    await new LearningSessionPendingStore(u.store).save(correct as never, signal());
    expect([...u.values.keys()]).toEqual(["wortly.pending.learning_session:profile:" + X]);
  });

  it("a hand-written valid pointer and payload load to exactly the record", async () => {
    const t = storage({
      [`${ORAL}:profile:${X}`]: JSON.stringify({ schemaVersion: 2, payloadKey: `wortly.payload.oral_session:${X}:${id(400)}`,
        record: { pair: "ru-de", intent: { payload: {}, assignment_id: id(6), kind: "oral.grade", session_id: id(3), command_id: id(400) },
          clientInstanceId: id(1), profileId: X, schemaVersion: 1 } }),
      [`wortly.payload.oral_session:${X}:${id(400)}`]: '{"correct":false}',
    });
    expect(await new OralSessionPendingStore(t.store).load(X, signal())).toEqual(oralGrade(false));
  });

  it("hand-written damage: content in the pointer (false, 0, a text), an extra field, another key — invalid", async () => {
    const pointerOf = (record: unknown, payloadKey?: string) => JSON.stringify({ schemaVersion: 2, record, ...(payloadKey ? { payloadKey } : {}) });
    const cases: Array<[string, Record<string, string>]> = [
      ["correct:false in the pointer", { [`${ORAL}:profile:${X}`]: pointerOf(oralGrade(false)) }],
      ["correct:false next to its payload key", { [`${ORAL}:profile:${X}`]: pointerOf(oralGrade(false), `wortly.payload.oral_session:${X}:${id(400)}`) }],
      ["an extra service field", { [`${ORAL}:profile:${X}`]: pointerOf({ ...oralGrade(false), intent: { ...oralGrade(false).intent, payload: {}, extra: 1 } },
        `wortly.payload.oral_session:${X}:${id(400)}`) }],
      ["the payload of Y", { [`${ORAL}:profile:${X}`]: pointerOf({ ...oralGrade(false), intent: { ...oralGrade(false).intent, payload: {} } },
        `wortly.payload.oral_session:${Y}:${id(400)}`), [`wortly.payload.oral_session:${Y}:${id(400)}`]: '{"correct":true}' }],
      ["a payload with a service field", { [`${ORAL}:profile:${X}`]: pointerOf({ ...oralGrade(false), intent: { ...oralGrade(false).intent, payload: {} } },
        `wortly.payload.oral_session:${X}:${id(400)}`), [`wortly.payload.oral_session:${X}:${id(400)}`]: `{"correct":true,"assignment_id":"${id(6)}"}` }],
    ];
    for (const [name, initial] of cases) {
      const t = storage(initial);
      const error = await new OralSessionPendingStore(t.store).load(X, signal()).then(() => null, (e: unknown) => e) as PendingStoreError | null;
      expect([name, error?.kind]).toEqual([name, "invalid"]);
      expect(error!.lost).toBeUndefined();
      expect(t.log).toEqual([]);
    }
    const g = storage({ ["wortly.pending.learning_session:profile:" + X]: pointerOf(grade(0)) });
    await expect(new LearningSessionPendingStore(g.store).load(X, signal())).rejects.toMatchObject({ kind: "invalid" });
  });

  it("the probe never leaks: a lost grade, self-assessment or answer — no content, no probe anywhere", async () => {
    const events: unknown[] = [];
    installClientJournal({ record: (event: unknown) => events.push(event) } as unknown as ClientJournal);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const service = (record: ReturnType<typeof lane>) => ({ ...record, intent: { ...record.intent, payload: {} } });
    const lostOf = async (store: { load(p: string, s: AbortSignal): Promise<unknown> }, t: ReturnType<typeof storage>) => {
      const error = await store.load(X, signal()).then(() => null, (e: unknown) => e) as PendingStoreError;
      expect(error.kind).toBe("lost_envelope");
      expect(t.log).toEqual([]);
      return error.lost!;
    };
    const o = storage({ [`${ORAL}:profile:${X}`]: JSON.stringify({ schemaVersion: 2, record: service(oralGrade(false)),
      payloadKey: `wortly.payload.oral_session:${X}:${id(400)}` }) });
    const oral = await lostOf(new OralSessionPendingStore(o.store), o);
    expect(oral).toEqual({ profileId: X, commandId: id(400), kind: "oral.grade", record: service(oralGrade(false)) });
    const r = storage({ ["wortly.pending.learning_session:profile:" + X]: JSON.stringify({ schemaVersion: 2, record: service(grade(4)),
      payloadKey: `wortly.payload.learning_session:${X}:${id(500)}` }) });
    const graded = await lostOf(new LearningSessionPendingStore(r.store), r);
    expect(graded.record).toEqual(service(grade(4)));
    const a = storage({ ["wortly.pending.learning_session:profile:" + X]: JSON.stringify({ schemaVersion: 2,
      record: service(answer(X) as never), payloadKey: `wortly.payload.learning_session:${X}:${id(100)}` }) });
    const answered = await lostOf(new LearningSessionPendingStore(a.store), a);
    for (const lost of [oral, graded, answered]) {
      const json = JSON.stringify(lost);
      expect(json).not.toContain("probe");
      expect(json).not.toMatch(/"(text|correct|grade|forgot)"/);
    }
    expect(JSON.stringify(events)).not.toMatch(/probe|correct|grade/);
    expect(warn).not.toHaveBeenCalled();
    // A load after the loss still offers nothing to send: no pending with a probe.
    await expect(new LearningSessionPendingStore(a.store).save(answer(X), signal())).rejects.toMatchObject({ kind: "lost_envelope" });
    expect(a.log).toEqual([]);
  });
});
