// The DOCUMENT_STALE junction P02↔P03 through the real chain Entry → write gate → transport (onDocumentStale with its
// local source, as App wires it) on the gate's manual clock: an attributed refusal of POST settings.reset proves the
// replacement of this very document and closes it at once; a card context's refusal only asks for the foreground check;
// a late answer of another document, profile or exchange never closes the current window; the closure is terminal.
import { describe, expect, it, vi } from "vitest";
import { TestEntryController } from "./entryInstallation.test-support";
import { createEntryApi } from "../api/entryApi";
import { createAvailabilityClient } from "../api/availability";
import { createJsonTransport, type HttpOptions } from "../api/http";
import type { AsyncStorage } from "../platform/storage";
import { WriteGate } from "../commands/writeGate";
import { ManualClock, settle } from "../commands/writeGate.test-support";
import type { EntryController, EntrySnapshot } from "./entryController";
import { createTodayApi } from "../today/todayApi";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROFILE = uuid(1);
const profile = () => ({ profile_id: PROFILE, role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
  state_version: "10", access: { status: "admitted", version: "1", reason: null } });
const compatibility = { compatible: true, contract_version: "1" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
/** The core's attributed refusal of a command (settings/reset.py:282–287, :343–346): the command, its current, the code. */
const attributed = (commandId: string, code = "DOCUMENT_STALE") => json({ command: { id: commandId, status: "rejected" },
  current: { status: "unavailable" }, state_version: "10", error: { code } }, 409);
const bare = (code = "DOCUMENT_STALE") => json({ error: { code } }, 409);

function memory(): AsyncStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); },
    remove: async key => { values.delete(key); } };
}

type Reply = Response | Promise<Response>;
/** The window check of a DOCUMENT_STALE starts one real task later (EntryController.documentStale): let it run. */
const tick = async () => { await new Promise(resolve => setTimeout(resolve, 5)); await settle(); };
function chain() {
  const clock = new ManualClock();
  const calls: string[] = [];
  const script = { open: [] as Reply[], commands: [] as Reply[] };
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(String(url), "http://localhost").pathname.replace("/api/v1", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push(`${init?.method ?? "GET"} ${path}${body?.kind ? ` ${body.kind}` : ""}${body?.event ? ` ${body.event}` : ""}`);
    if (path === "/availability") return json({ status: "ready", retry_after_s: null });
    if (path === "/auth/telegram") return json({ access_token: "token", expires_at: "2026-10-17T00:00:00Z", profile: profile(), compatibility });
    if (path === "/client/register") return json({ status: "registered", client_instance_id: body.client_instance_id,
      origin_proof: "proof", proof_version: "1", activated: false });
    if (path === "/client/open") {
      const next = script.open.shift();
      if (next) return next;
      return json({ status: "opened", client_instance_id: body.client_instance_id, document_id: body.document_id,
        document_epoch: "1", proof_version: "1", profile: profile(), session: null, compatibility });
    }
    if (path === "/commands" && init?.method === "POST") return script.commands.shift() ?? json({ error: { code: "UNSCRIPTED" } }, 500);
    return json({ error: { code: "NOT_FOUND" } }, 404);
  });
  const gate = new WriteGate({ clock });
  // As App wires it: the transport tells the window of every DOCUMENT_STALE with the request it answered.
  let controller: EntryController | null = null;
  const http: HttpOptions = { fetcher: fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 100_000, gate,
    onDocumentStale: source => controller?.documentStale(source) };
  gate.attachProbe(createAvailabilityClient(http).probe);
  gate.trackAccess();
  const storage = memory(), updates: EntrySnapshot[] = [], closeWindow = vi.fn(), checks: boolean[] = [];
  let next = 100, instance = "";
  controller = new TestEntryController({ gate, api: createEntryApi(http), today: createTodayApi(http), storage,
    lock: { acquire: vi.fn(async () => ({ release: vi.fn() })) }, initData: "signed", savedLanguage: "ru",
    browserLanguage: "ru", clientVersion: "0.0.0", contractVersion: "1", timeZone: () => "UTC",
    newId: () => uuid(next++), closeWindow, onUpdate: snapshot => updates.push(snapshot),
    onDocumentCheck: checking => checks.push(checking) });
  const request = createJsonTransport(http);
  const state = () => updates.at(-1)!.state;
  /** A command of this page for document documentId, sent through the shared transport as a module sends it. */
  const command = (kind: string, id: number, documentId: string) => request("/commands", { method: "POST", token: "token",
    proof: "proof", body: { command_id: uuid(id), kind, payload: {}, client_instance_id: instance, document_id: documentId } })
    .then(reply => reply, (error: unknown) => error);
  /** The same, but the caller keeps its body object: a test may change it while the exchange is in flight (C408). */
  const commandBody = (kind: string, id: number, documentId: string) => {
    const body = { command_id: uuid(id), kind, payload: {}, client_instance_id: instance, document_id: documentId };
    const sending = request("/commands", { method: "POST", token: "token", proof: "proof", body }).then(reply => reply, (error: unknown) => error);
    return { body, sending };
  };
  const foregrounds = () => calls.filter(call => call === "POST /client/open foreground").length;
  return { clock, gate, fetcher, controller: controller!, script, calls, state, storage, closeWindow, checks, command, commandBody, foregrounds,
    setInstance: (value: string) => { instance = value; } };
}

