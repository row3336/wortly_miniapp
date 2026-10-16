// M-P03-10 through the integration chain Entry → write gate → transport → decoder/store, on the gate's manual clock
// with a synthetic core that also answers GET /availability (the probe goes through the same transport): К-11 / К-9а of
// the working window, К-9 → К-7 of a window without a document, §4.13 routes, п.8б at the entry, the late registration
// after 403, the first open held by the outage mark, remoteAction, and R10 with reload, late answers and negative controls.
import { describe, expect, it, vi } from "vitest";
import { TestEntryController } from "./entryInstallation.test-support";
import { createEntryApi } from "../api/entryApi";
import { createAvailabilityClient } from "../api/availability";
import type { HttpOptions } from "../api/http";
import { createRemoteSessionApi } from "../study/remoteSessionApi";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import type { AsyncStorage } from "../platform/storage";
import { WriteGate } from "../commands/writeGate";
import { ManualClock, settle } from "../commands/writeGate.test-support";
import type { EntrySnapshot } from "./entryController";
import { createTodayApi } from "../today/todayApi";
import { createJsonTransport } from "../api/http";
import { hasPending, pendingRaw } from "../commands/pendingSeed.test-support";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = uuid(1), TARGET = uuid(50);
const profile = (version = "10") => ({ profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: version, access: { status: "admitted", version: "1", reason: null } });
const compatibility = { compatible: true, contract_version: "1" };
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
const envelope = (code: string, status: number, extra: Record<string, unknown> = {}) => json({ error: { code, ...extra } }, status);

type OpenBody = { event: string; document_id: string; client_instance_id: string; return_marker?: string };
type Reply = Response | "network" | Promise<Response | "network"> | (() => Response | "network" | Promise<Response | "network">);

function memory(): AsyncStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
}

/** The synthetic core. Every reply can be scripted once; by default open answers opened (or SESSION_BUSY while busy). */
function chain(options: { outage?: { retryAfterS: number | null }; storage?: ReturnType<typeof memory>; ids?: number } = {}) {
  const clock = new ManualClock();
  const opens: OpenBody[] = [];
  const calls: string[] = [];
  const script = { open: [] as Reply[], availability: [] as Response[], status: [] as Reply[], stop: [] as Reply[],
    register: [] as Reply[], busy: false, epoch: "1", version: "10", registerFailAt: 0 };
  let registers = 0;
  let instance = "";
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = new URL(String(url), "http://localhost"), path = address.pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const take = async (queue: Reply[], fallback: () => Response): Promise<Response> => {
      const item = queue.length ? queue.shift()! : fallback;
      const next = await (typeof item === "function" ? item() : item);
      if (next === "network") throw new TypeError("network");
      return next;
    };
    if (path === "/availability") return script.availability.shift() ?? json({ status: "ready", retry_after_s: null });
    if (path === "/auth/telegram") return json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z", profile: profile(script.version), compatibility });
    if (path === "/client/register") {
      instance = body.client_instance_id;
      if (++registers === script.registerFailAt) throw new TypeError("network");
      return take(script.register, () => json({ status: "registered", client_instance_id: body.client_instance_id,
        origin_proof: "proof", proof_version: "1", activated: false }));
    }
    if (path === "/client/open") {
      opens.push(body);
      return take(script.open, () => script.busy
        ? json({ status: "SESSION_BUSY", profile: profile(script.version), compatibility, session: { status: "busy", stop_remote_target: TARGET } })
        : json({ status: "opened", client_instance_id: body.client_instance_id, document_id: body.document_id,
          document_epoch: script.epoch, proof_version: "1", profile: profile(script.version), session: null, compatibility }));
    }
    if (path === "/commands" && init?.method === "POST") {
      return take(script.stop, () => {
        script.busy = false; script.version = "11";
        return json({ command: { id: body.command_id, kind: "session.stop_remote", status: "applied", applied_at: "2026-10-16T00:00:00Z",
          target_id: body.session_id, object_version: null, action_id: null, result_id: null, context_id: null },
        current: { session_id: body.session_id, status: "closed", close_reason: "remote_stop" }, state_version: "11" });
      });
    }
    if (path.startsWith("/commands/")) return take(script.status, () => json({ error: { code: "UNSCRIPTED" } }, 500));
    return json({ error: { code: "NOT_FOUND" } }, 404);
  });
  const gate = new WriteGate({ clock, ...(options.outage ? { outage: options.outage } : {}) });
  const http: HttpOptions = { fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 100_000, gate };
  gate.attachProbe(createAvailabilityClient(http).probe);
  const storage = options.storage ?? memory();
  const pendingStore = new RemoteStopPendingStore(storage);
  const updates: EntrySnapshot[] = [];
  let next = options.ids ?? 100;
  const closeWindow = vi.fn();
  const controller = new TestEntryController({ gate, api: createEntryApi(http), today: createTodayApi(http),
    remote: { api: createRemoteSessionApi(http), pendingStore }, storage,
    lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData: "signed", savedLanguage: "ru",
    browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
    newId: () => uuid(next++), closeWindow, onUpdate: snapshot => updates.push(snapshot) });
  const state = () => updates.at(-1)!.state;
  const probes = () => calls.filter(call => call === "GET /availability").length;
  const posts = (path: string) => calls.filter(call => call === `POST ${path}`).length;
  return { http, clock, gate, fetcher, controller, script, opens, calls, state, probes, posts, storage, pendingStore, closeWindow,
    instance: () => instance };
}
/** A POST of a command (K01–K14) as L2 would judge it now. */
const commandAdmitted = (gate: WriteGate) => gate.admit({ method: "POST", path: "/commands", body: { command_id: uuid(900) } });

async function working(f: ReturnType<typeof chain>) {
  await f.controller.start(); await settle();
  expect(f.state()).toEqual({ kind: "opened" });
  return f.gate.snapshot().lastWorkingDoc!;
}

