import { describe, expect, it, vi } from "vitest";
import type { AuthResponse, OpenedClient, Profile } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { EntryApi } from "../api/entryApi";
import type { AsyncStorage } from "../platform/storage";
import type { DocumentLock } from "./documentLock";
import { EntryController } from "./entryController";
import { newerVersion } from "./installation";

const profileId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const registrationId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";
const commandId = "55555555-5555-4555-8555-555555555555";

function profile(status: "admitted" | "pending" | "rejected", version = "9007199254740993"): Profile {
  return {
    profile_id: profileId,
    access: { status, version: "3", reason: status === "rejected" ? "Review complete" : null },
    role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null,
    state_version: version,
  };
}

function auth(status: "admitted" | "pending" | "rejected"): AuthResponse {
  return { access_token: "memory-token", expires_at: "2026-10-01T00:00:00Z", profile: profile(status), compatibility: { compatible: true, contract_version: "1" } };
}

function opened(version = "9007199254740994"): OpenedClient {
  return {
    status: "opened", client_instance_id: instanceId, document_id: documentId,
    document_epoch: "1", proof_version: "1", profile: profile("admitted", version),
    session: null, compatibility: { compatible: true, contract_version: "1" },
  };
}

function decided(status: "pending" | "rejected", accessVersion: string, version: string): Profile {
  return { ...profile(status, version),
    access: { status, version: accessVersion, reason: status === "rejected" ? "Second review" : null } };
}

function memoryStorage(): AsyncStorage & { values: Map<string, string>; set: ReturnType<typeof vi.fn> } {
  const values = new Map<string, string>();
  return {
    values,
    async get(key) { return values.get(key) ?? null; },
    set: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    async remove(key) { values.delete(key); },
  };
}

function fixture(status: "admitted" | "pending" | "rejected" = "admitted", onState?: (kind: string) => void) {
  const storage = memoryStorage();
  const states: string[] = [];
  const ids = [instanceId, registrationId, documentId, commandId];
  const api: EntryApi = {
    auth: vi.fn(async () => auth(status)),
    reapply: vi.fn(async (_token, request) => ({
      command: { id: request.command_id, status: "applied" as const, applied_at: "2026-09-29T00:00:00Z", target_id: null, object_version: "4" },
      current: profile("pending", "9007199254740994"),
    })),
    register: vi.fn(async () => ({ client_instance_id: instanceId, status: "registered" as const, origin_proof: "saved-proof", proof_version: "1", activated: false })),
    open: vi.fn(async () => opened()),
  };
  const lock: DocumentLock = { acquire: vi.fn(async () => ({ release: vi.fn() })) };
  const timeZone = vi.fn((): string | null => "Europe/Berlin");
  const controller = new EntryController({
    api, storage, lock, initData: "signed-Telegram-data", savedLanguage: "ru", browserLanguage: "ru-RU",
    clientVersion: "0.0.0", contractVersion: "1", timeZone,
    newId: () => {
      const id = ids.shift();
      if (!id) throw new Error("ID exhausted");
      return id;
    },
    onUpdate: ({ state }) => { states.push(state.kind); onState?.(state.kind); },
  });
  return { controller, api, storage, states, lock, timeZone };
}

/** A new document of the same Mini App: shared server and storage, its own controller. */
function relaunch(api: EntryApi, storage: AsyncStorage, ids: string[]) {
  const states: string[] = [];
  const controller = new EntryController({
    api, storage, lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) },
    initData: "signed", savedLanguage: "ru", browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1",
    timeZone: () => "Europe/Berlin", newId: () => ids.shift()!, onUpdate: ({ state }) => states.push(state.kind),
  });
  return { controller, states };
}

function appliedReapply(current: Profile): EntryApi["reapply"] {
  return async (_token, request) => ({
    command: { id: request.command_id, status: "applied", applied_at: "2026-09-29T00:00:00Z", target_id: null,
      object_version: current.access.version },
    current,
  });
}

