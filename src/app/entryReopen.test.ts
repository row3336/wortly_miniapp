// Relaunch of the same installation (M-REOPEN): the cross-window lock, the explicit replacement
// confirmation and the old window, over /client/open as core identity/clients.py answers it (C-REOPEN).
import { describe, expect, it, vi } from "vitest";
import type { BusyClient, OpenRequest, OpenedClient, Profile } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { EntryApi } from "../api/entryApi";
import type { AsyncStorage } from "../platform/storage";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import type { DocumentLease, DocumentLock } from "./documentLock";
import { EntryController } from "./entryController";
import type { EntryState } from "./entryState";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const compatibility = { compatible: true, contract_version: "1" };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

/** The installation's live document: a new one replaces it only with the held lock or a confirmation of its epoch. */
function documentServer() {
  const server = { document: null as string | null, epoch: 0, version: 10, otherSession: null as string | null };
  const profile = (): Profile => ({ profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru",
    time_zone: "UTC", state_version: String(server.version), access: { status: "admitted", version: "1", reason: null } });
  const open = (request: OpenRequest): OpenedClient | BusyClient => {
    // A confirmation always names its epoch, and an epoch is only a confirmation's.
    if ((request.confirm_document_replacement === true) !== (request.expected_document_epoch != null)) {
      throw new EntryApiError("http", 422, "VALIDATION_FAILED");
    }
    const replacing = server.document !== null && server.document !== request.document_id;
    const confirmed = request.confirm_document_replacement === true
      && request.expected_document_epoch === String(server.epoch);
    if (replacing && !(request.holds_document_lock === true || confirmed)) {
      return { status: "SESSION_BUSY", profile: profile(), compatibility, session: { status: "busy",
        stop_remote_target: null, document_conflict: true, document_epoch: String(server.epoch) } };
    }
    if (server.document !== request.document_id) {
      server.document = request.document_id; server.epoch += 1; server.version += 1;
    }
    if (server.otherSession) {
      return { status: "SESSION_BUSY", profile: profile(), compatibility, session: { status: "busy",
        stop_remote_target: server.otherSession, document_conflict: false, document_epoch: String(server.epoch) } };
    }
    return { status: "opened", profile: profile(), compatibility, client_instance_id: request.client_instance_id,
      document_id: request.document_id, document_epoch: String(server.epoch), proof_version: "1", session: null };
  };
  return { server, profile, open };
}

/** Web Locks of one browser: another window gets "busy" until the holder releases its lease. */
function browserLock() {
  let holder: DocumentLease | null = null;
  return { acquire: vi.fn(async (): Promise<DocumentLease | "busy"> => {
    if (holder) return "busy";
    const lease: DocumentLease = { release: () => { if (holder === lease) holder = null; } };
    holder = lease;
    return lease;
  }) } satisfies DocumentLock;
}
const noLocks = (): DocumentLock => ({ acquire: vi.fn(async () => "unsupported" as const) });

/** One device: shared storage, server and locks; every window is its own EntryController. */
function device(lock: DocumentLock, options: { remote?: boolean } = {}) {
  const { server, profile, open } = documentServer();
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
  const api: EntryApi = {
    auth: vi.fn(async () => ({ access_token: "token", expires_at: "2026-10-07T00:00:00Z", profile: profile(), compatibility })),
    reapply: vi.fn(),
    register: vi.fn(async (_token, request) => ({ client_instance_id: request.client_instance_id,
      status: "registered" as const, origin_proof: "proof", proof_version: "1", activated: false })),
    open: vi.fn(async (_token, _proof, request) => open(request)),
  };
  const remote = options.remote ? { today: { get: vi.fn() },
    remote: { api: { stop: vi.fn(), status: vi.fn() }, pendingStore: new RemoteStopPendingStore(storage) } } : {};
  let next = 100;
  const window = (onState?: (state: EntryState) => void) => {
    const states: EntryState[] = [];
    const controller = new EntryController({ api, storage, lock, initData: "signed", savedLanguage: "ru",
      browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
      newId: () => id(next++), onUpdate: ({ state }) => { states.push(state); onState?.(state); }, ...remote });
    return { controller, states, latest: () => states.at(-1) };
  };
  const bodies = () => vi.mocked(api.open).mock.calls.map(call => call[2]);
  return { server, api, window, bodies };
}

