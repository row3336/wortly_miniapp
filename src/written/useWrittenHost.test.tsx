import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, Profile } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { SettingsDocument } from "../settings/useSettingsDocument";
import { useWrittenHost } from "./useWrittenHost";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { settingsRefusalText } from "./writtenApp.test-support";
import { profile, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => cleanup());
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function access(live: boolean, status: "admitted" | "pending" | "denied") {
  const profile = { profile_id: id(1), access: { status, version: "1", reason: null }, role: "user", ui_language: "ru",
    dictionary_language: "uk", time_zone: "UTC", state_version: "10" } as unknown as Profile;
  const opened = { status: "opened", profile, compatibility: { compatible: true, contract_version: "1" }, client_instance_id: id(2),
    document_id: id(3), proof_version: "1", document_epoch: "1", session: null } as unknown as OpenedClient;
  return createOpenedAccess({ opened, token: "t", proof: "p", generation: 1, isLive: () => live, onDenied: () => undefined });
}
const settings = { state: { phase: "loading", data: null, dataCurrent: false, drafts: {}, pending: null, outcome: null, problem: null,
  canEdit: false, canRetry: false }, confirmed: null, actions: { refresh: vi.fn(async () => undefined) } } as unknown as SettingsDocument;
function Probe({ live, status }: { live: boolean; status: "admitted" | "pending" | "denied" }) {
  const host = useWrittenHost({ access: access(live, status), transport: {} as never, storage: {} as never, newId: () => id(9), language: "ru",
    settings, initialSessionId: null, route: "written", onWritten: () => undefined, onToday: () => undefined });
  return <>{host.screen}</>;
}
describe("Written host: refusal versus loading before the owner exists", () => {
  it("dead access: the refusal with its two buttons, not a loading status", () => {
    render(<Probe live={false} status="admitted" />);
    expect(screen.getByText(settingsRefusalText)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Обновить настройки" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    expect(screen.queryByText("Загружаем занятие…")).toBeNull();
  });
  it("a live access that is not admitted: the refusal, not a loading status", () => {
    render(<Probe live={true} status="pending" />);
    expect(screen.getByText(settingsRefusalText)).toBeTruthy();
    expect(screen.queryByText("Загружаем занятие…")).toBeNull();
  });
});

/** Confirmed current settings of this pair (TA §5 gate): ready, current, nothing pending, a transition mode. */
function confirmedSettings(pair: "ru" | "uk", version: string): SettingsDocument {
  const confirmed = settingsResponse(); confirmed.needs_setup = false; confirmed.state_version = version;
  confirmed.settings.dictionary_language.value = pair; confirmed.settings.transition_mode.value = "normal";
  return { state: { phase: "ready", data: confirmed, dataCurrent: true, drafts: {}, pending: null, outcome: null, problem: null,
    canEdit: true, canRetry: false }, confirmed, actions: { refresh: vi.fn(async () => undefined) } } as unknown as SettingsDocument;
}
describe("Written host: a closure of the quiz (Q27-А, TA:164)", () => {
  it("TA:164 a saved pair change from this window's Settings closes the quiz and leaves Today, never its summary", async () => {
    const f = writtenFixture({ cards: [6, 7, 8] }), onWritten = vi.fn(), onToday = vi.fn();
    const seen: { host: ReturnType<typeof useWrittenHost> | null } = { host: null };
    function Host({ route, pair }: { route: "today" | "written" | "hidden"; pair: "ru" | "uk" }) {
      const host = useWrittenHost({ access: f.access(), transport: f.transport, storage: f.storage, newId: f.newId, language: "ru",
        settings: confirmedSettings(pair, f.access().profile.state_version), initialSessionId: null, route, onWritten, onToday });
      seen.host = host;
      return <>{host.screen}</>;
    }
    const view = render(<Host route="written" pair="ru" />);
    await waitFor(() => expect(seen.host?.canRequestStart).toBe(true));
    act(() => seen.host!.requestStart("words"));
    await screen.findByText("слово 6");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(false));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Верно");
    // Settings of this window save the new pair: the server closes the quiz and the profile carries the new pair.
    view.rerender(<Host route="hidden" pair="ru" />);
    Object.assign(f.server.state, { status: "closed", closeReason: "pair_changed", assignment: null, version: f.server.state.version + 1 });
    f.replace({ profile: { ...profile(String(f.server.state.version)), dictionary_language: "uk" } });
    view.rerender(<Host route="today" pair="uk" />);
    await waitFor(() => expect(seen.host?.blocksToday).toBe(false));
    expect(onWritten).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe("");
    expect(screen.queryByText("Занятие прервано.")).toBeNull();
    expect(f.posts().filter(post => post.kind === "session.stop")).toHaveLength(0);
  });
});

