// D-FALSE-TEXTS part A, written quiz: «Не удалось обновить занятие.» is hidden only when a successful check that found the
// command absent is the ONLY current cause. A failed session read keeps it, whatever older not_found the lane holds.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import type { WrittenIntent } from "./writtenIntent";
import { id, response, tick, writtenFixture } from "./writtenFixtures.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const STALE = "Не удалось обновить занятие.";
const texts = () => [...document.querySelectorAll("p")].map(item => item.textContent);

async function reloadedStop(failReads: boolean) {
  vi.useFakeTimers();
  const stop: WrittenIntent = { command_id: id(401), session_id: id(3), kind: "session.stop", payload: { reason: "stop" } };
  const f = writtenFixture({ active: true, saved: { stop } });
  f.replace({ session: { id: id(3), phase: "active" } });
  if (failReads) {
    const base = f.server.handle;
    f.fetcher.mockImplementation(async (url, init) => String(url).includes("/sessions/") && init?.method === "GET"
      ? response({ error: { code: "UNEXPECTED" } }, 500) : base(url, init));
  }
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: "normal", initialSessionId: id(3) });
    return state ? <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={vi.fn()} /> : null;
  }
  render(<Harness />);
  const step = (ms = 0) => act(() => tick(ms));
  await step(); await step(1000);
  return { ...f, step };
}

describe("written quiz: the source of the current cause is vouched for", () => {
  it("a Stop whose check found it absent on the open step: the retry is offered, no refresh failure is claimed", async () => {
    await reloadedStop(false);
    expect(screen.getByRole("button", { name: "Повторить завершение" })).toBeTruthy();
    expect(texts()).not.toContain(STALE);
  });
  it("the same check, but the session read failed: the refresh failure stays", async () => {
    await reloadedStop(true);
    expect(texts()).toContain(STALE);
  });
});

// Both lanes hold a saved record; the check of each ends differently (C116 п. 2: an older not_found of one lane never hides
// the cause found by the other, in both directions).
// "stale": the answer is older than the known state. Used for the primary lane only: whether a Stop answer falls below the floor
// depends on which lane checks first, so a stale Stop is covered by the pure table of onlyCheckedAbsent instead.
type Check = "absent" | "net" | "500" | "stale";
async function twoLanes(primary: Check, stop: Check) {
  vi.useFakeTimers();
  const p: WrittenIntent = { command_id: id(400), session_id: id(3), kind: "answer.submit", assignment_id: id(6), payload: { text: "Haus" } };
  const s: WrittenIntent = { command_id: id(401), session_id: id(3), kind: "session.stop", payload: { reason: "stop" } };
  const f = writtenFixture({ active: true, saved: { primary: p, stop: s } });
  f.server.state.version = 5;
  f.replace({ session: { id: id(3), phase: "active" } });
  const base = f.server.handle;
  f.fetcher.mockImplementation(async (url, init) => {
    const address = String(url);
    if (init?.method === "GET" && address.includes("/commands/")) {
      const mode = address.includes(id(400)) ? primary : stop;
      if (mode === "net") throw new TypeError("network");
      if (mode === "500") return response({ error: { code: "UNEXPECTED" } }, 500);
      // An answer older than the known state (2.13): the outcome stays unknown, never an absence.
      if (mode === "stale") { const reply = await (await base(url, init)).json(); return response({ ...reply, state_version: "2" }); }
    }
    return base(url, init);
  });
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: "normal", initialSessionId: id(3) });
    return state ? <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={vi.fn()} /> : null;
  }
  render(<Harness />);
  const step = (ms = 0) => act(() => tick(ms));
  await step(); await step(1000); await step(2000);
  return { posts: f.posts() };
}

describe("written quiz, two lanes: the cause of the other lane is never hidden by an older not_found", () => {
  it("WA: both lanes found their record absent: the line is hidden (the one honest cause)", async () => {
    const h = await twoLanes("absent", "absent");
    expect(texts()).not.toContain(STALE);
    expect(h.posts).toEqual([]);
  });
  it.each([
    ["WC", "absent", "net"], ["WE", "absent", "500"],
    ["WB", "net", "absent"], ["WD", "500", "absent"], ["WF", "stale", "absent"],
  ] as const)("%s: primary %s, stop %s: the line stays", async (_name, primary, stop) => {
    const h = await twoLanes(primary, stop);
    expect(texts()).toContain(STALE);
    expect(h.posts).toEqual([]);
  });
});
