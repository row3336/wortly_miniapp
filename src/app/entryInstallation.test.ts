// C163 шаг 5 (Q01 вариант 1; CON:196–200; controller CL493): the narrow recovery candidate after a refused installation
// proof, through the real chain Entry → write gate (L2) → transport → decoder on a manual clock. A module request of the
// live document gets the core's bare {"error":{"code":"FORBIDDEN"}} with a really sent proof: the rights of A end at
// once, the re-entry is shown, and only its explicit click signs in anew; the fresh same admitted profile continues as a
// NEW installation B (new client_instance_id/registration_id) → register → the first open of B's new document (visible ∧
// mayWrite right before L2). Everything else stops; nothing is automatic; A's record is never reused.
import { describe, expect, it, vi } from "vitest";
import { createEntryApi } from "../api/entryApi";
import { createAvailabilityClient } from "../api/availability";
import { createJsonTransport, httpError, type HttpOptions } from "../api/http";
import { createRemoteSessionApi } from "../study/remoteSessionApi";
import { RemoteStopPendingStore } from "../study/remoteStopPending";
import type { AsyncStorage } from "../platform/storage";
import { WriteGate } from "../commands/writeGate";
import { ManualClock, settle } from "../commands/writeGate.test-support";
import { EntryController, type EntrySnapshot } from "./entryController";
import { createTodayApi } from "../today/todayApi";
import { installationKey, strictInstallation } from "./installationStore";
import { idbInstallationStore, INSTALLATION_DATABASE, INSTALLATION_STORE } from "./installationStoreIdb";
import { upgradeWrites } from "./installationIdb.test-support";
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import { sharedStorage } from "./webLocks.test-support";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = uuid(1), TARGET = uuid(50), SESSION = uuid(60);
type Access = "admitted" | "pending" | "rejected";
const compatibility = { compatible: true, contract_version: "1" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const bare403 = () => json({ error: { code: "FORBIDDEN" } }, 403);
type Body = Record<string, unknown>;
type Reply = Response | "network" | ((body: Body) => Response | "network" | Promise<Response | "network">);

/** afterGet: runs once after the next read of the installation record resolves (another window, a dispose meanwhile). */
function memory(): AsyncStorage & { values: Map<string, string>; hooks: { afterGet: null | (() => void | Promise<void>) } } {
  const values = new Map<string, string>();
  const hooks = { afterGet: null as null | (() => void | Promise<void>) };
  return { values, hooks,
    get: async key => {
      const value = values.get(key) ?? null;
      if (hooks.afterGet && key.startsWith("wortly.installation:")) { const run = hooks.afterGet; hooks.afterGet = null; await run(); }
      return value;
    },
    set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
}

/** indexedDb "absent": the IndexedDB API reliably absent (store canon §5) — the store reads the legacy record only. */
function chain(options: { indexedDb?: "present" | "absent" } = {}) {
  const clock = new ManualClock();
  const calls: { method: string; path: string; body: Body | null; proof: string | null }[] = [];
  const server = { access: "admitted" as Access, profileId: PROFILE, busy: false };
  const script = { auth: [] as Reply[], register: [] as Reply[], open: [] as Reply[], module: [] as Reply[] };
  const profile = () => ({ profile_id: server.profileId, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
    state_version: "10", access: { status: server.access, version: server.access === "admitted" ? "1" : "2", reason: null } });
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const address = new URL(String(url), "http://localhost"), path = address.pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) as Body : null;
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", path, body, proof: headers.get("X-Origin-Proof") });
    const take = async (queue: Reply[], fallback: () => Response): Promise<Response> => {
      const item = queue.length ? queue.shift()! : fallback;
      const next = await (typeof item === "function" ? item(body ?? {}) : item);
      if (next === "network") throw new TypeError("network");
      return next;
    };
    if (path === "/availability") return json({ status: "ready", retry_after_s: null });
    if (path === "/auth/telegram") return take(script.auth, () => json({ access_token: `token${calls.length}`,
      expires_at: "2026-10-17T00:00:00Z", profile: profile(), compatibility }));
    if (path === "/client/register") return take(script.register, () => json({ status: "registered",
      client_instance_id: body!.client_instance_id, origin_proof: `proof-${String(body!.client_instance_id).slice(-3)}`,
      proof_version: "1", activated: false }));
    if (path === "/client/open") return take(script.open, () => server.busy
      ? json({ status: "SESSION_BUSY", profile: profile(), compatibility,
        session: { status: "busy", stop_remote_target: TARGET, document_conflict: false, document_epoch: null } })
      : json({ status: "opened", client_instance_id: body!.client_instance_id, document_id: body!.document_id,
        document_epoch: "1", proof_version: "1", profile: profile(), session: null, compatibility }));
    // Module requests of the opened document: POST /commands and GET /sessions/{id}.
    return take(script.module, () => json({ error: { code: "UNSCRIPTED" } }, 500));
  });
  const gate = new WriteGate({ clock });
  const http: HttpOptions = { fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 100_000, gate };
  gate.attachProbe(createAvailabilityClient(http).probe);
  const transport = createJsonTransport(http);
  const storage = memory();
  // C163 integration: the installation record lives in the product store over the IndexedDB double — one database shared
  // by the windows of one origin (this page; `other` is another window of the same profile); the page's localStorage is
  // only the store's lazy legacy getter (import, §5).
  const idb = new FakeIndexedDb(), factory = upgradeWrites(idb), legacy = sharedStorage();
  const installationStore = idbInstallationStore(options.indexedDb === "absent" ? undefined : factory, () => legacy.storage);
  const updates: EntrySnapshot[] = [];
  let next = 100;
  const controller = new EntryController({ gate, api: createEntryApi(http), today: createTodayApi(http),
    remote: { api: createRemoteSessionApi(http), pendingStore: new RemoteStopPendingStore(storage) }, storage,
    lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData: "signed", savedLanguage: "ru",
    browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
    newId: () => uuid(next++), closeWindow: vi.fn(), onUpdate: snapshot => updates.push(snapshot), installationStore });
  const state = () => updates.at(-1)!.state;
  const sent = () => calls.filter(call => call.path !== "/availability");
  const of = (path: string) => calls.filter(call => call.path === path);
  /** A module request of the live document through its handle, as the modules make it (access.run + httpError). */
  async function command(kind: string, patch: { proof?: string | null; document?: string } = {}) {
    const access = controller.getOpenedAccess()!;
    await access.run(async ({ token, proof, clientInstanceId, documentId }) => {
      const reply = await transport("/commands", { method: "POST", token,
        ...(patch.proof === null ? {} : { proof: patch.proof ?? proof }),
        body: { command_id: uuid(900 + calls.length), kind, client_instance_id: clientInstanceId,
          document_id: patch.document ?? documentId, payload: {} } });
      if (!reply.ok) throw httpError(reply);
    }).catch(() => undefined);
    await settle();
  }
  async function sessionRead(params: Record<string, string>) {
    const access = controller.getOpenedAccess()!;
    await access.run(async ({ token, proof, clientInstanceId, documentId }) => {
      const query = new URLSearchParams({ client_instance_id: clientInstanceId, document_id: documentId, ...params });
      const reply = await transport(`/sessions/${SESSION}?${query}`, { method: "GET", token, proof });
      if (!reply.ok) throw httpError(reply);
    }).catch(() => undefined);
    await settle();
  }
  /**
   * C163 шаг 5b (P2-5A): a request object the caller changes AFTER it was sent — the snapshot of what really left decides.
   */
  async function mutatedCommand(kind: string, mutate: (request: { body: Body; proof?: string }) => void,
    patch: { proof?: string | null; document?: string } = {}) {
    const access = controller.getOpenedAccess()!;
    let release!: () => void;
    script.module.push(() => new Promise<Response>(resolve => { release = () => resolve(bare403()); }));
    await access.run(async ({ token, proof, clientInstanceId, documentId }) => {
      const request: { method: "POST"; token: string; proof?: string; body: Body } = { method: "POST", token,
        ...(patch.proof === null ? {} : { proof: patch.proof ?? proof }),
        body: { command_id: uuid(990), kind, client_instance_id: clientInstanceId, document_id: patch.document ?? documentId, payload: {} } };
      const pending = transport("/commands", request);
      await settle();
      mutate(request);
      release();
      const reply = await pending;
      if (!reply.ok) throw httpError(reply);
    }).catch(() => undefined);
    await settle();
  }
  return { clock, gate, controller, server, script, calls, state, sent, of, storage, command, sessionRead, mutatedCommand,
    idb, legacy, other: idbInstallationStore(factory, () => legacy.storage),
    row: () => idb.rows(INSTALLATION_DATABASE, INSTALLATION_STORE).get(PROFILE) as unknown,
    /** Another window's committed value (a test write into the shared database). */
    seed: (value: unknown) => idb.seed(INSTALLATION_DATABASE, INSTALLATION_STORE, PROFILE, value),
    stored: async () => { const value = idb.rows(INSTALLATION_DATABASE, INSTALLATION_STORE).get(PROFILE);
      if (value === undefined) return null;
      const record = strictInstallation(value, PROFILE);
      return record === "invalid" ? null : record; } };
}
type Chain = ReturnType<typeof chain>;

