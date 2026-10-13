import { createHash } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningCommandIntent } from "../learning/learningCommandIntent";
import type { Profile, SettingCommand, SettingsResponse, TodayResponse } from "../api/generated";
import { previewContent } from "../learning/learningPreview.test-support";
import { learningViewFixture } from "../learning/learningView.test-support";
import { current, deferred, id, missing, profile, response } from "../learning/learningFixtures.test-support";
import { settingsSlotOf } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { SETTINGS_RESET_SLOT, settingsResetSlotOf } from "../settings/settingsResetPending";
import { SessionResumeController } from "../study/sessionResumeController";
import { App } from "./App";
import { enabledExits, foregroundOpen, loseReply as loseStudyReply, moveWithout, noLandings, pairMoved, settle as pause,
  watchCommits } from "./pairMoved.test-support";
import { gate, refuseOnce, replaceDocument, watchFlash } from "./flashWatch.test-support";
import { staleCommand, staleRefusal } from "./openRules.test-support";
import { cardIdOf } from "../dictionary/card/cardTestData.test-support";
import { besidesContext, launch, serveLaunchCard } from "./launchCard.test-support";

/**
 * 2.3-А with a known send count (QA-R1-V3 F6): the page's send counter as the owners get it. Transparent unless a test
 * seeds marks: every load is recorded, and `marks` is stored for `ids` whenever an owner takes the counter.
 */
const sendCount = vi.hoisted(() => ({ marks: null as number | null, ids: [] as string[], loads: [] as string[],
  loaded: [] as { commandId: string; transmitted: number | null }[] }));
vi.mock("../commands/laneRecovery", async importOriginal => {
  const original = await importOriginal<typeof import("../commands/laneRecovery")>();
  const wrapped = new WeakSet<object>();
  return { ...original, pageSendCounter: (storage: Parameters<typeof original.pageSendCounter>[0]) => {
    const counter = original.pageSendCounter(storage);
    if (!wrapped.has(counter)) {
      wrapped.add(counter);
      const load = counter.load.bind(counter);
      counter.load = async (commandId: string) => {
        sendCount.loads.push(commandId);
        const marks = await load(commandId);
        sendCount.loaded.push({ commandId, transmitted: marks?.transmitted ?? null });
        return marks;
      };
    }
    // Stored again for every owner that takes the counter: an owner of the old pair may clear X meanwhile.
    if (sendCount.marks !== null) for (const commandId of sendCount.ids) {
      void counter.save(commandId, { reserved: sendCount.marks, transmitted: sendCount.marks });
    }
    return counter;
  } };
});

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Route = (url: string | URL | Request, init: RequestInit | undefined, base: Fetch) => Promise<Response>;
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";
/** A wait for a screen that arrives after a chain of server exchanges (open, Today, session read): not the default 1 s. */
const exchange = { timeout: 5000 };
/** The unresolved save of this profile (id 50) lives in its own slot (R3-02); the legacy global key is only read. */
const settingSlot = settingsSlotOf(id(50));
const example = { id: id(30), text: "Hallo, wie geht's?", role: null, highlighted_parts: [] };

function today(status: TodayResponse["learning"]["status"] = "new_group"): TodayResponse {
  return { state_version: "1", pair: "ru-de", local_date: "2026-09-30", status: "work_now",
    base: { total: 4, words: 4, phrases: 0 }, ordinary_status: "done",
    ordinary: { words: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } },
      phrases: { "l1-de": { ready: 0, next_due_date: null }, "de-l1": { ready: 0, next_due_date: null } } },
    learning: { status, ready: 0, preview: 0, next_due_at: status === "waiting" ? "2026-10-01T00:00:00Z" : null,
      new_group_size: status === "new_group" ? 4 : 0, manual_eligible: 0, automatic_eligible: 4 },
    conjugation: { ready: 0, openable: 0, next_due_date: null }, next_repeat_date: null };
}

/** Telegram BackButton double: records show/hide and click handlers in call order. */
function fakeBack() {
  const handlers = new Set<() => void>(), log: string[] = [];
  let visible = false, max = 0;
  const api = {
    show() { visible = true; log.push("show"); }, hide() { visible = false; log.push("hide"); },
    onClick(handler: () => void) { handlers.add(handler); max = Math.max(max, handlers.size); log.push("on"); },
    offClick(handler: () => void) { handlers.delete(handler); log.push("off"); },
  };
  return { api, log, get visible() { return visible; }, get handlers() { return handlers.size; }, get max() { return max; },
    shows: () => log.filter(event => event === "show").length,
    click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}

/** The real App over one synthetic server: entry, Settings and Today here, Learning in the accepted view fixture. */
function app(options: { session?: string | null; status?: TodayResponse["learning"]["status"]; transitionMode?: "normal" | null;
  back?: ReturnType<typeof fakeBack>;
  /** "1": the dictionary language is not chosen yet (19.2-А); by default it is (field version 2). */
  dictionaryVersion?: string } = {}) {
  const f = learningViewFixture("normal", null); f.view.dispose(); f.owner.dispose();
  // One global state version, as on the server: Settings and open never lag behind an accepted study command.
  let version = 1n;
  const server = { session: options.session ?? null as string | null };
  // The study fixture keeps its own counter; a Settings save advances only the global one. Every study reply carries the
  // global version (a POST advances it), as the single server state would.
  const observe = async (reply: Response, init?: RequestInit) => {
    const value = await reply.clone().json().catch(() => null) as { state_version?: unknown } | null;
    if (typeof value?.state_version !== "string") return reply;
    if (init?.method === "POST") version++;
    if (BigInt(value.state_version) > version) version = BigInt(value.state_version);
    return response({ ...value, state_version: String(version) }, reply.status);
  };
  let learning: Fetch = async (url, init) => observe(await f.handler(url, init), init);
  // One persistent Settings store; profile, Today pair and Settings follow saved values.
  const stored = settingsResponse(); stored.needs_setup = false;
  stored.settings.ui_language.value = "ru"; stored.settings.dictionary_language.value = "ru";
  if (options.dictionaryVersion) stored.settings.dictionary_language.version = options.dictionaryVersion;
  stored.settings.transition_mode.value = options.transitionMode === undefined ? "normal" : options.transitionMode;
  const settingsData = (): SettingsResponse => ({ ...structuredClone(stored), state_version: String(version) });
  const account = (): Profile => ({ ...profile(String(version)), ui_language: stored.settings.ui_language.value as Profile["ui_language"],
    dictionary_language: stored.settings.dictionary_language.value as Profile["dictionary_language"] });
  const settingsReply = vi.fn(async () => response(settingsData()));
  const save = (command: SettingCommand) => {
    const setting = stored.settings[command.payload.key as keyof SettingsResponse["settings"]];
    const changedPair = command.payload.key === "dictionary_language" && command.payload.value !== setting.value;
    Object.assign(setting, { value: structuredClone(command.payload.value), version: String(BigInt(setting.version) + 1n) });
    version++;
    // As on the server, a dictionary pair change closes the open study session.
    if (changedPair && server.session !== null) {
      f.setStep({ ...current(server.session), status: "closed", close_reason: "pair_changed", assignment: null, preview: null });
      server.session = null;
    }
    const { state_version: _, ...projection } = settingsData();
    return response({ command: { id: command.command_id, kind: "setting.save", status: "applied", applied_at: "2026-09-30T00:00:00Z",
      target_id: id(50), action_id: null, result_id: null, context_id: null,
      object_version: String(BigInt(command.expected_field_version) + 1n) }, current: projection, state_version: String(version) });
  };
  let openGate: Promise<void> | null = null;
  const openReply = vi.fn(async (body: { client_instance_id: string; document_id: string }) => {
    const gate = openGate; openGate = null; if (gate) await gate;
    return response({ status: "opened", profile: account(), compatibility, client_instance_id: body.client_instance_id,
      document_id: body.document_id, proof_version: "1", document_epoch: "1",
      session: server.session === null ? null : { id: server.session, phase: "active" } });
  });
  const todayReply = vi.fn(async () => response({ ...today(options.status), pair: `${account().dictionary_language}-de` }));
  const fetcher = vi.fn<Fetch>(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/commands") && body?.kind === "setting.save") return save(body);
    if (path.endsWith("/auth/telegram")) return response({ access_token: "synthetic-token", expires_at: "2026-10-01T00:00:00Z",
      profile: account(), compatibility });
    if (path.endsWith("/client/register")) return response({ client_instance_id: body.client_instance_id, status: "registered",
      origin_proof: "synthetic-proof", proof_version: "1", activated: false });
    if (path.endsWith("/client/open")) return openReply(body);
    if (path.endsWith("/today")) return todayReply();
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: String(version) });
    if (path.endsWith("/settings")) return settingsReply();
    return learning(url, init);
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("Telegram", { WebApp: { initData: "synthetic-init-data", initDataUnsafe: { user: { language_code: "ru" } },
    colorScheme: "light", HapticFeedback: { notificationOccurred: vi.fn() }, ...(options.back ? { BackButton: options.back.api } : {}) } });
  const posts = (): (LearningCommandIntent & Record<string, unknown>)[] => fetcher.mock.calls
    .filter(([url, init]) => init?.method === "POST" && String(url).endsWith("/commands")).map(([, init]) => JSON.parse(String(init!.body)));
  const studyPosts = () => posts().filter(post => (post.kind as string) !== "setting.save");
  const gets = (fragment: string) => fetcher.mock.calls.filter(([url, init]) => init?.method !== "POST" && String(url).includes(fragment));
  return { f, server, settingsReply, openReply, todayReply, fetcher, posts, studyPosts, gets,
    route(next: Route) { const base = learning; learning = (url, init) => next(url, init, base); },
    holdOpen(gate: Promise<void>) { openGate = gate; },
    /** Another device changed the dictionary pair: profile, Settings and Today follow it; the study fixture keeps its step. */
    changePairElsewhere(value: "en" | "ru" | "uk") { stored.settings.dictionary_language.value = value; version++; },
    version: () => String(version) };
}
type Server = ReturnType<typeof app>;
const isPost = (init: RequestInit | undefined, kind: string) => init?.method === "POST" && JSON.parse(String(init.body)).kind === kind;

