import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LearningSessionProjection, OpenedClient, SessionResponse } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { previewContent } from "../learning/learningPreview.test-support";
import { useSessionResumeDocument, type SessionResumeDocument } from "./useSessionResumeDocument";

type Options = Parameters<typeof useSessionResumeDocument>[0];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = (pair: LearningSessionProjection["pair"] = "ru-de"): LearningSessionProjection => ({ session_id: id(3), mode: "learning", status: "summary", pair,
  local_date: "2026-09-30", close_reason: null, group: { id: id(8), status: "active", version: "1", total: 2, preview_position: 2 },
  preview: null, assignment: null });
const written = (): SessionResponse["current"] => ({ session_id: id(3), mode: "written", status: "summary", pair: "ru-de",
  direction: "l1-de", local_date: "2026-09-30", bucket: "phrases", close_reason: null,
  progress: { completed: 1, total: 1, correct: 1, wrong: 0 }, assignment: null,
  summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } });
const preview = (): SessionResponse["current"] => ({ session_id: id(3), mode: "learning", status: "active", pair: "ru-de",
  local_date: "2026-09-30", close_reason: null, group: { id: id(8), status: "assembling", version: "1", total: 2, preview_position: 0 },
  preview: { id: id(9), card_id: id(7), position: 1, total: 2, content: previewContent(id(7)) }, assignment: null });
