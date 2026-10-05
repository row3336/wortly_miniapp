import { describe, expect, it, vi } from "vitest";
import type { EntryApi } from "../api/entryApi";
import { ApiError } from "../api/http";
import type { Profile, SessionStopRemoteCommand } from "../api/generated";
import type { AsyncStorage } from "../platform/storage";
import type { RemoteSessionApi, RemoteStopReply, RemoteStopStatus } from "../study/remoteSessionApi";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import { EntryController, type EntrySnapshot } from "./entryController";
import type { TodayApi } from "../today/todayApi";
import { ClosedAccessError } from "./openedAccess";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const profile = (version = "1"): Profile => ({ profile_id: id(1), role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version: version,
  access: { status: "admitted", version: "1", reason: null } });
function accepted(command: SessionStopRemoteCommand): RemoteStopReply {
  return { outcome: "accepted", state_version: "3", command: { id: command.command_id, kind: command.kind,
    status: "applied", applied_at: "2026-09-30T12:00:00Z", target_id: command.session_id,
    action_id: null, result_id: null, context_id: null, object_version: null },
  current: { session_id: command.session_id, status: "closed", close_reason: "remote_stop" } };
}
function fixture() {
  let nextId = 10;
  const state = { busy: true, target: id(50), version: "2" };
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }),
    remove: vi.fn(async key => { values.delete(key); }) };
  const api: EntryApi = {
    auth: vi.fn(async () => ({ access_token: "synthetic-token", expires_at: "2026-10-01T00:00:00Z",
      profile: profile(), compatibility: { compatible: true, contract_version: "1" } })),
    register: vi.fn<EntryApi["register"]>(async (_token, request) => ({ status: "registered", client_instance_id: request.client_instance_id,
      origin_proof: "synthetic-proof", proof_version: "1", activated: false })),
    open: vi.fn<EntryApi["open"]>(async (_token, _proof, request) => state.busy
      ? { status: "SESSION_BUSY", profile: profile(state.version), compatibility: { compatible: true, contract_version: "1" },
        session: { status: "busy", stop_remote_target: state.target } }
      : { status: "opened", profile: profile(state.version), compatibility: { compatible: true, contract_version: "1" },
        client_instance_id: request.client_instance_id, document_id: request.document_id,
        document_epoch: "1", proof_version: "1", session: null }),
    reapply: vi.fn(),
  };
  const remoteApi: RemoteSessionApi = {
    stop: vi.fn(async (_token, _proof, command) => { state.busy = false; state.version = "3"; return accepted(command); }),
    status: vi.fn(async (_token, _proof, command): Promise<RemoteStopStatus> => {
      const result = accepted(command);
      if (result.outcome !== "accepted") throw new Error();
      return { ...result, command: { ...result.command, status: "already_applied" } };
    }),
  };
  const pendingStore = new RemoteStopPendingStore(storage);
  const updates: EntrySnapshot[] = [];
  const release = vi.fn();
  const todayApi: TodayApi = { get: vi.fn() };
  const make = () => new EntryController({ api, today: todayApi, remote: { api: remoteApi, pendingStore }, storage,
    lock: { acquire: vi.fn(async () => ({ release })) }, initData: "synthetic-init", savedLanguage: "ru", browserLanguage: "ru",
    clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC", newId: () => id(nextId++),
    onUpdate: snapshot => updates.push(snapshot) });
  return { controller: make(), make, api, todayApi, remoteApi, state, storage, values, updates, release,
    latest: () => updates.at(-1)!.state };
}

