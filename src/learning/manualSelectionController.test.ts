import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { LearningCurrentResponse, ManualSelectionCommand, Profile, SavedCommandFact } from "../api/generated";
import type { AsyncStorage } from "../platform/storage";
import { createLearningApi, type LearningApi, type ManualCommandReply, type ManualStatusReply } from "./learningApi";
import { ManualPendingStore, type ManualPending } from "./manualPending";
import { ManualSelectionController, type ManualContext, type ManualSelectionSnapshot } from "./manualSelectionController";
import { testGate } from "../commands/testGate.test-support";
import type { WriteGate } from "../commands/writeGate";
import { WriteGate as RealWriteGate } from "../commands/writeGate";
import { ManualClock } from "../commands/writeGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const context = (): ManualContext => ({ profileId: id(1), clientInstanceId: id(2), documentId: id(3),
  pair: "ru-de", token: "synthetic-token", proof: "synthetic-proof" });
const pending = (): ManualPending => ({ schemaVersion: 1, profileId: id(1), clientInstanceId: id(2), intent: {
  command_id: id(100), kind: "learning.select", expected_selection_version: "10",
  payload: { card_id: id(4), expected_pair: "ru-de" },
} });
const current = (version = "10"): LearningCurrentResponse => ({ pair: "ru-de", state_version: version,
  manual_selection_version: version, manual_selection: [], group: null,
  learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null,
    new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 } });
const fact = (): SavedCommandFact => ({ id: id(100), kind: "learning.select", status: "applied",
  applied_at: "2026-09-30T00:00:00Z", target_id: id(4), action_id: null, result_id: null,
  context_id: null, object_version: "11" });
const accepted = (): ManualCommandReply => ({ outcome: "accepted", command: fact(), current: current("11"), state_version: "11" });
const profile = (): Profile => ({ profile_id: id(1), access: { status: "admitted", reason: null, version: "1" },
  state_version: "10", role: "user", dictionary_language: "ru", ui_language: "ru", time_zone: "UTC" });
const missing = (): ManualStatusReply => ({ outcome: "not_found", command: { id: id(100), status: "not_found" },
  current: profile(), state_version: "10" });
