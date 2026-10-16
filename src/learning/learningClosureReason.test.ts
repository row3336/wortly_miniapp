// The close reason of a Learning session in the view snapshot (M-TEXT-DEFECTS-1, D-TEXT-DEFECTS §1): the core sends it
// (close_reason, closed_session boundary) and the base class hands it to close(); Learning used to drop it.
import { afterEach, describe, expect, it } from "vitest";
import type { LearningSessionProjection } from "../api/generated";
import { current, fact, id, missing, original, pending, primaryKey, response, stopKey } from "./learningFixtures.test-support";
import { learningViewFixture } from "./learningView.test-support";
import type { LearningViewController } from "./learningViewController";
import { pendingRaw, seedRaw } from "../commands/pendingSeed.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); });
const harness = () => { const f = learningViewFixture(); owners.push(f.view); return f; };
const closedStep = (reason: LearningSessionProjection["close_reason"]): LearningSessionProjection =>
  ({ ...current(), status: "closed", close_reason: reason, assignment: null, preview: null });
type Harness = ReturnType<typeof harness>;
/** The base class calls close() on every closed observation; some of them (a second reason, another session) the wire cannot stage. */
const closeDirectly = (f: Harness, sessionId: string, reason: string | null) =>
  (f.view as unknown as { close(sessionId: string, reason: string | null): void }).close(sessionId, reason);

/** A saved answer whose reply is gone and whose status the core answers as not found, with the closure of its session. */
function boundary(f: Harness, reason: string, sessionId = id(3)) {
  const intent = original();
  seedRaw(f.values, primaryKey, JSON.stringify(pending({ ...intent, session_id: sessionId })), id(50));
  f.fetcher.mockImplementation(async (url, init) => init?.method === "GET" && String(url).includes(`/commands/${intent.command_id}`)
    ? response({ ...missing(intent, "5"), closed_session: { session_id: sessionId, status: "closed", close_reason: reason } })
    : f.handler(url, init));
}

describe("the close reason of a Learning session (D-TEXT-DEFECTS §1)", () => {
  it.each(["midnight", "pair_changed", "timezone_date_changed", "remote_stop", "stop", "summary_home"] as const)(
    "T1.1 a closed projection read gives the reason %s", async reason => {
      const f = harness();
      await f.view.refresh();
      expect(f.view.snapshot().closed).toBeNull();
      f.setStep(closedStep(reason));
      await f.view.refresh();
      expect(f.view.snapshot()).toMatchObject({ phase: "closed", closed: { sessionId: id(3), reason } });
    });

  it("T1.2 a closure known only by a boundary of a saved answer gives its reason, with no projection", async () => {
    const f = harness(); boundary(f, "midnight");
    await f.view.refresh(); await f.view.refresh();
    const s = f.view.snapshot();
    expect(s.commands.primary.closedSession?.close_reason).toBe("midnight");
    expect({ phase: s.phase, current: s.current, closed: s.closed }).toEqual({ phase: "closed", current: null, closed: { sessionId: id(3), reason: "midnight" } });
  });

  it.each(["stop", "summary_home"] as const)("T1.3 an own accepted Stop gives its reason %s even if the reply names no closed projection", async reason => {
    const f = harness();
    await f.view.refresh();
    // The reply of the Stop shows the session still open: only the view's own reason can name the closure.
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method !== "POST") return f.handler(url, init);
      const command = JSON.parse(String(init.body));
      return response({ current: current(), state_version: "9", command: fact(command) });
    });
    await f.view.stop(reason);
    expect(f.view.snapshot()).toMatchObject({ phase: "closed", closed: { sessionId: id(3), reason } });
  });

  it("T1.3 an own accepted Stop whose reply is the closed projection gives the reason of that projection", async () => {
    const f = harness();
    await f.view.refresh(); await f.view.stop("summary_home");
    expect(f.view.snapshot().closed).toEqual({ sessionId: id(3), reason: "summary_home" });
  });

  it("T1.4 a Stop whose reply is lost and which finds the session closed elsewhere gives that reason", async () => {
    const f = harness();
    await f.view.refresh();
    f.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new TypeError("network");
      if (String(url).includes("/commands/")) {
        const stop = JSON.parse(pendingRaw(f.values, stopKey)!).intent;
        return response({ ...missing(stop, "5"), closed_session: { session_id: id(3), status: "closed", close_reason: "remote_stop" } });
      }
      return f.handler(url, init);
    });
    await f.view.stop(); await f.view.refresh();
    expect(f.view.snapshot()).toMatchObject({ phase: "closed", closed: { sessionId: id(3), reason: "remote_stop" } });
  });

  it("T1.5 the first known reason wins over a later observation", async () => {
    const f = harness(); boundary(f, "midnight");
    await f.view.refresh(); await f.view.refresh();
    expect(f.view.snapshot().closed?.reason).toBe("midnight");
    f.setStep(closedStep("remote_stop"));
    await f.view.refresh(); await f.view.refresh();
    expect(f.view.snapshot()).toMatchObject({ phase: "closed", closed: { reason: "midnight" } });
  });

  it("T1.5 a reason first unknown is filled by a later one, and then stays", async () => {
    const f = harness();
    await f.view.refresh();
    closeDirectly(f, id(3), null);
    expect(f.view.snapshot().closed).toEqual({ sessionId: id(3), reason: null });
    closeDirectly(f, id(3), "midnight");
    closeDirectly(f, id(3), "remote_stop");
    expect(f.view.snapshot().closed).toEqual({ sessionId: id(3), reason: "midnight" });
  });

  it("T1.6 a new start drops the reason of the previous session", async () => {
    const f = harness();
    await f.view.refresh(); await f.view.stop();
    expect(f.view.snapshot().closed?.reason).toBe("stop");
    await f.view.start();
    const s = f.view.snapshot();
    expect(s.sessionId).not.toBe(id(3));
    expect(s.closed).toBeNull();
  });

  it("T1.7 the closure of another session is not this view's closure", async () => {
    const f = harness(); boundary(f, "midnight", id(9));
    await f.view.refresh(); await f.view.refresh();
    const s = f.view.snapshot();
    expect(s.phase).not.toBe("closed");
    expect(s.closed).toBeNull();
  });

  it("T1.7 the facts of another session are never shown as this view's", async () => {
    const f = harness();
    await f.view.refresh();
    closeDirectly(f, id(9), "midnight");
    expect(f.view.snapshot().closed).toBeNull();
  });

  it("T1.8 a value outside the contract is no reason", async () => {
    const f = harness();
    await f.view.refresh();
    // The wire decoder refuses an unknown reason before the view; this holds the view's own guard.
    closeDirectly(f, id(3), "bogus");
    expect(f.view.snapshot().closed).toEqual({ sessionId: id(3), reason: null });
  });

  it("no closure facts are shown while the session is open", async () => {
    const f = harness();
    await f.view.refresh();
    expect(f.view.snapshot().closed).toBeNull();
  });
});
