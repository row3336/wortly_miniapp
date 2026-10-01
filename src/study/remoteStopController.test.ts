import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { AsyncStorage } from "../platform/storage";
import type { RemoteStopReply, RemoteStopStatus } from "./remoteSessionApi";
import { RemoteStopPendingStore, type RemoteStopPending } from "./remoteStopPending";
import { RemoteStopController, type RemoteStopSnapshot } from "./remoteStopController";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const pending = (): RemoteStopPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2),
  intent: { command_id: id(3), kind: "session.stop_remote", session_id: id(4), payload: { confirmed: true } } });
const accepted = (): RemoteStopReply => ({ outcome: "accepted", state_version: "8",
  command: { id: id(3), kind: "session.stop_remote", status: "applied", applied_at: "2026-09-30T12:00:00Z",
    target_id: id(4), action_id: null, result_id: null, context_id: null, object_version: null },
  current: { session_id: id(4), status: "closed", close_reason: "remote_stop" } });
function recovered(): RemoteStopStatus {
  const value = accepted();
  if (value.outcome !== "accepted") throw new Error();
  return { ...value, command: { ...value.command, status: "already_applied" } };
}
const notFound = (): RemoteStopStatus => ({ outcome: "not_found", state_version: "8",
  command: { id: id(3), status: "not_found" }, current: { profile_id: id(1), access: {
    status: "admitted", version: "1", reason: null }, role: "user", ui_language: "ru",
    dictionary_language: "ru", time_zone: "UTC", state_version: "8" } });

function fixture(raw?: RemoteStopPending) {
  const values = new Map<string, string>();
  if (raw) values.set("wortly.pending.remote_stop", JSON.stringify(raw));
  const storage: AsyncStorage = {
    get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
    remove: vi.fn(async key => { values.delete(key); }),
  };
  const pendingStore = new RemoteStopPendingStore(storage);
  const send = vi.fn(async (): Promise<RemoteStopReply> => accepted());
  const check = vi.fn(async (): Promise<RemoteStopStatus> => recovered());
  const updates: RemoteStopSnapshot[] = [];
  const newId = vi.fn(() => id(3));
  const make = (clientInstanceId = id(2)) => new RemoteStopController({ profileId: id(1), clientInstanceId,
    pendingStore, send, check, newId, onUpdate: snapshot => updates.push(snapshot) });
  return { controller: make(), make, send, check, storage, pendingStore, values, updates, newId };
}

