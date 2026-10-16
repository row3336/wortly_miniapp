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
import { keysOf, openDocument, openRequestKeys } from "./openRules.test-support";
import { freshTestGate } from "../commands/testGate.test-support";

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
  const controller = new EntryController({ gate: freshTestGate(), api, storage, lock: { acquire: vi.fn(async () => ({ release })) },
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

describe("QA relaunch of an already opened installation (Н1, Н3 — after M-REOPEN-2, decision 2.3)", () => {
  /** identity/clients.py after C-REOPEN-2: an open of another document always replaces the live one with the next
   * epoch; a foreground of a replaced document is DOCUMENT_STALE and changes nothing. */
  function bindDocuments(s: ReturnType<typeof accessServer>) {
    const bound = { document: null as string | null, epoch: 0 };
    vi.mocked(s.api.open).mockImplementation(async (_token, _proof, request) => {
      const profile: Profile = { profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: null,
        state_version: "20", access: { status: "admitted", version: "3", reason: null } };
      if (openDocument(bound, request) === "stale") throw new EntryApiError("http", 409, "DOCUMENT_STALE");
      return { status: "opened", client_instance_id: request.client_instance_id, document_id: request.document_id,
        document_epoch: String(bound.epoch), proof_version: "1", profile, session: null,
        compatibility: { compatible: true, contract_version: "1" } };
    });
    return bound;
  }
  const unsupported = { acquire: vi.fn(async () => "unsupported" as const) };

  it("every relaunch sends a new document_id with the same installation proof and takes the next epoch, without any legacy field", async () => {
    const s = accessServer(); s.server.status = "admitted"; const storage = memoryStorage(); const bound = bindDocuments(s);
    const first = launch(s.api, storage); await first.controller.start(); first.controller.dispose();
    const second = launch(s.api, storage, { newId: () => id(900) }); await second.controller.start();
    const [a, b] = vi.mocked(s.api.open).mock.calls.map(call => call[2]);
    expect(b.client_instance_id).toBe(a.client_instance_id);
    expect(b.document_id).not.toBe(a.document_id);
    expect(keysOf(b)).toEqual(openRequestKeys);
    expect(s.api.register).toHaveBeenCalledOnce();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(bound).toEqual({ document: b.document_id, epoch: 2 });
  });

  it("Н1: without the lock the relaunch enters at once while the first window lives; never a question or a dead end", async () => {
    const s = accessServer(); s.server.status = "admitted"; const storage = memoryStorage(); const bound = bindDocuments(s);
    const first = launch(s.api, storage, { lock: unsupported }); await first.controller.start();
    expect(first.latest().kind).toBe("opened");
    const second = launch(s.api, storage, { newId: () => id(901), lock: unsupported }); await second.controller.start();
    expect(second.kinds()).toEqual(["checking", "opening", "opened"]);
    expect(bound).toEqual({ document: id(901), epoch: 2 });
    expect(s.api.open).toHaveBeenCalledTimes(2);
  });

  it("Н3: the old window that returns to the foreground is closed, and the live window keeps the document", async () => {
    const s = accessServer(); s.server.status = "admitted"; const storage = memoryStorage(); const bound = bindDocuments(s);
    const closeWindow = vi.fn();
    const first = launch(s.api, storage, { closeWindow }); await first.controller.start();
    const second = launch(s.api, storage, { newId: () => id(902) }); await second.controller.start();
    await first.controller.foreground();
    expect(first.latest()).toEqual({ kind: "replaced" });
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(bound).toEqual({ document: id(902), epoch: 2 });
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "opened" });
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

  const acceptedReply = (command: SessionStopRemoteCommand): RemoteStopReply => ({ outcome: "accepted", state_version: "3",
    command: { id: command.command_id, kind: command.kind, status: "applied", applied_at: "2026-10-06T12:00:00Z",
      target_id: command.session_id, action_id: null, result_id: null, context_id: null, object_version: null },
    current: { session_id: command.session_id, status: "closed", close_reason: "remote_stop" } });

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
    // The refused tap is explained and never counts for the new session (decision 2.13.2).
    expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(51), changed: true });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.busy = false; f.state.version = 4; return acceptedReply(command);
    });
    await l.controller.confirmRemoteStop();
    expect(vi.mocked(f.remoteApi.stop).mock.calls[1][2].session_id).toBe(id(51));
    expect(l.latest()).toEqual({ kind: "opened" });
  });

  it("cancelling the «session changed» question returns to the busy screen, and the next tap asks the plain question", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.target = id(51); f.state.version = 3; return closedRefusal(command);
    });
    l.controller.requestRemoteStop(); await l.controller.confirmRemoteStop();
    expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(51), changed: true });
    l.controller.cancelRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(51) });
    l.controller.requestRemoteStop();
    expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(51) });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
  });

  it("«already closed» with the same session still occupying the account is not reported as a change", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.version = 3; return closedRefusal(command);
    });
    l.controller.requestRemoteStop(); await l.controller.confirmRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
  });

  it("a later refresh does not repeat the change notice after the refused confirmation", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.version = 3; return closedRefusal(command);
    });
    l.controller.requestRemoteStop(); await l.controller.confirmRemoteStop();
    f.state.target = id(51); f.state.version = 4;
    await l.controller.foreground();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(51) });
  });

  it("the change notice belongs only to the reopen right after the refusal: a refusal whose reopen never ran leaves nothing behind", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.target = id(51); f.state.version = 3; return closedRefusal(command);
    });
    // The refusal is known, but forgetting the saved command fails: nothing reopens in this action.
    const remove = f.storage.remove;
    f.storage.remove = async () => { throw new Error("synthetic storage failure"); };
    l.controller.requestRemoteStop(); await l.controller.confirmRemoteStop();
    expect(l.latest()).toMatchObject({ kind: "remote", remote: { outcome: "rejected", problem: "storage" } });
    expect(f.api.open).toHaveBeenCalledOnce();
    f.storage.remove = remove;
    // A later check settles the old refusal and reopens: the other session is shown as the plain busy screen.
    await l.controller.checkRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(51) });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
  });

  it("a replacement session found after an accepted stop keeps the plain busy screen", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    vi.mocked(f.remoteApi.stop).mockImplementationOnce(async (_token, _proof, command) => {
      f.state.target = id(51); f.state.version = 3;
      return acceptedReply(command);
    });
    l.controller.requestRemoteStop(); await l.controller.confirmRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(51) });
  });

  it("a tap kept during a refresh that finds another session explains the change and sends nothing", async () => {
    const f = remoteFixture(); const l = f.make(); await l.controller.start();
    let finish!: (value: Awaited<ReturnType<EntryApi["open"]>>) => void;
    vi.mocked(f.api.open).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refresh = l.controller.foreground();
    await vi.waitFor(() => expect(f.api.open).toHaveBeenCalledTimes(2));
    l.controller.requestRemoteStop();
    expect(l.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    finish({ status: "SESSION_BUSY", profile: profile("3"), compatibility: { compatible: true, contract_version: "1" },
      session: { status: "busy", stop_remote_target: id(51) } });
    await refresh;
    expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(51), changed: true });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(l.latest()).toEqual({ kind: "remote_confirm", targetId: id(51), changed: true });
    expect(f.remoteApi.stop).not.toHaveBeenCalled();
    expect(f.storage.values.has("wortly.pending.remote_stop")).toBe(false);
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
    // P03 R10 п.4 (AC-118): the loaded pending does not hold the first open back — it goes once, without waiting for a
    // GET; SESSION_BUSY then gives the narrow context whose read of the own stop fails: the remote screen, no new open.
    expect(f.remoteApi.status).toHaveBeenCalledOnce();
    expect(vi.mocked(f.api.open).mock.calls.length).toBe(opens + 1);
    expect(vi.mocked(f.api.open).mock.calls.at(-1)![2].event).toBe("open");
    expect(second.latest()).toMatchObject({ kind: "remote", remote: { pending: true, phase: "unresolved" } });
    expect(f.remoteApi.stop).toHaveBeenCalledOnce();
  });
});