function persisted() {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  return { values, storage, store: new ManualPendingStore(storage) };
}
function fixture(options: { context?: Partial<ManualContext>; disk?: ReturnType<typeof persisted>; api?: LearningApi;
  writeGate?: WriteGate } = {}) {
  const disk = options.disk ?? persisted();
  const api = options.api ?? { get: vi.fn(async () => current()),
    change: vi.fn(async () => accepted()), status: vi.fn(async () => missing()) } satisfies LearningApi;
  const states: ManualSelectionSnapshot[] = [];
  let sequence = 100;
  const newId = vi.fn(() => id(sequence++));
  const controller = new ManualSelectionController({ gate: options.writeGate ?? testGate(), api, pendingStore: disk.store,
    context: { ...context(), ...options.context }, newId, onUpdate: state => states.push(state) });
  return { controller, api, disk, states, newId };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function seed(disk: ReturnType<typeof persisted>, value = pending()) {
  await disk.store.save(value, new AbortController().signal);
}

describe("manual selection controller", () => {
  it("loads before allowing a change and stores the intent before POST", async () => {
    const f = fixture();
    await f.controller.change(id(4), true);
    expect(f.api.change).not.toHaveBeenCalled();
    await f.controller.refresh();
    vi.mocked(f.api.change).mockImplementationOnce(async (_token, _proof, request) => {
      expect(JSON.parse([...f.disk.values.values()][0])).toEqual(pending());
      expect(f.controller.snapshot().canChange).toBe(false);
      expect(request).toEqual({ ...pending().intent, client_instance_id: id(2), document_id: id(3) });
      return accepted();
    });
    await f.controller.change(id(4), true);
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pending: null,
      canChange: true, outcome: { status: "accepted", commandId: id(100) } });
    expect(f.disk.values.size).toBe(0);
  });

  it("coalesces repeated clicks and does not queue a different card behind an unknown outcome", async () => {
    const f = fixture(); await f.controller.refresh();
    const sending = gate<ManualCommandReply>(); vi.mocked(f.api.change).mockReturnValueOnce(sending.promise);
    const first = f.controller.change(id(4), true);
    const second = f.controller.change(id(5), false);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(f.api.change).toHaveBeenCalledOnce());
    sending.reject(new ApiError("network")); await first;
    await f.controller.change(id(6), true);
    expect(f.api.change).toHaveBeenCalledOnce(); expect(f.newId).toHaveBeenCalledOnce();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canChange: false, canRetry: true,
      pending: pending(), problem: { reason: "network" } });
  });

  it("repeats the exact command manually after loss, without a new identifier", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockRejectedValueOnce(new ApiError("network"));
    await f.controller.change(id(4), true);
    expect(f.api.change).toHaveBeenCalledOnce();
    await f.controller.retry();
    expect(vi.mocked(f.api.change).mock.calls[1]).toEqual(vi.mocked(f.api.change).mock.calls[0]);
    expect(f.newId).toHaveBeenCalledOnce();
    expect(f.controller.snapshot().pending).toBeNull();
  });

  it("restores with status only; a new live document changes only transport fields", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk, context: { documentId: id(30), token: "renewed-token", proof: "renewed-proof" } });
    vi.mocked(f.api.get).mockResolvedValue(current("12"));
    await f.controller.refresh();
    expect(f.api.change).not.toHaveBeenCalled(); expect(f.newId).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), canRetry: true, problem: { reason: "not_found" } });
    await f.controller.retry();
    expect(f.api.change).toHaveBeenCalledExactlyOnceWith("renewed-token", "renewed-proof",
      { ...pending().intent, client_instance_id: id(2), document_id: id(30) });
    // The old intent's version10 is not upgraded to the freshly read12.
    expect(f.controller.snapshot().data?.state_version).toBe("12");
  });

  it("an accepted recovery clears pending without POST, even when the current pair changed", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk, context: { pair: "uk-de" } });
    vi.mocked(f.api.status).mockResolvedValue({ outcome: "accepted", command: { ...fact(), status: "already_applied" },
      current: { ...current("20"), pair: "uk-de" }, state_version: "20" });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pending: null, outcome: { status: "accepted" },
      data: { pair: "uk-de" }, canChange: true });
    expect(f.api.change).not.toHaveBeenCalled();
  });

  it.each(["client", "pair"] as const)("does not retarget an unknown intent after changing %s", async changed => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk, context: changed === "client" ? { clientInstanceId: id(99) } : { pair: "uk-de" } });
    if (changed === "pair") vi.mocked(f.api.get).mockResolvedValue({ ...current(), pair: "uk-de" });
    await f.controller.refresh(); await f.controller.retry(); await f.controller.change(id(9), true);
    expect(f.api.change).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), canRetry: false, canChange: false,
      problem: { reason: changed === "client" ? "client_changed" : "pair_changed" } });
  });

  it("drops the previous account's temporary data and never queries its command", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk, context: { profileId: id(9) } });
    await f.controller.refresh();
    expect(f.api.status).not.toHaveBeenCalled(); expect(f.api.change).not.toHaveBeenCalled();
    expect(disk.values.size).toBe(0); expect(f.controller.snapshot().pending).toBeNull();
  });

  it("does not clear an unknown intent when status returns another profile", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk });
    vi.mocked(f.api.status).mockResolvedValue({ outcome: "not_found", command: { id: id(100), status: "not_found" },
      current: { ...profile(), profile_id: id(9) }, state_version: "10" });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ phase: "unresolved", canChange: false, canRetry: false,
      pending: pending(), problem: { reason: "profile_changed" } });
    await f.controller.retry();
    expect(f.api.get).not.toHaveBeenCalled(); expect(f.api.change).not.toHaveBeenCalled();
  });

  it("preserves an accepted fact but no write permissions when current is unavailable", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk });
    vi.mocked(f.api.status).mockResolvedValue({ outcome: "accepted", command: { ...fact(), status: "already_applied" },
      current: { status: "unavailable" }, state_version: "20" });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pending: null, outcome: { status: "accepted" },
      data: null, canChange: false, problem: { reason: "forbidden" } });
  });

  it("not_found with revoked access keeps the intent and does not fetch study data", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk });
    vi.mocked(f.api.status).mockResolvedValue({ outcome: "not_found", command: { id: id(100), status: "not_found" },
      current: { ...profile(), access: { status: "rejected", reason: null, version: "2" } }, state_version: "20" });
    await f.controller.refresh(); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), data: null, canRetry: false });
    expect(f.api.get).not.toHaveBeenCalled(); expect(f.api.change).not.toHaveBeenCalled();
  });

  it("keeps bigint versions monotonic while resolving a fact from a delayed projection", async () => {
    const f = fixture();
    vi.mocked(f.api.get).mockResolvedValue(current("9007199254740997"));
    await f.controller.refresh();
    vi.mocked(f.api.change).mockResolvedValue({ ...accepted(), current: current("9007199254740996"), state_version: "9007199254740996" });
    await f.controller.change(id(4), true);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, outcome: { status: "accepted" },
      data: { state_version: "9007199254740997" }, canChange: true });
    vi.mocked(f.api.get).mockResolvedValue(current("2"));
    await f.controller.refresh();
    expect(f.controller.snapshot().data?.state_version).toBe("9007199254740997");
  });

  it("does not resurrect an older list after a newer status/calendar read", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk });
    const status = missing(); status.state_version = "20";
    vi.mocked(f.api.status).mockResolvedValue(status);
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ data: null, canChange: false, pending: pending() });
  });

  it("uses the current manual-list version, not the broader profile version, for a new intent", async () => {
    const f = fixture();
    vi.mocked(f.api.get).mockResolvedValue({ ...current("200"), manual_selection_version: "7" });
    await f.controller.refresh(); await f.controller.change(id(4), false);
    expect(vi.mocked(f.api.change).mock.calls[0][2]).toMatchObject({ kind: "learning.unselect", expected_selection_version: "7" });
  });

  it.each(["VERSION_CONFLICT", "ASSIGNMENT_STALE"])("settles an addressed %s refusal before allowing another intent", async code => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockResolvedValueOnce({ outcome: "rejected", command: { id: id(100), status: "rejected" },
      current: current("11"), state_version: "11", error: { code } });
    await f.controller.change(id(4), true);
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canChange: true, outcome: { status: "rejected", code } });
  });

  it("keeps a payload mismatch unresolved and does not repeat it blindly", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockResolvedValueOnce({ outcome: "mismatch", command: { id: id(100), status: "rejected" },
      current: current("11"), state_version: "11", error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await f.controller.change(id(4), true); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), canChange: false, canRetry: false, outcome: null });
    expect(f.api.change).toHaveBeenCalledOnce();
  });

  it.each([false, true])("does not claim an older fact as this intent after a mismatch (restart=%s)", async restart => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockResolvedValueOnce({ outcome: "mismatch", command: { id: id(100), status: "rejected" },
      current: current("11"), state_version: "11", error: { code: "COMMAND_PAYLOAD_MISMATCH" } });
    await f.controller.change(id(4), true);
    if (restart) f.controller.dispose();
    const active = restart ? fixture({ disk: f.disk, context: { documentId: id(30) } }) : f;
    // GET's minimal fact has no original expected pair/version, so cannot disprove this mismatch.
    vi.mocked(active.api.status).mockResolvedValue({ outcome: "accepted", command: { ...fact(), status: "already_applied" },
      current: current("12"), state_version: "12" });
    await active.controller.refresh(); await active.controller.retry();
    expect(active.controller.snapshot()).toMatchObject({ outcome: null, canChange: false, canRetry: false,
      problem: { reason: "mismatch" }, pending: { intent: pending().intent } });
    expect(active.api.status).not.toHaveBeenCalled();
  });

  it("retries only mismatch-marker persistence after a storage failure", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockImplementationOnce(async () => {
      vi.mocked(f.disk.storage.set).mockRejectedValueOnce(new Error("marker write failed"));
      return { outcome: "mismatch", command: { id: id(100), status: "rejected" },
        current: current("11"), state_version: "11", error: { code: "COMMAND_PAYLOAD_MISMATCH" } };
    });
    await f.controller.change(id(4), true); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: { mismatch: true }, canRetry: false, canChange: false });
    await f.controller.refresh();
    expect(JSON.parse([...f.disk.values.values()][0]).mismatch).toBe(true);
    expect(f.api.change).toHaveBeenCalledOnce(); expect(f.api.status).not.toHaveBeenCalled();
    expect(f.controller.snapshot().problem?.reason).toBe("mismatch");
  });

  it("disposal during initial load prevents a late screen update or command", async () => {
    const f = fixture(); const loading = gate<LearningCurrentResponse>();
    vi.mocked(f.api.get).mockReturnValueOnce(loading.promise);
    const task = f.controller.refresh();
    await vi.waitFor(() => expect(f.api.get).toHaveBeenCalledOnce());
    f.controller.dispose(); const count = f.states.length;
    loading.resolve(current()); await task; await f.controller.change(id(4), true);
    expect(f.states).toHaveLength(count); expect(f.api.change).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", data: null, canChange: false });
  });

  it.each([401, 403])("HTTP %s hides old data without losing the unknown command", async status => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockRejectedValueOnce(new ApiError("http", status));
    await f.controller.change(id(4), true); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), data: null, canChange: false, canRetry: false,
      problem: { reason: status === 401 ? "expired" : "forbidden" } });
    expect(f.api.change).toHaveBeenCalledOnce();
  });

  it("does not send when local save fails; recovery still uses the same ID", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.disk.storage.set).mockRejectedValueOnce(new Error("synthetic storage failure"));
    await f.controller.change(id(4), true);
    expect(f.api.change).not.toHaveBeenCalled();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), canRetry: true, problem: { reason: "storage" } });
    await f.controller.retry();
    expect(f.newId).toHaveBeenCalledOnce(); expect(f.api.change).toHaveBeenCalledOnce();
  });

  it("retries local cleanup after acceptance without repeating the command", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.disk.storage.remove).mockRejectedValueOnce(new Error("remove failed"));
    await f.controller.change(id(4), true); await f.controller.retry();
    expect(f.controller.snapshot()).toMatchObject({ pending: pending(), outcome: { status: "accepted" }, canChange: false, canRetry: false });
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ pending: null, canChange: true });
    expect(f.api.change).toHaveBeenCalledOnce(); expect(f.api.status).not.toHaveBeenCalled();
  });

  it.each(["read failure", "corrupt data"])("blocks new commands on %s", async reason => {
    const f = fixture();
    if (reason === "read failure") vi.mocked(f.disk.storage.get).mockRejectedValueOnce(new Error("read failure"));
    else f.disk.values.set("wortly.pending.manual", "broken");
    await f.controller.refresh(); await f.controller.change(id(4), true);
    expect(f.controller.snapshot().canChange).toBe(false); expect(f.api.change).not.toHaveBeenCalled();
    expect(f.newId).not.toHaveBeenCalled();
  });

  it("does not erase a different pending record during completion cleanup", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockImplementationOnce(async () => {
      f.disk.values.set("wortly.pending.manual", JSON.stringify({ ...pending(), intent: { ...pending().intent, command_id: id(999) } }));
      return accepted();
    });
    await f.controller.change(id(4), true);
    expect(f.controller.snapshot()).toMatchObject({ canChange: false, problem: { reason: "pending_changed" } });
    expect(JSON.parse([...f.disk.values.values()][0]).intent.command_id).toBe(id(999));
  });

  it("a UI snapshot cannot mutate the replay payload", async () => {
    const f = fixture(); await f.controller.refresh();
    vi.mocked(f.api.change).mockRejectedValueOnce(new ApiError("network"));
    await f.controller.change(id(4), true);
    f.controller.snapshot().pending!.intent.payload.card_id = id(999);
    f.states.at(-1)!.pending!.intent.expected_selection_version = "999";
    await f.controller.retry();
    expect(vi.mocked(f.api.change).mock.calls[1][2]).toMatchObject(pending().intent);
  });

  it("disposal during pending save prevents POST and leaves recovery data", async () => {
    const f = fixture(); await f.controller.refresh();
    const saving = gate<void>();
    vi.mocked(f.disk.storage.set).mockImplementationOnce(async (key, value) => { await saving.promise; f.disk.values.set(key, value); });
    const task = f.controller.change(id(4), true);
    await vi.waitFor(() => expect(f.disk.storage.set).toHaveBeenCalledOnce());
    f.controller.dispose(); const count = f.states.length;
    saving.resolve(); await task;
    expect(f.api.change).not.toHaveBeenCalled(); expect(f.states).toHaveLength(count); expect(f.disk.values.size).toBe(1);
  });

  it("disposal during POST keeps the intent despite a late accepted response", async () => {
    const f = fixture(); await f.controller.refresh();
    const sending = gate<ManualCommandReply>(); vi.mocked(f.api.change).mockReturnValueOnce(sending.promise);
    const task = f.controller.change(id(4), true);
    await vi.waitFor(() => expect(f.api.change).toHaveBeenCalledOnce());
    f.controller.dispose(); const count = f.states.length;
    sending.resolve(accepted()); await task;
    expect(f.states).toHaveLength(count); expect(f.disk.values.size).toBe(1);
  });

  it("disposal during status does not publish or delete data needed by a new document", async () => {
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk }); const checking = gate<ManualStatusReply>();
    vi.mocked(f.api.status).mockReturnValueOnce(checking.promise);
    const task = f.controller.refresh();
    await vi.waitFor(() => expect(f.api.status).toHaveBeenCalledOnce());
    f.controller.dispose(); const count = f.states.length;
    checking.resolve({ outcome: "accepted", command: { ...fact(), status: "already_applied" }, current: current("11"), state_version: "11" });
    await task;
    expect(f.states).toHaveLength(count); expect(disk.values.size).toBe(1);
  });

  it("recovers a lost committed response through the real adapter, without a second POST", async () => {
    let committed: ManualSelectionCommand | null = null;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (init?.method === "POST") {
        committed = JSON.parse(init.body as string) as ManualSelectionCommand;
        throw new Error("lost after commit");
      }
      const value = String(url).endsWith("/learning/current") ? current()
        : { command: { ...fact(), status: "already_applied" }, current: current("11"), state_version: "11" };
      return new Response(JSON.stringify(value));
    });
    const api = createLearningApi({ fetcher, timeoutMs: 1000, maxResponseBytes: 10000, gate: testGate() });
    const disk = persisted();
    const first = fixture({ disk, api }); await first.controller.refresh(); await first.controller.change(id(4), true);
    expect(committed).toMatchObject(pending().intent);
    first.controller.dispose();
    const second = fixture({ disk, api, context: { documentId: id(30) } }); await second.controller.refresh();
    expect(second.controller.snapshot()).toMatchObject({ pending: null, outcome: { status: "accepted" }, canChange: true });
    expect(fetcher.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(1);
  });
});