async function working(f: ReturnType<typeof chain>) {
  await f.controller.start(); await settle();
  expect(f.state()).toEqual({ kind: "opened" });
  const doc = f.gate.snapshot().lastWorkingDoc!;
  const open = f.fetcher.mock.calls.find(([url]) => String(url).endsWith("/client/open"))!;
  f.setInstance(JSON.parse(String(open[1]!.body)).client_instance_id);
  return doc;
}

describe("DOCUMENT_STALE junction (1): an attributed refusal of POST settings.reset closes exactly this document", () => {
  it("synchronously terminal before the module reads the refusal; then 0 GET, 0 cancel POST, 0 probes, 0 foreground", async () => {
    const f = chain(); const doc = await working(f);
    f.storage.values.set("wortly.pending.settings-reset:synthetic", JSON.stringify({ intent: { command_id: uuid(700) } }));
    const saved = JSON.stringify([...f.storage.values]);
    f.script.commands.push(attributed(uuid(700)));
    let gateAtRead: unknown = null;
    const reply = await f.command("settings.reset", 700, doc.documentId).then(value => {
      // What the module sees when it reads the refusal: the window is already closed for good.
      gateAtRead = f.gate.snapshot().closedWindow;
      return value;
    });
    expect((reply as { status: number }).status).toBe(409);
    expect(gateAtRead).toMatchObject({ doc: { documentId: doc.documentId } });
    expect(f.state()).toEqual({ kind: "replaced" });
    expect(f.closeWindow).toHaveBeenCalledOnce(); // the native close (Telegram) or the fallback screen without buttons
    expect(f.checks).toEqual([]); // no foreground check was started for it
    const count = f.fetcher.mock.calls.length;
    // The module's next steps are refused by the gate itself: no status read of X, no cancel, no other command.
    await expect(createJsonTransport({ fetcher: f.fetcher as typeof fetch, timeoutMs: 1_000, maxResponseBytes: 100_000, gate: f.gate })(
      `/commands/${uuid(700)}`, { method: "GET" })).rejects.toMatchObject({ reason: "closed_window" });
    await f.command("settings.reset_cancel", 701, doc.documentId);
    await f.controller.foreground(); await f.controller.foreground("show"); await f.controller.retry();
    f.controller.setVisible(false); f.gate.setVisible(false); f.gate.setVisible(true); f.controller.setVisible(true);
    await f.clock.advanceTo(300_000); await settle();
    expect(f.fetcher.mock.calls.length).toBe(count);
    expect(JSON.stringify([...f.storage.values])).toBe(saved); // the pending X is left as it was
  });
});

