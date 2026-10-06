// Windows of one installation after decision 2.3 over the real transport, entry API, remote-stop API and
// browserDocumentLock, each window wired like App.tsx (its HttpOptions tell its own controller of DOCUMENT_STALE).
import { describe, expect, it, vi } from "vitest";
import type { OpenRequest, Profile } from "../api/generated";
import { createEntryApi } from "../api/entryApi";
import { createJsonTransport, type HttpOptions } from "../api/http";
import type { AsyncStorage } from "../platform/storage";
import { createRemoteSessionApi } from "../study/remoteSessionApi";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import { browserDocumentLock } from "./documentLock";
import { EntryController } from "./entryController";
import type { EntryState } from "./entryState";
import { openDocument, staleDocument, staleRefusal } from "./openRules.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const compatibility = { compatible: true, contract_version: "1" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

/** navigator.locks of one browser profile: a steal request takes the name and ends the holder's request with AbortError. */
function locks() {
  const held = new Map<string, (error: Error) => void>();
  const request = vi.fn((name: string, _options: LockOptions, callback: (lock: Lock | null) => Promise<void>) =>
    new Promise<void>((resolve, reject) => {
      held.get(name)?.(new DOMException("The lock was stolen", "AbortError"));
      held.set(name, reject);
      void callback({ name, mode: "exclusive" } as Lock).then(() => {
        if (held.get(name) === reject) held.delete(name);
        resolve();
      });
    }));
  return { held, request, navigator: { locks: { request } } as unknown as Navigator };
}

/** One device: shared storage, fetch and locks; a synthetic core after C-REOPEN-2. */
function device(options: { otherSession?: string; locks?: boolean } = {}) {
  const server = { document: null as string | null, epoch: 0, version: 10, otherSession: options.otherSession ?? null,
    stopped: [] as string[], contextClosed: false };
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
  const profile = (): Profile => ({ profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru",
    time_zone: "UTC", state_version: String(server.version), access: { status: "admitted", version: "1", reason: null } });
  const opens: OpenRequest[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const address = new URL(String(url), "http://localhost"), path = address.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/auth/telegram")) return json({ access_token: "token", expires_at: "2026-10-07T00:00:00Z", profile: profile(), compatibility });
    if (path.endsWith("/client/register")) return json({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) {
      opens.push(body);
      const changed = openDocument(server, body);
      if (changed === "stale") return json(staleRefusal, 409);
      if (changed) server.version += 1;
      if (server.otherSession) return json({ status: "SESSION_BUSY", profile: profile(), compatibility, session: { status: "busy",
        stop_remote_target: server.otherSession, document_conflict: false, document_epoch: String(server.epoch) } });
      return json({ status: "opened", profile: profile(), compatibility, client_instance_id: body.client_instance_id,
        document_id: body.document_id, document_epoch: String(server.epoch), proof_version: "1", session: null });
    }
    // A card context read: the core answers DOCUMENT_STALE for a replaced document and for a closed context alike.
    if (path.includes("/dictionary/contexts/")) {
      if (server.contextClosed || staleDocument(server, address.searchParams.get("document_id"))) return json(staleRefusal, 409);
      return json({ ok: true });
    }
    if (path.endsWith("/commands") && body?.kind === "session.stop_remote") {
      if (staleDocument(server, body.document_id)) {
        return json({ command: { id: body.command_id, status: "rejected" }, current: { session_id: body.session_id, status: "unavailable" },
          state_version: String(server.version), error: { code: "DOCUMENT_STALE" } }, 409);
      }
      server.stopped.push(body.session_id); server.otherSession = null; server.version += 1;
      return json({ command: { id: body.command_id, kind: body.kind, target_id: body.session_id, status: "applied",
        applied_at: "2026-10-06T10:00:00Z", object_version: null, action_id: null, result_id: null, context_id: null },
        current: { session_id: body.session_id, status: "closed", close_reason: "remote_stop" }, state_version: String(server.version) });
    }
    return json({ error: { code: "UNEXPECTED" } }, 500);
  });
  const lockSet = options.locks ? locks() : null;
  const nav = lockSet?.navigator ?? ({} as Navigator);
  let next = 100;
  const window = () => {
    const states: EntryState[] = [];
    const closeWindow = vi.fn();
    let controller: EntryController | null = null;
    const http: HttpOptions = { fetcher: fetcher as unknown as typeof fetch, timeoutMs: 1000, maxResponseBytes: 100000,
      onDocumentStale: () => controller?.documentStale() };
    controller = new EntryController({ api: createEntryApi(http), storage, lock: browserDocumentLock(nav),
      remote: { api: createRemoteSessionApi(http), pendingStore: new RemoteStopPendingStore(storage) },
      initData: "signed", savedLanguage: "ru", browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1",
      timeZone: () => "UTC", newId: () => id(next++), onUpdate: ({ state }) => { states.push(state); }, closeWindow });
    const read = (path: string) => createJsonTransport(http)(path, { method: "GET", token: "token", proof: "proof" });
    return { controller: controller!, states, closeWindow, read, latest: () => states.at(-1) };
  };
  const eventsOf = (document: string) => opens.filter(body => body.document_id === document).map(body => body.event);
  return { server, opens, fetcher, window, eventsOf, locks: lockSet };
}

