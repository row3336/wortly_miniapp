// 35.1-А (C204/C205): a Learning start record of another page (a full reload, another window) is only checked by its
// ID; a start of this page keeps its explicit retry. The page is a memory-only list, never a fact of a send.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { LearningSessionProjection } from "../api/generated";
import type { AsyncStorage } from "../platform/storage";
import { LearningCommandController } from "./learningCommandController";
import type { LearningSessionRead, LearningSessionReply, LearningSessionStatus } from "./learningSessionApi";
import type { LearningSessionIntent } from "./learningSessionIntent";
import { LearningSessionPendingStore, type LearningSessionPending } from "./learningSessionPending";
import { LearningPageStarts } from "./learningPageStarts";
import { previewContent } from "./learningPreview.test-support";
import { pendingRaw, hasPending, seedRaw } from "../commands/pendingSeed.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slot = "wortly.pending.learning_session";
const start: LearningSessionIntent = { command_id: id(4), session_id: id(3), kind: "session.start", payload: { mode: "learning" } };
const record = (intent: LearningSessionIntent = start, clientInstanceId = id(1)): LearningSessionPending => ({ schemaVersion: 1,
  profileId: id(50), clientInstanceId, pair: "ru-de", intent: structuredClone(intent) });
const preview = (): LearningSessionProjection => ({ session_id: id(3), mode: "learning", status: "active",
  pair: "ru-de", local_date: "2026-09-30", close_reason: null,
  group: { id: id(10), status: "assembling", version: "1", preview_position: 0, total: 2 },
  preview: { id: id(5), card_id: id(11), position: 1, total: 2, content: previewContent(id(11)) }, assignment: null });
const accepted = (): Extract<LearningSessionReply, { outcome: "accepted" }> => ({ outcome: "accepted", state_version: "8",
  current: preview(), command: { id: start.command_id, kind: start.kind, status: "applied", applied_at: "2026-09-30T12:00:00Z",
    target_id: start.session_id, action_id: null, result_id: null, context_id: null, object_version: null } });
const recovered = (): Extract<LearningSessionStatus, { outcome: "accepted" }> => {
  const reply = accepted(); return { ...reply, command: { ...reply.command, status: "already_applied" } };
};
const notFound = (): Extract<LearningSessionStatus, { outcome: "not_found" }> => ({ outcome: "not_found", state_version: "8",
  command: { id: id(4), status: "not_found" }, current: { profile_id: id(50), role: "user", ui_language: "ru",
    dictionary_language: "ru", time_zone: "UTC", state_version: "8", access: { status: "admitted", version: "1", reason: null } } });
const absent = (): LearningSessionRead => ({ current: { session_id: id(3), status: "not_found" }, state_version: "9" });

function fixture(raw?: LearningSessionPending) {
  const values = new Map<string, string>(); if (raw) seedRaw(values, slot, JSON.stringify(raw), id(50));
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  const pendingStore = new LearningSessionPendingStore(storage);
  const send = vi.fn(async (): Promise<LearningSessionReply> => accepted());
  const check = vi.fn(async (): Promise<LearningSessionStatus> => notFound());
  const read = vi.fn(async (): Promise<LearningSessionRead> => absent());
  const newId = vi.fn(() => id(4));
  const make = (page: LearningPageStarts) => new LearningCommandController({ profileId: id(50), clientInstanceId: id(1),
    pair: "ru-de", pendingStore, send, check, read, readResult: async () => { throw new Error("unexpected result read"); },
    newId, isLive: () => true, onUpdate: () => {}, page });
  return { values, storage, send, check, read, newId, make };
}

