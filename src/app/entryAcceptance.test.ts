// Acceptance checks by the independent QA of entry and access (A-QA-E01E03), kept as regression tests:
// controller-level entry, reapply, revocation and remote stop.
import { describe, expect, it, vi } from "vitest";
import type { AuthResponse, OpenedClient, Profile, SessionStopRemoteCommand } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { EntryApi } from "../api/entryApi";
import { ApiError } from "../api/http";
import type { AsyncStorage } from "../platform/storage";
import type { RemoteSessionApi, RemoteStopReply } from "../study/remoteSessionApi";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import type { TodayApi } from "../today/todayApi";
import { EntryController, type EntrySnapshot } from "./entryController";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = id(1);

function memoryStorage(): AsyncStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
}

/** Access part of the core contract (identity/service.py reapply: prior fact → version → status). */
function accessServer() {
  const server = { status: "rejected" as Profile["access"]["status"], version: 3, state: 10,
    reason: "Owner note" as string | null, loseAfterCommit: false, facts: new Map<string, string>() };
  const current = (): Profile => ({ profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru",
    time_zone: null, state_version: String(server.state),
    access: { status: server.status, version: String(server.version), reason: server.status === "rejected" ? server.reason : null } });
  const command = (commandId: string, status: "applied" | "already_applied", version: string) => ({
    id: commandId, status, applied_at: "2026-10-05T12:00:00Z", target_id: PROFILE, object_version: version });
  let token = 0;
  const api: EntryApi = {
    auth: vi.fn(async (): Promise<AuthResponse> => ({ access_token: `token-${++token}`, expires_at: "2026-10-06T00:00:00Z",
      profile: current(), compatibility: { compatible: true, contract_version: "1" } })),
    reapply: vi.fn(async (_token, request) => {
      const prior = server.facts.get(request.command_id);
      if (prior !== undefined) {
        if (prior !== request.expected_access_version) throw new EntryApiError("http", 409, "COMMAND_PAYLOAD_MISMATCH");
        return { command: command(request.command_id, "already_applied", String(Number(prior) + 1)), current: current() };
      }
      if (String(server.version) !== request.expected_access_version) throw new EntryApiError("http", 409, "VERSION_CONFLICT");
      if (server.status !== "rejected") throw new EntryApiError("http", 403, "FORBIDDEN");
      server.status = "pending"; server.version += 1; server.state += 1;
      server.facts.set(request.command_id, request.expected_access_version);
      if (server.loseAfterCommit) { server.loseAfterCommit = false; throw new EntryApiError("network"); }
      return { command: command(request.command_id, "applied", String(server.version)), current: current() };
    }),
    register: vi.fn(async (_token, request) => ({ client_instance_id: request.client_instance_id, status: "registered" as const,
      origin_proof: "proof", proof_version: "1", activated: false })),
    open: vi.fn(async (_token, _proof, request): Promise<OpenedClient> => ({ status: "opened",
      client_instance_id: request.client_instance_id, document_id: request.document_id, document_epoch: "1", proof_version: "1",
      profile: current(), session: null, compatibility: { compatible: true, contract_version: "1" } })),
  };
  const ownerDecides = (approve: boolean) => {
    server.status = approve ? "admitted" : "rejected"; server.version += 1; server.state += 1;
  };
  return { server, api, ownerDecides };
}

// Shared by every launch: like crypto.randomUUID in the app, a relaunch never reuses an earlier ID.
let next = 100;

function launch(api: EntryApi, storage: AsyncStorage, extra: Partial<ConstructorParameters<typeof EntryController>[0]> = {}) {
  const updates: EntrySnapshot[] = [];
  const release = vi.fn();
  const controller = new EntryController({ api, storage, lock: { acquire: vi.fn(async () => ({ release })) },
    initData: "signed", savedLanguage: "ru", browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1",
    timeZone: () => "Europe/Berlin", newId: () => id(next++), onUpdate: snapshot => updates.push(snapshot), ...extra });
  return { controller, updates, release, kinds: () => updates.map(update => update.state.kind),
    latest: () => updates.at(-1)!.state };
}