describe("the replaced window and the remote stop of another installation", () => {
  it("A busy with another installation's session, B takes the document: A's confirmed remote stop is refused and A closes", async () => {
    const d = device({ otherSession: id(50) });
    const a = d.window(); await a.controller.start();
    expect(a.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    const old = d.opens[0].document_id;
    const b = d.window(); await b.controller.start();
    expect(b.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    a.controller.requestRemoteStop();
    expect(a.latest()).toEqual({ kind: "remote_confirm", targetId: id(50) });
    await a.controller.confirmRemoteStop();
    await vi.waitFor(() => expect(a.closeWindow).toHaveBeenCalledOnce());
    expect(a.latest()).toEqual({ kind: "replaced" });
    expect(d.server.stopped).toEqual([]);
    expect(d.server.otherSession).toBe(id(50));
    expect(d.eventsOf(old)).toEqual(["open", "foreground"]);
    await settle();
    expect(b.closeWindow).not.toHaveBeenCalled();
    expect(d.server.document).toBe(d.opens[1].document_id);
  });

  it("with Web Locks a busy window (another installation's session) is closed by the newer busy window's lock", async () => {
    const d = device({ otherSession: id(50), locks: true });
    const a = d.window(); await a.controller.start();
    await vi.waitFor(() => expect(d.locks!.held.size).toBe(1));
    const b = d.window(); await b.controller.start();
    await vi.waitFor(() => expect(a.closeWindow).toHaveBeenCalledOnce());
    expect(a.latest()).toEqual({ kind: "replaced" });
    expect(b.latest()).toEqual({ kind: "busy", remoteTarget: id(50) });
    expect(b.closeWindow).not.toHaveBeenCalled();
    expect(d.eventsOf(d.opens[0].document_id)).toEqual(["open"]);
  });
});

describe("DOCUMENT_STALE through the shared transport", () => {
  it("a live window's GET refused as DOCUMENT_STALE (a closed card context) stays open after its foreground", async () => {
    const d = device();
    const only = d.window(); await only.controller.start();
    d.server.contextClosed = true;
    const reply = await only.read(`/dictionary/contexts/${id(9)}?document_id=${d.opens[0].document_id}`);
    expect(reply.status).toBe(409);
    await settle();
    expect(d.eventsOf(d.opens[0].document_id)).toEqual(["open", "foreground"]);
    expect(only.latest()).toEqual({ kind: "opened" });
    expect(only.closeWindow).not.toHaveBeenCalled();
    expect(only.controller.getOpenedAccess()).not.toBeNull();
  });

  it("a replaced window's GET refused as DOCUMENT_STALE closes it after one foreground, and never sends open again", async () => {
    const d = device();
    const a = d.window(); await a.controller.start();
    const old = d.opens[0].document_id;
    const b = d.window(); await b.controller.start();
    await a.read(`/dictionary/contexts/${id(9)}?document_id=${old}`);
    await vi.waitFor(() => expect(a.closeWindow).toHaveBeenCalledOnce());
    await a.controller.retry(); await a.controller.foreground();
    await a.read(`/dictionary/contexts/${id(9)}?document_id=${old}`); await settle();
    expect(d.eventsOf(old)).toEqual(["open", "foreground"]);
    expect(b.closeWindow).not.toHaveBeenCalled();
    expect(d.server.document).toBe(d.opens[1].document_id);
  });

  it("several refusals in one burst send one foreground", async () => {
    const d = device();
    const a = d.window(); await a.controller.start();
    const old = d.opens[0].document_id;
    const b = d.window(); await b.controller.start();
    await Promise.all([1, 2, 3].map(() => a.read(`/dictionary/contexts/${id(9)}?document_id=${old}`)));
    await vi.waitFor(() => expect(a.closeWindow).toHaveBeenCalledOnce());
    await settle();
    expect(d.eventsOf(old)).toEqual(["open", "foreground"]);
    expect(b.latest()).toEqual({ kind: "opened" });
  });
});
