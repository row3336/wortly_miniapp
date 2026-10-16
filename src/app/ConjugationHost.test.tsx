import { StrictMode, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "../api/generated";
import type { ConjugationIntent } from "../conjugation/conjugationIntent";
import { conjugationId as id, conjugationServer, FORMS, type CloseReason, type ModelSession } from "../conjugation/conjugationModel.test-support";
import type { AsyncStorage } from "../platform/storage";
import { SettingsPendingStore } from "../settings/settingsPending";
import { settingsResponse } from "../settings/settingsRead.test-support";
import { useSettingsDocument } from "../settings/useSettingsDocument";
import { ConjugationSessionPendingStore, ConjugationStopPendingStore } from "../conjugation/conjugationPending";
import { leavesToToday, useConjugationHost, type ConjugationHost, type ConjugationHostOptions } from "./ConjugationHost";
import { ConjugationTestFlow } from "../conjugation/conjugationTestFlow";
import { createOpenedAccess, type OpenedAccess } from "./openedAccess";
import { testGate } from "../commands/testGate.test-support";
import { hasPending, seedRaw } from "../commands/pendingSeed.test-support";

const S1 = id(3), studyKey = "wortly.pending.conjugation_session";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const macrotasks = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise(done => setTimeout(done, 0)); }); };
function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
}
/** Telegram BackButton double: records click handlers. */
function fakeBack() {
  const handlers = new Set<() => void>();
  return { api: { show() {}, hide() {}, onClick(handler: () => void) { handlers.add(handler); }, offClick(handler: () => void) { handlers.delete(handler); } },
    get bound() { return handlers.size; }, click: () => act(async () => { for (const handler of [...handlers]) handler(); }) };
}
const active = (over: Partial<ModelSession> = {}): ModelSession => ({ id: S1, status: "active", assignment: FORMS[0], presented: true, results: [], ...over });

type Options = { sessions?: ModelSession[]; seed?: boolean; route?: ConjugationHostOptions["route"]; holdRoute?: boolean;
  seedPending?: boolean; strict?: boolean; settings?: (data: SettingsResponse) => void; holdSettings?: boolean; saved?: ConjugationIntent };
