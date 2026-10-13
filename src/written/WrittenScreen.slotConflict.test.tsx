// D-FALSE-TEXTS part B, written quiz: a NEW action that meets the unconfirmed record X of another window in the shared slot
// was neither stored nor sent. Nothing is checked or sent for it, no record of the dropped ID is left, and no timer or retry
// sends it. Decision 14.8.8.1 А (owner, C117): the live window then reads X and checks it by its own ID at once; decision
// 2.3 А: X, created elsewhere, is never sent from here (GUARD_14881_v2). X is a record of the open session, as another
// window of this device would leave it. Texts 2.2 and the exit 2.1 are not chosen: no assertion names them.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pageSendCounter } from "../commands/laneRecovery";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import type { WrittenIntent } from "./writtenIntent";
import { writtenPrimaryKey } from "./writtenPending";
import { id, pending, profile, response, tick, writtenFixture, type ServerOptions } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });

const OFFLINE = "Нет связи с сервером. Ждём, когда связь восстановится…";
const X: WrittenIntent = { command_id: id(400), session_id: id(3), kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } };
const X_MARKS = { reserved: 2, transmitted: 1 };

async function open(options: ServerOptions = {}) {
  vi.useFakeTimers();
  const f = writtenFixture(options);
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: "normal" });
    if (!state) return null;
    return <>
      <button type="button" onClick={() => { void actions.start("words"); }}>start-words</button>
      <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={vi.fn()} />
    </>;
  }
  const mount = () => render(<Harness />);
  mount();
  const step = (ms = 0) => act(() => tick(ms));
  await step();
  fireEvent.click(screen.getByRole("button", { name: "start-words" })); await step();
  const answer = async (text: string) => {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" })); await step();
  };
  /** The old window's unconfirmed record of the open session appears in the slot after this window loaded it; its count is in the page. */
  const occupy = async (base: WrittenIntent = X) => {
    const intent = { ...base, session_id: f.posts().find(post => post.kind === "session.start")!.session_id } as WrittenIntent;
    await occupyAs(intent);
  };
  /** The record exactly as given (its own session): used for a record of an earlier session. */
  const occupyAs = async (intent: WrittenIntent) => {
    f.values.set(writtenPrimaryKey, JSON.stringify(pending(intent)));
    await pageSendCounter(f.storage).save(intent.command_id, X_MARKS);
  };
  const overlay = () => document.querySelector(".recovery-overlay");
  const visible = () => [...document.querySelectorAll("p")].map(item => item.textContent);
  const slotId = () => JSON.parse(f.values.get(writtenPrimaryKey)!).intent.command_id as string;
  const lastNewId = () => f.newId.mock.results.at(-1)!.value as string;
  const button = (name: string) => screen.queryAllByRole("button").find(item => item.textContent === name) as HTMLButtonElement | undefined;
  const learningPosts = () => f.posts().filter(post => post.kind !== "session.start" && post.kind !== "assignment.present" || post.assignment_id !== id(6));
  return { ...f, mount, step, answer, occupy, occupyAs, overlay, visible, slotId, lastNewId, button, learningPosts };
}
/**
 * Synthetic contract premise (C240, C253): X is put straight into the slot after the live owner loaded, and "the other
 * window" applies it through the fixture server with client_instance_id/document_id "other-window"; no second real
 * window runs. Once the core recorded X, the view may show X's result. The tests below aim at the freed slot and one new
 * Z, not at how that old result advances: they take the existing «Далее» first. If the view already moved on by its
 * timer, there is no «Далее» to take (next() is guarded by canNext), and that is fine; no assertion picks the timer.
 */
async function nextBeforeZ(h: Awaited<ReturnType<typeof open>>) {
  const next = h.button("Далее");
  if (next) { fireEvent.click(next); await h.step(); await h.step(1000); }
}
/** 14.8.8.1 А: the only status requests are those of X, by its own ID; the dropped ID is never asked for. */
function checkedOnlyX(h: Awaited<ReturnType<typeof open>>, dropped: string) {
  const checks = h.gets("/commands/");
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.every(url => url.includes(X.command_id))).toBe(true);
  expect(checks.filter(url => url.includes(dropped))).toEqual([]);
}
/** The check of X proved its step outdated (CT §6.1 п. 7, step_stale): the record and the count of X are gone, nothing of Y appears. */
async function xClearedAsStale(h: Awaited<ReturnType<typeof open>>, dropped: string) {
  expect(h.values.has(writtenPrimaryKey)).toBe(false);
  expect(await pageSendCounter(h.storage).load(X.command_id)).toBeNull();
  expect(await pageSendCounter(h.storage).load(dropped)).toBeNull();
}
async function untouched(h: Awaited<ReturnType<typeof open>>, dropped: string) {
  expect(h.slotId()).toBe(X.command_id);
  expect(await pageSendCounter(h.storage).load(X.command_id)).toEqual(X_MARKS);
  // No record of the dropped ID, neither the reservation nor its give-back, whatever the machine wrote or cleared meanwhile.
  expect(await pageSendCounter(h.storage).load(dropped)).toBeNull();
  expect(h.gets("/commands/").filter(url => url.includes(dropped))).toEqual([]);
}