describe("DOCUMENT_STALE junction (2): a card context's refusal keeps the foreground check", () => {
  it.each([
    ["context.close of the live document (closed card context)", "context.close", true],
    ["settings.reset without the core's attribution (a bare 409)", "settings.reset", false],
  ])("%s → one foreground of the same document; the live window stays", async (_name, kind, withCommand) => {
    const f = chain(); const doc = await working(f);
    f.script.commands.push(withCommand ? attributed(uuid(710)) : bare());
    await f.command(kind, 710, doc.documentId); await settle(); await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.closeWindow).not.toHaveBeenCalled();
    expect(f.gate.snapshot().closedWindow).toBeNull();
    expect(f.foregrounds()).toBe(1);
    expect(f.checks).toEqual([true, false]);
  });
});

describe("DOCUMENT_STALE junction (3): a late answer never closes the current window", () => {
  it("of an older exchange: an `opened` was confirmed after the reset left → the check, not the closure", async () => {
    const f = chain(); const doc = await working(f);
    let answer!: (reply: Response) => void;
    f.script.commands.push(new Promise<Response>(resolve => { answer = resolve; }));
    const sending = f.command("settings.reset", 720, doc.documentId);
    await settle();
    await f.controller.foreground(); await settle(); // the window's own foreground confirmed the document meanwhile
    expect(f.state()).toEqual({ kind: "opened" });
    answer(attributed(uuid(720))); await sending; await settle(); await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.closeWindow).not.toHaveBeenCalled();
  });

  it("of another document: a reset this page sent for another document_id is ignored — no closure, no check", async () => {
    const f = chain(); await working(f);
    f.script.commands.push(attributed(uuid(730)));
    await f.command("settings.reset", 730, uuid(999)); await settle(); await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.closeWindow).not.toHaveBeenCalled();
    expect(f.foregrounds()).toBe(0);
    expect(f.checks).toEqual([]);
  });

  it("of another profile's document: the gate's document of reference changed meanwhile → not current, no closure", async () => {
    const f = chain(); const doc = await working(f);
    let answer!: (reply: Response) => void;
    f.script.commands.push(new Promise<Response>(resolve => { answer = resolve; }));
    const sending = f.command("settings.reset", 740, doc.documentId);
    await settle();
    f.gate.noteOpened({ ...doc, profileId: uuid(2) }); // the page's document of reference is another profile's now
    answer(attributed(uuid(740))); await sending; await settle();
    expect(f.state()).not.toEqual({ kind: "replaced" });
    expect(f.closeWindow).not.toHaveBeenCalled();
  });

  it("an answer whose command is another one (the envelope names a different id) is no proof", async () => {
    const f = chain(); const doc = await working(f);
    f.script.commands.push(attributed(uuid(751)));
    await f.command("settings.reset", 750, doc.documentId); await settle(); await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.closeWindow).not.toHaveBeenCalled();
  });
});

describe("DOCUMENT_STALE junction (5): after the terminal closure nothing revives the window", () => {
  it("ready, the probe series, a show and a late DOCUMENT_STALE or success of another request change nothing", async () => {
    const f = chain(); const doc = await working(f);
    let late!: (reply: Response) => void, lateOk!: (reply: Response) => void;
    f.script.commands.push(new Promise<Response>(resolve => { late = resolve; }), new Promise<Response>(resolve => { lateOk = resolve; }));
    const first = f.command("context.close", 760, doc.documentId), second = f.command("settings.save", 761, doc.documentId);
    await settle();
    f.script.commands.push(attributed(uuid(762)));
    await f.command("settings.reset", 762, doc.documentId); await settle();
    expect(f.state()).toEqual({ kind: "replaced" });
    const count = f.fetcher.mock.calls.length;
    late(bare()); lateOk(json({ command: { id: uuid(761), status: "applied" }, state_version: "11" }));
    await first; await second; await tick();
    f.gate.closeByFailure(); await f.clock.advanceTo(600_000); await settle();
    f.controller.setVisible(false); f.controller.setVisible(true); await f.controller.foreground("show"); await settle();
    expect(f.state()).toEqual({ kind: "replaced" });
    expect(f.fetcher.mock.calls.length).toBe(count);
    expect(f.closeWindow).toHaveBeenCalledOnce();
    expect(f.checks).toEqual([]);
  });

  it("a window closed by N14/ВР-8б (SESSION_BUSY on its return) starts no check for a late DOCUMENT_STALE either", async () => {
    const f = chain(); const doc = await working(f);
    let late!: (reply: Response) => void;
    f.script.commands.push(new Promise<Response>(resolve => { late = resolve; }));
    const pending = f.command("context.close", 770, doc.documentId);
    await settle();
    f.script.open.push(json({ status: "SESSION_BUSY", profile: profile(), compatibility, session: { status: "busy", stop_remote_target: uuid(50) } }));
    await f.controller.foreground("show"); await settle();
    expect(f.state()).toEqual({ kind: "closed", reason: "busy" });
    const count = f.fetcher.mock.calls.length;
    late(bare()); await pending; await tick();
    expect(f.checks).toEqual([]);
    expect(f.state()).toEqual({ kind: "closed", reason: "busy" });
    expect(f.fetcher.mock.calls.length).toBe(count);
  });
});