describe("К-11 / К-9а of the working window (the row M-P03-10)", () => {
  it.each([
    ["a refused fetch", "network" as const],
    ["502", envelope("BAD_GATEWAY", 502)],
    ["504", envelope("GATEWAY_TIMEOUT", 504)],
    ["503 WRITE_UNAVAILABLE", envelope("WRITE_UNAVAILABLE", 503)],
    ["503 without a code", json({}, 503)],
    ["500 INTERNAL_ERROR", envelope("INTERNAL_ERROR", 500)],
  ])("AC-11a/ВР-1 (%s): opened + recovering, the access stays live, net closed, the identity lock; ready → one foreground → ВР-6", async (_n, reply) => {
    const f = chain(); const doc = await working(f);
    const access = f.controller.getOpenedAccess()!;
    f.script.open.push(reply);
    await f.controller.foreground(); await settle();
    expect(f.state()).toMatchObject({ kind: "opened", recovery: "recovering", wait: { cause: "offline" } });
    expect(access.isLive()).toBe(true); expect(f.controller.unconfirmed()).toBe(true);
    // 503 WRITE_UNAVAILABLE closes as closed(unavailable) (§4.2), every other transport failure as closed(unknown).
    expect(f.gate.snapshot().net).toEqual({ kind: "closed", cause: _n === "503 WRITE_UNAVAILABLE" ? "unavailable" : "unknown" });
    expect(f.gate.snapshot().identityLock).toMatchObject({ doc, phase: "verifying" });
    expect(commandAdmitted(f.gate)).toBe("paused"); // 0 POST of K01–K14 until the identity is confirmed
    // No second request until the gate's ready: screens and stale checks send nothing (ВР-5 is the only source here).
    await f.controller.foreground(); f.controller.documentStale(); await new Promise(resolve => setTimeout(resolve, 5)); await settle();
    expect(f.opens).toHaveLength(2);
    await f.clock.advanceTo(5_000);
    expect(f.probes()).toBe(1);
    await vi.waitFor(() => expect(f.state()).toEqual({ kind: "opened" }));
    expect(f.opens.map(body => [body.event, body.document_id, "return_marker" in body])).toEqual([
      ["open", doc.documentId, false], ["foreground", doc.documentId, false], ["foreground", doc.documentId, false]]);
    expect(f.gate.snapshot().identityLock).toBeNull(); expect(f.controller.unconfirmed()).toBe(false);
    expect(commandAdmitted(f.gate)).toBeNull();
  });

  it("AC-11e/К-9а: 503 MAINTENANCE on the foreground keeps opened; 9.2.4 with the estimate; after ready one foreground", async () => {
    const f = chain(); await working(f);
    f.script.open.push(envelope("MAINTENANCE", 503, { retry_after_s: 30 }));
    await f.controller.foreground(); await settle();
    expect(f.state()).toMatchObject({ kind: "opened", recovery: "recovering", wait: { cause: "maintenance", waitSeconds: 30 } });
    expect(f.gate.snapshot().net).toEqual({ kind: "closed", cause: "maintenance" });
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.opens).toHaveLength(3));
    // ВР-6 ends К-9а for the window; the announced hold still shuts writes — the window keeps naming it (§4.8, fix1).
    await vi.waitFor(() => expect(f.state()).toMatchObject({ kind: "opened", wait: { cause: "maintenance" } }));
    expect(f.state()).not.toHaveProperty("recovery");
    expect(commandAdmitted(f.gate)).toBe("paused");
    await f.clock.advanceTo(30_001);
    expect(f.state()).toEqual({ kind: "opened" });
    expect(commandAdmitted(f.gate)).toBeNull();
  });

  it("ВР-9: the recovery foreground fails again — the same episode, the next index; ВР-10: a 503 MAINTENANCE keeps recovering", async () => {
    const f = chain(); await working(f);
    f.script.open.push("network", "network", envelope("MAINTENANCE", 503, { retry_after_s: null }));
    await f.controller.foreground(); await settle();
    const episode = f.gate.snapshot().episode!.id;
    await f.clock.advanceTo(5_000); await vi.waitFor(() => expect(f.opens).toHaveLength(3));
    await settle();
    expect(f.state()).toMatchObject({ kind: "opened", recovery: "recovering" });
    expect(f.gate.snapshot().episode).toEqual({ id: episode, index: 2 });
    await f.clock.advanceTo(15_000); await vi.waitFor(() => expect(f.opens).toHaveLength(4));
    await settle();
    expect(f.state()).toMatchObject({ kind: "opened", recovery: "recovering", wait: { cause: "maintenance" } });
    expect(f.probes()).toBe(2);
  });

  it("AC-11b/ВР-4: hidden — no probe, no foreground; shown — one foreground for visibilitychange and pageshow together", async () => {
    const f = chain(); await working(f);
    f.script.open.push("network", "network");
    await f.controller.foreground(); await settle();
    f.controller.setVisible(false); f.gate.setVisible(false);
    await f.clock.advanceTo(60_000);
    expect(f.probes()).toBe(0); expect(f.opens).toHaveLength(2);
    f.gate.setVisible(true); f.controller.setVisible(true);
    await Promise.all([f.controller.foreground(), f.controller.foreground()]); await settle();
    expect(f.opens).toHaveLength(3);
    expect(f.opens[2]).toMatchObject({ event: "foreground", document_id: f.opens[0].document_id });
    // AC-68: a second show within 5 s of that send is suppressed (no request), the series starts again at 5 s.
    f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground(); await settle();
    expect(f.opens).toHaveLength(3);
  });

  it.each([
    ["ВР-7: 409 DOCUMENT_STALE", envelope("DOCUMENT_STALE", 409), { kind: "replaced" }],
    ["ВР-8: another epoch", "epoch", { kind: "closed", reason: "identity" }],
    ["ВР-8б: SESSION_BUSY", "busy", { kind: "closed", reason: "busy" }],
  ])("AC-11c/d (%s): the window closes for good — closedWindow refuses every request; ready changes nothing", async (_n, reply, closed) => {
    const f = chain(); await working(f);
    f.script.open.push("network");
    await f.controller.foreground(); await settle();
    if (reply === "epoch") f.script.epoch = "2";
    else if (reply === "busy") f.script.busy = true;
    else f.script.open.push(reply as Response);
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.state()).toEqual(closed));
    expect(f.gate.snapshot().closedWindow).not.toBeNull();
    expect(f.closeWindow).toHaveBeenCalledOnce();
    for (const request of [{ method: "GET", path: "/today" }, { method: "POST", path: "/auth/telegram" },
      { method: "POST", path: "/commands", body: { command_id: uuid(901), kind: "session.stop_remote" } },
      { method: "POST", path: "/client/open", body: { event: "foreground", document_id: f.opens[0].document_id } }]) {
      expect(f.gate.admit(request)).toBe("closed_window");
    }
    const count = f.fetcher.mock.calls.length;
    await f.controller.foreground(); await f.controller.retry(); await f.clock.advanceTo(120_000);
    expect(f.fetcher.mock.calls.length).toBe(count);
  });

  it("AC-94/AC-73: a 4xx on the recovery foreground — unavailable, route А; the lock stays verifying; one manual check", async () => {
    const f = chain(); const doc = await working(f);
    f.script.open.push("network", envelope("SYNTHETIC_REFUSAL", 422));
    await f.controller.foreground(); await settle();
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.state()).toMatchObject({ kind: "unavailable", route: "document" }));
    expect(f.state()).toMatchObject({ checkable: true });
    expect(f.gate.snapshot().identityLock).toMatchObject({ doc, phase: "verifying" });
    expect(f.gate.snapshot().lastWorkingDoc).toEqual(doc);
    let finish!: (reply: Response) => void;
    f.script.open.push(new Promise<Response>(resolve => { finish = resolve; }));
    const check = f.controller.retry(); await settle();
    expect(f.state()).toMatchObject({ kind: "unavailable", route: "document" });
    expect(f.state()).not.toHaveProperty("checkable"); // in flight: the button is inactive
    void f.controller.retry(); await settle(); expect(f.opens).toHaveLength(4); // a second press in flight sends nothing
    finish(json({ status: "opened", client_instance_id: f.instance(), document_id: doc.documentId, document_epoch: "1",
      proof_version: "1", profile: profile(), session: null, compatibility }));
    await check; await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.opens.at(-1)).toMatchObject({ event: "foreground", document_id: doc.documentId });
    expect(f.opens.some(body => body.event === "open" && f.opens.indexOf(body) > 0)).toBe(false);
    expect(f.gate.snapshot().identityLock).toBeNull();
  });

  it("AC-51/AC-41 (gate part): a readback asked under the lock waits for ВР-6 and then runs once", async () => {
    const f = chain(); await working(f);
    f.gate.registerPending("lane", uuid(700));
    f.script.open.push("network");
    await f.controller.foreground(); await settle();
    const read = vi.fn(async () => "checked");
    const deferred = f.gate.runReadback(uuid(700), read);
    await settle();
    expect(read).not.toHaveBeenCalled();
    await f.clock.advanceTo(5_000);
    await expect(deferred).resolves.toBe("checked");
    expect(read).toHaveBeenCalledOnce();
    // The round keeps the lock until the pending's definite answer (Z3/Z4); the window shows 9.2.1 meanwhile.
    expect(f.state()).toMatchObject({ kind: "opened", checking: true, wait: { cause: "checking" } });
    f.gate.resolvePending(uuid(700), "recorded"); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("Z5 (AC-36/AC-63): 401 on the recovery foreground — expired; the locks, the registry and lastWorkingDoc are gone", async () => {
    const f = chain(); await working(f);
    f.gate.registerPending("lane", uuid(701));
    f.script.open.push("network", envelope("AUTH_EXPIRED", 401));
    await f.controller.foreground(); await settle();
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true }));
    expect(f.gate.snapshot()).toMatchObject({ identityLock: null, lastWorkingDoc: null, familyLocks: [] });
    expect(f.gate.hasUnsettledPending()).toBe(false);
  });
});