async function settled() { for (let i = 0; i < 3; i++) await act(async () => {}); }
async function startButton(a: Server) {
  // The first App render of a file pays the cold module start (about 1.2 s on a loaded machine), beyond the default 1 s.
  await screen.findByRole("button", { name: /Новая группа слов/ }, exchange);
  await waitFor(() => expect(a.settingsReply).toHaveBeenCalled()); await settled();
  return screen.getByRole("button", { name: /Новая группа слов/ });
}
async function editable() {
  const input = await screen.findByRole("textbox");
  await waitFor(() => expect((input as HTMLInputElement).readOnly).toBe(false));
  return input as HTMLInputElement;
}
async function startToQuestion(a: Server) {
  render(<App />);
  fireEvent.click(await startButton(a));
  fireEvent.click(await screen.findByRole("button", { name: "Дальше" }));
  const input = await editable();
  a.server.session = a.posts()[0].session_id;
  return input;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubEnv("VITE_WORTLY_TIMEOUT_MS", "30000"); vi.stubEnv("VITE_WORTLY_MAX_RESPONSE_BYTES", "100000");
  vi.stubEnv("VITE_WORTLY_API_BASE_URL", "");
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Learning through the actual App document", () => {
  it("1: starts once only on an explicit tap and shows M07 through the approved card renderer", async () => {
    const a = app(); render(<App />);
    await startButton(a);
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await waitFor(() => expect(a.settingsReply).toHaveBeenCalledTimes(2)); await settled();
    expect(a.openReply).toHaveBeenCalledTimes(2); expect(a.posts()).toEqual([]);
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.start")) return base(url, init);
      const value = await (await base(url, init)).json();
      value.current.preview.content.examples = { common: [example], personal: null };
      a.f.setStep(value.current); return response(value);
    });
    const button = await startButton(a);
    fireEvent.click(button); fireEvent.click(button);
    await screen.findByText("Hallo, wie geht's?");
    expect(a.posts().map(post => post.kind)).toEqual(["session.start"]);
    expect(screen.getByText("1 / 1")).toBeTruthy(); expect(screen.getByText("Hallo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Дальше" })); await editable();
    expect(a.posts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
    expect(a.posts()[1].preview_id).toBe(id(20)); expect(a.openReply).toHaveBeenCalledTimes(2);
  });

  it("1: a waiting group has no Start", async () => {
    const a = app({ status: "waiting" }); render(<App />);
    await screen.findByText("Learning ждёт следующего этапа"); await settled();
    expect(screen.queryByRole("button", { name: /Новая группа слов/ })).toBeNull(); expect(a.posts()).toEqual([]);
  });

  it("2: resumes a server-confirmed Learning session and keeps it across a reload without Start", async () => {
    const a = app({ session: id(3) }); render(<App />);
    await editable(); expect(screen.getAllByText("дом").length).toBeGreaterThan(0);
    cleanup(); render(<App />);
    await editable(); await settled();
    expect(a.posts()).toEqual([]); expect(a.todayReply).not.toHaveBeenCalled();
    expect(a.gets("/sessions/").every(([url]) => String(url).includes(`/sessions/${id(3)}?`))).toBe(true);
  });

  it("2: a summary is not closed before its explicit tap", async () => {
    const a = app({ session: id(3) }); a.f.setStep({ ...current(), status: "summary", assignment: null });
    render(<App />); await screen.findByRole("button", { name: "Вернуться на Сегодня" }); await settled();
    expect(a.posts()).toEqual([]); expect(a.todayReply).not.toHaveBeenCalled();
  });

  // An active Written step is valid only with its assignment (sessionProjection.ts:74-75).
  const written = { session_id: id(3), mode: "written", status: "active", pair: "ru-de", direction: "l1-de", local_date: "2026-09-30",
    bucket: "words", close_reason: null, progress: { completed: 0, total: 2, correct: 0, wrong: 0 }, summary: null,
    assignment: { id: id(6), card_id: id(7), status: "presented", kind: "original",
      prompt: { text: "дом", language: "ru", translations: ["дом"], personal_translation_version: null, conjunction_hint: null },
      answer_spec: { kind: "word", labels: ["word"], part_count: 1, case_sensitive: true } } };
  const oral = { session_id: id(3), status: "active", mode: "oral", pair: "ru-de", direction: "de-l1", local_date: "2026-10-01",
    bucket: "words", close_reason: null, progress: { completed: 0, total: 2, correct: 0, wrong: 0 },
    assignment: { id: id(6), card_id: id(7), status: "prefetched", kind: "original", prompt: { text: "wenn", language: "de",
      conjunction_hint: { meaning_category: "Bedingung", verb_position: "am Ende" } }, revealed: false },
    summary: null, practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
    capabilities: { reveal_target: null, grade_target: null, stop: true, summary_home: false } };
  const conjugation = { session_id: id(3), status: "active", mode: "conjugation", pair: "ru-de", direction: "conjugation",
    local_date: "2026-10-01", close_reason: null, progress: { total: 3, completed: 1, correct: 1, wrong: 0 },
    assignment: { id: id(5), card_id: id(8), status: "presented", kind: "conjugation", cycle_id: id(9),
      slot_id: { cycle_id: id(9), pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
      prompt: { verb: "ankommen", translation: "прибывать", language: "ru", pronoun: "du", tense: "present" },
      answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } }, summary: null,
    capabilities: { answer_target: id(5), correct_target: null, grades: null, undo_target: null, stop: true, summary_home: false } };
  it("2: an unavailable session is never routed into Learning", async () => {
    const a = app({ session: id(3) });
    a.route(async (url, init, base) => String(url).includes("/sessions/")
      ? response({ current: { session_id: id(3), status: "unavailable" }, state_version: "1" }) : base(url, init));
    render(<App />); await screen.findByText("Не удалось загрузить план"); await settled();
    expect(a.posts()).toEqual([]); expect(a.gets("/commands/")).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull(); expect(a.todayReply).not.toHaveBeenCalled();
  });
  // M-CONJ-HOST: an open conjugation session of this client continues on its own screen at the server's form (tz_app:48).
  it("2: a conjugation session is never routed into Learning and continues on the conjugation screen", async () => {
    const a = app({ session: id(3) });
    a.route(async (url, init, base) => String(url).includes("/sessions/") ? response({ current: conjugation, state_version: "1" }) : base(url, init));
    render(<App />); await screen.findByRole("heading", { name: "Тест спряжений", level: 1 }, exchange); await editable(); await settled();
    expect(screen.getByText("ankommen")).toBeTruthy();
    expect(a.posts()).toEqual([]); expect(a.gets("/commands/")).toEqual([]);
    expect(screen.queryByText("Вход подтверждён")).toBeNull(); expect(a.todayReply).not.toHaveBeenCalled();
  });
  // An open written session of this client continues on the written screen at its server step (В02, tz_app:48);
  // its assignment is already presented, so nothing is posted.
  it("2: a written session is never routed into Learning and continues on the written screen", async () => {
    const a = app({ session: id(3) });
    a.route(async (url, init, base) => String(url).includes("/sessions/") ? response({ current: written, state_version: "1" }) : base(url, init));
    render(<App />); await screen.findByText("дом");
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(false)); await settled();
    expect(screen.getByRole("heading", { name: "Слова: перевод на немецкий", level: 1 })).toBeTruthy();
    expect(a.posts()).toEqual([]); expect(a.gets("/commands/")).toEqual([]);
    expect(screen.queryByText("Вход подтверждён")).toBeNull(); expect(a.todayReply).not.toHaveBeenCalled();
  });
  // An open oral session of this client continues on the oral screen (tz_app:48); its only POST is the visible-commit present.
  it("2: an oral session is never routed into Learning and continues on the oral screen", async () => {
    const a = app({ session: id(3) });
    a.route(async (url, init, base) => {
      if (String(url).includes("/sessions/")) return response({ current: oral, state_version: "1" });
      if (!isPost(init, "assignment.present")) return base(url, init);
      const command = JSON.parse(String(init!.body));
      return response({ command: { id: command.command_id, kind: command.kind, status: "applied", applied_at: "2026-10-01T12:00:00Z",
        target_id: command.assignment_id, action_id: null, result_id: null, context_id: null, object_version: null },
        current: { ...oral, assignment: { ...oral.assignment, status: "presented" }, capabilities: { ...oral.capabilities, reveal_target: id(6) } },
        state_version: "2" });
    });
    render(<App />); await screen.findByText("wenn");
    await waitFor(() => expect((screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement).disabled).toBe(false)); await settled();
    expect(a.posts().map(post => [post.kind, post.assignment_id])).toEqual([["assignment.present", id(6)]]);
    expect(a.gets("/commands/")).toEqual([]); expect(screen.queryByText("Вход подтверждён")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull(); expect(a.todayReply).not.toHaveBeenCalled();
  });

  it("3: reloads an accepted answer with a lost ACK by its original command ID, never posting it again", async () => {
    const a = app(); const input = await startToQuestion(a); a.f.wrong();
    fireEvent.change(input, { target: { value: "Haus" } });
    let delivered = false;
    a.route(async (url, init, base) => {
      if (!isPost(init, "answer.submit")) return base(url, init);
      await base(url, init); delivered = true; return new Promise<Response>(() => {});
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(delivered).toBe(true));
    const answer = a.posts().at(-1)!; expect(answer.kind).toBe("answer.submit");
    cleanup(); render(<App />);
    await screen.findByRole("region", { name: "Есть ошибка" }); await settled();
    expect(a.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
    expect(a.gets(`/commands/${answer.command_id}`).length).toBeGreaterThan(0);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("3: a not_found status for the saved answer never triggers an automatic POST", async () => {
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "Haus" } });
    const saved: { intent: LearningCommandIntent | null } = { intent: null };
    a.route(async (url, init, base) => {
      if (isPost(init, "answer.submit")) { saved.intent = JSON.parse(String(init!.body)); return new Promise<Response>(() => {}); }
      const sent = saved.intent;
      if (sent && String(url).includes(`/commands/${sent.command_id}`)) return response(missing(sent, a.version()));
      return base(url, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(saved.intent).not.toBeNull());
    cleanup(); render(<App />);
    await waitFor(() => expect(a.gets(`/commands/${saved.intent!.command_id}`).length).toBeGreaterThan(0)); await settled();
    expect(a.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
  });

  it("4: Stop runs in its own lane during an answer; Today only after closed; the late ACK opens nothing", async () => {
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "Haus" } });
    const lateGate = deferred<Response>(), stopGate = deferred<Response>(); let late!: Response;
    a.route(async (url, init, base) => {
      if (isPost(init, "answer.submit")) { late = await base(url, init); return lateGate.promise; }
      if (isPost(init, "session.stop")) { const reply = await base(url, init); a.server.session = null; return stopGate.promise.then(() => reply); }
      return base(url, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(a.posts().at(-1)?.kind).toBe("answer.submit"));
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(a.posts().at(-1)?.kind).toBe("session.stop")); await settled();
    const opens = a.openReply.mock.calls.length, todays = a.todayReply.mock.calls.length;
    expect(screen.queryByText(pairText)).toBeNull(); expect(a.todayReply).toHaveBeenCalledTimes(todays);
    await act(async () => { stopGate.resolve(new Response()); });
    await screen.findByText(pairText);
    expect(a.openReply).toHaveBeenCalledTimes(opens + 1); expect(a.todayReply).toHaveBeenCalledTimes(todays + 1);
    await act(async () => { lateGate.resolve(late); }); await settled();
    expect(screen.getByText(pairText)).toBeTruthy(); expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("region", { name: "Есть ошибка" })).toBeNull();
    expect(a.posts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present", "answer.submit", "session.stop"]);
  });

  it("5: a foreground keeps the assignment draft but sends nothing before its open returns", async () => {
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "draft five" } });
    const opens = a.openReply.mock.calls.length, sent = a.posts().length, gate = deferred<void>();
    a.holdOpen(gate.promise);
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await waitFor(() => expect(a.openReply).toHaveBeenCalledTimes(opens + 1));
    expect((screen.getByRole("textbox") as HTMLInputElement).readOnly).toBe(true);
    await settled(); expect(a.posts()).toHaveLength(sent);
    await act(async () => { gate.resolve(); });
    expect((await editable()).value).toBe("draft five");
    expect(a.openReply).toHaveBeenCalledTimes(opens + 1); expect(a.posts()).toHaveLength(sent);
  });

  it("6: without a confirmed transition mode a tap shows the configuration gate and studies nothing", async () => {
    const a = app({ transitionMode: null }); render(<App />);
    fireEvent.click(await startButton(a));
    await screen.findByText("Для занятия нужно подтвердить настройки и текущую словарную пару."); await settled();
    expect(screen.getByRole("button", { name: "Обновить настройки" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Настройки" })).toBeTruthy();
    expect(a.posts()).toEqual([]); expect(a.settingsReply).toHaveBeenCalledOnce();
  });

  it("7: Settings and back keep the same owner and draft; an adopted session is never re-read for its mode", async () => {
    const resume = vi.spyOn(SessionResumeController.prototype, "refresh");
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "draft seven" } });
    const opens = a.openReply.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    // Settings is visible and the Learning screen is not rendered while it is.
    expect(screen.queryByRole("heading", { name: "Изучение слов" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    const learning = within((await screen.findByRole("heading", { name: "Изучение слов" }, exchange)).closest("main")!);
    const draft = learning.getByRole("textbox") as HTMLInputElement;
    await waitFor(() => expect(draft.readOnly).toBe(false), exchange);
    expect(draft.value).toBe("draft seven");
    // The Settings page stays mounted for its own state but is hidden again.
    expect(screen.queryByRole("heading", { name: "Настройки", level: 1 })).toBeNull();
    expect(a.openReply.mock.calls.length).toBeGreaterThan(opens);
    expect(a.posts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
    expect(resume).not.toHaveBeenCalled();
  });

  it("8: one Enter sends one answer", async () => {
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "Haus" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" }); fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(a.posts().at(-1)?.kind).toBe("answer.submit")); await settled();
    expect(a.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
  });

  it("8: the summary tap closes the session, then one fresh open shows Today and no new Start", async () => {
    const a = app({ session: id(3) }); a.f.setStep({ ...current(), status: "summary", assignment: null });
    const gate = deferred<void>();
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.stop")) return base(url, init);
      const reply = await base(url, init); a.server.session = null; await gate.promise; return reply;
    });
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: "Вернуться на Сегодня" }));
    await waitFor(() => expect(a.posts()).toHaveLength(1)); await settled();
    expect(a.posts()[0]).toMatchObject({ kind: "session.stop", session_id: id(3), payload: { reason: "summary_home" } });
    const opens = a.openReply.mock.calls.length;
    expect(a.todayReply).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); });
    await screen.findByText(pairText); await settled();
    expect(a.openReply).toHaveBeenCalledTimes(opens + 1); expect(a.todayReply).toHaveBeenCalledOnce();
    expect(a.posts()).toHaveLength(1);
  });

  const enPair = "Активная пара: Английский ↔ Немецкий";
  async function saveSetting(group: string, value: string) {
    const field = within(await screen.findByRole("group", { name: group }));
    await waitFor(() => expect(field.getByRole("combobox").hasAttribute("disabled")).toBe(false));
    fireEvent.change(field.getByRole("combobox"), { target: { value } });
    fireEvent.click(field.getByRole("button", { name: "Сохранить" }));
  }
  /** The first choice of the dictionary language, on its screen in front of Today (19.2-А, 29.1-А). */
  async function choose(pair: string) {
    const heading = await screen.findByRole("heading", { level: 1, name: "Язык словаря" }, exchange);
    const page = within(heading.closest("main")!);
    await waitFor(() => expect(page.getByRole("radio", { name: pair }).hasAttribute("disabled")).toBe(false), exchange);
    fireEvent.click(page.getByRole("radio", { name: pair }));
    fireEvent.click(page.getByRole("button", { name: "Продолжить" }));
  }
  type Stages = { opens: number; todays: number };
  /** Server-model counts taken just before «Сегодня»: each stage below is confirmed by an exchange, never by a delay. */
  const before = (a: Server): Stages => ({ opens: a.openReply.mock.settledResults.length, todays: a.todayReply.mock.calls.length });
  /** After «Сегодня» three pre-existing stages run in sequence (DIAG_G1_CP10: about 0.3 + 0.4 + 0.35 s under full-suite
   * load): the fresh open behind the gate, Learning recovery up to the Today read, then the Today read itself. Each stage
   * is awaited separately. Either the new pair's Today or a (stale) Learning screen ends the wait; the D1 assertions decide. */
  async function afterPairChange(a: Server, stages: Stages) {
    const learning = () => screen.queryByRole("heading", { name: "Изучение слов" });
    await waitFor(() => expect(a.openReply.mock.settledResults.length > stages.opens || learning() !== null).toBe(true), exchange);
    await waitFor(() => expect(a.todayReply.mock.calls.length > stages.todays || learning() !== null).toBe(true), exchange);
    await waitFor(() => expect(screen.queryByText(enPair) ?? learning()).not.toBeNull(), exchange);
    await settled();
  }

  it("D1-T1: a finished resumed session's seed is not reused after a dictionary_language change", async () => {
    // The resumed session predates the choice; Today after its summary is the first choice of the language.
    const a = app({ session: id(3), dictionaryVersion: "1" }); a.f.setStep({ ...current(), status: "summary", assignment: null });
    a.route(async (url, init, base) => {
      if (isPost(init, "session.stop")) { const reply = await base(url, init); a.server.session = null; return reply; }
      if (!isPost(init, "session.start")) return base(url, init);
      const value = await (await base(url, init)).json();
      value.current.pair = "en-de"; value.current.preview.content = previewContent(id(21), "en-de");
      a.f.setStep(value.current); return response(value);
    });
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: "Вернуться на Сегодня" }, exchange));
    await screen.findByRole("heading", { level: 1, name: "Язык словаря" }, exchange);
    expect(screen.queryByText(pairText)).toBeNull();
    await waitFor(() => expect(a.studyPosts().map(post => post.kind)).toEqual(["session.stop"]));
    const reads = a.gets(`/sessions/${id(3)}?`).length, stages = before(a);
    await choose("Немецко-английский");
    await waitFor(() => expect(a.posts().some(post => (post.kind as string) === "setting.save")).toBe(true));
    await afterPairChange(a, stages);
    expect(screen.queryByRole("heading", { name: "Изучение слов" })).toBeNull(); // A1
    expect(a.gets(`/sessions/${id(3)}?`)).toHaveLength(reads); // A2
    expect(screen.getByText(enPair)).toBeTruthy(); // A3
    const start = screen.getByRole("button", { name: /Новая группа слов/ });
    expect(start.hasAttribute("disabled")).toBe(false);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.stop"]); // A4
    await settled(); fireEvent.click(start);
    await screen.findByText("Hallo"); // A5
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.stop", "session.start"]);
    expect(a.studyPosts()[1].session_id).not.toBe(id(3));
  });

  it("D1-T2: an active resumed session closed by pair_changed leaves Today reachable for the new pair", async () => {
    // Before the choice an active session keeps its route; its Settings still offer the first save of the language.
    const a = app({ session: id(3), dictionaryVersion: "1" }); render(<App />);
    await editable();
    // The saved setting raises the version floor, so the Learning owner re-reads its session once after the save, finds it
    // closed and itself returns to Today. That read is lawful but its timing follows React scheduling: its reply is held
    // until «Сегодня» is tapped, so the count is fixed after that read has arrived and before the tap, whatever the load.
    const reply = deferred<void>(); let held = 0;
    a.route(async (url, init, base) => {
      if (init?.method !== "POST" && String(url).includes(`/sessions/${id(3)}?`) && a.posts().some(post => (post.kind as string) === "setting.save")) {
        held++; await reply.promise;
      }
      return base(url, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await saveSetting("Язык словаря", "en");
    await screen.findAllByText("Сохранено");
    expect(a.server.session).toBeNull();
    await waitFor(() => expect(held).toBe(1), exchange);
    const reads = a.gets(`/sessions/${id(3)}?`).length, stages = before(a);
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await act(async () => { reply.resolve(); });
    await afterPairChange(a, stages);
    expect(screen.queryByRole("heading", { name: "Изучение слов" })).toBeNull(); // A1
    expect(a.gets(`/sessions/${id(3)}?`)).toHaveLength(reads); // A2
    expect(screen.getByText(enPair)).toBeTruthy(); // A3
    expect(screen.getByRole("button", { name: /Новая группа слов/ }).hasAttribute("disabled")).toBe(false);
    expect(a.studyPosts()).toEqual([]);
  });

  const ruPair = "Активная пара: Русский ↔ Немецкий";
  /**
   * Resumed summary X closed by its tap, then ru -> en chosen on the first-choice screen -> Today -> Settings; the pair
   * goes back to ru elsewhere (a later change is closed in the App, 19.2-А) and Settings re-reads it; stays on Settings.
   */
  async function pairRoundTrip() {
    const a = app({ session: id(3), dictionaryVersion: "1" }); a.f.setStep({ ...current(), status: "summary", assignment: null });
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.stop")) return base(url, init);
      const reply = await base(url, init); a.server.session = null; return reply;
    });
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: "Вернуться на Сегодня" }));
    await choose("Немецко-английский");
    await screen.findByText(enPair, undefined, exchange);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Язык словаря" })).getByText("English")).toBeTruthy());
    expect(within(screen.getByRole("group", { name: "Язык словаря" })).queryByRole("combobox")).toBeNull();
    a.changePairElsewhere("ru");
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Язык словаря" })).getByText("Русский")).toBeTruthy(), exchange);
    expect(a.posts().filter(post => (post.kind as string) === "setting.save")).toHaveLength(1);
    await settled();
    return { a, reads: a.gets(`/sessions/${id(3)}?`).length, opens: a.openReply.mock.calls.length };
  }

  it("D1-T4 R-CP4-1: a pair round-trip never re-reads the closed seed", async () => {
    const { a, reads, opens } = await pairRoundTrip();
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText(ruPair, undefined, exchange); await settled();
    expect(a.gets(`/sessions/${id(3)}?`)).toHaveLength(reads); // B1
    expect(a.openReply).toHaveBeenCalledTimes(opens + 1); // B2
    expect(screen.queryByRole("heading", { name: "Изучение слов" })).toBeNull(); // B3
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.stop"]); // B4
  });

  it("D1-T5 R-CP4-1: a foreground after the pair round-trip keeps Settings open", async () => {
    const { a, reads, opens } = await pairRoundTrip();
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    // Wait for the foreground open itself; its exact count is asserted by C3.
    await waitFor(() => expect(a.openReply.mock.calls.length).toBeGreaterThan(opens)); await settled();
    expect(screen.queryByRole("heading", { name: "Настройки", level: 1 })).not.toBeNull(); // C1
    expect(a.gets(`/sessions/${id(3)}?`)).toHaveLength(reads); // C2
    expect(a.openReply).toHaveBeenCalledTimes(opens + 1); // C3
  });

  it("D1-T3: a UI-language-only change keeps the same Learning owner and draft", async () => {
    const resume = vi.spyOn(SessionResumeController.prototype, "refresh");
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "draft ui" } });
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await saveSetting("Язык интерфейса", "en");
    await screen.findByRole("heading", { name: "Settings", level: 1 });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main navigation" })).getByRole("button", { name: "Today" }));
    const learning = within((await screen.findByRole("heading", { name: "Learn words" }, exchange)).closest("main")!);
    const draft = learning.getByRole("textbox") as HTMLInputElement;
    await waitFor(() => expect(draft.readOnly).toBe(false), exchange);
    expect(draft.value).toBe("draft ui");
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
    expect(resume).not.toHaveBeenCalled();
  });
});

