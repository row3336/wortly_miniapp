// 35.1-А × decision 2.3 А (C243): the Learning document and its start lane see one page, the LearningPageStarts they
// are given. A new storage wrapper of the same page (an App remount) keeps the start's explicit retry; a new page, or a
// record this page never made, does not. pageOrigin keeps deciding every other kind.
import { describe, expect, it, vi } from "vitest";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { OpenedClient } from "../api/generated";
import { hashInPlace } from "../commands/recoveryTime.test-support";
import type { AsyncStorage } from "../platform/storage";
import type { LearningTransition } from "./learningCommandController";
import { LearningDocumentCommands } from "./learningDocumentCommands";
import { id, pending, primaryKey, profile, response } from "./learningFixtures.test-support";
import { LearningPageStarts } from "./learningPageStarts";
import { testGate } from "../commands/testGate.test-support";
import { hasPending, seedRaw } from "../commands/pendingSeed.test-support";

const begin: LearningTransition = { kind: "session.start", session_id: id(3), payload: { mode: "learning" } };

/** One device: its values outlive every storage wrapper, as localStorage outlives an App remount. */
function device() {
  hashInPlace();
  const values = new Map<string, string>();
  const wrapper = (): AsyncStorage => ({ get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) });
  const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } };
  const access: OpenedAccess = createOpenedAccess({ opened, token: "synthetic-token", proof: "synthetic-proof", generation: 1,
    isLive: () => true, onDenied: () => {} });
  // The core never saw the start: its status is not_found and its session does not exist.
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (init?.method === "POST") throw new TypeError("synthetic network loss");
    if (path.includes("/commands/")) return response({ state_version: "1", current: profile(), command: { id: path.split("/").at(-1), status: "not_found" } });
    return response({ current: { session_id: id(3), status: "not_found" }, state_version: "1" });
  });
  let next = 40;
  const owner = (storage: AsyncStorage, page: LearningPageStarts) => new LearningDocumentCommands({ access: () => access, storage,
    transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() }, newId: () => id(next++), onUpdate: () => {}, page });
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init!.body)).command_id as string);
  return { values, wrapper, owner, posts };
}

/** The start of this page loses its request; its record stays on the device. */
async function lostStart(d: ReturnType<typeof device>, page: LearningPageStarts) {
  const first = d.owner(d.wrapper(), page); await first.refresh();
  await first.begin(begin).catch(() => {});
  expect(d.posts()).toHaveLength(1); expect(hasPending(d.values, primaryKey)).toBe(true);
  first.dispose();
  return d.posts()[0];
}

describe("35.1-А × 2.3 А: one page for the Learning start", () => {
  it("a new storage wrapper of the same page (an App remount) keeps the explicit retry of its start: one more POST, same ID", async () => {
    const d = device(), page = new LearningPageStarts(), sent = await lostStart(d, page);
    const next = d.owner(d.wrapper(), page); await next.refresh();
    expect(next.snapshot().primary).toMatchObject({ kind: "session.start", problem: "not_found", canRetry: true });
    await next.retry("primary");
    expect(d.posts()).toEqual([sent, sent]);
    next.dispose();
  });

  it("a new page (a reload) under a new wrapper is only checked: no retry, no POST", async () => {
    const d = device(), sent = await lostStart(d, new LearningPageStarts());
    const next = d.owner(d.wrapper(), new LearningPageStarts()); await next.refresh();
    expect(next.snapshot().primary).toMatchObject({ kind: "session.start", problem: "not_found", canRetry: false });
    await next.retry("primary");
    expect(d.posts()).toEqual([sent]);
    next.dispose();
  });

  it("a start record this page never made (another window) is not its own, whatever wrapper reads it", async () => {
    const d = device(), page = new LearningPageStarts();
    seedRaw(d.values, primaryKey, JSON.stringify(pending({ ...begin, command_id: id(90) })), id(50));
    const owner = d.owner(d.wrapper(), page); await owner.refresh();
    expect(owner.snapshot().primary).toMatchObject({ kind: "session.start", problem: "not_found", canRetry: false });
    await owner.retry("primary");
    expect(d.posts()).toEqual([]);
    owner.dispose();
  });
});