async function working(f: Chain) {
  await f.controller.start(); await settle();
  expect(f.state()).toEqual({ kind: "opened" });
  return { a: (await f.stored())!, doc: f.gate.snapshot().lastWorkingDoc! };
}
async function refused(f: Chain, kind = "setting.save") {
  f.script.module.push(bare403());
  await f.command(kind);
}
async function automatics(f: Chain) {
  f.gate.closeByFailure("unknown"); await f.clock.advanceBy(60_000);
  f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
  await f.controller.foreground("show"); await f.controller.foreground("screen"); await f.clock.advanceBy(60_000);
  await f.controller.retry(); await settle();
}
const ignoringProbes = (f: Chain) => f.sent().length;

describe("C163 шаг 5: the candidate and its immediate re-entry state", () => {
  it("a bare FORBIDDEN of setting.save with a really sent proof: A's rights end at once, the re-entry is shown, A's record and nothing else is touched; nothing is automatic", async () => {
    const f = chain(); const { a } = await working(f);
    await refused(f);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
    expect(f.controller.getOpenedAccess()).toBeNull();
    expect(f.gate.snapshot().lastWorkingDoc).toBeNull();
    expect(await f.stored()).toEqual(a);
    const sent = ignoringProbes(f);
    await automatics(f);
    expect(ignoringProbes(f)).toBe(sent);
  });

  it("the explicit click: auth → the fresh same admitted profile → NEW client_instance_id/registration_id B → register → ONE first open of B (no A reuse, no old POST)", async () => {
    const f = chain(); const { a, doc } = await working(f);
    await refused(f);
    const commands = f.of("/commands").length, registers = f.of("/client/register").length, opens = f.of("/client/open").length;
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    const register = f.of("/client/register").slice(registers);
    expect(register).toHaveLength(1);
    expect(register[0].body!.client_instance_id).not.toBe(a.clientInstanceId);
    expect(register[0].body!.registration_id).not.toBe(a.registrationId);
    const open = f.of("/client/open").slice(opens);
    expect(open.map(call => [call.body!.event, call.body!.client_instance_id])).toEqual([["open", register[0].body!.client_instance_id]]);
    expect(open[0].body!.document_id).not.toBe(doc.documentId);
    expect(open[0].body!.return_marker).toBeUndefined();
    expect(open[0].proof).toBe(`proof-${String(register[0].body!.client_instance_id).slice(-3)}`);
    expect(f.of("/commands")).toHaveLength(commands);
    expect((await f.stored())!.clientInstanceId).toBe(register[0].body!.client_instance_id);
  });

  it("B meets the occupancy of A: the busy screen of B with the target, no automatic Stop, nothing invented for B", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.server.busy = true;
    const commands = f.of("/commands").length;
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "busy", remoteTarget: TARGET });
    expect(f.gate.snapshot().lastWorkingDoc).toBeNull();
    await automatics(f);
    expect(f.of("/commands")).toHaveLength(commands);
    expect((await f.stored())!.activated).toBe(false);
  });
});

