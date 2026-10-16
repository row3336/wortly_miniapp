// C163 / 22.1-А after M-P03-10: the re-entry of the expired screen (P03 §4.6, AC-104; P02-W К-Т12о) through the real
// chain Entry → write gate (L2, п.8б) → transport → decoder, on the gate's manual clock. Only a 401 offers it; the open
// it makes is the first open of a new document and reaches L2 only from a visible window whose gate lets it go. The
// `unavailable` button keeps AC-102: no other cause of session=null signs in or opens by itself or by a click.
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

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = uuid(1);
type Access = "admitted" | "pending" | "rejected";
const profile = (version = "10", access: Access = "admitted") => ({ profile_id: PROFILE, role: "user", ui_language: "ru",
  dictionary_language: "ru", time_zone: "UTC", state_version: version,
  access: { status: access, version: access === "admitted" ? "1" : "2", reason: null } });
const compatibility = { compatible: true, contract_version: "1" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const envelope = (code: string, status: number) => json({ error: { code } }, status);
type Reply = Response | "network" | (() => Response | "network" | Promise<Response | "network">);

function memory(): AsyncStorage {
  const values = new Map<string, string>();
  return { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
}

function chain(initData: string | null = "signed", options: { outage?: { retryAfterS: number | null } } = {}) {
  const clock = new ManualClock();
  const opens: { event: string; document_id: string; return_marker?: string }[] = [];
  const calls: string[] = [];
  const script = { auth: [] as Reply[], open: [] as Reply[], access: "admitted" as Access };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), "http://localhost").pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const take = async (queue: Reply[], fallback: () => Response): Promise<Response> => {
      const item = queue.length ? queue.shift()! : fallback;
      const next = await (typeof item === "function" ? item() : item);
      if (next === "network") throw new TypeError("network");
      return next;
    };
    if (path === "/availability") return json({ status: "ready", retry_after_s: null });
    if (path === "/auth/telegram") return take(script.auth, () => json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z",
      profile: profile("10", script.access), compatibility }));
    if (path === "/client/register") return json({ status: "registered", client_instance_id: body.client_instance_id,
      origin_proof: "proof", proof_version: "1", activated: false });
    if (path === "/client/open") {
      opens.push(body);
      return take(script.open, () => json({ status: "opened", client_instance_id: body.client_instance_id,
        document_id: body.document_id, document_epoch: "1", proof_version: "1", profile: profile("10", script.access),
        session: null, compatibility }));
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  });
  const gate = new WriteGate({ clock, ...(options.outage ? { outage: options.outage } : {}) });
  const http: HttpOptions = { fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 100_000, gate };
  gate.attachProbe(createAvailabilityClient(http).probe);
  const storage = memory();
  const updates: EntrySnapshot[] = [];
  let next = 100;
  const controller = new TestEntryController({ gate, api: createEntryApi(http), today: createTodayApi(http),
    remote: { api: createRemoteSessionApi(http), pendingStore: new RemoteStopPendingStore(storage) }, storage,
    lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData, savedLanguage: "ru",
    browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
    newId: () => uuid(next++), closeWindow: vi.fn(), onUpdate: snapshot => updates.push(snapshot) });
  const state = () => updates.at(-1)!.state;
  /** Every request but the gate's own probe. */
  const sent = () => calls.filter(call => call !== "GET /availability");
  return { clock, gate, controller, script, opens, state, sent, auths: () => calls.filter(call => call === "POST /auth/telegram").length,
    probes: () => calls.filter(call => call === "GET /availability").length };
}
type Chain = ReturnType<typeof chain>;

async function working(f: Chain) {
  await f.controller.start(); await settle();
  expect(f.state()).toEqual({ kind: "opened" });
  return f.gate.snapshot().lastWorkingDoc!;
}
/**
 * P2-1 (pre-QA C163): the recoverable 401 is a revoked session (AUTH_INVALID, core identity/service.py:139–149) while the
 * signed initData is still within max_age (telegram.py:120–121) — the next auth succeeds. An expired session (AUTH_EXPIRED,
 * service.py:150–151) means the initData is older than max_age too: its auth answers 401 again (Н4, the test below).
 */
const revoked = () => envelope("AUTH_INVALID", 401);
/** The working window's return (a show) gets `reply` on its foreground. */
async function refusedOnShow(f: Chain, reply: Response) {
  f.script.open.push(reply);
  f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
  await f.controller.foreground("show"); await settle();
}
/** Everything automatic that could follow: ready after a closure, shows, timers — and the unavailable button. */
async function automatics(f: Chain) {
  f.gate.closeByFailure("unknown"); await f.clock.advanceBy(60_000);
  f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
  await f.controller.foreground("show"); await f.controller.foreground("screen"); await f.clock.advanceBy(60_000);
  await f.controller.retry(); await settle();
}