// R17: native Back runs the visible exit/return action (tz_app:86); an awaited stop keeps it visible without a second stop (К10-151).
describe("R17 native Telegram Back through the actual App document", () => {
  const settingsNav = () => within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name: "Настройки" });
  /** The next session.stop reaches the server, then its reply waits for the returned gate. */
  function holdStop(a: Server) {
    const gate = deferred<void>();
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.stop")) return base(url, init);
      const reply = await base(url, init); a.server.session = null; await gate.promise; return reply;
    });
    return gate;
  }

  it("R17-1: Today has no native Back", async () => {
    const back = fakeBack(), a = app({ back }); render(<App />);
    await startButton(a); await screen.findByText(pairText);
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0); expect(back.log).toEqual([]);
  });

  it("R17-2: Settings Back is its «Сегодня»; the following gate keeps it hidden; unmount releases it", async () => {
    const back = fakeBack(), a = app({ back }); render(<App />);
    await screen.findByText(pairText); fireEvent.click(settingsNav());
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    expect(back.visible).toBe(true); expect(back.handlers).toBe(1);
    const open = deferred<void>(); a.holdOpen(open.promise);
    await back.click();
    await screen.findByText("Загружаем план на сегодня");
    expect(screen.queryByRole("heading", { name: "Настройки", level: 1 })).toBeNull();
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0);
    await act(async () => { open.resolve(); });
    await screen.findByText(pairText); await settled();
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0);
    fireEvent.click(settingsNav()); await screen.findByRole("heading", { name: "Настройки", level: 1 });
    expect(back.handlers).toBe(1); expect(back.max).toBe(1); expect(a.studyPosts()).toEqual([]);
    cleanup();
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0);
  });

  it("R17-3: on a question Back is «Выйти»: one stop, visible while it is awaited, Today only after closed", async () => {
    const back = fakeBack(), a = app({ back }); await startToQuestion(a);
    expect(back.visible).toBe(true); expect(back.handlers).toBe(1);
    const shows = back.shows(), gate = holdStop(a);
    await back.click(); await back.click();
    await waitFor(() => expect(a.studyPosts().at(-1)?.kind).toBe("session.stop")); await settled();
    await back.click(); await settled();
    expect(a.studyPosts().filter(post => post.kind === "session.stop")).toHaveLength(1);
    expect(a.studyPosts().at(-1)).toMatchObject({ payload: { reason: "stop" } });
    expect(screen.getByText("Завершаем занятие…")).toBeTruthy(); expect(screen.queryByText(pairText)).toBeNull();
    expect(back.visible).toBe(true); expect(back.handlers).toBe(1); expect(back.shows()).toBe(shows);
    await act(async () => { gate.resolve(); });
    await screen.findByText(pairText); await settled();
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0); expect(back.max).toBe(1);
    expect(a.studyPosts().filter(post => post.kind === "session.stop")).toHaveLength(1);
  });

  it("R17-4: preview Back stops without advancing the preview", async () => {
    const back = fakeBack(), a = app({ back }); render(<App />);
    fireEvent.click(await startButton(a)); await screen.findByRole("button", { name: "Дальше" });
    await waitFor(() => expect(back.handlers).toBe(1));
    await back.click();
    await waitFor(() => expect(a.studyPosts().at(-1)?.kind).toBe("session.stop"));
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start", "session.stop"]);
    expect(a.studyPosts()[1]).toMatchObject({ payload: { reason: "stop" } });
  });

  it("R17-5: result Back stops and never opens another view of the answer", async () => {
    const back = fakeBack(), a = app({ back }); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(a.studyPosts().at(-1)?.kind).toBe("answer.submit")); await settled();
    expect(back.handlers).toBe(1);
    await back.click();
    await waitFor(() => expect(a.studyPosts().at(-1)?.kind).toBe("session.stop"));
    expect(a.studyPosts().map(post => post.kind))
      .toEqual(["session.start", "learning.preview_next", "assignment.present", "answer.submit", "session.stop"]);
    expect(a.studyPosts().at(-1)).toMatchObject({ payload: { reason: "stop" } });
  });

  it("R17-6: summary Back is its summary_home tap, once, visible until closed", async () => {
    const back = fakeBack(), a = app({ session: id(3), back }); a.f.setStep({ ...current(), status: "summary", assignment: null });
    const gate = holdStop(a);
    render(<App />); await screen.findByRole("button", { name: "Вернуться на Сегодня" });
    await waitFor(() => expect(back.handlers).toBe(1));
    await back.click(); await back.click();
    await waitFor(() => expect(a.studyPosts()).toHaveLength(1)); await settled();
    await back.click(); await settled();
    expect(a.studyPosts()).toEqual([expect.objectContaining({ kind: "session.stop", session_id: id(3), payload: { reason: "summary_home" } })]);
    expect(back.visible).toBe(true); expect(a.todayReply).not.toHaveBeenCalled();
    await act(async () => { gate.resolve(); });
    await screen.findByText(pairText); await settled();
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0); expect(a.studyPosts()).toHaveLength(1);
  });

  it("R17-9: without a session the configuration gate's Back is its «На Сегодня», never Settings", async () => {
    const back = fakeBack(), a = app({ transitionMode: null, back }); render(<App />);
    fireEvent.click(await startButton(a));
    await screen.findByText("Для занятия нужно подтвердить настройки и текущую словарную пару.");
    await waitFor(() => expect(back.handlers).toBe(1));
    await back.click();
    await screen.findByText(pairText); await settled();
    expect(screen.queryByRole("heading", { name: "Настройки", level: 1 })).toBeNull();
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0); expect(a.posts()).toEqual([]);
  });

  it("R17-10: during a held foreground open Back does exactly what the visible «Выйти» allows", async () => {
    const back = fakeBack(), a = app({ back }); await startToQuestion(a);
    const open = deferred<void>(); a.holdOpen(open.promise);
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    const enabled = !(screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled;
    await back.click();
    if (enabled) await waitFor(() => expect(a.studyPosts().at(-1)?.kind).toBe("session.stop"));
    else await settled();
    expect(a.studyPosts().some(post => post.kind === "session.stop")).toBe(enabled);
    expect(enabled).toBe(true);
    await act(async () => { open.resolve(); });
  });
});

// Т96 / К10-151 transitions found by the independent QA (QA-X1, QA-X2 in QA_R17_20261004): a failed or unknown stop
// with native Back, and the Learning <-> Settings owner swap.
describe("R17 native Back across a failed stop and an owner swap", () => {
  const stopPosts = (a: Server) => a.studyPosts().filter(post => post.kind === "session.stop");

  it("R17-15: a failed stop keeps Back visible and inert; unknown is checked, the known failure is retried only explicitly", async () => {
    const back = fakeBack(), a = app({ back }); await startToQuestion(a);
    const first: { intent: LearningCommandIntent | null } = { intent: null };
    a.route(async (url, init, base) => {
      if (isPost(init, "session.stop")) {
        if (first.intent === null) { first.intent = JSON.parse(String(init!.body)) as LearningCommandIntent; throw new TypeError("Failed to fetch"); }
        const reply = await base(url, init); a.server.session = null; return reply;
      }
      const sent = first.intent;
      if (sent && String(url).includes(`/commands/${sent.command_id}`)) return response(missing(sent, a.version()));
      return base(url, init);
    });
    await back.click();
    await waitFor(() => expect(stopPosts(a)).toHaveLength(1)); await settled();
    const commandId = first.intent!.command_id;
    // Unknown outcome: Back stays visible, sends nothing and does not resolve the command by itself.
    expect(back.visible).toBe(true); expect(back.handlers).toBe(1);
    await back.click(); await back.click(); await settled();
    expect(stopPosts(a)).toHaveLength(1); expect(a.gets(`/commands/${commandId}`)).toHaveLength(0);
    expect(screen.queryByText(pairText)).toBeNull();
    // The earlier command is checked first; not_found makes the exact retry available.
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" }));
    const retry = await screen.findByRole("button", { name: "Повторить завершение" });
    expect(a.gets(`/commands/${commandId}`).length).toBeGreaterThan(0);
    // Known failure: Back still visible and inert; the retry stays an explicit on-screen action.
    expect(back.visible).toBe(true); expect(back.handlers).toBe(1);
    await back.click(); await back.click(); await settled();
    expect(stopPosts(a)).toHaveLength(1);
    fireEvent.click(retry);
    await screen.findByText(pairText); await settled();
    expect(stopPosts(a)).toHaveLength(2); expect(stopPosts(a)[1].command_id).toBe(commandId);
    expect(back.visible).toBe(false); expect(back.handlers).toBe(0); expect(back.max).toBe(1);
  });

  it("R17-16: Learning -> Settings -> Back swaps the single owner without a stop and returns to the same Learning", async () => {
    const back = fakeBack(), a = app({ back }); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "draft x2" } });
    expect(back.handlers).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    expect(back.visible).toBe(true); expect(back.handlers).toBe(1);
    await back.click();
    const learning = within((await screen.findByRole("heading", { name: "Изучение слов" })).closest("main")!);
    const draft = learning.getByRole("textbox") as HTMLInputElement;
    await waitFor(() => expect(draft.readOnly).toBe(false));
    expect(draft.value).toBe("draft x2");
    expect(back.visible).toBe(true); expect(back.handlers).toBe(1); expect(back.max).toBe(1);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
  });
});