describe("К-9 → К-7 and §4.13 В of a window without a working document (0 automatic open)", () => {
  it("AC-11j: 503 MAINTENANCE on the first open — a wait without a button until ready and the hold end, then blocked", async () => {
    const f = chain();
    f.script.open.push(envelope("MAINTENANCE", 503, { retry_after_s: 40 }));
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable", waiting: true, wait: { cause: "maintenance", waitSeconds: 40 } });
    await f.clock.advanceTo(5_000);
    expect(f.probes()).toBe(1);
    expect(f.state()).toMatchObject({ kind: "unavailable", waiting: true });
    await f.clock.advanceTo(40_001);
    expect(f.state()).toEqual({ kind: "unavailable" }); // К-7: the button, blocked until Я19 (route В)
    await f.controller.retry(); await f.clock.advanceTo(200_000);
    expect(f.opens).toHaveLength(1); expect(f.posts("/auth/telegram")).toBe(1); expect(f.posts("/client/register")).toBe(1);
  });

  it("AC-11i/AC-99: a 502 on the first open — the button is blocked; after ready nothing leaves; a direct open is k5_denied", async () => {
    const f = chain();
    f.script.open.push(envelope("BAD_GATEWAY", 502));
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable" });
    await f.clock.advanceTo(5_000);
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(1);
    expect(f.gate.admit({ method: "POST", path: "/client/open", body: { event: "open", document_id: f.opens[0].document_id }, origin: "user" }))
      .toBe("k5_denied");
  });

  it("AC-107: a definite 403 FORBIDDEN after a late registration repeats the same open exactly once", async () => {
    const f = chain();
    f.script.open.push(envelope("FORBIDDEN", 403));
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.opens.map(body => [body.event, body.document_id])).toEqual([["open", f.opens[0].document_id], ["open", f.opens[0].document_id]]);
    expect(f.posts("/client/register")).toBe(2);
    expect(f.gate.snapshot().openAttempts).toEqual([f.opens[0].document_id]);
  });

  it("AC-108 (б): a 403 with another code sets no allowance: no repeat of the open", async () => {
    const f = chain();
    f.script.open.push(envelope("ACCESS_PENDING", 403));
    await f.controller.start(); await settle();
    expect(f.opens).toHaveLength(1); expect(f.posts("/client/register")).toBe(1);
    expect(f.state()).toEqual({ kind: "unavailable" });
  });

  it("AC-108 (е): the late registration fails — the allowance is dropped, nothing is repeated", async () => {
    const f = chain();
    f.script.open.push(envelope("FORBIDDEN", 403));
    f.script.registerFailAt = 2;
    await f.controller.start(); await settle();
    expect(f.opens).toHaveLength(1); expect(f.gate.retryAfter403Pending()).toBeNull();
  });

  it("AC-45/T28s: the outage mark holds the first open — none before ready, the hold end and a fresh probe; then one", async () => {
    const f = chain({ outage: { retryAfterS: 40 } });
    const starting = f.controller.start(); await settle();
    expect(f.posts("/auth/telegram")).toBe(1); expect(f.posts("/client/register")).toBe(1);
    expect(f.opens).toHaveLength(0);
    expect(f.state()).toMatchObject({ kind: "unavailable", waiting: true });
    await f.clock.advanceTo(5_000);
    expect(f.opens).toHaveLength(0); expect(f.gate.snapshot().openAttempts).toEqual([]);
    await f.clock.advanceTo(40_001);
    await vi.waitFor(() => expect(f.opens).toHaveLength(1));
    expect(f.probes()).toBe(2); // the series' ready at 5 s and the fresh probe R-12 at the end of the hold
    await starting;
    expect(f.state()).toEqual({ kind: "opened" });
  });
});

describe("remoteAction and R10 (the own stop_remote in busy/remote without opened)", () => {
  async function seeded(command: number, storage = memory()) {
    // A previous page of this installation confirmed a stop and lost its reply: the record and the installation remain.
    const store = new RemoteStopPendingStore(storage);
    storage.values.set(`wortly.installation:${PROFILE}`, JSON.stringify({ profileId: PROFILE, clientInstanceId: uuid(60),
      registrationId: uuid(61), proof: "proof", proofVersion: "1", activated: true }));
    await store.save({ schemaVersion: 1, profileId: PROFILE, clientInstanceId: uuid(60), intent: { command_id: uuid(command),
      kind: "session.stop_remote", session_id: TARGET, payload: { confirmed: true } } }, new AbortController().signal);
    return storage;
  }
  const status = (command: number, current: unknown) => json({ command: { id: uuid(command), kind: "session.stop_remote",
    status: "already_applied", applied_at: "2026-10-16T00:00:00Z", target_id: TARGET, object_version: null, action_id: null,
    result_id: null, context_id: null }, current, state_version: "11" });

  it("AC-106: after a confirmed stop the window opens by one foreground of its own document, never a new open", async () => {
    const f = chain(); f.script.busy = true;
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.opens.map(body => body.event)).toEqual(["open", "foreground"]);
    expect(f.opens[1].document_id).toBe(f.opens[0].document_id);
    expect(f.gate.snapshot().openAttempts).toEqual([f.opens[0].document_id]);
  });

  it("AC-118/AC-111 (а): a reload with the pending stop — the first open does not wait for a GET; busy → narrow read → settled → one foreground", async () => {
    const storage = await seeded(800);
    const f = chain({ storage }); f.script.busy = true;
    f.script.status.push(() => { f.script.busy = false; f.script.version = "11";
      return status(800, { session_id: TARGET, status: "closed", close_reason: "remote_stop" }); });
    await f.controller.start(); await settle();
    const order = f.calls.filter(call => call.includes("/client/open") || call.includes("/commands/"));
    expect(order).toEqual(["POST /client/open", `GET /commands/${uuid(800)}`, "POST /client/open"]);
    expect(f.opens.map(body => body.event)).toEqual(["open", "foreground"]);
    expect(f.state()).toEqual({ kind: "opened" });
    expect(hasPending(storage.values, "wortly.pending.remote_stop")).toBe(false);
    expect(f.posts("/commands")).toBe(0);
  });

  it("AC-120: accepted of the own intent with current={status:\"unavailable\"} settles the pending — no right, no POST", async () => {
    const storage = await seeded(801);
    const f = chain({ storage }); f.script.busy = true;
    f.script.status.push(() => { f.script.busy = false; f.script.version = "11"; return status(801, { status: "unavailable" }); });
    await f.controller.start(); await settle();
    expect(hasPending(storage.values, "wortly.pending.remote_stop")).toBe(false);
    expect(f.posts("/commands")).toBe(0);
    expect(f.opens.map(body => body.event)).toEqual(["open", "foreground"]);
  });

  it("AC-111 (б)/AC-119: not_found keeps the pending — the remote screen, 0 automatic POST, the manual route", async () => {
    const storage = await seeded(802);
    const f = chain({ storage }); f.script.busy = true;
    f.script.status.push(json({ command: { id: uuid(802), status: "not_found" }, current: profile(), state_version: "10" }));
    await f.controller.start(); await settle(); await f.clock.advanceTo(60_000);
    expect(f.state()).toMatchObject({ kind: "remote", remote: { pending: true, problem: "not_found", phase: "unresolved" } });
    expect(f.posts("/commands")).toBe(0);
    expect(hasPending(storage.values, "wortly.pending.remote_stop")).toBe(true);
    expect(f.opens).toHaveLength(1);
  });

  it("AC-118: the reloaded first open fails — the pending stays, 0 automatic open afterwards", async () => {
    const storage = await seeded(803);
    const f = chain({ storage });
    f.script.open.push(envelope("BAD_GATEWAY", 502));
    await f.controller.start(); await settle(); await f.clock.advanceTo(120_000);
    expect(f.opens).toHaveLength(1);
    expect(f.calls.some(call => call.startsWith("GET /commands/"))).toBe(false);
    expect(hasPending(storage.values, "wortly.pending.remote_stop")).toBe(true);
  });

  it("AC-116: the window goes unavailable while the GET runs — the late accepted changes nothing, the pending stays", async () => {
    const storage = await seeded(804);
    const f = chain({ storage }); f.script.busy = true;
    let answer!: (reply: Response) => void;
    f.script.status.push(new Promise<Response>(resolve => { answer = resolve; }));
    const starting = f.controller.start();
    await vi.waitFor(() => expect(f.calls).toContain(`GET /commands/${uuid(804)}`));
    f.gate.noteAccessLost(); // what an `unavailable` of this generation does to the context (R10 п.3)
    answer(status(804, { session_id: TARGET, status: "closed", close_reason: "remote_stop" }));
    await starting; await settle();
    expect(hasPending(storage.values, "wortly.pending.remote_stop")).toBe(true);
    expect(f.opens.map(body => body.event)).toEqual(["open"]);
  });
});

