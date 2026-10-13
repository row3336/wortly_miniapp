// M-SLOT-INVALID, Learning: the shared slot holds a record nobody can read when a new answer Y is submitted. Y is neither stored nor
// sent, so the recovery machine does not wait for it: Y is never checked by its ID, never retried, and the record stays as it is.
// Real view, document lanes and transport over the synthetic Learning server, on fake time.
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { id, primaryKey } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import type { LearningViewController } from "./learningViewController";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function harness() {
  vi.useFakeTimers();
  const f = learningViewFixture("normal", id(3)); owners.push(f.view);
  const requests = (mark: number) => {
    const calls = f.fetcher.mock.calls.slice(mark).map(([url, init]) => ({ method: init?.method ?? "GET", path: new URL(String(url), "http://localhost").pathname }));
    return { statuses: calls.filter(call => call.method === "GET" && call.path.startsWith("/api/v1/commands/")).map(call => call.path.split("/").pop()),
      posts: f.posts().length };
  };
  return { ...f, requests, run: async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await tick(step); } };
}

describe("Learning: an unreadable record in the slot meets a new answer", () => {
  it.each([["not JSON", "{not json"], ["JSON of another shape", "{\"a\":1}"]])("%s: no check of Y, no send, no recovery view, record kept", async (_name, raw) => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    h.values.set(primaryKey, raw);
    const mark = h.fetcher.mock.calls.length;
    await h.view.submit(); await tick();
    const y = h.newId.mock.results.at(-1)!.value as string;
    await h.run(10 * 60_000, 15_000);
    expect(h.requests(mark).statuses).toEqual([]);
    expect(h.posts()).toEqual([]);
    expect(h.values.get(primaryKey)).toBe(raw);
    expect(h.view.snapshot().commands.recovery).toBeNull();
    expect(h.view.snapshot().commands.primary).toMatchObject({ pending: false, problem: "invalid_pending" });
    expect(h.fetcher.mock.calls.slice(mark).some(([url, init]) => String(url).includes(y) || String(init?.body ?? "").includes(y))).toBe(false);
  });

  it("the lane is free again after a check; once the record is gone the next answer goes out once under a new ID", async () => {
    const h = harness(); await h.view.refresh(); h.view.setDraft("Haus");
    h.values.set(primaryKey, "{not json");
    await h.view.submit(); await tick(); await h.run(30_000);
    const y = h.newId.mock.results.at(-1)!.value as string;
    h.values.delete(primaryKey);
    await h.view.refresh(); await tick();
    h.view.setDraft("Haus");
    await h.view.submit(); await tick(); await h.run(10_000);
    const answers = h.posts().filter(post => post.kind === "answer.submit");
    expect(answers).toHaveLength(1);
    expect(answers[0].command_id).not.toBe(y);
  });
});