/** Two windows without the lock: the first holds the document, the second has the question open. */
async function conflict() {
  const d = device(noLocks());
  const first = d.window(); await first.controller.start();
  const second = d.window(); await second.controller.start();
  return { d, first, second };
}

describe("relaunch with the cross-window lock (CT:186, CT:188)", () => {
  it("a relaunch holding the free lock opens its new document at once: no question, no busy, the epoch changes", async () => {
    const d = device(browserLock());
    const first = d.window(); await first.controller.start();
    expect(first.latest()).toEqual({ kind: "opened" });
    first.controller.dispose();
    const second = d.window(); await second.controller.start();
    expect(second.states.map(state => state.kind)).toEqual(["checking", "opening", "opened"]);
    const [a, b] = d.bodies();
    expect(a).toMatchObject({ holds_document_lock: true, event: "open" });
    expect(b.document_id).not.toBe(a.document_id);
    expect(b).toEqual({ ...a, document_id: b.document_id });
    expect(d.api.register).toHaveBeenCalledOnce();
    expect(d.server).toMatchObject({ document: b.document_id, epoch: 2 });
    expect(second.controller.getOpenedAccess()!.document).toMatchObject({ documentId: b.document_id, epoch: "2" });
  });

  it("while another window holds the lock nothing is opened; back in the foreground after it closed, this window enters", async () => {
    const lock = browserLock(); const d = device(lock);
    const first = d.window(); await first.controller.start();
    const second = d.window(); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "other_window" });
    expect(d.api.open).toHaveBeenCalledOnce();
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "other_window" });
    expect(d.api.open).toHaveBeenCalledOnce(); expect(lock.acquire).toHaveBeenCalledTimes(3);
    first.controller.dispose();
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(d.bodies()[1]).toMatchObject({ event: "open", holds_document_lock: true });
    expect(d.bodies()[1].document_id).not.toBe(d.bodies()[0].document_id);
    expect(d.server.epoch).toBe(2);
    expect(d.api.auth).toHaveBeenCalledTimes(2); // The recheck reuses this window's sign-in.
  });

  it("a foreground right as the other window is shown is kept and checks once that work ends", async () => {
    const lock = browserLock(); const d = device(lock);
    const first = d.window(); await first.controller.start();
    let refresh: Promise<void> | undefined;
    const second = d.window(state => {
      if (state.kind !== "other_window" || refresh) return;
      first.controller.dispose();
      refresh = second.controller.foreground();
    });
    await second.controller.start(); await refresh;
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(d.api.open).toHaveBeenCalledTimes(2);
  });

  it("the lease goes with every open of the live document and a lost reply repeats the same request", async () => {
    const d = device(browserLock());
    const first = d.window(); await first.controller.start(); first.controller.dispose();
    const original = vi.mocked(d.api.open).getMockImplementation()!;
    vi.mocked(d.api.open).mockImplementationOnce(async (...args) => { await original(...args); throw new EntryApiError("network"); });
    const second = d.window(); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "unavailable" });
    await second.controller.retry();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(d.bodies()[2]).toEqual(d.bodies()[1]);
    expect(d.bodies()[1]).toMatchObject({ holds_document_lock: true });
    expect(d.server.epoch).toBe(2);
    await second.controller.foreground();
    expect(d.bodies()[3]).toEqual({ ...d.bodies()[1], event: "foreground" });
  });

  it("a window that lost its lease never claims the lock again: another window holds it now", async () => {
    const lock = browserLock(); const d = device(lock);
    const first = d.window(); await first.controller.start();
    // A refused access ends the document and gives its lease back.
    await expect(first.controller.getOpenedAccess()!.run(async () => { throw new EntryApiError("http", 403); }))
      .rejects.toMatchObject({ status: 403 });
    expect(first.latest()).toEqual({ kind: "unavailable" });
    const second = d.window(); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "opened" });
    await first.controller.retry();
    expect(first.latest()).toEqual({ kind: "other_window" });
    expect(d.api.open).toHaveBeenCalledTimes(2);
  });

  it("another installation's session keeps its remote stop after this document was replaced", async () => {
    const d = device(browserLock(), { remote: true });
    const first = d.window(); await first.controller.start(); first.controller.dispose();
    d.server.otherSession = id(50);
    const second = d.window(); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    expect(second.controller.getBusyAccess()).not.toBeNull();
    expect(d.server.epoch).toBe(2);
    second.controller.requestRemoteStop();
    expect(second.latest()).toEqual({ kind: "remote_confirm", targetId: id(50) });
  });
});