describe("C163 шаг 5: not the candidate (default deny) — the ordinary stop of M-P03-10, no re-entry", () => {
  const cases: [string, (f: Chain) => Promise<void>][] = [
    ["an owner kind (access.decide)", async f => { f.script.module.push(bare403()); await f.command("access.decide"); }],
    ["an unknown kind", async f => { f.script.module.push(bare403()); await f.command("onboarding.advance"); }],
    // C407: session.stop_remote is a real sender, but never a request of OpenedAccess (the entry's RemoteStopController):
    // its entry in the set was unreachable and is removed; through a live handle it would not be a candidate either.
    ["session.stop_remote (removed from the set)", async f => { f.script.module.push(bare403()); await f.command("session.stop_remote"); }],
    ["a business FORBIDDEN with the command envelope", async f => {
      f.script.module.push(body => json({ command: { id: body.command_id, status: "rejected" }, current: {}, state_version: "11",
        error: { code: "FORBIDDEN" } }, 403));
      await f.command("card.relearn"); }],
    ["a FORBIDDEN body with another field", async f => { f.script.module.push(json({ error: { code: "FORBIDDEN", message: "x" } }, 403)); await f.command("setting.save"); }],
    ["a 403 without a JSON body", async f => { f.script.module.push(new Response("", { status: 403 })); await f.command("setting.save"); }],
    ["no proof header really sent", async f => { f.script.module.push(bare403()); await f.command("setting.save", { proof: null }); }],
    ["another document in the request", async f => { f.script.module.push(bare403()); await f.command("setting.save", { document: uuid(999) }); }],
    ["GET /sessions/{id} with only assignment_id", async f => { f.script.module.push(bare403()); await f.sessionRead({ assignment_id: uuid(70) }); }],
  ];
  for (const [name, refuse] of cases) it(`${name}: unavailable, no sign-in, no register, no open`, async () => {
    const f = chain(); await working(f);
    await refuse(f);
    expect(f.state()).toEqual({ kind: "unavailable" });
    const sent = ignoringProbes(f);
    await f.controller.reenter(); await automatics(f);
    expect(ignoringProbes(f)).toBe(sent);
  });

  it.each([
    ["without assignment_id and result_id", {}],
    ["with BOTH assignment_id and result_id", { assignment_id: uuid(70), result_id: uuid(71) }],
  ])("GET /sessions/{id} %s is a candidate", async (_n, params) => {
    const f = chain(); await working(f);
    f.script.module.push(bare403());
    await f.sessionRead(params);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
  });

  it("a second candidate on B's document stops (one recovery per page, no cycle)", async () => {
    const f = chain(); await working(f);
    await refused(f);
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    await refused(f);
    expect(f.state()).toEqual({ kind: "unavailable" });
    const sent = ignoringProbes(f);
    await f.controller.reenter(); await automatics(f);
    expect(ignoringProbes(f)).toBe(sent);
  });

  it("a late refusal of the old handle changes nothing after the recovery began", async () => {
    const f = chain(); await working(f);
    let late!: (r: Response) => void;
    f.script.module.push(bare403(), () => new Promise<Response>(resolve => { late = resolve; }));
    const pending = f.command("field.save");
    await f.command("setting.save");
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
    const updates = f.state();
    late(bare403()); await pending;
    expect(f.state()).toEqual(updates);
    await f.controller.reenter(); await settle();
    expect(f.of("/client/register")).toHaveLength(2); // the start's A and one B
  });
});

