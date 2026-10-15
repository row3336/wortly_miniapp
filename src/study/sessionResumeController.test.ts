import { previewContent } from "../learning/learningPreview.test-support";
import { describe, expect, it, vi } from "vitest";
import type { OpenedClient, SessionProjection } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { SessionResumeController, type SessionResumeState } from "./sessionResumeController";
import { testGate } from "../commands/testGate.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const written = (): SessionProjection => ({ session_id: id(3), mode: "written", status: "summary", pair: "ru-de",
  direction: "l1-de", local_date: "2026-09-30", bucket: "phrases", close_reason: null,
  progress: { completed: 1, total: 1, correct: 1, wrong: 0 }, assignment: null,
  summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } });
const response = (current: unknown = written(), version = "3") => new Response(JSON.stringify({ current, state_version: version }));
function deferred() { let finish!: (value: Response) => void; const promise = new Promise<Response>(resolve => { finish = resolve; }); return { promise, finish }; }
function fixture() {
  let current: OpenedAccess, live = true, minimum = "1";
  const denied = vi.fn(() => { live = false; });
  const replace = (change: Partial<OpenedClient> = {}, token = "synthetic-token") => {
    const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
      session: { id: id(3), phase: "active" }, compatibility: { compatible: true, contract_version: "1" },
      profile: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
        state_version: "1", access: { status: "admitted", version: "1", reason: null } }, ...change };
    const access: OpenedAccess = createOpenedAccess({ opened, token, proof: "synthetic-proof", generation: 1,
      isLive: () => live && access === current, onDenied: denied });
    current = access;
  };
  replace();
  const fetcher = vi.fn<typeof fetch>(async () => response()), onUpdate = vi.fn<(state: SessionResumeState) => void>();
  const owner = new SessionResumeController({ access: () => current,
    transport: { fetcher, timeoutMs: 500, maxResponseBytes: 20000, gate: testGate() }, minimumStateVersion: () => minimum, onUpdate });
  return { fetcher, owner, onUpdate, replace, denied, access: () => current, revoke: () => { live = false; }, floor: (value: string) => { minimum = value; } };
}

