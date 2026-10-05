import { StrictMode, createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardViewResponse, OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import type { DictionaryCardSnapshot } from "./dictionaryCardController";
import { useDictionaryCardDocument, type DictionaryCardDocumentOptions } from "./useDictionaryCardDocument";

type Pair = "ru-de" | "uk-de" | "en-de";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(11), B = id(12);
function view(cardId: string, state_version = "1", pair: Pair = "ru-de"): DictionaryCardViewResponse {
  return { state_version, current: {
    status: "available",
    content: {
      pair, card: { id: cardId, revision: "1", lemma: "Haus", type: "noun", cefr: "A1" },
      translations: { common: ["дом"], personal: null }, grammar: null,
      reference_conjugations: [], examples: { common: [], personal: null }, association: null, hint: null,
    },
    study: {
      status: "available", card_id: cardId, card_revision: "1", pair, card_type: "noun", local_date: "2026-10-01",
      facts: {
        common_translation_present: true, exclusion: { excluded: false, version: null },
        manual: { selected: false, selection_version: "1" },
        learning: { ever_selected: false, finished_or_skipped: false, current: null }, non_learning_history: false,
      },
      directions: (["l1-de", "de-l1"] as const).map(direction => ({
        direction, introduced: false, progress_present: false, progress_version: null, schedule: null, interval_preview: null,
      })),
    },
  } };
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const denial = (status: number) => response({ error: { code: "ACCESS_DENIED" } }, status);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); }
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

function fixture(cardId = A) {
  let active: OpenedAccess | null = null, serial = 0, version = "1", pair: Pair = "ru-de", gone = false;
  const denied = vi.fn();
  const opened: OpenedClient = { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(3), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "1",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  const access = (patch: Partial<OpenedClient> = {}) => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened: { ...opened, ...patch }, token: `synthetic-card-token-${++serial}`, proof: "synthetic-card-proof",
      generation: 1, isLive: () => active === bound, onDenied: error => { denied(error); if (active === bound) active = null; } });
    active = bound; return bound;
  };
  const handler: typeof fetch = async (url, init) => {
    const match = /^\/api\/v1\/dictionary\/cards\/([0-9a-f-]{36})\/view$/.exec(new URL(String(url), "https://model.invalid").pathname);
    expect(match).not.toBeNull(); expect(init?.method).toBe("GET"); expect(init?.body).toBeUndefined();
    return response(gone ? { state_version: version, current: { status: "unavailable" } } : view(match![1], version, pair));
  };
  const fetcher = vi.fn<typeof fetch>(handler);
  const options: DictionaryCardDocumentOptions = { access: access(), transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000 }, cardId, enabled: true };
  return { options, opened, fetcher, denied, access, revoke: () => { active = null; },
    set: (next: string, nextPair = pair) => { version = next; pair = nextPair; }, remove: () => { gone = true; } };
}
function observed(f: ReturnType<typeof fixture>, strict = false) {
  const seen: DictionaryCardSnapshot[] = [];
  const ui = renderHook((options: DictionaryCardDocumentOptions) => {
    const result = useDictionaryCardDocument(options); seen.push(result.state); return result;
  }, { initialProps: f.options,
    wrapper: strict ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) : undefined });
  return { ui, seen };
}
const ready = (ui: ReturnType<typeof observed>["ui"]) => waitFor(() => expect(ui.result.current.state.phase).toBe("ready"));
const lastAuthorization = (f: ReturnType<typeof fixture>) => (f.fetcher.mock.calls.at(-1)![1]!.headers as Record<string, string>).Authorization;