// M-NAV: the bottom navigation is hidden during the session (К09-040); Back is still the session's own exit.
describe("M-NAV bottom navigation around a Learning session", () => {
  it("N-L1 preview and question show no navigation panel; Back stops and Today shows the panel again", async () => {
    const back = fakeBack(), a = app({ back }); render(<App />);
    await startButton(a);
    expect(screen.getByRole("navigation", { name: "Основная навигация" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Новая группа слов/ }));
    await screen.findByRole("button", { name: "Дальше" });
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Дальше" }));
    await editable(); a.server.session = a.posts()[0].session_id;
    expect(screen.queryByRole("navigation", { name: "Основная навигация" })).toBeNull();
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.stop")) return base(url, init);
      const reply = await base(url, init); a.server.session = null; return reply;
    });
    await back.click();
    await waitFor(() => expect(a.studyPosts().at(-1)).toMatchObject({ kind: "session.stop", payload: { reason: "stop" } }));
    await screen.findByText(pairText);
    expect(screen.getByRole("navigation", { name: "Основная навигация" })).toBeTruthy();
  });
});

// 2.33: while a DOCUMENT_STALE is checked, the document is out of sight; nothing of it may show or act.
describe("Learning while the window checks its document (2.33)", () => {
  const wrapperDisplay = () => (document.querySelector(".document-check") as HTMLElement | null)?.style.display;

  it("replaced window: an answer refused as DOCUMENT_STALE never shows a refusal on any screen update", async () => {
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "Haus" } });
    const hold = gate(); const r = replaceDocument(a.fetcher, hold.promise);
    const watch = watchFlash(document.body);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(r.foregrounds()).toBe(1));
    await settled();
    expect(watch.seen).toEqual([]);
    await act(async () => { hold.open(); }); await settled();
    await screen.findByRole("heading", { name: "Wortly уже открыт" });
    watch.stop();
    expect(watch.seen).toEqual([]);
  });

  it("native Back during the check reaches no hidden module: no stop is sent; after the check the module is shown again", async () => {
    const back = fakeBack(), a = app({ back }); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "Haus" } });
    const hold = gate();
    const r = refuseOnce(a.fetcher, (path, init) => init?.method === "POST" && path.endsWith("/commands")
      && JSON.parse(String(init!.body)).kind === "answer.submit", hold.promise);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(r.foregrounds()).toBe(1));
    await settled();
    expect(wrapperDisplay()).toBe("none");
    expect(screen.getByRole("heading", { name: "Обновляем Wortly" })).toBeTruthy();
    expect(back.handlers).toBe(1); // One Telegram binding, whatever layers supply handlers.
    const before = a.studyPosts().length;
    await back.click(); await settled();
    expect(a.studyPosts().slice(before)).toEqual([]);
    await act(async () => { hold.open(); }); await settled();
    await waitFor(() => expect(wrapperDisplay()).toBe("contents"));
    expect(screen.queryByRole("heading", { name: "Обновляем Wortly" })).toBeNull();
  });

  it("Enter on body during the check never reaches the hidden Learning result's «next»", async () => {
    const a = app(); const input = await startToQuestion(a); a.f.wrong();
    fireEvent.change(input, { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByRole("region", { name: "Есть ошибка" }); await settled();
    // A foreground re-reads the result; that read is refused once as DOCUMENT_STALE, and the check's own foreground is held.
    const hold = gate(), base = a.fetcher.getMockImplementation()!;
    let foregrounds = 0, refused = 0;
    a.fetcher.mockImplementation(async (url, init) => {
      const u = new URL(String(url), "http://localhost"), body = init?.body ? JSON.parse(String(init.body)) : null;
      if (u.pathname.endsWith("/client/open") && body?.event === "foreground" && ++foregrounds > 1) { await hold.promise; return base(url, init); }
      if (refused === 0 && init?.method !== "POST" && u.pathname.includes("/sessions/") && u.searchParams.has("result_id")) {
        refused++; return new Response(JSON.stringify(staleRefusal), { status: 409 });
      }
      return base(url, init);
    });
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await waitFor(() => expect(wrapperDisplay()).toBe("none"));
    await settled();
    expect(refused).toBe(1);
    const next = within(document.querySelector(".document-check") as HTMLElement).queryByRole("button", { name: "Далее", hidden: true });
    const before = a.studyPosts().length;
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter" }); await settled();
    expect({ next: !!next, sent: a.studyPosts().slice(before).map(post => post.kind) }).toEqual({ next: true, sent: [] });
    expect(document.querySelector(".document-check")!.hasAttribute("inert")).toBe(true);
    await act(async () => { hold.open(); }); await settled();
    await waitFor(() => expect(wrapperDisplay()).toBe("contents"));
    expect(document.querySelector(".document-check")!.hasAttribute("inert")).toBe(false);
  });
});

// M-CARD-LINK-2 (answer S01): the bot's complaint button over a resumed session opens its card at once; Back returns to
// the session at the same place; neither the opening nor the closing sends a study command or ends the session.
describe("the launch card over a resumed session", () => {
  afterEach(() => { window.history.replaceState(null, "", "/"); });
  const LAUNCH = cardIdOf(3);
  const kinds = (a: Server) => a.posts().map(post => post.kind as string);
  const pause = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });

  it("Learning: the card opens over the question; native Back returns to the same question, the session stays open", async () => {
    launch(`?card=${LAUNCH}`);
    const back = fakeBack();
    const a = app({ session: id(3), back });
    const card = serveLaunchCard(a.fetcher, LAUNCH, { learning: true });
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("das\u00a0Haus");
    expect(card.views()).toEqual([`/api/v1/dictionary/cards/${LAUNCH}/view`]);
    expect(card.origins()).toEqual(["?origin=message"]);
    // The card of the complaint is not the card of the current assignment.
    expect(current().assignment?.card_id).not.toBe(LAUNCH);
    await waitFor(() => expect(kinds(a)).toEqual(["context.open"]));
    await pause();
    expect(besidesContext(kinds(a))).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();

    const opens = a.openReply.mock.calls.length;
    await back.click();
    const input = await editable(); expect(input).toBeTruthy();
    expect(screen.getAllByText("дом").length).toBeGreaterThan(0);
    await waitFor(() => expect(kinds(a)).toEqual(["context.open", "context.close"]));
    await pause();
    expect(besidesContext(kinds(a))).toEqual([]);
    // No session.stop or other study command: the session stays open on the server. A return, not a way through Today.
    expect(a.openReply.mock.calls.length).toBe(opens);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.todayReply).not.toHaveBeenCalled();
  });

  // C024 (b): an action in the card changes the session on the server (e.g. an interval increase ends earlier answer
  // rights, K05-057); the session shown after Back is the server's current one, not a read from before the card.
  it("Learning: a session changed on the server while the card is open is shown as the server has it after Back", async () => {
    launch(`?card=${LAUNCH}`);
    const back = fakeBack();
    const a = app({ session: id(3), back });
    serveLaunchCard(a.fetcher, LAUNCH, { learning: true });
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    await waitFor(() => expect(kinds(a)).toEqual(["context.open"]));
    const step = current();
    a.f.setStep({ ...step, assignment: { ...step.assignment!, id: id(9), card_id: id(12),
      prompt: { ...step.assignment!.prompt, text: "кот", translations: ["кот"] } } });
    await back.click();
    await screen.findByText("кот", undefined, exchange);
    expect(screen.queryByText("дом")).toBeNull();
    await editable();
    expect(besidesContext(kinds(a))).toEqual([]);
  });

  it("conjugation: the card opens over the conjugation test and Back returns to the same form; nothing is started or sent", async () => {
    launch(`?card=${LAUNCH}`);
    const back = fakeBack();
    const a = app({ session: id(3), back });
    const conjugation = { session_id: id(3), status: "active", mode: "conjugation", pair: "ru-de", direction: "conjugation",
      local_date: "2026-10-01", close_reason: null, progress: { total: 3, completed: 1, correct: 1, wrong: 0 },
      assignment: { id: id(5), card_id: id(8), status: "presented", kind: "conjugation", cycle_id: id(9),
        slot_id: { cycle_id: id(9), pronoun_group: "du" }, base_verb_id: id(8), display_verb_id: id(18), tense: "present", pronoun_group: "du",
        prompt: { verb: "ankommen", translation: "прибывать", language: "ru", pronoun: "du", tense: "present" },
        answer_spec: { kind: "forms", labels: ["du"], part_count: 1, case_sensitive: false } }, summary: null,
      capabilities: { answer_target: id(5), correct_target: null, grades: null, undo_target: null, stop: true, summary_home: false } };
    a.route(async (url, init, base) => String(url).includes("/sessions/") ? response({ current: conjugation, state_version: "1" }) : base(url, init));
    const card = serveLaunchCard(a.fetcher, LAUNCH, { learning: true });
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(card.views()).toEqual([`/api/v1/dictionary/cards/${LAUNCH}/view`]);
    expect(card.origins()).toEqual(["?origin=message"]);
    expect(LAUNCH).not.toBe(conjugation.assignment.card_id);
    expect(screen.queryByRole("heading", { name: "Тест спряжений", level: 1 })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    await waitFor(() => expect(kinds(a)).toEqual(["context.open"]));
    await pause();
    expect(besidesContext(kinds(a))).toEqual([]);

    const opens = a.openReply.mock.calls.length;
    await back.click();
    await screen.findByRole("heading", { name: "Тест спряжений", level: 1 }, exchange);
    expect(screen.getByText("ankommen")).toBeTruthy(); await editable();
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    await waitFor(() => expect(kinds(a)).toEqual(["context.open", "context.close"]));
    await pause();
    expect(besidesContext(kinds(a))).toEqual([]);
    expect(a.openReply.mock.calls.length).toBe(opens);
    expect(a.todayReply).not.toHaveBeenCalled();
    expect(card.views()).toHaveLength(1);
  });

  it("oral: a session changed on the server while the card is open is shown as the server has it after Back", async () => {
    launch(`?card=${LAUNCH}`);
    const a = app({ session: id(3) });
    const projection = (text: string, assignment: number) => ({ session_id: id(3), status: "active", mode: "oral", pair: "ru-de",
      direction: "de-l1", local_date: "2026-10-01", bucket: "words", close_reason: null,
      progress: { completed: 0, total: 2, correct: 0, wrong: 0 },
      assignment: { id: id(assignment), card_id: id(assignment + 1), status: "presented", kind: "original",
        prompt: { text, language: "de", conjunction_hint: { meaning_category: "Bedingung", verb_position: "am Ende" } }, revealed: false },
      summary: null, practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
      capabilities: { reveal_target: id(assignment), grade_target: null, stop: true, summary_home: false } });
    let served = projection("wenn", 6);
    a.route(async (url, init, base) => String(url).includes("/sessions/") ? response({ current: served, state_version: "1" }) : base(url, init));
    serveLaunchCard(a.fetcher, LAUNCH, { learning: true });
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    await waitFor(() => expect(kinds(a)).toEqual(["context.open"]));
    served = projection("weil", 16);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("weil", undefined, exchange);
    expect(screen.queryByText("wenn")).toBeNull();
    await waitFor(() => expect(kinds(a)).toEqual(["context.open", "context.close"]));
    expect(besidesContext(kinds(a))).toEqual([]);
  });

  it("oral: the question is committed as shown only after the card closes; the session stays open", async () => {
    launch(`?card=${LAUNCH}`);
    const a = app({ session: id(3) });
    const oral = { session_id: id(3), status: "active", mode: "oral", pair: "ru-de", direction: "de-l1", local_date: "2026-10-01",
      bucket: "words", close_reason: null, progress: { completed: 0, total: 2, correct: 0, wrong: 0 },
      assignment: { id: id(6), card_id: id(7), status: "prefetched", kind: "original", prompt: { text: "wenn", language: "de",
        conjunction_hint: { meaning_category: "Bedingung", verb_position: "am Ende" } }, revealed: false },
      summary: null, practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: 0 },
      capabilities: { reveal_target: null, grade_target: null, stop: true, summary_home: false } };
    a.route(async (url, init, base) => {
      if (String(url).includes("/sessions/")) return response({ current: oral, state_version: "1" });
      if (!isPost(init, "assignment.present")) return base(url, init);
      const command = JSON.parse(String(init!.body));
      return response({ command: { id: command.command_id, kind: command.kind, status: "applied", applied_at: "2026-10-01T12:00:00Z",
        target_id: command.assignment_id, action_id: null, result_id: null, context_id: null, object_version: null },
        current: { ...oral, assignment: { ...oral.assignment, status: "presented" }, capabilities: { ...oral.capabilities, reveal_target: id(6) } },
        state_version: "2" });
    });
    const card = serveLaunchCard(a.fetcher, LAUNCH, { learning: true });
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(card.views()).toEqual([`/api/v1/dictionary/cards/${LAUNCH}/view`]);
    expect(card.origins()).toEqual(["?origin=message"]);
    expect(LAUNCH).not.toBe(oral.assignment.card_id);
    await waitFor(() => expect(kinds(a)).toEqual(["context.open"]));
    await pause();
    expect(besidesContext(kinds(a))).toEqual([]);
    expect(screen.queryByText("wenn")).toBeNull();

    const opens = a.openReply.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("wenn", undefined, exchange);
    await waitFor(() => expect((screen.getByRole("button", { name: "Раскрыть" }) as HTMLButtonElement).disabled).toBe(false));
    // The present belongs to the oral quiz once its question is on screen; nothing else was sent.
    expect(kinds(a)).toEqual(["context.open", "context.close", "assignment.present"]);
    expect(a.posts().filter(post => post.kind === "session.stop")).toEqual([]);
    expect(a.openReply.mock.calls.length).toBe(opens);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.todayReply).not.toHaveBeenCalled();
  });
});