describe("N3/visibility at the entry (C365): no automatic request of a hidden window; the show resumes once", () => {
  it("К-11: a ready while hidden sends no recovery foreground; the show sends one (ВР-3, ВР-4)", async () => {
    const f = chain(); await working(f);
    f.script.open.push("network");
    await f.controller.foreground(); await settle();
    // The probe of the series is in flight when the window is hidden; its ready lands while hidden.
    let answer!: (reply: Response) => void;
    const original = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes("/availability")
      ? new Promise<Response>(resolve => { answer = resolve; }) : original(url, init));
    await f.clock.advanceTo(5_000);
    f.controller.setVisible(false); f.gate.setVisible(false);
    answer(json({ status: "ready", retry_after_s: null })); await settle(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.gate.snapshot().net.kind).toBe("open");
    expect(f.opens).toHaveLength(2);
    f.fetcher.mockImplementation(original);
    f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground(); await settle();
    expect(f.opens).toHaveLength(3);
    expect(f.opens[2]).toMatchObject({ event: "foreground", document_id: f.opens[0].document_id });
    await vi.waitFor(() => expect(f.state()).toEqual({ kind: "opened" }));
  });

  it("T28s: the end of the hold while hidden hands no first open to L2; the show does, once, after a fresh probe", async () => {
    const f = chain({ outage: { retryAfterS: 40 } });
    const starting = f.controller.start(); await settle();
    await f.clock.advanceTo(5_000); // ready of the series
    f.controller.setVisible(false); f.gate.setVisible(false);
    await f.clock.advanceTo(60_000); // the hold ends while hidden
    expect(f.opens).toHaveLength(0); expect(f.gate.snapshot().openAttempts).toEqual([]);
    const probes = f.probes();
    f.gate.setVisible(true); f.controller.setVisible(true);
    await starting;
    expect(f.opens).toHaveLength(1);
    expect(f.probes()).toBe(probes + 1); // ready of 5 s is older than 10 s: one fresh probe before the open
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("R10: the confirmed own stop answered while hidden opens nothing before the show; then one foreground", async () => {
    const storage = memory();
    storage.values.set(`wortly.installation:${PROFILE}`, JSON.stringify({ profileId: PROFILE, clientInstanceId: uuid(60),
      registrationId: uuid(61), proof: "proof", proofVersion: "1", activated: true }));
    await new RemoteStopPendingStore(storage).save({ schemaVersion: 1, profileId: PROFILE, clientInstanceId: uuid(60),
      intent: { command_id: uuid(805), kind: "session.stop_remote", session_id: TARGET, payload: { confirmed: true } } },
    new AbortController().signal);
    const f = chain({ storage }); f.script.busy = true;
    let answer!: (reply: Response) => void;
    f.script.status.push(new Promise<Response>(resolve => { answer = resolve; }));
    const starting = f.controller.start();
    await vi.waitFor(() => expect(f.calls).toContain(`GET /commands/${uuid(805)}`));
    f.controller.setVisible(false); f.gate.setVisible(false);
    f.script.busy = false; f.script.version = "11";
    answer(json({ command: { id: uuid(805), kind: "session.stop_remote", status: "already_applied", applied_at: "2026-10-16T00:00:00Z",
      target_id: TARGET, object_version: null, action_id: null, result_id: null, context_id: null },
    current: { session_id: TARGET, status: "closed", close_reason: "remote_stop" }, state_version: "11" }));
    await settle(); await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.opens).toHaveLength(1);
    expect(hasPending(storage.values, "wortly.pending.remote_stop")).toBe(false);
    f.gate.setVisible(true); f.controller.setVisible(true);
    await starting;
    expect(f.opens.map(body => body.event)).toEqual(["open", "foreground"]);
  });

  it("a closed window resumes nothing on a show (§4.12)", async () => {
    const f = chain(); await working(f);
    f.script.open.push("network", envelope("DOCUMENT_STALE", 409));
    await f.controller.foreground(); await settle();
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.state()).toEqual({ kind: "replaced" }));
    const count = f.fetcher.mock.calls.length;
    f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground(); await f.clock.advanceTo(300_000);
    expect(f.fetcher.mock.calls.length).toBe(count);
  });
});