describe("dictionary card React document with real access, controller and view API", () => {
  it("opens loading then ready for the exact card and pair, detached and without credentials", async () => {
    const f = fixture(), { ui, seen } = observed(f);
    expect(seen[0]).toEqual({ phase: "loading", cardId: A, pair: null, data: null, problem: null });
    await ready(ui);
    expect(ui.result.current.state).toEqual({ phase: "ready", cardId: A, pair: "ru-de", data: view(A), problem: null });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(String(f.fetcher.mock.calls[0][0])).toBe(`/api/v1/dictionary/cards/${A}/view`);
    expect(JSON.stringify(seen)).not.toMatch(/synthetic-card|token|proof/);
    const refresh = ui.result.current.refresh;
    ui.result.current.state.cardId = B; ui.result.current.state.data!.state_version = "99"; ui.rerender(f.options);
    expect(ui.result.current.state).toMatchObject({ cardId: A, data: { state_version: "1" } });
    expect(ui.result.current.refresh).toBe(refresh);
    f.set("2"); await act(refresh);
    expect(ui.result.current.state).toMatchObject({ phase: "ready", cardId: A, data: { state_version: "2" } });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it("shows an unavailable record as its own phase, without content and distinct from failure", async () => {
    const f = fixture(); f.remove(); f.set("3");
    const { ui } = observed(f);
    await waitFor(() => expect(ui.result.current.state.phase).toBe("unavailable"));
    expect(ui.result.current.state).toEqual({ phase: "unavailable", cardId: A, pair: "ru-de",
      data: { state_version: "3", current: { status: "unavailable" } }, problem: null });
  });

  it("a reply for another pair after a server-side language change is pair_changed with no content", async () => {
    const f = fixture(); f.set("2", "en-de");
    const { ui } = observed(f);
    await waitFor(() => expect(ui.result.current.state).toEqual({ phase: "failed", cardId: A, pair: "ru-de", data: null, problem: "pair_changed" }));
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it("never shows another card returned for the requested ID", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(response(view(B)));
    const { ui, seen } = observed(f);
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "failed", cardId: A, data: null, problem: "load" }));
    expect(JSON.stringify(seen)).not.toContain(B);
  });

  it.each(["ready", "503", "401", "403"])("a card change masks the old card in the same render; its late %s neither publishes nor revokes", async outcome => {
    const f = fixture(), { ui, seen } = observed(f);
    await ready(ui);
    const old = deferred<Response>(); f.fetcher.mockReturnValueOnce(old.promise);
    let pending!: Promise<void>; act(() => { pending = ui.result.current.refresh(); });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    seen.length = 0; ui.rerender({ ...f.options, cardId: B });
    expect(seen[0]).toEqual({ phase: "loading", cardId: B, pair: null, data: null, problem: null });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "ready", cardId: B }));
    await act(async () => { old.resolve(outcome === "ready" ? response(view(A, "9")) : denial(Number(outcome))); await pending; });
    expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
    expect(ui.result.current.state).toEqual({ phase: "ready", cardId: B, pair: "ru-de", data: view(B), problem: null });
    expect(seen.some(state => state.cardId === A || state.data?.state_version === "9")).toBe(false);
    await act(ui.result.current.refresh);
    expect(ui.result.current.state).toMatchObject({ phase: "ready", cardId: B, data: { state_version: "1" } });
    expect(lastAuthorization(f)).toBe("Bearer synthetic-card-token-1");
  });

  it.each([401, 403].flatMap(status => ["transport", "refresh"].map(change => ({ status, change }))))(
    "late $status after $change preserves the same live access and newer data", async ({ status, change }) => {
      const f = fixture(), { ui } = observed(f);
      await ready(ui);
      const old = deferred<Response>(); f.fetcher.mockReturnValueOnce(old.promise);
      let pending!: Promise<void>; act(() => { pending = ui.result.current.refresh(); });
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
      f.set("3");
      const current = change === "transport" ? { ...f.options, transport: { ...f.options.transport } } : f.options;
      if (change === "refresh") await act(ui.result.current.refresh); else ui.rerender(current);
      await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "ready", data: { state_version: "3" } }));
      await act(async () => { old.resolve(denial(status)); await pending; });
      ui.rerender(current);
      expect(f.denied).not.toHaveBeenCalled(); expect(f.options.access.isLive()).toBe(true);
      expect(ui.result.current.state).toMatchObject({ phase: "ready", cardId: A, data: { state_version: "3" } });
      expect(f.fetcher).toHaveBeenCalledTimes(3);
    });

  it.each([401, 403])("a current %s revokes access once and blocks later reads", async status => {
    const f = fixture(), { ui } = observed(f);
    await ready(ui);
    f.fetcher.mockResolvedValueOnce(denial(status));
    await act(ui.result.current.refresh); ui.rerender(f.options);
    expect(f.denied).toHaveBeenCalledTimes(1); expect(f.options.access.isLive()).toBe(false);
    expect(ui.result.current.state).toMatchObject({ phase: "disposed", data: null });
    await act(ui.result.current.refresh); ui.rerender({ ...f.options, cardId: B }); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.denied).toHaveBeenCalledTimes(1);
    expect(ui.result.current.state).toMatchObject({ phase: "disposed", cardId: B, data: null });
  });

  it("a raised minimum masks data in the same render, reads once, stays stale without retry, and refresh recovers", async () => {
    const f = fixture(); f.set("9007199254740993");
    const { ui, seen } = observed(f);
    await ready(ui); seen.length = 0;
    ui.rerender({ ...f.options, minimumStateVersion: "9007199254740994" });
    expect(seen[0].data).toBeNull();
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "failed", data: null, problem: "stale_response" }));
    await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(seen.every(state => state.data === null)).toBe(true);
    f.set("9007199254740994"); await act(ui.result.current.refresh);
    expect(ui.result.current.state).toMatchObject({ phase: "ready", data: { state_version: "9007199254740994" } });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("the profile version is a floor, retained across cards and same-identity access replacement", async () => {
    const f = fixture(), profile = { ...f.opened.profile, state_version: "5" };
    f.set("4"); const options = { ...f.options, access: f.access({ profile }) };
    const ui = renderHook(useDictionaryCardDocument, { initialProps: options });
    await waitFor(() => expect(ui.result.current.state.problem).toBe("stale_response"));
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.set("6"); await act(ui.result.current.refresh); expect(ui.result.current.state.phase).toBe("ready");
    f.set("5"); ui.rerender({ ...options, cardId: B, access: f.access({ profile }) });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ cardId: B, problem: "stale_response", data: null }));
  });

  it("a different full document identity gets its own pair and floor and hides the old card", async () => {
    const f = fixture(); f.set("99");
    const { ui, seen } = observed(f);
    await ready(ui); f.set("1", "en-de"); seen.length = 0;
    const access = f.access({ document_id: id(20), document_epoch: "2", profile: { ...f.opened.profile, dictionary_language: "en" } });
    ui.rerender({ ...f.options, access });
    expect(seen[0].data).toBeNull();
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "ready", pair: "en-de", data: { state_version: "1" } }));
  });

  it.each(["visibilitychange", "pageshow"])("%s masks data synchronously; refresh and card change cannot bypass a fresh foreground access", async event => {
    const f = fixture(), { ui } = observed(f);
    await ready(ui); const calls = f.fetcher.mock.calls.length;
    act(() => { if (event === "visibilitychange") { visible("hidden"); document.dispatchEvent(new Event(event)); } else window.dispatchEvent(new Event(event)); });
    expect(ui.result.current.state.data).toBeNull(); visible("visible");
    ui.rerender({ ...f.options, cardId: B }); await act(ui.result.current.refresh); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(ui.result.current.state).toMatchObject({ cardId: B, data: null });
    ui.rerender({ ...f.options, cardId: B, access: f.access() });
    await waitFor(() => expect(ui.result.current.state).toMatchObject({ phase: "ready", cardId: B }));
    expect(lastAuthorization(f)).toBe("Bearer synthetic-card-token-2");
  });

  it("hidden before mount never reads; becoming visible still requires a new access", async () => {
    visible("hidden");
    const f = fixture(), { ui } = observed(f);
    await flush(); expect(f.fetcher).not.toHaveBeenCalled();
    visible("visible"); act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(ui.result.current.refresh); ui.rerender(f.options); await flush();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(ui.result.current.state.data).toBeNull();
    ui.rerender({ ...f.options, access: f.access() }); await ready(ui);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["disabled", (f: ReturnType<typeof fixture>) => ({ ...f.options, enabled: false }), "idle"],
    ["pending profile", (f: ReturnType<typeof fixture>) => ({ ...f.options, access: f.access({ profile: { ...f.opened.profile, access: { status: "pending", version: "2", reason: null } } }) }), "disposed"],
    ["revoked access", (f: ReturnType<typeof fixture>) => { const options = f.options; f.revoke(); return options; }, "disposed"],
  ] as const)("%s does not read", async (_name, make, phase) => {
    const f = fixture(), options = make(f);
    const ui = renderHook(useDictionaryCardDocument, { initialProps: options });
    await flush(); await act(ui.result.current.refresh); await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(ui.result.current.state).toEqual({ phase, cardId: A, pair: null, data: null, problem: null });
  });

  it("disabling masks in-flight data, never reads, and remembers an observed floor", async () => {
    const f = fixture(), hold = deferred<Response>(); f.fetcher.mockReturnValueOnce(hold.promise);
    const ui = renderHook(useDictionaryCardDocument, { initialProps: f.options });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1)); const refresh = ui.result.current.refresh;
    ui.rerender({ ...f.options, enabled: false, minimumStateVersion: "8" });
    await act(async () => { hold.resolve(response(view(A, "7"))); await refresh(); });
    expect(ui.result.current.state).toMatchObject({ phase: "idle", data: null }); expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.set("7"); ui.rerender(f.options);
    await waitFor(() => expect(ui.result.current.state.problem).toBe("stale_response"));
  });

  it("StrictMode removes every listener and an unmounted refresh cannot send or publish", async () => {
    const f = fixture(), hold = deferred<Response>(); f.fetcher.mockImplementation(async () => hold.promise);
    const add = vi.spyOn(document, "addEventListener"), remove = vi.spyOn(document, "removeEventListener");
    const addWindow = vi.spyOn(window, "addEventListener"), removeWindow = vi.spyOn(window, "removeEventListener");
    const { ui, seen } = observed(f, true);
    await waitFor(() => expect(f.fetcher.mock.calls.length).toBeGreaterThan(0));
    const refresh = ui.result.current.refresh; ui.unmount();
    for (const call of add.mock.calls.filter(v => v[0] === "visibilitychange")) expect(remove.mock.calls).toContainEqual(call);
    for (const call of addWindow.mock.calls.filter(v => v[0] === "pageshow")) expect(removeWindow.mock.calls).toContainEqual(call);
    const calls = f.fetcher.mock.calls.length, renders = seen.length;
    await act(async () => { hold.resolve(response(view(A))); await refresh(); });
    expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(seen).toHaveLength(renders);
    expect(seen.some(state => state.phase === "ready")).toBe(false);
  });

  it("a transient error waits for explicit retry with no automatic request loop", async () => {
    const f = fixture(); f.fetcher.mockResolvedValueOnce(response({ error: { code: "UNAVAILABLE" } }, 503));
    const { ui } = observed(f);
    await waitFor(() => expect(ui.result.current.state).toEqual({ phase: "failed", cardId: A, pair: "ru-de", data: null, problem: "load" }));
    await flush(); ui.rerender(f.options); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    await act(ui.result.current.refresh);
    expect(ui.result.current.state.phase).toBe("ready"); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an invalid card ID", (f: ReturnType<typeof fixture>) => ({ ...f.options, cardId: "card-1" })],
    ["an unknown dictionary language", (f: ReturnType<typeof fixture>) => ({ ...f.options,
      access: f.access({ profile: { ...f.opened.profile, dictionary_language: "de" as "ru" } }) })],
  ])("%s throws during render and sends nothing", async (_name, make) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = fixture(), options = make(f);
    expect(() => renderHook(useDictionaryCardDocument, { initialProps: options })).toThrow();
    await flush(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
