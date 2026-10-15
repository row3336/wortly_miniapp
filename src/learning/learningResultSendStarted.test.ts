// The real wiring of the timer layer (20.1-А, 22.1-А) for Learning results: the transport tells Request.started right
// before fetch, and LearningDocumentCommands passes that moment on as the controller's sendStarted (QA-FINAL Q2, C245).
// An answer an earlier owner of this page left in the slot is inherited; once this owner's own request of it reached
// fetch, the outcome found later by its ID is a live one (no `restored`). A send stopped before its request
// (a failed save) tells nothing, so the outcome stays an old one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { OpenedClient } from "../api/generated";
import type { AsyncStorage } from "../platform/storage";
import { LearningCommandController, type LearningTransition } from "./learningCommandController";
import type { LearningCommandIntent } from "./learningCommandIntent";
import { LearningDocumentCommands } from "./learningDocumentCommands";
import { accepted, current, id, missing, pending, primaryKey, profile, response } from "./learningFixtures.test-support";
import { hashInPlace } from "../commands/recoveryTime.test-support";
import { testGate } from "../commands/testGate.test-support";

const answer: LearningTransition = { kind: "answer.submit", session_id: id(3), assignment_id: id(6), payload: { text: "Haus" } };
const owners: LearningDocumentCommands[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); vi.restoreAllMocks(); });

/** One page: one storage wrapper shared by its owners, open handles replaced as on a re-entry after 403. */
function page() {
  vi.useFakeTimers(); hashInPlace();
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  let access: OpenedAccess, token = "synthetic-token";
  const replace = (nextToken = "synthetic-token") => {
    token = nextToken;
    const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
      profile: profile(), session: { id: id(3), phase: "active" }, compatibility: { compatible: true, contract_version: "1" } };
    const handle: OpenedAccess = createOpenedAccess({ opened, token, proof: "synthetic-proof", generation: 1,
      isLive: () => access === handle, onDenied: () => {} });
    access = handle;
  };
  replace();
  // The synthetic core: an answer it committed is found by its ID (already_applied); `lose` drops or loses replies.
  const committed = new Map<string, LearningCommandIntent>(), events: string[] = [];
  const lose = { before: 0, after: 0 };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (init?.method === "POST") {
      events.push("fetch POST");
      const { client_instance_id: _c, document_id: _d, ...intent } = JSON.parse(String(init.body)) as LearningCommandIntent & Record<string, string>;
      if (lose.before > 0) { lose.before--; throw new TypeError("network"); }
      const prior = committed.has(intent.command_id);
      committed.set(intent.command_id, intent);
      if (lose.after > 0) { lose.after--; throw new TypeError("network"); }
      return response(accepted(intent, "4", current(), prior ? "already_applied" : "applied"));
    }
    if (path.startsWith("/api/v1/commands/")) {
      const command = committed.get(path.split("/").at(-1)!);
      return response(command ? accepted(command, "4", current(), "already_applied")
        : missing({ ...answer, command_id: path.split("/").at(-1)! } as LearningCommandIntent));
    }
    if (path.startsWith("/api/v1/sessions/")) return response({ current: current(), state_version: "3" });
    throw new Error(`unexpected ${init?.method ?? "GET"} ${path}`);
  });
  let next = 100;
  const make = () => {
    const owner = new LearningDocumentCommands({ access: () => access, storage, newId: () => id(next++), onUpdate: () => {},
      transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() } });
    owners.push(owner); return owner;
  };
  const original = LearningCommandController.prototype.sendStarted;
  const started = vi.spyOn(LearningCommandController.prototype, "sendStarted").mockImplementation(function (this: LearningCommandController) {
    events.push("sendStarted"); original.call(this);
  });
  const posts = () => fetcher.mock.calls.filter(([, init]) => init?.method === "POST").length;
  return { values, storage, replace, make, lose, events, started, posts, committed };
}

/** The first owner of the page sends the answer, which never reaches the core; then a new handle and a new owner. */
async function inherit(p: ReturnType<typeof page>) {
  const first = p.make(); await first.refresh();
  p.lose.before = 1;
  first.setRecoveryActive(true);
  await first.begin(answer).catch(() => {}); await tick();
  expect(p.posts()).toBe(1);
  first.dispose(); p.events.length = 0; p.started.mockClear();
  p.replace();
  const second = p.make();
  return second;
}

describe("Learning results: Request.started → sendStarted (timer layer, QA-FINAL Q2)", () => {
  it("control: an answer left by an earlier owner and already held by the core is found by the first check: old (restored), nothing sent", async () => {
    const p = page(), intent = { ...answer, command_id: id(90) } as LearningCommandIntent;
    p.values.set(primaryKey, JSON.stringify(pending(intent))); p.committed.set(intent.command_id, intent);
    const owner = p.make(); owner.setRecoveryActive(true); await owner.refresh(); await tick();
    expect(p.posts()).toBe(0);
    expect(p.started).not.toHaveBeenCalled();
    expect(owner.snapshot().primary).toMatchObject({ outcome: "accepted", resolved: { kind: "answer.submit", restored: true } });
  });

  it("the resend of an inherited answer tells sendStarted right before its fetch; found after a lost reply it is a live outcome", async () => {
    const p = page(), owner = await inherit(p);
    p.lose.after = 1;
    owner.setRecoveryActive(true); await owner.refresh(); await tick(); await tick(30_000);
    expect(p.posts()).toBe(2);
    expect(p.events.slice(0, 2)).toEqual(["sendStarted", "fetch POST"]);
    expect(p.started).toHaveBeenCalledOnce();
    expect(owner.snapshot().primary.outcome).toBe("accepted");
    expect(owner.snapshot().primary.resolved?.restored).toBeUndefined();
  });

  it("a resend stopped before its request (the device storage fails its save) tells nothing and sends nothing", async () => {
    const p = page(), owner = await inherit(p);
    owner.setRecoveryActive(true); await owner.refresh();
    expect(owner.snapshot().primary).toMatchObject({ pending: true, outcome: null });
    // As the controller test of the same boundary: the device storage fails, so the retained record cannot be saved.
    p.storage.get = vi.fn(async () => { throw new Error("storage unavailable"); });
    p.storage.set = vi.fn(async () => { throw new Error("quota"); });
    const resend = vi.spyOn(LearningCommandController.prototype, "resend");
    await tick(); await tick(30_000);
    // The machine did try: the send ended at the local save, before any request was built.
    expect(resend).toHaveBeenCalled();
    expect(p.started).not.toHaveBeenCalled();
    expect(p.posts()).toBe(1);
  });
});