describe("C163 шаг 5: the re-entry's own failures stop or come back — never A, never automatic", () => {
  it("auth fails by transport: no register/open; the button again; the next click goes on to B", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.script.auth.push("network");
    await f.controller.reenter(); await settle();
    expect(f.of("/client/register")).toHaveLength(1);
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true });
    await f.clock.advanceBy(5_000);
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.of("/client/register")).toHaveLength(2);
  });

  it("auth 401 AUTH_EXPIRED (initData older than max_age): Н4 — no button, nothing more", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.script.auth.push(json({ error: { code: "AUTH_EXPIRED" } }, 401));
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "expired" });
    const sent = ignoringProbes(f);
    await f.controller.reenter(); await automatics(f);
    expect(ignoringProbes(f)).toBe(sent);
    expect(f.of("/client/register")).toHaveLength(1);
  });

  it.each(["pending", "rejected"] as const)("the fresh profile is %s: its own screen, no register, no open", async access => {
    const f = chain(); await working(f);
    await refused(f);
    f.server.access = access;
    const opens = f.of("/client/open").length;
    await f.controller.reenter(); await settle();
    expect(f.state().kind).toBe(access);
    expect(f.of("/client/register")).toHaveLength(1);
    expect(f.of("/client/open")).toHaveLength(opens);
  });

  it("the fresh profile is ANOTHER profile: no register, no open", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.server.profileId = uuid(2);
    const opens = f.of("/client/open").length;
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable" });
    expect(f.of("/client/register")).toHaveLength(1);
    expect(f.of("/client/open")).toHaveLength(opens);
  });

  it("register of B is refused (bare 403, e.g. a profile without its coordination row): stop, no open, no cycle", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.script.register.push(bare403());
    const opens = f.of("/client/open").length;
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable" });
    expect(f.of("/client/open")).toHaveLength(opens);
    const sent = ignoringProbes(f);
    await f.controller.reenter(); await automatics(f);
    expect(ignoringProbes(f)).toBe(sent);
  });

  it("register of B fails by transport: the button again; the next click makes another new B (its registration was the earlier sign-in's), never A", async () => {
    const f = chain(); const { a } = await working(f);
    await refused(f);
    f.script.register.push("network");
    await f.controller.reenter(); await settle();
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true });
    await f.clock.advanceBy(5_000);
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    const ids = f.of("/client/register").slice(1).map(call => call.body!.client_instance_id);
    expect(ids).toHaveLength(2);
    expect(new Set([...ids, a.clientInstanceId]).size).toBe(3);
  });

  it("B's first open is refused with 403 FORBIDDEN: no п.8б (5) repeat, stop", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.script.open.push(bare403());
    const opens = f.of("/client/open").length;
    await f.controller.reenter(); await settle();
    expect(f.of("/client/open")).toHaveLength(opens + 1);
    expect(f.state()).toEqual({ kind: "unavailable" });
    expect(f.gate.snapshot().retryAfter403Doc).toBeNull();
    const sent = ignoringProbes(f);
    await f.controller.reenter(); await automatics(f);
    expect(ignoringProbes(f)).toBe(sent);
  });

  it.each([
    ["hidden while the auth is in flight", (f: Chain) => { f.script.auth.push(() => { f.controller.setVisible(false); f.gate.setVisible(false);
      return json({ access_token: "token-h", expires_at: "2026-10-17T00:00:00Z", compatibility,
        profile: { profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "10",
          access: { status: "admitted", version: "1", reason: null } } }); }); }],
    ["the gate closes while the register is in flight", (f: Chain) => { f.script.register.push(body => { f.gate.closeByFailure("unknown");
      return json({ status: "registered", client_instance_id: body.client_instance_id, origin_proof: "proof-g", proof_version: "1", activated: false }); }); }],
  ])("%s: B's first open does not reach L2; no queued click; the next click opens B", async (_n, hold) => {
    const f = chain(); await working(f);
    await refused(f);
    hold(f);
    const opens = f.of("/client/open").length, attempts = f.gate.snapshot().openAttempts.length;
    await f.controller.reenter(); await settle();
    expect(f.of("/client/open")).toHaveLength(opens);
    expect(f.gate.snapshot().openAttempts).toHaveLength(attempts);
    f.gate.setVisible(true); f.controller.setVisible(true);
    await f.controller.foreground("show"); await f.clock.advanceBy(60_000);
    expect(f.of("/client/open")).toHaveLength(opens);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.of("/client/open")).toHaveLength(opens + 1);
  });

  // 6b (P2-6A, QA RB1): between two clicks a record with OUR B's client id but another registration and proof appears
  // (outside the protocol) — it is not our B: no register, no open with its proof.
  it("RB1: our B's client id with a foreign registration and proof between clicks: no reuse — 0 register, 0 open", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.script.register.push("network");
    await f.controller.reenter(); await settle();
    expect(f.state()).toMatchObject({ kind: "expired", reentry: true });
    const b = f.row() as Record<string, unknown>;
    f.seed({ ...b, registrationId: uuid(888), proof: "proof-foreign", proofVersion: "7" });
    const registers = f.of("/client/register").length, opens = f.of("/client/open").length;
    await f.clock.advanceBy(10_000);
    await f.controller.reenter(); await settle();
    expect(f.of("/client/register")).toHaveLength(registers);
    expect(f.of("/client/open")).toHaveLength(opens);
    expect(f.calls.some(call => call.proof === "proof-foreign")).toBe(false);
    expect(f.state()).toEqual({ kind: "unavailable" });
  });

  it("the shared storage holds A with a NEWER proof (another window of A registered again): no B, no register, no open", async () => {
    const f = chain(); const { a } = await working(f);
    await refused(f);
    f.seed({ ...a, proof: "proof-other", proofVersion: "2" });
    await f.controller.reenter(); await settle();
    expect(f.state()).toEqual({ kind: "unavailable" });
    expect(f.of("/client/register")).toHaveLength(1);
  });
});

