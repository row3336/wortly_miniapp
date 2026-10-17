// M1d (Q19 вариант 1 of 12.10, К19-018; CON §6.1 п.1–4, п.8, §7.2 п.2; Q34 вар.1; Q30; Q32): the automatic recovery of the
// oral quiz — the mark of a shown question, the reveal of its translation and the self-assessment — on the shared mechanism
// of CP5b (DocumentLanes, the durable budget, pauses, checks), through the real owner and screen over a synthetic oral
// server, on fake time. No manual check or resend of a study step; Stop keeps its own buttons; the closure C after six
// lost sends; «Повторить завершение» once C's own budget ran out; no study send without the page's store; a reason of a
// closure without the person (Q32) is kept whatever the machines do.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenedClient, OralSessionProjection } from "../api/generated";
import { createOpenedAccess } from "../app/openedAccess";
import type { AsyncStorage } from "../platform/storage";
import { hashInPlace, tick } from "../commands/recoveryTime.test-support";
import { testGate } from "../commands/testGate.test-support";
import { hasPending } from "../commands/pendingSeed.test-support";
import { sendBudgetProvider } from "../commands/intentBudget";
import { SendBudgetError } from "../commands/sendBudget";
import { OralScreen } from "./OralScreen";
import type { OralDocumentSnapshot } from "./oralDocumentController";
import { oralIntentHash, type OralCommand, type OralIntent } from "./oralIntent";
import { OralSessionPendingStore, OralStopPendingStore } from "./oralPending";
import { useOralDocument } from "./useOralDocument";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const studyKey = "wortly.pending.oral_session", stopKey = "wortly.pending.oral_stop";
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
/** 9.2.7 (ru): the line the host passes once GET /notices found the answer_loss of the closure C (useClosureNotice). */
const line927 = "Не удалось сохранить последнее действие. Занятие завершено. Ранее сохранённый прогресс не потерян.";
type Step = "prefetched" | "presented" | "revealed" | "closed";
type Reason = OralSessionProjection["close_reason"];
function projection(step: Step, completed = 0, reason: Reason = null): OralSessionProjection {
  const active = step !== "closed", assignment = completed === 0 ? id(6) : id(8);
  return { session_id: id(3), status: active ? "active" : "closed", mode: "oral", pair: "ru-de", direction: "de-l1",
    local_date: "2026-10-01", bucket: "words", close_reason: active ? null : reason,
    progress: { completed, total: 3, correct: completed, wrong: 0 },
    assignment: active ? { id: assignment, card_id: id(7), status: step === "prefetched" ? "prefetched" : "presented", kind: "original",
      prompt: { text: completed === 0 ? "wenn" : "die Straße", language: "de", conjunction_hint: null },
      ...(step === "revealed" ? { status: "presented", revealed: true, translations: ["если"] } : { revealed: false }) } : null,
    summary: active ? null : { completed, correct: completed, wrong: 0, ratio: completed ? { numerator: completed, denominator: completed } : null },
    practice: { pair: "ru-de", direction: "de-l1", local_date: "2026-10-01", time_zone: "UTC", count: completed },
    capabilities: { reveal_target: step === "presented" ? assignment : null, grade_target: step === "revealed" ? assignment : null,
      stop: active, summary_home: false } };
}
const profile: OpenedClient["profile"] = { profile_id: id(50), role: "user", ui_language: "ru", dictionary_language: "ru",
  time_zone: "UTC", state_version: "1", access: { status: "admitted", version: "1", reason: null } };
function fact(intent: OralIntent, status = "applied") {
  const grade = intent.kind === "oral.grade";
  return { id: intent.command_id, kind: intent.kind, status, applied_at: "2026-10-01T12:00:00Z",
    target_id: "assignment_id" in intent ? intent.assignment_id : intent.session_id,
    action_id: grade ? id(10) : null, result_id: grade ? id(11) : null, context_id: null, object_version: grade ? "1" : null };
}
type Route = (request: { method: string; kind: string | null; command: OralCommand | null }) => undefined | "drop" | Response;

