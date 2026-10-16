import { withTrace } from "../api/traceHeader.test-support";
import { describe, expect, it, vi } from "vitest";
import type { LearningCurrentResponse, ManualSelectionCommand, OpenedClient } from "../api/generated";
import { ApiError } from "../api/http";
import { ClosedAccessError, createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { ACCESS_BOUND_MARKER, accessBoundLearningApi, accessBoundManualContext, manualPairOf } from "./accessBoundLearningApi";
import { createLearningApi, type LearningApi, type ManualIntent } from "./learningApi";
import { ManualPendingStore } from "./manualPending";
import { ManualSelectionController, type ManualSelectionSnapshot } from "./manualSelectionController";
import { readWithTicket, testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const big = "9007199254740995";
const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
  profile: { profile_id: id(3), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: big,
    access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
const intent = (): ManualIntent => ({ command_id: id(100), kind: "learning.select", expected_selection_version: big,
  payload: { card_id: id(4), expected_pair: "ru-de" } });
const command = (patch: Partial<ManualSelectionCommand> = {}): ManualSelectionCommand => ({ ...intent(),
  client_instance_id: id(1), document_id: id(2), ...patch });
const current = (version = big): LearningCurrentResponse => ({ pair: "ru-de", state_version: version, manual_selection_version: version,
  manual_selection: [], group: null, learning: { status: "new_group", ready: 0, preview: 0, next_due_at: null,
    new_group_size: 2, manual_eligible: 0, automatic_eligible: 2 } });
const fact = (status = "applied") => ({ id: id(100), kind: "learning.select", status, applied_at: "2026-10-01T00:00:00Z",
  target_id: id(4), action_id: null, result_id: null, context_id: null, object_version: big });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const denial = (status: number) => response({ error: { code: status === 401 ? "UNAUTHORIZED" : "ACCESS_DENIED" } }, status);
const ok: Record<Path, () => Response> = {
  get: () => response(current()),
  change: () => response({ command: fact(), current: current(), state_version: big }),
  status: () => response({ command: fact("already_applied"), current: current(), state_version: big }),
};
type Path = "get" | "change" | "status";
const call = (api: LearningApi, path: Path, token = "argument-token", proof = "argument-proof") =>
  path === "get" ? api.get(token) : path === "change" ? api.change(token, proof, command()) : readWithTicket(intent(), (__command, __ticket) => api.status(token, __command, __ticket));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function fixture() {
  let active: OpenedAccess | null = null, serial = 0, current = true;
  const denied = vi.fn();
  const access = (patch: Partial<OpenedClient> = {}) => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened: { ...opened, ...patch }, token: `synthetic-manual-token-${++serial}`,
      proof: `synthetic-manual-proof-${serial}`, generation: 1, isLive: () => active === bound,
      onDenied: error => { denied(error); if (active === bound) active = null; } });
    active = bound; return bound;
  };
  const fetcher = vi.fn<typeof fetch>();
  const raw = createLearningApi({ fetcher, timeoutMs: 5000, maxResponseBytes: 100000, gate: testGate() });
  const first = access();
  const api = accessBoundLearningApi({ access: first, api: raw, isCurrent: () => current });
  return { access, first, fetcher, raw, api, denied, stale: () => { current = false; } };
}
const headers = (f: ReturnType<typeof fixture>, n = -1) => f.fetcher.mock.calls.at(n)![1]!.headers as Record<string, string>;