describe("C163 шаг 5b (P2-5A): the classifier reads only the frozen snapshot of what really left", () => {
  it("X1: access.decide was sent, the request's kind changed to setting.save afterwards — not a candidate", async () => {
    const f = chain(); await working(f);
    await f.mutatedCommand("access.decide", request => { request.body.kind = "setting.save"; });
    expect(f.of("/commands").at(-1)!.body!.kind).toBe("access.decide");
    expect(f.state()).toEqual({ kind: "unavailable" });
  });
  it("X2: a foreign document_id was sent, changed to this document afterwards — not a candidate", async () => {
    const f = chain(); const { doc } = await working(f);
    await f.mutatedCommand("setting.save", request => { request.body.document_id = doc.documentId; }, { document: uuid(999) });
    expect(f.state()).toEqual({ kind: "unavailable" });
  });
  it("X3: no proof header was sent, a proof set on the request afterwards — not a candidate", async () => {
    const f = chain(); await working(f);
    await f.mutatedCommand("setting.save", request => { request.proof = "late-proof"; }, { proof: null });
    expect(f.of("/commands").at(-1)!.proof).toBeNull();
    expect(f.state()).toEqual({ kind: "unavailable" });
  });
  it("X4 (control): an allowed kind of this document with its proof, nothing changed — a candidate", async () => {
    const f = chain(); await working(f);
    await f.mutatedCommand("setting.save", () => undefined);
    expect(f.state()).toEqual({ kind: "expired", reentry: true, checkable: true });
  });
});