describe("the buttons and the write gate (P03 M-P03-8, C335)", () => {
  it("P2-1: after an unknown outcome «Повторить» reads the ID first, so a family lock never keeps it; it sends only after not_recorded", async () => {
    const writeGate = new RealWriteGate({ clock: new ManualClock() });
    writeGate.resolvePending(id(100), "stale");
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk, writeGate });
    (f.api.status as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("network"));
    await f.controller.refresh();
    expect(f.controller.snapshot()).toMatchObject({ problem: { reason: "network" }, canRetry: true });
    await f.controller.retry();
    expect(f.api.status).toHaveBeenCalledTimes(2);
    expect(f.api.change).toHaveBeenCalledOnce();
    expect(writeGate.snapshot().familyLocks).toEqual([]);
    f.controller.dispose();
  });

  it("the gate closed: neither a check-first repeat nor a new change is offered", async () => {
    const writeGate = new RealWriteGate({ clock: new ManualClock() });
    const disk = persisted(); await seed(disk);
    const f = fixture({ disk, writeGate });
    (f.api.status as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TypeError("network"));
    await f.controller.refresh();
    writeGate.closeByFailure();
    expect(f.controller.snapshot()).toMatchObject({ canRetry: false, canChange: false });
    f.controller.dispose();
  });
});