describe("fix1 (QA M-P03-9/10): the entry", () => {
  it("QA-E1: an unreadable 2xx on the ordinary foreground — К-11 with net closed; ready brings one foreground (no hang)", async () => {
    const f = chain(); const doc = await working(f);
    f.script.open.push(new Response("<html>proxy</html>", { status: 200, headers: { "content-type": "text/html" } }));
    await f.controller.foreground(); await settle();
    expect(f.state()).toMatchObject({ kind: "opened", recovery: "recovering" });
    expect(f.gate.snapshot().net).toEqual({ kind: "closed", cause: "unknown" });
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.state()).toEqual({ kind: "opened" }));
    expect(f.opens.map(body => [body.event, body.document_id])).toEqual([["open", doc.documentId], ["foreground", doc.documentId],
      ["foreground", doc.documentId]]);
  });

  it("C388 (fix5, N14): SESSION_BUSY on an ordinary foreground of a working window closes it — no busy Today, no Stop, 0 requests after; the pending stays", async () => {
    const f = chain(); const doc = await working(f);
    f.gate.registerPending("lane", uuid(703));
    f.storage.values.set("wortly.pending.synthetic_lane", JSON.stringify({ command_id: uuid(703) })); // a saved pending
    const saved = JSON.stringify([...f.storage.values]);
    f.script.busy = true;
    await f.controller.foreground(); await settle(); // a generic screen synchronization (Today, pair, stale check)
    expect(f.state()).toEqual({ kind: "closed", reason: "busy" });
    expect(f.closeWindow).toHaveBeenCalledOnce();
    expect(f.gate.snapshot().remoteReadContext).toBe(false);
    expect(f.gate.snapshot().closedWindow).toMatchObject({ doc }); // Z5′ of that working document (§4.12)
    const count = f.fetcher.mock.calls.length;
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop();
    await f.controller.foreground(); await f.controller.foreground("show"); await f.controller.retry();
    f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground("show"); await f.clock.advanceTo(300_000); await settle();
    expect(f.fetcher.mock.calls.length).toBe(count); // no GET, POST, ready, show or retry after the closure
    expect(JSON.stringify([...f.storage.values])).toBe(saved); // nothing saved is dropped: the next window checks it
  });

  it("QA-C5 (C373): a reapply refused with 409 VERSION_CONFLICT — the button reads the current profile: one sign-in, 0 reapply, 0 open", async () => {
    const f = chain();
    const base = f.fetcher.getMockImplementation()!;
    let accessVersion = "1";
    f.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname.replace("/api/v1", "");
      if (path === "/auth/telegram") return json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z",
        profile: { ...profile(), access: { status: "rejected", version: accessVersion, reason: null } }, compatibility });
      if (path === "/access/reapply") { accessVersion = "2"; return envelope("VERSION_CONFLICT", 409); }
      return base(url, init);
    });
    await f.controller.start(); await settle();
    await f.controller.reapply(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable", route: "profile", checkable: true });
    const calls = (part: string) => f.fetcher.mock.calls.filter(call => String(call[0]).includes(part)).length;
    const before = calls("/auth/telegram");
    await f.controller.retry(); await settle();
    expect(f.state()).toMatchObject({ kind: "rejected" });
    expect(calls("/auth/telegram") - before).toBe(1);
    expect(calls("/access/reapply")).toBe(1);
    expect(f.opens).toHaveLength(0);
  });

  // В4-Б (C390) replaces the earlier «never opens»: an admitted current profile continues the first entry of a page that never
  // handed an open to L2 — one first open; the old reapply ID is not sent again (entryProfileFirstOpen.test.ts in detail).
  it("the profile refresh of a page without any open attempt continues its first entry once the profile is admitted", async () => {
    const f = chain();
    const base = f.fetcher.getMockImplementation()!;
    let status: "rejected" | "admitted" = "rejected";
    f.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname.replace("/api/v1", "");
      if (path === "/auth/telegram") return json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z",
        profile: { ...profile(), access: { status, version: status === "rejected" ? "1" : "2", reason: null } }, compatibility });
      if (path === "/access/reapply") { status = "admitted"; return envelope("VERSION_CONFLICT", 409); }
      if (path === "/client/open") {
        // The core's open answers with the same current profile as its auth (a strict DTO: access version 2).
        const body = JSON.parse(String(init!.body));
        f.opens.push(body);
        return json({ status: "opened", client_instance_id: body.client_instance_id, document_id: body.document_id,
          document_epoch: "1", proof_version: "1", session: null, compatibility,
          profile: { ...profile(), access: { status: "admitted", version: "2", reason: null } } });
      }
      return base(url, init);
    });
    await f.controller.start(); await f.controller.reapply(); await settle();
    await f.controller.retry(); await settle();
    expect(f.opens.map(body => body.event)).toEqual(["open"]); expect(f.posts("/client/register")).toBe(1);
    expect(f.fetcher.mock.calls.filter(call => String(call[0]).includes("/access/reapply"))).toHaveLength(1);
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("QA-N3b (C365): the answer of a manual confirmRemoteStop while hidden — no foreground until the show, then one", async () => {
    const f = chain(); f.script.busy = true;
    await f.controller.start(); await settle();
    let answer!: () => void;
    const held = new Promise<void>(resolve => { answer = resolve; });
    f.script.stop.push(async () => {
      await held; f.script.busy = false; f.script.version = "11";
      const last = JSON.parse(String(f.fetcher.mock.calls.at(-1)![1]!.body));
      return json({ command: { id: last.command_id, kind: "session.stop_remote", status: "applied", applied_at: "2026-10-16T00:00:00Z",
        target_id: last.session_id, object_version: null, action_id: null, result_id: null, context_id: null },
      current: { session_id: last.session_id, status: "closed", close_reason: "remote_stop" }, state_version: "11" });
    });
    f.controller.requestRemoteStop();
    const confirming = f.controller.confirmRemoteStop();
    await vi.waitFor(() => expect(f.posts("/commands")).toBe(1));
    f.controller.setVisible(false); f.gate.setVisible(false);
    answer(); await confirming; await settle();
    expect(f.opens.map(body => body.event)).toEqual(["open"]);
    f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground(); await settle();
    expect(f.opens.map(body => body.event)).toEqual(["open", "foreground"]);
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("AC-116 wiring (X25): the window going unavailable from busy voids the narrow context through the controller", async () => {
    const f = chain(); f.script.busy = true;
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    expect(f.gate.snapshot().remoteReadContext).toBe(true);
    f.script.open.push(envelope("SYNTHETIC_REFUSAL", 422));
    await f.controller.foreground(); await settle();
    expect(f.state()).toMatchObject({ kind: "unavailable" });
    expect(f.gate.snapshot().remoteReadContext).toBe(false);
  });

  it("X10 (§4.10, P02-W К-9): a first open kept on the client (PAUSED) waits without a button, then the blocked К-7 — 0 open", async () => {
    const f = chain();
    f.script.register.push(() => { f.gate.closeByFailure(); return json({ status: "registered", client_instance_id: f.instance(),
      origin_proof: "proof", proof_version: "1", activated: false }); });
    await f.controller.start(); await settle();
    expect(f.state()).toMatchObject({ kind: "unavailable", waiting: true });
    expect(f.opens).toHaveLength(0); expect(f.gate.snapshot().openAttempts).toHaveLength(1);
    await f.clock.advanceTo(5_000);
    expect(f.state()).toEqual({ kind: "unavailable" });
    await f.controller.retry(); await f.clock.advanceTo(100_000);
    expect(f.opens).toHaveLength(0);
  });

  it("X14 (AC-105): a 4xx with the core's envelope on the recovery foreground does not end the episode", async () => {
    const f = chain(); await working(f);
    f.script.open.push("network", envelope("SYNTHETIC_REFUSAL", 422));
    await f.controller.foreground(); await settle();
    const episode = f.gate.snapshot().episode!.id;
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.state()).toMatchObject({ kind: "unavailable", route: "document" }));
    expect(f.gate.snapshot().episode?.id).toBe(episode);
  });

  it("§4.8 (fix1): a hold announced by a 503 MAINTENANCE of a command names its wait over the working window", async () => {
    const f = chain(); await working(f);
    f.gate.closeByMaintenance(30);
    await settle();
    expect(f.state()).toEqual({ kind: "opened", wait: { cause: "maintenance", waitSeconds: 30 } });
    await f.clock.advanceTo(5_000); // ready: the hold still runs
    expect(f.state()).toEqual({ kind: "opened", wait: { cause: "maintenance", waitSeconds: 25 } });
    await f.clock.advanceTo(30_001);
    expect(f.state()).toEqual({ kind: "opened" });
  });
});