describe("QA reapply (К02-030…036, Т38)", () => {
  it("a double tap sends one reapply command and shows pending only after commit", async () => {
    const s = accessServer(); const storage = memoryStorage();
    const l = launch(s.api, storage); await l.controller.start();
    expect(l.latest()).toEqual({ kind: "rejected", reason: "Owner note" });
    const first = l.controller.reapply(); const second = l.controller.reapply();
    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(s.api.reapply).toHaveBeenCalledOnce();
    expect(l.latest().kind).toBe("pending");
    expect(l.kinds().slice(-2)).toEqual(["reapplying", "pending"]);
  });

  it("reapply in pending sends nothing (kills mutation M1)", async () => {
    const s = accessServer(); s.server.status = "pending";
    const l = launch(s.api, memoryStorage()); await l.controller.start();
    expect(l.latest().kind).toBe("pending");
    await l.controller.reapply();
    expect(s.api.reapply).not.toHaveBeenCalled(); expect(l.latest().kind).toBe("pending");
  });

  it("a reopen in rejected never reapplies by itself (К02-034)", async () => {
    const s = accessServer(); const storage = memoryStorage();
    const first = launch(s.api, storage); await first.controller.start(); first.controller.dispose();
    const second = launch(s.api, storage); await second.controller.start(); await second.controller.foreground();
    expect(s.api.reapply).not.toHaveBeenCalled(); expect(second.latest().kind).toBe("rejected");
  });

  it("the rejected state carries the owner's reason and no reason for a plain refusal (К02-041/042)", async () => {
    const s = accessServer();
    const a = launch(s.api, memoryStorage()); await a.controller.start();
    expect(a.latest()).toEqual({ kind: "rejected", reason: "Owner note" });
    s.server.reason = null;
    const b = launch(s.api, memoryStorage()); await b.controller.start();
    expect(b.latest()).toEqual({ kind: "rejected" });
  });

  it("Н6: after a lost-but-committed reapply and a new refusal, the first tap returns the request to the owner", async () => {
    const s = accessServer(); const storage = memoryStorage();
    // 1. Tap; the server commits but the reply is lost.
    const first = launch(s.api, storage); await first.controller.start();
    s.server.loseAfterCommit = true; await first.controller.reapply();
    expect(first.latest().kind).toBe("rejected"); // honest: success was not confirmed (К02-036)
    first.controller.dispose();
    // 2. Reopen: the server shows pending. 3. The owner rejects again. 4. Reopen and tap once.
    const second = launch(s.api, storage); await second.controller.start();
    expect(second.latest().kind).toBe("pending"); second.controller.dispose();
    s.ownerDecides(false);
    const third = launch(s.api, storage); await third.controller.start();
    expect(third.latest().kind).toBe("rejected");
    await third.controller.reapply();
    // К02-031: the tap returns the request to the owner; the user sees «Заявка отправлена».
    expect(s.server.status).toBe("pending");
    expect(third.latest().kind).toBe("pending");
  });
});

describe("QA revocation (К02-047, Т38)", () => {
  function opened() {
    const s = accessServer(); s.server.status = "admitted";
    const storage = memoryStorage(); const l = launch(s.api, storage);
    return { s, storage, l };
  }

  it("a revocation during an in-flight study command ends the document once; the late success is not delivered", async () => {
    const { s, l } = opened(); await l.controller.start();
    const access = l.controller.getOpenedAccess()!;
    let finish!: (value: string) => void;
    const command = access.run(() => new Promise<string>(resolve => { finish = resolve; }));
    await expect(access.run(async () => { throw new ApiError("http", 401, "AUTH_INVALID"); })).rejects.toMatchObject({ status: 401 });
    expect(l.latest()).toEqual({ kind: "expired" });
    const count = l.updates.length;
    finish("saved");
    await expect(command).rejects.toMatchObject({ message: "closed_access" });
    expect(l.updates).toHaveLength(count);
    expect(l.release).toHaveBeenCalledOnce();
    expect(l.controller.getOpenedAccess()).toBeNull();
    expect(s.api.open).toHaveBeenCalledOnce();
    await l.controller.foreground(); expect(s.api.open).toHaveBeenCalledOnce();
  });

  it("a second refusal of the in-flight command does not turn expired into another state", async () => {
    const { l } = opened(); await l.controller.start();
    const access = l.controller.getOpenedAccess()!;
    let refuse!: (error: Error) => void;
    const command = access.run(() => new Promise<void>((_resolve, reject) => { refuse = reject; }));
    await expect(access.run(async () => { throw new ApiError("http", 401); })).rejects.toBeTruthy();
    refuse(new ApiError("http", 403));
    await expect(command).rejects.toMatchObject({ message: "closed_access" });
    expect(l.latest()).toEqual({ kind: "expired" });
  });

  it("a new Telegram login after revocation gets a new token and uses it for the document (К02-047 client side)", async () => {
    const { s, storage, l } = opened(); await l.controller.start();
    await expect(l.controller.getOpenedAccess()!.run(async () => { throw new ApiError("http", 401); })).rejects.toBeTruthy();
    l.controller.dispose();
    const again = launch(s.api, storage); await again.controller.start();
    expect(s.api.auth).toHaveBeenCalledTimes(2);
    expect(vi.mocked(s.api.open).mock.calls.at(-1)![0]).toBe("token-2");
    expect(again.latest().kind).toBe("opened");
  });
});