// NOTICE_PENDING (project notices §6.1, T5): a start refused because a notice waits tells the document once (it reads
// GET /notices and shows the notice); the owner sends nothing more for it — no new ID, no POST.
describe("Written host: a start refused NOTICE_PENDING", () => {
  it.each([["NOTICE_PENDING", 1], ["SESSION_BUSY", 0]] as const)("%s tells a pending notice %s time(s); one start only", async (code, told) => {
    const f = writtenFixture({ cards: [6, 7, 8] }), onNoticePending = vi.fn(), starts: string[] = [];
    const transport = { ...f.transport, fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.method === "POST" && init.body ? JSON.parse(String(init.body)) : null;
      if (body?.kind === "session.start" && String(url).endsWith("/commands")) {
        starts.push(body.command_id);
        return new Response(JSON.stringify({ command: { id: body.command_id, status: "rejected" },
          current: { session_id: body.session_id, status: "not_found" }, state_version: f.access().profile.state_version,
          error: { code } }), { status: 409 });
      }
      return f.transport.fetcher(url, init);
    }) as typeof fetch };
    const seen: { host: ReturnType<typeof useWrittenHost> | null } = { host: null };
    function Host() {
      const host = useWrittenHost({ access: f.access(), transport, storage: f.storage, newId: f.newId, language: "ru",
        settings: confirmedSettings("ru", f.access().profile.state_version), initialSessionId: null, route: "written",
        onWritten: () => undefined, onToday: () => undefined, onNoticePending });
      seen.host = host;
      return <>{host.screen}</>;
    }
    render(<Host />);
    await waitFor(() => expect(seen.host?.canRequestStart).toBe(true));
    act(() => seen.host!.requestStart("words"));
    await waitFor(() => expect(starts).toHaveLength(1));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
    expect(onNoticePending).toHaveBeenCalledTimes(told);
    expect(starts).toHaveLength(1);
  });
});