/** The synthetic oral server: one session, steps by the accepted commands; GET /commands answers by the accepted ones. */
function setup(step: Step = "prefetched") {
  vi.useFakeTimers(); hashInPlace();
  let current = projection(step), stateVersion = "8", counter = 100, route: Route = () => undefined;
  const values = new Map<string, string>(), accepted = new Map<string, OralIntent>(), posts: OralCommand[] = [], gets: string[] = [];
  const storage: AsyncStorage = { get: vi.fn(async k => values.get(k) ?? null), set: vi.fn(async (k, v) => { values.set(k, v); }),
    remove: vi.fn(async k => { values.delete(k); }) };
  const access = createOpenedAccess({ opened: { status: "opened", client_instance_id: id(1), document_id: id(2), document_epoch: "1",
    proof_version: "1", profile, session: null, compatibility: { compatible: true, contract_version: "1" } },
    token: "synthetic-token", proof: "synthetic-proof", generation: 1, isLive: () => true, onDenied() {} });
  const server: typeof fetch = async (url, init) => {
    const path = new URL(String(url), "https://model.invalid");
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body)) as OralCommand;
      const { client_instance_id: _client, document_id: _doc, ...intent } = command;
      if (current.status === "closed") {
        return response({ command: { id: command.command_id, status: "rejected" }, error: { code: "SESSION_CLOSED" }, current, state_version: stateVersion }, 409);
      }
      accepted.set(intent.command_id, intent);
      const done = current.progress.completed;
      current = command.kind === "oral.grade" ? projection("prefetched", done + 1)
        : command.kind === "session.stop" ? projection("closed", done, command.payload.reason as Reason)
        : projection(command.kind === "oral.reveal" ? "revealed" : command.kind === "assignment.present" ? "presented" : "prefetched", done);
      stateVersion = String(BigInt(stateVersion) + 1n);
      return response({ command: fact(intent), current, state_version: stateVersion });
    }
    gets.push(path.pathname + path.search);
    if (path.pathname.includes("/commands/")) {
      const commandId = path.pathname.split("/").at(-1)!, intent = accepted.get(commandId);
      return intent ? response({ command: fact(intent, "already_applied"), verified_intent_hash: await oralIntentHash(intent), current, state_version: stateVersion })
        : response({ command: { id: commandId, status: "not_found" }, current: { ...profile, state_version: stateVersion }, state_version: stateVersion });
    }
    return response({ current, state_version: stateVersion });
  };
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const method = init?.method ?? "GET", command = method === "POST" ? JSON.parse(String(init!.body)) as OralCommand : null;
    if (command) posts.push(command);
    const decision = route({ method, kind: command?.kind ?? null, command });
    if (decision === "drop") throw new TypeError("network");
    return decision ?? server(url, init);
  });
  const options = { access, transport: { fetcher, timeoutMs: 1000, maxResponseBytes: 100000, gate: testGate() },
    studyStore: new OralSessionPendingStore(storage), stopStore: new OralStopPendingStore(storage),
    newId: () => id(counter++), initialSessionId: id(3) };
  let state: OralDocumentSnapshot | null = null;
  function Harness({ enabled = true }: { enabled?: boolean }) {
    const doc = useOralDocument({ ...options, enabled });
    state = doc.state;
    return <OralScreen {...doc} language="ru" active onToday={() => {}}
      noticeLines={doc.state?.phase === "closed" && doc.state.closed?.reason === "save_failed" ? [line927] : null} />;
  }
  const step_ = (ms = 0) => act(() => tick(ms));
  const kinds = (kind: OralIntent["kind"]) => posts.filter(post => post.kind === kind);
  const overlay = () => document.querySelector(".recovery-overlay");
  const noManual = () => {
    for (const name of ["Проверить состояние", "Повторить действие"]) expect(screen.queryByRole("button", { name })).toBeNull();
  };
  const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
  return { Harness, posts, gets, values, kinds, overlay, noManual, button, step: step_, state: () => state,
    route: (next: Route) => { route = next; }, close: (reason: Reason) => { current = projection("closed", current.progress.completed, reason);
      stateVersion = String(BigInt(stateVersion) + 1n); } };
}
async function mount(h: ReturnType<typeof setup>) {
  const ui = render(<h.Harness />);
  for (let round = 0; round < 3; round++) await h.step();
  return ui;
}