describe("QA relaunch of an already opened installation (Н1, Н3 — after M-REOPEN)", () => {
  /** identity/clients.py after C-REOPEN: another document of a bound installation replaces it only with the held
   * lock or a confirmation of the current epoch; otherwise SESSION_BUSY with document_conflict and that epoch. */
  function bindDocuments(s: ReturnType<typeof accessServer>) {
    const bound = { document: null as string | null, epoch: 0 };
    vi.mocked(s.api.open).mockImplementation(async (_token, _proof, request) => {
      const profile: Profile = { profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null,
        state_version: "20", access: { status: "admitted", version: "3", reason: null } };
      const compatibility = { compatible: true, contract_version: "1" };
      const replacing = bound.document !== null && bound.document !== request.document_id;
      const confirmed = request.confirm_document_replacement === true
        && request.expected_document_epoch === String(bound.epoch);
      if (replacing && !(request.holds_document_lock === true || confirmed)) return { status: "SESSION_BUSY", profile,
        compatibility, session: { status: "busy", stop_remote_target: null, document_conflict: true, document_epoch: String(bound.epoch) } };
      if (bound.document !== request.document_id) { bound.document = request.document_id; bound.epoch += 1; }
      return { status: "opened", client_instance_id: request.client_instance_id, document_id: request.document_id,
        document_epoch: String(bound.epoch), proof_version: "1", profile, session: null, compatibility };
    });
    return bound;
  }
  const unsupported = { acquire: vi.fn(async () => "unsupported" as const) };

  it("every relaunch sends a new document_id with the same installation proof; holding the lock it takes the next epoch", async () => {
    const s = accessServer(); s.server.status = "admitted"; const storage = memoryStorage(); const bound = bindDocuments(s);
    const first = launch(s.api, storage); await first.controller.start(); first.controller.dispose();
    const second = launch(s.api, storage, { newId: () => id(900) }); await second.controller.start();
    const [a, b] = vi.mocked(s.api.open).mock.calls.map(call => call[2]);
    expect(b.client_instance_id).toBe(a.client_instance_id);
    expect(b.document_id).not.toBe(a.document_id);
    expect(b).toMatchObject({ holds_document_lock: true });
    expect(b).not.toHaveProperty("confirm_document_replacement");
    expect(s.api.register).toHaveBeenCalledOnce();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(bound).toEqual({ document: b.document_id, epoch: 2 });
  });

  it("Н1: without the lock the relaunch asks before ending the other window — never a dead end without any action", async () => {
    const s = accessServer(); s.server.status = "admitted"; const storage = memoryStorage(); const bound = bindDocuments(s);
    const first = launch(s.api, storage, { lock: unsupported }); await first.controller.start();
    expect(first.latest().kind).toBe("opened"); first.controller.dispose();
    const second = launch(s.api, storage, { newId: () => id(901), lock: unsupported }); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "replace_confirm", epoch: "1" });
    expect(bound.epoch).toBe(1);
    await second.controller.confirmDocumentReplacement();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(bound).toEqual({ document: id(901), epoch: 2 });
    expect(s.api.open).toHaveBeenCalledTimes(3);
  });

  it("Н3: a window whose lock is held elsewhere checks again when it returns to the foreground", async () => {
    const s = accessServer(); s.server.status = "admitted"; const storage = memoryStorage(); const bound = bindDocuments(s);
    const first = launch(s.api, storage); await first.controller.start();
    let held = true;
    const lock = { acquire: vi.fn(async () => held ? "busy" as const : { release: vi.fn() }) };
    const second = launch(s.api, storage, { newId: () => id(902), lock }); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "other_window" });
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "other_window" });
    expect(lock.acquire).toHaveBeenCalledTimes(2); expect(s.api.open).toHaveBeenCalledOnce();
    first.controller.dispose(); held = false;
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(bound).toEqual({ document: id(902), epoch: 2 });
  });
});