describe("Learning: a pair changed elsewhere after a lost answer (M-WRITTEN-STUCK)", () => {
  const enPair = "Активная пара: Английский ↔ Немецкий";
  it("A3: the return shows Today of the new pair; no Stop is sent and no «Завершаем занятие…» stays", async () => {
    const a = app(); const input = await startToQuestion(a);
    fireEvent.change(input, { target: { value: "Haus" } });
    // The answer commits, its reply is lost, and study reads fail while the device is away.
    let offline = true;
    a.route(async (url, init, base) => {
      if (isPost(init, "answer.submit")) { await base(url, init); throw new TypeError("network"); }
      if (offline && (init?.method ?? "GET") === "GET") throw new TypeError("network");
      return base(url, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(a.posts().some(post => post.kind === "answer.submit")).toBe(true));
    await settled();
    // Another device changes the pair: the server closes the old-pair session.
    a.f.setStep({ ...current(a.server.session!), status: "closed", close_reason: "pair_changed", assignment: null, preview: null });
    a.server.session = null; a.changePairElsewhere("en"); offline = false;
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await screen.findByText(enPair, undefined, exchange);
    await settled();
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    expect(a.studyPosts().filter(post => post.kind === "session.stop")).toEqual([]);
  });
});

describe("Learning: a start the server refused for good (C168 SETUP_REQUIRED, C183 NO_MATERIAL, C192 SESSION_BUSY)", () => {
  const todayNav = () => within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name: "Сегодня" });
  const stops = (a: Server) => a.studyPosts().filter(post => post.kind === "session.stop");
  const starts = (a: Server) => a.studyPosts().filter(post => post.kind === "session.start");
  const closedText = () => screen.queryByText("Занятие завершено.");
  /** The refusals that leave the start, each with the existing text of its reason (LearningScreen copy). */
  const CODES = ["SETUP_REQUIRED", "NO_MATERIAL", "SESSION_BUSY"];
  const reason = (code: string) => code === "NO_MATERIAL" ? "Сейчас нет доступных слов для этого занятия."
    : code === "SESSION_BUSY" ? "Занятие открыто на другом устройстве" : "Не удалось обновить занятие.";
  /** GETs that name the refused number Y: a read or a check of a session that does not exist. */
  const reads = (a: Server, y: string) => a.fetcher.mock.calls.filter(([url, init]) => init?.method !== "POST" && String(url).includes(y));
  /**
   * session.start is refused as the core does (coordinator.execute: the savepoint removed the new session, then the
   * projection of its number reads not_found; learning_session_projection). "unavailable" is the variant of a document
   * check failing in that projection.
   */
  function refuseStart(a: Server, code: string,
    options: { until?: () => boolean; gate?: Promise<void>; current?: "not_found" | "unavailable" } = {}) {
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.start") || options.until?.()) return base(url, init);
      const body = JSON.parse(String(init!.body));
      if (options.gate) await options.gate;
      return response({ command: { id: body.command_id, status: "rejected" }, current: { session_id: body.session_id, status: options.current ?? "not_found" },
        state_version: a.version(), error: { code } }, 409);
    });
  }
  async function refusedStart(code: string, back?: ReturnType<typeof fakeBack>) {
    const a = app({ back }); refuseStart(a, code); render(<App />);
    fireEvent.click(await startButton(a));
    await waitFor(() => expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]));
    await screen.findByRole("heading", { name: "Изучение слов" }); await settled();
    return a;
  }

  it.each(CODES)("S1 %s: «Выйти» sends no stop; the reason stays, nothing says closed; «На Сегодня» leads to Today", async code => {
    const a = await refusedStart(code);
    expect(screen.getByText(reason(code))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Выйти" })); await settled();
    expect(stops(a)).toEqual([]); expect(closedText()).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "На Сегодня" }));
    await screen.findByText(pairText, undefined, exchange); await settled();
    expect(stops(a)).toEqual([]); expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
  });

  it.each(CODES)("S2 %s: native Back is «На Сегодня», never a stop; repeated Back sends nothing", async code => {
    const back = fakeBack(), a = await refusedStart(code, back);
    expect(back.handlers).toBe(1);
    await back.click(); await back.click(); await back.click();
    await screen.findByText(pairText, undefined, exchange); await settled();
    await back.click(); await settled();
    expect(stops(a)).toEqual([]); expect(closedText()).toBeNull();
    expect(back.handlers).toBe(0); expect(back.max).toBe(1);
  });

  it.each(CODES)("S3 %s: Settings, then «Сегодня» shows Today, not the refused start again", async code => {
    const a = await refusedStart(code);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    fireEvent.click(todayNav());
    await screen.findByText(pairText, undefined, exchange); await settled();
    expect(screen.queryByText(reason(code))).toBeNull();
    expect(stops(a)).toEqual([]);
  });

  it.each(CODES)("S4 %s: a late refusal, met after the user went to Settings, still leaves Today reachable without a stop", async code => {
    const back = fakeBack(), a = app({ back }), gate = deferred<void>();
    refuseStart(a, code, { gate: gate.promise }); render(<App />);
    fireEvent.click(await startButton(a));
    await waitFor(() => expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]));
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    await act(async () => { gate.resolve(); }); await settled();
    fireEvent.click(todayNav());
    await screen.findByText(pairText, undefined, exchange); await settled();
    expect(stops(a)).toEqual([]); expect(closedText()).toBeNull();
  });

  it.each(CODES)("S5 %s: nothing starts by itself; a new tap starts with a new number, and that session runs as usual", async code => {
    let refuse = true;
    const a = app(); refuseStart(a, code, { until: () => !refuse }); render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: "На Сегодня" }, exchange));
    await screen.findByText(pairText, undefined, exchange); await settled();
    expect(starts(a)).toHaveLength(1);
    refuse = false;
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: "Дальше" }, exchange));
    await editable();
    expect(starts(a)).toHaveLength(2); expect(starts(a)[1].session_id).not.toBe(starts(a)[0].session_id);
    expect(starts(a)[1].command_id).not.toBe(starts(a)[0].command_id); expect(stops(a)).toEqual([]);
  });

  /**
   * S8: what lifts each refusal in the core is a real Settings field of this tree, saved through its own group
   * (the dictionary language is locked once chosen, first_choice/CP2). SETUP_REQUIRED: the group size the new group
   * needs (learning_selection._selection: target < 1); NO_MATERIAL: the learning material (LearningSelectionEmpty).
   * SESSION_BUSY has no Settings path: the other session ends elsewhere, which S5 covers.
   */
  const lifts: [string, string, (field: ReturnType<typeof within>) => void][] = [
    ["SETUP_REQUIRED", "learning_group_size", field => fireEvent.change(field.getByRole("textbox"), { target: { value: "4" } })],
    ["NO_MATERIAL", "material", field => {
      fireEvent.click(field.getByRole("radio", { name: "Уровень" }));
      fireEvent.change(field.getByRole("combobox"), { target: { value: "A2" } });
    }],
  ];
  it.each(lifts)("S8 %s: the setting that lifts it (%s), saved in Settings, lets the next start through", async (code, key, edit) => {
    const a = app(), saved = () => a.posts().some(post => (post.kind as string) === "setting.save"
      && (post as unknown as { payload: { key: string } }).payload.key === key);
    refuseStart(a, code, { until: saved }); render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }, exchange));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    const field = within(screen.getByRole("group", { name: key === "material" ? "Учебный материал" : "Новых карточек в группе" }));
    edit(field);
    fireEvent.click(field.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Сохранено", undefined, exchange);
    fireEvent.click(todayNav());
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: "Дальше" }, exchange));
    await editable();
    expect(starts(a)).toHaveLength(2); expect(stops(a)).toEqual([]);
  });

  it.each(CODES)("S9 %s: a foreground after the refusal keeps the idle exit: «На Сегодня» stays, Back sends no stop", async code => {
    const back = fakeBack(), a = await refusedStart(code, back), opens = a.openReply.mock.calls.length;
    await act(async () => { window.dispatchEvent(new Event("pageshow")); });
    await waitFor(() => expect(a.openReply.mock.calls.length).toBeGreaterThan(opens)); await settled();
    expect(await screen.findByRole("button", { name: "На Сегодня" })).toBeTruthy();
    await back.click(); await screen.findByText(pairText, undefined, exchange);
    expect(stops(a)).toEqual([]); expect(closedText()).toBeNull();
  });

  it.each(CODES)("S10 %s: «Проверить состояние», a background and two foregrounds never read Y and keep the idle exit", async code => {
    const back = fakeBack(), a = await refusedStart(code, back), y = starts(a)[0].session_id as string;
    const visibility = (state: "hidden" | "visible") => act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    fireEvent.click(screen.getByRole("button", { name: /Проверить/ })); await settled();
    expect(await screen.findByRole("button", { name: "На Сегодня" })).toBeTruthy();
    await visibility("hidden"); await settled(); await visibility("visible");
    await act(async () => { window.dispatchEvent(new Event("pageshow")); }); await settled();
    await act(async () => { window.dispatchEvent(new Event("pageshow")); }); await settled();
    expect(await screen.findByRole("button", { name: "На Сегодня" }, exchange)).toBeTruthy();
    // The own visibility property goes; jsdom's getter on the prototype answers again.
    delete (document as { visibilityState?: unknown }).visibilityState;
    expect(back.handlers).toBe(1);
    expect(reads(a, y)).toEqual([]); expect(stops(a)).toEqual([]);
  });

  it.each(CODES)("S11 %s: a reload after the refusal opens Today; the new owner neither reads nor stops Y", async code => {
    const a = app(); refuseStart(a, code); const view = render(<App />);
    fireEvent.click(await startButton(a));
    await screen.findByRole("button", { name: "На Сегодня" }, exchange);
    const y = starts(a)[0].session_id as string;
    view.unmount(); render(<App />);
    await screen.findByText(pairText, undefined, exchange); await settled();
    expect(screen.queryByRole("heading", { name: "Изучение слов" })).toBeNull();
    expect(reads(a, y)).toEqual([]); expect(stops(a)).toEqual([]); expect(starts(a)).toHaveLength(1);
  });

  it.each(CODES)("S12 %s: with an unavailable projection of Y the exit is the same: no stop, «На Сегодня» leads to Today", async code => {
    const back = fakeBack(), a = app({ back }); refuseStart(a, code, { current: "unavailable" }); render(<App />);
    fireEvent.click(await startButton(a));
    await screen.findByRole("button", { name: "На Сегодня" }, exchange);
    expect(screen.getByText(reason(code))).toBeTruthy();
    await back.click(); await back.click();
    await screen.findByText(pairText, undefined, exchange); await settled();
    expect(stops(a)).toEqual([]); expect(closedText()).toBeNull();
  });

  it("S6: SESSION_BUSY of another device's T: «На Сегодня» opens afresh, the busy open shows the busy entry; Y and T are never stopped", async () => {
    const back = fakeBack(), a = await refusedStart("SESSION_BUSY", back), y = starts(a)[0].session_id as string;
    expect(screen.getByText(reason("SESSION_BUSY"))).toBeTruthy();
    // The core's open while T of another installation is open (ClientService._busy); held to look at the check itself.
    const gate = deferred<void>(), opens = a.openReply.mock.calls.length;
    a.openReply.mockImplementation(async () => {
      await gate.promise;
      return response({ profile: profile(a.version()), compatibility, status: "SESSION_BUSY",
        session: { status: "busy", stop_remote_target: null } });
    });
    fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
    await waitFor(() => expect(a.openReply.mock.calls.length).toBeGreaterThan(opens)); await settled();
    await back.click(); await settled();
    expect(starts(a)).toHaveLength(1); expect(stops(a)).toEqual([]);
    await act(async () => { gate.resolve(); });
    await screen.findByRole("heading", { name: "Wortly уже открыт" }, exchange); await settled();
    expect(screen.getByText("Вернись в другое открытое окно или на другое устройство.")).toBeTruthy();
    expect(screen.queryByText(pairText)).toBeNull();
    expect(starts(a)).toHaveLength(1); expect(stops(a)).toEqual([]); expect(reads(a, y)).toEqual([]);
    expect(a.posts().filter(post => (post.kind as string) === "session.stop_remote")).toEqual([]);
  });

  it("S13 control: SESSION_CLOSED with an active projection of Y keeps Y: no idle «На Сегодня», «Выйти» still addresses it", async () => {
    const a = app();
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.start")) return base(url, init);
      const body = JSON.parse(String(init!.body));
      // The number exists on the server (session_start_refusal.new_session_start): its projection is a real session.
      return response({ command: { id: body.command_id, status: "rejected" }, current: { ...current(body.session_id), pair: "ru-de" },
        state_version: a.version(), error: { code: "SESSION_CLOSED" } }, 409);
    });
    render(<App />);
    fireEvent.click(await startButton(a));
    await screen.findByRole("heading", { name: "Изучение слов" }); await settled();
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    expect(stops(a)).toEqual([]);
  });

  /**
   * The start's reply is lost after the core stored its final refusal; its status GET then answers as the core does
   * (command_status.read): with include_refusal=true and the matching intent hash the stored refusal, else not_found.
   * olderCore ignores include_refusal, as a core before C197 would.
   */
  function loseRefusedStart(a: Server, code: string,
    options: { olderCore?: boolean; currentOf?: (y: string) => Record<string, unknown> } = {}) {
    const currentOf = options.currentOf ?? ((y: string) => ({ session_id: y, status: "not_found" }));
    const refused = new Map<string, string>();
    a.route(async (url, init, base) => {
      if (isPost(init, "session.start")) {
        const body = JSON.parse(String(init!.body)); refused.set(body.command_id, body.session_id);
        throw new TypeError("network");
      }
      const address = new URL(String(url), "http://localhost"), commandId = address.pathname.split("/commands/")[1];
      const read = address.pathname.split("/sessions/")[1];
      // The refused number has no session: its strict read is not_found (learning_session_projection).
      if ((init?.method ?? "GET") === "GET" && read && [...refused.values()].includes(read)) {
        return response({ current: currentOf(read), state_version: a.version() });
      }
      if ((init?.method ?? "GET") !== "GET" || !commandId || !refused.has(commandId)) return base(url, init);
      const y = refused.get(commandId)!, query = address.searchParams;
      const hash = createHash("sha256").update(`{"kind":"session.start","payload":{"mode":"learning","session_id":"${y}"}}`).digest("hex");
      if (!options.olderCore && query.get("include_refusal") === "true") {
        expect(query.get("expected_intent_hash")).toBe(hash);
        return response({ command: { id: commandId, kind: "session.start", status: "rejected", refused_at: "2026-09-30T12:00:00Z" },
          error: { code }, current: currentOf(y), state_version: a.version(), verified_intent_hash: hash });
      }
      return response({ command: { id: commandId, status: "not_found" }, current: profile(a.version()), state_version: a.version() });
    });
  }
  const checks = (a: Server) => a.fetcher.mock.calls.filter(([url, init]) => (init?.method ?? "GET") === "GET" && String(url).includes("/commands/"));

  it.each(CODES)("Q12a %s: a lost start reply, then «Проверить состояние» finds the stored refusal: idle exit, no stop", async code => {
    const back = fakeBack(), a = app({ back }); loseRefusedStart(a, code); render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: /Проверить/ }, exchange));
    fireEvent.click(await screen.findByRole("button", { name: "На Сегодня" }, exchange));
    expect(new URL(String(checks(a)[0][0]), "http://localhost").searchParams.get("include_refusal")).toBe("true");
    await screen.findByText(pairText, undefined, exchange); await settled();
    expect(stops(a)).toEqual([]); expect(starts(a)).toHaveLength(1); expect(closedText()).toBeNull();
  });

  it("Q12b control: a core that ignores include_refusal answers not_found; the lost start keeps its number, nothing is stopped", async () => {
    const a = app(); loseRefusedStart(a, "SETUP_REQUIRED", { olderCore: true }); render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: /Проверить/ }, exchange));
    await waitFor(() => expect(checks(a).length).toBeGreaterThan(0)); await settled();
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect(stops(a)).toEqual([]); expect(starts(a)).toHaveLength(1);
  });

  it.each(CODES)("Q12c %s: a reload after the lost start reply: the new owner's check finds the refusal and Today opens", async code => {
    const a = app(); loseRefusedStart(a, code); const view = render(<App />);
    fireEvent.click(await startButton(a));
    await screen.findByRole("button", { name: /Проверить/ }, exchange);
    expect(localStorage.getItem("wortly.pending.learning_session")).not.toBeNull();
    view.unmount(); const before = checks(a).length; render(<App />);
    await screen.findByText(pairText, undefined, exchange); await settled();
    await waitFor(() => expect(localStorage.getItem("wortly.pending.learning_session")).toBeNull());
    const check = checks(a).slice(before);
    expect(check).toHaveLength(1);
    expect(new URL(String(check[0][0]), "http://localhost").searchParams.get("include_refusal")).toBe("true");
    expect(screen.queryByRole("heading", { name: "Изучение слов" })).toBeNull();
    expect(stops(a)).toEqual([]); expect(starts(a)).toHaveLength(1);
  });

  it("Q12d control: the same reload against a core that ignores include_refusal keeps the unresolved start on its screen", async () => {
    const a = app(); loseRefusedStart(a, "SETUP_REQUIRED", { olderCore: true }); const view = render(<App />);
    fireEvent.click(await startButton(a));
    await screen.findByRole("button", { name: /Проверить/ }, exchange);
    view.unmount(); render(<App />);
    await screen.findByRole("heading", { name: "Изучение слов" }, exchange); await settled();
    expect(localStorage.getItem("wortly.pending.learning_session")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect(stops(a)).toEqual([]); expect(starts(a)).toHaveLength(1);
  });

  it("Q13u control (QA F2): SETUP_REQUIRED of preview_next with an unavailable current keeps the session: the rule is start-only", async () => {
    // No live projection here, so only the start-only kind checks (refused, leavingRefusal) keep this session.
    const a = app();
    a.route(async (url, init, base) => {
      if (!isPost(init, "learning.preview_next")) return base(url, init);
      const body = JSON.parse(String(init!.body));
      return response({ command: { id: body.command_id, status: "rejected" }, current: { session_id: body.session_id, status: "unavailable" },
        state_version: a.version(), error: { code: "SETUP_REQUIRED" } }, 409);
    });
    render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: "Дальше" }, exchange)); await settled();
    await waitFor(() => expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next"])); await settled();
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    expect(stops(a)).toEqual([]);
  });

  it("Q14 control (C210): a stored SESSION_CLOSED of a cancelled number is read as that refusal, not left: no idle, no stop", async () => {
    const a = app(); loseRefusedStart(a, "SESSION_CLOSED"); render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: /Проверить/ }, exchange));
    await waitFor(() => expect(localStorage.getItem("wortly.pending.learning_session")).toBeNull()); await settled();
    expect(screen.getByText("Занятие завершено.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect(screen.queryByText(pairText)).toBeNull();
    expect(stops(a)).toEqual([]); expect(starts(a)).toHaveLength(1);
  });

  it("Q15 control (C210): a stored SETUP_REQUIRED whose number is now a real session keeps that session: its question, no idle", async () => {
    const a = app();
    loseRefusedStart(a, "SETUP_REQUIRED", { currentOf: y => ({ ...current(y), pair: "ru-de" }) }); render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: /Проверить/ }, exchange));
    await waitFor(() => expect(localStorage.getItem("wortly.pending.learning_session")).toBeNull()); await settled();
    expect(await screen.findByRole("textbox")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    expect(stops(a)).toEqual([]); expect(starts(a)).toHaveLength(1);
  });

  it("Q13 control: SETUP_REQUIRED of preview_next keeps the live session: no idle exit, «Выйти» still stops it", async () => {
    const a = app();
    a.route(async (url, init, base) => {
      if (!isPost(init, "learning.preview_next")) return base(url, init);
      const body = JSON.parse(String(init!.body));
      return response({ command: { id: body.command_id, status: "rejected" }, current: { ...current(body.session_id), pair: "ru-de" },
        state_version: a.version(), error: { code: "SETUP_REQUIRED" } }, 409);
    });
    render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: "Дальше" }, exchange)); await settled();
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next"]);
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    expect(stops(a)).toEqual([]);
  });

  it("S7 control: a start whose reply was lost keeps its number; Today is not offered and nothing is stopped by itself", async () => {
    const a = app();
    a.route(async (url, init, base) => { if (isPost(init, "session.start")) throw new TypeError("network"); return base(url, init); });
    render(<App />);
    fireEvent.click(await startButton(a));
    await waitFor(() => expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"])); await settled();
    await screen.findByRole("button", { name: /Проверить/ });
    expect(screen.queryByRole("button", { name: "На Сегодня" })).toBeNull();
    expect(stops(a)).toEqual([]);
  });
});