describe("entry controller", () => {
  it("does not drop foreground arriving after opened is published but before startup settles", async () => {
    let refresh: Promise<void> | undefined;
    const f = fixture("admitted", kind => {
      if (kind === "opened" && !refresh) refresh = f.controller.foreground();
    });
    await f.controller.start(); await refresh;
    expect(f.api.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.api.open).mock.calls[1][2].event).toBe("foreground");
    expect(f.api.auth).toHaveBeenCalledOnce(); expect(f.api.register).toHaveBeenCalledOnce();
  });

  it("coalesces foreground events at the startup boundary into one refresh", async () => {
    let refresh: Promise<void> | undefined;
    const f = fixture("admitted", kind => {
      if (kind !== "opened" || refresh) return;
      refresh = f.controller.foreground();
      expect(f.controller.foreground()).toBe(refresh);
    });
    await f.controller.start(); await refresh;
    expect(f.api.open).toHaveBeenCalledTimes(2);
  });

  it("does not run a queued foreground after the document closes", async () => {
    let refresh: Promise<void> | undefined;
    const f = fixture("admitted", kind => {
      if (kind !== "opened") return;
      refresh = f.controller.foreground();
      f.controller.dispose();
    });
    await f.controller.start(); await refresh;
    expect(f.api.open).toHaveBeenCalledOnce(); expect(f.controller.getOpenedAccess()).toBeNull();
  });

  it("exposes application access only after a confirmed open and successful local activation", async () => {
    const f = fixture();
    expect(f.controller.getOpenedAccess()).toBeNull();
    let finish!: () => void;
    f.storage.set.mockImplementation(async (key, raw) => {
      if (JSON.parse(raw).activated) await new Promise<void>(resolve => { finish = resolve; });
      f.storage.values.set(key, raw);
    });
    const starting = f.controller.start();
    await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledOnce());
    expect(f.controller.getOpenedAccess()).toBeNull();
    finish(); await starting;
    const access = f.controller.getOpenedAccess();
    expect(access?.profile.profile_id).toBe(profileId);
    expect(access?.document.documentId).toBe(documentId);
    expect(JSON.stringify(access)).not.toMatch(/memory-token|saved-proof/);
  });

  it.each(["pending", "rejected"] as const)("never gives application access to %s", async status => {
    const f = fixture(status); await f.controller.start();
    expect(f.controller.getOpenedAccess()).toBeNull();
  });

  it("does not issue application access for SESSION_BUSY", async () => {
    const f = fixture();
    vi.mocked(f.api.open).mockResolvedValue({ status: "SESSION_BUSY", profile: profile("admitted"),
      compatibility: { compatible: true, contract_version: "1" }, session: { status: "busy" } });
    await f.controller.start();
    expect(f.controller.getOpenedAccess()).toBeNull();
  });

  it("a late old access refusal cannot invalidate a later successful open", async () => {
    const f = fixture(); await f.controller.start();
    const first = f.controller.getOpenedAccess()!;
    let refuse!: (error: Error) => void;
    const pending = first.run(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    await f.controller.retry();
    const second = f.controller.getOpenedAccess()!;
    expect(second).not.toBe(first); expect(second.isLive()).toBe(true);
    refuse(new EntryApiError("http", 401));
    await expect(pending).rejects.toMatchObject({ message: "closed_access" });
    expect(f.controller.getOpenedAccess()).toBe(second);
    expect(f.states.at(-1)).toBe("opened");
  });

  it.each([401, 403])("a current application HTTP %s clears access and releases the document lease", async status => {
    const f = fixture(); await f.controller.start();
    const access = f.controller.getOpenedAccess()!;
    await expect(access.run(async () => { throw new EntryApiError("http", status); })).rejects.toMatchObject({ status });
    expect(f.controller.getOpenedAccess()).toBeNull(); expect(access.isLive()).toBe(false);
    expect(f.states.at(-1)).toBe(status === 401 ? "expired" : "unavailable");
    const lease = await vi.mocked(f.lock.acquire).mock.results[0].value;
    if (typeof lease === "object") expect(lease.release).toHaveBeenCalledOnce();
  });

  it("dispose invalidates any retained application handle", async () => {
    const f = fixture(); await f.controller.start();
    const access = f.controller.getOpenedAccess()!;
    f.controller.dispose();
    expect(f.controller.getOpenedAccess()).toBeNull();
    const action = vi.fn(async () => undefined);
    await expect(access.run(action)).rejects.toMatchObject({ message: "closed_access" });
    expect(action).not.toHaveBeenCalled();
  });

  it("foreground uses the live document and current device zone without reopening the UI", async () => {
    const f = fixture(); await f.controller.start();
    const before = f.controller.getOpenedAccess()!;
    const stateCount = f.states.length;
    f.timeZone.mockReturnValue("Asia/Tokyo");
    const updated = opened("9007199254740995");
    updated.profile.time_zone = "Asia/Tokyo";
    updated.session = { id: commandId, phase: "summary" };
    let finish!: (value: OpenedClient) => void;
    vi.mocked(f.api.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = f.controller.foreground();
    const second = f.controller.foreground();
    expect(second).toBe(first);
    expect(f.controller.getOpenedAccess()).toBe(before);
    expect(f.states.slice(stateCount)).toEqual([]);
    expect(f.api.open).toHaveBeenCalledTimes(2);
    // The takeover needs no lock flag or confirmation (decision 2.3): the refresh names only the document.
    expect(vi.mocked(f.api.open).mock.calls[1]).toEqual(["memory-token", "saved-proof", {
      client_instance_id: instanceId, document_id: documentId, time_zone: "Asia/Tokyo",
      event: "foreground", client_version: "0.0.0", contract_version: "1",
    }]);
    finish(updated); await first;
    const after = f.controller.getOpenedAccess()!;
    expect(after.key).toBe(before.key);
    expect(after).not.toBe(before); expect(before.isLive()).toBe(false);
    expect(after.profile.time_zone).toBe("Asia/Tokyo");
    expect(after.session).toEqual(updated.session);
    expect(f.states.slice(stateCount)).toEqual(["opened"]);
    expect(f.api.auth).toHaveBeenCalledOnce(); expect(f.api.register).toHaveBeenCalledOnce();
    expect(f.lock.acquire).toHaveBeenCalledOnce();
  });

  it.each(["pending", "rejected"] as const)("foreground cannot activate %s access", async status => {
    const f = fixture(status); await f.controller.start(); await f.controller.foreground();
    expect(f.api.open).not.toHaveBeenCalled(); expect(f.api.auth).toHaveBeenCalledOnce();
    expect(f.states.at(-1)).toBe(status);
  });

  it.each(["pending", "rejected"] as const)("a contradictory opened response cannot restore %s access", async status => {
    const f = fixture(); await f.controller.start();
    const access = f.controller.getOpenedAccess()!;
    vi.mocked(f.api.open).mockResolvedValueOnce({ ...opened("9007199254740995"),
      profile: profile(status, "9007199254740995") });
    await f.controller.foreground();
    expect(f.controller.getOpenedAccess()).toBeNull(); expect(access.isLive()).toBe(false);
    expect(f.states.at(-1)).toBe("unavailable");
  });

  it("rejects a stale profile in foreground without replacing the accepted context", async () => {
    const f = fixture(); await f.controller.start();
    const access = f.controller.getOpenedAccess()!;
    vi.mocked(f.api.open).mockResolvedValueOnce(opened("9007199254740993"));
    await f.controller.foreground();
    expect(f.controller.getOpenedAccess()).toBeNull(); expect(access.isLive()).toBe(false);
    expect(f.states.at(-1)).toBe("unavailable");
  });

  it.each([401, 403])("a concurrent HTTP %s denial cannot be undone by a late foreground response", async status => {
    const f = fixture(); await f.controller.start();
    const access = f.controller.getOpenedAccess()!;
    let finish!: (value: OpenedClient) => void;
    vi.mocked(f.api.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const task = f.controller.foreground();
    await expect(access.run(async () => { throw new EntryApiError("http", status); })).rejects.toMatchObject({ status });
    finish(opened("9007199254740995")); await task;
    expect(f.controller.getOpenedAccess()).toBeNull();
    expect(f.states.at(-1)).toBe(status === 401 ? "expired" : "unavailable");
    await f.controller.foreground();
    expect(f.api.open).toHaveBeenCalledTimes(2);
  });

  it("discarded foreground work cannot reactivate a disposed controller", async () => {
    const f = fixture(); await f.controller.start();
    let finish!: (value: OpenedClient) => void;
    vi.mocked(f.api.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const task = f.controller.foreground(); const count = f.states.length;
    f.controller.dispose(); finish(opened("9007199254740995")); await task;
    expect(f.controller.getOpenedAccess()).toBeNull(); expect(f.states).toHaveLength(count);
    await f.controller.foreground(); expect(f.api.open).toHaveBeenCalledTimes(2);
  });

  it("does not guess a zone or read through the old context when device time zone is unavailable", async () => {
    const f = fixture(); await f.controller.start();
    const access = f.controller.getOpenedAccess()!;
    f.timeZone.mockReturnValue(null); await f.controller.foreground();
    expect(f.api.open).toHaveBeenCalledOnce();
    expect(f.states.at(-1)).toBe("unavailable"); expect(access.isLive()).toBe(false);
  });

  it("keeps the same origin on manual retry after an unknown foreground outcome", async () => {
    const f = fixture(); await f.controller.start();
    f.timeZone.mockReturnValue("Asia/Tokyo");
    vi.mocked(f.api.open).mockRejectedValueOnce(new EntryApiError("network"));
    await f.controller.foreground();
    expect(f.states.at(-1)).toBe("unavailable"); expect(f.controller.getOpenedAccess()).toBeNull();
    await f.controller.foreground(); expect(f.api.open).toHaveBeenCalledTimes(2);
    await f.controller.retry();
    expect(f.states.at(-1)).toBe("opened");
    expect(f.api.auth).toHaveBeenCalledOnce(); expect(f.api.register).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.open).mock.calls[2]).toEqual(["memory-token", "saved-proof", {
      ...vi.mocked(f.api.open).mock.calls[1][2], event: "open",
    }]);
  });

  it("does not call auth without signed Telegram init data", async () => {
    const { api, storage, lock } = fixture();
    const states: string[] = [];
    const controller = new EntryController({
      api, storage, lock, initData: null, savedLanguage: null, browserLanguage: "en",
      clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "Europe/Berlin",
      newId: () => instanceId, onUpdate: ({ state }) => states.push(state.kind),
    });
    await controller.start();
    expect(api.auth).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("unavailable");
  });

  it.each([401, 403, 500])("an entry HTTP %s is shown as an expired sign-in only for 401", async status => {
    const f = fixture();
    vi.mocked(f.api.auth).mockRejectedValueOnce(new EntryApiError("http", status));
    await f.controller.start();
    expect(f.states.at(-1)).toBe(status === 401 ? "expired" : "unavailable");
    expect(f.api.register).not.toHaveBeenCalled();
  });

  it.each(["register", "open"] as const)("an HTTP 401 on %s during entry is an expired sign-in, not a retry", async step => {
    const f = fixture();
    vi.mocked(f.api[step]).mockRejectedValueOnce(new EntryApiError("http", 401));
    await f.controller.start();
    expect(f.states.filter(kind => kind === "expired")).toHaveLength(1);
    expect(f.states.at(-1)).toBe("expired");
    await f.controller.foreground();
    expect(f.api.auth).toHaveBeenCalledOnce();
    expect(f.controller.getOpenedAccess()).toBeNull();
  });

  it.each([401, 403])("a reapply HTTP %s leaves the refusal screen without promising a new request", async status => {
    const f = fixture("rejected"); await f.controller.start();
    vi.mocked(f.api.reapply).mockRejectedValueOnce(new EntryApiError("http", status));
    await f.controller.reapply();
    expect(f.states.slice(-2)).toEqual(["reapplying", status === 401 ? "expired" : "unavailable"]);
    expect(f.states).not.toContain("pending");
  });

  it("does not register pending or rejected users", async () => {
    for (const status of ["pending", "rejected"] as const) {
      const { controller, api, states } = fixture(status);
      await controller.start();
      expect(states.at(-1)).toBe(status);
      expect(api.register).not.toHaveBeenCalled();
      expect(api.open).not.toHaveBeenCalled();
    }
  });

  it("reapplies only after an explicit action and repeats the same command ID after an unknown outcome", async () => {
    const { controller, api, states, storage } = fixture("rejected");
    await controller.start();
    vi.mocked(api.reapply).mockRejectedValueOnce(new Error("response lost"));
    await controller.reapply();
    expect(states.at(-1)).toBe("rejected");
    const savedIntent = JSON.parse(storage.values.get(`wortly.reapply:${profileId}`)!);
    expect(savedIntent).toMatchObject({ profileId, expectedAccessVersion: "3" });
    await controller.reapply();
    expect(states.at(-1)).toBe("pending");
    expect(storage.values.has(`wortly.reapply:${profileId}`)).toBe(false);
    expect(vi.mocked(api.reapply).mock.calls[0][1]).toEqual(vi.mocked(api.reapply).mock.calls[1][1]);
    expect(vi.mocked(api.reapply).mock.calls[0][1].command_id).toBe(savedIntent.commandId);
    expect(api.register).not.toHaveBeenCalled();
  });

  it("keeps the unresolved reapply command ID across a new document", async () => {
    const first = fixture("rejected");
    await first.controller.start();
    vi.mocked(first.api.reapply).mockRejectedValueOnce(new Error("response lost"));
    await first.controller.reapply();
    const prior = vi.mocked(first.api.reapply).mock.calls[0][1];
    first.controller.dispose();

    const states: string[] = [];
    const second = new EntryController({
      api: first.api, storage: first.storage, lock: first.lock,
      initData: "signed", savedLanguage: "ru", browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1",
      timeZone: () => "Europe/Berlin", newId: () => { throw new Error("New ID must not be used"); },
      onUpdate: ({ state }) => states.push(state.kind),
    });
    await second.start();
    await second.reapply();
    expect(vi.mocked(first.api.reapply).mock.calls[1][1]).toEqual(prior);
    expect(states.at(-1)).toBe("pending");
  });

  it("sends one new reapply command when a newer refusal has settled the saved one", async () => {
    const first = fixture("rejected"); await first.controller.start();
    vi.mocked(first.api.reapply).mockRejectedValueOnce(new EntryApiError("network"));
    await first.controller.reapply();
    const lost = vi.mocked(first.api.reapply).mock.calls[0][1];
    first.controller.dispose();
    // The lost command was applied, and the owner has refused again: access is now at version 5.
    vi.mocked(first.api.auth).mockResolvedValueOnce({ ...auth("rejected"), profile: decided("rejected", "5", "9007199254740995") });
    vi.mocked(first.api.reapply).mockImplementationOnce(appliedReapply(decided("pending", "6", "9007199254740996")));
    const fresh = "99999999-9999-4999-8999-999999999999";
    const second = relaunch(first.api, first.storage, [fresh]);
    await second.controller.start();
    expect(second.states.at(-1)).toBe("rejected");
    await second.controller.reapply();
    expect(first.api.reapply).toHaveBeenCalledTimes(2);
    expect(vi.mocked(first.api.reapply).mock.calls[1][1]).toEqual({ command_id: fresh, expected_access_version: "5" });
    expect(fresh).not.toBe(lost.command_id);
    expect(second.states.at(-1)).toBe("pending");
    expect(first.storage.values.has(`wortly.reapply:${profileId}`)).toBe(false);
  });

  it("forgets a settled reapply in pending, so a later refusal is answered by one new command", async () => {
    const first = fixture("rejected"); await first.controller.start();
    vi.mocked(first.api.reapply).mockRejectedValueOnce(new EntryApiError("network"));
    await first.controller.reapply();
    const lost = vi.mocked(first.api.reapply).mock.calls[0][1];
    first.controller.dispose();
    vi.mocked(first.api.auth).mockResolvedValueOnce({ ...auth("pending"), profile: decided("pending", "4", "9007199254740994") });
    const waiting = relaunch(first.api, first.storage, []);
    await waiting.controller.start();
    expect(waiting.states.at(-1)).toBe("pending");
    expect(first.storage.values.has(`wortly.reapply:${profileId}`)).toBe(false);
    waiting.controller.dispose();
    vi.mocked(first.api.auth).mockResolvedValueOnce({ ...auth("rejected"), profile: decided("rejected", "5", "9007199254740995") });
    vi.mocked(first.api.reapply).mockImplementationOnce(appliedReapply(decided("pending", "6", "9007199254740996")));
    const fresh = "99999999-9999-4999-8999-999999999999";
    const refused = relaunch(first.api, first.storage, [fresh]);
    await refused.controller.start(); await refused.controller.reapply();
    expect(first.api.reapply).toHaveBeenCalledTimes(2);
    expect(vi.mocked(first.api.reapply).mock.calls[1][1]).toEqual({ command_id: fresh, expected_access_version: "5" });
    expect(fresh).not.toBe(lost.command_id);
    expect(refused.states.at(-1)).toBe("pending");
  });

  it("refreshes access after a confirmed version conflict before allowing a new intent", async () => {
    const { controller, api, storage, states } = fixture("rejected");
    vi.mocked(api.reapply).mockRejectedValueOnce(new EntryApiError("http", 409, "VERSION_CONFLICT"));
    await controller.start();
    await controller.reapply();
    expect(storage.values.has(`wortly.reapply:${profileId}`)).toBe(false);
    expect(states.at(-1)).toBe("unavailable");
    await controller.retry();
    expect(api.auth).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe("unavailable"); // Auth still reports access version 3.
    vi.mocked(api.auth).mockResolvedValueOnce({ ...auth("rejected"), profile: { ...profile("rejected", "9007199254740994"), access: { status: "rejected", version: "4", reason: "Review complete" } } });
    await controller.retry();
    expect(states.at(-1)).toBe("rejected");
    await controller.reapply();
    expect(vi.mocked(api.reapply).mock.calls[0][1].command_id).not.toBe(vi.mocked(api.reapply).mock.calls[1][1].command_id);
    expect(vi.mocked(api.reapply).mock.calls[1][1].expected_access_version).toBe("4");
  });

  it("blocks a confirmed rejected intent while local cleanup still fails", async () => {
    const { controller, api, storage, states } = fixture("rejected");
    vi.mocked(api.reapply).mockRejectedValueOnce(new EntryApiError("http", 409, "VERSION_CONFLICT"));
    storage.remove = vi.fn(async () => { throw new Error("storage denied"); });
    await controller.start();
    await controller.reapply();
    expect(states.at(-1)).toBe("unavailable");
    await controller.reapply();
    expect(api.reapply).toHaveBeenCalledTimes(1);
  });

  it("does not show rejected after reapply committed but local cleanup failed", async () => {
    const { controller, storage, states } = fixture("rejected");
    await controller.start();
    storage.remove = vi.fn(async () => { throw new Error("storage denied"); });
    await controller.reapply();
    expect(states.at(-1)).toBe("unavailable");
    await controller.retry();
    expect(states.at(-1)).toBe("pending");
  });

  it("continues opening when a confirmed reapply finds access already admitted", async () => {
    const { controller, api, states } = fixture("rejected");
    vi.mocked(api.reapply).mockImplementationOnce(async (_token, request) => ({
      command: { id: request.command_id, status: "already_applied", applied_at: "2026-09-29T00:00:00Z", target_id: null, object_version: "4" },
      current: profile("admitted", "9007199254740994"),
    }));
    vi.mocked(api.register).mockImplementationOnce(async (_token, request) => ({
      client_instance_id: request.client_instance_id, status: "registered", origin_proof: "saved-proof", proof_version: "1", activated: false,
    }));
    vi.mocked(api.open).mockImplementationOnce(async (_token, _proof, request) => ({
      ...opened("9007199254740995"), client_instance_id: request.client_instance_id, document_id: request.document_id,
    }));
    await controller.start();
    await controller.reapply();
    expect(states.at(-1)).toBe("opened");
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.open).toHaveBeenCalledTimes(1);
  });

  it("retries a lost register response with the same IDs and auth token", async () => {
    const { controller, api, states, storage } = fixture();
    vi.mocked(api.register).mockImplementationOnce(async (_token, request) => {
      expect(JSON.parse(storage.values.get(`wortly.installation:${profileId}`)!)).toMatchObject({
        clientInstanceId: request.client_instance_id, registrationId: request.registration_id, proof: null,
      });
      throw new Error("response lost");
    });
    await controller.start();
    expect(states.at(-1)).toBe("unavailable");
    expect(api.open).not.toHaveBeenCalled();
    await controller.retry();
    expect(states.at(-1)).toBe("opened");
    expect(api.auth).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.register).mock.calls[0]).toEqual(vi.mocked(api.register).mock.calls[1]);
    expect(JSON.parse(storage.values.get(`wortly.installation:${profileId}`)!)).toMatchObject({ activated: true, proof: "saved-proof" });
  });

  it("stores the proof before open and repeats a lost open with the same document", async () => {
    const { controller, api, storage, states } = fixture();
    vi.mocked(api.open).mockImplementationOnce(async (_token, proof) => {
      const saved = JSON.parse(storage.values.get(`wortly.installation:${profileId}`)!);
      expect(saved).toMatchObject({ clientInstanceId: instanceId, proof, proofVersion: "1", activated: false });
      throw new Error("response lost");
    });
    await controller.start();
    expect(states.at(-1)).toBe("unavailable");
    await controller.retry();
    expect(states.at(-1)).toBe("opened");
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.open).mock.calls[0]).toEqual(vi.mocked(api.open).mock.calls[1]);
  });

  it("retries after a newer busy profile without falling back to stale auth", async () => {
    const { controller, api, states } = fixture();
    vi.mocked(api.open).mockResolvedValueOnce({
      status: "SESSION_BUSY", profile: profile("admitted", "9007199254740994"),
      session: { status: "busy" }, compatibility: { compatible: true, contract_version: "1" },
    });
    await controller.start();
    expect(states.at(-1)).toBe("busy");
    await controller.retry();
    expect(states.at(-1)).toBe("opened");
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it("retries an opened document after storing activation fails", async () => {
    const { controller, api, storage, states } = fixture();
    storage.set.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage denied"));
    await controller.start();
    expect(states.at(-1)).toBe("unavailable");
    await controller.retry();
    expect(states.at(-1)).toBe("opened");
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.open).mock.calls[0]).toEqual(vi.mocked(api.open).mock.calls[1]);
  });

  it("keeps a saved proof after a lost open response and a new auth session", async () => {
    const first = fixture();
    vi.mocked(first.api.open).mockRejectedValueOnce(new EntryApiError("network"));
    await first.controller.start();
    const saved = JSON.parse(first.storage.values.get(`wortly.installation:${profileId}`)!);
    first.controller.dispose();
    const states: string[] = [];
    const second = new EntryController({
      api: first.api, storage: first.storage, lock: first.lock,
      initData: "signed", savedLanguage: null, browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1",
      timeZone: () => "Europe/Berlin", newId: () => "88888888-8888-4888-8888-888888888888",
      onUpdate: ({ state }) => states.push(state.kind),
    });
    vi.mocked(first.api.open).mockResolvedValueOnce({ status: "SESSION_BUSY", profile: profile("admitted", "9007199254740994"), session: { status: "busy" }, compatibility: { compatible: true, contract_version: "1" } });
    await second.start();
    expect(first.api.register).toHaveBeenCalledTimes(1);
    expect(vi.mocked(first.api.open).mock.calls[1][1]).toBe(saved.proof);
    expect(vi.mocked(first.api.open).mock.calls[1][2].client_instance_id).toBe(saved.clientInstanceId);
    expect(states.at(-1)).toBe("busy");
  });

  it("does not send reapply after disposal during intent storage", async () => {
    const { controller, api, storage } = fixture("rejected");
    await controller.start();
    let finish!: () => void;
    storage.set.mockImplementationOnce(async () => new Promise<void>((resolve) => { finish = resolve; }));
    const task = controller.reapply();
    controller.dispose();
    finish();
    await task;
    expect(api.reapply).not.toHaveBeenCalled();
  });

  it("rejects a profile or command that does not belong to this entry", async () => {
    const openedCase = fixture();
    vi.mocked(openedCase.api.open).mockResolvedValueOnce({ ...opened(), profile: { ...profile("admitted", "9007199254740994"), profile_id: "other-profile" } });
    await openedCase.controller.start();
    expect(openedCase.states.at(-1)).toBe("unavailable");

    const reapplyCase = fixture("rejected");
    vi.mocked(reapplyCase.api.reapply).mockResolvedValueOnce({
      command: { id: "other-command", status: "applied", applied_at: "2026-09-29T00:00:00Z", target_id: null, object_version: "4" },
      current: profile("pending", "9007199254740994"),
    });
    await reapplyCase.controller.start();
    await reapplyCase.controller.reapply();
    expect(reapplyCase.states.at(-1)).toBe("unavailable");
    expect(reapplyCase.storage.values.has(`wortly.reapply:${profileId}`)).toBe(true);
  });

  it("expires the token after admitted reapply reaches an open 401; the lock was never taken for a refused document", async () => {
    const { controller, api, lock, states } = fixture("rejected");
    const release = vi.fn();
    vi.mocked(lock.acquire).mockResolvedValue({ release });
    vi.mocked(api.reapply).mockImplementationOnce(async (_token, request) => ({
      command: { id: request.command_id, status: "applied", applied_at: "2026-09-29T00:00:00Z", target_id: null, object_version: "4" },
      current: { ...profile("admitted", "9007199254740994"), access: { status: "admitted", version: "4", reason: null } },
    }));
    vi.mocked(api.register).mockImplementationOnce(async (_token, request) => ({ client_instance_id: request.client_instance_id, status: "registered", origin_proof: "saved-proof", proof_version: "1", activated: false }));
    vi.mocked(api.open).mockRejectedValue(new EntryApiError("http", 401));
    await controller.start();
    await controller.reapply();
    expect(states.at(-1)).toBe("expired");
    expect(lock.acquire).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
    await controller.retry();
    expect(api.auth).toHaveBeenCalledTimes(2);
  });

  it("never registers or opens when saving IDs fails", async () => {
    const { controller, api, storage, states } = fixture();
    storage.set.mockRejectedValueOnce(new Error("storage denied"));
    await controller.start();
    expect(states.at(-1)).toBe("unavailable");
    expect(api.register).not.toHaveBeenCalled();
    expect(api.open).not.toHaveBeenCalled();
  });

  it("never opens when saving the proof fails", async () => {
    const { controller, api, storage, states } = fixture();
    storage.set.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("storage denied"));
    await controller.start();
    expect(states.at(-1)).toBe("unavailable");
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.open).not.toHaveBeenCalled();
  });

  it("does not overwrite a damaged stored installation", async () => {
    const { controller, api, storage, states } = fixture();
    storage.values.set(`wortly.installation:${profileId}`, "{bad-json");
    await controller.start();
    expect(states.at(-1)).toBe("unavailable");
    expect(api.register).not.toHaveBeenCalled();
    expect(storage.values.get(`wortly.installation:${profileId}`)).toBe("{bad-json");
  });

  it("uses new IDs after a new auth session when the old registration was unfinished", async () => {
    const first = fixture();
    vi.mocked(first.api.register).mockRejectedValueOnce(new Error("response lost"));
    await first.controller.start();
    first.controller.dispose();
    const freshInstance = "66666666-6666-4666-8666-666666666666";
    const freshRegistration = "77777777-7777-4777-8777-777777777777";
    const freshApi: EntryApi = {
      auth: vi.fn(async () => auth("admitted")),
      reapply: vi.fn(),
      register: vi.fn(async (_token, request) => ({ client_instance_id: request.client_instance_id, status: "registered" as const, origin_proof: "new-proof", proof_version: "1", activated: false })),
      open: vi.fn(async (_token, _proof, request) => ({ ...opened(), client_instance_id: request.client_instance_id })),
    };
    const ids = [freshInstance, freshRegistration, documentId];
    const second = new EntryController({
      api: freshApi, storage: first.storage, lock: { acquire: async () => "unsupported" },
      initData: "signed", savedLanguage: "ru", browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1",
      timeZone: () => "Europe/Berlin", newId: () => ids.shift()!, onUpdate: () => {},
    });
    await second.start();
    expect(vi.mocked(freshApi.register).mock.calls[0][1]).toEqual({ client_instance_id: freshInstance, registration_id: freshRegistration });
  });

  it("reuses an activated installation without calling register", async () => {
    const { controller, api, storage, states } = fixture();
    storage.values.set(`wortly.installation:${profileId}`, JSON.stringify({
      profileId, clientInstanceId: instanceId, registrationId, proof: "saved-proof", proofVersion: "1", activated: true,
    }));
    vi.mocked(api.open).mockResolvedValueOnce({ status: "SESSION_BUSY", profile: profile("admitted", "9007199254740994"), session: { status: "busy" }, compatibility: { compatible: true, contract_version: "1" } });
    await controller.start();
    expect(states.at(-1)).toBe("busy");
    expect(api.register).not.toHaveBeenCalled();
    expect(vi.mocked(api.open).mock.calls[0][1]).toBe("saved-proof");
  });

  it("does not let an old auth response of a closed document overwrite the newer document's result", async () => {
    const { controller, api, storage, lock, states } = fixture();
    let resolveOld!: (response: AuthResponse) => void;
    vi.mocked(api.auth).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce(auth("pending"));
    const old = controller.start();
    await vi.waitFor(() => expect(api.auth).toHaveBeenCalledOnce());
    controller.dispose(); const closedStates = states.length;
    const fresh = relaunch(api, storage, []);
    await fresh.controller.start();
    expect(fresh.states.at(-1)).toBe("pending");
    resolveOld(auth("admitted"));
    await old;
    expect(states).toHaveLength(closedStates);
    expect(fresh.states.at(-1)).toBe("pending");
    expect(lock.acquire).not.toHaveBeenCalled();
    expect(api.register).not.toHaveBeenCalled();
    expect(storage.values.has(`wortly.installation:${profileId}`)).toBe(false);
  });

  it("does not display an opened client from an older state version", async () => {
    const { controller, api, states } = fixture();
    vi.mocked(api.open).mockResolvedValueOnce(opened("9007199254740992"));
    await controller.start();
    expect(states.at(-1)).toBe("unavailable");
    expect(states).not.toContain("opened");
  });

  it("never waits for the cross-window lock: it opens first and takes the lock of this installation after the answer", async () => {
    const { controller, api, states, lock } = fixture();
    vi.mocked(lock.acquire).mockImplementationOnce(() => new Promise(() => {}));
    await controller.start();
    expect(states.at(-1)).toBe("opened");
    expect(lock.acquire).toHaveBeenCalledOnce();
    expect(vi.mocked(lock.acquire).mock.calls[0][0]).toBe(`${profileId}:${instanceId}`);
    expect(vi.mocked(lock.acquire).mock.invocationCallOrder[0]).toBeGreaterThan(vi.mocked(api.open).mock.invocationCallOrder[0]);
  });

  it("compares large versions without floating-point rounding", () => {
    expect(newerVersion("9007199254740994", "9007199254740993")).toBe(true);
    expect(newerVersion("9007199254740993", "9007199254740994")).toBe(false);
  });
});