describe("access-bound Learning API with real OpenedAccess and Learning transport", () => {
  it("takes credentials only from the access handle; marker and argument credentials never reach fetch", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(ok.get()).mockResolvedValueOnce(ok.change()).mockResolvedValueOnce(ok.status());
    await expect(f.api.get(ACCESS_BOUND_MARKER)).resolves.toEqual(current());
    await expect(f.api.change(ACCESS_BOUND_MARKER, ACCESS_BOUND_MARKER, command())).resolves.toMatchObject({ outcome: "accepted", state_version: big });
    await expect(readWithTicket(intent(), (__command, __ticket) => f.api.status(ACCESS_BOUND_MARKER, __command, __ticket))).resolves.toMatchObject({ outcome: "accepted" });
    expect(f.fetcher.mock.calls.map(([url, init]) => [url, init!.method])).toEqual([
      ["/api/v1/learning/current", "GET"], ["/api/v1/commands", "POST"], [`/api/v1/commands/${id(100)}`, "GET"]]);
    expect(headers(f, 0)).toEqual(withTrace({ Authorization: "Bearer synthetic-manual-token-1" }));
    expect(headers(f, 1)).toMatchObject({ Authorization: "Bearer synthetic-manual-token-1", "X-Origin-Proof": "synthetic-manual-proof-1" });
    expect(headers(f, 2)).toEqual(withTrace({ Authorization: "Bearer synthetic-manual-token-1" }));
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]!.body))).toEqual(command());
    expect(JSON.stringify(f.fetcher.mock.calls)).not.toContain(ACCESS_BOUND_MARKER);
    expect(f.denied).not.toHaveBeenCalled();
  });

  it.each((["get", "change", "status"] as const).flatMap(path => [401, 403].map(status => ({ path, status }))))(
    "a current $status from $path revokes the document once; later calls send nothing", async ({ path, status }) => {
      const f = fixture(); f.fetcher.mockResolvedValueOnce(denial(status));
      const error = await call(f.api, path).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError); expect(error).toMatchObject({ kind: "http", status });
      expect(f.denied).toHaveBeenCalledTimes(1); expect(f.first.isLive()).toBe(false);
      await expect(call(f.api, path)).rejects.toBeInstanceOf(ClosedAccessError);
      expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.denied).toHaveBeenCalledTimes(1);
    });

  it("a business 403 rejection with its command envelope is an outcome, not a document denial", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(response({ command: { id: id(100), status: "rejected" }, error: { code: "CARD_NOT_ELIGIBLE" },
      current: current(), state_version: big }, 403));
    await expect(f.api.change("", "", command())).resolves.toMatchObject({ outcome: "rejected", error: { code: "CARD_NOT_ELIGIBLE" } });
    expect(f.denied).not.toHaveBeenCalled(); expect(f.first.isLive()).toBe(true);
  });

  it.each(["get", "change", "status"] as const)("an obsolete binding sends no %s at all", async path => {
    const f = fixture(); f.stale();
    await expect(call(f.api, path)).rejects.toBeInstanceOf(ClosedAccessError);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.denied).not.toHaveBeenCalled();
  });

  it.each((["get", "change", "status"] as const).flatMap(path => ["ok", "401", "403", "503"].map(outcome => ({ path, outcome }))))(
    "a late $outcome for $path after the binding was superseded neither publishes nor revokes", async ({ path, outcome }) => {
      const f = fixture(), held = deferred<Response>(); f.fetcher.mockReturnValueOnce(held.promise);
      const pending = call(f.api, path).catch((caught: unknown) => caught);
      await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
      f.stale(); held.resolve(outcome === "ok" ? ok[path]() : denial(Number(outcome)));
      expect(await pending).toBeInstanceOf(ClosedAccessError);
      expect(f.denied).not.toHaveBeenCalled(); expect(f.first.isLive()).toBe(true);
    });

  it.each([401, 403])("a late %s for a replaced access handle does not revoke its successor", async status => {
    const f = fixture(), held = deferred<Response>(); f.fetcher.mockReturnValueOnce(held.promise);
    const pending = f.api.get("").catch((caught: unknown) => caught);
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    const next = f.access(); expect(next.key).toBe(f.first.key);
    held.resolve(denial(status));
    expect(await pending).toBeInstanceOf(ClosedAccessError);
    expect(f.denied).not.toHaveBeenCalled(); expect(next.isLive()).toBe(true);
  });

  it.each([["document", { document_id: id(9) }], ["client", { client_instance_id: id(9) }]] as const)(
    "a command for another %s is not sent", async (_name, patch) => {
      const f = fixture();
      await expect(f.api.change("", "", command(patch))).rejects.toThrow("another document");
      expect(f.fetcher).not.toHaveBeenCalled(); expect(f.denied).not.toHaveBeenCalled();
    });

  it("derives the controller context from the access handle with marker credentials only", () => {
    const f = fixture();
    expect(accessBoundManualContext(f.first)).toEqual({ profileId: id(3), clientInstanceId: id(1), documentId: id(2), pair: "ru-de",
      token: ACCESS_BOUND_MARKER, proof: ACCESS_BOUND_MARKER });
    expect(JSON.stringify(accessBoundManualContext(f.first))).not.toContain("synthetic-manual");
    expect(manualPairOf(f.access({ profile: { ...opened.profile, dictionary_language: "uk" } }))).toBe("uk-de");
    expect(() => manualPairOf(f.access({ profile: { ...opened.profile, dictionary_language: "de" as "ru" } }))).toThrow("unknown dictionary pair");
  });
});

describe("accepted ManualSelectionController over the access-bound API", () => {
  function composed(f: ReturnType<typeof fixture>) {
    const values = new Map<string, string>();
    const storage: AsyncStorage = { get: async key => values.get(key) ?? null,
      set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } };
    const states: ManualSelectionSnapshot[] = [];
    const controller = new ManualSelectionController({ gate: testGate(), api: f.api, pendingStore: new ManualPendingStore(storage),
      context: accessBoundManualContext(f.first), newId: () => id(100), onUpdate: state => states.push(state) });
    return { controller, values, states };
  }

  it.each([401, 403])("a current %s on the opening read blocks the controller and revokes the document once", async status => {
    const f = fixture(), c = composed(f); f.fetcher.mockResolvedValueOnce(denial(status));
    await c.controller.refresh();
    expect(c.controller.snapshot()).toMatchObject({ phase: "blocked", data: null, canChange: false,
      problem: { reason: status === 401 ? "expired" : "forbidden" } });
    expect(f.denied).toHaveBeenCalledTimes(1);
  });

  it("persists before a POST that is denied; the intent stays for the next document and nothing leaks", async () => {
    const f = fixture(), c = composed(f);
    f.fetcher.mockResolvedValueOnce(ok.get()).mockImplementationOnce(async () => {
      expect(JSON.parse([...c.values.values()][0]).record).toEqual({ schemaVersion: 1, profileId: id(3), clientInstanceId: id(1), intent: intent() });
      return denial(401);
    });
    await c.controller.refresh(); await c.controller.change(id(4), true);
    expect(c.controller.snapshot()).toMatchObject({ phase: "unresolved", canRetry: false, problem: { reason: "expired" } });
    expect(f.denied).toHaveBeenCalledTimes(1); expect(c.values.size).toBe(1);
    expect(JSON.stringify([c.states, [...c.values.values()]])).not.toMatch(/synthetic-manual|access-bound/);
  });
});
