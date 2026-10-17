import { useReducer, useState } from "react";
import type { ClosureNotices } from "../notices/noticeBoard";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, OralSessionProjection, SettingsResponse } from "../api/generated";
import { oralIntentHash, type OralCommand, type OralIntent } from "../oral/oralIntent";
import { OralSessionPendingStore, OralStopPendingStore } from "../oral/oralPending";
import type { AsyncStorage } from "../platform/storage";
import { SettingsPendingStore } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { useSettingsDocument } from "../settings/useSettingsDocument";
import { createOpenedAccess } from "./openedAccess";
import { oralBucket, useOralHost, type OralHost, type OralHostOptions } from "./OralHost";
import { testGate } from "../commands/testGate.test-support";
import { pendingRaw, seedRaw } from "../commands/pendingSeed.test-support";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const studyKey = "wortly.pending.oral_session";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Step = "prefetched" | "presented" | "revealed" | "summary" | "closed";
type Reason = OralSessionProjection["close_reason"];
function projection(step: Step, completed = 0, correct = 0, total = 2, session = id(3), reason: Reason = "stop"): OralSessionProjection {
  const active = step !== "summary" && step !== "closed", assignmentId = id(6 + completed * 2);
  return { session_id: session, status: active ? "active" : step as "summary" | "closed", mode: "oral", pair: "ru-de",
    direction: "de-l1", local_date: "2026-10-01", bucket: "words", close_reason: step === "closed" ? reason : null,
    progress: { completed, total, correct, wrong: completed - correct },
    assignment: active ? { id: assignmentId, card_id: id(7), status: step === "prefetched" ? "prefetched" : "presented",
      kind: "original", prompt: { text: completed === 0 ? "wenn" : "die Straße", language: "de", conjunction_hint: null },
      ...(step === "revealed" ? { status: "presented", revealed: true, translations: ["если"] } : { revealed: false }) } : null,
    summary: active ? null : { completed, correct, wrong: completed - correct, ratio: completed ? { numerator: correct, denominator: completed } : null },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: completed },
    capabilities: { reveal_target: step === "presented" ? assignmentId : null, grade_target: step === "revealed" ? assignmentId : null,
      stop: step !== "closed", summary_home: step === "summary" } };
}
const profile: OpenedClient["profile"] = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: "1", access: { status: "admitted", version: "1", reason: null } };
function fact(intent: OralIntent, status = "applied") {
  const grade = intent.kind === "oral.grade";
  return { id: intent.command_id, kind: intent.kind, status, applied_at: "2026-10-01T12:00:00Z",
    target_id: "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: grade ? id(10) : null, result_id: grade ? id(11) : null, context_id: null, object_version: grade ? "1" : null };
}
/** Telegram BackButton double: records click handlers. */
function fakeBack() {
  const handlers = new Set<() => void>();
  return { api: { show() {}, hide() {}, onClick(handler: () => void) { handlers.add(handler); }, offClick(handler: () => void) { handlers.delete(handler); } },
    get bound() { return handlers.size; }, click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}

type Options = { step?: Step | null; completed?: number; reason?: Reason; seed?: boolean; saved?: OralIntent; reject?: string;
  route?: OralHostOptions["route"]; holdRoute?: boolean; settings?: (data: SettingsResponse) => void; holdStop?: boolean;
  openCard?: boolean; closureNotices?: ClosureNotices & { changed?: () => void } };
/** A synthetic server model for one profile; it makes no claim of backend acceptance. */
function setup(options: Options = {}) {
  let counter = 100, version = 8n;
  let current: OralSessionProjection | null = options.step ? projection(options.step, options.completed ?? 0, options.completed ?? 0, 2, id(3), options.reason) : null;
  const values = new Map<string, string>(), accepted = new Map<string, OralIntent>(), posts: OralCommand[] = [];
  if (options.saved) seedRaw(values, studyKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent: options.saved }), id(50));
  const storage: AsyncStorage = { get: vi.fn(async k => values.get(k) ?? null),
    set: vi.fn(async (k, v) => { values.set(k, v); }), remove: vi.fn(async k => { values.delete(k); }) };
  const data = settingsResponse(); data.state_version = "1"; data.needs_setup = false;
  data.settings.dictionary_language.value = "ru"; data.settings.transition_mode.value = "normal"; options.settings?.(data);
  const stopGate = deferred<void>();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url), "https://model.invalid").pathname;
    if (path.endsWith("/settings")) return response(data);
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: data.state_version });
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as OralCommand; posts.push(command);
      const { client_instance_id: _client, document_id: _doc, ...intent } = command;
      if (command.kind === "session.start" && options.reject) {
        return response({ command: { id: command.command_id, status: "rejected" }, current: { session_id: command.session_id, status: "unavailable" },
          state_version: String(version), error: { code: options.reject } }, 409);
      }
      accepted.set(intent.command_id, intent);
      const progress = current?.progress ?? { completed: 0, correct: 0, total: 2 };
      const session = command.session_id;
      if (command.kind === "session.start") current = projection("prefetched", 0, 0, 2, session);
      else if (command.kind === "oral.grade") current = projection(progress.completed + 1 === progress.total ? "summary" : "prefetched",
        progress.completed + 1, progress.correct + Number(command.payload.correct), progress.total, session);
      else if (command.kind === "session.stop") current = projection("closed", progress.completed, progress.correct, progress.total, session, command.payload.reason);
      else current = projection(command.kind === "oral.reveal" ? "revealed" : "presented", progress.completed, progress.correct, progress.total, session);
      version++;
      const reply = { command: fact(intent), current, state_version: String(version) };
      if (command.kind === "session.stop" && options.holdStop) await stopGate.promise;
      return response(reply);
    }
    if (path.includes("/commands/")) {
      const commandId = path.split("/").at(-1)!, intent = accepted.get(commandId);
      return intent ? response({ command: fact(intent, "already_applied"), verified_intent_hash: await oralIntentHash(intent), current, state_version: String(version) })
        : response({ command: { id: commandId, status: "not_found" }, current: { ...profile, state_version: String(version) }, state_version: String(version) });
    }
    const session = path.split("/").at(-1)!;
    return response({ current: current ?? { session_id: session, status: "unavailable" }, state_version: String(version) });
  });
  const transport = { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() };
  const seed = options.seed ? id(3) : null;
  const access = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1",
    proof_version: "1", profile, session: seed ? { id: seed, phase: "active" } : null, compatibility: { compatible: true, contract_version: "1" } },
    token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => true, onDenied() {} });
  const stores = { study: new OralSessionPendingStore(storage), stop: new OralStopPendingStore(storage) };
  const settingsStore = new SettingsPendingStore(storage), back = fakeBack(), haptic = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { HapticFeedback: { notificationOccurred: haptic }, BackButton: back.api } });
  const onToday = vi.fn(), onOral = vi.fn(), onOpenCard = vi.fn(), host: { current: OralHost | null } = { current: null };
  let setRoute!: (route: OralHostOptions["route"]) => void;
  function Harness() {
    const [route, update] = useState<OralHostOptions["route"]>(options.route ?? (seed ? "oral" : "today")); setRoute = update;
    const settings = useSettingsDocument({ access, transport, pendingStore: settingsStore, onCurrent() {} });
    const [, repaintBoard] = useReducer((n: number) => n + 1, 0);
    if (options.closureNotices) options.closureNotices.changed = repaintBoard;
    const value = useOralHost({ access, transport, stores, newId: () => id(counter++), language: "ru", settings,
      initialSessionId: seed, seedPending: false, route, closureNotices: options.closureNotices,
      onOral: () => { onOral(); if (!options.holdRoute) update("oral"); }, onToday: intent => { onToday(intent); update("today"); },
      onOpenCard: options.openCard ? onOpenCard : undefined });
    host.current = value;
    return <>{value.screen}{route === "today" && <p data-testid="today">{value.blocksToday ? "held" : "shown"}</p>}</>;
  }
  render(<Harness />);
  const kinds = () => posts.map(post => post.kind);
  const commandChecks = () => fetcher.mock.calls.filter(([url, init]) => init?.method !== "POST" && String(url).includes("/commands/")).length;
  const sessionReads = () => fetcher.mock.calls.filter(([url, init]) => init?.method !== "POST" && String(url).includes("/sessions/")).length;
  return { posts, kinds, values, onToday, onOral, onOpenCard, host, back, haptic, stopGate, commandChecks, sessionReads,
    route: (route: OralHostOptions["route"]) => act(() => setRoute(route)), setCurrent: (next: OralSessionProjection) => { current = next; version++; } };
}
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const dd = () => Array.from(screen.getByRole("region", { name: "Итог занятия" }).querySelectorAll("dd"), e => e.textContent);
async function settled() { for (let i = 0; i < 3; i++) await act(async () => {}); }
async function gateOpen(h: ReturnType<typeof setup>) { await waitFor(() => expect(h.host.current?.canRequestStart).toBe(true)); }
function visible(state: "visible" | "hidden") { Object.defineProperty(document, "visibilityState", { configurable: true, value: state }); }
afterEach(() => { cleanup(); visible("visible"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("useOralHost: start, routing and Today", () => {
  it("O1 mount with empty slots claims nothing; Today waits only for the first recovery", async () => {
    const h = setup();
    expect(screen.getByTestId("today").textContent).toBe("held");
    await waitFor(() => expect(screen.getByTestId("today").textContent).toBe("shown"));
    await gateOpen(h); await settled();
    expect(h.posts).toEqual([]); expect(h.onOral).not.toHaveBeenCalled(); expect(h.onToday).not.toHaveBeenCalled();
    expect(h.commandChecks()).toBe(0); expect(h.sessionReads()).toBe(0); expect(h.back.bound).toBe(0);
  });

  it("O2 a De→L1 request starts exactly once with its bucket, confirms the commit and signals the accepted start once", async () => {
    const h = setup(); await gateOpen(h);
    expect(oralBucket({ material: "phrases", direction: "de-l1" })).toBe("phrases");
    expect(oralBucket({ material: "words", direction: "l1-de" })).toBeNull();
    act(() => { h.host.current!.requestStart({ material: "words", direction: "l1-de" }); });
    expect(h.onOral).not.toHaveBeenCalled();
    act(() => { h.host.current!.requestStart({ material: "words", direction: "de-l1" }); h.host.current!.requestStart({ material: "words", direction: "de-l1" }); });
    // Stage 1: the accepted start is visible. It alone carries the one-time synchronous cost of the first oral-route mount
    // in this file (DIAG_G1_CP10: 0.29-0.36 s isolated; the whole stage up to 0.84 s under full-suite load; the start chain
    // itself ~14 ms). No visible state separates that cost from the start, so this one stage gets a measured bound.
    await screen.findByText("wenn", undefined, { timeout: 1500 });
    // Stage 2: the visible-commit present makes Reveal available.
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
    expect(h.kinds()).toEqual(["session.start", "assignment.present"]);
    expect(h.posts[0]).toMatchObject({ kind: "session.start", payload: { mode: "oral", bucket: "words" } });
    expect(h.onOral).toHaveBeenCalledOnce(); expect(h.haptic).toHaveBeenCalledOnce(); expect(h.onToday).not.toHaveBeenCalled();
  });

  it("O3 a request dropped by foreground before consumption never starts and returns to Today once", async () => {
    const h = setup({ holdRoute: true }); await gateOpen(h);
    act(() => { h.host.current!.requestStart({ material: "phrases", direction: "de-l1" }); });
    expect(h.onOral).toHaveBeenCalledOnce();
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await h.route("oral"); await settled();
    expect(h.posts).toEqual([]); expect(h.onToday).toHaveBeenCalledOnce(); expect(h.haptic).not.toHaveBeenCalled();
  });

  it("O4 the gate is Settings identity only: another pair blocks, Learning setup fields do not", async () => {
    const other = setup({ settings: data => { data.settings.dictionary_language.value = "uk"; } });
    await waitFor(() => expect(screen.getByTestId("today").textContent).toBe("shown")); await settled();
    expect(other.host.current!.canRequestStart).toBe(false);
    act(() => { other.host.current!.requestStart({ material: "words", direction: "de-l1" }); }); await settled();
    expect(other.onOral).not.toHaveBeenCalled(); expect(other.posts).toEqual([]);
    cleanup(); vi.unstubAllGlobals();
    const learningUnset = setup({ settings: data => { data.needs_setup = true; data.settings.transition_mode.value = null; } });
    await gateOpen(learningUnset);
    act(() => { learningUnset.host.current!.requestStart({ material: "words", direction: "de-l1" }); });
    await waitFor(() => expect(learningUnset.kinds()[0]).toBe("session.start"));
  });

  it("O5 a durable unknown grade holds Today, is checked by GET with the same UUID and claims the oral route once", async () => {
    const saved: OralIntent = { command_id: id(90), session_id: id(3), assignment_id: id(6), kind: "oral.grade", payload: { correct: true } };
    const h = setup({ saved });
    expect(screen.getByTestId("today").textContent).toBe("held");
    await screen.findByText("Действие ещё не подтверждено. Проверь состояние.");
    // The text needs only the loaded receipt; its status GET follows the intent hash, so await the exchange itself.
    await waitFor(() => expect(h.commandChecks()).toBeGreaterThanOrEqual(1));
    expect(h.onOral).toHaveBeenCalledOnce();
    expect(h.posts).toEqual([]); expect(h.onToday).not.toHaveBeenCalled();
    expect(JSON.parse(pendingRaw(h.values, studyKey)!).intent.command_id).toBe(id(90));
  });

  // answer_loss in the open window (project notices §6, Т2; T1): the own Stop names the unconfirmed grade X; its summary
  // shows R2-05 from the notice and «На Сегодня» acknowledges before Today.
  it("O5n the own Stop while a grade is unconfirmed names X; the summary shows R2-05; «На Сегодня» acknowledges first", async () => {
    const saved: OralIntent = { command_id: id(90), session_id: id(3), assignment_id: id(6), kind: "oral.grade", payload: { correct: true } };
    const notice = { notice_id: id(101), kind: "answer_loss" as const, session_id: id(3), mode: "oral" as const, close_reason: "stop" as const,
      defect_class: null, created_at: "2026-10-07T00:00:01Z", summary: null };
    const board = { known: false, changed: undefined as undefined | (() => void),
      read: vi.fn(() => { board.known = true; queueMicrotask(() => board.changed?.()); }),
      find: vi.fn((sessionId: string) => board.known && sessionId.toLowerCase() === id(3) ? notice : null), leave: vi.fn(async () => true) };
    const h = setup({ saved, seed: true, step: "revealed", closureNotices: board });
    await waitFor(() => expect(button("Выйти").disabled).toBe(false), { timeout: 5000 });
    fireEvent.click(button("Выйти"));
    await screen.findByText("Последний ответ не сохранился. Остальные ответы сохранены.", undefined, { timeout: 5000 });
    expect(h.posts.filter(post => post.kind === "session.stop").map(post => post.payload)).toEqual([{ reason: "stop", unsaved_command_id: id(90) }]);
    expect(board.read).toHaveBeenCalledOnce();
    expect(h.onToday).not.toHaveBeenCalled();
    fireEvent.click(button("На Сегодня")); await settled();
    expect(board.leave).toHaveBeenCalledOnce(); expect(h.onToday).toHaveBeenCalledOnce();
  });

  // Q29 (fix5): the refusal stays on the oral screen until the person leaves it; its «На Сегодня» names the refused start
  // for the П01 episode only when it was refused SESSION_BUSY (startRefusalIntent).
  it.each(["NO_MATERIAL", "SESSION_BUSY"])("O6 a rejected start (%s) stays on the oral screen; its «На Сегодня» leaves once and never resends", async code => {
    const h = setup({ reject: code }); await gateOpen(h);
    act(() => { h.host.current!.requestStart({ material: "words", direction: "de-l1" }); });
    const today = await screen.findByRole("button", { name: "На Сегодня" }); await settled();
    expect(h.onToday).not.toHaveBeenCalled();
    fireEvent.click(today); await settled();
    expect(h.onToday).toHaveBeenCalledOnce();
    expect(h.onToday).toHaveBeenCalledWith(code === "SESSION_BUSY" ? { startRefused: h.posts[0].command_id } : undefined);
    expect(h.kinds()).toEqual(["session.start"]); expect(h.haptic).not.toHaveBeenCalled();
  });
});

describe("useOralHost: closure, summary, native Back and haptics", () => {
  it("O7 native Back on a question is Exit; the own summary stays until На Сегодня or Back, never automatically", async () => {
    const h = setup({ step: "presented", seed: true });
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false)); expect(h.back.bound).toBe(1);
    await h.back.click();
    await waitFor(() => expect(dd()).toEqual(["0", "0", "0", "2"]));
    expect(h.posts.map(post => post.payload)).toEqual([{ reason: "stop" }]); await settled();
    expect(h.onToday).not.toHaveBeenCalled(); expect(h.haptic).not.toHaveBeenCalled();
    await h.back.click(); expect(h.onToday).toHaveBeenCalledOnce();
    expect(h.kinds()).toEqual(["session.stop"]);
  });

  it("O8 На Сегодня on the own summary only navigates", async () => {
    const h = setup({ step: "revealed", seed: true });
    await waitFor(() => expect(button("Выйти").disabled).toBe(false)); fireEvent.click(button("Выйти"));
    await waitFor(() => expect(dd()).toEqual(["0", "0", "0", "2"]));
    fireEvent.click(button("На Сегодня")); await settled();
    expect(h.onToday).toHaveBeenCalledOnce(); expect(h.kinds()).toEqual(["session.stop"]);
  });

  // Q32 вар.1, R4-03 (tz_app.md:295, SHA-16 7d949301; Codex C520): before M1a an external closure returned to Today by
  // itself without a summary; now the open window keeps its summary with the reason until the explicit «На Сегодня».
  const forced = [["midnight", "Занятие закрыто: начался новый день"], ["timezone_date_changed", "Занятие закрыто: сменилась дата"],
    ["remote_stop", "Занятие завершено на другом устройстве"], ["pair_changed", "Занятие закрыто: изменилась языковая пара"]] as const;
  it.each(forced)(
    "O9b (Q32) %s: native Back on that summary is the same explicit way to Today, once, nothing sent", async (reason, line) => {
      const h = setup({ step: "closed", reason, seed: true });
      await screen.findByText(line, undefined, { timeout: 5000 });
      await waitFor(() => expect(h.back.bound).toBe(1));
      expect(h.onToday).not.toHaveBeenCalled();
      await h.back.click(); await settled();
      expect(h.onToday).toHaveBeenCalledOnce(); expect(h.posts).toEqual([]);
    });
  it.each(forced)(
    "O9 (Q32) an external closure (%s) stays on its summary with the reason; only «На Сегодня» or Back leaves, once", async (reason, line) => {
      const h = setup({ step: "closed", reason, seed: true });
      await screen.findByText(line, undefined, { timeout: 5000 }); await settled();
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
      expect(h.onToday).not.toHaveBeenCalled(); expect(screen.getByRole("region", { name: "Итог занятия" })).toBeTruthy();
      // The numbers of this pair's closed projection (the harness core keeps the pair); C178 bars only another pair's.
      expect(dd()).toEqual(["0", "0", "0", "2"]);
      fireEvent.click(button("На Сегодня")); await settled();
      expect(h.onToday).toHaveBeenCalledOnce(); expect(h.posts).toEqual([]); expect(h.haptic).not.toHaveBeenCalled();
    });

  it("O10 the natural summary: Back mirrors На Сегодня (summary_home), and its confirmed closure returns to Today once", async () => {
    const h = setup({ step: "summary", completed: 2, seed: true });
    await waitFor(() => expect(dd()).toEqual(["2", "2", "0", "0"]), { timeout: 5000 }); expect(h.haptic).not.toHaveBeenCalled();
    // Back is bound by an effect after the summary is drawn; a click before that reaches no handler and sends no Stop.
    await waitFor(() => expect(h.back.bound).toBe(1));
    await h.back.click();
    await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce(), { timeout: 5000 }); await settled();
    expect(h.posts.map(post => post.payload)).toEqual([{ reason: "summary_home" }]); expect(h.onToday).toHaveBeenCalledOnce();
  });

  it("O11 the own last grade signals completion once; closing the summary afterwards signals nothing", async () => {
    const h = setup({ step: "revealed", completed: 1, seed: true });
    await waitFor(() => expect(button("Правильно").disabled).toBe(false)); fireEvent.click(button("Правильно"));
    await waitFor(() => expect(dd()).toEqual(["2", "2", "0", "0"])); await settled();
    expect(h.haptic).toHaveBeenCalledOnce();
    await h.back.click(); await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
    expect(h.haptic).toHaveBeenCalledOnce();
  });

  it("O12 while a sent Stop is awaited Back stays bound and sends nothing more", async () => {
    const h = setup({ step: "presented", seed: true, holdStop: true });
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
    await h.back.click(); await waitFor(() => expect(h.kinds()).toEqual(["session.stop"]));
    await h.back.click(); await h.back.click(); expect(h.back.bound).toBe(1);
    expect(h.kinds()).toEqual(["session.stop"]);
    await act(async () => { h.stopGate.resolve(); });
    await waitFor(() => expect(dd()).toEqual(["0", "0", "0", "2"])); expect(h.onToday).not.toHaveBeenCalled();
  });
});

