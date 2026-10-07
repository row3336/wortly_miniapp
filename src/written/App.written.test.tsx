import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OpenRequest } from "../api/generated";
import { App } from "../app/App";
import { staleCommand, staleRefusal } from "../app/openRules.test-support";
import { app, answer, settingsRefusalText, compatibility, exchange, field, loseReply, pairText, requests, row, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";
import { deferred, id, profile, response } from "./writtenFixtures.test-support";

useWrittenAppEnvironment();

/** A spy on Telegram's close for the stubbed WebApp of app(). */
function telegramClose() {
  const close = vi.fn();
  Object.assign((globalThis as unknown as { Telegram: { WebApp: object } }).Telegram.WebApp, { close });
  return close;
}

describe("Written quiz through the actual App document", () => {
  // De→L1 rows start the oral quiz since M-ORAL-ENTRY (CP14 B-ENTRY lifted): App.oralEntry.test.tsx E1.
  it("W1 a tap on the L1→De count starts the written quiz at once", async () => {
    const a = app(); render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    await startWords();
    expect(a.posts()[0]).toMatchObject({ kind: "session.start", payload: { mode: "written", bucket: "words" } });
    expect(a.kinds()).toEqual(["session.start", "assignment.present"]);
    // The bottom navigation is hidden during the session.
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    expect(a.haptic).toHaveBeenCalledTimes(2); // entry, then the confirmed quiz start
  });

  it("W2 native Back is Exit without confirmation; the own summary (Д02) waits for «На Сегодня», then a fresh Today", async () => {
    const a = app({ cards: [6, 7, 8] }); render(<App />);
    await startWords(); await answer("Haus");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("слово 7");
    await a.back.click();
    await screen.findByText("Занятие прервано.");
    expect(a.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "stop" } });
    expect(Array.from(document.querySelectorAll(".written-summary dd"), item => item.textContent).slice(0, 3)).toEqual(["1", "1", "0"]);
    const reads = a.todayReply.mock.calls.length;
    await a.back.click();
    await screen.findByText(pairText);
    expect(a.todayReply.mock.calls.length).toBeGreaterThan(reads);
    expect(a.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
  });

  it("W3 the natural summary closes with summary_home and returns to Today; completion is signalled once", async () => {
    const a = app({ cards: [6] }); render(<App />);
    await startWords(); await answer("falsch");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Занятие завершено.");
    expect(a.haptic).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText);
    expect(a.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } });
    expect(a.haptic).toHaveBeenCalledTimes(3);
  });

  it("W4 while a sent Stop is awaited, Back stays bound and creates no second Stop (Т96)", async () => {
    const a = app(); render(<App />);
    await startWords();
    const gate = deferred<void>();
    a.fetcher.mockImplementationOnce(async (...call) => { await gate.promise; return a.server.handle(call[0] as RequestInfo, call[1]); });
    await a.back.click();
    await screen.findByText("Завершаем занятие…");
    await a.back.click(); await a.back.click();
    expect(a.back.bound).toBe(1);
    expect(a.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
    gate.resolve();
    await screen.findByText("Занятие прервано.");
    expect(a.kinds().filter(kind => kind === "session.stop")).toHaveLength(1);
  });

  it("W5 a refused start shows its reason on the written route, signals nothing and Today stays reachable", async () => {
    const a = app({ refuseStart: "SESSION_BUSY" }); render(<App />);
    await screen.findByText(pairText);
    await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false));
    fireEvent.click(row(/Слова: перевод на немецкий/));
    await screen.findByText("Занятие открыто на другом устройстве");
    // Only an accepted start is a haptic milestone (TA §3): the entry signal stays the only one.
    expect(a.haptic).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText);
  });

  it("В02 a new document of the same client continues the open session at its server step, without the old correction", async () => {
    const a = app({ cards: [6, 7, 8] });
    const first = render(<App />);
    await startWords(); await answer("falsch");
    expect(screen.getByRole("button", { name: "Исправить ответ" })).toBeTruthy();
    first.unmount();
    const mark = a.fetcher.mock.calls.length, sessionId = a.server.state.sessionId!, posts = a.posts().length;
    render(<App />);
    await screen.findByText("слово 7");
    await waitFor(() => expect(field().readOnly).toBe(false));
    // The step comes from the projection; no result, correction or undo of the old document comes with it (TA:48).
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(screen.queryByRole("button", { name: "Исправить ответ" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Предыдущий ответ" })).toBeNull();
    expect(screen.queryByText(pairText)).toBeNull(); expect(screen.queryByText("Вход подтверждён")).toBeNull();
    expect(requests(a, mark)).toContain(`GET /api/v1/sessions/${sessionId}`);
    expect(a.posts().slice(posts).map(post => [post.kind, post.session_id, post.assignment_id]))
      .toEqual([["assignment.present", sessionId, id(7)]]);
    expect(a.back.bound).toBe(1);
  });

  it("В02 a closed written session is never resumed, even when an open still reports it", async () => {
    const a = app(); const first = render(<App />);
    await startWords(); await a.back.click();
    await screen.findByText("Занятие прервано.");
    first.unmount();
    const mark = a.fetcher.mock.calls.length, sessionId = a.server.state.sessionId!, posts = a.posts().length;
    const opened = a.openReply.getMockImplementation()!;
    a.openReply.mockImplementationOnce(async body => response({ ...await (await opened(body)).json(), session: { id: sessionId, phase: "active" } }));
    render(<App />);
    await screen.findByText(pairText);
    expect(screen.queryByText("Занятие прервано.")).toBeNull(); expect(screen.queryByRole("textbox")).toBeNull();
    expect(a.posts()).toHaveLength(posts);
    expect(requests(a, mark).filter(request => request.includes("/commands/"))).toEqual([]);
    expect(requests(a, mark).filter(request => request.endsWith("/client/open")).length).toBeGreaterThan(1);
  });

  it("В02 an unknown present of the old document is resolved by its own ID before any change; nothing is issued again (CT:109)", async () => {
    const a = app({ cards: [6, 7] }); const first = render(<App />);
    await startWords(); await answer("Haus");
    loseReply(a, "assignment.present");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    // B stays visible and unconfirmed; only a check of the same ID is offered.
    await screen.findByRole("button", { name: "Проверить состояние" });
    expect(screen.getByText("слово 7")).toBeTruthy();
    const lost = a.posts().at(-1)!;
    expect([lost.kind, lost.assignment_id]).toEqual(["assignment.present", id(7)]);
    first.unmount();
    const mark = a.fetcher.mock.calls.length, posts = a.posts().length;
    render(<App />);
    await screen.findByText("слово 7");
    await waitFor(() => expect(field().readOnly).toBe(false));
    expect(a.posts()).toHaveLength(posts);
    await answer("Haus");
    const later = requests(a, mark), check = later.indexOf(`GET /api/v1/commands/${lost.command_id}`);
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(later.indexOf("POST /api/v1/commands"));
    expect(a.posts().slice(posts).map(post => post.kind)).toEqual(["answer.submit"]);
    expect(a.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });

  it("В02 an unknown correction of the old document is resolved by its own ID before any change, never sent again (CT:109)", async () => {
    const a = app({ cards: [6, 7] }); const first = render(<App />);
    await startWords(); await answer("falsch");
    loseReply(a, "result.correct");
    fireEvent.click(screen.getByRole("button", { name: "Исправить ответ" }));
    await screen.findByText("Проверяем изменение");
    const lost = a.posts().at(-1)!;
    expect(lost.kind).toBe("result.correct");
    first.unmount();
    const mark = a.fetcher.mock.calls.length, posts = a.posts().length;
    render(<App />);
    await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/commands/${lost.command_id}`));
    await screen.findByText("слово 7");
    await waitFor(() => expect(field().readOnly).toBe(false));
    const later = requests(a, mark);
    expect(later.indexOf(`GET /api/v1/commands/${lost.command_id}`)).toBeLessThan(later.indexOf("POST /api/v1/commands"));
    expect(a.posts().slice(posts).map(post => post.kind)).toEqual(["assignment.present"]);
    expect(a.kinds().filter(kind => kind === "result.correct")).toHaveLength(1);
    expect([...a.server.results.values()].map(item => item.grade)).toEqual([4]);
  });

  it("В02 a start refused as SESSION_BUSY leads to the busy Today; a confirmed remote stop there returns to a fresh Today", async () => {
    const a = app({ refuseStart: "SESSION_BUSY" }), other = id(60), remote = { busy: false }, close = telegramClose();
    const base = a.fetcher.getMockImplementation()!;
    a.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith("/client/open") && remote.busy) return response({ status: "SESSION_BUSY", profile: profile(String(a.server.state.version)),
        compatibility, session: { status: "busy", stop_remote_target: other } });
      if (!path.endsWith("/commands") || body?.kind !== "session.stop_remote") return base(url, init);
      remote.busy = false; a.server.state.version++;
      return response({ command: { id: body.command_id, kind: body.kind, status: "applied", target_id: other, applied_at: "2026-10-05T12:00:00Z",
        action_id: null, result_id: null, context_id: null, object_version: null },
        current: { session_id: other, status: "closed", close_reason: "remote_stop" }, state_version: String(a.server.state.version) });
    });
    render(<App />);
    await screen.findByText(pairText);
    await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false));
    // Another device opened its session after this document entered.
    remote.busy = true;
    fireEvent.click(row(/Слова: перевод на немецкий/));
    await screen.findByText("Занятие открыто на другом устройстве");
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByRole("heading", { name: "Занятие на другом устройстве" });
    expect(a.kinds()).toEqual(["session.start"]);
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" }));
    // The question is a real pause: a stop sent right after the request would already be in the log here, and Cancel posts nothing.
    await screen.findByRole("heading", { name: "Завершить занятие?" });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(a.kinds()).toEqual(["session.start"]);
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    await screen.findByRole("heading", { name: "Занятие на другом устройстве" });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(a.kinds()).toEqual(["session.start"]);
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" }));
    await screen.findByRole("heading", { name: "Завершить занятие?" });
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие" }));
    await screen.findByText(pairText);
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Занятие на другом устройстве" })).toBeNull());
    expect(a.posts().map(post => [post.kind, post.session_id, post.payload]))
      .toEqual([["session.start", expect.any(String), { mode: "written", bucket: "words" }], ["session.stop_remote", other, { confirmed: true }]]);
    expect(screen.queryByRole("textbox")).toBeNull();
    // Another installation's session never closes this window (decision 2.2: the busy screen is only for it).
    expect(close).not.toHaveBeenCalled();
  });

  it("В02 a start refused as DOCUMENT_STALE (a newer window of this installation took the document): this window closes, never reopens it", async () => {
    const a = app({ refuseStart: "DOCUMENT_STALE" }), close = telegramClose(), replaced = { now: false };
    const opened = a.openReply.getMockImplementation()!;
    a.openReply.mockImplementation(async body => replaced.now && (body as OpenRequest).event === "foreground"
      ? response(staleRefusal, 409) : opened(body));
    render(<App />);
    await screen.findByText(pairText);
    await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false));
    const own = a.openReply.mock.calls[0][0].document_id;
    replaced.now = true;
    fireEvent.click(row(/Слова: перевод на немецкий/));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    await screen.findByRole("heading", { name: "Wortly уже открыт" });
    expect(screen.queryByText("Занятие открыто на другом устройстве")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(a.kinds()).toEqual(["session.start"]);
    expect(a.openReply.mock.calls.map(([body]) => [body.document_id, (body as OpenRequest).event])).toEqual([[own, "open"], [own, "foreground"]]);
  });

  it("В02 two windows of one installation: B continues at once without A's typed answer; A's check is refused and A closes", async () => {
    const a = app({ cards: [6, 7] }), close = telegramClose(), live = { document: null as string | null };
    const base = a.fetcher.getMockImplementation()!;
    // The core after C-REOPEN-2: an open makes its document live; a foreground or a write of another one is DOCUMENT_STALE.
    a.fetcher.mockImplementation(async (url, init) => {
      const address = new URL(String(url), "http://localhost"), body = init?.body ? JSON.parse(String(init.body)) : null;
      if (address.pathname.endsWith("/client/open")) {
        if (body.event === "foreground" && body.document_id !== live.document) return response(staleRefusal, 409);
        live.document = body.document_id;
        return base(url, init);
      }
      const document = body?.document_id ?? address.searchParams.get("document_id");
      if (!document || document === live.document) return base(url, init);
      if (!body?.command_id) return response(staleRefusal, 409);
      const { current, ...refused } = staleCommand(body.command_id, body.session_id, a.server.state.version);
      // An answer command answers with the written step envelope (written_projection.safe_written_projection).
      return response(body.kind !== "answer.submit" ? { current, ...refused } : { ...refused, action: null, result: null, step: current,
        capabilities: { answer_target: null, correct_target: null, grades: null, undo_target: null, stop: false, summary_home: false } }, 409);
    });
    const first = render(<App />);
    await startWords();
    const old = live.document;
    fireEvent.change(field(), { target: { value: "Haus" } });
    const second = render(<App />);
    await within(second.container).findByText("слово 6");
    const input = within(second.container).getByRole("textbox") as HTMLTextAreaElement;
    await waitFor(() => expect(input.readOnly).toBe(false));
    expect(input.value).toBe("");
    expect(live.document).not.toBe(old);
    fireEvent.click(within(first.container).getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    await within(first.container).findByRole("heading", { name: "Wortly уже открыт" });
    expect(a.posts().filter(post => post.document_id === old).map(post => post.kind)).toEqual(["session.start", "assignment.present", "answer.submit"]);
    expect(a.server.results.size).toBe(0);
    expect(input.value).toBe("");
    expect(within(second.container).queryByText("Есть ошибка")).toBeNull();
    expect(within(second.container).queryByText("Учебное действие ещё не подтверждено.")).toBeNull();
    expect(localStorage.getItem("wortly.pending.written_session")).toBeNull();
  });

  it("a prefetched question that waits for an unset transition mode keeps the refusal with its buttons, not an endless loading", async () => {
    const a = app({ active: true, cards: [6, 7] });
    a.server.state.assignment = "prefetched";
    const base = a.fetcher.getMockImplementation()!;
    a.fetcher.mockImplementation(async (url, init) => {
      const res = await base(url, init);
      if (new URL(String(url), "http://localhost").pathname.endsWith("/settings") && (init?.method ?? "GET") === "GET") {
        const body = await res.clone().json();
        body.settings.transition_mode.value = null;
        return response(body);
      }
      return res;
    });
    render(<App />);
    await screen.findByText(settingsRefusalText);
    expect(screen.getByRole("button", { name: "Обновить настройки" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    expect(screen.queryByText("Загружаем занятие…")).toBeNull();
  });
});