describe("written quiz, B: a new action meets the record of another window", () => {
  it("an answer: X is checked by its own ID and never sent, no connection overlay, POST 0, X and its count untouched, the typed text stays", async () => {
    const h = await open();
    await h.occupy();
    const before = h.posts().length;
    await h.answer("Haus");
    const dropped = h.lastNewId();
    await h.step(1000);
    checkedOnlyX(h, dropped);
    const early = h.gets("/commands/").length;
    await h.step(120_000);
    expect(h.overlay()).toBeNull();
    expect(document.body.textContent).not.toContain(OFFLINE);
    expect(document.body.textContent).not.toContain("Сохраняем ответ…");
    expect(h.posts().length).toBe(before);
    // 14.8.8.1 А: X keeps being checked on the existing probe series; 2.3 А: no POST of X and no manual retry of it here.
    checkedOnlyX(h, dropped);
    expect(h.gets("/commands/").length).toBeGreaterThan(early);
    expect(h.button("Повторить действие")).toBeUndefined();
    expect(h.button("Проверить")?.disabled).toBe(true);
    await untouched(h, dropped);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Haus");
  });

  it("the dropped action is gone for good: no later timer or check sends or asks for it, and a new Z passes once the server recorded X", async () => {
    const h = await open();
    await h.occupy();
    const x = JSON.parse(h.values.get(writtenPrimaryKey)!).intent as WrittenIntent;
    await h.answer("Haus");
    const dropped = h.lastNewId();
    await h.step(180_000);
    expect(h.posts().filter(post => post.kind === "answer.submit")).toEqual([]);
    checkedOnlyX(h, dropped);
    await untouched(h, dropped);
    // X is resolved where it was created: the other window's send reaches the server. The next check of X finds it recorded
    // (a recorded fact settles X, GUARD_14881_v2), its record and count go, and a new action Z gets a new ID and is sent once.
    await h.server.handle("http://localhost/api/v1/commands", { method: "POST",
      body: JSON.stringify({ ...x, client_instance_id: "other-window", document_id: "other-window" }) });
    await h.step(40_000);
    expect(h.values.has(writtenPrimaryKey)).toBe(false);
    expect(await pageSendCounter(h.storage).load(X.command_id)).toBeNull();
    await nextBeforeZ(h);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" })); await h.step(); await h.step(1000);
    const sent = h.posts().filter(post => post.kind === "answer.submit");
    expect(sent).toHaveLength(1);
    expect(sent[0].command_id).not.toBe(dropped);
    expect(sent[0].command_id).not.toBe(X.command_id);
    expect(h.gets("/commands/").filter(url => url.includes(dropped))).toEqual([]);
    expect(h.posts().some(post => post.command_id === X.command_id)).toBe(false);
    expect(await pageSendCounter(h.storage).load(dropped)).toBeNull();
  });

  it("a new owner of the window after the conflict (reopen): X is loaded and checked by its own ID, the dropped ID never appears", async () => {
    const h = await open();
    await h.occupy();
    await h.answer("Haus");
    const dropped = h.lastNewId();
    cleanup();
    h.mount(); await h.step(); await h.step(10_000);
    const urls = h.fetcher.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.includes(dropped))).toBe(false);
    expect(h.posts().some(post => post.command_id === dropped)).toBe(false);
    expect(h.gets("/commands/").every(url => url.includes(X.command_id))).toBe(true);
    expect(await pageSendCounter(h.storage).load(dropped)).toBeNull();
  });

  it("a real lost connection of a sent answer is still named as such", async () => {
    const h = await open();
    h.offline();
    await h.answer("Haus");
    expect(h.overlay()?.textContent).toBe(OFFLINE);
  });

  it("the shown question after a correct result: the timer's next card meets X, POST 0, X of an outdated step is checked and cleared, the result stays, nothing advances", async () => {
    const h = await open({ cards: [6, 7, 8] });
    await h.answer("Haus"); await h.step(500);
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    // X answers card 7, which the server has not shown yet: its check proves the step outdated.
    await h.occupy({ ...X, assignment_id: id(7) });
    const before = h.posts().length;
    // The automatic timer of the result (3 s, normal mode) asks for the next card: its present is the new action.
    await h.step(4000);
    const dropped = h.lastNewId();
    await h.step(120_000);
    expect(h.posts().length).toBe(before);
    expect(h.overlay()).toBeNull();
    expect(document.body.textContent).not.toContain(OFFLINE);
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    checkedOnlyX(h, dropped);
    await xClearedAsStale(h, dropped);
    // One attempt only: once X is gone no timer asks for the next card again.
    const attempts = h.newId.mock.calls.length;
    await h.step(30_000);
    expect(h.newId.mock.calls.length).toBe(attempts);
    expect(h.posts().length).toBe(before);
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
  });

  it("a correction of a wrong answer: POST 0, the old result and the reason stay, X of an outdated step is checked and cleared", async () => {
    const h = await open();
    await h.answer("falsch");
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    await h.occupy({ ...X, kind: "answer.submit" });
    const before = h.posts().length;
    fireEvent.click(screen.getByRole("button", { name: "Исправить ответ" })); await h.step(); await h.step(120_000);
    const dropped = h.lastNewId();
    expect(h.posts().length).toBe(before);
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    expect(h.overlay()).toBeNull();
    expect(document.body.textContent).not.toContain("Проверяем изменение");
    // X answers the card whose result is already shown: its check proves the step outdated, X goes, the correction is free again.
    checkedOnlyX(h, dropped);
    await xClearedAsStale(h, dropped);
    expect(h.button("Исправить ответ")?.disabled).toBe(false);
  });

  it("«Шаг назад»: POST 0, the result stays, X of an outdated step is checked and cleared", async () => {
    const h = await open({ undo: true });
    await h.answer("falsch");
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    await h.occupy();
    const before = h.posts().length;
    fireEvent.click(screen.getByRole("button", { name: "Шаг назад" })); await h.step(); await h.step(120_000);
    const dropped = h.lastNewId();
    expect(h.posts().length).toBe(before);
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    expect(h.overlay()).toBeNull();
    checkedOnlyX(h, dropped);
    await xClearedAsStale(h, dropped);
  });

  it("an action already sent whose reply was lost, then a conflict at the retry: not dropped (retained intent)", async () => {
    // Guard of the branch: only a NEW intent is dropped. A sent one keeps its record and its recovery.
    const h = await open();
    h.loseReply(); h.offline();
    await h.answer("Haus");
    expect(h.overlay()?.textContent).toBe(OFFLINE);
    expect(h.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
  });
});