describe("Entry remote confirmation integration", () => {
  it("busy reads never grant opened access and confirmation/cancel replaces the old read handle", async () => {
    const f = fixture(); await f.controller.start();
    const original = f.controller.getBusyAccess()!;
    expect(original.isLive()).toBe(true); expect(f.controller.getOpenedAccess()).toBeNull();
    f.controller.requestRemoteStop();
    expect(original.isLive()).toBe(false); expect(f.controller.getBusyAccess()).toBeNull();
    f.controller.cancelRemoteStop();
    expect(f.controller.getBusyAccess()!.key).not.toBe(original.key);
    await expect(original.readToday()).rejects.toBeInstanceOf(ClosedAccessError);
    expect(f.todayApi.get).not.toHaveBeenCalled(); expect(f.api.open).toHaveBeenCalledOnce();
    f.controller.dispose(); expect(f.controller.getBusyAccess()).toBeNull();
  });

  it("foreground rechecks occupancy, then replaces aggregate access or enters an empty document", async () => {
    const f = fixture(); await f.controller.start();
    const first = f.controller.getBusyAccess()!;
    await f.controller.foreground();
    expect(first.isLive()).toBe(false); expect(f.controller.getBusyAccess()!.key).not.toBe(first.key);
    expect(vi.mocked(f.api.open).mock.calls[1][2].event).toBe("foreground");
    f.state.busy = false; await f.controller.foreground();
    expect(f.controller.getBusyAccess()).toBeNull(); expect(f.controller.getOpenedAccess()?.session).toBeNull();
    expect(f.remoteApi.stop).not.toHaveBeenCalled();
  });

  it("a conflicting local document does not receive the remote aggregate capability", async () => {
    const f = fixture();
    vi.mocked(f.api.open).mockResolvedValueOnce({ status: "SESSION_BUSY", profile: profile("2"),
      compatibility: { compatible: true, contract_version: "1" }, session: { status: "busy", stop_remote_target: null } });
    await f.controller.start();
    expect(f.controller.getBusyAccess()).toBeNull(); await f.controller.foreground();
    expect(f.api.open).toHaveBeenCalledOnce();
  });

  it.each([401, 403])("a current aggregate HTTP%s invalidates a concurrent foreground reply", async status => {
    const f = fixture(); await f.controller.start(); const access = f.controller.getBusyAccess()!;
    let finish!: (value: Awaited<ReturnType<EntryApi["open"]>>) => void;
    vi.mocked(f.api.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refresh = f.controller.foreground(); await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(2));
    vi.mocked(f.todayApi.get).mockRejectedValueOnce(new ApiError("http", status));
    await expect(access.readToday()).rejects.toMatchObject({ status });
    finish({ status: "SESSION_BUSY", profile: profile("3"), compatibility: { compatible: true, contract_version: "1" },
      session: { status: "busy", stop_remote_target: id(50) } });
    await refresh;
    expect(f.latest()).toEqual({ kind: status === 401 ? "expired" : "unavailable" });
    expect(f.controller.getBusyAccess()).toBeNull(); expect(f.controller.getOpenedAccess()).toBeNull();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it("cancel does not mutate, while confirmation closes and then separately opens", async () => {
    const f = fixture(); await f.controller.start();
    expect(f.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    f.controller.requestRemoteStop(); expect(f.latest()).toEqual({ kind: "remote_confirm", targetId: id(50) });
    f.controller.cancelRemoteStop();
    expect(f.remoteApi.stop).not.toHaveBeenCalled();
    expect(f.values.has("wortly.pending.remote_stop")).toBe(false);
    await f.controller.confirmRemoteStop(); expect(f.remoteApi.stop).not.toHaveBeenCalled();
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
    expect(f.api.open).toHaveBeenCalledTimes(2);
    expect(f.latest()).toEqual({ kind: "opened" });
    expect(f.controller.getOpenedAccess()).not.toBeNull();
    expect(f.values.has("wortly.pending.remote_stop")).toBe(false);
    expect(JSON.stringify(f.updates)).not.toMatch(/synthetic-token|synthetic-proof/);
  });

  it("retains an unknown command on reload and checks its original ID before opening", async () => {
    const f = fixture(); await f.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async () => {
      f.state.busy = false; f.state.version = "3";
      throw new ApiError("network");
    });
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    expect(f.latest()).toMatchObject({ kind: "remote", remote: { pending: true, canRetry: true } });
    const original = vi.mocked(f.remoteApi.stop).mock.calls[0][2];
    f.controller.dispose(); const next = f.make();
    await next.start();
    expect(f.remoteApi.stop).toHaveBeenCalledOnce(); expect(f.remoteApi.status).toHaveBeenCalledOnce();
    const checked = vi.mocked(f.remoteApi.status).mock.calls[0][2];
    expect(checked.command_id).toBe(original.command_id); expect(checked.session_id).toBe(id(50));
    expect(checked.document_id).not.toBe(original.document_id);
    expect(f.latest()).toEqual({ kind: "opened" });
  });

  it("not-found checks do not resend; explicit retry uses the same ID and target", async () => {
    const f = fixture(); await f.controller.start();
    vi.mocked(f.remoteApi.stop).mockRejectedValueOnce(new ApiError("network"));
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    const original = vi.mocked(f.remoteApi.stop).mock.calls[0][2];
    vi.mocked(f.remoteApi.status).mockResolvedValue({ outcome: "not_found", state_version: "2",
      command: { id: original.command_id, status: "not_found" }, current: profile("2") });
    await f.controller.checkRemoteStop();
    expect(f.remoteApi.stop).toHaveBeenCalledOnce(); expect(f.api.open).toHaveBeenCalledOnce();
    expect(f.latest()).toMatchObject({ kind: "remote", remote: { problem: "not_found", canRetry: true } });
    await f.controller.retryRemoteStop();
    expect(vi.mocked(f.remoteApi.stop).mock.calls[1][2]).toEqual(original);
    expect(f.latest()).toEqual({ kind: "opened" });
  });

  it("a replacement busy session needs a separate explicit confirmation", async () => {
    const f = fixture(); await f.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.target = id(51); f.state.version = "4"; return accepted(command);
    });
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    expect(f.latest()).toEqual({ kind: "busy", remoteTarget: id(51) });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    expect(vi.mocked(f.remoteApi.stop).mock.calls[1][2].session_id).toBe(id(51));
    expect(vi.mocked(f.remoteApi.stop).mock.calls[1][2].command_id)
      .not.toBe(vi.mocked(f.remoteApi.stop).mock.calls[0][2].command_id);
  });

  it("a request kept during a refresh asks nothing when the refresh finds the other session ended", async () => {
    const f = fixture(); await f.controller.start();
    const original = vi.mocked(f.api.open).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.api.open).mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    const refresh = f.controller.foreground();
    await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(2));
    f.controller.requestRemoteStop();
    f.state.busy = false; f.state.version = "3"; release(); await refresh;
    // A send would store its intent first, so let all pending work settle before checking.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.latest()).toEqual({ kind: "opened" });
    expect(f.updates.map(update => update.state.kind)).not.toContain("remote_confirm");
    expect(f.remoteApi.stop).not.toHaveBeenCalled();
  });

  it("a request kept during a refresh does nothing after the document is closed", async () => {
    const f = fixture(); await f.controller.start();
    let finish!: (value: Awaited<ReturnType<EntryApi["open"]>>) => void;
    vi.mocked(f.api.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refresh = f.controller.foreground();
    f.controller.requestRemoteStop();
    await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(2));
    f.controller.dispose(); const length = f.updates.length;
    finish({ status: "SESSION_BUSY", profile: profile("3"), compatibility: { compatible: true, contract_version: "1" },
      session: { status: "busy", stop_remote_target: id(50) } });
    await refresh; await Promise.resolve();
    expect(f.updates).toHaveLength(length);
  });

  it("deduplicates repeated confirm and check clicks while sending", async () => {
    const f = fixture(); await f.controller.start();
    let finish!: (reply: RemoteStopReply) => void;
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    f.controller.requestRemoteStop(); const sending = f.controller.confirmRemoteStop();
    expect(f.controller.confirmRemoteStop()).toBe(sending);
    await vi.waitFor(() => expect(f.remoteApi.stop).toHaveBeenCalledOnce());
    expect(f.controller.checkRemoteStop()).toBe(sending);
    expect(f.controller.retryRemoteStop()).toBe(sending);
    f.state.busy = false; f.state.version = "3";
    finish(accepted(vi.mocked(f.remoteApi.stop).mock.calls[0][2])); await sending;
    expect(f.remoteApi.stop).toHaveBeenCalledOnce(); expect(f.remoteApi.status).not.toHaveBeenCalled();
  });

  it.each([401, 403])("a remote HTTP%s ends access but keeps pending for recovery", async status => {
    const f = fixture(); await f.controller.start();
    vi.mocked(f.remoteApi.stop).mockRejectedValueOnce(new ApiError("http", status));
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    expect(f.latest()).toEqual({ kind: status === 401 ? "expired" : "unavailable" });
    expect(f.controller.getOpenedAccess()).toBeNull(); expect(f.release).toHaveBeenCalledOnce();
    expect(f.values.has("wortly.pending.remote_stop")).toBe(true);
  });

  it("a stale open reply after confirmation cannot admit the application", async () => {
    const f = fixture(); await f.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.busy = false; return accepted(command); // Keep open's profile version older than the command's.
    });
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    expect(f.latest()).toEqual({ kind: "unavailable" });
    expect(f.controller.getOpenedAccess()).toBeNull();
  });

  it("retries a failed open after a settled command without rejecting the cached profile or resending", async () => {
    const f = fixture(); await f.controller.start();
    vi.mocked(f.api.open).mockRejectedValueOnce(new ApiError("network"));
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    expect(f.latest()).toEqual({ kind: "unavailable" });
    expect(f.values.has("wortly.pending.remote_stop")).toBe(false);
    await f.controller.retry();
    expect(f.latest()).toEqual({ kind: "opened" });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
    expect(f.api.auth).toHaveBeenCalledOnce(); expect(f.api.open).toHaveBeenCalledTimes(3);
  });

  it("disposal while recovering cannot open the app or clear the old intent", async () => {
    const f = fixture(); await f.controller.start();
    vi.mocked(f.remoteApi.stop).mockRejectedValueOnce(new ApiError("network"));
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    let finish!: (reply: RemoteStopStatus) => void;
    vi.mocked(f.remoteApi.status).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const checking = f.controller.checkRemoteStop();
    await vi.waitFor(() => expect(f.remoteApi.status).toHaveBeenCalledOnce());
    const old = vi.mocked(f.remoteApi.status).mock.calls[0][2];
    const result = accepted(old); if (result.outcome !== "accepted") throw new Error();
    f.controller.dispose(); const length = f.updates.length;
    finish({ ...result, command: { ...result.command, status: "already_applied" } }); await checking;
    expect(f.updates).toHaveLength(length); expect(f.api.open).toHaveBeenCalledOnce();
    expect(f.values.has("wortly.pending.remote_stop")).toBe(true);
  });
});