describe("35.1-А: a Learning start left by another page", () => {
  it("is checked by its ID only: no retry, no POST, no new ID, the record stays after not_found", async () => {
    const f = fixture(record()), controller = f.make(new LearningPageStarts());
    await controller.refresh();
    expect(f.check).toHaveBeenCalledOnce(); expect(f.read).toHaveBeenCalledExactlyOnceWith(id(3));
    expect(controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "not_found", pending: true, outcome: null, canRetry: false });
    await controller.retry(); await controller.resend();
    await controller.refresh();
    expect(f.check).toHaveBeenCalledTimes(2); expect(f.send).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    expect(JSON.parse(pendingRaw(f.values, slot)!)).toEqual(record());
  });

  it("restores the session the check finds, by the same ID and without a POST", async () => {
    const f = fixture(record()); f.check.mockResolvedValue(recovered());
    const controller = f.make(new LearningPageStarts()); await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false, resolved: { commandId: id(4), kind: "session.start" } });
    expect(controller.snapshot().current).toMatchObject({ session_id: id(3), status: "active" });
    expect(f.send).not.toHaveBeenCalled(); expect(hasPending(f.values, slot)).toBe(false);
  });

  it("a start of this page keeps its explicit retry under a new owner of the same page", async () => {
    const page = new LearningPageStarts(), f = fixture();
    const first = f.make(page); await first.refresh();
    f.send.mockRejectedValueOnce(new ApiError("network"));
    await first.start(start); first.dispose();
    expect(JSON.parse(pendingRaw(f.values, slot)!)).toEqual(record());
    const next = f.make(page); await next.refresh();
    expect(next.snapshot()).toMatchObject({ problem: "not_found", canRetry: true });
    await next.retry();
    expect(f.send).toHaveBeenCalledTimes(2); expect(f.send).toHaveBeenLastCalledWith(start);
  });

  it("owns only the exact start: another installation, session or command under the same ID is another page's", () => {
    const page = new LearningPageStarts(); page.mark(record());
    expect(page.owns(record())).toBe(true);
    expect(page.owns(record(start, id(2)))).toBe(false);
    expect(page.owns(record({ ...start, session_id: id(9) }))).toBe(false);
    expect(page.owns(record({ ...start, command_id: id(8) }))).toBe(false);
    // Only starts are marked: the page is no history of other commands.
    const other: LearningSessionIntent = { command_id: id(7), session_id: id(3), kind: "learning.preview_next", preview_id: id(5), payload: {} };
    page.mark(record(other)); expect(page.owns(record(other))).toBe(false);
  });

  it("owns is exact about the profile and the pair too, and ignores the case of the ids", () => {
    const page = new LearningPageStarts(); page.mark(record());
    expect(page.owns({ ...record(), profileId: id(51) })).toBe(false);
    expect(page.owns({ ...record(), pair: "en-de" })).toBe(false);
    const upper = record(); upper.profileId = upper.profileId.toUpperCase(); upper.intent.command_id = upper.intent.command_id.toUpperCase();
    expect(page.owns(upper)).toBe(true);
  });

  it("marks the start before its slot write, and forgets it only once the record of the known outcome is cleared", async () => {
    const page = new LearningPageStarts(), f = fixture();
    let ownedAtWrite: boolean | null = null;
    vi.mocked(f.storage.set).mockImplementationOnce(async (key, value) => { ownedAtWrite = page.owns(record()); f.values.set(key, value); });
    const controller = f.make(page); await controller.refresh();
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("disk"));
    await controller.start(start);
    expect(ownedAtWrite).toBe(true);
    // The server accepted it, but its record could not be cleared: the record and its mark stay together.
    expect(controller.snapshot()).toMatchObject({ outcome: "accepted", pending: true });
    expect(page.owns(record())).toBe(true);
    await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ outcome: "accepted", pending: false });
    expect(page.owns(record())).toBe(false);
  });

  it.each([
    ["release", (c: LearningCommandController, value: string) => c.release(value), start.command_id, id(99)],
    ["releaseClosed", (c: LearningCommandController, value: string) => c.releaseClosed(value), start.session_id, id(98)],
  ] as const)("%s ends the mark only with its cleared record: a failed clear or another target keeps both", async (_name, release, own, other) => {
    const page = new LearningPageStarts(), f = fixture();
    const controller = f.make(page); await controller.refresh();
    f.send.mockRejectedValue(new ApiError("network"));
    await controller.start(start);
    expect(page.owns(record())).toBe(true); expect(hasPending(f.values, slot)).toBe(true);
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("disk"));
    await release(controller, own);
    expect(hasPending(f.values, slot)).toBe(true); expect(page.owns(record())).toBe(true);
    await release(controller, other);
    expect(hasPending(f.values, slot)).toBe(true); expect(page.owns(record())).toBe(true);
    await release(controller, own);
    expect(hasPending(f.values, slot)).toBe(false); expect(page.owns(record())).toBe(false);
  });

  it("33.1-А F6: the found session of an own never sent start clears its record and its mark; a failed clear keeps both", async () => {
    const page = new LearningPageStarts(), f = fixture();
    const controller = f.make(page); await controller.refresh();
    // A send refused before its request: the start is stored, never sent (storedUnsent of this owner).
    f.send.mockRejectedValueOnce(new ApiError("network"));
    await controller.start(start);
    // The same version as the status reply, so the second check is not older than the read before it.
    f.read.mockResolvedValue({ current: preview(), state_version: "8" });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("disk"));
    await controller.refresh();
    expect(hasPending(f.values, slot)).toBe(true); expect(page.owns(record())).toBe(true);
    await controller.refresh();
    expect(hasPending(f.values, slot)).toBe(false); expect(page.owns(record())).toBe(false);
    expect(controller.snapshot()).toMatchObject({ pending: false, phase: "idle" });
    expect(f.send).toHaveBeenCalledOnce();
  });

  it("not_found frees nothing: the mark of this page stays with its unresolved record", async () => {
    const page = new LearningPageStarts(), f = fixture();
    const controller = f.make(page); await controller.refresh();
    f.send.mockRejectedValueOnce(new ApiError("network"));
    await controller.start(start); await controller.refresh();
    expect(controller.snapshot()).toMatchObject({ problem: "not_found", pending: true, canRetry: true });
    expect(page.owns(record())).toBe(true);
  });
});