// P2-5B, C163 integration (store canon §4): the four writers decide on the ACTUAL record inside one readwrite transaction.
// Another window of this protocol commits while this page's transaction waits behind it; this page's B decides on what
// it then finds. An old tab that writes only localStorage is ignored after the import (Y1r, CON204 remainder §8).
describe("C163 integration (P2-5B): B in the store's transaction — another window's record is never overwritten", () => {
  const foreign = { profileId: PROFILE, clientInstanceId: uuid(777), registrationId: uuid(778), proof: "proof-foreign",
    proofVersion: "5", activated: false };
  /** Another window's write is placed and its commit held; this page's re-entry queues behind it; then it commits. */
  async function whileOtherCommits(f: Chain, value: unknown, during?: () => void) {
    const release = f.idb.holdCommits();
    const other = f.other.mutate(PROFILE, () => true, () => ({ write: value as never, result: null }));
    await settle();
    const task = f.controller.reenter();
    await settle();
    during?.();
    release();
    await other; await task; await settle();
  }
  it("Y1: another window commits its own B while this page waits — not overwritten; 0 register, 0 open", async () => {
    const f = chain(); await working(f);
    await refused(f);
    const registers = f.of("/client/register").length, opens = f.of("/client/open").length;
    await whileOtherCommits(f, foreign);
    expect(f.row()).toEqual(foreign);
    expect(f.of("/client/register")).toHaveLength(registers);
    expect(f.of("/client/open")).toHaveLength(opens);
    expect(f.state()).toEqual({ kind: "unavailable" });
  });
  it("Y2: another window commits a fresher A (newer proof) meanwhile — not overwritten; 0 register, 0 open", async () => {
    const f = chain(); const { a } = await working(f);
    await refused(f);
    const fresher = { ...a, proof: "proof-A2", proofVersion: "2" };
    const registers = f.of("/client/register").length, opens = f.of("/client/open").length;
    await whileOtherCommits(f, fresher);
    expect(f.row()).toEqual(fresher);
    expect(f.of("/client/register")).toHaveLength(registers);
    expect(f.of("/client/open")).toHaveLength(opens);
  });
  it("Y2w: the other window's own protocol writer (its register result for A) runs first — this page's B sees it and stops", async () => {
    const f = chain(); const { a } = await working(f);
    await refused(f);
    const registers = f.of("/client/register").length;
    await f.other.mutate(PROFILE, () => true, current => ({ write: { profileId: current!.profileId, clientInstanceId: current!.clientInstanceId,
      registrationId: current!.registrationId, proof: "proof-A3", proofVersion: "3", activated: current!.activated }, result: null }));
    await f.controller.reenter(); await settle();
    expect(f.row()).toEqual({ ...a, proof: "proof-A3", proofVersion: "3" });
    expect(f.of("/client/register")).toHaveLength(registers);
  });
  it("Y1r (CON204 remainder): an old tab that writes only localStorage is ignored after the import — no read, B as usual", async () => {
    const f = chain(); await working(f);
    await refused(f);
    f.legacy.map.set(installationKey(PROFILE), JSON.stringify(foreign));
    const reads = f.legacy.log.filter(line => line.startsWith("get")).length;
    const registers = f.of("/client/register").length;
    await f.controller.reenter(); await settle();
    expect(f.legacy.log.filter(line => line.startsWith("get")).length).toBe(reads); // 0 localStorage reads for the record
    expect(f.legacy.map.get(installationKey(PROFILE))).toBe(JSON.stringify(foreign)); // not touched either
    expect(f.of("/client/register")).toHaveLength(registers + 1);
    expect((f.row() as { clientInstanceId: string }).clientInstanceId).not.toBe(foreign.clientInstanceId);
  });
  it("Y3: dispose while this page waits behind another window — nothing written by it; 0 register, 0 open", async () => {
    const f = chain(); const { a } = await working(f);
    await refused(f);
    const registers = f.of("/client/register").length, opens = f.of("/client/open").length;
    await whileOtherCommits(f, a, () => f.controller.dispose());
    expect(f.row()).toEqual(a);
    expect(f.of("/client/register")).toHaveLength(registers);
    expect(f.of("/client/open")).toHaveLength(opens);
  });
});

