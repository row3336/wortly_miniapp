import { withTrace } from "../api/traceHeader.test-support";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodayResponse } from "../api/generated";
import { TodayScreen } from "./TodayScreen";
import { TodayController } from "./todayController";
import { createTodayApi, validToday } from "./todayApi";
import { EntryApiError } from "../api/entryApi";
import { TodayHost } from "../app/TodayHost";
import { LearningScreen } from "../learning/LearningScreen";
import { useLearningDocument } from "../learning/useLearningDocument";
import { learningViewFixture } from "../learning/learningView.test-support";
import { testGate } from "../commands/testGate.test-support";

afterEach(cleanup);

const plan: TodayResponse = {
  state_version: "9007199254740993", pair: "ru-de", local_date: "2026-09-29", status: "work_now",
  base: { total: 7, words: 5, phrases: 2 },
  ordinary: {
    words: { "l1-de": { ready: 3, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
    phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 2, next_due_date: null } },
  },
  ordinary_status: "ready",
  learning: { status: "waiting", ready: 0, preview: 0, next_due_at: "2026-09-29T14:30:00+00:00", new_group_size: 0, manual_eligible: 0, automatic_eligible: 0 },
  conjugation: { ready: 0, openable: 0, next_due_date: null },
  next_repeat_date: "2026-09-30",
};

function props(state: Parameters<typeof TodayScreen>[0]["state"]) {
  return {
    state, language: "ru" as const, onRetry: vi.fn(), onStartQuiz: vi.fn(),
    onOpenLearning: vi.fn(), onStartConjugation: vi.fn(), onOpenConjugations: vi.fn(), onNavigate: vi.fn(),
  };
}

