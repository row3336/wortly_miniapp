// В4-Б (C390, CL477): after a reapply refused with 409 VERSION_CONFLICT the explicit profile refresh (route «profile»,
// C373) may continue the page's ORIGINAL entry when the current profile is admitted — only while that is truly the first
// open of the page (P03 п.8б (1); TZA:64 admitted → bootstrap): no document of reference, no working document, no L2
// attempt of any open; the open goes to L2 only from a visible window with mayWrite; the old reapply ID is never sent
// again; after a failed first open no new ID. Real chain Entry → write gate → transport → decoder on a manual clock.
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
const PROFILE = uuid(1), OTHER = uuid(2);
type Access = "admitted" | "pending" | "rejected";
const compatibility = { compatible: true, contract_version: "1" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const envelope = (code: string, status: number) => json({ error: { code } }, status);
type Reply = Response | "network" | ((body?: { client_instance_id?: string }) => Response | "network" | Promise<Response | "network">);

function memory(): AsyncStorage {
  const values = new Map<string, string>();
  return { get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
}

/** A rejected profile at access version 1; the reapply meets VERSION_CONFLICT and the server moves to `after`. */
function chain() {
  const clock = new ManualClock();
  const opens: { event: string; document_id: string }[] = [];
  const reapplies: string[] = [];
  const calls: string[] = [];
  const server = { status: "rejected" as Access, version: "1", profileId: PROFILE, stateVersion: "10" };
  const after = { status: "admitted" as Access, version: "2", profileId: PROFILE, stateVersion: "11" };
  const script = { auth: [] as Reply[], open: [] as Reply[], register: [] as Reply[], reapply: [] as Reply[] };
  const profile = () => ({ profile_id: server.profileId, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: server.stateVersion, access: { status: server.status, version: server.version, reason: null } });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), "http://localhost").pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const take = async (queue: Reply[], fallback: () => Response): Promise<Response> => {
      const item = queue.length ? queue.shift()! : fallback;
      const next = await (typeof item === "function" ? item(body) : item);
      if (next === "network") throw new TypeError("network");
      return next;
    };
    if (path === "/availability") return json({ status: "ready", retry_after_s: null });
    if (path === "/auth/telegram") return take(script.auth, () => json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z",
      profile: profile(), compatibility }));
    if (path === "/access/reapply") {
      reapplies.push(body.command_id); Object.assign(server, after);
      return take(script.reapply, () => envelope("VERSION_CONFLICT", 409));
    }
    if (path === "/client/register") return take(script.register, () => json({ status: "registered",
      client_instance_id: body.client_instance_id, origin_proof: "proof", proof_version: "1", activated: false }));
    if (path === "/client/open") {
      opens.push(body);
      return take(script.open, () => json({ status: "opened", client_instance_id: body.client_instance_id,
        document_id: body.document_id, document_epoch: "1", proof_version: "1", profile: profile(), session: null, compatibility }));
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  });
  const gate = new WriteGate({ clock });
  const http: HttpOptions = { fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 100_000, gate };
  gate.attachProbe(createAvailabilityClient(http).probe);
  const storage = memory();
  const updates: EntrySnapshot[] = [];
  let next = 100;
  const controller = new TestEntryController({ gate, api: createEntryApi(http), today: createTodayApi(http),
    remote: { api: createRemoteSessionApi(http), pendingStore: new RemoteStopPendingStore(storage) }, storage,
    lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData: "signed", savedLanguage: "ru",
    browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
    newId: () => uuid(next++), closeWindow: vi.fn(), onUpdate: snapshot => updates.push(snapshot) });
  const state = () => updates.at(-1)!.state;
  const sent = () => calls.filter(call => call !== "GET /availability");
  const count = (call: string) => calls.filter(entry => entry === call).length;
  return { clock, gate, controller, server, after, script, opens, reapplies, state, sent, count, profile };
}
type Chain = ReturnType<typeof chain>;

