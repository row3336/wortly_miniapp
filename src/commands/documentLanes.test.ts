// The two durable lanes of one opened document (M-REFAC-CMD): one clock, closed sessions and access guards.
import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { DocumentLanes, type DocumentLane, type LaneWiring } from "./documentLanes";
import { testGate } from "./testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Action = { kind: "session.stop" | "item.mark"; session_id: string };
type State = { pending: boolean; phase: string; kind: string | null; outcome: string | null; sessionId: string | null;
  pendingIntent: null; resolved: { commandId: string; kind: string; sessionId: string } | null; problem: string | null;
  canRetry: boolean; current: { status: string; session_id?: string } | null; closedSession: null; stateVersion: string | null };
type Read = { state_version: string; current: { status: string; session_id: string } };
type ResultRead = { state_version: string; step: { status: string; session_id: string } };

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
/** A scripted lane: begin sends through the document guard and records what the document asked of it. */
function lane(wiring: LaneWiring<State>) {
  const state: State = { pending: false, phase: "idle", kind: null, outcome: null, sessionId: null, pendingIntent: null,
    resolved: null, problem: null, canRetry: false, current: null, closedSession: null, stateVersion: null };
  const lane = { wiring, state, gate: null as ReturnType<typeof deferred> | null,
    refresh: vi.fn(async () => { await lane.gate?.promise; }),
    begin: vi.fn(async (action: Action) => {
      state.pending = true; state.sessionId = action.session_id;
      await wiring.send(async credentials => credentials.token);
      await lane.gate?.promise;
      state.pending = false; state.phase = "settled"; state.outcome = "accepted";
      state.resolved = { commandId: id(100), kind: action.kind, sessionId: action.session_id }; wiring.onUpdate({ ...state });
    }),
    retry: vi.fn(async () => {}), dispose: vi.fn(), snapshot: () => ({ ...state }),
    // No kind of this scripted mode recovers automatically: these are never reached.
    prepare: vi.fn(() => new Error("manual mode")), start: vi.fn(async () => {}), resend: vi.fn(async () => {}),
    lastFailure: () => null, release: vi.fn(async () => {}), releaseClosed: vi.fn(async () => {}) };
  return lane;
}
const profile = (version = "5"): Profile => ({ profile_id: id(1), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: version, access: { status: "admitted", version: "1", reason: null } });

function fixture(minimum?: () => string | null) {
  let access: OpenedAccess, live = true;
  const open = (token: string) => {
    const opened: OpenedClient = { status: "opened", client_instance_id: id(2), document_id: id(3), document_epoch: "1",
      proof_version: "1", profile: profile(), session: null, compatibility: { compatible: true, contract_version: "1" } };
    const handle: OpenedAccess = createOpenedAccess({ opened, token, proof: "proof", generation: 1,
      isLive: () => live && access === handle, onDenied: () => {} });
    access = handle;
  };
  open("token-1");
  const lanes: Partial<Record<DocumentLane, ReturnType<typeof lane>>> = {};
  const readSession = vi.fn(async (): Promise<Read> => ({ state_version: "6", current: { status: "active", session_id: id(9) } }));
  const readResult = vi.fn(async (): Promise<ResultRead> => ({ state_version: "6", step: { status: "active", session_id: id(9) } }));
  const owner = new DocumentLanes<State, Action, Read, ResultRead>({ access: () => access,
    transport: { fetcher: vi.fn(), timeoutMs: 1, maxResponseBytes: 1, gate: testGate() }, storage: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
    newId: () => id(100), minimumStateVersion: minimum, onUpdate: vi.fn() },
  { label: "test", readSession, readResult, controller: wiring => (lanes[wiring.lane] = lane(wiring)), automatic: [] });
  return { owner, lanes: lanes as Record<DocumentLane, ReturnType<typeof lane>>, readSession, readResult, open,
    revoke: () => { live = false; } };
}

