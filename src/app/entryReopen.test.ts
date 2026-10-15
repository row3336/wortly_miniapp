// Relaunch of the same installation after decision 2.3 (M-REOPEN-2): a new window takes the document over at once,
// the old one closes itself, over /client/open as core identity/clients.py answers it after C-REOPEN-2.
import { describe, expect, it, vi } from "vitest";
import type { BusyClient, OpenRequest, OpenedClient, Profile } from "../api/generated";
import { EntryApiError } from "../api/entryApi";
import type { EntryApi } from "../api/entryApi";
import type { AsyncStorage } from "../platform/storage";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import type { DocumentLease, DocumentLock } from "./documentLock";
import { EntryController } from "./entryController";
import { keysOf, openDocument, openRequestKeys } from "./openRules.test-support";
import type { EntryState } from "./entryState";
import { testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const compatibility = { compatible: true, contract_version: "1" };
const settle = () => new Promise(resolve => setTimeout(resolve, 10));

/** The installation's live document: an open of another document always replaces it; a foreground of an old one is stale. */
function documentServer() {
  const server = { document: null as string | null, epoch: 0, version: 10, otherSession: null as string | null };
  const profile = (): Profile => ({ profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru",
    time_zone: "UTC", state_version: String(server.version), access: { status: "admitted", version: "1", reason: null } });
  const open = (request: OpenRequest): OpenedClient | BusyClient => {
    const changed = openDocument(server, request);
    if (changed === "stale") throw new EntryApiError("http", 409, "DOCUMENT_STALE");
    if (changed) server.version += 1;
    if (server.otherSession) {
      return { status: "SESSION_BUSY", profile: profile(), compatibility, session: { status: "busy",
        stop_remote_target: server.otherSession, document_conflict: false, document_epoch: String(server.epoch) } };
    }
    return { status: "opened", profile: profile(), compatibility, client_instance_id: request.client_instance_id,
      document_id: request.document_id, document_epoch: String(server.epoch), proof_version: "1", session: null };
  };
  return { server, profile, open };
}

/** Web Locks of one browser: every request steals, and the window that held the name learns it lost it. */
function browserLock() {
  const holders = new Map<string, { lease: DocumentLease; lost(): void }>();
  const acquire = vi.fn(async (key: string, onLost: () => void): Promise<DocumentLease> => {
    const previous = holders.get(key);
    const lease: DocumentLease = { release: () => { if (holders.get(key)?.lease === lease) holders.delete(key); } };
    holders.set(key, { lease, lost: onLost });
    if (previous) queueMicrotask(previous.lost);
    return lease;
  });
  return { holders, acquire } satisfies DocumentLock & { holders: unknown };
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
  const window = () => {
    const states: EntryState[] = [];
    const closeWindow = vi.fn();
    const checks: boolean[] = [];
    const controller = new EntryController({ gate: testGate(), api, storage, lock, initData: "signed", savedLanguage: "ru",
      browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
      newId: () => id(next++), onUpdate: ({ state }) => { states.push(state); }, closeWindow,
      onDocumentCheck: checking => { checks.push(checking); }, ...remote });
    return { controller, states, closeWindow, checks, latest: () => states.at(-1) };
  };
  const bodies = () => vi.mocked(api.open).mock.calls.map(call => call[2]);
  return { server, api, window, bodies };
}

/** Two windows of one installation; the second took the document over. */
async function twoWindows(lock: DocumentLock) {
  const d = device(lock);
  const first = d.window(); await first.controller.start();
  const second = d.window(); await second.controller.start();
  return { d, first, second };
}

describe("a new window takes the document over at once (decision 2.3, CT:186)", () => {
  it("a relaunch opens its new document: no question, no busy, the next epoch, no lock flag or confirmation", async () => {
    const d = device(browserLock());
    const first = d.window(); await first.controller.start();
    expect(first.latest()).toEqual({ kind: "opened" });
    first.controller.dispose();
    const second = d.window(); await second.controller.start();
    expect(second.states.map(state => state.kind)).toEqual(["checking", "opening", "opened"]);
    const [a, b] = d.bodies();
    expect(a).toMatchObject({ event: "open" });
    expect(b.document_id).not.toBe(a.document_id);
    expect(b).toEqual({ ...a, document_id: b.document_id });
    expect(keysOf(a)).toEqual(openRequestKeys); expect(keysOf(b)).toEqual(openRequestKeys);
    expect(d.api.register).toHaveBeenCalledOnce();
    expect(d.server).toMatchObject({ document: b.document_id, epoch: 2 });
    expect(second.controller.getOpenedAccess()!.document).toMatchObject({ documentId: b.document_id, epoch: "2" });
  });

  it("while the first window is alive the second enters at once; the first learns it from the lock and closes itself", async () => {
    const lock = browserLock();
    const { d, first, second } = await twoWindows(lock);
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(d.server).toMatchObject({ document: d.bodies()[1].document_id, epoch: 2 });
    await vi.waitFor(() => expect(first.latest()).toEqual({ kind: "replaced" }));
    expect(first.closeWindow).toHaveBeenCalledOnce();
    expect(first.controller.getOpenedAccess()).toBeNull();
    expect(second.closeWindow).not.toHaveBeenCalled();
    // The old window sent nothing to learn it; the lock now belongs to the new window only.
    expect(d.api.open).toHaveBeenCalledTimes(2);
    expect([...lock.holders.keys()]).toHaveLength(1);
  });

  it.each([
    ["is held by the first window", () => browserLock() as DocumentLock],
    ["is not supported", noLocks],
    ["never answers", (): DocumentLock => ({ acquire: vi.fn(() => new Promise<never>(() => {})) })],
  ])("the second window enters at once when the lock %s", async (_case, lock) => {
    const { d, second } = await twoWindows(lock());
    expect(second.states.map(state => state.kind)).toEqual(["checking", "opening", "opened"]);
    expect(d.server.document).toBe(d.bodies()[1].document_id);
  });

  it("without Web Locks the old window closes on its next foreground: DOCUMENT_STALE, nothing changes on the server", async () => {
    const { d, first, second } = await twoWindows(noLocks());
    expect(first.latest()).toEqual({ kind: "opened" });
    const access = first.controller.getOpenedAccess()!;
    await first.controller.foreground();
    expect(d.bodies()[2]).toEqual({ ...d.bodies()[0], event: "foreground" });
    expect(first.latest()).toEqual({ kind: "replaced" });
    expect(first.closeWindow).toHaveBeenCalledOnce();
    expect(access.isLive()).toBe(false);
    expect(d.server).toMatchObject({ document: d.bodies()[1].document_id, epoch: 2 });
    await second.controller.foreground();
    expect(second.latest()).toEqual({ kind: "opened" });
    expect(second.closeWindow).not.toHaveBeenCalled();
  });

  it("a write of the old window refused as DOCUMENT_STALE: one task later its foreground decides and the window closes", async () => {
    const { d, first } = await twoWindows(noLocks());
    const access = first.controller.getOpenedAccess()!;
    first.controller.documentStale();
    // The module still settles its refusal on a live access first; nothing is sent in the same task.
    expect(access.isLive()).toBe(true);
    expect(d.api.open).toHaveBeenCalledTimes(2);
    first.controller.documentStale();
    await settle();
    expect(d.bodies().slice(2)).toEqual([{ ...d.bodies()[0], event: "foreground" }]);
    expect(first.latest()).toEqual({ kind: "replaced" });
    expect(first.closeWindow).toHaveBeenCalledOnce();
  });

  it("the check is announced before the module reads the refusal and ends with its foreground, once per doubt (2.33)", async () => {
    const { d, first } = await twoWindows(noLocks());
    first.controller.documentStale();
    // Synchronously, before the module that got the refusal renders it.
    expect(first.checks).toEqual([true]);
    first.controller.documentStale();
    expect(first.checks).toEqual([true]);
    await settle();
    expect(first.latest()).toEqual({ kind: "replaced" });
    expect(first.checks).toEqual([true, false]);
    expect(d.bodies().slice(2).map(body => body.event)).toEqual(["foreground"]);
  });

  it("a second DOCUMENT_STALE during the check is answered by it: no new check after it confirms the live document", async () => {
    const d = device(noLocks());
    const only = d.window(); await only.controller.start();
    const original = vi.mocked(d.api.open).getMockImplementation()!;
    let resume!: () => void;
    vi.mocked(d.api.open).mockImplementationOnce(async (...args) => {
      await new Promise<void>(resolve => { resume = resolve; });
      return original(...args);
    });
    only.controller.documentStale();
    await settle();
    only.controller.documentStale(); // While the check's foreground is in flight.
    resume();
    await settle(); await settle();
    expect(only.latest()).toEqual({ kind: "opened" });
    expect(d.bodies().slice(1).map(body => body.event)).toEqual(["foreground"]);
    expect(only.checks).toEqual([true, false]);
  });

  it.each([
    ["confirms the live document", false],
    ["is lost", true],
  ])("the check ends too when its foreground %s", async (_case, lost) => {
    const d = device(noLocks());
    const only = d.window(); await only.controller.start();
    if (lost) vi.mocked(d.api.open).mockRejectedValueOnce(new EntryApiError("network"));
    only.controller.documentStale();
    await settle();
    expect(only.checks).toEqual([true, false]);
    expect(only.latest()).toEqual(lost ? { kind: "unavailable" } : { kind: "opened" });
  });

  it("a DOCUMENT_STALE of the live window (a closed card context) keeps it open: its foreground confirms the document", async () => {
    const d = device(noLocks());
    const only = d.window(); await only.controller.start();
    only.controller.documentStale();
    await settle();
    expect(d.bodies()[1]).toEqual({ ...d.bodies()[0], event: "foreground" });
    expect(only.latest()).toEqual({ kind: "opened" });
    expect(only.controller.getOpenedAccess()).not.toBeNull();
    expect(only.closeWindow).not.toHaveBeenCalled();
    // The answer cleared the doubt: a later retry is an ordinary open again.
    await only.controller.retry();
    expect(d.bodies()[2]).toEqual(d.bodies()[0]);
  });

  it("after DOCUMENT_STALE the window never sends open for that document again (2.30, QA Н1)", async () => {
    const { d, first } = await twoWindows(noLocks());
    await first.controller.foreground();
    expect(first.latest()).toEqual({ kind: "replaced" });
    const count = vi.mocked(d.api.open).mock.calls.length;
    await first.controller.retry(); await first.controller.foreground(); await first.controller.start();
    first.controller.documentStale(); await settle();
    expect(d.api.open).toHaveBeenCalledTimes(count);
    expect(d.bodies().filter(body => body.document_id === d.bodies()[0].document_id && body.event === "open")).toHaveLength(1);
    expect(d.server.document).toBe(d.bodies()[1].document_id);
  });

  it("a doubt that meets a lost answer: the retry asks with a foreground, never with an open that would take the document back", async () => {
    const { d, first } = await twoWindows(noLocks());
    vi.mocked(d.api.open).mockRejectedValueOnce(new EntryApiError("network"));
    first.controller.documentStale();
    await settle();
    expect(first.latest()).toEqual({ kind: "unavailable" });
    await first.controller.retry();
    expect(d.bodies().slice(2).map(body => [body.document_id, body.event]))
      .toEqual([[d.bodies()[0].document_id, "foreground"], [d.bodies()[0].document_id, "foreground"]]);
    expect(first.latest()).toEqual({ kind: "replaced" });
    expect(d.server.document).toBe(d.bodies()[1].document_id);
  });

  it("a lost reply to the open repeats the same request", async () => {
    const d = device(browserLock());
    const original = vi.mocked(d.api.open).getMockImplementation()!;
    vi.mocked(d.api.open).mockImplementationOnce(async (...args) => { await original(...args); throw new EntryApiError("network"); });
    const only = d.window(); await only.controller.start();
    expect(only.latest()).toEqual({ kind: "unavailable" });
    await only.controller.retry();
    expect(only.latest()).toEqual({ kind: "opened" });
    expect(d.bodies()[1]).toEqual(d.bodies()[0]);
    expect(d.server.epoch).toBe(1);
    await only.controller.foreground();
    expect(d.bodies()[2]).toEqual({ ...d.bodies()[0], event: "foreground" });
  });

  it("a refused access gives the lock back; a window that lost its document never closes the live one", async () => {
    const lock = browserLock(); const d = device(lock);
    const first = d.window(); await first.controller.start();
    await vi.waitFor(() => expect(lock.holders.size).toBe(1));
    await expect(first.controller.getOpenedAccess()!.run(async () => { throw new EntryApiError("http", 403); }))
      .rejects.toMatchObject({ status: 403 });
    expect(first.latest()).toEqual({ kind: "unavailable" });
    expect(lock.holders.size).toBe(0);
    const second = d.window(); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "opened" });
    await settle();
    expect(first.closeWindow).not.toHaveBeenCalled(); expect(second.closeWindow).not.toHaveBeenCalled();
  });

  it("another installation's session keeps its remote stop; that window never closes itself", async () => {
    const d = device(browserLock(), { remote: true });
    const first = d.window(); await first.controller.start(); first.controller.dispose();
    d.server.otherSession = id(50);
    const second = d.window(); await second.controller.start();
    expect(second.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    expect(second.controller.getBusyAccess()).not.toBeNull();
    expect(d.server.epoch).toBe(2);
    second.controller.requestRemoteStop();
    expect(second.latest()).toEqual({ kind: "remote_confirm", targetId: id(50) });
    await settle();
    expect(second.closeWindow).not.toHaveBeenCalled();
  });
});