/** The host over a synthetic server model for one profile; it makes no claim of backend acceptance. */
function setup(options: Options = {}) {
  const model = conjugationServer({ sessions: options.sessions, version: "10" });
  const values = new Map<string, string>();
  if (options.saved) seedRaw(values, studyKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(1), pair: "ru-de", intent: options.saved }), id(50));
  const fail = { remove: false };
  const storage: AsyncStorage = { get: async k => values.get(k) ?? null, set: async (k, v) => { values.set(k, v); },
    remove: async k => { if (fail.remove) throw new Error("storage unavailable"); values.delete(k); } };
  const data = settingsResponse(); data.state_version = "10"; data.needs_setup = false;
  data.settings.dictionary_language.value = "ru"; data.settings.transition_mode.value = "normal"; options.settings?.(data);
  let releaseSettings: () => void = () => undefined;
  const settingsGate = options.holdSettings ? new Promise<void>(done => { releaseSettings = done; }) : null;
  // The next command POST is answered by this reply instead of the model; reads can be failed to make a session read stale.
  const override: { current: null | (() => Response | Promise<Response>) } = { current: null };
  const reads = { fail: false };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url), "https://model.invalid").pathname;
    if (override.current && init?.method === "POST" && path.endsWith("/commands")) {
      const reply = override.current; override.current = null; model.posted.push(JSON.parse(String(init.body))); return await reply();
    }
    if (reads.fail && init?.method !== "POST" && path.includes("/sessions/")) throw new TypeError("offline");
    if (path.endsWith("/settings")) { if (settingsGate) await settingsGate; return response(data); }
    if (path.endsWith("/settings/topics")) return response({ topics: [], state_version: data.state_version });
    return await model.handle(url, init) ?? response({ error: { code: "UNEXPECTED" } }, 500);
  });
  const transport = { fetcher, timeoutMs: 1000, maxResponseBytes: 200000, gate: testGate() };
  const seed = options.seed ? S1 : null;
  const opened = (generation: number) => createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2),
    document_epoch: "1", proof_version: "1", profile: { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
      time_zone: "UTC", state_version: "10", access: { status: "admitted", version: "1", reason: null } },
    session: seed ? { id: seed, phase: "active" } : null, compatibility: { compatible: true, contract_version: "1" } },
  token: "synthetic-token", proof: "synthetic-proof", generation, isLive: () => true, onDenied() {} });
  const stores = { study: new ConjugationSessionPendingStore(storage), stop: new ConjugationStopPendingStore(storage) };
  const settingsStore = new SettingsPendingStore(storage), back = fakeBack(), haptic = vi.fn();
  vi.stubGlobal("Telegram", { WebApp: { HapticFeedback: { notificationOccurred: haptic }, BackButton: back.api } });
  const onToday = vi.fn(), onConjugation = vi.fn(), host: { current: ConjugationHost | null } = { current: null };
  let setRoute!: (route: ConjugationHostOptions["route"]) => void, setAccess!: (access: OpenedAccess) => void, generation = 1;
  let renders = 0;
  function Harness() {
    // A replacement loop must fail cleanly here, not hang the run.
    if (++renders > 500) throw new Error("render storm: the host does not settle");
    const [route, update] = useState<ConjugationHostOptions["route"]>(options.route ?? (seed ? "conjugation" : "today")); setRoute = update;
    const [access, replace] = useState(() => opened(1)); setAccess = replace;
    const settings = useSettingsDocument({ access, transport, pendingStore: settingsStore, onCurrent() {} });
    const value = useConjugationHost({ access, transport, stores, newId: model.newId, language: "ru", settings,
      initialSessionId: seed, seedPending: options.seedPending ?? false, route,
      onConjugation: () => { onConjugation(); if (!options.holdRoute) update("conjugation"); },
      onToday: intent => { onToday(intent); update("today"); } });
    host.current = value;
    return <>{value.screen}{route === "today" && <p data-testid="today">{value.blocksToday ? "held" : "shown"}</p>}</>;
  }
  render(options.strict ?? suiteStrict ? <StrictMode><Harness /></StrictMode> : <Harness />);
  const starts = () => model.posted.filter(post => post.kind === "session.start");
  const stops = () => model.posted.filter(post => post.kind === "session.stop");
  return { model, fetcher, values, fail, override, reads, renders: () => renders, onToday, onConjugation, host, back, haptic, starts, stops, releaseSettings,
    route: (route: ConjugationHostOptions["route"]) => act(() => setRoute(route)),
    /** A new access object of the same document tuple, as after a foreground. */
    reopen: () => act(() => setAccess(opened(++generation))),
    /** Taps «Тест спряжений» on Today once the start right is there. */
    async start() {
      await waitFor(() => expect(host.current?.canRequestStart).toBe(true));
      act(() => host.current!.requestStart());
    } };
}
async function editable() {
  const field = await screen.findByRole("textbox") as HTMLTextAreaElement;
  await waitFor(() => expect(field.readOnly).toBe(false));
  return field;
}
async function answer(text: string) {
  fireEvent.change(await editable(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
}

/** Set by the mode matrix below: every suite outside the S block runs plain and under StrictMode. */
let suiteStrict = false;
afterEach(() => { cleanup(); setVisibility("visible"); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });


// The flow is disposed by the simulated unmount of StrictMode's double effect and must still project the document.
describe.each([["StrictMode", true], ["plain render", false]])("useConjugationHost: flow lifetime (%s)", (_name, strict) => {
  it("S1 an open session shows its text, not the loading placeholder", async () => {
    const h = setup({ seed: true, strict, sessions: [active()] });
    await editable();
    expect(screen.queryByText("Загружаем занятие…")).toBeNull();
    expect(h.model.posted).toEqual([]);
  });

  it("S2 a refused start (SESSION_CLOSED) shows the module's message, not the loading placeholder", async () => {
    const h = setup({ strict });
    h.model.server.rejectStart = "SESSION_CLOSED";
    await h.start();
    await screen.findByText("Занятие завершено.");
    expect(screen.queryByText("Загружаем занятие…")).toBeNull();
    expect(h.starts()).toHaveLength(1);
  });

  it("S3 a typed answer still works after the remount", async () => {
    setup({ seed: true, strict, sessions: [active()] });
    fireEvent.change(await editable(), { target: { value: "komm" } });
    expect((await editable()).value).toBe("komm");
  });

  it("S4 the closed screen: one Stop, one return to Today, no second Stop from the replaced flow", async () => {
    const h = setup({ seed: true, strict, sessions: [active()] });
    await editable();
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    await screen.findByText("Занятие завершено");
    await macrotasks();
    expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "stop" }]);
    await h.back.click();
    await macrotasks();
    expect(h.onToday).toHaveBeenCalledOnce(); expect(h.stops()).toHaveLength(1);
  });

  it("S5 a foreground and a new access object keep the draft and send nothing", async () => {
    const h = setup({ seed: true, strict, sessions: [active()] });
    fireEvent.change(await editable(), { target: { value: "komm" } });
    setVisibility("hidden");
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    setVisibility("visible");
    await h.reopen();
    await waitFor(async () => expect((await editable()).value).toBe("komm"));
    await macrotasks();
    expect(h.model.posted).toEqual([]); expect(h.onToday).not.toHaveBeenCalled();
  });

  // Normal mode, a correct answer: the one armed timer (3000 ms) opens the next form with exactly one present.
  const toResultWithTimer = async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const h = setup({ seed: true, strict, sessions: [active()] });
    await answer("kommst");
    await screen.findByRole("button", { name: "Далее" });
    return h;
  };
  const presents = (h: ReturnType<typeof setup>) => h.model.posted.filter(post => post.kind === "assignment.present");

  it("S6 the result timer runs once: the next form is presented exactly once, not before 3000 ms, never again", async () => {
    const h = await toResultWithTimer();
    await act(async () => { vi.advanceTimersByTime(2500); });
    expect(presents(h)).toHaveLength(0); expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1000); });
    await waitFor(() => expect(presents(h)).toHaveLength(1));
    expect(presents(h)[0]).toMatchObject({ assignment_id: FORMS[1] });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Далее" })).toBeNull());
    await act(async () => { vi.advanceTimersByTime(20000); });
    await macrotasks();
    expect(h.model.kinds()).toEqual(["answer.submit", "assignment.present"]); expect(h.onToday).not.toHaveBeenCalled();
  });

  it("S7 a late timer callback after unmount does nothing", async () => {
    const h = await toResultWithTimer();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    cleanup();
    // The unmounted flow must cancel its timer itself; a callback that merely finds nothing to do would hide a leak.
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { vi.advanceTimersByTime(20000); });
    await macrotasks();
    expect(h.model.kinds()).toEqual(["answer.submit"]);
  });

  it("S8 setup and replacement are finite: the render count settles, the number of disposed flows is fixed, unmount disposes the live one", async () => {
    const dispose = vi.spyOn(ConjugationTestFlow.prototype, "dispose");
    const h = setup({ seed: true, strict, sessions: [active()] });
    await editable(); await macrotasks();
    const settled = h.renders();
    await macrotasks(20);
    expect(h.renders()).toBe(settled);
    expect(settled).toBeLessThan(60);
    // StrictMode: the simulated unmount disposes the first flow (its cleanup then runs once more when the effect's flow
    // changes, so calls are counted per distinct flow); the replacement stays live until the real unmount.
    const disposed = () => new Set(dispose.mock.contexts).size;
    expect(disposed()).toBe(strict ? 1 : 0);
    cleanup();
    expect(disposed()).toBe(strict ? 2 : 1);
  });
});