/**
 * F1 of the first choice on its real legacy path (б), probes of QA-FIRST-CHOICE r2: the language at version 1, an older
 * session open, Learning -> Settings -> a save of another field whose reply is lost, the session closed, Today. That save
 * stays the user's own unknown outcome under its old command: the gate never resends, clears or replaces it (C211).
 */
async function legacySaveOfAnotherField(reply: "applied-lost" | "never-applied") {
  const a = app({ session: id(3), dictionaryVersion: "1" });
  const base = a.fetcher.getMockImplementation()!;
  let appliedId: string | null = null;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (isPost(init, "setting.save") && JSON.parse(String(init!.body)).payload.key === "learning_group_size") {
      if (reply === "applied-lost") { await base(url, init); appliedId = JSON.parse(String(init!.body)).command_id; }
      throw new TypeError("lost reply");
    }
    if (path.includes("/commands/")) {
      const commandId = path.split("/").at(-1)!;
      const { state_version, ...projection } = await (await base("/api/v1/settings", { method: "GET" })).json();
      if (commandId === appliedId) return response({ command: { id: commandId, kind: "setting.save", status: "already_applied",
        applied_at: "2026-10-09T00:00:00Z", target_id: id(50), action_id: null, result_id: null, context_id: null, object_version: "2" },
        current: projection, state_version });
      return response({ command: { id: commandId, status: "not_found" }, current: profile(state_version), state_version });
    }
    return base(url, init);
  });
  render(<App />);
  await editable();
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  const field = within(await screen.findByRole("group", { name: "Новых карточек в группе" }, exchange));
  await waitFor(() => expect((field.getByRole("textbox") as HTMLInputElement).disabled).toBe(false), exchange);
  fireEvent.change(field.getByRole("textbox"), { target: { value: "7" } });
  fireEvent.click(field.getByRole("button", { name: "Сохранить" }));
  await screen.findAllByText(/Пока не удалось подтвердить сохранение/, undefined, exchange);
  const stored = localStorage.getItem(settingSlot)!;
  expect(JSON.parse(stored).intent.payload.key).toBe("learning_group_size");
  // The session is closed elsewhere; the person returns to Today.
  a.server.session = null;
  a.f.setStep({ ...current(), status: "summary", assignment: null });
  return { a, stored };
}
const isSettingSave = (post: Record<string, unknown>) => post.kind === "setting.save";
const enPairText = "Активная пара: Английский ↔ Немецкий";