// QA a2f6d85b (P3-I2, qa_integ R5) as a regression: §5 through the real chain Entry → L2 → transport. Between the strict
// legacy read and the open: a window closed for good (closedWindow) sends no open; a hidden window keeps the ordinary
// first open of M9 (not a new ban) — in both cases 0 installation writes and 0 register.
describe("§5 noIDB through the real chain: closed / hidden between the legacy read and the open", () => {
  const A5 = { profileId: PROFILE, clientInstanceId: uuid(41), registrationId: uuid(42), proof: "proof-a5", proofVersion: "1", activated: true };
  for (const what of ["closed", "hidden", "control"] as const) it(`${what} between the legacy read and the open`, async () => {
    const f = chain({ indexedDb: "absent" });
    f.legacy.map.set(installationKey(PROFILE), JSON.stringify(A5));
    const read = f.legacy.storage.getItem.bind(f.legacy.storage);
    f.legacy.storage.getItem = key => {
      const value = read(key);
      if (what === "closed") f.gate.closeWindow();
      if (what === "hidden") { f.controller.setVisible(false); f.gate.setVisible(false); }
      return value;
    };
    await f.controller.start(); await settle();
    const opens = f.of("/client/open");
    expect(f.of("/client/register")).toHaveLength(0);
    expect(f.legacy.log.filter(line => line.startsWith("set") || line.startsWith("remove"))).toHaveLength(0);
    expect(f.idb.log).toHaveLength(0); // the store has no database at all: nothing is written anywhere
    if (what === "closed") expect(opens).toHaveLength(0);
    else {
      // hidden: the ordinary first open of M9 goes as at any start (no new ban); control: the same.
      expect(opens.map(open => open.proof)).toEqual(["proof-a5"]);
      expect(f.state()).toEqual({ kind: "opened" });
    }
  });
});