// C170: the record X of an EARLIER session that is closed now, on the same installation. The fake answers at X's own address as
// core does (command_status.py: not_found with closed_session for the session_id asked; the read of that session is its own
// closed projection), never with the projection of the new session under the old ID.
describe("written quiz, B: the record of a closed earlier session blocks a new action", () => {
  it("X is checked once by its own ID, its closure clears X by the closure rule, Y is never sent, and a new Z then passes", async () => {
    const h = await open();
    const old: WrittenIntent = { command_id: X.command_id, session_id: id(3), kind: "answer.submit", assignment_id: id(66), payload: { text: "Haus" } };
    const base = h.server.handle;
    h.fetcher.mockImplementation(async (url, init) => {
      const address = new URL(String(url), "http://localhost"), version = String(h.server.state.version);
      if (init?.method === "GET" && address.pathname === `/api/v1/commands/${old.command_id}`) {
        return response({ command: { id: old.command_id, status: "not_found" }, current: profile(version), state_version: version,
          ...(address.searchParams.get("session_id") === id(3) ? { closed_session: { session_id: id(3), status: "closed", close_reason: "stop" } } : {}) });
      }
      if (init?.method === "GET" && address.pathname === `/api/v1/sessions/${id(3)}`) {
        return response({ current: { session_id: id(3), status: "closed", mode: "written", pair: "ru-de", direction: "l1-de",
          local_date: "2026-10-04", bucket: "words", close_reason: "stop", progress: { completed: 1, total: 2, correct: 1, wrong: 0 },
          assignment: null, summary: { completed: 1, correct: 1, wrong: 0, ratio: { numerator: 1, denominator: 1 } } }, state_version: version });
      }
      return base(url, init);
    });
    await h.occupyAs(old);
    const before = h.posts().length;
    await h.answer("Haus");
    const dropped = h.lastNewId();
    await h.step(1000); await h.step(120_000);
    checkedOnlyX(h, dropped);
    expect(h.posts().length).toBe(before);
    expect(h.values.has(writtenPrimaryKey)).toBe(false);
    expect(h.overlay()).toBeNull();
    expect(document.body.textContent).not.toContain(OFFLINE);
    expect(await pageSendCounter(h.storage).load(dropped)).toBeNull();
    // The dropped Y stays dropped; the person's next tap is a new action Z with a new ID, sent once.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" })); await h.step(); await h.step(1000);
    const sent = h.posts().filter(post => post.kind === "answer.submit");
    expect(sent).toHaveLength(1);
    expect([dropped, X.command_id]).not.toContain(sent[0].command_id);
    expect(h.posts().some(post => post.command_id === X.command_id)).toBe(false);
  });
});

