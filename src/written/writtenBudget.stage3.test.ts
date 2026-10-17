// CP5b stage 3 through the real written view, document lanes and HTTP transport over the synthetic server, fake time:
// C565 (the physical mark of a send after L2), Q34 (no send at all without the page's store), the start of a session
// counted with the release of damaged records (D-CP5A-DAMAGE-EXIT 3.2), Е02 forgetHash on open, the V-1 cleanup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestSendBudget, pageStore, storedMarks, TestSendBudget } from "../commands/budget.test-support";
import { sendBudgetProvider } from "../commands/intentBudget";
import { releaseKey, SendBudgetError } from "../commands/sendBudget";
import { WrittenViewController } from "./writtenViewController";
import { id, tick, writtenFixture } from "./writtenFixtures.test-support";

const owners: WrittenViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });

function harness() {
  vi.useFakeTimers();
  const f = writtenFixture();
  const view = new WrittenViewController({ access: f.access, storage: f.storage, transport: f.transport, newId: f.newId,
    sessionId: null, transitionMode: () => "normal", onUpdate: vi.fn() });
  owners.push(view);
  /** Every POST that reached fetch, by kind. */
  const fetched: string[] = [];
  const serve = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "POST") fetched.push(JSON.parse(String(init.body)).kind as string);
    return serve(url, init);
  });
  const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); };
  const started = async (text = "Haus") => { await view.refresh(); await view.start("words"); view.setDraft(text); };
  return { ...f, view, fetched, run, started };
}

describe("C565: a send counts as gone only after L2, right before fetch", () => {
  it("L1 lets it through, the transport's L2 refuses: no fetch, the slot is not transmitted or retryable, no false exhaustion", async () => {
    const h = harness(); await h.started();
    let refused = 0;
    const real = h.transport.gate!.admit.bind(h.transport.gate!);
    vi.spyOn(h.transport.gate!, "admit").mockImplementation(request => {
      const body = request.body as { kind?: string } | undefined;
      if (request.method === "POST" && body?.kind === "answer.submit") { refused++; return "paused"; }
      return real(request);
    });
    const mayWrite = vi.spyOn(h.transport.gate!, "mayWrite");
    await h.view.submit(); await tick();
    expect(refused).toBe(1);
    expect(mayWrite).toHaveBeenCalled();
    expect(h.fetched).not.toContain("answer.submit");
    const store = await pageStore(h.storage), x = h.view.snapshot().commands.recovery!.commandId;
    // The slot went to "sending" before L2 (its commit stands first), and nothing else: never transmitted, never retryable.
    expect(store.peek(x.toLowerCase())).toMatchObject({ slots: [{ state: "sending" }, { state: "empty" }, { state: "empty" },
      { state: "empty" }, { state: "empty" }, { state: "empty" }] });
    expect(await storedMarks(store, x)).toEqual({ reserved: 1, transmitted: 0 });
    await h.run(10 * 60_000, 5000);
    expect(h.fetched).not.toContain("answer.submit");
    expect(h.view.snapshot().commands.recovery?.state.name).not.toBe("exhausted");
    expect(await storedMarks(store, x)).toEqual({ reserved: 1, transmitted: 0 });
  });

  it("the ordinary path: the commit of sending stands before L2, one physical mark, one fetch", async () => {
    const h = harness(); await h.started();
    const store = await pageStore(h.storage), order: string[] = [];
    const real = h.transport.gate!.admit.bind(h.transport.gate!);
    vi.spyOn(h.transport.gate!, "admit").mockImplementation(request => {
      if (request.method === "POST" && (request.body as { kind?: string } | undefined)?.kind === "answer.submit") order.push("L2");
      return real(request);
    });
    const begin = store.beginSending.bind(store), mark = store.markTransmitted.bind(store);
    vi.spyOn(store, "beginSending").mockImplementation(async (identity, claim) => { order.push("sending"); return begin(identity, claim); });
    vi.spyOn(store, "markTransmitted").mockImplementation(async (identity, claim) => {
      order.push(`transmitted after ${h.fetched.filter(kind => kind === "answer.submit").length} fetch`); return mark(identity, claim);
    });
    await h.view.submit(); await tick();
    expect(h.fetched.filter(kind => kind === "answer.submit")).toEqual(["answer.submit"]);
    expect(order).toEqual(["sending", "L2", "transmitted after 1 fetch"]);
  });
});