describe("DOCUMENT_STALE junction fix1 (C408): the source is what the exchange sent, not the caller's object afterwards", () => {
  async function held(f: ReturnType<typeof chain>, kind: string, id: number, documentId: string) {
    let answer!: (reply: Response) => void;
    f.script.commands.push(new Promise<Response>(resolve => { answer = resolve; }));
    const sent = f.commandBody(kind, id, documentId);
    await settle();
    return { ...sent, answer };
  }
  it("M1: a context.close whose body object becomes a settings.reset in flight only asks for the foreground check", async () => {
    const f = chain(); const doc = await working(f);
    const x = await held(f, "context.close", 950, doc.documentId);
    x.body.kind = "settings.reset";
    x.answer(attributed(uuid(950))); await x.sending; await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.closeWindow).not.toHaveBeenCalled();
    expect(f.foregrounds()).toBe(1);
  });
  it("M2: a reset sent for another document whose body object is given this document in flight closes nothing", async () => {
    const f = chain(); const doc = await working(f);
    const x = await held(f, "settings.reset", 951, uuid(999));
    x.body.document_id = doc.documentId;
    x.answer(attributed(uuid(951))); await x.sending; await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.closeWindow).not.toHaveBeenCalled();
    expect(f.foregrounds()).toBe(0);
  });
  it("M2b: a command_id changed in flight to the one the envelope names is no attribution", async () => {
    const f = chain(); const doc = await working(f);
    const x = await held(f, "settings.reset", 952, doc.documentId);
    x.body.command_id = uuid(953);
    x.answer(attributed(uuid(953))); await x.sending; await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.closeWindow).not.toHaveBeenCalled();
  });
  it("M3 (control): the unchanged reset held in flight closes the window", async () => {
    const f = chain(); const doc = await working(f);
    const x = await held(f, "settings.reset", 954, doc.documentId);
    x.answer(attributed(uuid(954))); await x.sending; await settle();
    expect(f.state()).toEqual({ kind: "replaced" });
    expect(f.closeWindow).toHaveBeenCalledOnce();
  });
});