/** rejected → «Подать заявку ещё раз» → 409 VERSION_CONFLICT → the profile button. */
async function conflicted(f: Chain) {
  await f.controller.start(); await settle();
  expect(f.state()).toMatchObject({ kind: "rejected" });
  await f.controller.reapply(); await settle();
  expect(f.state()).toEqual({ kind: "unavailable", route: "profile", checkable: true });
}
async function automatics(f: Chain) {
  f.gate.closeByFailure("unknown"); await f.clock.advanceBy(60_000);
  f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
  await f.controller.foreground("show"); await f.controller.foreground("screen"); await f.clock.advanceBy(60_000);
  await f.controller.reenter(); await f.controller.retry(); await settle();
}

describe("В4-Б: the profile refresh after VERSION_CONFLICT continues the first entry of an admitted profile", () => {
  it("admitted and newer: one auth, the ordinary register, ONE first open; the old reapply ID is not sent again", async () => {
    const f = chain(); await conflicted(f);
    const auths = f.count("POST /auth/telegram");
    await f.controller.retry(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.count("POST /auth/telegram")).toBe(auths + 1);
    expect(f.count("POST /client/register")).toBe(1);
    expect(f.opens.map(open => open.event)).toEqual(["open"]);
    expect(f.reapplies).toHaveLength(1);
    expect(f.gate.snapshot().openAttempts).toEqual([f.opens[0].document_id]);
  });

  it.each(["pending", "rejected"] as const)("%s and newer: its own screen, 0 open, 0 reapply", async status => {
    const f = chain(); f.after.status = status; await conflicted(f);
    await f.controller.retry(); await settle();
    expect(f.state().kind).toBe(status);
    expect(f.opens).toHaveLength(0);
    expect(f.reapplies).toHaveLength(1);
  });

  it.each([
    ["the access version not newer than the conflicted one", (f: Chain) => { f.after.version = "1"; }],
    ["another profile", (f: Chain) => { f.after.profileId = OTHER; }],
  ])("strict actuality (%s): admitted proves nothing — no open, the profile button stays", async (_n, change) => {
    const f = chain(); change(f); await conflicted(f);
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(0);
    expect(f.count("POST /client/register")).toBe(0);
    expect(f.state()).toMatchObject({ kind: "unavailable" });
  });

  it.each(["pending", "admitted"] as const)("strict actuality also for %s: a not newer access version is no current profile", async status => {
    const f = chain(); f.after.status = status; f.after.version = "1"; await conflicted(f);
    await f.controller.retry(); await settle();
    expect(f.state()).toMatchObject({ kind: "unavailable" });
    expect(f.opens).toHaveLength(0);
  });

  it("hidden while the auth is in flight: the open does not reach L2; the profile button again; the show sends nothing", async () => {
    const f = chain(); await conflicted(f);
    let answer!: () => void;
    f.script.auth.push(() => new Promise<Response>(resolve => { answer = () => resolve(json({ access_token: "token",
      expires_at: "2026-10-17T00:00:00Z", compatibility, profile: { profile_id: PROFILE, role: "user", ui_language: "ru",
        dictionary_language: "ru", time_zone: "UTC", state_version: "11", access: { status: "admitted", version: "2", reason: null } } })); }));
    const task = f.controller.retry(); await settle();
    f.controller.setVisible(false); f.gate.setVisible(false);
    answer(); await task; await settle();
    expect(f.opens).toHaveLength(0);
    expect(f.gate.snapshot().openAttempts).toEqual([]);
    expect(f.state()).toEqual({ kind: "unavailable", route: "profile", checkable: true });
    const sent = f.sent().length;
    f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground("show"); await f.clock.advanceBy(60_000);
    expect(f.sent()).toHaveLength(sent);
    await f.controller.retry(); await settle(); // a new explicit click
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.opens.map(open => open.event)).toEqual(["open"]);
  });

  it("the gate closes while the auth is in flight: no open reaches L2; ready opens nothing", async () => {
    const f = chain(); await conflicted(f);
    f.script.auth.push(() => { f.gate.closeByFailure("unknown"); return json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z",
      compatibility, profile: { profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
        state_version: "11", access: { status: "admitted", version: "2", reason: null } } }); });
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(0);
    expect(f.gate.snapshot().openAttempts).toEqual([]);
    expect(f.state()).toMatchObject({ kind: "unavailable", route: "profile" });
    await f.clock.advanceBy(60_000);
    expect(f.opens).toHaveLength(0);
  });

  it("the register fails by transport before the open: the profile button again, 0 open; the next click goes on", async () => {
    const f = chain(); await conflicted(f);
    f.script.register.push("network");
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(0);
    expect(f.state()).toMatchObject({ kind: "unavailable", route: "profile" });
    await f.clock.advanceBy(5_000);
    await f.controller.retry(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.opens.map(open => open.event)).toEqual(["open"]);
  });

  it("the first open reached L2 and failed by transport: §4.13 В (blocked), no new ID, nothing automatic or by any button", async () => {
    const f = chain(); await conflicted(f);
    f.script.open.push("network");
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(1);
    expect(f.state()).toEqual({ kind: "unavailable" });
    const sent = f.sent().length;
    await automatics(f);
    expect(f.sent()).toHaveLength(sent);
  });

  // P2-2 (pre-QA C163, probe V6): route «profile» without a proven VERSION_CONFLICT never opens (C390 В3).
  it("V6: a CONFIRMED reapply (admitted) whose register then got 403 ACCESS_PENDING — the profile button reads the profile, 0 open", async () => {
    const f = chain();
    f.script.reapply.push(() => json({ command: { id: f.reapplies[0], status: "applied", applied_at: "2026-10-16T10:00:00Z",
      target_id: null, object_version: "2" }, current: f.profile() }));
    f.script.register.push(envelope("ACCESS_PENDING", 403));
    await f.controller.start(); await settle();
    await f.controller.reapply(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable", route: "profile", checkable: true });
    const auths = f.count("POST /auth/telegram");
    await f.controller.retry(); await settle();
    expect(f.count("POST /auth/telegram")).toBe(auths + 1);
    expect(f.opens).toHaveLength(0);
    // P3 (QA шаг 5, K8): no first open is possible by this route any more — the button is blocked (route В), honestly.
    expect(f.state()).toEqual({ kind: "unavailable" });
    const blocked = f.sent().length;
    await f.controller.retry(); await settle();
    expect(f.sent()).toHaveLength(blocked);
    const sent = f.sent().length;
    await automatics(f);
    expect(f.opens).toHaveLength(0);
    expect(f.sent().length - sent).toBeLessThanOrEqual(1); // at most the one sign-in of the profile button itself
  });

  it("an unreadable reapply reply (invalid_response) — route «profile», admitted after the refresh: 0 open", async () => {
    const f = chain();
    f.script.reapply.push(() => json({ unexpected: true }));
    await f.controller.start(); await settle();
    await f.controller.reapply(); await settle();
    expect(f.state()).toMatchObject({ kind: "unavailable", route: "profile" });
    // r7 keeps the session after an unreadable reply: the button re-reads it without a sign-in (rejected) — never an open.
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(0);
    expect(f.count("POST /client/register")).toBe(0);
    expect(f.state().kind).not.toBe("opened");
  });

  // P2-3 (pre-QA C163, probes «C398»): the conflict proof (profile identity and access version) is kept until the first open
  // has passed L2; a click held before L2 and a later click with ANOTHER profile open nothing.
  const held: [string, (f: Chain) => void][] = [
    ["hidden while the auth is in flight", f => { f.script.auth.push(() => { f.controller.setVisible(false); f.gate.setVisible(false);
      return json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z", profile: f.profile(), compatibility }); }); }],
    ["a planned hold begins while the auth is in flight", f => { f.script.auth.push(() => { f.gate.closeByMaintenance(30);
      return json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z", profile: f.profile(), compatibility }); }); }],
    ["the register fails by transport", f => { f.script.register.push("network"); }],
  ];
  for (const [name, hold] of held) it(`P2-3: ${name} — nothing reached L2; a later click whose auth names another profile opens nothing`, async () => {
    const f = chain(); await conflicted(f);
    hold(f);
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(0);
    expect(f.gate.snapshot().openAttempts).toEqual([]);
    f.gate.setVisible(true); f.controller.setVisible(true);
    await f.clock.advanceBy(60_000);
    expect(f.state()).toMatchObject({ kind: "unavailable", route: "profile" });
    f.server.profileId = OTHER;
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(0);
    expect(f.state()).toMatchObject({ kind: "unavailable" });
  });
  for (const [name, hold] of held) it(`P2-3: ${name} — the same profile on the next click: the proof kept, one first open`, async () => {
    const f = chain(); await conflicted(f);
    hold(f);
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(0);
    f.gate.setVisible(true); f.controller.setVisible(true);
    await f.clock.advanceBy(60_000);
    await f.controller.retry(); await settle();
    expect(f.opens.map(open => open.event)).toEqual(["open"]);
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("P3-3: during an announced hold the profile button is inactive with the wait; a call sends nothing; the hold end activates it", async () => {
    const f = chain(); await conflicted(f);
    f.gate.closeByMaintenance(30); await f.clock.advanceBy(5_000); // ready, the hold still runs
    expect(f.state()).toMatchObject({ kind: "unavailable", route: "profile", wait: { cause: "maintenance" } });
    expect(f.state()).not.toHaveProperty("checkable");
    const sent = f.sent().length;
    await f.controller.retry(); await settle();
    expect(f.sent()).toHaveLength(sent);
    await f.clock.advanceTo(40_000);
    expect(f.state()).toEqual({ kind: "unavailable", route: "profile", checkable: true });
    await f.controller.retry(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
  });

  it("P3-6/M10: the one repeat of п.8б (5) held before L2 (hidden) — its allowance is dropped; nothing opens later", async () => {
    const f = chain(); await conflicted(f);
    f.script.open.push(envelope("FORBIDDEN", 403));
    f.script.register.push(
      body => json({ status: "registered", client_instance_id: body!.client_instance_id, origin_proof: "proof", proof_version: "1", activated: false }),
      body => { f.controller.setVisible(false); f.gate.setVisible(false);
        return json({ status: "registered", client_instance_id: body!.client_instance_id, origin_proof: "proof2", proof_version: "2", activated: false }); });
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(1);
    expect(f.gate.snapshot().retryAfter403Doc).toBeNull();
    f.gate.setVisible(true); f.controller.setVisible(true);
    const sent = f.sent().length;
    await automatics(f);
    expect(f.opens).toHaveLength(1);
    expect(f.sent().length - sent).toBeLessThanOrEqual(0);
  });

  it("a page that already handed an open to L2 (401 → re-entry → rejected → conflict): admitted opens nothing — a named remainder", async () => {
    const f = chain();
    f.server.status = "admitted";
    f.script.open.push(envelope("AUTH_INVALID", 401)); // a revoked session: the re-entry's auth succeeds (P2-1)
    await f.controller.start(); await settle();
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true });
    f.server.status = "rejected";
    await f.controller.reenter(); await settle();
    expect(f.state()).toMatchObject({ kind: "rejected" });
    await f.controller.reapply(); await settle();
    expect(f.state()).toMatchObject({ kind: "unavailable", route: "profile" });
    const opens = f.opens.length;
    await f.controller.retry(); await settle();
    expect(f.opens).toHaveLength(opens);
    expect(f.state()).toMatchObject({ kind: "unavailable" });
  });
});