describe("fix2 (C381): SESSION_BUSY by transition — cold busy / a refused start's «На Сегодня» / the return / recovery", () => {
  it("(1) cold busy: the busy Today, one confirmed stop POST; its lost reply is read by its own ID through R10 — no second POST", async () => {
    const f = chain(); f.script.busy = true;
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    f.script.stop.push(() => { f.script.busy = false; f.script.version = "11"; return "network"; }); // applied, reply lost
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    expect(f.posts("/commands")).toBe(1);
    expect(f.state()).toMatchObject({ kind: "remote", remote: { pending: true, problem: "network" } });
    const stopId = JSON.parse(String(f.fetcher.mock.calls.find(call => String(call[0]).endsWith("/commands"))![1]!.body)).command_id;
    f.script.status.push(json({ command: { id: stopId, kind: "session.stop_remote", status: "already_applied", applied_at: "2026-10-16T00:00:00Z",
      target_id: TARGET, object_version: null, action_id: null, result_id: null, context_id: null },
    current: { session_id: TARGET, status: "closed", close_reason: "remote_stop" }, state_version: "11" }));
    await f.controller.checkRemoteStop(); await settle();
    expect(f.calls).toContain(`GET /commands/${stopId}`);
    expect(f.posts("/commands")).toBe(1);
    // Opened (the lost reply closed net until the next ready: the window names that wait, §4.8).
    expect(f.state()).toMatchObject({ kind: "opened" });
    expect(f.opens.map(body => body.event)).toEqual(["open", "foreground"]);
  });

  it("(2) П01/В4: the «На Сегодня» of a refused start (its П01 episode) of a working window gives the busy Today with Stop", async () => {
    const f = chain(); const doc = await working(f);
    await createJsonTransport(f.http)("/commands", { method: "POST", body: { command_id: uuid(704), kind: "session.start",
      session_id: uuid(705), payload: { mode: "written", bucket: "words" }, client_instance_id: f.instance(),
      document_id: doc.documentId } }).catch(() => undefined);
    expect(f.gate.noteStartBusy(uuid(704))).toBe(true);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(704) }); await settle(); // the refusal's «На Сегодня»
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    expect(f.closeWindow).not.toHaveBeenCalled();
    expect(f.gate.snapshot().closedWindow).toBeNull();
    // Cancel posts nothing; the confirmed stop is one POST (П01).
    f.controller.requestRemoteStop(); f.controller.cancelRemoteStop();
    expect(f.posts("/commands")).toBe(1); // the refused start only
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    expect(f.posts("/commands")).toBe(2);
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("(2, C388) without a П01 episode no Stop exists: the window closed by the busy foreground posts no stop and reads no status", async () => {
    const f = chain(); await working(f);
    f.script.busy = true;
    await f.controller.foreground(); await settle();
    expect(f.state()).toEqual({ kind: "closed", reason: "busy" });
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    void f.controller.checkRemoteStop(); await settle(); await f.clock.advanceTo(60_000);
    expect(f.calls.some(call => call.startsWith("GET /commands/"))).toBe(false);
    expect(f.posts("/commands")).toBe(0);
  });

  it("(3) N14: the real return (show) of a working window answered SESSION_BUSY closes it — no busy Today, no Stop", async () => {
    const f = chain(); await working(f);
    f.script.busy = true;
    await f.controller.foreground("show"); await settle();
    expect(f.state()).toEqual({ kind: "closed", reason: "busy" });
    expect(f.closeWindow).toHaveBeenCalledOnce();
    expect(f.gate.admit({ method: "POST", path: "/commands", body: { command_id: uuid(991), kind: "session.stop_remote" } })).toBe("closed_window");
    const count = f.fetcher.mock.calls.length;
    await f.controller.foreground("show"); await f.clock.advanceTo(120_000);
    expect(f.fetcher.mock.calls.length).toBe(count);
  });

  it("(4) ВР-8б: the recovery foreground answered SESSION_BUSY closes for good; the pending stays; 0 requests after ready/show", async () => {
    const f = chain(); await working(f);
    f.gate.registerPending("lane", uuid(702));
    f.script.open.push("network");
    await f.controller.foreground(); await settle();
    f.script.busy = true;
    await f.clock.advanceTo(5_000);
    await vi.waitFor(() => expect(f.state()).toEqual({ kind: "closed", reason: "busy" }));
    const count = f.fetcher.mock.calls.length;
    f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground("show"); await f.clock.advanceTo(300_000);
    expect(f.fetcher.mock.calls.length).toBe(count);
    expect(f.gate.snapshot().remoteReadContext).toBe(false);
  });
});