describe("QA remote stop", () => {
  const profile = (version: string): Profile => ({ profile_id: PROFILE, role: "user", ui_language: "ru",
    dictionary_language: "ru", time_zone: "UTC", state_version: version, access: { status: "admitted", version: "1", reason: null } });
  function remoteFixture() {
    const state = { busy: true, target: id(50), version: 2 };
    const storage = memoryStorage();
    const api: EntryApi = {
      auth: vi.fn(async () => ({ access_token: "token", expires_at: "2026-10-06T00:00:00Z", profile: profile("1"),
        compatibility: { compatible: true, contract_version: "1" } })),
      register: vi.fn(async (_token, request) => ({ status: "registered" as const, client_instance_id: request.client_instance_id,
        origin_proof: "proof", proof_version: "1", activated: false })),
      open: vi.fn(async (_token, _proof, request) => state.busy
        ? { status: "SESSION_BUSY" as const, profile: profile(String(state.version)), compatibility: { compatible: true, contract_version: "1" },
          session: { status: "busy" as const, stop_remote_target: state.target } }
        : { status: "opened" as const, profile: profile(String(state.version)), compatibility: { compatible: true, contract_version: "1" },
          client_instance_id: request.client_instance_id, document_id: request.document_id, document_epoch: "1",
          proof_version: "1", session: null }),
      reapply: vi.fn(),
    };
    const remoteApi: RemoteSessionApi = { stop: vi.fn(), status: vi.fn() };
    const pendingStore = new RemoteStopPendingStore(storage);
    const today: TodayApi = { get: vi.fn() };
    const make = () => launch(api, storage, { today, remote: { api: remoteApi, pendingStore } });
    return { state, storage, api, remoteApi, make };
  }
  const closedRefusal = (command: SessionStopRemoteCommand): RemoteStopReply => ({ outcome: "rejected", state_version: "3",
    command: { id: command.command_id, status: "rejected" }, error: { code: "SESSION_CLOSED" },
    current: { session_id: command.session_id, status: "closed", close_reason: "stop" } });

  it("cancel of the confirmation sends nothing and keeps the same target", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    l.controller.requestRemoteStop(); expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(50) });
    l.controller.cancelRemoteStop(); expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    await l.controller.foreground();
    expect(f.remoteApi.stop).not.toHaveBeenCalled(); expect(f.remoteApi.status).not.toHaveBeenCalled();
    expect(f.storage.values.has("wortly.pending.remote_stop")).toBe(false);
  });

  it("«already closed» refusal settles without a resend and reopens to the actual state", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.busy = false; f.state.version = 3; return closedRefusal(command);
    });
    l.controller.requestRemoteStop(); await l.controller.confirmRemoteStop();
    expect(f.remoteApi.stop).toHaveBeenCalledOnce(); expect(f.remoteApi.status).not.toHaveBeenCalled();
    expect(f.storage.values.has("wortly.pending.remote_stop")).toBe(false);
    expect(l.latest()).toEqual({ kind: "opened" });
  });

  it("«already closed» while a newer session already occupies the account asks again for the new target", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.target = id(51); f.state.version = 3; return closedRefusal(command);
    });
    l.controller.requestRemoteStop(); await l.controller.confirmRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(51) });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
  });

  it("Н8: a tap on «end the session elsewhere» during a foreground refresh asks for confirmation once the refresh ends", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    let finish!: (value: Awaited<ReturnType<EntryApi["open"]>>) => void;
    vi.mocked(f.api.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refresh = l.controller.foreground();
    l.controller.requestRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(2));
    l.controller.requestRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    finish({ status: "SESSION_BUSY", profile: profile("3"), compatibility: { compatible: true, contract_version: "1" },
      session: { status: "busy", stop_remote_target: id(50) } });
    await refresh;
    expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(50) });
    // The kept tap only opens the confirmation: a send would store its intent first, so let all pending work settle.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(50) });
    expect(l.kinds().filter(kind => kind === "remote_confirm")).toHaveLength(1);
    expect(f.remoteApi.stop).not.toHaveBeenCalled();
  });

  it("a failed status check of a pending stop after relaunch does not open the document (kills mutation M10)", async () => {
    const f = remoteFixture(); const first = f.make(); await first.controller.start();
    vi.mocked(f.remoteApi.stop).mockRejectedValueOnce(new ApiError("network"));
    first.controller.requestRemoteStop(); await first.controller.confirmRemoteStop();
    expect(first.latest()).toMatchObject({ kind: "remote", remote: { pending: true } });
    first.controller.dispose();
    vi.mocked(f.remoteApi.status).mockRejectedValueOnce(new ApiError("network"));
    const opens = vi.mocked(f.api.open).mock.calls.length;
    const second = f.make(); await second.controller.start();
    expect(f.remoteApi.status).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.open).mock.calls.length).toBe(opens);
    expect(second.latest()).toMatchObject({ kind: "remote", remote: { pending: true, phase: "unresolved" } });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
  });
});