// C170: X of the open session vanished from the device while the core still answers not_found. A local removal proves nothing
// about the core: the window keeps the check of X it holds and lets no new action pass (an unknown outcome lets nothing
// continue). Only a sufficient fact of the core ends the block; the window then follows the core's current state and rights.
describe("written quiz, B: X vanished locally, the block ends only by a fact of the core", () => {
  async function blockedThenVanished() {
    const h = await open({ cards: [6, 7, 8] });
    await h.occupy();
    const x = JSON.parse(h.values.get(writtenPrimaryKey)!).intent as WrittenIntent;
    await h.answer("Haus");
    const dropped = h.lastNewId();
    await h.step(1000);
    h.values.delete(writtenPrimaryKey);
    await h.step(60_000);
    return { h, x, dropped };
  }
  const xPosts = (h: Awaited<ReturnType<typeof open>>, dropped: string) =>
    h.posts().filter(post => post.command_id === X.command_id || post.command_id === dropped);
  /** The check of X has ended: no further status request of X over a long wait. */
  async function checksEnded(h: Awaited<ReturnType<typeof open>>) {
    const settled = h.gets("/commands/").length;
    await h.step(180_000);
    expect(h.gets("/commands/").length).toBe(settled);
  }
  async function zPassesOnce(h: Awaited<ReturnType<typeof open>>, dropped: string) {
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" })); await h.step(); await h.step(1000);
    const sent = h.posts().filter(post => post.kind === "answer.submit");
    expect(sent).toHaveLength(1);
    expect([dropped, X.command_id]).not.toContain(sent[0].command_id);
  }

  it("the core still answers not_found: the check of X goes on, nothing is sent, no new action passes", async () => {
    const { h, dropped } = await blockedThenVanished();
    const checks = h.gets("/commands/").length;
    await h.step(120_000);
    checkedOnlyX(h, dropped);
    expect(h.gets("/commands/").length).toBeGreaterThan(checks);
    expect(xPosts(h, dropped)).toEqual([]);
    expect(h.posts().filter(post => post.kind === "answer.submit")).toEqual([]);
    expect(h.button("Проверить")?.disabled).toBe(true);
    expect(h.button("Повторить действие")).toBeUndefined();
  });

  it("(а) the core recorded X: the check settles it, its count goes, the check ends, and a new Z passes once", async () => {
    const { h, x, dropped } = await blockedThenVanished();
    await h.server.handle("http://localhost/api/v1/commands", { method: "POST",
      body: JSON.stringify({ ...x, client_instance_id: "other-window", document_id: "other-window" }) });
    await h.step(60_000);
    checkedOnlyX(h, dropped);
    expect(await pageSendCounter(h.storage).load(X.command_id)).toBeNull();
    expect(xPosts(h, dropped)).toEqual([]);
    await checksEnded(h);
    await nextBeforeZ(h);
    await zPassesOnce(h, dropped);
  });

  it("(б) the step moved on in the core (another window answered the card): X is outdated and goes, a new Z passes once", async () => {
    const { h, x, dropped } = await blockedThenVanished();
    await h.server.handle("http://localhost/api/v1/commands", { method: "POST",
      body: JSON.stringify({ ...x, command_id: id(401), client_instance_id: "other-window", document_id: "other-window" }) });
    await h.step(60_000);
    checkedOnlyX(h, dropped);
    expect(await pageSendCounter(h.storage).load(X.command_id)).toBeNull();
    expect(xPosts(h, dropped)).toEqual([]);
    await checksEnded(h);
    await zPassesOnce(h, dropped);
  });

  it("(в) the session was closed in the core: the check ends with the closure, nothing is sent, only the way to Today is left", async () => {
    const { h, dropped } = await blockedThenVanished();
    h.server.state.status = "closed"; h.server.state.closeReason = "stop"; h.server.state.version++;
    await h.step(60_000);
    checkedOnlyX(h, dropped);
    expect(xPosts(h, dropped)).toEqual([]);
    expect(h.posts().filter(post => post.kind === "answer.submit")).toEqual([]);
    expect(h.button("На Сегодня")).toBeTruthy();
    expect(document.querySelector("textarea")).toBeNull();
    await checksEnded(h);
  });
});