describe("fix3 (C382): the П01 episode — a definite SESSION_BUSY of the own start, then «На Сегодня»", () => {
  /** The start of a study screen as its lane sends it, through the same transport, refused SESSION_BUSY by its direct reply. */
  async function refusedStart(f: ReturnType<typeof chain>, id: number, doc: { documentId: string }) {
    const request = createJsonTransport(f.http);
    await request("/commands", { method: "POST", body: { command_id: uuid(id), kind: "session.start", session_id: uuid(id + 1),
      payload: { mode: "written", bucket: "words" }, client_instance_id: f.instance(), document_id: doc.documentId } }).catch(() => undefined);
    return f.gate.noteStartBusy(uuid(id)); // what the lane's decoder of that direct reply does
  }

  it("the busy Today of the episode reads its lost stop reply by the same ID (one GET), no second POST; then opened", async () => {
    const f = chain(); const doc = await working(f);
    expect(await refusedStart(f, 600, doc)).toBe(true);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(600) }); await settle();
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    expect(f.gate.snapshot().remoteReadContext).toBe(true);
    expect(f.gate.snapshot().lastWorkingDoc).toEqual(doc);
    const before = f.posts("/commands");
    f.script.stop.push(() => { f.script.busy = false; f.script.version = "11"; return "network"; }); // applied, reply lost
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    expect(f.posts("/commands")).toBe(before + 1);
    const stopId = JSON.parse(String(f.fetcher.mock.calls.filter(call => String(call[0]).endsWith("/commands")).at(-1)![1]!.body)).command_id;
    f.script.status.push(json({ command: { id: stopId, kind: "session.stop_remote", status: "already_applied", applied_at: "2026-10-16T00:00:00Z",
      target_id: TARGET, object_version: null, action_id: null, result_id: null, context_id: null },
    current: { status: "unavailable" }, state_version: "11" }));
    await f.controller.checkRemoteStop(); await settle();
    expect(f.calls.filter(call => call === `GET /commands/${stopId}`)).toHaveLength(1);
    expect(f.posts("/commands")).toBe(before + 1);
    expect(f.state()).toMatchObject({ kind: "opened" });
    expect(hasPending(f.storage.values, "wortly.pending.remote_stop")).toBe(false);
  });

  it("a generic screen foreground (no П01 intent) of the same busy closes the window (C388); so does the intent without an episode", async () => {
    for (const [episode, intent] of [[true, false], [false, true]] as const) {
      const f = chain(); const doc = await working(f);
      if (episode) expect(await refusedStart(f, 610, doc)).toBe(true);
      f.script.busy = true;
      await f.controller.foreground("screen", intent ? { startRefused: uuid(610) } : undefined); await settle();
      expect(f.state()).toEqual({ kind: "closed", reason: "busy" });
      expect(f.gate.snapshot().remoteReadContext).toBe(false);
      expect(f.gate.p01Pending()).toBe(false); // spent or ended by that foreground
    }
  });

  it("a newer command after the refusal, a real show, a lost access or a reset end the episode", async () => {
    const f = chain(); const doc = await working(f);
    expect(await refusedStart(f, 620, doc)).toBe(true);
    await createJsonTransport(f.http)("/commands", { method: "POST", body: { command_id: uuid(630), kind: "item.mark" } }).catch(() => undefined);
    expect(f.gate.p01Pending()).toBe(false);
    expect(await refusedStart(f, 640, doc)).toBe(true);
    f.gate.noteAccessLost();
    expect(f.gate.p01Pending()).toBe(false);
    const g = chain(); const gdoc = await working(g);
    expect(await refusedStart(g, 650, gdoc)).toBe(true);
    g.script.busy = true;
    await g.controller.foreground("show", { startRefused: uuid(650) }); await settle(); // the real return: N14 closes
    expect(g.state()).toEqual({ kind: "closed", reason: "busy" });
    expect(g.gate.p01Pending()).toBe(false);
    expect(g.gate.snapshot().remoteReadContext).toBe(false);
  });

  it("the episode needs the command this gate let go last, of the live working document — not a readback, not another ID", async () => {
    const f = chain(); const doc = await working(f);
    expect(f.gate.noteStartBusy(uuid(660))).toBe(false); // nothing of that ID left this page
    expect(await refusedStart(f, 661, doc)).toBe(true);
    expect(f.gate.noteStartBusy(uuid(999))).toBe(false);
    f.gate.lockIdentity(doc);
    expect(f.gate.noteStartBusy(uuid(661))).toBe(false);
  });

  it("only the own registered stop is read, once; another family or a settled ID gets no ticket — zero transfers", async () => {
    const f = chain(); const doc = await working(f);
    expect(await refusedStart(f, 670, doc)).toBe(true);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(670) }); await settle();
    const request = createJsonTransport(f.http);
    f.gate.registerPending("settings", uuid(671));
    const before = f.fetcher.mock.calls.length;
    const context = { remoteReadContext: true } as const;
    // A forged context is no context; a real one does not read another family's ID.
    await expect(f.gate.runRemoteReadback(context, uuid(671), ticket => request(`/commands/${uuid(671)}`, { method: "GET", readbackTicket: ticket })))
      .rejects.toMatchObject({ reason: "cancelled" });
    expect(f.fetcher.mock.calls.length).toBe(before);
  });

  it("a late old reply after the document changed (Z5) changes nothing: the pending stays", async () => {
    const f = chain(); const doc = await working(f);
    expect(await refusedStart(f, 680, doc)).toBe(true);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(680) }); await settle();
    f.script.stop.push("network");
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    let answer!: (reply: Response) => void;
    f.script.status.push(new Promise<Response>(resolve => { answer = resolve; }));
    const checking = f.controller.checkRemoteStop();
    await vi.waitFor(() => expect(f.calls.some(call => call.startsWith("GET /commands/"))).toBe(true));
    const stopId = f.calls.find(call => call.startsWith("GET /commands/"))!.split("/commands/")[1];
    f.gate.resetDocument(); // the document of the episode changed meanwhile
    answer(json({ command: { id: stopId, kind: "session.stop_remote", status: "already_applied", applied_at: "2026-10-16T00:00:00Z",
      target_id: TARGET, object_version: null, action_id: null, result_id: null, context_id: null },
    current: { session_id: TARGET, status: "closed", close_reason: "remote_stop" }, state_version: "11" }));
    await checking; await settle();
    expect(hasPending(f.storage.values, "wortly.pending.remote_stop")).toBe(true);
  });
});

describe("fix3 (C383): one UUID per intent on the П01 path — lost reply, not_found and a new busy target (В4)", () => {
  it("not_found keeps the old intent unchanged, sends nothing by itself; a new target never rewrites it; the manual retry repeats exactly it", async () => {
    const f = chain(); const doc = await working(f);
    const request = createJsonTransport(f.http);
    await request("/commands", { method: "POST", body: { command_id: uuid(700), kind: "session.start", session_id: uuid(701),
      payload: { mode: "written", bucket: "words" }, client_instance_id: f.instance(), document_id: doc.documentId } }).catch(() => undefined);
    expect(f.gate.noteStartBusy(uuid(700))).toBe(true);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(700) }); await settle();
    f.script.stop.push("network"); // the stop never reached the server: lost before it
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    const stops = () => f.fetcher.mock.calls.filter(call => String(call[0]).endsWith("/commands"))
      .map(call => JSON.parse(String(call[1]!.body))).filter(body => body.kind === "session.stop_remote");
    const first = stops()[0];
    expect(first).toMatchObject({ session_id: TARGET, payload: { confirmed: true } });
    const saved = () => JSON.parse(pendingRaw(f.storage.values, "wortly.pending.remote_stop")!).intent;
    f.script.status.push(json({ command: { id: first.command_id, status: "not_found" }, current: profile(f.script.version), state_version: f.script.version }));
    await f.controller.checkRemoteStop(); await settle(); await f.clock.advanceTo(60_000);
    expect(f.state()).toMatchObject({ kind: "remote", remote: { pending: true, problem: "not_found" } });
    expect(stops()).toHaveLength(1); // not_found is no ground for an automatic POST
    expect(saved()).toEqual({ command_id: first.command_id, kind: "session.stop_remote", session_id: TARGET, payload: { confirmed: true } });
    // The manual retry of the same intent: the same command_id and the same target, once.
    await f.controller.retryRemoteStop(); await settle();
    expect(stops()).toHaveLength(2);
    expect(stops()[1]).toEqual(first);
  });
});

describe("fix4 (C384): the signal names the refusal on screen", () => {
  it("another or an older command_id does not spend the episode into a context — and the episode is gone", async () => {
    const f = chain(); const doc = await working(f);
    const request = createJsonTransport(f.http);
    await request("/commands", { method: "POST", body: { command_id: uuid(720), kind: "session.start", session_id: uuid(721),
      payload: { mode: "written", bucket: "words" }, client_instance_id: f.instance(), document_id: doc.documentId } }).catch(() => undefined);
    expect(f.gate.noteStartBusy(uuid(720))).toBe(true);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(719) }); await settle();
    expect(f.state()).toEqual({ kind: "closed", reason: "busy" }); // C388: no episode, so the ordinary N14 closure
    expect(f.gate.snapshot().remoteReadContext).toBe(false);
    expect(f.gate.p01Pending()).toBe(false);
  });
});

