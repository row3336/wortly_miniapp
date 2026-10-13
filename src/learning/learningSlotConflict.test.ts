import { afterEach, describe, expect, it, vi } from "vitest";
import { pageSendCounter } from "../commands/laneRecovery";
import { tick } from "../commands/recoveryTime.test-support";
import { id, primaryKey, stopKey, prefetched, action, stop, original, pending, missing, response, fixture } from "./learningFixtures.test-support";

afterEach(() => { vi.useRealTimers(); });

/** X: the record of another window's action in the shared slot, which this window never sent. */
const other = (n = 777, intent = action()) => JSON.stringify(pending(original(intent, n)));

// M-SLOT-CONFLICT-LC: a new action Y of this window that meets X in the shared slot is neither stored nor sent, so it is
// no unknown outcome (C116): no check, no retry, no counter of Y; X, its record and its count stay exactly as they were.
describe("Learning: a new action meets another window's record in the shared slot", () => {
  it("an automatic answer is dropped: no request, no lost connection, X and its count untouched, no late write of Y", async () => {
    vi.useFakeTimers();
    const f = fixture(); await f.owner.refresh(); await tick();
    const counter = pageSendCounter(f.storage);
    await counter.save(id(777), { reserved: 2, transmitted: 1 });
    const x = other(); f.values.set(primaryKey, x);
    await f.owner.begin(action()); await tick();
    expect(f.newId).toHaveBeenCalledOnce();
    expect(f.owner.snapshot()).toMatchObject({ recovery: null, automaticPrimary: false,
      primary: { pending: false, phase: "blocked", problem: "pending_changed", outcome: null, canRetry: false, pendingIntent: null } });
    // Late handlers of Y: the machine is gone, its timers never fire, and no release writes a zero count of Y back.
    for (let second = 0; second < 120; second += 5) await tick(5000);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.values.get(primaryKey)).toBe(x);
    expect(await counter.load(id(777))).toEqual({ reserved: 2, transmitted: 1 });
    expect(await counter.load(id(100))).toBeNull();
    f.owner.dispose();
  });
  it("after the conflict is resolved a new action Z gets its own ID and is sent once; Y is never sent or checked", async () => {
    const f = fixture(); await f.owner.refresh();
    f.values.set(primaryKey, other());
    await f.owner.begin(action());
    expect(f.fetcher).not.toHaveBeenCalled();
    // The block holds until a refresh, which has nothing to ask for: Y left no record.
    expect(f.owner.snapshot().canBegin).toBe(false);
    f.values.delete(primaryKey); await f.owner.refresh();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.owner.snapshot().canBegin).toBe(true);
    await f.owner.begin(action());
    const posts = f.fetcher.mock.calls.map(call => JSON.parse(String(call[1]?.body)));
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST"]);
    expect(posts[0].command_id).toBe(id(101));
    expect(f.fetcher.mock.calls.some(([url]) => String(url).includes(id(100)))).toBe(false);
    expect(f.owner.snapshot().primary).toMatchObject({ outcome: "accepted", pending: false });
  });
  it("a manual start and a new Stop are dropped the same way: no request, X stays", async () => {
    const f = fixture(); await f.owner.refresh();
    const x = other(), xs = JSON.stringify(pending(original(stop, 778)));
    f.values.set(primaryKey, x); f.values.set(stopKey, xs);
    await f.owner.begin({ kind: "session.start", session_id: id(20), payload: { mode: "learning" } });
    await f.owner.begin(stop);
    expect(f.owner.snapshot()).toMatchObject({ primary: { pending: false, phase: "blocked", problem: "pending_changed" },
      stop: { pending: false, phase: "blocked", problem: "pending_changed" } });
    await f.owner.refresh();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.values.get(primaryKey)).toBe(x); expect(f.values.get(stopKey)).toBe(xs);
  });
  it("a retained intent whose slot changed keeps its record and stays unknown (retry is not a new intent)", async () => {
    const command = original(stop), f = fixture({ stop: command });
    f.fetcher.mockResolvedValueOnce(response(missing(command))).mockResolvedValueOnce(response({ current: prefetched(), state_version: "3" }));
    await f.owner.refresh(); expect(f.owner.snapshot().stop.canRetry).toBe(true);
    const xs = JSON.stringify(pending(original(stop, 778))); f.values.set(stopKey, xs);
    f.fetcher.mockClear();
    await f.owner.retry("stop");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.owner.snapshot().stop).toMatchObject({ pending: true, problem: "pending_changed", outcome: null });
    expect(f.owner.snapshot().stop.pendingIntent?.command_id).toBe(command.command_id);
    expect(f.values.get(stopKey)).toBe(xs);
  });
});