describe("M1d: the automatic recovery of the oral steps (Q19 вариант 1, К19-018)", () => {
  it("a lost reveal goes again by its machine with the same ID after its pause; no manual check or retry, ever", async () => {
    const h = setup("presented"); await mount(h);
    h.route(request => request.kind === "oral.reveal" && h.kinds("oral.reveal").length === 1 ? "drop" : undefined);
    fireEvent.click(h.button("Раскрыть")); await h.step();
    expect(h.overlay()?.textContent).toBe("Отправляем действие повторно…");
    h.noManual();
    // Exit (Stop) stays reachable above the cover.
    expect(h.button("Выйти").disabled).toBe(false);
    await h.step(2000); await h.step();
    expect(h.kinds("oral.reveal")).toHaveLength(2);
    expect(h.kinds("oral.reveal")[1].command_id).toBe(h.kinds("oral.reveal")[0].command_id);
    expect(h.overlay()).toBeNull();
    expect(screen.getByText("если")).toBeTruthy();
    h.noManual();
  });

  // As the written and Learning views: a route away (the module hidden, the window visible) does not stop the machine;
  // only a background does (Я15.3).
  it("a route away while the window stays visible: the machine still sends the lost reveal again after its pause", async () => {
    const h = setup("presented"); const ui = await mount(h);
    h.route(request => request.kind === "oral.reveal" && h.kinds("oral.reveal").length === 1 ? "drop" : undefined);
    fireEvent.click(h.button("Раскрыть")); await h.step();
    ui.rerender(<h.Harness enabled={false} />); await h.step();
    await h.step(2000); await h.step();
    expect(h.kinds("oral.reveal")).toHaveLength(2);
    expect(h.kinds("oral.reveal")[1].command_id).toBe(h.kinds("oral.reveal")[0].command_id);
  });

  it("a lost self-assessment recovers the same way: the same exact payload once more, then the next question", async () => {
    const h = setup("revealed"); await mount(h);
    h.route(request => request.kind === "oral.grade" && h.kinds("oral.grade").length === 1 ? "drop" : undefined);
    fireEvent.click(h.button("Неправильно")); await h.step();
    expect(h.overlay()).not.toBeNull(); h.noManual();
    await h.step(2000); await h.step();
    expect(h.kinds("oral.grade").map(post => JSON.stringify(post))).toEqual(Array(2).fill(JSON.stringify(h.kinds("oral.grade")[0])));
    expect(h.kinds("oral.grade")[0].payload).toEqual({ correct: false });
    expect(screen.getByText("die Straße")).toBeTruthy();
    expect(hasPending(h.values, studyKey)).toBe(false);
  });

  it("a lost mark of a shown question waits without the cover under its own status and goes again by its machine", async () => {
    const h = setup("prefetched");
    h.route(request => request.kind === "assignment.present" && h.kinds("assignment.present").length === 1 ? "drop" : undefined);
    await mount(h);
    expect(h.kinds("assignment.present")).toHaveLength(1);
    expect(screen.getByText("Подтверждаем показ задания…")).toBeTruthy();
    expect(h.overlay()).toBeNull(); h.noManual();
    await h.step(2000); await h.step();
    expect(h.kinds("assignment.present")).toHaveLength(2);
    expect(h.kinds("assignment.present")[1].command_id).toBe(h.kinds("assignment.present")[0].command_id);
    expect(h.button("Раскрыть").disabled).toBe(false);
  });

  it("six lost reveals end in the closure C save_failed with X; the own summary with 9.2.7; no manual action", async () => {
    const h = setup("presented"); await mount(h);
    h.route(request => request.kind === "oral.reveal" ? "drop" : undefined);
    fireEvent.click(h.button("Раскрыть"));
    for (let second = 0; second < 75; second++) await h.step(1000);
    expect(h.kinds("oral.reveal")).toHaveLength(6);
    expect(new Set(h.kinds("oral.reveal").map(post => post.command_id)).size).toBe(1);
    expect(h.kinds("session.stop").map(post => post.payload))
      .toEqual([{ reason: "save_failed", unsaved_command_id: h.kinds("oral.reveal")[0].command_id }]);
    expect(h.overlay()).toBeNull();
    expect(screen.getByRole("region", { name: "Итог занятия" })).toBeTruthy();
    expect(screen.getByText(line927)).toBeTruthy();
    // The session closed by C is among the own closures with X (Т2: only their summary reads GET /notices).
    expect(h.state()?.unsavedClosures).toEqual([id(3)]);
    h.noManual();
    expect(screen.queryByRole("button", { name: "Повторить завершение" })).toBeNull();
  });

  it("C's own six sends ran out with the session open: 9.2.12 and «Повторить завершение»; one press sends the same C once", async () => {
    const h = setup("presented"); await mount(h);
    h.route(request => request.kind === "oral.reveal" || request.kind === "session.stop" ? "drop" : undefined);
    fireEvent.click(h.button("Раскрыть"));
    for (let second = 0; second < 160; second++) await h.step(1000);
    const closes = h.kinds("session.stop");
    expect(closes).toHaveLength(6);
    expect(screen.getByText("Не удалось завершить занятие.")).toBeTruthy();
    h.route(request => request.kind === "oral.reveal" ? "drop" : undefined);
    fireEvent.click(h.button("Повторить завершение")); await h.step(); await h.step(1000);
    expect(h.kinds("session.stop")).toHaveLength(7);
    expect(JSON.stringify(h.kinds("session.stop").at(-1))).toBe(JSON.stringify(closes[0]));
    expect(screen.queryByText("Не удалось завершить занятие.")).toBeNull();
    expect(hasPending(h.values, stopKey)).toBe(false);
  });
});