describe("fix5 (C388): only a proved П01 episode turns SESSION_BUSY of a working window into the busy Today", () => {
  async function refused(f: ReturnType<typeof chain>, id: number, doc: { documentId: string }) {
    await createJsonTransport(f.http)("/commands", { method: "POST", body: { command_id: uuid(id), kind: "session.start",
      session_id: uuid(id + 1), payload: { mode: "written", bucket: "words" }, client_instance_id: f.instance(),
      document_id: doc.documentId } }).catch(() => undefined);
    return f.gate.noteStartBusy(uuid(id));
  }

  it("QA7-E2-obs as a test: a generic screen synchronization answered SESSION_BUSY closes the window; Stop is refused by the gate", async () => {
    const f = chain(); await working(f);
    f.script.busy = true;
    await f.controller.foreground("screen"); await settle();
    expect(f.state()).toEqual({ kind: "closed", reason: "busy" });
    expect(f.gate.snapshot().remoteReadContext).toBe(false);
    expect(f.gate.admit({ method: "POST", path: "/commands", body: { command_id: uuid(990), kind: "session.stop_remote" } }))
      .toBe("closed_window");
  });

  it("the episode does not outlive a lock, a closure, a changed document, a lost access or a dispose", async () => {
    const breaks: [string, (f: ReturnType<typeof chain>, doc: GateDocOf) => void][] = [
      ["lock", (f, doc) => f.gate.lockIdentity(doc)],
      ["closed", f => f.gate.closeWindow()],
      ["document", f => f.gate.noteOpened({ ...f.gate.snapshot().lastWorkingDoc!, documentId: uuid(999) })],
      ["epoch", f => f.gate.noteOpened({ ...f.gate.snapshot().lastWorkingDoc!, epoch: "2" })],
      ["access", f => f.gate.noteAccessLost()],
      ["reset", f => f.gate.resetDocument()],
      ["dispose", f => f.gate.dispose()],
    ];
    for (const [name, broken] of breaks) {
      const f = chain(); const doc = await working(f);
      expect(await refused(f, 730, doc), name).toBe(true);
      broken(f, doc);
      expect(f.gate.takeP01(uuid(730)), name).toBeNull();
    }
  });

  it("the exact «На Сегодня» after the episode met an identity lock gets no busy Today and no read context", async () => {
    const f = chain(); const doc = await working(f);
    expect(await refused(f, 740, doc)).toBe(true);
    f.gate.lockIdentity(doc);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(740) }); await settle();
    expect(f.state()).not.toMatchObject({ kind: "busy" });
    expect(f.gate.snapshot().remoteReadContext).toBe(false);
  });

  it("the busy Today of a spent episode: its refresh or a real show answered SESSION_BUSY again closes the window", async () => {
    for (const source of ["screen", "show"] as const) {
      const f = chain(); const doc = await working(f);
      expect(await refused(f, 750, doc)).toBe(true);
      f.script.busy = true;
      await f.controller.foreground("screen", { startRefused: uuid(750) }); await settle();
      expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
      await f.controller.foreground(source); await settle(); // «Обновить» of the busy Today, or the window's return
      expect(f.state(), source).toEqual({ kind: "closed", reason: "busy" });
      expect(f.gate.snapshot().remoteReadContext).toBe(false);
    }
  });

  it("a window without a working document keeps the cold busy Today on a screen foreground (no closure)", async () => {
    const f = chain(); f.script.busy = true;
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    await f.controller.foreground(); await settle();
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    expect(f.closeWindow).not.toHaveBeenCalled();
  });
});
type GateDocOf = { profileId: string; documentId: string; epoch: string };

describe("C400 (R10 п.1, ред.21): the manual repeat of «Проверить» after not_found gets a new one-shot ticket", () => {
  const notFound = (f: ReturnType<typeof chain>, stopId: string) => json({ command: { id: stopId, status: "not_found" },
    current: profile(f.script.version), state_version: f.script.version });
  /** A lost stop of the cold busy Today: its pending is kept, net is closed until the probe's ready (5 s). */
  async function lostStop(f: ReturnType<typeof chain>) {
    f.script.stop.push("network");
    f.controller.requestRemoteStop(); await f.controller.confirmRemoteStop(); await settle();
    await f.clock.advanceTo(5_000); await settle();
    const saved = pendingRaw(f.storage.values, "wortly.pending.remote_stop")!;
    return { saved, stopId: JSON.parse(saved).intent.command_id as string };
  }
  const reads = (f: ReturnType<typeof chain>, stopId: string) => f.calls.filter(call => call.startsWith(`GET /commands/${stopId}`)).length;

  it("cold busy: not_found, «Проверить» again → not_found again, one GET per check; no foreground, open or POST; pending kept", async () => {
    const f = chain(); f.script.busy = true;
    await f.controller.start(); await settle();
    const { saved, stopId } = await lostStop(f);
    const opens = f.opens.length, posts = f.posts("/commands");
    const problems: string[] = [];
    for (let i = 0; i < 3; i++) {
      f.script.status.push(notFound(f, stopId));
      await f.controller.checkRemoteStop(); await settle();
      problems.push((f.state() as { remote: { problem: string } }).remote.problem);
      expect(reads(f, stopId)).toBe(i + 1);
    }
    expect(problems).toEqual(["not_found", "not_found", "not_found"]);
    expect(f.opens.length - opens).toBe(0);
    expect(f.posts("/commands") - posts).toBe(0);
    expect(pendingRaw(f.storage.values, "wortly.pending.remote_stop")).toBe(saved);
  });

  it("the П01 context of a working window: the same — a new ticket for each explicit check, then the stop found applied", async () => {
    const f = chain(); const doc = await working(f);
    await createJsonTransport(f.http)("/commands", { method: "POST", body: { command_id: uuid(790), kind: "session.start",
      session_id: uuid(791), payload: { mode: "written", bucket: "words" }, client_instance_id: f.instance(),
      document_id: doc.documentId } }).catch(() => undefined);
    expect(f.gate.noteStartBusy(uuid(790))).toBe(true);
    f.script.busy = true;
    await f.controller.foreground("screen", { startRefused: uuid(790) }); await settle();
    expect(f.gate.snapshot().remoteReadContext).toBe(true);
    const { stopId } = await lostStop(f);
    f.script.status.push(notFound(f, stopId));
    await f.controller.checkRemoteStop(); await settle();
    expect((f.state() as { remote: { problem: string } }).remote.problem).toBe("not_found");
    f.script.busy = false; f.script.version = "11";
    f.script.status.push(json({ command: { id: stopId, kind: "session.stop_remote", status: "already_applied",
      applied_at: "2026-10-16T00:00:00Z", target_id: TARGET, object_version: null, action_id: null, result_id: null, context_id: null },
    current: { session_id: TARGET, status: "closed", close_reason: "remote_stop" }, state_version: "11" }));
    await f.controller.checkRemoteStop(); await settle();
    expect(reads(f, stopId)).toBe(2);
    expect(f.state()).toMatchObject({ kind: "opened" });
    expect(hasPending(f.storage.values, "wortly.pending.remote_stop")).toBe(false);
  });

  it("no automatic path reads after not_found: show, ready, the probe series and time send no GET; only the user's check does", async () => {
    const f = chain(); f.script.busy = true;
    await f.controller.start(); await settle();
    const { saved, stopId } = await lostStop(f);
    f.script.status.push(notFound(f, stopId));
    await f.controller.checkRemoteStop(); await settle();
    expect(reads(f, stopId)).toBe(1);
    f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground("show"); await f.controller.foreground(); await settle();
    f.gate.closeByFailure(); await f.clock.advanceTo(120_000); await settle();
    expect(reads(f, stopId)).toBe(1);
    expect((f.state() as { remote: { problem: string } }).remote.problem).toBe("not_found");
    expect(pendingRaw(f.storage.values, "wortly.pending.remote_stop")).toBe(saved);
    f.script.status.push(notFound(f, stopId));
    await f.controller.checkRemoteStop(); await settle();
    expect(reads(f, stopId)).toBe(2);
  });
});
