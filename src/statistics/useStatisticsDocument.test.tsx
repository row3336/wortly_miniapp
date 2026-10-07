import { StrictMode, createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, StatisticsOverviewResponse } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { PracticeWeek } from "./practiceApi";
import { useStatisticsDocument, type StatisticsDocumentOptions } from "./useStatisticsDocument";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function data(week: PracticeWeek, state_version = "1", pair: StatisticsOverviewResponse["pair"] = "ru-de"): StatisticsOverviewResponse {
  const start = week === "current" ? "2026-09-28" : "2026-09-21";
  const end = week === "current" ? "2026-10-05" : "2026-09-28";
  return { state_version, pair, local_date: "2026-10-01", time_zone: "UTC",
    base: { total: 1, words: 1, phrases: 0, by_type: { noun: 1, verb: 0, phrase: 0, adjective: 0,
      pronoun: 0, adverb: 0, preposition: 0, conjunction: 0, particle: 0 } },
    ready: { words: { "l1-de": 1, "de-l1": 0 }, phrases: { "l1-de": 0, "de-l1": 0 } },
    learned: { words: 0, phrases: 0 }, not_started: { words: 0, phrases: 0 }, added: { words: 0, phrases: 0 },
    word_results: { last_wrong: 0, streaks: { one: 0, two: 0, three: 0, four: 0, five_plus: 0 } },
    practice: { state_version, pair, local_date: "2026-10-01", time_zone: "UTC", starts_at: `${start}T00:00:00Z`, ends_at: `${end}T00:00:00Z`,
      days: Array.from({ length: 7 }, (_, i) => ({ local_date: new Date(Date.parse(`${start}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10),
        words: 0, phrases: 0 })) } };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); }
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

function fixture(week: PracticeWeek = "current") {
  let active: OpenedAccess | null = null, serial = 0, version = "1", pair: StatisticsOverviewResponse["pair"] = "ru-de";
  const denied = vi.fn();
  const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(3), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "1",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  const access = (patch: Partial<OpenedClient> = {}) => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened: { ...opened, ...patch }, token: `synthetic-stat-token-${++serial}`, proof: "synthetic-stat-proof",
      generation: 1, isLive: () => active === bound, onDenied: error => { denied(error); if (active === bound) active = null; } });
    active = bound; return bound;
  };
  const handler: typeof fetch = async (url, init) => {
    const path = new URL(String(url), "https://model.invalid");
    expect(path.pathname).toBe("/api/v1/statistics/overview"); expect(init?.method).toBe("GET");
    expect([...path.searchParams.keys()]).toEqual(["week"]);
    return response(data(path.searchParams.get("week") as PracticeWeek, version, pair));
  };
  const fetcher = vi.fn<typeof fetch>(handler);
  const options: StatisticsDocumentOptions = { access: access(), transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000 }, week, enabled: true };
  return { options, opened, fetcher, handler, denied, access, revoke: () => { active = null; },
    set: (next: string, nextPair = pair) => { version = next; pair = nextPair; } };
}

describe("statistics React document with real read controller and API", () => {
  it("uses an explicit previous week, copies data and only manually refreshes the same source", async () => {
    const f = fixture("previous"), ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready"));
    expect(ui.result.current.state).toMatchObject({ week: "previous", data: data("previous") });
    expect(f.fetcher).toHaveBeenCalledTimes(1); const refresh = ui.result.current.refresh;
    ui.result.current.state.data!.base.words = 99; ui.rerender(f.options);
    expect(ui.result.current.state.data!.base.words).toBe(1); expect(ui.result.current.refresh).toBe(refresh);
    expect(JSON.stringify(ui.result.current.state)).not.toMatch(/synthetic-stat|token|proof/);
    f.set("2"); await act(refresh); expect(ui.result.current.state.data?.state_version).toBe("2");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("masks the old period before effects and ignores its late response", async () => {
    const f = fixture(), old = deferred<Response>(), fresh = deferred<Response>();
    f.fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const seen: (string | null)[] = [];
    const ui = renderHook((options: StatisticsDocumentOptions) => { const result = useStatisticsDocument(options); seen.push(result.state.data?.practice.starts_at ?? null); return result; }, { initialProps: f.options });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); seen.length = 0;
    ui.rerender({ ...f.options, week: "previous" }); expect(seen[0]).toBeNull();
    await act(async () => { fresh.resolve(response(data("previous", "3"))); });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready"));
    await act(async () => { old.resolve(response(data("current", "9"))); });
    expect(ui.result.current.state).toMatchObject({ week: "previous", data: data("previous", "3") });
  });
  it.each([401, 403])("late old access %s cannot revoke the replacement or publish its data", async status => {
    const f = fixture(), hold = deferred<Response>(); f.fetcher.mockReturnValueOnce(hold.promise);
    const ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); const refresh = ui.result.current.refresh;
    f.set("2"); ui.rerender({ ...f.options, access: f.access() });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready"));
    await act(async () => { hold.resolve(response({ error: { code: "ACCESS_DENIED" } }, status)); });
    expect(f.denied).not.toHaveBeenCalled(); expect(ui.result.current.state.data?.state_version).toBe("2");
    await act(refresh); const headers = f.fetcher.mock.calls.at(-1)![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer synthetic-stat-token-2");
  });
  it.each([401, 403].flatMap(status => ["transport", "week", "refresh"].map(change => ({ status, change }))))(
    "late $status after $change preserves the same live access and newer data", async ({ status, change }) => {
      const f = fixture(), ui = renderHook(useStatisticsDocument, { initialProps: f.options });
      await waitFor(() => expect(ui.result.current.state.phase).toBe("ready"));
      const old = deferred<Response>(); f.fetcher.mockReturnValueOnce(old.promise);
      let pending!: Promise<void>; act(() => { pending = ui.result.current.refresh(); });
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
      f.set("3");
      const current = change === "transport" ? { ...f.options, transport: { ...f.options.transport } }
        : change === "week" ? { ...f.options, week: "previous" as const } : f.options;
      if (change === "refresh") await act(ui.result.current.refresh);
      else ui.rerender(current);
      await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "ready", data: { state_version: "3" } }));
      await act(async () => { old.resolve(response({ error: { code: "ACCESS_DENIED" } }, status)); await pending; });
      ui.rerender(current);
      expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
      expect(ui.result.current.state).toMatchObject({ phase: "ready", week: current.week, data: { state_version: "3" } });
      expect(f.fetcher).toHaveBeenCalledTimes(3);
    });
  it.each([401, 403])("current %s still revokes access and prevents further reads", async status => {
    const f = fixture(), ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready"));
    f.fetcher.mockResolvedValueOnce(response({ error: { code: "ACCESS_DENIED" } }, status));
    await act(ui.result.current.refresh); ui.rerender(f.options);
    expect(f.denied).toHaveBeenCalledTimes(1); expect(f.options.access.isLive()).toBe(false);
    expect(ui.result.current.state).toMatchObject({ phase: "disposed", data: null });
    await act(ui.result.current.refresh); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it("retains BigInt floor across render masking, week and same-identity access replacement", async () => {
    const f = fixture(); f.set("9007199254740993"); const seen: (string | null)[] = [];
    const ui = renderHook((options: StatisticsDocumentOptions) => { const result = useStatisticsDocument(options); seen.push(result.state.data?.state_version ?? null); return result; }, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready")); seen.length = 0;
    ui.rerender({ ...f.options, minimumStateVersion: "9007199254740994" }); expect(seen.every(item => item === null)).toBe(true);
    await waitFor(() => expect(ui.result.current.state.problem).toBe("stale_response"));
    ui.rerender({ ...f.options, week: "previous", access: f.access() });
    await waitFor(() => expect(ui.result.current.state.problem).toBe("stale_response")); expect(ui.result.current.state.data).toBeNull();
    f.set("9007199254740994"); await act(ui.result.current.refresh); expect(ui.result.current.state.phase).toBe("ready");
  });
  it("a different full document identity gets its own pair and floor", async () => {
    const f = fixture(); f.set("99"); const ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready")); f.set("1", "en-de");
    const access = f.access({ document_id: id(20), document_epoch: "2", profile: { ...f.opened.profile, dictionary_language: "en" } });
    ui.rerender({ ...f.options, access });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "ready", data: { pair: "en-de", state_version: "1" } }));
  });
  it("disabled render masks in-flight data, never reads, and remembers an observed floor", async () => {
    const f = fixture(), hold = deferred<Response>(); f.fetcher.mockReturnValueOnce(hold.promise);
    const ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); const refresh = ui.result.current.refresh;
    ui.rerender({ ...f.options, enabled: false, minimumStateVersion: "8" });
    await act(async () => { hold.resolve(response(data("current", "7"))); await refresh(); });
    expect(ui.result.current.state).toMatchObject({ phase: "idle", data: null }); expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.set("7"); ui.rerender(f.options);
    await waitFor(() => expect(ui.result.current.state.problem).toBe("stale_response"));
    f.revoke(); ui.rerender(f.options); expect(ui.result.current.state).toMatchObject({ phase: "disposed", data: null });
    await act(refresh); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it.each(["visibilitychange", "pageshow"])("%s masks data synchronously and a week change cannot bypass fresh-access recovery", async event => {
    const f = fixture(), ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready")); const calls = f.fetcher.mock.calls.length;
    act(() => { if (event === "visibilitychange") { visible("hidden"); document.dispatchEvent(new Event(event)); } else window.dispatchEvent(new Event(event)); });
    expect(ui.result.current.state.data).toBeNull(); visible("visible");
    ui.rerender({ ...f.options, week: "previous" }); await act(ui.result.current.refresh);
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(ui.result.current.state.data).toBeNull();
    ui.rerender({ ...f.options, week: "previous", access: f.access() });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "ready", week: "previous" }));
  });
  it("access supplied while hidden still requires another foreground access", async () => {
    const f = fixture(), ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state.phase).toBe("ready")); visible("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    const hidden = f.access(); ui.rerender({ ...f.options, access: hidden }); const calls = f.fetcher.mock.calls.length;
    visible("visible"); act(() => document.dispatchEvent(new Event("visibilitychange"))); await act(ui.result.current.refresh);
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(ui.result.current.state.data).toBeNull();
    ui.rerender({ ...f.options, access: f.access() }); await waitFor(() => expect(ui.result.current.state.phase).toBe("ready"));
  });
  it("StrictMode removes every listener and unmounted refresh cannot send or publish", async () => {
    const f = fixture(), hold = deferred<Response>(); f.fetcher.mockImplementation(async () => hold.promise);
    const add = vi.spyOn(document, "addEventListener"), remove = vi.spyOn(document, "removeEventListener");
    const addWindow = vi.spyOn(window, "addEventListener"), removeWindow = vi.spyOn(window, "removeEventListener");
    const ui = renderHook(useStatisticsDocument, { initialProps: f.options,
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) });
    await waitFor(() => expect(f.fetcher.mock.calls.length).toBeGreaterThan(0)); const refresh = ui.result.current.refresh; ui.unmount();
    for (const call of add.mock.calls.filter(v => v[0] === "visibilitychange")) expect(remove.mock.calls).toContainEqual(call);
    for (const call of addWindow.mock.calls.filter(v => v[0] === "pageshow")) expect(removeWindow.mock.calls).toContainEqual(call);
    const calls = f.fetcher.mock.calls.length;
    await act(async () => { hold.resolve(response(data("current"))); await refresh(); }); expect(f.fetcher).toHaveBeenCalledTimes(calls);
  });
  it("a transient error gives explicit retry with no automatic request loop", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(response({ error: { code: "UNAVAILABLE" } }, 503));
    const ui = renderHook(useStatisticsDocument, { initialProps: f.options });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "failed", problem: "load", data: null }));
    expect(f.fetcher).toHaveBeenCalledTimes(1); await act(ui.result.current.refresh);
    expect(ui.result.current.state.phase).toBe("ready"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
});