describe("Q34: no send at all without the page's store (owner 12.10, var. 1; К19-029)", () => {
  it("the store does not open: «Начать» sends nothing (session.start included), the view stays idle, the stub is on", async () => {
    sendBudgetProvider.make = () => Promise.reject(new SendBudgetError("unavailable"));
    const h = harness(); await h.view.refresh(); await tick();
    expect(h.view.snapshot().commands).toMatchObject({ storageUnavailable: true, canBegin: false });
    await h.view.start("words"); await tick();
    await h.run(60_000, 5000);
    expect(h.fetched).toEqual([]);
    expect(h.view.snapshot()).toMatchObject({ phase: "idle", canStart: false });
  });

  it("a store that did not open is opened again by a refresh; then one start goes", async () => {
    let fail = true;
    const store = new TestSendBudget();
    sendBudgetProvider.make = () => fail ? Promise.reject(new SendBudgetError("unavailable")) : Promise.resolve(store);
    const h = harness(); await h.view.refresh(); await tick();
    expect(h.view.snapshot().commands.storageUnavailable).toBe(true);
    fail = false;
    await h.view.refresh(); await tick();
    expect(h.view.snapshot().commands.storageUnavailable).toBeUndefined();
    await h.view.start("words"); await tick();
    expect(h.fetched.filter(kind => kind === "session.start")).toHaveLength(1);
  });
});

describe("the start of a session in its budget (D-CP5A-DAMAGE-EXIT 3.2)", () => {
  const damaged = { schemaVersion: 1, commandId: id(900), profileId: id(50), slots: "broken" };
  it("«Начать» lists the damaged records and releases them for this new session: the start goes, its record and the release are written", async () => {
    const h = harness(); const store = await pageStore(h.storage);
    store.seed(id(900), damaged);
    await h.started();
    expect(h.fetched.filter(kind => kind === "session.start")).toHaveLength(1);
    const start = h.posts().find(post => post.kind === "session.start")!;
    // Accepted: the start's own record is gone (D-CP5 9.2); the release of this session names the damaged key.
    expect(store.peek(String(start.command_id))).toBeUndefined();
    expect(store.peek(releaseKey(id(50), String(start.session_id)))).toMatchObject({ keys: [id(900)] });
  });
  it("a damaged record the listing did not see blocks the start: no POST, the view is idle with the stub; a new press tries again", async () => {
    const h = harness(); const store = await pageStore(h.storage);
    store.seed(id(900), damaged);
    const list = vi.spyOn(store, "listDamagedKeys").mockResolvedValueOnce([]);
    await h.view.refresh(); await h.view.start("words"); await tick();
    expect(h.fetched).toEqual([]);
    expect(h.view.snapshot()).toMatchObject({ phase: "idle", commands: { startBlocked: "damage" } });
    list.mockRestore();
    await h.view.start("words"); await tick();
    expect(h.fetched.filter(kind => kind === "session.start")).toHaveLength(1);
    expect(h.view.snapshot().commands.startBlocked).toBeUndefined();
  });
});

describe("Е02 (D-CP5 10.6.2): another profile's records lose their fingerprint when this document opens", () => {
  it("the fingerprint of the other profile goes, nothing else of it changes; this profile's record keeps its own", async () => {
    installTestSendBudget();
    const h = harness(); const store = await pageStore(h.storage);
    const record = (commandId: string, profileId: string) => ({ schemaVersion: 1, commandId, profileId, clientInstanceId: id(2),
      pair: "ru-de", sessionId: id(3), kind: "answer.submit", intentHash: "a".repeat(64), family: "primary",
      target: { field: "assignment_id", id: id(6) }, slots: [{ state: "retryable", attempt: id(801) }, { state: "empty" },
        { state: "empty" }, { state: "empty" }, { state: "empty" }, { state: "empty" }], createdAt: 1 });
    store.seed(id(910), record(id(910), id(99))); store.seed(id(911), record(id(911), id(50)));
    await h.view.refresh(); await tick();
    const { intentHash: _gone, ...rest } = record(id(910), id(99));
    expect(store.peek(id(910))).toEqual(rest);
    expect(store.peek(id(911))).toEqual(record(id(911), id(50)));
  });
});