describe("C163 re-entry after a 401 (AC-104)", () => {
  it("401 on the return of a working window: expired with an active button; nothing automatic; the click signs in once and opens a NEW document", async () => {
    const f = chain(); const doc = await working(f);
    await refusedOnShow(f, revoked());
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
    expect(f.gate.snapshot().lastWorkingDoc).toBeNull();
    const sent = f.sent().length, opens = f.opens.length;
    await automatics(f);
    expect(f.sent()).toHaveLength(sent);
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.auths()).toBe(2);
    const added = f.opens.slice(opens);
    expect(added.map(open => open.event)).toEqual(["open"]);
    expect(added[0].document_id).not.toBe(doc.documentId);
    expect(added[0].return_marker).toBeUndefined();
    expect(f.gate.snapshot().openAttempts).toEqual([doc.documentId, added[0].document_id]);
    expect(f.gate.snapshot().lastWorkingDoc?.documentId).toBe(added[0].document_id);
  });

  it("the button follows the gate: inactive with the wait while net is closed, active after ready; a call meanwhile sends nothing", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.gate.closeByFailure("unknown"); await settle();
    expect(f.state()).toEqual({ kind: "expired", reentry: true, wait: { cause: "offline" } });
    const sent = f.sent().length;
    await f.controller.reenter(); await settle();
    expect(f.sent()).toHaveLength(sent);
    await f.clock.advanceBy(5_000);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
    expect(f.sent()).toHaveLength(sent); // ready lifts the button, never sends the click (no queue)
  });

  it("C392: ready with the hold still running keeps the button inactive (a planned pause); the hold end alone, without a new answer, activates it", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.gate.closeByMaintenance(60); await settle();
    expect(f.state()).toEqual({ kind: "expired", reentry: true, wait: { cause: "maintenance", waitSeconds: 60 } });
    const sent = f.sent().length;
    await f.clock.advanceBy(5_000); // the probe answers ready; the announced hold is not over
    expect(f.gate.snapshot().net.kind).toBe("open");
    expect(f.gate.holdActive()).toBe(true);
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true, wait: { cause: "maintenance" } });
    expect(f.state()).not.toHaveProperty("checkable");
    await f.controller.reenter(); await settle();
    expect(f.sent()).toHaveLength(sent);
    const probes = f.probes();
    await f.clock.advanceTo(61_000); // only the hold ends: no new answer of the server
    expect(f.probes()).toBe(probes);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
    expect(f.sent()).toHaveLength(sent);
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("hidden while the auth is in flight: the open does not reach L2, openAttempts unchanged; the show sends nothing", async () => {
    const f = chain(); const doc = await working(f);
    await refusedOnShow(f, revoked());
    let answer!: () => void;
    f.script.auth.push(() => new Promise<Response>(resolve => { answer = () => resolve(json({ access_token: "token",
      expires_at: "2026-10-17T00:00:00Z", profile: profile(), compatibility })); }));
    const opens = f.opens.length;
    const task = f.controller.reenter(); await settle();
    f.controller.setVisible(false); f.gate.setVisible(false);
    answer(); await task; await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.gate.snapshot().openAttempts).toEqual([doc.documentId]);
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true });
    const sent = f.sent().length;
    f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground("show"); await f.clock.advanceBy(60_000);
    expect(f.sent()).toHaveLength(sent);
    await f.controller.reenter(); await settle(); // a new explicit click
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.opens.slice(opens).map(open => open.event)).toEqual(["open"]);
  });

  it("the gate closes while the auth is in flight: the open does not reach L2; expired with the wait; ready opens nothing", async () => {
    const f = chain(); const doc = await working(f);
    await refusedOnShow(f, revoked());
    let answer!: () => void;
    f.script.auth.push(() => new Promise<Response>(resolve => { answer = () => resolve(json({ access_token: "token",
      expires_at: "2026-10-17T00:00:00Z", profile: profile(), compatibility })); }));
    const opens = f.opens.length;
    const task = f.controller.reenter(); await settle();
    f.gate.closeByFailure("unknown");
    answer(); await task; await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.gate.snapshot().openAttempts).toEqual([doc.documentId]);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, wait: { cause: "offline" } });
    await f.clock.advanceBy(60_000);
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
  });

  it.each([
    ["a refused fetch", "network" as const],
    ["503 MAINTENANCE", envelope("MAINTENANCE", 503)],
    ["502", envelope("BAD_GATEWAY", 502)],
  ])("the re-entry's auth fails (%s): no open, the expired screen comes back (no К-9/route В dead end)", async (_n, reply) => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.script.auth.push(reply);
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true });
  });

  it("an expired session (AUTH_EXPIRED): the re-entry's auth answers 401 too (initData older than max_age) — expired without a button (Н4), no open, nothing more", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, envelope("AUTH_EXPIRED", 401));
    f.script.auth.push(envelope("AUTH_EXPIRED", 401));
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toEqual({ kind: "expired" });
    const sent = f.sent().length;
    await f.controller.reenter(); await automatics(f);
    expect(f.sent()).toHaveLength(sent);
  });

  it("Н4: a 401 to the first auth of the page — expired without a button; a later 401 of a session offers none either", async () => {
    const f = chain();
    f.script.auth.push(envelope("AUTH_EXPIRED", 401));
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "expired" });
    const sent = f.sent().length;
    await f.controller.reenter(); await automatics(f);
    expect(f.sent()).toHaveLength(sent);
  });

  it.each(["pending", "rejected"] as const)("the re-entry's auth reports a %s profile: its own screen of the admission, no open", async access => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.script.access = access;
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.state().kind).toBe(access);
  });

  it("the re-entry's open reached L2 and failed by transport: §4.13 В (blocked), no second new document, no re-entry", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.script.open.push("network");
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens + 1);
    expect(f.state()).toEqual({ kind: "unavailable" });
    const sent = f.sent().length;
    await f.controller.reenter(); await automatics(f);
    expect(f.sent()).toHaveLength(sent);
  });

  it("the re-entry's open answers 403 FORBIDDEN with a stored proof: no repeat, no new document (п.8б (5) needs a late register)", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.script.open.push(envelope("FORBIDDEN", 403));
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens + 1);
    expect(f.state()).toEqual({ kind: "unavailable" });
    expect(f.gate.snapshot().retryAfter403Doc).toBeNull();
    const sent = f.sent().length;
    await f.controller.reenter(); await automatics(f);
    expect(f.sent()).toHaveLength(sent);
  });

  it("without signed initData nothing signs in: unavailable, reenter() sends nothing", async () => {
    const f = chain(null);
    await f.controller.start(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable" });
    await f.controller.reenter(); await settle();
    expect(f.sent()).toEqual([]);
  });
});