describe("remote stop confirmation and recovery", () => {
  it("does not send on opening or before loading pending state", async () => {
    const f = fixture();
    await f.controller.confirm(id(4)); expect(f.newId).not.toHaveBeenCalled();
    await f.controller.refresh();
    expect(f.controller.snapshot().phase).toBe("idle");
    expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
  });

  it("persists the exact confirmation before one POST and clears only after acceptance", async () => {
    const f = fixture(); await f.controller.refresh();
    let finish!: (reply: RemoteStopReply) => void;
    f.send.mockImplementationOnce(async () => {
      expect(JSON.parse(f.values.get("wortly.pending.remote_stop")!)).toEqual(pending());
      return new Promise(resolve => { finish = resolve; });
    });
    const sending = f.controller.confirm(id(4));
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.controller.snapshot()).toMatchObject({ phase: "sending", pending: true, outcome: null, canRetry: false });
    expect(f.controller.confirm(id(99))).toBe(sending);
    finish(accepted()); await sending;
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", pending: false, outcome: "accepted" });
    expect(f.values.size).toBe(0);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", pending: false, outcome: "accepted" });
    expect(f.check).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
  });

  it("keeps network loss unresolved and performs status-only recovery", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockRejectedValueOnce(new ApiError("network"));
    await f.controller.confirm(id(4));
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", problem: "network", canRetry: true });
    f.controller.dispose(); const next = f.make();
    await next.refresh();
    expect(f.send).toHaveBeenCalledOnce(); expect(f.check).toHaveBeenCalledExactlyOnceWith(pending().intent);
    expect(next.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted", pending: false });
  });

  it("not-found permits only an explicit exact retry", async () => {
    const f = fixture(pending()); f.check.mockResolvedValue(notFound());
    await f.controller.refresh();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ problem: "not_found", canRetry: true });
    await f.controller.confirm(id(99)); expect(f.send).not.toHaveBeenCalled();
    await f.controller.retry();
    expect(f.send).toHaveBeenCalledExactlyOnceWith(pending().intent);
    expect(f.newId).not.toHaveBeenCalled();
  });

  it("does not send when durable save fails", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("synthetic write failure"));
    await f.controller.confirm(id(4));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ problem: "storage", pending: true, canRetry: true });
    await f.controller.retry(); expect(f.send).toHaveBeenCalledExactlyOnceWith(pending().intent);
  });

  it.each(["accepted", "rejected"] as const)("cleanup failure after %s cannot permit another POST", async outcome => {
    const f = fixture(); await f.controller.refresh();
    if (outcome === "rejected") f.send.mockResolvedValue({ outcome, command: { id: id(3), status: "rejected" },
      current: { session_id: id(4), status: "closed", close_reason: "midnight" }, state_version: "9",
      error: { code: "SESSION_CLOSED" } });
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    await f.controller.confirm(id(4));
    expect(f.controller.snapshot()).toMatchObject({ outcome, pending: true, problem: "storage", canRetry: false });
    await f.controller.retry(); expect(f.send).toHaveBeenCalledOnce();
    await f.controller.refresh();
    expect(f.check).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ outcome, pending: false, phase: "settled" });
  });

  it.each([401, 403])("blocks retries after an HTTP%s access refusal", async status => {
    const f = fixture(pending()); f.check.mockRejectedValueOnce(new ApiError("http", status));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pending: true, canRetry: false,
      problem: status === 401 ? "expired" : "forbidden" });
    await f.controller.retry(); expect(f.send).not.toHaveBeenCalled();
  });

  it("does not replay an unresolved intent from a different installation", async () => {
    const f = fixture({ ...pending(), clientInstanceId: id(99) }); f.check.mockResolvedValue(notFound());
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: "client_changed", canRetry: false });
    await f.controller.retry(); expect(f.send).not.toHaveBeenCalled();
  });

  it("can resolve an already accepted fact even after installation changed", async () => {
    const f = fixture({ ...pending(), clientInstanceId: id(99) });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "settled", outcome: "accepted" });
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["profile", "access"])("does not retry after not-found with changed %s", async change => {
    const f = fixture(pending()); const reply = notFound();
    if (reply.outcome !== "not_found") throw new Error();
    if (change === "profile") reply.current.profile_id = id(99);
    else reply.current.access.status = "rejected";
    f.check.mockResolvedValue(reply); await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: false,
      problem: change === "profile" ? "profile_changed" : "forbidden" });
  });

  it("retains mismatch across restart and never uses an unrelated fact as confirmation", async () => {
    const f = fixture(); await f.controller.refresh();
    f.send.mockResolvedValue({ outcome: "mismatch", command: { id: id(3), status: "rejected" },
      current: { session_id: id(4), status: "active", close_reason: null }, state_version: "9",
      error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await f.controller.confirm(id(4));
    expect(f.controller.snapshot()).toMatchObject({ problem: "mismatch", canRetry: false });
    f.controller.dispose(); const next = f.make(); await next.refresh(); await next.retry();
    expect(next.snapshot()).toMatchObject({ problem: "mismatch", canRetry: false });
    expect(f.check).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
    expect(JSON.parse(f.values.get("wortly.pending.remote_stop")!).mismatch).toBe(true);
  });

  it("disposal before storage completes prevents POST", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.storage.set).mockImplementationOnce(async () => { f.controller.dispose(); });
    await f.controller.confirm(id(4)); expect(f.send).not.toHaveBeenCalled();
  });

  it("a late accepted reply after disposal cannot clear pending or publish success", async () => {
    const f = fixture(); await f.controller.refresh();
    let finish!: (reply: RemoteStopReply) => void;
    f.send.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const sending = f.controller.confirm(id(4));
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.controller.dispose(); const count = f.updates.length;
    finish(accepted()); await sending;
    expect(f.values.size).toBe(1); expect(f.updates).toHaveLength(count);
  });

  it("bad persisted data blocks commands and is not silently erased", async () => {
    const f = fixture(); f.values.set("wortly.pending.remote_stop", "damaged");
    await f.controller.refresh(); await f.controller.confirm(id(4));
    expect(f.controller.snapshot()).toMatchObject({ phase: "blocked", problem: "invalid_pending", canRetry: false });
    expect(f.send).not.toHaveBeenCalled(); expect(f.check).not.toHaveBeenCalled();
    expect(f.values.get("wortly.pending.remote_stop")).toBe("damaged");
  });
});