describe("DOCUMENT_STALE junction fix1 (C408): the three kinds of the reset family prove the replacement", () => {
  it.each(["settings.reset", "settings.reset_cancel", "settings.reset_barrier"])("%s of the current document and profile closes it", async kind => {
    const f = chain(); const doc = await working(f);
    f.script.commands.push(attributed(uuid(960)));
    await f.command(kind, 960, doc.documentId); await settle();
    expect(f.state()).toEqual({ kind: "replaced" });
    expect(f.closeWindow).toHaveBeenCalledOnce();
    expect(f.checks).toEqual([]);
  });
  it.each(["settings.save", "context.open", "session.start", "settings.reset_cancelled"])("%s is no proof: the check only", async kind => {
    const f = chain(); const doc = await working(f);
    f.script.commands.push(attributed(uuid(961)));
    await f.command(kind, 961, doc.documentId); await tick();
    expect(f.state()).toEqual({ kind: "opened" });
    expect(f.foregrounds()).toBe(1);
  });
  it.each(["settings.reset_cancel", "settings.reset_barrier"])("%s answered after a new opened, or after Z5, closes nothing", async kind => {
    for (const change of ["opened", "z5"] as const) {
      const f = chain(); const doc = await working(f);
      let answer!: (reply: Response) => void;
      f.script.commands.push(new Promise<Response>(resolve => { answer = resolve; }));
      const sending = f.command(kind, 962, doc.documentId);
      await settle();
      if (change === "opened") { await f.controller.foreground(); await settle(); }
      else f.gate.resetDocument(); // Z5: the document changed without a closure
      answer(attributed(uuid(962))); await sending; await tick();
      expect(f.state(), change).not.toEqual({ kind: "replaced" });
      expect(f.closeWindow, change).not.toHaveBeenCalled();
    }
  });
  it("a cancel for another profile's document of reference closes nothing", async () => {
    const f = chain(); const doc = await working(f);
    let answer!: (reply: Response) => void;
    f.script.commands.push(new Promise<Response>(resolve => { answer = resolve; }));
    const sending = f.command("settings.reset_cancel", 963, doc.documentId);
    await settle();
    f.gate.noteOpened({ ...doc, profileId: uuid(2) });
    answer(attributed(uuid(963))); await sending; await tick();
    expect(f.state()).not.toEqual({ kind: "replaced" });
    expect(f.closeWindow).not.toHaveBeenCalled();
  });
});

describe("DOCUMENT_STALE junction × P04 (rebase on 44f65bc): the deletion's end and the replacement never undo each other", () => {
  it("after the deletion screen ended the document (deleted, unknown), a late attributed reset refusal changes nothing", async () => {
    for (const end of [{ kind: "deleted" as const }, { kind: "unknown" as const, confirmedProfileId: PROFILE }]) {
      const f = chain(); const doc = await working(f);
      let answer!: (reply: Response) => void;
      f.script.commands.push(new Promise<Response>(resolve => { answer = resolve; }));
      const sending = f.command("settings.reset", 980, doc.documentId);
      await settle();
      f.controller.endAfterDeletion(end);
      const shown = f.state(), count = f.fetcher.mock.calls.length;
      expect(shown).toEqual({ kind: end.kind === "deleted" ? "profile_deleted" : "deletion_unknown" });
      answer(attributed(uuid(980))); await sending; await tick();
      expect(f.state(), end.kind).toEqual(shown);
      expect(f.closeWindow).not.toHaveBeenCalled();
      expect(f.checks).toEqual([]);
      expect(f.fetcher.mock.calls.length).toBe(count);
    }
  });
  it("after 403 PROFILE_DELETED on the window's foreground, a late reset refusal neither closes nor checks", async () => {
    const f = chain(); const doc = await working(f);
    let answer!: (reply: Response) => void;
    f.script.commands.push(new Promise<Response>(resolve => { answer = resolve; }));
    const sending = f.command("settings.reset_cancel", 981, doc.documentId);
    await settle();
    f.script.open.push(json({ error: { code: "PROFILE_DELETED" } }, 403));
    await f.controller.foreground(); await settle();
    expect(f.state()).toEqual({ kind: "profile_deleted" });
    const count = f.fetcher.mock.calls.length;
    answer(attributed(uuid(981))); await sending; await tick();
    expect(f.state()).toEqual({ kind: "profile_deleted" });
    expect(f.closeWindow).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls.length).toBe(count);
  });
  it("a window already replaced by the reset refusal stays replaced when the deletion screen ends afterwards", async () => {
    const f = chain(); const doc = await working(f);
    f.script.commands.push(attributed(uuid(982)));
    await f.command("settings.reset_barrier", 982, doc.documentId); await settle();
    expect(f.state()).toEqual({ kind: "replaced" });
    const count = f.fetcher.mock.calls.length;
    f.controller.endAfterDeletion({ kind: "deleted" }); await tick();
    expect(f.state()).toEqual({ kind: "replaced" });
    expect(f.fetcher.mock.calls.length).toBe(count);
  });
});
