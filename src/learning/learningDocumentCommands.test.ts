import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import type { LearningTransition } from "./learningCommandController";
import { id, primaryKey, stopKey, profile, current, prefetched, closed, action, present, stop, original, resultRead, accepted, missing,
  response, deferred, fixture } from "./learningFixtures.test-support";

afterEach(() => { vi.useRealTimers(); });

// The manual mechanics of the document (handles, floors, closures) are shown with assignment.present, which keeps its
// manual recovery (4.6-В1); study results recover automatically (M-RECOV-AUTO CP2b) and have their own cases below.
describe("Learning opened-document command owner", () => {
  it.each(["primary", "stop"] as const)("a new handle during %s persistence requires GET recovery and explicit retry", async lane => {
    const transition = lane === "stop" ? stop : present, command = original(transition);
    const key = lane === "stop" ? stopKey : primaryKey, f = fixture(); await f.owner.refresh();
    const gate = deferred<void>();
    vi.spyOn(f.storage, "set").mockImplementationOnce(async (key, value) => {
      f.values.set(key, value); await gate.promise;
    });
    const sending = f.owner.begin(transition);
    await vi.waitFor(() => expect(f.values.has(key)).toBe(true));
    f.replace({}, "fresh-token"); gate.resolve(); await sending;
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.owner.snapshot()[lane].pending).toBe(true);
    expect(JSON.parse(f.values.get(key)!).intent).toEqual(command);
    f.fetcher.mockResolvedValueOnce(response(missing(command))).mockResolvedValueOnce(response({ current: prefetched(), state_version: "3" }));
    await f.owner.refresh();
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "GET"]);
    expect(f.owner.snapshot()[lane].canRetry).toBe(true);
    await f.owner.retry(lane);
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["GET", "GET", "POST"]);
    expect(JSON.parse(String(f.fetcher.mock.calls[2][1]?.body)).command_id).toBe(command.command_id);
    expect(f.fetcher.mock.calls[2][1]?.headers).toMatchObject({ Authorization: "Bearer fresh-token" });
    expect(f.newId).toHaveBeenCalledOnce(); expect(f.values.has(key)).toBe(false);
  });
  it.each(["primary", "stop"] as const)("a new handle also revokes %s retry while it persists the same intent", async lane => {
    const command = original(lane === "stop" ? stop : present), key = lane === "stop" ? stopKey : primaryKey;
    const f = fixture({ [lane]: command });
    f.fetcher.mockResolvedValueOnce(response(missing(command))).mockResolvedValueOnce(response({ current: prefetched(), state_version: "3" }));
    await f.owner.refresh(); expect(f.owner.snapshot()[lane].canRetry).toBe(true);
    f.fetcher.mockClear();
    const gate = deferred<string | null>(), calls = vi.mocked(f.storage.get).mock.calls.length;
    vi.mocked(f.storage.get).mockReturnValueOnce(gate.promise);
    const retrying = f.owner.retry(lane);
    await vi.waitFor(() => expect(f.storage.get).toHaveBeenCalledTimes(calls + 1));
    f.replace({}, "fresh-token"); gate.resolve(f.values.get(key)!); await retrying;
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    expect(JSON.parse(f.values.get(key)!).intent).toEqual(command);
    expect(f.owner.snapshot()[lane]).toMatchObject({ pending: true, outcome: null, canRetry: false });
  });
  it("a confirmed external setting version rejects an older session read on the same access handle", async () => {
    let floor = "1"; const f = fixture({}, () => floor); await f.owner.refresh();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const reading = f.owner.readSession(id(3)); floor = "9";
    gate.resolve(response({ current: current(), state_version: "8" }));
    await expect(reading).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.owner.snapshot().stateVersion).toBe("9");
  });
  it("an external settings floor hides old answer capabilities without losing its accepted receipt", async () => {
    let floor = "1"; const f = fixture({}, () => floor); await f.owner.refresh();
    const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const sending = f.owner.begin(action()); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    floor = "9"; gate.resolve(response(accepted(original(), "8"))); await sending;
    expect(f.owner.snapshot()).toMatchObject({ stateVersion: "9", primary: { outcome: "accepted", pending: false, answer: null, current: null } });
    expect(f.values.has(primaryKey)).toBe(false); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it("an external floor also rejects stale result capabilities", async () => {
    const f = fixture({}, () => "9"); await f.owner.refresh();
    f.fetcher.mockResolvedValueOnce(response(resultRead("1", 4, "8")));
    await expect(f.owner.readResult({ session_id: id(3), assignment_id: id(6), result_id: id(7) }))
      .rejects.toMatchObject({ kind: "invalid_response" });
    f.fetcher.mockResolvedValueOnce(response(resultRead("1", 4, "9")));
    expect((await f.owner.readResult({ session_id: id(3), assignment_id: id(6), result_id: id(7) })).state_version).toBe("9");
  });
  it("external floor increases are monotonic and preserve full integer precision", async () => {
    let floor: string | null = "9007199254740995"; const f = fixture({}, () => floor);
    expect(f.owner.snapshot().stateVersion).toBe(floor);
    floor = "9007199254740996"; expect(f.owner.snapshot().stateVersion).toBe(floor);
    floor = "2"; expect(f.owner.snapshot().stateVersion).toBe("9007199254740996");
    floor = null; expect(f.owner.snapshot().stateVersion).toBe("9007199254740996");
    f.replace({ profile: profile("9007199254740997") }); expect(f.owner.snapshot().stateVersion).toBe("9007199254740997");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("a previously verified retry loses permission when a settings observation advances", async () => {
    let floor = "1"; const command = original(present), f = fixture({ primary: command }, () => floor);
    f.fetcher.mockResolvedValueOnce(response(missing(command, "3"))).mockResolvedValueOnce(response({ current: prefetched(), state_version: "3" }));
    await f.owner.refresh(); expect(f.owner.snapshot().primary.canRetry).toBe(true);
    floor = "4"; expect(f.owner.snapshot().primary.canRetry).toBe(false);
    await f.owner.retry("primary"); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.newId).not.toHaveBeenCalled();
    expect(f.values.has(primaryKey)).toBe(true);
  });
  it("an accepted Stop stays conclusive even below a later settings observation", async () => {
    const f = fixture({}, () => "20"); await f.owner.refresh(); await f.owner.begin(stop);
    expect(f.owner.snapshot()).toMatchObject({ stateVersion: "20", stop: { outcome: "accepted", pending: false, current: null } });
    await f.owner.begin(action()); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.values.has(stopKey)).toBe(false);
  });
  it("accepted result identity survives stale projection and a retry of local cleanup", async () => {
    const f = fixture({}, () => "9"); await f.owner.refresh();
    vi.mocked(f.storage.remove).mockRejectedValueOnce(new Error("storage busy")); await f.owner.begin(action());
    const resolved = { commandId: id(100), kind: "answer.submit", sessionId: id(3), assignmentId: id(6), resultId: id(7) };
    expect(f.owner.snapshot().primary).toMatchObject({ resolved, outcome: "accepted", pending: true, answer: null });
    const exposed = f.owner.snapshot().primary.resolved!; exposed.resultId = id(999);
    await f.owner.refresh(); expect(f.owner.snapshot().primary).toMatchObject({ resolved, outcome: "accepted", pending: false });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.values.has(primaryKey)).toBe(false);
  });
  it("loads both slots without opening a session or sending anything", async () => {
    const f = fixture(); expect(f.owner.snapshot().canBegin).toBe(false); await f.owner.refresh();
    expect(f.owner.snapshot()).toMatchObject({ live: true, canBegin: true, canStop: true });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    expect(f.storage.get).toHaveBeenCalledWith(primaryKey); expect(f.storage.get).toHaveBeenCalledWith(stopKey);
  });
  it.each(["session.start", "learning.preview_next", "learning.known", "assignment.present", "answer.submit", "result.correct", "result.grade", "session.stop"])(
    "routes %s through the real transport and saves before POST", async kind => {
      const f = fixture(); await f.owner.refresh();
      const transition: LearningTransition = kind === "session.start" ? { kind, session_id: id(3), payload: { mode: "learning" } }
        : kind === "assignment.present" ? { kind, session_id: id(3), assignment_id: id(6), payload: {} }
        : kind === "learning.known" || kind === "learning.preview_next" ? { kind, session_id: id(3), preview_id: id(9), payload: {} }
        : kind === "session.stop" ? stop : action(kind as "answer.submit" | "result.correct" | "result.grade");
      const normal = f.fetcher.getMockImplementation()!;
      f.fetcher.mockImplementationOnce(async (url, options) => {
        const key = kind === "session.stop" ? stopKey : primaryKey;
        expect(JSON.parse(f.values.get(key)!).intent).toEqual(original(transition));
        expect(f.values.get(key)).not.toMatch(/synthetic-token|synthetic-proof|document_id|documentId/);
        expect(JSON.parse(String(options?.body))).toEqual({ ...original(transition), client_instance_id: id(1), document_id: id(2) });
        expect(options?.headers).toMatchObject({ Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" });
        return normal(url, options);
      });
      await f.owner.begin(transition);
      expect(f.owner.snapshot()[kind === "session.stop" ? "stop" : "primary"].outcome).toBe("accepted");
      expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.newId).toHaveBeenCalledOnce(); expect(f.values.get("unrelated")).toBe("keep");
    });
  it("double clicks share one in-flight command while Stop keeps its own lane", async () => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    // The second tap starts nothing: one command_id, one POST.
    const work = f.owner.begin(action()), second = f.owner.begin(action("result.correct"));
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce()); await second;
    expect(f.owner.snapshot()).toMatchObject({ canBegin: false, canStop: true });
    await f.owner.begin(stop); expect(f.owner.snapshot().stop.outcome).toBe("accepted");
    gate.resolve(response(accepted(original(), "9"))); await work;
    expect(f.owner.snapshot()).toMatchObject({ stateVersion: "10", primary: { outcome: "accepted", pending: false, current: null, answer: null } });
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.newId).toHaveBeenCalledTimes(2);
    await f.owner.begin(action()); await f.owner.begin({ kind: "session.start", session_id: id(3), payload: { mode: "learning" } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["result.correct", "result.grade"] as const)("reload reconciles %s by exact GET; with an unknown count it is never sent (CT §6.1 п. 4)", async kind => {
    vi.useFakeTimers();
    const command = original(action(kind)), f = fixture({ primary: command });
    f.fetcher.mockImplementation(async url => String(url).includes("/commands/") ? response(missing(command))
      : response(resultRead("1", kind === "result.grade" ? 4 : 2)));
    await f.owner.refresh(); await tick();
    expect(f.fetcher.mock.calls.slice(0, 2).map(call => call[1]?.method)).toEqual(["GET", "GET"]);
    const query = new URL(String(f.fetcher.mock.calls[1][0]), "http://localhost").searchParams;
    expect(query.get("assignment_id")).toBe(id(6)); expect(query.get("result_id")).toBe(id(7));
    expect(query.has("command_id")).toBe(false); expect(f.newId).not.toHaveBeenCalled();
    // A reload starts without the count of the page that sent it: only checks, never a resend or a manual retry.
    expect(f.owner.snapshot()).toMatchObject({ automaticPrimary: true, primary: { pending: true, canRetry: false },
      recovery: { state: { name: "counter_unknown" }, sends: null } });
    await f.owner.retry("primary");
    for (let second = 0; second < 120; second += 5) await tick(5000);
    expect(f.fetcher.mock.calls.some(call => call[1]?.method === "POST")).toBe(false);
    expect(f.owner.snapshot().primary.pending).toBe(true); expect(f.newId).not.toHaveBeenCalled();
    f.owner.dispose();
  });
  it.each(["applied", "not_applied"])("Stop followed by lost answer is reconciled as %s without replay", async outcome => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.owner.begin(action()); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    await f.owner.begin(stop);
    f.fetcher.mockResolvedValueOnce(response(outcome === "applied" ? accepted(original(), "10", closed(), "already_applied") : missing(original(), "10", true)));
    gate.reject(new Error("connection lost")); await send;
    await vi.waitFor(() => expect(f.owner.snapshot().primary.pending).toBe(false));
    expect(f.owner.snapshot().primary.outcome).toBe(outcome === "applied" ? "accepted" : "not_applied");
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "POST", "GET"]);
    expect(String(f.fetcher.mock.calls[2][0])).toContain(`/commands/${id(100)}?`);
  });
  it("a failed check after Stop stays durable and is checked again on the probe schedule, never in a loop", async () => {
    vi.useFakeTimers();
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.owner.begin(action()); await tick(); expect(f.fetcher).toHaveBeenCalledOnce(); await f.owner.begin(stop);
    // The one check of the closed session and the machine's check after the loss share a single GET.
    f.fetcher.mockRejectedValueOnce(new Error("offline")); gate.reject(new Error("lost")); await send; await tick();
    expect(f.owner.snapshot().primary).toMatchObject({ phase: "unresolved", problem: "network" });
    expect(f.owner.snapshot().recovery?.state.name).toBe("unreachable");
    expect(f.fetcher).toHaveBeenCalledTimes(3); expect(f.values.has(primaryKey)).toBe(true);
    await tick(4000); expect(f.fetcher).toHaveBeenCalledTimes(3);
    f.fetcher.mockResolvedValueOnce(response(missing(original(), "10", true))); await tick(1000);
    expect(f.fetcher).toHaveBeenCalledTimes(4); expect(f.values.has(primaryKey)).toBe(false);
    expect(f.owner.snapshot().primary.outcome).toBe("not_applied");
    expect(f.fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(2);
  });
  it("unknown Stop blocks a new primary command until its outcome is checked", async () => {
    const f = fixture(); await f.owner.refresh(); f.fetcher.mockRejectedValueOnce(new Error("lost")); await f.owner.begin(stop);
    await f.owner.begin(action()); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.newId).toHaveBeenCalledOnce();
    f.fetcher.mockResolvedValueOnce(response(accepted(original(stop), "10", closed(), "already_applied"))); await f.owner.refresh();
    await f.owner.begin(action()); expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.fetcher.mockResolvedValueOnce(response(accepted(original({ kind: "session.start", session_id: id(20), payload: { mode: "learning" } }, 101), "11", current(id(20)))));
    await f.owner.begin({ kind: "session.start", session_id: id(20), payload: { mode: "learning" } });
    expect(f.owner.snapshot().primary.outcome).toBe("accepted"); expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it("an old accepted Stop fact still closes its exact session when its current projection is unavailable", async () => {
    const command = original(stop), f = fixture({ stop: command }); f.replace({ profile: profile("20") });
    const value = { ...accepted(command, "10", closed(), "already_applied"), current: { status: "unavailable" } };
    f.fetcher.mockResolvedValueOnce(response(value)); await f.owner.refresh();
    expect(f.owner.snapshot()).toMatchObject({ stateVersion: "20", stop: { outcome: "accepted", pending: false, current: null,
      resolved: { commandId: command.command_id, kind: "session.stop", sessionId: id(3) } } });
    await f.owner.begin(action()); await f.owner.begin(stop); await f.owner.begin({ kind: "session.start", session_id: id(3), payload: { mode: "learning" } });
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.newId).not.toHaveBeenCalled();
  });
  it("both unknown lanes recover with GET, and primary retry waits for Stop", async () => {
    const primary = original(), stopping = original(stop, 101), f = fixture({ primary, stop: stopping });
    let stopped = false;
    f.fetcher.mockImplementation(async (url, options) => {
      if (options?.method === "POST") {
        const command = JSON.parse(String(options.body)); expect(command.command_id).toBe(stopping.command_id);
        stopped = true; return response(accepted(command, "10", closed()));
      }
      if (String(url).includes("/sessions/")) return response({ current: current(), state_version: "3" });
      return response(missing(String(url).includes(primary.command_id) ? primary : stopping, stopped ? "10" : "3", stopped));
    });
    vi.useFakeTimers();
    // The answer is a study result: no manual retry, and its recovery never sends while Stop is unresolved.
    await f.owner.refresh(); await tick(); expect(f.owner.snapshot().primary.canRetry).toBe(false);
    await f.owner.retry("primary"); await tick(60_000);
    expect(f.fetcher.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
    await f.owner.retry("stop"); await tick();
    expect(f.owner.snapshot().primary.pending).toBe(false);
    expect(f.owner.snapshot().primary.outcome).toBe("not_applied");
    expect(f.fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
    expect(f.newId).not.toHaveBeenCalled();
  });
  it("a refreshed handle supplies new credentials and ignores a late refusal from the old handle", async () => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.owner.begin(action()); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.replace({}, "synthetic-new-token"); gate.resolve(response({ error: { code: "EXPIRED" } }, 401)); await send;
    expect(f.onDenied).not.toHaveBeenCalled(); expect(f.owner.snapshot()).toMatchObject({ live: true, primary: { pending: true, outcome: null } });
    f.fetcher.mockResolvedValueOnce(response(accepted(original(), "4", current(), "already_applied"))); await f.owner.refresh();
    expect(f.fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-new-token" });
    expect(f.owner.snapshot().primary.outcome).toBe("accepted");
  });
  it.each(["primary", "stop"] as const)("foreground joining an old-handle %s POST checks its original receipt once", async lane => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh();
    f.fetcher.mockReturnValueOnce(gate.promise); const transition = lane === "stop" ? stop : action(), command = original(transition);
    const send = f.owner.begin(transition); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.replace({}, "synthetic-new-token");
    f.fetcher.mockResolvedValueOnce(response(accepted(command, "10", lane === "stop" ? closed() : current(), "already_applied")));
    const foreground = f.owner.refresh(); gate.resolve(response(accepted(command, "4", lane === "stop" ? closed() : current())));
    await Promise.all([send, foreground]);
    // The answer's own check by ID (automatic recovery) may still be on its way.
    await vi.waitFor(() => expect(f.owner.snapshot()[lane]).toMatchObject({ outcome: "accepted", pending: false }));
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "GET"]);
    expect(String(f.fetcher.mock.calls[1][0])).toContain(command.command_id);
    expect(f.fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-new-token" });
    expect(f.newId).toHaveBeenCalledOnce();
  });
  it("foreground joining a successful send does not request an unnecessary receipt", async () => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.owner.begin(action()); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    const foreground = f.owner.refresh(); gate.resolve(response(accepted(original()))); await Promise.all([send, foreground]);
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.owner.snapshot().primary.outcome).toBe("accepted");
  });
  it("a failed receipt check after joining a send remains pending: checks on the probe schedule, never a resend", async () => {
    vi.useFakeTimers();
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.owner.begin(action()); await tick(); expect(f.fetcher).toHaveBeenCalledOnce();
    f.fetcher.mockRejectedValueOnce(new Error("status offline")); const foreground = f.owner.refresh();
    gate.reject(new Error("lost send")); await Promise.all([send, foreground]); await tick();
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "GET"]);
    expect(f.owner.snapshot().primary).toMatchObject({ pending: true, outcome: null, phase: "unresolved", canRetry: false });
    // The default fetcher of the fixture refuses every GET: checks at 5, 15 and 35 s, no POST.
    await tick(4000); expect(f.fetcher).toHaveBeenCalledTimes(2);
    for (let second = 0; second < 40; second += 5) await tick(5000);
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "GET", "GET", "GET", "GET"]);
    expect(f.values.has(primaryKey)).toBe(true); expect(f.newId).toHaveBeenCalledOnce();
    f.owner.dispose();
  });
  it.each(["dispose", "document"] as const)("joined foreground does not check an old command after %s", async ending => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.owner.begin(action()); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    const foreground = f.owner.refresh();
    if (ending === "dispose") f.owner.dispose(); else f.replace({ document_id: id(91) });
    gate.resolve(response(accepted(original()))); await Promise.all([send, foreground]);
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.values.has(primaryKey)).toBe(true); expect(f.owner.snapshot().live).toBe(false);
  });
  it.each([401, 403])("a current HTTP %s revokes the document and preserves the unknown intent", async status => {
    const f = fixture(); await f.owner.refresh(); f.fetcher.mockResolvedValueOnce(response({ error: { code: "FORBIDDEN" } }, status));
    await f.owner.begin(action()); expect(f.onDenied).toHaveBeenCalledOnce();
    expect(f.owner.snapshot()).toMatchObject({ live: false, canBegin: false, canStop: false, primary: { phase: "disposed", pending: true, current: null } });
    await f.owner.refresh(); await f.owner.begin(stop); await f.owner.retry("primary"); expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.values.has(primaryKey)).toBe(true);
  });
  it.each(["profile", "pair", "client", "document", "revoked", "dispose"])("context change %s prevents late data and new writes", async changed => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const send = f.owner.begin(action()); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    if (changed === "profile") f.replace({ profile: { ...profile(), profile_id: id(90) } });
    else if (changed === "pair") f.replace({ profile: { ...profile(), dictionary_language: "en" } });
    else if (changed === "client") f.replace({ client_instance_id: id(90) });
    else if (changed === "document") f.replace({ document_id: id(90) });
    else if (changed === "revoked") f.revoke(); else f.owner.dispose();
    const emitted = f.onUpdate.mock.calls.length; gate.resolve(response(accepted(original()))); await send;
    expect(f.owner.snapshot()).toMatchObject({ live: false, primary: { pending: true, outcome: null, answer: null, current: null, resolved: null } });
    await f.owner.refresh(); await f.owner.begin(stop); await f.owner.retry("primary");
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.onUpdate).toHaveBeenCalledTimes(emitted); expect(f.values.has(primaryKey)).toBe(true);
  });
  it("a newer foreground profile immediately blocks a previously verified retry", async () => {
    const command = original(present), f = fixture({ primary: command });
    f.fetcher.mockResolvedValueOnce(response(missing(command))).mockResolvedValueOnce(response({ current: prefetched(), state_version: "3" }));
    await f.owner.refresh();
    expect(f.owner.snapshot().primary.canRetry).toBe(true); f.replace({ profile: profile("10") });
    await f.owner.retry("primary"); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.owner.snapshot()).toMatchObject({ stateVersion: "10", primary: { pending: true, canRetry: false, current: null, answer: null } });
  });
  it("failed local persistence blocks the answer while independent Stop still works", async () => {
    const f = fixture(); await f.owner.refresh(); vi.mocked(f.storage.set).mockRejectedValueOnce(new Error("storage full"));
    await f.owner.begin(action()); expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.owner.snapshot()).toMatchObject({ canBegin: false, canStop: true, primary: { problem: "storage", pending: true } });
    f.fetcher.mockResolvedValueOnce(response(accepted(original(stop, 101), "10", closed())))
      .mockResolvedValueOnce(response(missing(original(), "10", true)));
    await f.owner.begin(stop); await vi.waitFor(() => expect(f.owner.snapshot().primary.pending).toBe(false));
    expect(f.fetcher.mock.calls.map(call => call[1]?.method)).toEqual(["POST", "GET"]);
    expect(f.owner.snapshot().primary.outcome).toBe("not_applied");
  });
  it.each([primaryKey, stopKey])("malformed %s remains stored and blocks new primary writes", async key => {
    const f = fixture(); f.values.set(key, "not-json"); await f.owner.refresh(); await f.owner.begin(action());
    expect(f.owner.snapshot().canBegin).toBe(false); expect(f.values.get(key)).toBe("not-json");
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
  });
  it("captures the submitted input before awaiting storage and never stores credentials", async () => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const input = action(), send = f.owner.begin(input); Object.assign(input.payload, { text: "changed" });
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).payload).toEqual({ text: "Haus" });
    expect(JSON.parse(f.values.get(primaryKey)!).intent.payload).toEqual({ text: "Haus" });
    gate.resolve(response(accepted(original()))); await send;
    const snapshot = f.owner.snapshot(); snapshot.primary.resolved!.sessionId = id(99);
    expect(f.owner.snapshot().primary.resolved!.sessionId).toBe(id(3));
    expect(JSON.stringify(f.owner.snapshot())).not.toMatch(/synthetic-token|synthetic-proof/);
  });
  it("a screen read is GET-only and advances the same document version", async () => {
    const f = fixture(); await f.owner.refresh(); f.fetcher.mockResolvedValueOnce(response({ current: current(), state_version: "7" }));
    expect(await f.owner.readSession(id(3))).toEqual({ current: current(), state_version: "7" });
    expect(f.owner.snapshot().stateVersion).toBe("7"); expect(f.fetcher.mock.calls[0][1]?.method).toBe("GET");
    expect(f.newId).not.toHaveBeenCalled(); expect(f.storage.set).not.toHaveBeenCalled();
  });
  it("exact result reading captures the address and never infers a command outcome", async () => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const address = { session_id: id(3), assignment_id: id(6), result_id: id(7) }, work = f.owner.readResult(address);
    address.result_id = id(99); gate.resolve(response(resultRead("2", 4, "8"))); const read = await work;
    expect(read.result?.result_id).toBe(id(7)); expect(f.owner.snapshot()).toMatchObject({ stateVersion: "8", primary: { outcome: null } });
    expect(new URL(String(f.fetcher.mock.calls[0][0]), "http://localhost").searchParams.get("result_id")).toBe(id(7));
    expect(f.fetcher.mock.calls[0][1]?.method).toBe("GET"); expect(f.newId).not.toHaveBeenCalled();
  });
  it.each(["session", "result"])("late %s screen read cannot return a card after newer Stop", async kind => {
    const f = fixture(), gate = deferred<Response>(); await f.owner.refresh(); f.fetcher.mockReturnValueOnce(gate.promise);
    const read = kind === "session" ? f.owner.readSession(id(3)) : f.owner.readResult({ session_id: id(3), assignment_id: id(6), result_id: id(7) });
    await f.owner.begin(stop);
    const rejected = expect(read).rejects.toMatchObject({ kind: "invalid_response" });
    gate.resolve(response(kind === "session" ? { current: current(), state_version: "9" } : resultRead("1", 4, "9"))); await rejected;
    expect(f.owner.snapshot()).toMatchObject({ stateVersion: "10", stop: { outcome: "accepted", current: { status: "closed" } } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("a newer addressed result read invalidates an older concurrent session read", async () => {
    const f = fixture(), gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const old = f.owner.readSession(id(3)); f.fetcher.mockResolvedValueOnce(response(resultRead("2", 4, "8")));
    await f.owner.readResult({ session_id: id(3), assignment_id: id(6), result_id: id(7) });
    const rejected = expect(old).rejects.toMatchObject({ kind: "invalid_response" });
    gate.resolve(response({ current: current(), state_version: "7" })); await rejected;
    expect(f.owner.snapshot().stateVersion).toBe("8");
  });
  it("a closed screen read cannot erase pending until the separate atomic outcome is known", async () => {
    const command = original(present), f = fixture({ primary: command }), gate = deferred<Response>();
    f.fetcher.mockResolvedValueOnce(response(missing(command))).mockResolvedValueOnce(response({ current: prefetched(), state_version: "3" }));
    await f.owner.refresh();
    f.fetcher.mockResolvedValueOnce(response({ current: closed(), state_version: "10" })).mockReturnValueOnce(gate.promise);
    await f.owner.readSession(id(3)); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(4));
    expect(f.owner.snapshot().primary).toMatchObject({ pending: true, outcome: null, canRetry: false });
    expect(f.values.has(primaryKey)).toBe(true); gate.resolve(response(missing(command, "10", true)));
    await vi.waitFor(() => expect(f.owner.snapshot().primary.outcome).toBe("not_applied"));
    expect(f.values.has(primaryKey)).toBe(false); expect(f.fetcher.mock.calls.every(call => call[1]?.method === "GET")).toBe(true);
  });
  it("closure of another addressed session does not resolve this pending intent", async () => {
    const command = original(present), f = fixture({ primary: command });
    f.fetcher.mockResolvedValueOnce(response(missing(command))).mockResolvedValueOnce(response({ current: prefetched(), state_version: "3" }));
    await f.owner.refresh();
    f.fetcher.mockResolvedValueOnce(response({ current: { ...closed(), session_id: id(90) }, state_version: "10" }));
    await f.owner.readSession(id(90));
    expect(f.fetcher).toHaveBeenCalledTimes(3); expect(f.owner.snapshot().primary).toMatchObject({ pending: true, outcome: null });
    expect(JSON.parse(f.values.get(primaryKey)!).intent).toEqual(command);
  });
  it("screen reads use the refreshed document's current credentials", async () => {
    const f = fixture(); f.replace({}, "synthetic-new-token"); f.fetcher.mockResolvedValueOnce(response({ current: current(), state_version: "3" }));
    await f.owner.readSession(id(3)); expect(f.fetcher.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-new-token" });
  });
  it.each([401, 403])("screen read HTTP %s revokes access and subsequent reads never send", async status => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(response({ error: { code: "FORBIDDEN" } }, status));
    await expect(f.owner.readSession(id(3))).rejects.toMatchObject({ status }); expect(f.onDenied).toHaveBeenCalledOnce();
    await expect(f.owner.readSession(id(3))).rejects.toThrow("closed_access");
    await expect(f.owner.readResult({ session_id: id(3), assignment_id: id(6), result_id: id(7) })).rejects.toThrow("closed_access");
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(["dispose", "handle", "pair"])("late screen read is discarded after %s changes", async changed => {
    const f = fixture(), gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    const work = f.owner.readSession(id(3));
    if (changed === "dispose") f.owner.dispose(); else f.replace(changed === "pair" ? { profile: { ...profile(), dictionary_language: "en" } } : {});
    const emitted = f.onUpdate.mock.calls.length, rejected = expect(work).rejects.toThrow("closed_access");
    gate.resolve(response({ current: current(), state_version: "5" })); await rejected;
    expect(f.onUpdate).toHaveBeenCalledTimes(emitted);
  });
  it("a screen read below the current foreground profile is not returned", async () => {
    const f = fixture(); f.replace({ profile: profile("20") }); f.fetcher.mockResolvedValueOnce(response({ current: current(), state_version: "19" }));
    await expect(f.owner.readSession(id(3))).rejects.toMatchObject({ kind: "invalid_response" });
    expect(f.owner.snapshot().stateVersion).toBe("20");
  });
  it("invalid read addresses cannot reach the network", async () => {
    const f = fixture(); await expect(f.owner.readSession("bad-id")).rejects.toThrow("invalid Learning session access");
    await expect(f.owner.readResult({ session_id: id(3), assignment_id: id(6), result_id: "bad-id" })).rejects.toThrow("invalid Learning result address");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