describe("F1 of the first choice on the real legacy path (б): version 1, no version raise", () => {
  it("applied save with a lost reply: the return to Today is resolved by the status check, then the choice; the old command is not resent", async () => {
    const { a, stored } = await legacySaveOfAnotherField("applied-lost");
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    const heading = await screen.findByRole("heading", { level: 1, name: "Язык словаря" }, exchange);
    expect(a.posts().filter(isSettingSave)).toHaveLength(1);
    expect(a.posts().filter(isSettingSave)[0].command_id).toBe(JSON.parse(stored).intent.command_id);
    expect(localStorage.getItem(settingSlot)).toBeNull();
    const page = within(heading.closest("main")!);
    await waitFor(() => expect(page.getByRole("radio", { name: "Немецко-английский" }).hasAttribute("disabled")).toBe(false), exchange);
    fireEvent.click(page.getByRole("radio", { name: "Немецко-английский" }));
    fireEvent.click(page.getByRole("button", { name: "Продолжить" }));
    await screen.findByText(enPairText, undefined, exchange);
    const saves = a.posts().filter(isSettingSave);
    expect(saves).toHaveLength(2); expect(saves[1].payload).toMatchObject({ key: "dictionary_language", value: "en" });
  });

  it("F1 boundary, never-applied save: Today shows the failed frame; retry only reads the status; the stored intent is byte-for-byte the same", async () => {
    const { a, stored } = await legacySaveOfAnotherField("never-applied");
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText("Не удалось загрузить план", undefined, exchange);
    for (let n = 0; n < 2; n++) {
      fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
      await screen.findByText("Не удалось загрузить план", undefined, exchange);
    }
    expect(a.posts().filter(isSettingSave)).toHaveLength(1);
    expect(localStorage.getItem(settingSlot)).toBe(stored);
    expect(screen.queryByRole("heading", { level: 1, name: "Язык словаря" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

// C159 (no false published state): a seed read of the session can outrun the Settings read of the same document.
// Settings are then read again. Until that read is current the gate stays closed, and the screen says that settings are
// loading, never that the user must confirm them.
describe("Learning: Settings re-read after the session seed outran them", () => {
  const confirmText = "нужно подтвердить настройки";
  const failedText = "Не удалось подтвердить настройки занятия.";
  const loadingText = "Загружаем настройки занятия.";
  const wait = (ms = 300) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const gateOpen = () => { const box = screen.queryByRole("textbox") as HTMLInputElement | null; return !!box && !box.readOnly; };
  const bodyText = () => document.body.textContent ?? "";

  type Later = "current" | "refused" | "below-floor" | "needs-setup";
  /**
   * The first Settings read is answered, a profile write follows it, and only then the session answers (its version is
   * above the Settings just read). Every later Settings read waits for `hold`, then answers as `later` says.
   */
  function raceSettings(a: Server, later: Later, hold?: Promise<void>) {
    const base = a.fetcher.getMockImplementation()!;
    const bumped = gate(), second = gate();
    let reads = 0, first: Response | null = null;
    a.fetcher.mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
      if (method === "GET" && path.endsWith("/settings")) {
        const reply = await base(url, init);
        if (++reads === 1) { first = reply.clone(); a.changePairElsewhere("ru"); bumped.open(); return reply; }
        second.open();
        if (hold) await hold;
        if (later === "refused") return response({ error: { code: "INTERNAL" } }, 500);
        if (later === "below-floor") return first!.clone();
        if (later === "needs-setup") return response({ ...(await reply.json()), needs_setup: true });
        return reply;
      }
      if (method === "GET" && path.includes("/sessions/")) { await bumped.promise; await new Promise(resolve => setTimeout(resolve, 30)); }
      return base(url, init);
    });
    return { reads: () => reads, reached: () => second.promise };
  }

  it("every published state: no «confirm settings» text, the gate is closed until the re-read, then the answer goes", async () => {
    const a = app({ session: id(3) }); const hold = gate(); const race = raceSettings(a, "current", hold.promise);
    const flash = watchCommits([confirmText, failedText]);
    let during!: { gate: boolean; posts: number; loading: boolean };
    try {
      render(<App />);
      await race.reached(); await wait();
      // The held re-read is under way: the owner is not ready, so no mode action exists.
      during = { gate: gateOpen(), posts: a.studyPosts().length, loading: bodyText().includes(loadingText) };
      hold.open();
      const input = await editable();
      a.f.wrong();
      fireEvent.change(input, { target: { value: "Haus" } });
      fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
      await screen.findByRole("region", { name: "Есть ошибка" }, exchange);
      await wait();
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    expect(during).toEqual({ gate: false, posts: 0, loading: true });
    expect(race.reads()).toBe(2);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["answer.submit"]);
  });

  it("a permanent refusal of the re-read: the failed text with the exit and the retry as before", async () => {
    const a = app({ session: id(3) }); const race = raceSettings(a, "refused");
    render(<App />);
    await screen.findByText(failedText, undefined, exchange); await wait();
    expect(gateOpen()).toBe(false); expect(a.studyPosts()).toEqual([]);
    expect(screen.getByRole("button", { name: "Настройки" })).toBeTruthy();
    const reads = race.reads();
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(race.reads()).toBeGreaterThan(reads)); await settled();
    expect(screen.getByText(failedText)).toBeTruthy(); expect(gateOpen()).toBe(false);
  });

  it("Settings below the seed version for good: the failed text with the exit and the retry as before", async () => {
    const a = app({ session: id(3) }); const race = raceSettings(a, "below-floor");
    render(<App />);
    await screen.findByText(failedText, undefined, exchange); await wait();
    expect(gateOpen()).toBe(false); expect(a.studyPosts()).toEqual([]);
    expect(screen.getByRole("button", { name: "Настройки" })).toBeTruthy();
    const reads = race.reads();
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(race.reads()).toBeGreaterThan(reads)); await settled();
    expect(screen.getByText(failedText)).toBeTruthy(); expect(gateOpen()).toBe(false);
  });

  it("a current read that still needs setup: the «confirm settings» text with the exit and the retry as before", async () => {
    const a = app({ session: id(3) }); const race = raceSettings(a, "needs-setup");
    render(<App />);
    await screen.findByText(new RegExp(confirmText), undefined, exchange); await wait();
    expect(gateOpen()).toBe(false); expect(a.studyPosts()).toEqual([]);
    expect(screen.getByRole("button", { name: "Настройки" })).toBeTruthy();
    const reads = race.reads();
    fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
    await waitFor(() => expect(race.reads()).toBeGreaterThan(reads)); await settled();
    expect(screen.getByText(new RegExp(confirmText))).toBeTruthy(); expect(gateOpen()).toBe(false);
  });
});

// C159 layer 6: an unresolved setting save is checked only after the session seed has outrun Settings. Whatever the
// check finds, the stale reply is not taken, the draft and the stored intent survive, the gate opens only on current
// Settings, and no study command or new command ID appears.
describe("Learning: a setting save resolved after the Settings race", () => {
  const confirmText = "нужно подтвердить настройки";
  const pendingText = "Проверяем сохранение настроек. Начать занятие пока нельзя.";
  const loadingText = "Загружаем настройки занятия.";
  const intentId = id(60);
  const wait = (ms = 300) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const gateOpen = () => { const box = screen.queryByRole("textbox") as HTMLInputElement | null; return !!box && !box.readOnly; };
  /** The chain after a raced start (open, Settings, session, a second Settings read) takes longer than the default 1 s. */
  const gateOpens = async () => {
    await screen.findByRole("textbox", undefined, exchange); await waitFor(() => expect(gateOpen()).toBe(true), exchange);
  };
  const stored = () => localStorage.getItem(settingSlot) !== null;
  const chosen = () => (document.querySelector("select option[value=accelerated]")?.closest("select") as HTMLSelectElement | null)?.value;

  type Mode = "accepted-current" | "accepted-stale" | "unknown" | "rejected";
  /**
   * The unsent-to-us save (written at registration, so it belongs to this client instance) is checked only after the
   * first session read answered with a version above every Settings read. `mode` is what that check, and for a repeat the
   * send, finds.
   */
  function saveRace(a: Server, mode: Mode) {
    const base = a.fetcher.getMockImplementation()!;
    const statusGate = gate(), settingsHold = mode === "accepted-stale" ? gate() : null;
    const seen = { settingsGets: 0, statusGets: 0, saves: [] as string[] };
    let bumped = false, override: { value: string; version: string } | null = null;
    const projection = async () => {
      const body = await (await base("/settings", { method: "GET" })).json();
      if (override) body.settings.transition_mode = { ...override };
      return body;
    };
    a.fetcher.mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith("/client/register")) localStorage.setItem(settingSlot, JSON.stringify({ schemaVersion: 1, profileId: id(50),
        clientInstanceId: body.client_instance_id, intent: { command_id: intentId, kind: "setting.save", expected_field_version: "1",
          payload: { key: "transition_mode", value: "accelerated" } } }));
      if (method === "GET" && path.endsWith(`/commands/${intentId}`)) {
        seen.statusGets++;
        await statusGate.promise;
        if (mode === "accepted-current" || mode === "accepted-stale") {
          override = { value: "accelerated", version: "2" };
          const { state_version: _, ...current } = await projection();
          return response({ command: { id: intentId, kind: "setting.save", status: "already_applied", applied_at: "2026-09-30T00:00:00Z",
            target_id: id(50), action_id: null, result_id: null, context_id: null, object_version: "2" }, current,
            state_version: mode === "accepted-stale" ? "1" : a.version() });
        }
        return response(missing({ command_id: intentId } as never, a.version()));
      }
      if (method === "GET" && path.endsWith("/settings")) {
        seen.settingsGets++;
        if (settingsHold) await settingsHold.promise;
        return response(await projection());
      }
      if (method === "POST" && path.endsWith("/commands") && body?.kind === "setting.save") {
        seen.saves.push(body.command_id);
        if (mode === "rejected") {
          const { state_version: _, ...current } = await projection();
          return response({ command: { id: body.command_id, status: "rejected" }, current, state_version: a.version(),
            error: { code: "VALIDATION_FAILED" } }, 422);
        }
      }
      if (method === "GET" && path.includes("/sessions/")) {
        if (!bumped) { bumped = true; a.changePairElsewhere("ru"); }
        const reply = await base(url, init); statusGate.open(); return reply;
      }
      return base(url, init);
    });
    return { seen, release: () => settingsHold?.open() };
  }

  it("accepted, and the reply is current: the stored intent is cleared, the gate opens, nothing is sent", async () => {
    const a = app({ session: id(3) }); const { seen } = saveRace(a, "accepted-current");
    const flash = watchCommits([confirmText]);
    try { render(<App />); await gateOpens(); await wait(500); } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    expect(stored()).toBe(false); expect(seen.saves).toEqual([]); expect(a.posts()).toEqual([]);
  });

  it("accepted, but the reply is older than the seed: not taken, the gate stays closed until a current read", async () => {
    const a = app({ session: id(3) }); const { seen, release } = saveRace(a, "accepted-stale");
    const flash = watchCommits([confirmText]);
    try {
      render(<App />);
      await waitFor(() => expect(seen.settingsGets).toBe(1), exchange); await wait(500);
      // The accepted fact is known (the stored intent is gone), the stale data is not used, and the read is under way.
      expect(stored()).toBe(false); expect(gateOpen()).toBe(false); expect(screen.getByText(loadingText)).toBeTruthy();
      release(); await gateOpens();
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]); expect(seen.saves).toEqual([]); expect(a.posts()).toEqual([]);
  });

  it.each(["unknown", "rejected"] as const)("%s: the intent and the gate stay closed; an explicit repeat sends the same command ID once", async mode => {
    const a = app({ session: id(3) }); const { seen } = saveRace(a, mode);
    const flash = watchCommits([confirmText]);
    try {
      render(<App />);
      await screen.findByText(pendingText, undefined, exchange); await wait(500);
      expect(stored()).toBe(true); expect(gateOpen()).toBe(false); expect(seen.saves).toEqual([]); expect(a.studyPosts()).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
      fireEvent.click(await screen.findByRole("button", { name: "Повторить отправку" }, exchange));
      await waitFor(() => expect(stored()).toBe(false), exchange);
      // The draft of the intent is the unsent choice; a refusal does not discard it.
      if (mode === "rejected") expect(chosen()).toBe("accelerated");
      fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
      await gateOpens();
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    expect(seen.saves).toEqual([intentId]); expect(a.studyPosts()).toEqual([]);
  });
});

// C185 (owner answer 31.1-А): while the owner sends or checks a settings reset, Learning says that settings are loading,
// never that the user must confirm them; the gate stays closed, and a failed send or check stays the failed text.
describe("Learning: a settings reset in flight", () => {
  const confirmText = "нужно подтвердить настройки";
  const loadingText = "Загружаем настройки занятия.";
  const failedText = "Не удалось подтвердить настройки занятия.";
  const wait = (ms = 300) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
  const gateOpen = () => { const box = screen.queryByRole("textbox") as HTMLInputElement | null; return !!box && !box.readOnly; };
  // Each profile keeps its reset in its own slot (MA-09); the legacy global key is only read, never written.
  const resetKey = settingsResetSlotOf(id(50));

  it("sent from Settings and back in Learning: loading while sending, failed when lost, loading while checked, failed again", async () => {
    const a = app({ session: id(3) }); const base = a.fetcher.getMockImplementation()!;
    const send = gate(), status = gate(); let checking = false;
    a.fetcher.mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (method === "POST" && path.endsWith("/commands") && body?.kind === "settings.reset") { await send.promise; throw new TypeError("network"); }
      if (method === "GET" && path.includes("/commands/") && checking) { await status.promise; throw new TypeError("network"); }
      return base(url, init);
    });
    const flash = watchCommits([confirmText]);
    try {
      render(<App />); await editable();
      fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
      fireEvent.click(await screen.findByRole("button", { name: "Сброс настроек" }));
      fireEvent.click(await screen.findByRole("button", { name: "Вернуть" }));
      await screen.findByText("Возвращаем исходные настройки");
      fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
      await screen.findByText(loadingText, undefined, exchange); expect(gateOpen()).toBe(false);
      send.open();
      await screen.findByText(failedText, undefined, exchange); expect(gateOpen()).toBe(false);
      checking = true;
      fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
      await screen.findByText(loadingText, undefined, exchange); expect(gateOpen()).toBe(false);
      status.open();
      await screen.findByText(failedText, undefined, exchange); expect(gateOpen()).toBe(false);
      await wait();
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    // Only the reset itself was sent, and it stays stored for its own check.
    expect(localStorage.getItem(resetKey)).not.toBeNull(); expect(a.studyPosts().map(post => post.kind)).toEqual(["settings.reset"]);
  });

  it("stored from an earlier launch: loading while its status is checked, failed when the check is lost", async () => {
    const a = app({ session: id(3) }); const base = a.fetcher.getMockImplementation()!; const status = gate();
    a.fetcher.mockImplementation(async (url, init) => {
      const method = init?.method ?? "GET", path = new URL(String(url), "http://localhost").pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      // Written at registration, so the record belongs to this client instance.
      if (path.endsWith("/client/register")) localStorage.setItem(resetKey, JSON.stringify({ schemaVersion: 1, profileId: id(50),
        clientInstanceId: body.client_instance_id, intent: { command_id: id(61), kind: "settings.reset", payload: {} } }));
      if (method === "GET" && path.endsWith(`/commands/${id(61)}`)) { await status.promise; throw new TypeError("network"); }
      return base(url, init);
    });
    const flash = watchCommits([confirmText]);
    try {
      render(<App />);
      await screen.findByText(loadingText, undefined, exchange);
      await waitFor(() => expect(a.fetcher.mock.calls.some(([url]) => String(url).endsWith(`/commands/${id(61)}`))).toBe(true), exchange);
      await wait(); expect(screen.getByText(loadingText)).toBeTruthy(); expect(gateOpen()).toBe(false);
      status.open();
      await screen.findByText(failedText, undefined, exchange); expect(gateOpen()).toBe(false);
      await wait();
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    expect(a.studyPosts()).toEqual([]);
  });

  it("MA-09: a reset of this profile left in the legacy global key fails closed until P02: no status check, no send, kept as is", async () => {
    const a = app({ session: id(3) }); const base = a.fetcher.getMockImplementation()!;
    let legacy: string | null = null;
    a.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      // Written by an older build of this client: only read by this one, never written, removed or migrated.
      if (path.endsWith("/client/register")) {
        legacy = JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: body.client_instance_id,
          intent: { command_id: id(61), kind: "settings.reset", payload: {} } });
        localStorage.setItem(SETTINGS_RESET_SLOT, legacy);
      }
      return base(url, init);
    });
    const flash = watchCommits([confirmText]);
    try {
      render(<App />);
      await screen.findByText(failedText, undefined, exchange); expect(gateOpen()).toBe(false);
      await wait();
    } finally { flash.stop(); }
    expect(flash.seen).toEqual([]);
    expect(a.fetcher.mock.calls.some(([url]) => String(url).endsWith(`/commands/${id(61)}`))).toBe(false);
    expect(a.studyPosts()).toEqual([]);
    expect(localStorage.getItem(SETTINGS_RESET_SLOT)).toBe(legacy); expect(localStorage.getItem(resetKey)).toBeNull();
  });
});