// M-ORAL-ENTRY: М18 opens the question's card on top of the quiz; the hidden owner keeps the same question for Back.
describe("useOralHost: «Уточнить поля» and the return from the card", () => {
  it.each(["presented", "revealed"] as const)("C1 %s question: the card opens with its question, Back returns to it without a command", async step => {
    const h = setup({ step, seed: true, openCard: true });
    const control = step === "presented" ? "Раскрыть" : "Правильно";
    await waitFor(() => expect(button(control).disabled).toBe(false));
    fireEvent.click(button("Уточнить поля"));
    expect(h.onOpenCard).toHaveBeenCalledExactlyOnceWith(id(7), { assignment: id(6) });
    // The card route hides the owner: no screen, no Back of its own (the card's Back belongs to the document).
    await h.route("hidden"); await settled();
    expect(screen.queryByText("wenn")).toBeNull(); expect(h.back.bound).toBe(0);
    const reads = h.sessionReads();
    await h.route("oral");
    await waitFor(() => expect(button(control).disabled).toBe(false));
    expect(screen.getByText("wenn")).toBeTruthy();
    // The reveal is server state: it survives the card, and a hidden question stays hidden.
    expect(screen.queryByText("если") !== null).toBe(step === "revealed");
    expect(h.sessionReads()).toBeGreaterThan(reads);
    expect(h.posts).toEqual([]); expect(h.onToday).not.toHaveBeenCalled(); expect(h.back.bound).toBe(1);
  });

  it("C2 without the document option the oral screen has no «Уточнить поля»", async () => {
    setup({ step: "presented", seed: true });
    await waitFor(() => expect(button("Раскрыть").disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Уточнить поля" })).toBeNull();
  });
});
