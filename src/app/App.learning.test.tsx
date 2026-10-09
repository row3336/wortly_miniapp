import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningCommandIntent } from "../learning/learningCommandIntent";
import type { Profile, SettingCommand, SettingsResponse, TodayResponse } from "../api/generated";
import { previewContent } from "../learning/learningPreview.test-support";
import { learningViewFixture } from "../learning/learningView.test-support";
import { current, deferred, id, missing, profile, response } from "../learning/learningFixtures.test-support";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { SessionResumeController } from "../study/sessionResumeController";
import { App } from "./App";
import { gate, refuseOnce, replaceDocument, watchFlash } from "./flashWatch.test-support";
import { staleRefusal } from "./openRules.test-support";
import { cardIdOf } from "../dictionary/card/cardTestData.test-support";
import { besidesContext, launch, serveLaunchCard } from "./launchCard.test-support";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Route = (url: string | URL | Request, init: RequestInit | undefined, base: Fetch) => Promise<Response>;
const compatibility = { compatible: true, contract_version: "1" };
const pairText = "Активная пара: Русский ↔ Немецкий";
/** A wait for a screen that arrives after a chain of server exchanges (open, Today, session read): not the default 1 s. */
const exchange = { timeout: 5000 };
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
  back?: ReturnType<typeof fakeBack> } = {}) {
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
    const a = app({ session: id(3) }); a.f.setStep({ ...current(), status: "summary", assignment: null });
    a.route(async (url, init, base) => {
      if (isPost(init, "session.stop")) { const reply = await base(url, init); a.server.session = null; return reply; }
      if (!isPost(init, "session.start")) return base(url, init);
      const value = await (await base(url, init)).json();
      value.current.pair = "en-de"; value.current.preview.content = previewContent(id(21), "en-de");
      a.f.setStep(value.current); return response(value);
    });
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: "Вернуться на Сегодня" }));
    await screen.findByText(pairText);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name: "Настройки" }));
    await saveSetting("Язык словаря", "en");
    await waitFor(() => expect(a.posts().some(post => (post.kind as string) === "setting.save")).toBe(true));
    await screen.findAllByText("Сохранено");
    const reads = a.gets(`/sessions/${id(3)}?`).length, stages = before(a);
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
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
    const a = app({ session: id(3) }); render(<App />);
    await editable();
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await saveSetting("Язык словаря", "en");
    await screen.findAllByText("Сохранено");
    expect(a.server.session).toBeNull();
    const reads = a.gets(`/sessions/${id(3)}?`).length, stages = before(a);
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await afterPairChange(a, stages);
    expect(screen.queryByRole("heading", { name: "Изучение слов" })).toBeNull(); // A1
    expect(a.gets(`/sessions/${id(3)}?`)).toHaveLength(reads); // A2
    expect(screen.getByText(enPair)).toBeTruthy(); // A3
    expect(screen.getByRole("button", { name: /Новая группа слов/ }).hasAttribute("disabled")).toBe(false);
    expect(a.studyPosts()).toEqual([]);
  });

  const ruPair = "Активная пара: Русский ↔ Немецкий";
  /** Resumed summary X closed by its tap, then ru -> en -> Today -> Settings -> ru saved; stays on Settings. */
  async function pairRoundTrip() {
    const a = app({ session: id(3) }); a.f.setStep({ ...current(), status: "summary", assignment: null });
    a.route(async (url, init, base) => {
      if (!isPost(init, "session.stop")) return base(url, init);
      const reply = await base(url, init); a.server.session = null; return reply;
    });
    render(<App />); fireEvent.click(await screen.findByRole("button", { name: "Вернуться на Сегодня" }));
    await screen.findByText(ruPair, undefined, exchange);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name: "Настройки" }));
    await saveSetting("Язык словаря", "en");
    await screen.findAllByText("Сохранено", undefined, exchange);
    fireEvent.click(screen.getByRole("button", { name: "Сегодня" }));
    await screen.findByText(enPair, undefined, exchange);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Основная навигация" })).getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { name: "Настройки", level: 1 });
    await saveSetting("Язык словаря", "ru");
    await waitFor(() => expect(a.posts().filter(post => (post.kind as string) === "setting.save")).toHaveLength(2));
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