describe.each([["StrictMode", true], ["plain render", false]])("useConjugationHost (%s)", (_name, strictMode) => {
  beforeEach(() => { suiteStrict = strictMode; });
  describe("useConjugationHost: start from Today", () => {
    it.each<[string, Options]>([
      ["settings still loading", { holdSettings: true }],
      ["no confirmed transition mode", { settings: data => { data.settings.transition_mode.value = null; } }],
      ["settings of another pair", { settings: data => { data.settings.dictionary_language.value = "uk"; } }],
    ])("H1 a closed start right (%s): no start, no route", async (_name, options) => {
      const h = setup(options);
      await macrotasks();
      expect(h.host.current!.canRequestStart).toBe(false);
      act(() => h.host.current!.requestStart());
      await macrotasks();
      expect(h.onConjugation).not.toHaveBeenCalled(); expect(h.model.posted).toEqual([]);
      expect(screen.getByTestId("today")).toBeTruthy();
      h.releaseSettings();
    });

    it("H2 a tap opens the route once and sends exactly one start of a new conjugation session, also after a second tap", async () => {
      const h = setup();
      await h.start();
      act(() => h.host.current!.requestStart());
      await editable();
      act(() => h.host.current!.requestStart());
      await macrotasks();
      expect(h.onConjugation).toHaveBeenCalledOnce();
      expect(h.starts()).toHaveLength(1);
      expect(h.starts()[0].payload).toEqual({ mode: "conjugation" });
      expect(h.model.sessions.has(h.starts()[0].session_id)).toBe(true);
      expect(h.model.kinds()).toEqual(["session.start", "assignment.present"]);
    });

    it("H2 a consumed tap never starts again: after the test is ended no new session is started", async () => {
      const h = setup();
      await h.start();
      await editable();
      fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
      await screen.findByText("Занятие завершено");
      await macrotasks();
      expect(h.starts()).toHaveLength(1); expect(h.model.kinds()).toEqual(["session.start", "assignment.present", "session.stop"]);
    });

    it("H3 a background between the tap and the start cancels it: nothing is sent and the empty route returns to Today once", async () => {
      const h = setup();
      await h.start();
      setVisibility("hidden");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await macrotasks();
      expect(h.model.posted).toEqual([]);
      expect(h.onToday).toHaveBeenCalledOnce();
    });

    it("H3 an empty route returns to Today each time it is opened, not only the first time", async () => {
      const h = setup();
      await waitFor(() => expect(screen.getByTestId("today").textContent).toBe("shown"));
      await h.route("conjugation");
      await waitFor(() => expect(h.onToday).toHaveBeenCalledTimes(1));
      await h.route("conjugation");
      await waitFor(() => expect(h.onToday).toHaveBeenCalledTimes(2));
      expect(h.model.posted).toEqual([]);
    });

    it("H4 while the start is on its way the screen loads; it shows no refresh failure", async () => {
      const h = setup();
      const held = h.model.hold((url, method) => method === "POST" && url.pathname.endsWith("/commands"));
      await h.start();
      await held.entered;
      await macrotasks();
      expect(screen.getByText("Загружаем занятие…")).toBeTruthy();
      expect(screen.queryByText("Не удалось обновить занятие.")).toBeNull();
      expect(screen.queryByRole("button", { name: "Проверить статус" })).toBeNull();
      held.release();
      await editable();
    });

    // Q29 (owner's answer 12.10, variant 1; was «5.1.1» of D-CONJ-HOST): the screen of a refused start stays as the module
    // shows it and nothing leaves by itself; only native Back returns to Today (C085). fix5 (C388): that Back names the
    // shown refusal for the П01 episode — the command_id of the start refused SESSION_BUSY, nothing for any other code.
    it.each([["NO_MATERIAL", "Не удалось обновить занятие."], ["SETUP_REQUIRED", "Не удалось обновить занятие."],
      ["SESSION_BUSY", "Занятие открыто на другом устройстве"], ["SESSION_CLOSED", "Занятие завершено."]])(
      "H5 a refused start (%s) stays on the module's screen; Back returns to Today once and the host does not take it back", async (code, text) => {
        const h = setup();
        h.model.server.rejectStart = code;
        await h.start();
        await screen.findByText(text);
        await macrotasks();
        expect(h.starts()).toHaveLength(1); expect(h.model.posted).toHaveLength(1);
        expect(h.onToday).not.toHaveBeenCalled(); expect(h.haptic).not.toHaveBeenCalled();
        expect(h.back.bound).toBe(1);
        await h.back.click();
        await macrotasks();
        expect(h.onToday).toHaveBeenCalledOnce();
        expect(h.onToday).toHaveBeenCalledWith(code === "SESSION_BUSY" ? { startRefused: h.starts()[0].command_id } : undefined);
        expect(screen.getByTestId("today").textContent).toBe("shown");
        // No claim of the refused session: the route stays on Today, nothing is cleared, cancelled or started again.
        expect(h.onConjugation).toHaveBeenCalledOnce(); expect(h.model.posted).toHaveLength(1);
        expect(hasPending(h.values, studyKey)).toBe(false);
      });

    it("H5 a refusal outside the final list (VERSION_CONFLICT) gives Back nothing to do", async () => {
      const h = setup();
      h.model.server.rejectStart = "VERSION_CONFLICT";
      await h.start();
      await screen.findByText("Не удалось обновить занятие.");
      await macrotasks();
      expect(h.back.bound).toBe(0);
      expect(h.onToday).not.toHaveBeenCalled();
    });

    it("H5 an unknown start outcome (lost request) is no proof: Back does not leave", async () => {
      const h = setup();
      h.model.server.loseNextPost = true;
      await h.start();
      await waitFor(() => expect(h.starts()).toHaveLength(1));
      await macrotasks();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(h.back.bound).toBe(0);
      await h.back.click();
      expect(h.onToday).not.toHaveBeenCalled(); expect(hasPending(h.values, studyKey)).toBe(true);
    });

    it("H5 a stale read of an open session is no refusal: Back does not leave", async () => {
      const h = setup({ seed: true, sessions: [active({ presented: false, status: "active" })] });
      h.model.server.failReads = true;
      await screen.findByText("Не удалось обновить занятие.");
      await macrotasks();
      expect(h.back.bound).toBe(0);
      expect(h.onToday).not.toHaveBeenCalled(); expect(h.model.posted).toEqual([]);
    });

    // The five test runs below pin the guards of `refusedStart` (ConjugationHost.tsx): R1, R3, R4 and R5 (twice, via
    // it.each). The refusal codes are the synthetic model's; none of them is evidence of a refusal stored by the server
    // (Ж01). In every case the block on Today stays and no refused-start Back appears (R4: the question's own Back only).
    const blocked = (h: ReturnType<typeof setup>) => {
      expect(h.host.current!.blocksToday).toBe(true); expect(h.back.bound).toBe(0);
      expect(h.onToday).not.toHaveBeenCalled();
    };

    it("H5 R1: a refused start whose pending slot cannot be cleared stays claimed: no Back, the slot is kept", async () => {
      const h = setup();
      h.fail.remove = true;
      h.model.server.rejectStart = "NO_MATERIAL";
      await h.start();
      await waitFor(() => expect(h.starts()).toHaveLength(1));
      await macrotasks(25);
      expect(screen.getByText("Не удалось обновить данные на этом устройстве.")).toBeTruthy();
      expect(hasPending(h.values, studyKey)).toBe(true);
      blocked(h);
      await h.back.click();
      expect(h.onToday).not.toHaveBeenCalled(); expect(h.model.posted).toHaveLength(1);
    });

    it("H5 R3: a refusal of another start (stored receipt A) is no refusal of the open session S1 on screen", async () => {
      const A = id(61), h = setup({ seed: true, sessions: [active()], saved: { command_id: id(60), kind: "session.start", session_id: A, payload: { mode: "conjugation" } } });
      await screen.findByRole("button", { name: "Повторить действие" });
      h.override.current = () => { h.reads.fail = true; return response({ command: { id: id(60), status: "rejected" }, error: { code: "SESSION_BUSY" },
        current: { session_id: A, status: "unavailable" }, state_version: "11" }, 409); };
      fireEvent.click(screen.getByRole("button", { name: "Проверить статус" }));
      await macrotasks(20);
      fireEvent.click(screen.getByRole("button", { name: "Повторить действие" }));
      await screen.findByText("Занятие открыто на другом устройстве");
      await macrotasks(10);
      expect(h.starts()).toHaveLength(1); expect(h.starts()[0].session_id).toBe(A);
      blocked(h);
    });

    // Defensive server input, not the behaviour of a correct client: every press starts a fresh session ID, so a number
    // that already exists as an open session is never sent. The host must still not read such a reply as a refusal.
    it("H5 R4 (defensive server input): a refused start answered with the open projection of that number is no refusal", async () => {
      const h = setup({ sessions: [active({ id: id(100) })] });
      h.model.server.rejectStart = "SESSION_CLOSED";
      await h.start();
      await waitFor(() => expect(h.starts()).toHaveLength(1));
      await macrotasks(25);
      expect(h.starts()[0].session_id).toBe(id(100));
      expect(h.host.current!.blocksToday).toBe(true); expect(h.onToday).not.toHaveBeenCalled();
      expect(await screen.findByRole("button", { name: "Проверить" })).toBeTruthy();
      // The open question keeps its own Back, which is Stop; it is not the refused-start Back and leaves nothing.
      expect(h.back.bound).toBe(1);
      await h.back.click(); await macrotasks();
      expect(h.model.kinds()).toContain("session.stop"); expect(h.onToday).not.toHaveBeenCalled();
    });

    it.each(["SESSION_BUSY", "SESSION_CLOSED"])("H5 R5: a rejected %s of an answer is no refusal of a start", async code => {
      const h = setup({ seed: true, sessions: [active()] });
      await editable();
      h.override.current = async () => {
        const read = await (await h.model.handle(`https://model.invalid/api/v1/sessions/${S1}`, { method: "GET" })!)!.json();
        const posted = h.model.posted[h.model.posted.length - 1], step = read.current;
        h.reads.fail = true;
        return response({ command: { id: posted.command_id, status: "rejected" }, error: { code }, action: null, result: null, step,
          capabilities: { ...step.capabilities }, state_version: read.state_version }, 409);
      };
      fireEvent.change(await editable(), { target: { value: "kommt" } });
      fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
      await screen.findByText(code === "SESSION_BUSY" ? "Занятие открыто на другом устройстве" : "Занятие завершено.");
      await macrotasks(10);
      expect(h.model.kinds()).toEqual(["answer.submit"]);
      blocked(h);
    });

    it("H10 an own unconfirmed receipt without a reported session claims the route before Today, once", async () => {
      const h = setup({ holdRoute: true, saved: { command_id: id(60), kind: "session.start", session_id: id(61), payload: { mode: "conjugation" } } });
      expect(screen.getByTestId("today").textContent).toBe("held");
      await waitFor(() => expect(h.onConjugation).toHaveBeenCalledOnce());
      await macrotasks();
      expect(h.onConjugation).toHaveBeenCalledOnce();
      expect(screen.getByTestId("today").textContent).toBe("held");
      expect(h.model.posted).toEqual([]);
    });

    it("H10 without any session or receipt Today is released after the first recovery", async () => {
      setup();
      await waitFor(() => expect(screen.getByTestId("today").textContent).toBe("shown"));
    });

    // pending owner answer 5.1.3 (D-CONJ-HOST): TEMPORARY expectation, no haptic signal until the owner decides.
    it("H12 neither an accepted start nor the summary after an own answer gives a haptic signal", async () => {
      const h = setup();
      await h.start();
      await answer("kommst");
      fireEvent.click(await screen.findByRole("button", { name: "Далее" }));
      await answer("kommst");
      fireEvent.click(await screen.findByRole("button", { name: "Далее" }));
      await screen.findByText("Итог спряжений");
      await macrotasks();
      expect(h.haptic).not.toHaveBeenCalled();
    });
  });

  describe("useConjugationHost: closures", () => {
    it("H6 «Завершить» sends one Stop and keeps the closed screen; Back or «На Сегодня» returns to Today once", async () => {
      const h = setup({ seed: true, sessions: [active()] });
      await editable();
      fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
      await screen.findByText("Занятие завершено");
      await macrotasks();
      expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "stop" }]);
      expect(h.onToday).not.toHaveBeenCalled();
      await h.back.click();
      expect(h.onToday).toHaveBeenCalledOnce();
    });

    it("H6 «На Сегодня» on the own closed screen returns once", async () => {
      const h = setup({ seed: true, sessions: [active()] });
      await editable();
      fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
      fireEvent.click(await screen.findByRole("button", { name: "На Сегодня" }));
      await macrotasks();
      expect(h.onToday).toHaveBeenCalledOnce();
    });

    it("H7 the summary's «На Сегодня» sends one summary_home Stop and returns to Today exactly once", async () => {
      const h = setup({ seed: true, sessions: [active({ status: "summary", assignment: null })] });
      fireEvent.click(await screen.findByRole("button", { name: "На Сегодня" }));
      await waitFor(() => expect(h.onToday).toHaveBeenCalled());
      await macrotasks();
      expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "summary_home" }]);
      expect(h.onToday).toHaveBeenCalledOnce();
    });

    const reasons: [CloseReason, string][] = [["midnight", "Занятие закрыто: начался новый день"],
      ["timezone_date_changed", "Занятие закрыто: сменилась дата"], ["pair_changed", "Занятие закрыто: изменилась языковая пара"],
      ["remote_stop", "Занятие завершено на другом устройстве"]];
    it.each(reasons)("H8 a closure by %s read on return stays on the closed screen with its reason until Back", async (reason, text) => {
      const h = setup({ seed: true, sessions: [active()] });
      await editable();
      h.model.close(S1, reason);
      await h.reopen();
      await screen.findByText(text);
      await macrotasks();
      expect(h.onToday).not.toHaveBeenCalled(); expect(h.model.posted).toEqual([]);
      await h.back.click(); await h.back.click();
      expect(h.onToday).toHaveBeenCalledOnce();
    });

    it.each(reasons)("H8 a closure by %s learnt from the refusal SESSION_CLOSED of an answer keeps its reason until «На Сегодня»", async (reason, text) => {
      const h = setup({ seed: true, sessions: [active()] });
      await editable();
      h.model.close(S1, reason);
      await answer("kommst");
      await screen.findByText(text);
      await macrotasks();
      expect(h.onToday).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
      await macrotasks();
      expect(h.onToday).toHaveBeenCalledOnce(); expect(h.model.kinds()).toEqual(["answer.submit"]);
    });

    it("leavesToToday: only summary_home leaves by itself", () => {
      expect((["stop", "remote_stop", "midnight", "timezone_date_changed", "pair_changed", "save_failed", null] as const)
        .map(reason => leavesToToday(reason))).toEqual([false, false, false, false, false, false, false]);
      expect(leavesToToday("summary_home")).toBe(true);
    });
  });

  describe("useConjugationHost: native Back", () => {
    it("H9 Back on a question stops once; while that Stop is on its way Back sends nothing more; the closed screen returns to Today", async () => {
      const h = setup({ seed: true, sessions: [active()] });
      await editable();
      const held = h.model.hold((_url, method) => method === "POST");
      await h.back.click();
      await held.entered;
      // The awaited Stop keeps Back bound, doing nothing (К10-151): it neither sends again nor leaves.
      expect(h.back.bound).toBe(1);
      await h.back.click(); await h.back.click();
      expect(h.onToday).not.toHaveBeenCalled();
      held.release();
      await screen.findByText("Занятие завершено");
      expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "stop" }]);
      expect(h.onToday).not.toHaveBeenCalled();
      await h.back.click();
      expect(h.onToday).toHaveBeenCalledOnce();
    });

    it("H9 Back on the summary is its «На Сегодня»: summary_home", async () => {
      const h = setup({ seed: true, sessions: [active({ status: "summary", assignment: null })] });
      await screen.findByText("Итог спряжений");
      await waitFor(() => expect(h.back.bound).toBe(1));
      await h.back.click();
      await waitFor(() => expect(h.onToday).toHaveBeenCalledOnce());
      expect(h.stops().map(stop => stop.payload)).toEqual([{ reason: "summary_home" }]);
    });
  });

  describe("useConjugationHost: owner lifetime", () => {
    it("H11 an unresolved mode read keeps the screen loading and the owner closed", async () => {
      const h = setup({ seed: true, seedPending: true, sessions: [active()] });
      await macrotasks();
      expect(screen.getByText("Загружаем занятие…")).toBeTruthy();
      expect(screen.queryByRole("textbox")).toBeNull(); expect(h.model.posted).toEqual([]);
    });

    it("H14 a new access object of the same document keeps the typed draft", async () => {
      const h = setup({ seed: true, sessions: [active()] });
      fireEvent.change(await editable(), { target: { value: "komm" } });
      await h.reopen();
      await waitFor(async () => expect((await editable()).value).toBe("komm"));
      expect(h.model.posted).toEqual([]);
    });

    it("H15 without the start right a session waiting for its form: the settings block, its refresh and Today", async () => {
      const h = setup({ seed: true, sessions: [active({ presented: false })], settings: data => { data.settings.transition_mode.value = null; } });
      await screen.findByText("Для занятия нужно подтвердить настройки и текущую словарную пару.");
      const reads = h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/settings")).length;
      fireEvent.click(screen.getByRole("button", { name: "Обновить настройки" }));
      await waitFor(() => expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/settings")).length).toBeGreaterThan(reads));
      fireEvent.click(screen.getByRole("button", { name: "На Сегодня" }));
      expect(h.onToday).toHaveBeenCalledOnce(); expect(h.model.posted).toEqual([]);
    });
  });

  describe("useConjugationHost: result transition", () => {
    it.each<["normal" | "accelerated", string, number | null]>([["accelerated", "kommst", 2000], ["accelerated", "kommt", 2000],
      ["normal", "kommst", 3000], ["normal", "kommt", null]])("H13 %s mode, answer %s: the result moves on after %s ms", async (mode, text, delay) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      setup({ seed: true, sessions: [active()], settings: data => { data.settings.transition_mode.value = mode; } });
      await answer(text);
      await screen.findByRole("button", { name: "Далее" });
      await act(async () => { vi.advanceTimersByTime(1900); });
      expect(screen.queryByRole("button", { name: "Далее" })).toBeTruthy();
      await act(async () => { vi.advanceTimersByTime(1200); });
      if (delay === 2000) { await waitFor(() => expect(screen.queryByRole("button", { name: "Далее" })).toBeNull()); return; }
      await act(async () => { vi.advanceTimersByTime(1000); });
      if (delay === 3000) { await waitFor(() => expect(screen.queryByRole("button", { name: "Далее" })).toBeNull()); return; }
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    });

    it("H13/H14 a background cancels the result timer for good: after the return the result waits for «Далее»", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const h = setup({ seed: true, sessions: [active()] });
      await answer("kommst");
      await screen.findByRole("button", { name: "Далее" });
      setVisibility("hidden");
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await act(async () => { vi.advanceTimersByTime(4000); });
      setVisibility("visible");
      await h.reopen();
      await screen.findByRole("button", { name: "Далее" });
      await act(async () => { vi.advanceTimersByTime(10000); });
      expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
      expect(h.model.kinds()).toEqual(["answer.submit"]);
    });
  });
});