// Answer 17.1-А / 17.2-А (R1): the pair moved to uk on another device and this window's start made the Learning session
// in uk-de. The window refreshes its access by itself (one client/open) and shows that session; Stop of it is never sent
// from the old screen, a local exit without a command stays.
describe("Learning R1: the window refreshes itself into the session of the new pair (17.1-А)", () => {
  async function inSession(a: Server, started: string) {
    fireEvent.click(await screen.findByRole("button", { name: "Дальше" }, exchange));
    await waitFor(() => expect(a.studyPosts().map(post => post.kind)).toContain("learning.preview_next"), exchange);
    const stop = await screen.findByRole("button", { name: "Выйти" });
    await waitFor(() => expect((stop as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(stop);
    await waitFor(() => expect(a.studyPosts().filter(post => post.kind === "session.stop")
      .map(post => post.session_id)).toEqual([started]), exchange);
  }
  // QA-REOPEN-FIX F1: a window that already got the new pair and started there itself is no R1; its foreground keeps
  // the owner, the typed answer and the field (only a session this document refreshed for is selected anew).
  it("no R1: own start after the window got the new pair, a foreground mid-question keeps the draft and the field", async () => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); await startButton(a);
    world.moved = true;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); await pause(2500);
    fireEvent.click(await screen.findByRole("button", { name: /Новая группа слов/ }, exchange));
    fireEvent.click(await screen.findByRole("button", { name: "Дальше" }, exchange));
    const input = await screen.findByRole("textbox", undefined, exchange) as HTMLInputElement;
    await waitFor(() => expect(input.readOnly).toBe(false));
    // QA T5: the own start in the new pair is one start and its question is shown, never a reselection.
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start", "learning.preview_next", "assignment.present"]);
    fireEvent.change(input, { target: { value: "Hau" } }); await pause(300);
    const opens = world.opens.length;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); await pause(3000);
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    const after = screen.getByRole("textbox") as HTMLInputElement;
    expect(after.value).toBe("Hau"); expect(after).toBe(input);
  });
  // C151 (no false published state): from the tap until the card, «not started» is never on screen, neither in the old
  // pair nor in the new one; the start under way shows the loading status the start itself shows.
  it.each([["R1", true, false], ["own pair", false, false], ["R1 StrictMode", true, true], ["own pair StrictMode", false, true]] as const)(
    "%s: the start never publishes «Занятие ещё не началось.» before the card", async (_, moved, strict) => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(strict ? <StrictMode><App /></StrictMode> : <App />); const start = await startButton(a);
    const flash = watchCommits(["Занятие ещё не началось.", "Заняття ще не почалося."]);
    const loading = watchCommits(["Загружаем занятие…"]);
    try {
      world.moved = moved; fireEvent.click(start);
      expect(await screen.findByText("Hallo", undefined, exchange)).toBeTruthy();
      await pause(300);
    } finally { flash.stop(); loading.stop(); }
    expect(flash.seen).toEqual([]);
    expect(loading.seen.length).toBeGreaterThan(0);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
  });
  it("direct reply: one client/open, the card of the uk session, no other start and no Stop before it", async () => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(a); const opens = world.opens.length;
    // C149/C151 (guard v3): the known pair change of the confirmed start is no failed update, so no failure text is shown.
    const failure = watchCommits(["Не удалось обновить занятие", "Не вдалося оновити заняття"]);
    try {
      world.moved = true; fireEvent.click(start);
      expect(await screen.findByText("Hallo", undefined, exchange)).toBeTruthy();
      await pause(1000);
    } finally { failure.stop(); }
    expect(failure.seen).toEqual([]);
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
    await inSession(a, world.started!);
  });
  // A refresh that still names the old pair (a world the core never answers) is not asked again by later checks.
  it("a refresh that still names the old pair is not asked again by later checks, and Stop keeps waiting", async () => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(a); const opens = world.opens.length;
    world.moved = true; world.openOld = true; fireEvent.click(start);
    await pause(1500);
    for (let check = 0; check < 2; check++) {
      fireEvent.click(await screen.findByRole("button", { name: "Проверить состояние" }, exchange)); await pause(1500);
    }
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
    expect(enabledExits()).toEqual([]);
  });
  // 2.3-А with the automatic recovery (QA-R1-V3 F6). An old record X of this installation in the written slot of the new
  // pair, of an automatic kind, addressed to a session Z that is no open step of this window. After the refresh the
  // written owner of the new pair resumes X with the send count the page knows (k), checks it by its ID only, and the
  // server's «not found» proves no open step of X here, so X is never sent, whatever k is.
  it.each([null, 1, 5])("2.3-А: an old automatic record X with the known send count %s is only checked, never sent", async marks => {
    const X = "7a1b2c3d-0000-4000-8000-00000000dd01", Z = "7a1b2c3d-0000-4000-8000-00000000dd02";
    sendCount.loads = []; sendCount.loaded = []; sendCount.marks = marks; sendCount.ids = marks === null ? [] : [X];
    try {
      const a = app(); const world = pairMoved(a.fetcher);
      // The server never received X: its status by ID is «not found» at the current profile.
      const served = a.fetcher.getMockImplementation()!; let profileNow: { state_version: string } | null = null;
      a.fetcher.mockImplementation(async (url, init) => {
        if ((init?.method ?? "GET") === "GET" && String(url).includes(`/commands/${X}`) && profileNow) {
          return response({ command: { id: X, status: "not_found" }, current: profileNow, state_version: profileNow.state_version });
        }
        const reply = await served(url, init);
        if (String(url).includes("/client/open")) profileNow = (await reply.clone().json() as { profile: { state_version: string } }).profile;
        return reply;
      });
      render(<App />); const start = await startButton(a);
      const key = Object.keys(localStorage).find(name => name.startsWith("wortly.installation:"))!;
      const installation = JSON.parse(localStorage.getItem(key)!) as { profileId: string; clientInstanceId: string };
      const mark = a.fetcher.mock.calls.length;
      world.moved = true; fireEvent.click(start);
      localStorage.setItem("wortly.pending.written_session", JSON.stringify({ schemaVersion: 1, profileId: installation.profileId,
        clientInstanceId: installation.clientInstanceId, pair: "uk-de", intent: { command_id: X, session_id: Z, kind: "answer.submit",
          assignment_id: "7a1b2c3d-0000-4000-8000-00000000dd03", payload: { text: "Haus" } } }));
      expect(await screen.findByText("Hallo", undefined, exchange)).toBeTruthy();
      await pause(4000);
      // The automatic recovery took X with the page's count (the decision about a send was reached).
      expect(sendCount.loads).toContain(X);
      expect(sendCount.loaded.filter(entry => entry.commandId === X).map(entry => entry.transmitted)).toContain(marks);
      const onX = a.fetcher.mock.calls.slice(mark).filter(([url, init]) => String(url).includes(X) || String(init?.body ?? "").includes(X))
        .map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`);
      expect(onX.length).toBeGreaterThan(0);
      expect(new Set(onX)).toEqual(new Set([`GET /api/v1/commands/${X}`]));
      expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
    } finally { sendCount.marks = null; sendCount.ids = []; }
  }, 30000);
  // C151 forks: a reply below the floor, a reply naming another session, and a refresh that finds the created session
  // closed, another session open or the pair changed again. None is this start's R1 landing: no refresh into it, no new
  // start, no Stop of any session, and the session is never shown. The refresh itself asks once.
  it.each(noLandings)("no landing (%s): no second start, no Stop, the created session is not shown", async kind => {
    const a = app(); const world = pairMoved(a.fetcher); world.low = kind === "low";
    render(<App />); const start = await startButton(a); const opens = world.opens.length;
    moveWithout(world, kind); fireEvent.click(start);
    await pause(3000);
    expect(world.opens.slice(opens)).toEqual(kind === "low" || kind === "foreign" ? [] : ["foreground"]);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
    expect(screen.queryByText("Hallo")).toBeNull();
    // A reply that proves nothing leaves the start unknown, and its Stop stays as before (17.2-А is not a general ban).
    if (kind !== "low" && kind !== "foreign") expect(enabledExits()).toEqual([]);
  });
  it("lost reply: Stop stays while the start is unknown; its check confirms it, then the refresh", async () => {
    const a = app(); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(a); const opens = world.opens.length;
    world.moved = true; loseStudyReply(a.fetcher, "session.start"); fireEvent.click(start);
    const check = await screen.findByRole("button", { name: "Проверить состояние" }, exchange);
    await pause(1500);
    expect(world.opens.slice(opens)).toEqual([]);
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(check);
    expect(await screen.findByText("Hallo", undefined, exchange)).toBeTruthy();
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    await inSession(a, world.started!);
  });
  it("before the refresh answers: no Stop by «Выйти» or Back, «Настройки» leaves without a command, one open", async () => {
    const back = fakeBack(); const a = app({ back }); const world = pairMoved(a.fetcher);
    render(<App />); const start = await startButton(a); const opens = world.opens.length;
    world.moved = true; const open = foregroundOpen(a.fetcher, "hold"); fireEvent.click(start);
    await screen.findByRole("button", { name: "Проверить состояние" }, exchange);
    await pause(500);
    const stop = screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop); await back.click();
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await pause(1000);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" })); await pause(500);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
    expect(open.attempts).toBe(1);
    open.release();
    expect(await screen.findByText("Hallo", undefined, exchange)).toBeTruthy();
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    await inSession(a, world.started!);
  });
  // C206 (QA-FINAL Q4, C245): stopY (21.1-А, 33.1-А) and stop_gate_r1 (17.2-А) on one App, phase after phase. While the
  // transmitted start is unknown, Stop keeps its rights (17.2 is no ban of Stop at an unknown start); once the start is
  // the own accepted start of S in the new pair, Stop waits for the refresh; after it, the ordinary rights of S. The phase
  // before the request (the local save, 21.1-А) is pinned by the lanes (learningStopDuringStartSave), not here.
  it.each([false, true])("stopY × stop_gate: request in flight, then own accepted S before the refresh, then S (StrictMode %s)", async strict => {
    const back = fakeBack(); const a = app({ back }); const world = pairMoved(a.fetcher);
    render(strict ? <StrictMode><App /></StrictMode> : <App />); const start = await startButton(a); const opens = world.opens.length;
    world.moved = true; const open = foregroundOpen(a.fetcher, "hold");
    const base = a.fetcher.getMockImplementation()!;
    let answerStart = () => {}; const reply = new Promise<void>(done => { answerStart = done; });
    a.fetcher.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && JSON.parse(String(init.body)).kind === "session.start") await reply;
      return base(url, init);
    });
    fireEvent.click(start); await pause(600);
    // The request of the start began and is unanswered: an unknown transmitted start, Stop is offered as before.
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
    answerStart(); await pause(800);
    // The core created S in the new pair and the refresh is held: no exit, «Выйти» and Back send no Stop.
    expect(enabledExits()).toEqual([]);
    const exit = screen.queryByRole("button", { name: "Выйти" });
    if (exit) fireEvent.click(exit);
    await back.click(); await pause(300);
    expect(a.studyPosts().map(post => post.kind)).toEqual(["session.start"]);
    expect(open.attempts).toBe(1);
    open.release();
    expect(await screen.findByText("Hallo", undefined, exchange)).toBeTruthy();
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    await inSession(a, world.started!);
  });
});

// D-STALE-WINDOW, C188: a Learning Stop refused as DOCUMENT_STALE. The App's foreground check of the document decides
// what follows: a replaced document closes the window; a live one keeps the Stop to check and retry by hand.
async function currentVersion(base: Fetch) {
  return (await (await base("http://localhost/api/v1/settings", { method: "GET" })).json() as { state_version: string }).state_version;
}
function refuseStop(a: Server, foreground: "replaced" | "live") {
  const base = a.fetcher.getMockImplementation()!;
  let refused: string | null = null;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
    if (path.endsWith("/client/open") && body?.event === "foreground" && foreground === "replaced") {
      return new Response(JSON.stringify(staleRefusal), { status: 409 });
    }
    if (init?.method === "POST" && body?.kind === "session.stop") {
      if (refused === null) {
        refused = body.command_id;
        // The refusal carries the server's current version, as the core's envelope does.
        return new Response(JSON.stringify(staleCommand(body.command_id, body.session_id, Number(await currentVersion(base)), "session.stop")),
          { status: 409 });
      }
      // As this file's other Stop tests: an accepted Stop ends the session the open reply reports.
      const reply = await base(url, init);
      if (reply.ok) a.server.session = null;
      return reply;
    }
    // The core's not_found for the refused Stop (this fake asks each test for an explicit one).
    if (refused !== null && init?.method !== "POST" && path.endsWith(`/commands/${refused}`)) {
      const version = await currentVersion(base);
      return new Response(JSON.stringify({ command: { id: refused, status: "not_found" }, current: profile(version), state_version: version }));
    }
    return base(url, init);
  });
}
const requestsSince = (a: Server, mark: number) => a.fetcher.mock.calls.slice(mark)
  .map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`).filter(entry => entry !== "GET /api/v1/settings");

describe("Learning Stop refused as DOCUMENT_STALE (C188)", () => {
  it("replaced window: «Wortly уже открыт», no buttons, nothing more is sent, the Stop record stays", async () => {
    const a = app(); await startToQuestion(a);
    const close = vi.fn();
    Object.assign((globalThis as unknown as { Telegram: { WebApp: object } }).Telegram.WebApp, { close });
    refuseStop(a, "replaced");
    const mark = a.fetcher.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await screen.findByRole("heading", { name: "Wortly уже открыт" });
    await pause(300); await pause(300);
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    expect(requestsSince(a, mark)).toEqual(["POST /api/v1/commands", "POST /api/v1/client/open"]);
    expect(JSON.parse(localStorage.getItem("wortly.pending.learning_stop")!).intent).toMatchObject({ kind: "session.stop" });
  });

  it("live window: the Stop is checked, its manual retry sends the same ID once, and Today then loads its plan", async () => {
    const a = app(); await startToQuestion(a);
    refuseStop(a, "live");
    const mark = a.fetcher.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    const retry = await screen.findByRole("button", { name: "Повторить завершение" }, exchange);
    expect(screen.getByText("Завершаем занятие…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(true);
    const stops = () => a.posts().filter(post => post.kind === "session.stop");
    expect(stops()).toHaveLength(1);
    expect(requestsSince(a, mark).filter(entry => entry.startsWith("GET /api/v1/commands/")).length).toBeGreaterThan(0);
    fireEvent.click(retry);
    await screen.findByRole("heading", { name: "Сегодня" }, exchange);
    await pause(300);
    expect(stops()).toHaveLength(2);
    expect(stops()[1].command_id).toBe(stops()[0].command_id);
    expect(requestsSince(a, mark)).toContain("GET /api/v1/today");
    expect(screen.queryByText("Не удалось загрузить план")).toBeNull();
    expect(localStorage.getItem("wortly.pending.learning_stop")).toBeNull();
  });
});

// C249: the own start of this window lost before the server, checked and sent again by hand with the same ID.
describe("Learning own start retried by hand after its loss (C249)", () => {
  it("the one retry of the same command and session, confirmed by the server, shows the preview of that session", async () => {
    const a = app();
    const lost: { intent: LearningCommandIntent | null } = { intent: null };
    a.route(async (url, init, base) => {
      if (isPost(init, "session.start") && lost.intent === null) {
        lost.intent = JSON.parse(String(init!.body)) as LearningCommandIntent; throw new TypeError("network");
      }
      const sent = lost.intent;
      // Until the retry the server never received this start: its status and its session are both not found.
      if (sent && a.studyPosts().length === 1 && String(url).includes(`/commands/${sent.command_id}`)) return response(missing(sent, a.version()));
      if (sent && a.studyPosts().length === 1 && (init?.method ?? "GET") === "GET" && String(url).includes(`/sessions/${sent.session_id}`)) {
        return response({ state_version: a.version(), current: { session_id: sent.session_id, status: "not_found" } });
      }
      return base(url, init);
    });
    render(<App />);
    fireEvent.click(await startButton(a));
    fireEvent.click(await screen.findByRole("button", { name: "Проверить состояние" }, exchange));
    const retry = await screen.findByRole("button", { name: "Повторить отправку" }, exchange);
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false), exchange);
    fireEvent.click(retry);
    await waitFor(() => expect(a.studyPosts()).toHaveLength(2), exchange);
    expect(await screen.findByRole("button", { name: "Дальше" }, exchange)).toBeTruthy();
    expect(screen.queryByText("Проверяем, сохранилось ли действие.")).toBeNull();
    expect(a.studyPosts().map(post => [post.kind, post.command_id, post.session_id])).toEqual([
      ["session.start", lost.intent!.command_id, lost.intent!.session_id], ["session.start", lost.intent!.command_id, lost.intent!.session_id]]);
    // The preview goes on by the usual rights of that very session: «Дальше», then the question by one present.
    const next = () => screen.getByRole("button", { name: "Дальше" }) as HTMLButtonElement;
    await waitFor(() => expect(next().disabled).toBe(false), exchange);
    fireEvent.click(next());
    await editable();
    expect(a.studyPosts().map(post => [post.kind, post.session_id])).toEqual([["session.start", lost.intent!.session_id],
      ["session.start", lost.intent!.session_id], ["learning.preview_next", lost.intent!.session_id], ["assignment.present", lost.intent!.session_id]]);
  });
});