describe("session resume through live opened access", () => {
  it.each([false, true])("a newer settings floor replaces an in-flight same-handle resume (old closed=%s)", async closed => {
    const f = fixture(), wait = deferred(); f.fetcher.mockReturnValueOnce(wait.promise);
    const old = f.owner.refresh(); f.floor("9");
    f.fetcher.mockResolvedValueOnce(response(written(), "9"));
    const latest = f.owner.refresh(); expect(latest).not.toBe(old);
    await latest; expect(f.owner.snapshot()).toEqual({ kind: "ready", data: { current: written(), state_version: "9" } });
    wait.finish(response(closed ? { ...written(), status: "closed", close_reason: "stop" } : written(), "8")); await old;
    expect(f.owner.snapshot()).toEqual({ kind: "ready", data: { current: written(), state_version: "9" } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("a loading subscriber can advance the shared floor and start the authoritative resume", async () => {
    const f = fixture(), wait = deferred();
    f.fetcher.mockReturnValueOnce(wait.promise).mockResolvedValueOnce(response(written(), "9"));
    let raised = false, latest: Promise<void> | null = null;
    f.onUpdate.mockImplementation(state => {
      if (state.kind === "loading" && !raised) { raised = true; f.floor("9"); latest = f.owner.refresh(); }
    });
    const old = f.owner.refresh(); await vi.waitFor(() => expect(f.owner.snapshot().kind).toBe("ready"));
    wait.finish(response(written(), "8")); await old; await latest;
    expect(f.owner.snapshot()).toEqual({ kind: "ready", data: { current: written(), state_version: "9" } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("resolves stored written mode using a single GET and no new session or presentation", async () => {
    const f = fixture(); await f.owner.refresh();
    expect(f.owner.snapshot()).toEqual({ kind: "ready", data: { current: written(), state_version: "3" } });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", headers: {
      Authorization: "Bearer synthetic-token", "X-Origin-Proof": "synthetic-proof" } });
    expect(f.fetcher.mock.calls[0][1]?.body).toBeUndefined();
    expect(JSON.stringify(f.owner.snapshot())).not.toMatch(/synthetic|proof|token/);
  });
  it("resolves Learning preview from its own server projection", async () => {
    const f = fixture(); const current = { session_id: id(3), mode: "learning", status: "active", pair: "ru-de",
      local_date: "2026-09-30", close_reason: null, group: { id: id(8), status: "assembling", version: "1", total: 2, preview_position: 0 },
      preview: { id: id(9), card_id: id(7), position: 1, total: 2, content: previewContent(id(7)) }, assignment: null };
    f.fetcher.mockResolvedValueOnce(response(current)); await f.owner.refresh();
    expect(f.owner.snapshot()).toMatchObject({ kind: "ready", data: { current } });
  });
  it("does not start or read a session when none is open", async () => {
    const f = fixture(); f.replace({ session: null }); await f.owner.refresh();
    expect(f.owner.snapshot()).toEqual({ kind: "idle" }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("coalesces refresh for the same live source while it is pending", async () => {
    const f = fixture(), wait = deferred(); f.fetcher.mockReturnValueOnce(wait.promise);
    const first = f.owner.refresh(), second = f.owner.refresh();
    expect(second).toBe(first); expect(f.fetcher).toHaveBeenCalledOnce();
    wait.finish(response()); await first;
  });
  it.each([false, true])("a late old-handle response cannot overwrite newer foreground data (refusal=%s)", async refused => {
    const f = fixture(), wait = deferred(); f.fetcher.mockReturnValueOnce(wait.promise);
    const first = f.owner.refresh(); f.replace({}, "synthetic-new-token");
    f.fetcher.mockResolvedValueOnce(response(written(), "5")); await f.owner.refresh();
    const before = f.owner.snapshot(), calls = f.onUpdate.mock.calls.length;
    wait.finish(refused ? new Response("{}", { status: 403 }) : response(written(), "4")); await first;
    expect(f.owner.snapshot()).toEqual(before); expect(f.onUpdate).toHaveBeenCalledTimes(calls);
    expect(f.denied).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls[1][1]?.headers).toMatchObject({ Authorization: "Bearer synthetic-new-token" });
  });
  it("an old session response cannot replace the latest opened session", async () => {
    const f = fixture(), wait = deferred(); f.fetcher.mockReturnValueOnce(wait.promise);
    const first = f.owner.refresh(); f.replace({ session: { id: id(30), phase: "summary" } });
    f.fetcher.mockResolvedValueOnce(response({ ...written(), session_id: id(30) }, "4")); await f.owner.refresh();
    wait.finish(response()); await first;
    expect(f.owner.snapshot()).toMatchObject({ kind: "ready", data: { current: { session_id: id(30) } } });
  });
  it("replacing foreground access hides old data before the next refresh", async () => {
    const f = fixture(); await f.owner.refresh(); f.replace();
    expect(f.owner.snapshot()).toEqual({ kind: "loading" });
    await f.owner.refresh(); expect(f.owner.snapshot()).toMatchObject({ kind: "ready" });
  });
  it("opening with no session invalidates a still-running read", async () => {
    const f = fixture(), wait = deferred(); f.fetcher.mockReturnValueOnce(wait.promise);
    const first = f.owner.refresh(); f.replace({ session: null }); await f.owner.refresh();
    wait.finish(response()); await first; expect(f.owner.snapshot()).toEqual({ kind: "idle" });
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(["profile", "commands", "prior_read"])("refuses a response older than the %s state", async source => {
    const f = fixture();
    if (source === "profile") f.replace({ profile: { ...f.access().profile, state_version: "5" } });
    if (source === "commands") f.floor("5");
    if (source === "prior_read") { f.fetcher.mockResolvedValueOnce(response(written(), "5")); await f.owner.refresh(); }
    await f.owner.refresh(); expect(f.owner.snapshot()).toEqual({ kind: "failed" });
  });
  it("checks the command floor again after the read was sent, and hides an older snapshot", async () => {
    const f = fixture(); await f.owner.refresh(); f.floor("4");
    expect(f.owner.snapshot()).toEqual({ kind: "loading" });
    const wait = deferred(); f.fetcher.mockReturnValueOnce(wait.promise); const refresh = f.owner.refresh();
    f.floor("6"); wait.finish(response(written(), "5")); await refresh;
    expect(f.owner.snapshot()).toEqual({ kind: "failed" });
  });
  it("does not reopen an observed closed session even if a later projection claims a higher version", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(response({ ...written(), status: "closed", close_reason: "remote_stop" }));
    await f.owner.refresh(); f.fetcher.mockResolvedValueOnce(response(written(), "4")); await f.owner.refresh();
    expect(f.owner.snapshot()).toEqual({ kind: "failed" });
  });
  it.each(["summary", "closed"] as const)("only final closure may describe the old language pair: %s", async status => {
    const f = fixture(); f.replace({ profile: { ...f.access().profile, dictionary_language: "uk" } });
    f.fetcher.mockResolvedValueOnce(response({ ...written(), status, close_reason: status === "closed" ? "pair_changed" : null }));
    await f.owner.refresh(); expect(f.owner.snapshot().kind).toBe(status === "closed" ? "ready" : "failed");
  });
  it.each(["unavailable", "not_found"])("preserves %s without inventing a mode or completion", async status => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(response({ session_id: id(3), status })); await f.owner.refresh();
    expect(f.owner.snapshot()).toEqual({ kind: "ready", data: { current: { session_id: id(3), status }, state_version: "3" } });
  });
  it.each(["dispose", "revoke", "profile", "document", "refused_profile"])("clears visibility and ignores late data after %s", async reason => {
    const f = fixture(), wait = deferred(); f.fetcher.mockReturnValueOnce(wait.promise); const work = f.owner.refresh();
    if (reason === "dispose") f.owner.dispose();
    if (reason === "revoke") f.revoke();
    if (reason === "profile") f.replace({ profile: { ...f.access().profile, profile_id: id(99) } });
    if (reason === "document") f.replace({ document_id: id(99) });
    if (reason === "refused_profile") f.replace({ profile: { ...f.access().profile, access: { status: "rejected", version: "2", reason: null } } });
    const count = f.onUpdate.mock.calls.length; wait.finish(response()); await work;
    expect(f.owner.snapshot()).toEqual({ kind: "disposed" }); expect(f.onUpdate).toHaveBeenCalledTimes(count);
    await f.owner.refresh(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each([401, 403])("current HTTP%s revokes access through the original owner", async status => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(new Response("{}", { status })); await f.owner.refresh();
    expect(f.denied).toHaveBeenCalledOnce(); expect(f.owner.snapshot()).toEqual({ kind: "disposed" });
  });
  it("retains no private data from a caller-mutated snapshot", async () => {
    const f = fixture(); await f.owner.refresh(); const view = f.owner.snapshot();
    if (view.kind !== "ready") throw new Error("not ready"); view.data.current.session_id = id(99);
    expect(f.owner.snapshot()).toMatchObject({ kind: "ready", data: { current: { session_id: id(3) } } });
  });
});