describe("relaunch without the lock: the explicit replacement (CT:188)", () => {
  it("a conflict asks the user and sends nothing more by itself", async () => {
    const { d, first, second } = await conflict();
    expect(first.latest()).toEqual({ kind: "opened" });
    expect(second.latest()).toEqual({ kind: "replace_confirm", epoch: "1" });
    expect(d.bodies()[1]).not.toHaveProperty("holds_document_lock");
    expect(d.bodies()[1]).not.toHaveProperty("confirm_document_replacement");
    await settle(); await second.controller.foreground();
    expect(d.api.open).toHaveBeenCalledTimes(2);
    expect(d.server).toMatchObject({ document: d.bodies()[0].document_id, epoch: 1 });
  });

  it("cancel changes nothing on the server; the next foreground asks again with the same document", async () => {
    const { d, second } = await conflict();
    second.controller.cancelDocumentReplacement();
    expect(second.latest()).toEqual({ kind: "other_window" });
    await settle();
    expect(d.api.open).toHaveBeenCalledTimes(2);
    expect(d.server).toMatchObject({ document: d.bodies()[0].document_id, epoch: 1, version: 11 });
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "replace_confirm", epoch: "1" });
    expect(d.bodies()[2]).toEqual(d.bodies()[1]);
    expect(d.server).toMatchObject({ document: d.bodies()[0].document_id, epoch: 1 });
  });

  it("the confirmation is the same open of the same document naming the epoch the user saw", async () => {
    const { d, second } = await conflict();
    await second.controller.confirmDocumentReplacement();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(d.bodies()[2]).toEqual({ ...d.bodies()[1], confirm_document_replacement: true, expected_document_epoch: "1" });
    expect(d.server).toMatchObject({ document: d.bodies()[1].document_id, epoch: 2 });
    await second.controller.foreground();
    // The confirmation is spent: the live document refreshes without it.
    expect(d.bodies()[3]).toEqual({ ...d.bodies()[1], event: "foreground" });
  });

  it("a double tap confirms once", async () => {
    const { d, second } = await conflict();
    const tap = second.controller.confirmDocumentReplacement();
    expect(second.controller.confirmDocumentReplacement()).toBe(tap);
    await tap;
    expect(d.api.open).toHaveBeenCalledTimes(3);
  });

  it("a newer conflict to the confirmation is asked again and never confirmed automatically", async () => {
    const { d, second } = await conflict();
    // A third window took the document after the question was shown.
    d.server.document = id(900); d.server.epoch = 2; d.server.version += 1;
    await second.controller.confirmDocumentReplacement();
    expect(second.latest()).toEqual({ kind: "replace_confirm", epoch: "2" });
    await settle();
    expect(d.api.open).toHaveBeenCalledTimes(3);
    expect(d.server).toMatchObject({ document: id(900), epoch: 2 });
    await second.controller.confirmDocumentReplacement();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(d.bodies()[3]).toMatchObject({ document_id: d.bodies()[1].document_id, expected_document_epoch: "2" });
  });

  it("a declined newer question sends no confirmation when it is asked next time", async () => {
    const { d, second } = await conflict();
    d.server.document = id(900); d.server.epoch = 2; d.server.version += 1;
    await second.controller.confirmDocumentReplacement();
    second.controller.cancelDocumentReplacement();
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "replace_confirm", epoch: "2" });
    expect(d.bodies()[3]).toEqual(d.bodies()[1]);
  });

  it("a lost reply to the confirmation repeats the same request", async () => {
    const { d, second } = await conflict();
    const original = vi.mocked(d.api.open).getMockImplementation()!;
    vi.mocked(d.api.open).mockImplementationOnce(async (...args) => { await original(...args); throw new EntryApiError("network"); });
    await second.controller.confirmDocumentReplacement();
    expect(second.latest()).toEqual({ kind: "unavailable" });
    await second.controller.retry();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(d.bodies()[3]).toEqual(d.bodies()[2]);
    expect(d.bodies()[3]).toMatchObject({ confirm_document_replacement: true, expected_document_epoch: "1" });
    expect(d.server.epoch).toBe(2);
  });

  it("a confirmation does not outlive the sign-in it was given in", async () => {
    const { d, second } = await conflict();
    vi.mocked(d.api.open).mockRejectedValueOnce(new EntryApiError("http", 403));
    await second.controller.confirmDocumentReplacement();
    expect(second.latest()).toEqual({ kind: "unavailable" });
    await second.controller.retry();
    expect(second.latest()).toEqual({ kind: "replace_confirm", epoch: "1" });
    expect(d.bodies()[3]).not.toHaveProperty("confirm_document_replacement");
    expect(d.server.epoch).toBe(1);
  });

  it("a conflict without an epoch offers no confirmation", async () => {
    const d = device(noLocks());
    vi.mocked(d.api.open).mockResolvedValueOnce({ status: "SESSION_BUSY", profile: { profile_id: id(1), role: "user",
      ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
      access: { status: "admitted", version: "1", reason: null } }, compatibility,
      session: { status: "busy", stop_remote_target: null, document_conflict: true, document_epoch: null } });
    const only = d.window(); await only.controller.start();
    expect(only.latest()).toEqual({ kind: "unavailable" });
    expect(only.states.map(state => state.kind)).not.toContain("replace_confirm");
  });

  it("confirm and cancel outside the question do nothing", async () => {
    const d = device(noLocks());
    const only = d.window(); await only.controller.start();
    const count = only.states.length;
    await only.controller.confirmDocumentReplacement(); only.controller.cancelDocumentReplacement();
    expect(only.states).toHaveLength(count);
    expect(d.api.open).toHaveBeenCalledOnce();
  });
});

describe("the old window after its document was replaced", () => {
  it("a refused write stays with its own screen; the next foreground shows the question and confirms nothing", async () => {
    const { d, first, second } = await conflict();
    await second.controller.confirmDocumentReplacement();
    const access = first.controller.getOpenedAccess()!;
    await expect(access.run(async () => { throw new EntryApiError("http", 409, "SESSION_BUSY"); }))
      .rejects.toMatchObject({ code: "SESSION_BUSY" });
    expect(first.latest()).toEqual({ kind: "opened" });
    await settle();
    expect(d.api.open).toHaveBeenCalledTimes(3);
    await first.controller.foreground();
    expect(first.latest()).toEqual({ kind: "replace_confirm", epoch: "2" });
    expect(access.isLive()).toBe(false); expect(first.controller.getOpenedAccess()).toBeNull();
    expect(d.bodies()[3]).toEqual({ ...d.bodies()[0], event: "foreground" });
    await settle();
    expect(d.api.open).toHaveBeenCalledTimes(4);
    expect(d.server).toMatchObject({ document: d.bodies()[1].document_id, epoch: 2 });
  });
});
