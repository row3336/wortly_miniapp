import { StrictMode, createElement, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardContent, OpenedClient } from "../api/generated";
import { createOpenedAccess, type OpenedAccess } from "../app/openedAccess";
import { useDictionaryHistoryDocument, type DictionaryHistoryDocumentOptions } from "./useDictionaryHistoryDocument";

type Language = "ru" | "uk" | "en";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { value: state, configurable: true }); }
const flush = () => act(async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); });
function content(n: number, pair: string): DictionaryCardContent {
  return { pair: pair as DictionaryCardContent["pair"], card: { id: id(n), revision: "1", lemma: `Wort${n}`, type: "noun", cefr: null },
    translations: { common: [`слово${n}`], personal: null }, grammar: null, reference_conjugations: [],
    examples: { common: [], personal: null }, association: null };
}
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); });

/** Real access, history and card APIs over a model server. */
function fixture() {
  const server = { history: [1, 2], pair: "ru-de", historyStatus: 200 };
  const live = new Set<OpenedAccess>();
  const denied = vi.fn();
  const opened: OpenedClient = { status: "opened", client_instance_id: id(901), document_id: id(902), document_epoch: "1", proof_version: "1",
    profile: { profile_id: id(903), role: "user", ui_language: "ru", dictionary_language: "ru", time_zone: "UTC", state_version: "1",
      access: { status: "admitted", version: "1", reason: null } }, session: null, compatibility: { compatible: true, contract_version: "1" } };
  const access = (o: { language?: Language; status?: "admitted" | "pending" } = {}) => {
    let bound!: OpenedAccess;
    bound = createOpenedAccess({ opened: { ...opened, profile: { ...opened.profile, dictionary_language: o.language ?? "ru",
      access: { status: o.status ?? "admitted", version: "1", reason: null } } },
      token: "synthetic-history-token", proof: "synthetic-proof", generation: 1,
      isLive: () => live.has(bound), onDenied: error => { denied(error); live.delete(bound); } });
    live.clear(); live.add(bound);
    return bound;
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    expect(init?.method).toBe("GET");
    const path = new URL(String(url), "https://model.invalid").pathname;
    if (path === "/api/v1/dictionary/history") {
      if (server.historyStatus !== 200) return json({ error: { code: "ACCESS_DENIED" } }, server.historyStatus);
      return json({ state_version: "1", items: server.history.map((n, k) => ({ card_id: id(n), opened_at: `2026-10-06T10:0${k}:00Z` })) });
    }
    expect(path.startsWith("/api/v1/dictionary/cards/")).toBe(true);
    return json({ state_version: "1", current: content(Number(path.slice(-12)), server.pair) });
  });
  const options: DictionaryHistoryDocumentOptions = { access: access(), transport: { fetcher, timeoutMs: 30000, maxResponseBytes: 100000 },
    enabled: true };
  const historyReads = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith("/dictionary/history")).length;
  return { server, fetcher, options, access, denied, historyReads };
}
function mount(f: ReturnType<typeof fixture>, strict = false) {
  const ui = renderHook((props: DictionaryHistoryDocumentOptions) => useDictionaryHistoryDocument(props), { initialProps: f.options,
    wrapper: strict ? ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children) : undefined });
  const lemmas = () => ui.result.current.state.items.map(item => item.lemma);
  return { ui, lemmas, state: () => ui.result.current.state };
}

describe("dictionary history document with real access, APIs and controller", () => {
  it("reads the history and its card texts once for an enabled access; renders read nothing more", async () => {
    const f = fixture(), h = mount(f); await flush();
    expect(h.state()).toMatchObject({ phase: "ready", pair: "ru-de", problem: null });
    expect(h.lemmas()).toEqual(["Wort1", "Wort2"]);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    h.ui.rerender({ ...f.options }); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it("a disabled document reads nothing until enabled; actions are stable", async () => {
    const f = fixture();
    f.options.enabled = false;
    const h = mount(f); await flush();
    const actions = h.ui.result.current.actions;
    act(() => actions.refresh()); await flush();
    expect(f.fetcher).not.toHaveBeenCalled();
    h.ui.rerender({ ...f.options, enabled: true }); await flush();
    expect(f.historyReads()).toBe(1);
    expect(h.state().phase).toBe("ready");
    expect(h.ui.result.current.actions).toBe(actions);
  });

  it("K11-013: a new access object (foreground) rereads the list and the texts", async () => {
    const f = fixture(), h = mount(f); await flush();
    f.server.history = [3, 1];
    h.ui.rerender({ ...f.options, access: f.access() }); await flush();
    expect(f.historyReads()).toBe(2);
    expect(h.lemmas()).toEqual(["Wort3", "Wort1"]);
  });

  it("refresh rereads the list and only new card texts; forget() rereads them all", async () => {
    const f = fixture(), h = mount(f); await flush();
    f.server.history = [3, 1, 2];
    act(() => h.ui.result.current.actions.refresh()); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(5);
    act(() => { h.ui.result.current.actions.forget(); h.ui.result.current.actions.refresh(); }); await flush();
    expect(f.fetcher).toHaveBeenCalledTimes(9);
    expect(h.lemmas()).toEqual(["Wort3", "Wort1", "Wort2"]);
  });

  it("a hidden page suspends the access: nothing is read until a new access arrives", async () => {
    const f = fixture(), h = mount(f); await flush();
    act(() => { visible("hidden"); document.dispatchEvent(new Event("visibilitychange")); });
    act(() => { visible("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    act(() => h.ui.result.current.actions.refresh()); await flush();
    expect(f.historyReads()).toBe(1);
    h.ui.rerender({ ...f.options, access: f.access() }); await flush();
    expect(f.historyReads()).toBe(2);
    expect(h.state().phase).toBe("ready");
  });

  it("a denied read revokes the access and the document is disposed, without texts", async () => {
    const f = fixture(); f.server.historyStatus = 403;
    const h = mount(f); await flush();
    expect(f.denied).toHaveBeenCalledOnce();
    h.ui.rerender({ ...f.options }); await flush();
    expect(h.state()).toEqual({ phase: "disposed", items: [], pair: null, problem: null });
  });

  it("a not admitted access is disposed and never reads", async () => {
    const f = fixture();
    f.options.access = f.access({ status: "pending" });
    const h = mount(f); await flush();
    expect(h.state().phase).toBe("disposed");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("card texts of another pair than the access are pair_changed", async () => {
    const f = fixture(); f.server.pair = "uk-de";
    const h = mount(f); await flush();
    expect(h.state()).toMatchObject({ phase: "failed", problem: "pair_changed", items: [] });
  });

  it("StrictMode: one read per access, and nothing is published after unmount", async () => {
    const f = fixture(), h = mount(f, true); await flush();
    expect(f.historyReads()).toBe(1);
    const actions = h.ui.result.current.actions;
    h.ui.unmount();
    const calls = f.fetcher.mock.calls.length;
    act(() => actions.refresh()); await flush();
    expect(f.fetcher.mock.calls.length).toBe(calls);
  });

  it("an unknown dictionary language throws during render and sends nothing", () => {
    const f = fixture();
    f.options.access = f.access({ language: "de" as Language });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => mount(f)).toThrow("unknown dictionary pair");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
