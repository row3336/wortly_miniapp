// The «request started» signal end to end for the written document (H1 of QA-RESTORE-TIMER r2): the real transport tells the
// lane right before fetch (Request.started -> sendStarted), through the real writtenDocumentCommands wiring. A restored
// outcome (LaneResolved.restored) must end exactly when a request of the inherited intent has left, never earlier.
// The three send() adapters forward `started` to the transport and call it only after every local check passed.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnswerSubmitCommand } from "../api/generated";
import { createLearningResultApi } from "../learning/learningAnswerApi";
import { createLearningSessionApi } from "../learning/learningSessionApi";
import { WrittenDocumentCommands } from "./writtenDocumentCommands";
import { createWrittenApi } from "./writtenApi";
import type { WrittenCommand } from "./writtenIntent";
import { id, writtenFixture } from "./writtenFixtures.test-support";

const owners: { dispose(): void }[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); });
type Fixture = ReturnType<typeof writtenFixture>;
type Call = Fixture["fetcher"]["mock"]["calls"][number];

const start = { kind: "session.start" as const, session_id: id(3), payload: { mode: "written" as const, bucket: "words" as const } };
function documentOf(f: Fixture) {
  const owner = new WrittenDocumentCommands({ access: f.access, transport: f.transport, storage: f.storage, newId: f.newId, onUpdate: vi.fn() });
  owners.push(owner);
  return owner;
}
/** The first owner sends the start, but the request never reaches the server. Returns the dropped call and the command ID. */
async function droppedStart(f: Fixture): Promise<{ call: Call; commandId: string }> {
  const first = documentOf(f);
  await first.refresh();
  f.dropRequest();
  await first.begin(start);
  const call = f.fetcher.mock.calls.filter(item => item[1]?.method === "POST").at(-1)!;
  const commandId = JSON.parse(String(call[1]!.body)).command_id as string;
  first.dispose();
  return { call, commandId };
}
/** A new owner of the same slot checks the old start by its ID: absent, so the manual retry is granted. */
async function inheritingOwner(f: Fixture, commandId: string) {
  const owner = documentOf(f);
  await owner.refresh();
  expect(owner.snapshot().primary).toMatchObject({ pending: true, kind: "session.start", canRetry: true });
  expect(owner.snapshot().primary.pendingIntent?.command_id).toBe(commandId);
  return owner;
}
/** The next POST never reaches the server; the status reads that precede a retry pass untouched. */
function dropNextPost(f: Fixture) {
  const base = f.fetcher.getMockImplementation()!;
  let dropped = false;
  f.fetcher.mockImplementation(async (url, init) => {
    if (!dropped && init?.method === "POST") { dropped = true; throw new TypeError("network"); }
    return base(url, init);
  });
}
const deliver = (f: Fixture, call: Call) => f.server.handle(call[0] as RequestInfo, call[1]);

describe("written document wiring: Request.started -> sendStarted", () => {
  it("a retry whose request was built and handed to fetch ends the inherited state: the later applied check is live", async () => {
    const f = writtenFixture({ cards: [6, 7] }); const { call, commandId } = await droppedStart(f);
    const owner = await inheritingOwner(f, commandId);
    const before = f.posts().length;
    dropNextPost(f);
    await owner.retry("primary");
    expect(f.posts().length).toBe(before + 1);
    // The first request, still on its way, reaches the server now; the owner finds the command applied by its ID.
    await deliver(f, call);
    await owner.refresh();
    expect(owner.snapshot().primary.resolved).toMatchObject({ commandId, kind: "session.start" });
    expect(owner.snapshot().primary.resolved?.restored).toBeUndefined();
  });

  it("control: without any request of this owner the same applied check is restored", async () => {
    const f = writtenFixture({ cards: [6, 7] }); const { call, commandId } = await droppedStart(f);
    const owner = await inheritingOwner(f, commandId);
    await deliver(f, call);
    await owner.refresh();
    expect(owner.snapshot().primary.resolved).toMatchObject({ commandId, kind: "session.start", restored: true });
  });

  it("a retry stopped before any HTTP (the slot cannot be saved) leaves the inherited state: the later applied check is restored", async () => {
    const f = writtenFixture({ cards: [6, 7] }); const { call, commandId } = await droppedStart(f);
    const owner = await inheritingOwner(f, commandId);
    const posts = f.posts().length, get = f.storage.get;
    f.storage.get = vi.fn(async () => { throw new Error("storage unavailable"); });
    await owner.retry("primary");
    expect(f.posts().length).toBe(posts);
    f.storage.get = get;
    await deliver(f, call);
    await owner.refresh();
    expect(owner.snapshot().primary.resolved).toMatchObject({ commandId, kind: "session.start", restored: true });
  });
});

describe("the three send() adapters forward started to the transport", () => {
  const origin = { client_instance_id: id(1), document_id: id(2) };
  /** A fetch that records its order against the started callback and answers an unreadable refusal. */
  function probe() {
    const order: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => { order.push("fetch"); return new Response("{}", { status: 500 }); });
    return { order, fetcher, started: () => { order.push("started"); }, http: { fetcher, timeoutMs: 1000, maxResponseBytes: 10000 } };
  }
  const writtenCommand = { command_id: id(10), session_id: id(3), kind: "session.start", payload: { mode: "written", bucket: "words" }, ...origin } as WrittenCommand;
  const answer: AnswerSubmitCommand = { command_id: id(11), session_id: id(3), assignment_id: id(6), kind: "answer.submit",
    payload: { text: "Haus" }, ...origin };
  const learningStart = { command_id: id(12), session_id: id(3), kind: "session.start" as const, payload: { mode: "learning" as const }, ...origin };

  it.each([
    ["writtenApi.send", (p: ReturnType<typeof probe>) => createWrittenApi(p.http).send("token", "proof", writtenCommand, p.started)],
    ["learningAnswerApi.send", (p: ReturnType<typeof probe>) => createLearningResultApi(p.http).send("token", "proof", answer, p.started)],
    ["learningSessionApi.send", (p: ReturnType<typeof probe>) => createLearningSessionApi(p.http).send("token", "proof", learningStart, p.started)],
  ])("%s: started is told once, right before the one fetch", async (_name, send) => {
    const p = probe();
    await expect(send(p)).rejects.toBeTruthy();
    expect(p.order).toEqual(["started", "fetch"]);
  });

  it.each([
    ["writtenApi.send", (p: ReturnType<typeof probe>) => createWrittenApi(p.http).send("", "", writtenCommand, p.started)],
    ["learningAnswerApi.send", (p: ReturnType<typeof probe>) => createLearningResultApi(p.http).send("", "", answer, p.started)],
    ["learningSessionApi.send", (p: ReturnType<typeof probe>) => createLearningSessionApi(p.http).send("", "", learningStart, p.started)],
  ])("%s: a command refused by the local checks tells nothing and sends nothing", async (_name, send) => {
    const p = probe();
    await expect(send(p)).rejects.toBeTruthy();
    expect(p.order).toEqual([]);
    expect(p.fetcher).not.toHaveBeenCalled();
  });
});