describe("M1d: Q34 — no oral study send without the page's store (owner 12.10, var. 1; К19-029)", () => {
  it("the store does not open: no mark of the shown question, no reveal; the general unavailability line", async () => {
    const h = setup("prefetched");
    sendBudgetProvider.make = () => Promise.reject(new SendBudgetError("unavailable"));
    await mount(h);
    for (let second = 0; second < 30; second++) await h.step(1000);
    expect(h.posts).toEqual([]);
    expect(screen.getByText("Занятие недоступно в этом окне.")).toBeTruthy();
    expect(h.state()?.storageUnavailable).toBe(true);
  });
});

describe("M1d: Q32 (C489, C577) — the reason of a closure without the person outlives the machines", () => {
  it("the server closed S by midnight while X recovers: the forced summary with its reason, no C is sent", async () => {
    const h = setup("presented"); await mount(h);
    h.route(request => request.kind === "oral.reveal" ? "drop" : undefined);
    fireEvent.click(h.button("Раскрыть")); await h.step();
    h.close("midnight");
    for (let second = 0; second < 75; second++) await h.step(1000);
    expect(h.kinds("session.stop")).toEqual([]);
    expect(screen.getByText("Занятие закрыто: начался новый день")).toBeTruthy();
    expect(screen.queryByText(line927)).toBeNull();
    expect(h.state()?.closed?.reason).toBe("midnight");
    expect(h.state()?.unsavedClosures).toBeUndefined();
  });

  it("C refused because the server closed S by midnight meanwhile: C is not done, the reason stays midnight, no 9.2.7", async () => {
    const h = setup("presented"); await mount(h);
    h.route(request => {
      if (request.kind === "oral.reveal") return "drop";
      // The closure C meets the session the server closed by the calendar a moment before.
      if (request.kind === "session.stop" && h.kinds("session.stop").length === 1) h.close("midnight");
      return undefined;
    });
    fireEvent.click(h.button("Раскрыть"));
    for (let second = 0; second < 90; second++) await h.step(1000);
    expect(h.kinds("session.stop").map(post => (post.payload as { reason: string }).reason)).toEqual(["save_failed"]);
    expect(h.state()?.closed?.reason).toBe("midnight");
    expect(screen.getByText("Занятие закрыто: начался новый день")).toBeTruthy();
    expect(screen.queryByText(line927)).toBeNull();
    expect(screen.queryByText("Не удалось завершить занятие.")).toBeNull();
    // SESSION_CLOSED is final for C: its record goes; nothing claims it applied.
    expect(hasPending(h.values, stopKey)).toBe(false);
    expect(h.state()?.commands.stop.outcome).not.toBe("accepted");
  });
});