describe("P3 of the pre-QA C163 (narrow)", () => {
  const authOk = (patch: Record<string, unknown> = {}) => json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z",
    profile: { ...profile(), ...patch }, compatibility });

  it("P3-1: a bare 401 to the re-entry's auth (no code of the core) refuses nothing of the initData — the button stays", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.script.auth.push(new Response("", { status: 401 }));
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
  });

  it.each([
    ["422 VALIDATION_FAILED", envelope("VALIDATION_FAILED", 422), false],
    ["429 RATE_LIMITED", envelope("RATE_LIMITED", 429), true],
  ])("P3-2: the re-entry's auth answers %s — %s", async (_n, reply, keeps) => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.script.auth.push(reply);
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual(keeps ? { kind: "expired", reentry: true, checkable: true } : { kind: "expired" });
    const sent = f.sent().length;
    await f.controller.reenter(); await settle();
    // 429: a later explicit press signs in again (here it goes on: auth + the first open); 422: nothing more.
    if (keeps) expect(f.sent().length - sent).toBeGreaterThan(0); else expect(f.sent().length - sent).toBe(0);
  });

  it("P3-5: the re-entry signs in as ANOTHER profile than the one whose session ended — no screen of it, 0 open", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, revoked());
    f.script.auth.push(authOk({ profile_id: uuid(2) }));
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toEqual({ kind: "unavailable" });
  });

  it("P3-6/M7: a page started with the outage mark — the re-entry's open never waits for the gate itself (no queued click)", async () => {
    const f = chain("signed", { outage: { retryAfterS: null } });
    const started = f.controller.start(); await f.clock.advanceBy(5_000); await started; await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    await refusedOnShow(f, revoked());
    await f.clock.advanceBy(10_000);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
    f.script.auth.push(() => { f.gate.closeByFailure("unknown"); return authOk(); });
    const opens = f.opens.length;
    await f.controller.reenter(); await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true });
    await f.clock.advanceBy(60_000);
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
  });
});

describe("other causes of session=null: no re-entry, 0 sign-in, 0 open (M-P03-10 stop kept)", () => {
  it.each([
    ["an unknown 403 without the envelope", new Response("", { status: 403 })],
    ["403 FORBIDDEN on the foreground (a refused proof)", envelope("FORBIDDEN", 403)],
    ["403 ACCESS_PENDING", envelope("ACCESS_PENDING", 403)],
    ["403 ACCESS_REJECTED", envelope("ACCESS_REJECTED", 403)],
  ])("%s on the return of the working window: unavailable В, reenter()/retry()/ready/show/timer send nothing", async (_n, reply) => {
    const f = chain(); await working(f);
    await refusedOnShow(f, reply);
    expect(f.state()).toEqual({ kind: "unavailable" });
    const sent = f.sent().length;
    await f.controller.reenter(); await automatics(f);
    expect(f.sent()).toHaveLength(sent);
  });

  // Integration with P04 (44f65bc): 403 PROFILE_DELETED is the deletion's own result (S-A07), never a re-entry.
  it("403 PROFILE_DELETED on the return of the working window: profile_deleted (P04), reenter()/retry()/ready/show/timer send nothing", async () => {
    const f = chain(); await working(f);
    await refusedOnShow(f, envelope("PROFILE_DELETED", 403));
    expect(f.state()).toEqual({ kind: "profile_deleted" });
    const sent = f.sent().length;
    await f.controller.reenter(); await automatics(f);
    expect(f.sent()).toHaveLength(sent);
  });

  it("reenter() of an opened window sends nothing", async () => {
    const f = chain(); await working(f);
    const sent = f.sent().length;
    await f.controller.reenter(); await settle();
    expect(f.sent()).toHaveLength(sent);
    expect(f.state()).toEqual({ kind: "opened" });
  });
});
