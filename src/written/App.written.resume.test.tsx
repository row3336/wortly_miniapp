// Resuming a written session after a relaunch and the busy chain (В02), moved from the independent QA of M-WCORR CP2 (QA2-02…06, QA2-08).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/App";
import { app, answer, compatibility, dropRequest, exchange, field, loseReply, offlineStudy, pairText, requests, row, startWords,
  useWrittenAppEnvironment } from "./writtenApp.test-support";
import { id, profile, response } from "./writtenFixtures.test-support";

useWrittenAppEnvironment();

describe("Written session resume after a relaunch (В02)", () => {
  it("after resume native Back is Stop of the same session and shows its own summary", async () => {
    const a = app({ cards: [6, 7, 8] }); const first = render(<App />);
    await startWords(); await answer("falsch");
    first.unmount();
    const sessionId = a.server.state.sessionId!, posts = a.posts().length;
    render(<App />);
    await screen.findByText("слово 7"); await waitFor(() => expect(field().readOnly).toBe(false));
    await a.back.click();
    await screen.findByText("Занятие прервано.");
    expect(a.posts().slice(posts).map(post => [post.kind, post.session_id, post.payload]))
      .toEqual([["assignment.present", sessionId, {}], ["session.stop", sessionId, { reason: "stop" }]]);
    // The summary counts the answer of the old document (C-WSUM): completed 1, correct 0, wrong 1.
    expect(Array.from(document.querySelectorAll(".written-summary dd"), item => item.textContent).slice(0, 3)).toEqual(["1", "0", "1"]);
  });

  it("after resume a new error gets its correction right from the server, and the correction targets it", async () => {
    const a = app({ cards: [6, 7, 8] }); const first = render(<App />);
    await startWords(); await answer("Haus");
    first.unmount();
    render(<App />);
    await screen.findByText("слово 7"); await waitFor(() => expect(field().readOnly).toBe(false));
    await answer("falsch");
    fireEvent.click(screen.getByRole("button", { name: "Исправить ответ" }));
    await waitFor(() => expect(a.kinds().filter(kind => kind === "result.correct")).toHaveLength(1));
    const correction = a.posts().find(post => post.kind === "result.correct")!;
    expect([correction.assignment_id, correction.result_id]).toEqual([id(7), id(707)]);
    await waitFor(() => expect(a.server.results.get(id(707))!.grade).toBe(4));
  });

  it("an unknown answer of the old document is resolved by its ID before any POST and never submitted twice", async () => {
    const a = app({ cards: [6, 7] }); const first = render(<App />);
    await startWords();
    // The old document cannot check the lost answer: it is left unknown there.
    loseReply(a, "answer.submit"); const online = offlineStudy(a);
    fireEvent.change(field(), { target: { value: "falsch" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(a.kinds()).toContain("answer.submit"));
    const lost = a.posts().at(-1)!;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    first.unmount(); online();
    const mark = a.fetcher.mock.calls.length;
    render(<App />);
    await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/commands/${lost.command_id}`));
    await screen.findByText("слово 7"); await waitFor(() => expect(field().readOnly).toBe(false));
    const later = requests(a, mark);
    const firstPost = later.indexOf("POST /api/v1/commands");
    expect(later.indexOf(`GET /api/v1/commands/${lost.command_id}`)).toBeLessThan(firstPost === -1 ? Infinity : firstPost);
    expect(a.kinds().filter(kind => kind === "answer.submit")).toHaveLength(1);
    expect(a.kinds().filter(kind => kind === "assignment.present")).toHaveLength(2);
  });

  it("an unclosed natural summary resumes as the summary; nothing is posted and completion is not signalled again", async () => {
    const a = app({ cards: [6] }); const first = render(<App />);
    await startWords(); await answer("falsch");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Занятие завершено.");
    first.unmount();
    const posts = a.posts().length, haptics = a.haptic.mock.calls.length;
    render(<App />);
    await screen.findByText("Занятие завершено.");
    expect(a.posts()).toHaveLength(posts);
    // Only the entry signal of the new document (TA §3: a duplicate never repeats a shown signal).
    expect(a.haptic.mock.calls.length - haptics).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText);
    expect(a.posts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "summary_home" } });
  });

  it("a present that never reached the server goes again by itself with the same ID; B's typed answer waits for it (Q25.1, Q25.2)", async () => {
    const a = app({ cards: [6, 7] }); render(<App />);
    await startWords(); await answer("Haus");
    dropRequest(a, "assignment.present");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("слово 7");
    const lost = a.posts().at(-1)!, posts = a.posts().length;
    expect(lost.kind).toBe("assignment.present");
    // B is typed under the short status, without a cover or a manual control; its answer is not sent yet (CT:107).
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(document.querySelector(".recovery-overlay")).toBeNull();
    for (const name of ["Проверить состояние", "Повторить отправку"]) expect(screen.queryByRole("button", { name })).toBeNull();
    fireEvent.change(field(), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    expect(a.posts()).toHaveLength(posts);
    await waitFor(() => expect(a.posts().length).toBeGreaterThan(posts), { timeout: 5000 });
    expect(a.posts().slice(posts).map(post => [post.kind, post.command_id])).toEqual([["assignment.present", lost.command_id]]);
    await waitFor(() => expect((screen.getByRole("button", { name: "Проверить" }) as HTMLButtonElement).disabled).toBe(false), exchange);
    expect(a.server.state.assignment).toBe("presented");
    expect(field().value).toBe("Haus");
    expect(screen.queryByText("Подтверждаем показ задания…")).toBeNull();
  });

  it("after a relaunch an unconfirmed present with an unknown count is only checked: B is typed, nothing is sent, no manual control (CT §6.1 п. 4)", async () => {
    const a = app({ cards: [6, 7] }); const first = render(<App />);
    await startWords(); await answer("Haus");
    dropRequest(a, "assignment.present"); const online = offlineStudy(a);
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("слово 7");
    const lost = a.posts().at(-1)!;
    first.unmount(); online();
    const mark = a.fetcher.mock.calls.length, posts = a.posts().length;
    render(<App />);
    await screen.findByText("слово 7");
    await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/commands/${lost.command_id}`), exchange);
    await waitFor(() => expect(field().readOnly).toBe(false), exchange);
    fireEvent.change(field(), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 3000)); });
    expect(a.posts()).toHaveLength(posts);
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(document.querySelector(".recovery-overlay")).toBeNull();
    for (const name of ["Проверить состояние", "Повторить отправку"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(a.server.state.assignment).toBe("prefetched");
  }, 15_000);
});

describe("Written start refused as SESSION_BUSY (В02)", () => {
  it("the busy Today asks before the remote stop: nothing is posted until «Завершить занятие», and Cancel posts nothing", async () => {
    const a = app({ refuseStart: "SESSION_BUSY" }), other = id(60), remote = { busy: false };
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
    remote.busy = true;
    fireEvent.click(row(/Слова: перевод на немецкий/));
    await screen.findByText("Занятие открыто на другом устройстве");
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await screen.findByRole("heading", { name: "Занятие на другом устройстве" });
    fireEvent.click(screen.getByRole("button", { name: "Завершить занятие на другом устройстве" }));
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
    expect(a.kinds()).toEqual(["session.start", "session.stop_remote"]);
  });
});