describe("Today screen", () => {
  it("TodayHost connects an explicit Learning tap to one real start and preview-to-question flow", async () => {
    const f = learningViewFixture("normal", null); f.view.dispose(); f.owner.dispose();
    const transport = { fetcher: f.fetcher, timeoutMs: 30000, maxResponseBytes: 100000, gate: testGate() };
    f.fetcher.mockImplementation(async (...call) => String(call[0]).endsWith("/today")
      ? new Response(JSON.stringify({ ...plan, state_version: "1", learning: { ...plan.learning,
        status: "new_group", next_due_at: null, new_group_size: 4 } })) : f.handler(...call));
    function Document() {
      const { state, actions } = useLearningDocument({ access: f.access(), storage: f.storage, transport,
        newId: f.newId, initialSessionId: null, transitionMode: "normal" });
      return state?.sessionId ? <LearningScreen state={state} actions={actions} language="ru" submitOnEnter
        renderPreview={preview => <p data-testid="live-preview">{preview.content.card.lemma}</p>} />
        : <TodayHost access={f.access()} transport={transport} language="ru" onOpenLearning={actions.start} />;
    }
    render(<Document />);
    const start = await screen.findByRole("button", { name: /Новая группа слов4/ });
    expect(start.hasAttribute("disabled")).toBe(false); expect(f.posts()).toEqual([]); expect(f.newId).not.toHaveBeenCalled();
    fireEvent.click(start); fireEvent.click(start);
    await screen.findByTestId("live-preview"); expect(f.posts().map(post => post.kind)).toEqual(["session.start"]);
    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    await screen.findByRole("textbox"); await waitFor(() => expect(screen.getByRole("button", { name: "Забыл…" }).hasAttribute("disabled")).toBe(false));
    expect(f.posts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("дом");
  });
  it("keeps unconnected actions disabled and enables them when the host supplies handlers", () => {
    const data = { ...plan, learning: { ...plan.learning, status: "new_group" as const, new_group_size: 3 },
      conjugation: { ready: 2, openable: 2, next_due_date: null } };
    const p = props({ kind: "ready", data, refreshing: false });
    const { rerender } = render(<TodayScreen state={p.state} language="ru" onRetry={vi.fn()} />);
    for (const button of screen.getAllByRole("button")) expect(button.hasAttribute("disabled")).toBe(true);
    rerender(<TodayScreen {...p} />);
    const start = screen.getByRole("button", { name: /Слова: перевод на немецкий\s*3/ });
    expect(start.hasAttribute("disabled")).toBe(false);
    fireEvent.click(start);
    expect(p.onStartQuiz).toHaveBeenCalledOnce();
  });
  it("does not invent counts or completion before the plan arrives", () => {
    const { rerender } = render(<TodayScreen {...props({ kind: "loading" })} />);
    expect(screen.queryByText("На сегодня всё")).toBeNull();
    expect(screen.queryByText("0")).toBeNull();
    rerender(<TodayScreen {...props({ kind: "failed" })} />);
    expect(screen.getByText("Не удалось загрузить план")).toBeTruthy();
    expect(screen.queryByText("На сегодня всё")).toBeNull();
  });

  it("starts the chosen ready quiz with one tap and leaves zero rows inert", () => {
    const p = props({ kind: "ready", data: plan, refreshing: false });
    render(<TodayScreen {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Слова: перевод на немецкий\s*3/ }));
    expect(p.onStartQuiz).toHaveBeenCalledExactlyOnceWith({ material: "words", direction: "l1-de" });
    expect(screen.queryByRole("button", { name: /Слова: перевод с немецкого 0/ })).toBeNull();
    expect(screen.queryByText("На сегодня всё")).toBeNull();
  });

  it("only shows all done from the server state and shows the next repeat", () => {
    const complete: TodayResponse = { ...plan, status: "all_done", ordinary_status: "done",
      ordinary: {
        words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
        phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      },
    };
    render(<TodayScreen {...props({ kind: "ready", data: complete, refreshing: false })} />);
    expect(screen.getByText("На сегодня всё")).toBeTruthy();
    expect(screen.getByText(/Ближайший повтор/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /перевод на немецкий/ })).toBeNull();
  });

  it("opens a new Learning group once and keeps busy distinct from completion", () => {
    const p = props({ kind: "ready", data: { ...plan, learning: { ...plan.learning, status: "new_group", new_group_size: 4 } }, refreshing: false });
    const { rerender } = render(<TodayScreen {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Новая группа слов4/ }));
    expect(p.onOpenLearning).toHaveBeenCalledTimes(1);
    rerender(<TodayScreen {...props({ kind: "busy" })} />);
    expect(screen.getByText("Занятие открыто на другом устройстве")).toBeTruthy();
    expect(screen.queryByText("На сегодня всё")).toBeNull();
  });

  it("starts a ready conjugation quiz even when no free blocks are openable", () => {
    const p = props({ kind: "ready", data: { ...plan, conjugation: { ready: 2, openable: 0, next_due_date: null } }, refreshing: false });
    render(<TodayScreen {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Тест спряжений\s*2/ }));
    expect(p.onStartConjugation).toHaveBeenCalledTimes(1);
    expect(p.onOpenConjugations).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Открыть спряжения/ })).toBeNull();
  });

  it("shows a localized pair label instead of a transport value", () => {
    render(<TodayScreen {...props({ kind: "ready", data: { ...plan, pair: "uk-de" }, refreshing: false })} />);
    expect(screen.getByText("Активная пара: Украинский ↔ Немецкий")).toBeTruthy();
    expect(screen.queryByText("uk-de")).toBeNull();
  });

  it("locks the screen after a rejected start until the host remounts it", async () => {
    const p = props({ kind: "ready", data: plan, refreshing: false });
    p.onStartQuiz.mockRejectedValue(new Error("unknown outcome"));
    render(<TodayScreen {...p} />);
    fireEvent.click(screen.getByRole("button", { name: /Слова: перевод на немецкий\s*3/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Не удалось подтвердить запуск"));
    expect(screen.queryByRole("button", { name: /Слова: перевод на немецкий/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Словарь" })).toBeNull();
    expect(p.onStartQuiz).toHaveBeenCalledTimes(1);
  });
});

describe("Today data", () => {
  it("accepts an opened source without using a token-shaped UI key", async () => {
    const legacyApi = { get: vi.fn(async () => plan) };
    const controller = new TodayController(legacyApi, vi.fn());
    const source = { identity: {}, get: vi.fn(async () => plan) };
    await controller.loadFrom(source, "ru-de");
    expect(source.get).toHaveBeenCalledExactlyOnceWith();
    expect(legacyApi.get).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ kind: "ready", data: plan });
  });

  it("resets ordering for a new opened source and rejects an old source's late result", async () => {
    const controller = new TodayController({ get: vi.fn() }, vi.fn());
    const first = { identity: {}, get: vi.fn(async () => plan) };
    await controller.loadFrom(first, "ru-de");
    let finish!: (value: TodayResponse) => void;
    first.get.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const old = controller.loadFrom(first, "ru-de");
    const fresh = { ...plan, state_version: "2", base: { total: 1, words: 1, phrases: 0 } };
    const second = { identity: {}, get: vi.fn(async () => fresh) };
    await controller.loadFrom(second, "ru-de");
    finish({ ...plan, state_version: "9007199254740999" }); await old;
    expect(controller.snapshot()).toMatchObject({ kind: "ready", data: fresh });
  });

  it("suppresses late source data after dispose", async () => {
    const updates = vi.fn();
    const controller = new TodayController({ get: vi.fn() }, updates);
    let finish!: (value: TodayResponse) => void;
    const source = { identity: {}, get: () => new Promise<TodayResponse>(resolve => { finish = resolve; }) };
    const loading = controller.loadFrom(source, "ru-de");
    controller.dispose(); updates.mockClear(); finish(plan); await loading;
    expect(updates).not.toHaveBeenCalled();
  });
  it("validates nested counts and keeps the bearer token in the request only", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(plan), { status: 200 }));
    const api = createTodayApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 4000, gate: testGate() });
    await expect(api.get("secret-token")).resolves.toEqual(plan);
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/today");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual(withTrace({ Authorization: "Bearer secret-token" }));
    expect(validToday({ ...plan, base: { total: 7, words: -1, phrases: 8 } })).toBe(false);
    expect(validToday({ ...plan, learning: { ...plan.learning, next_due_at: "tomorrow" } })).toBe(false);
    expect(validToday({ ...plan, pair: ["ru-de"] })).toBe(false);
    expect(validToday({ ...plan, status: ["work_now"] })).toBe(false);
    expect(validToday({ ...plan, learning: { ...plan.learning, status: ["waiting"] } })).toBe(false);
    expect(validToday({ ...plan, learning: { ...plan.learning, next_due_at: "2026-09-29T24:00:00Z" } })).toBe(false);
    expect(validToday({ ...plan, learning: { ...plan.learning, next_due_at: "2026-09-29T14:30:00+02:00" } })).toBe(false);
  });

  it("rejects oversized responses", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(plan)));
    const api = createTodayApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 20, gate: testGate() });
    await expect(api.get("token")).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it.each([401, 403])("keeps HTTP %i status when its response body is oversized", async (status) => {
    const fetcher = vi.fn(async () => new Response("x".repeat(200), { status }));
    const api = createTodayApi({ fetcher: fetcher as typeof fetch, timeoutMs: 1000, maxResponseBytes: 20, gate: testGate() });
    await expect(api.get("token")).rejects.toMatchObject({ kind: "http", status });
  });

  it("does not roll back a version above JavaScript's safe integer limit", async () => {
    const pending: ((value: TodayResponse) => void)[] = [];
    const api = { get: () => new Promise<TodayResponse>((resolve) => pending.push(resolve)) };
    const updates: string[] = [];
    const controller = new TodayController(api, (state) => {
      if (state.kind === "ready") updates.push(state.data.state_version);
    });
    const first = controller.load("token", "ru-de");
    const second = controller.load("token", "ru-de");
    pending[1]({ ...plan, state_version: "9007199254740995" });
    await second;
    pending[0]({ ...plan, state_version: "9007199254740994" });
    await first;
    const third = controller.load("token", "ru-de");
    pending[2]({ ...plan, state_version: "9007199254740993" });
    await third;
    expect(controller.snapshot()).toMatchObject({ kind: "ready", data: { state_version: "9007199254740995" } });
    expect(updates).not.toContain("9007199254740994");
  });

  it.each([new EntryApiError("network"), new EntryApiError("http", 503)])("hides the old plan and closes start actions after a failed refresh: %s", async (failure) => {
    let requests = 0;
    const api = { get: async () => {
      requests += 1;
      if (requests === 1) return plan;
      throw failure;
    } };
    const controller = new TodayController(api, () => undefined);
    await controller.load("token", "ru-de");
    expect(controller.snapshot().kind).toBe("ready");
    const refresh = controller.load("token", "ru-de");
    expect(controller.snapshot()).toEqual({ kind: "loading" });
    await refresh;
    expect(controller.snapshot()).toEqual({ kind: "failed", reason: "load" });
    render(<TodayScreen {...props(controller.snapshot())} />);
    expect(screen.getByText("Не удалось загрузить план")).toBeTruthy();
    expect(screen.queryByText("На сегодня всё")).toBeNull();
    expect(screen.queryByRole("button", { name: /Слова: перевод на немецкий/ })).toBeNull();
  });

  it.each([401, 403])("expires the old plan on %i and allows only a fresh authenticated plan afterward", async (status) => {
    let requests = 0;
    const api = { get: async () => {
      requests += 1;
      if (requests === 1) return plan;
      if (requests === 2) throw new EntryApiError("http", status);
      return { ...plan, state_version: "1" };
    } };
    const controller = new TodayController(api, () => undefined);
    await controller.load("token", "ru-de");
    await controller.load("token", "ru-de");
    expect(controller.snapshot()).toEqual({ kind: "failed", reason: "expired" });
    render(<TodayScreen {...props(controller.snapshot())} />);
    expect(screen.getByText(/Не удалось подтвердить доступ/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Слова: перевод на немецкий/ })).toBeNull();
    await controller.load("new-token", "ru-de");
    expect(controller.snapshot()).toMatchObject({ kind: "ready", data: { state_version: "1" } });
  });

  it("invalidates the old user's plan and late request when the token changes", async () => {
    const pending: ((value: TodayResponse) => void)[] = [];
    const api = { get: () => new Promise<TodayResponse>((resolve) => pending.push(resolve)) };
    const controller = new TodayController(api, () => undefined);
    const first = controller.load("token-A", "ru-de");
    pending[0]({ ...plan, state_version: "10" });
    await first;
    const lateA = controller.load("token-A", "ru-de");
    const userB = controller.load("token-B", "ru-de");
    expect(controller.snapshot()).toEqual({ kind: "loading" });
    pending[2]({ ...plan, state_version: "1" });
    await userB;
    pending[1]({ ...plan, state_version: "11" });
    await lateA;
    expect(controller.snapshot()).toMatchObject({ kind: "ready", data: { state_version: "1" } });
  });
});