const closed = (): SessionResponse["current"] => ({ ...summary(), status: "closed", close_reason: "stop" });
const response = (current: SessionResponse["current"] = summary(), state_version = "3") =>
  new Response(JSON.stringify({ current, state_version }));
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(finish => { resolve = finish; });
  return { promise, resolve };
}
function fixture(initial: Partial<OpenedClient> = {}) {
  let access!: OpenedAccess, live = true;
  const base: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    session: { id: id(3), phase: "active" }, compatibility: { compatible: true, contract_version: "1" },
    profile: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC",
      state_version: "1", access: { status: "admitted", version: "1", reason: null } } };
  const replace = (change: Partial<OpenedClient> = {}, keepKey = false) => {
    const oldKey = access?.key;
    const actual = createOpenedAccess({ opened: { ...base, ...change }, token: "synthetic-token", proof: "synthetic-proof", generation: 1,
      isLive: () => live && access === next, onDenied: () => { live = false; } });
    const next = keepKey ? { ...actual, key: oldKey } : actual;
    access = next;
    return access;
  };
  replace(initial);
  return { access: () => access, replace, profile: base.profile, revoke: () => { live = false; } };
}
function setup(config: { initial?: Partial<OpenedClient>; enabled?: boolean; strict?: boolean;
  fetcher?: ReturnType<typeof vi.fn<typeof fetch>>; probe?: (document: SessionResumeDocument) => void } = {}) {
  const f = fixture(config.initial);
  const fetcher = config.fetcher ?? vi.fn<typeof fetch>(async () => response());
  const options: Options = { access: f.access(), transport: { fetcher, timeoutMs: 30000, maxResponseBytes: 50000 },
    enabled: config.enabled ?? true };
  const ui = renderHook((props: Options) => {
    const document = useSessionResumeDocument(props);
    config.probe?.(document);
    return document;
  }, { initialProps: options, reactStrictMode: config.strict });
  return { f, fetcher, options, ...ui };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("initial session mode document", () => {
  it.each([
    ["learning active", preview()], ["learning summary", summary()], ["written", written()], ["closed", closed()],
    ["unavailable", { session_id: id(3), status: "unavailable" }], ["not_found", { session_id: id(3), status: "not_found" }],
  ] as const)("returns addressed %s without interpreting navigation or starting study", async (_, current) => {
    const fetcher = vi.fn<typeof fetch>(async () => response(current));
    const { result } = setup({ fetcher });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: { current, state_version: "3" } }));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe(`/api/v1/sessions/${id(3)}?client_instance_id=${id(1)}&document_id=${id(2)}`);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
    expect(JSON.stringify(result.current.state)).not.toMatch(/synthetic|token|proof/);
  });

  it("null session is idle with no HTTP, including refresh", async () => {
    const { result, fetcher } = setup({ initial: { session: null } });
    expect(result.current.state).toEqual({ kind: "idle" });
    await act(() => result.current.refresh());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("same source rerenders and concurrent refresh share the pending read", async () => {
    const read = deferred(), fetcher = vi.fn<typeof fetch>(() => read.promise);
    const { result, rerender, options } = setup({ fetcher });
    const refresh = result.current.refresh;
    rerender({ ...options });
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = refresh(); second = refresh(); });
    expect(first).toBe(second); expect(fetcher).toHaveBeenCalledOnce();
    await act(async () => { read.resolve(response()); await first; });
    rerender({ ...options });
    expect(fetcher).toHaveBeenCalledOnce(); expect(result.current.refresh).toBe(refresh);
  });

  it("same-key foreground source masks ready before effects and ignores its late old response", async () => {
    let inspect = false;
    const { result, f, fetcher, options, rerender } = setup({ probe(document) {
      if (inspect) expect(document.state.kind).toBe("loading");
    } });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const old = deferred(), fresh = deferred();
    fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    let reading!: Promise<void>; act(() => { reading = result.current.refresh(); });
    const access = f.replace(); expect(access.key).toBe(options.access.key);
    inspect = true; rerender({ ...options, access }); inspect = false;
    await act(async () => { old.resolve(response(closed(), "8")); await reading; });
    expect(result.current.state.kind).toBe("loading");
    await act(async () => fresh.resolve(response(written(), "9")));
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "ready", data: { current: { mode: "written" } } }));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("a higher floor masks ready during render and supersedes an old pending read", async () => {
    let inspect = false;
    const { result, fetcher, options, rerender } = setup({ probe(document) {
      if (inspect) expect(document.state.kind).toBe("loading");
    } });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const old = deferred(), fresh = deferred();
    fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    let reading!: Promise<void>; act(() => { reading = result.current.refresh(); });
    inspect = true; rerender({ ...options, minimumStateVersion: "9" }); inspect = false;
    await act(async () => { old.resolve(response(closed(), "8")); await reading; });
    expect(result.current.state.kind).toBe("loading");
    await act(async () => fresh.resolve(response(summary(), "9")));
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "ready", data: { state_version: "9" } }));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("a changed floor can join an existing covered refresh without remaining masked", async () => {
    const { result, fetcher, options, rerender } = setup();
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const read = deferred(); fetcher.mockReturnValueOnce(read.promise);
    let pending!: Promise<void>; act(() => { pending = result.current.refresh(); });
    // The controller already observed version 3; this floor does not require another GET.
    rerender({ ...options, minimumStateVersion: "2" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { read.resolve(response(written(), "4")); await pending; });
    expect(result.current.state).toMatchObject({ kind: "ready", data: { current: { mode: "written" }, state_version: "4" } });
  });

  it("a new null-session source discards a previous in-flight mode read without another GET", async () => {
    const read = deferred(), fetcher = vi.fn<typeof fetch>(() => read.promise);
    const { result, f, options, rerender } = setup({ fetcher });
    rerender({ ...options, access: f.replace({ session: null }) });
    expect(result.current.state).toEqual({ kind: "idle" });
    await act(async () => read.resolve(response()));
    expect(result.current.state).toEqual({ kind: "idle" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a current reply below the floor and permits an explicit read retry", async () => {
    const { result, fetcher, options, rerender } = setup();
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    rerender({ ...options, minimumStateVersion: "9" });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "failed" }));
    fetcher.mockResolvedValueOnce(response(summary(), "9"));
    await act(() => result.current.refresh());
    expect(result.current.state).toMatchObject({ kind: "ready", data: { state_version: "9" } });
  });

  it("keeps the controller and its closed-session protection across access and ordinary version changes", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response(closed(), "3"));
    const { result, f, options, rerender } = setup({ fetcher });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    fetcher.mockResolvedValueOnce(response(summary(), "4"));
    const access = f.replace({ profile: { ...f.profile, state_version: "4" } });
    rerender({ ...options, access });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "failed" }));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("disabled never reads and enabling starts initial recovery", async () => {
    const { result, fetcher, options, rerender } = setup({ enabled: false });
    expect(result.current.state).toEqual({ kind: "idle" });
    await act(() => result.current.refresh()); expect(fetcher).not.toHaveBeenCalled();
    rerender({ ...options, enabled: true });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("disable masks ready before effects and prevents a late read from becoming ready after re-enable", async () => {
    let inspect = false;
    const { result, fetcher, options, rerender } = setup({ probe(document) {
      if (inspect) expect(document.state).toEqual({ kind: "idle" });
    } });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const old = deferred(), fresh = deferred();
    fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    let reading!: Promise<void>; act(() => { reading = result.current.refresh(); });
    inspect = true; rerender({ ...options, enabled: false }); inspect = false;
    await act(() => result.current.refresh()); expect(fetcher).toHaveBeenCalledTimes(2);
    rerender(options);
    await act(async () => { old.resolve(response(closed(), "8")); await reading; });
    expect(result.current.state.kind).toBe("loading");
    await act(async () => fresh.resolve(response(written(), "9")));
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "ready", data: { current: { mode: "written" } } }));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("StrictMode recreates a live owner and its disposed first read cannot publish", async () => {
    const old = deferred(), fresh = deferred();
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result } = setup({ fetcher, strict: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => old.resolve(response(closed(), "8")));
    expect(result.current.state.kind).toBe("loading");
    await act(async () => fresh.resolve(response(written(), "9")));
    await waitFor(() => expect(result.current.state).toMatchObject({ kind: "ready", data: { current: { mode: "written" } } }));
  });

  it("unmount prevents late publication and a retained refresh from reading", async () => {
    const old = deferred(), seen: string[] = [], fetcher = vi.fn<typeof fetch>(() => old.promise);
    const { result, unmount } = setup({ fetcher, probe: document => seen.push(document.state.kind) });
    const refresh = result.current.refresh; unmount();
    const count = seen.length;
    await act(async () => old.resolve(response()));
    await act(refresh);
    expect(seen).toHaveLength(count); expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["document", "profile", "pair", "transport"] as const)("replacement %s invalidates ready and late old reads", async change => {
    let inspect = false;
    const { result, f, fetcher, options, rerender } = setup({ probe(document) {
      if (inspect) expect(document.state.kind).toBe("loading");
    } });
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    const old = deferred(), fresh = deferred();
    fetcher.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    let reading!: Promise<void>; act(() => { reading = result.current.refresh(); });
    // Even a reused key must not retain a different document/profile/dictionary owner.
    const access = change === "document" ? f.replace({ document_id: id(99) }, true)
      : change === "profile" ? f.replace({ profile: { ...f.profile, profile_id: id(51) } }, true)
      : change === "pair" ? f.replace({ profile: { ...f.profile, dictionary_language: "uk" } }, true) : f.access();
    inspect = true;
    rerender({ ...options, access, transport: change === "transport" ? { ...options.transport } : options.transport });
    inspect = false;
    await act(async () => { old.resolve(response(closed(), "8")); await reading; });
    expect(result.current.state.kind).toBe("loading");
    const current = summary(change === "pair" ? "uk-de" : "ru-de");
    await act(async () => fresh.resolve(response(current, "9")));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", data: { current, state_version: "9" } }));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("a network failure remains failed until an explicit refresh succeeds", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(response());
    const { result } = setup({ fetcher });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "failed" }));
    await act(() => result.current.refresh());
    expect(result.current.state.kind).toBe("ready"); expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("revoked access removes ready and retained refresh cannot read", async () => {
    const { result, f, fetcher, rerender, options } = setup();
    await waitFor(() => expect(result.current.state.kind).toBe("ready"));
    f.revoke(); rerender(options);
    expect(result.current.state).toEqual({ kind: "disposed" });
    await act(() => result.current.refresh()); expect(fetcher).toHaveBeenCalledOnce();
  });
});