describe("the counted start and its manual retry (Q34, 21.1-А; mutants S03, S09)", () => {
  it("a start lost before the server is retried by hand only while the store opens: without it the retry sends nothing", async () => {
    const h = harness(); await h.view.refresh();
    h.dropRequest();
    await h.view.start("words"); await tick();
    expect(h.fetched.filter(kind => kind === "session.start")).toHaveLength(0);
    await h.view.refresh(); await tick();
    expect(h.view.snapshot().commands.primary).toMatchObject({ pending: true, kind: "session.start", canRetry: true });
    // The store of the page stops opening (another tab took it, the WebView refused it): the retry is no study send.
    sendBudgetProvider.make = () => Promise.reject(new SendBudgetError("unavailable"));
    await h.view.refresh(); await tick();
    expect(h.view.snapshot().commands.storageUnavailable).toBe(true);
    await h.view.retry("primary"); await tick(); await h.run(30_000, 5000);
    expect(h.fetched.filter(kind => kind === "session.start")).toHaveLength(0);
  });
  it("while a counted start writes its record no Stop may begin (canStop false at once); only the start goes", async () => {
    const { WrittenDocumentCommands } = await import("./writtenDocumentCommands");
    vi.useFakeTimers();
    const f = writtenFixture(), onUpdate = vi.fn();
    const commands = new WrittenDocumentCommands({ access: f.access, transport: f.transport, storage: f.storage, newId: f.newId, onUpdate });
    await commands.refresh(); await tick();
    const session = id(3);
    const starting = commands.begin({ kind: "session.start", session_id: session, payload: { mode: "written", bucket: "words" } } as never);
    expect(commands.snapshot().canStop).toBe(false);
    const stopping = commands.begin({ kind: "session.stop", session_id: session, payload: { reason: "stop" } } as never);
    await starting; await stopping; await tick(5000);
    expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
    commands.dispose();
  });
});

describe("C567: the real IndexedDB adapter of the page closes (versionchange) — QA probe as a permanent test", () => {
  it("the closed adapter is not handed out again: a refresh shows the store available, the next start goes on a new connection", async () => {
    const { FakeIndexedDb } = await import("../commands/idbFake.test-support");
    const { IdbSendBudget } = await import("../commands/sendBudgetIdb");
    const fake = new FakeIndexedDb(); let opens = 0;
    sendBudgetProvider.make = () => { opens++; return IdbSendBudget.open(fake.factory); };
    const h = harness(); await h.view.refresh(); await tick(); await tick();
    expect(opens).toBe(1);
    fake.requestVersionChange();
    await h.view.refresh(); await tick(); await tick();
    expect(h.view.snapshot().commands).toMatchObject({ canBegin: true });
    expect(h.view.snapshot().commands.storageUnavailable).toBeUndefined();
    await h.view.start("words"); await tick(); await tick(); await h.run(5000);
    expect(h.fetched.filter(kind => kind === "session.start")).toHaveLength(1);
    expect(h.view.snapshot().commands.startBlocked).toBeUndefined();
    expect(opens).toBe(2);
    expect(fake.connections.filter(db => !db.closed)).toHaveLength(1);
  }, 60_000);
  it("an answer begun after the connection closed is counted on the new connection and sent once", async () => {
    const { FakeIndexedDb } = await import("../commands/idbFake.test-support");
    const { IdbSendBudget } = await import("../commands/sendBudgetIdb");
    const fake = new FakeIndexedDb();
    sendBudgetProvider.make = () => IdbSendBudget.open(fake.factory);
    const h = harness(); await h.started(); await tick();
    fake.requestVersionChange();
    await h.view.submit(); await tick(); await h.run(20_000);
    expect(h.fetched.filter(kind => kind === "answer.submit")).toEqual(["answer.submit"]);
    expect(h.view.snapshot().commands.recovery?.state.name).toBe("settled");
  }, 60_000);
});

describe("P3 QA stage 3: the stub and a start blocked by the store", () => {
  it("a start blocked because the store did not open is unblocked by the reopen itself, without another press", async () => {
    let fail = false;
    const store = new TestSendBudget();
    sendBudgetProvider.make = () => fail ? Promise.reject(new SendBudgetError("unavailable")) : Promise.resolve(store);
    const h = harness(); await h.view.refresh(); await tick();
    // The store fails between the open check and the start's record: the start is blocked by the store, no POST.
    vi.spyOn(store, "createAndReserve").mockRejectedValueOnce(new SendBudgetError("failed"));
    await h.view.start("words"); await tick();
    expect(h.view.snapshot().commands.startBlocked).toBe("storage");
    expect(h.fetched).toEqual([]);
    await h.view.refresh(); await tick();
    expect(h.view.snapshot().commands.startBlocked).toBeUndefined();
    expect(h.fetched).toEqual([]);
  });
});