describe("shared document lanes", () => {
  it("gives each lane the document identity and routes Stop to its own lane", async () => {
    const f = fixture();
    expect(f.lanes.primary.wiring).toMatchObject({ lane: "primary", profileId: id(1), clientInstanceId: id(2), pair: "ru-de", stateVersion: "5" });
    await f.owner.begin({ kind: "session.stop", session_id: id(9) });
    expect(f.lanes.stop.begin).toHaveBeenCalledOnce(); expect(f.lanes.primary.begin).not.toHaveBeenCalled();
    // An accepted Stop closes its session for every later command of this document.
    await f.owner.begin({ kind: "item.mark", session_id: id(9) });
    expect(f.lanes.primary.begin).not.toHaveBeenCalled();
  });
  it("blocks a study command while Stop is in flight, but not Stop while study is in flight", async () => {
    const f = fixture(); f.lanes.stop.gate = deferred();
    const stopping = f.owner.begin({ kind: "session.stop", session_id: id(9) });
    expect(f.owner.snapshot()).toMatchObject({ canBegin: false, canStop: false });
    await f.owner.begin({ kind: "item.mark", session_id: id(8) });
    expect(f.lanes.primary.begin).not.toHaveBeenCalled();
    f.lanes.stop.gate.resolve(); await stopping;
    f.lanes.primary.gate = deferred();
    const marking = f.owner.begin({ kind: "item.mark", session_id: id(8) });
    expect(f.owner.snapshot()).toMatchObject({ canBegin: false, canStop: true });
    f.lanes.primary.gate.resolve(); await marking;
  });
  it("sends only through the handle of the tap; a newer handle must recover by GET", async () => {
    const f = fixture(); f.lanes.primary.gate = deferred();
    vi.mocked(f.lanes.primary.begin).mockImplementationOnce(async () => {
      f.open("token-2");
      await expect(f.lanes.primary.wiring.send(async credentials => credentials.token)).rejects.toThrow("closed_access");
    });
    await f.owner.begin({ kind: "item.mark", session_id: id(8) });
    expect(await f.lanes.primary.wiring.run(async credentials => credentials.token)).toBe("token-2");
  });
  it("a read below the document floor is refused and a closed read closes its session", async () => {
    let floor: string | null = "7"; const f = fixture(() => floor);
    await expect(f.owner.readSession(id(9))).rejects.toMatchObject({ kind: "invalid_response" });
    floor = null;
    f.readSession.mockResolvedValueOnce({ state_version: "8", current: { status: "closed", session_id: id(9) } });
    await f.owner.readSession(id(9));
    expect(f.owner.snapshot().stateVersion).toBe("8");
    await f.owner.begin({ kind: "item.mark", session_id: id(9) });
    expect(f.lanes.primary.begin).not.toHaveBeenCalled();
    expect(() => fixture(() => "x").owner.snapshot()).toThrow("invalid shared test version");
  });
  it("a pending study command of a closed session is asked once by its ID, never replayed", async () => {
    const f = fixture();
    Object.assign(f.lanes.primary.state, { pending: true, phase: "unresolved", sessionId: id(9) });
    f.readResult.mockResolvedValueOnce({ state_version: "8", step: { status: "closed", session_id: id(9) } });
    await f.owner.readResult({ session_id: id(9), assignment_id: id(10), result_id: id(11) });
    await vi.waitFor(() => expect(f.lanes.primary.refresh).toHaveBeenCalledOnce());
    f.readSession.mockResolvedValueOnce({ state_version: "9", current: { status: "closed", session_id: id(9) } });
    await f.owner.readSession(id(9));
    expect(f.lanes.primary.refresh).toHaveBeenCalledOnce(); expect(f.lanes.primary.retry).not.toHaveBeenCalled();
  });
  it("a dead document starts nothing and disposes both lanes", async () => {
    const f = fixture(); f.revoke();
    await f.owner.begin({ kind: "item.mark", session_id: id(8) }); await f.owner.retry("primary"); await f.owner.refresh();
    expect(f.lanes.primary.begin).not.toHaveBeenCalled(); expect(f.lanes.primary.refresh).not.toHaveBeenCalled();
    expect(f.owner.snapshot()).toMatchObject({ live: false, canBegin: false, canStop: false });
    f.owner.dispose(); expect(f.lanes.primary.dispose).toHaveBeenCalledOnce(); expect(f.lanes.stop.dispose).toHaveBeenCalledOnce();
  });
});