// answer_loss in the open window (project notices §6, Т2; core 35c3844 N3): the own Stop names the unconfirmed answer X,
// the closed summary reads GET /notices once and shows R2-05; its «На Сегодня» acknowledges before Today.
describe("Written host: answer_loss after the own Stop with X", () => {
  it("the summary shows R2-05 from the notice; «На Сегодня» acknowledges first, a failed ack keeps the summary", async () => {
    const f = writtenFixture({ cards: [6, 7, 8] }), onToday = vi.fn();
    const transport = { ...f.transport, fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.method === "POST" && init.body ? JSON.parse(String(init.body)) : null;
      if (body?.kind === "answer.submit") { dropped.push(body.command_id); throw new TypeError("network"); }
      return f.transport.fetcher(url, init);
    }) as typeof fetch };
    const dropped: string[] = [];
    const acks: boolean[] = [false, true];
    const notice = (sessionId: string) => ({ notice_id: id(101), kind: "answer_loss" as const, session_id: sessionId, mode: "written" as const,
      close_reason: "stop" as const, defect_class: null, created_at: "2026-10-07T00:00:01Z", summary: null });
    // The document re-renders its hosts when the board changes (useNoticeBoard); modelled by `changed`.
    let changed = () => {};
    const board = { known: false, read: vi.fn(() => { board.known = true; queueMicrotask(() => changed()); }),
      find: vi.fn((sessionId: string) => board.known ? notice(sessionId) : null), leave: vi.fn(async () => acks.shift()!) };
    const seen: { host: ReturnType<typeof useWrittenHost> | null } = { host: null };
    function Host() {
      const [, repaint] = useReducer((n: number) => n + 1, 0); changed = repaint;
      const host = useWrittenHost({ access: f.access(), transport, storage: f.storage, newId: f.newId, language: "ru",
        settings: confirmedSettings("ru", f.access().profile.state_version), initialSessionId: null, route: "written",
        onWritten: () => undefined, onToday, closureNotices: board });
      seen.host = host;
      return <>{host.screen}</>;
    }
    const view = render(<Host />);
    await waitFor(() => expect(seen.host?.canRequestStart).toBe(true));
    act(() => seen.host!.requestStart("words"));
    await screen.findByText("слово 6");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(false));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await screen.findByText("Последний ответ не сохранился. Остальные ответы сохранены.");
    // X: the answer whose request never reached the core (dropped before it) — its stored record names it.
    const stop = f.posts().find(post => post.kind === "session.stop")!;
    expect(Object.keys(stop.payload).sort()).toEqual(["reason", "unsaved_command_id"]);
    expect(stop.payload.reason).toBe("stop");
    expect(new Set(dropped)).toEqual(new Set([stop.payload.unsaved_command_id]));
    expect(f.server.lostAnswers).toEqual([{ sessionId: stop.session_id, commandId: stop.payload.unsaved_command_id, reason: "stop" }]);
    expect(board.read).toHaveBeenCalledOnce();
    expect(screen.getByText("Занятие завершено.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await waitFor(() => expect(board.leave).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(onToday).not.toHaveBeenCalled();
    expect(screen.getByText("Последний ответ не сохранился. Остальные ответы сохранены.")).toBeTruthy();
    fireEvent.click(await waitFor(() => { const b = screen.getByRole("button", { name: "На Сегодня" }) as HTMLButtonElement;
      expect(b.disabled).toBe(false); return b; }));
    await waitFor(() => expect(onToday).toHaveBeenCalledOnce());
    expect(board.leave).toHaveBeenCalledTimes(2);
    view.unmount();
  });
});

// Т2 (project notices §5): only a closure with X reads GET /notices — a plain Stop reads nothing more (QA M1b P3).
describe("Written host: a plain Stop reads no notices", () => {
  it("Stop without an unconfirmed answer: payload {reason}, no read of the board, Today without acknowledgement", async () => {
    const f = writtenFixture({ cards: [6, 7, 8] }), onToday = vi.fn();
    const board = { read: vi.fn(), find: vi.fn(() => null), leave: vi.fn(async () => true) };
    const seen: { host: ReturnType<typeof useWrittenHost> | null } = { host: null };
    function Host() {
      const host = useWrittenHost({ access: f.access(), transport: f.transport, storage: f.storage, newId: f.newId, language: "ru",
        settings: confirmedSettings("ru", f.access().profile.state_version), initialSessionId: null, route: "written",
        onWritten: () => undefined, onToday, closureNotices: board });
      seen.host = host;
      return <>{host.screen}</>;
    }
    render(<Host />);
    await waitFor(() => expect(seen.host?.canRequestStart).toBe(true));
    act(() => seen.host!.requestStart("words"));
    await screen.findByText("слово 6");
    await waitFor(() => expect(screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).toHaveProperty("disabled", false));
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await screen.findByText("Занятие прервано.");
    expect(f.posts().find(post => post.kind === "session.stop")!.payload).toEqual({ reason: "stop" });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(board.read).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await waitFor(() => expect(onToday).toHaveBeenCalledOnce());
    expect(board.leave).not.toHaveBeenCalled();
  });
});
