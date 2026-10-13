// Answer 17.1-А (R1) with two real windows of one profile (QA-R1-V3, C151): A opened after the pair moved to uk on the
// server, B still shows ru. The fake answers several installations as the core does (twoWindows.test-support).
import { fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { commandPosts, pairMoved, settle } from "../app/pairMoved.test-support";
import { windows } from "../app/twoWindows.test-support";
import { app, exchange, useWrittenAppEnvironment } from "./writtenApp.test-support";

useWrittenAppEnvironment();
const words = /Слова: перевод на немецкий/;
const ukText = "Активная пара: Украинский ↔ Немецкий", ruText = "Активная пара: Русский ↔ Немецкий";
type Window = Awaited<ReturnType<ReturnType<typeof windows>["mount"]>>;
const startRow = async (w: Window, name: RegExp) => await waitFor(() => {
  const button = w.ui.getByRole("button", { name }) as HTMLButtonElement;
  expect(button.disabled).toBe(false); return button;
}, exchange);
/** The window answers the question of `session` and stops it; the server applies both there. */
async function answerAndStop(w: Window) {
  fireEvent.change(w.ui.getByRole("textbox"), { target: { value: "Haus" } });
  fireEvent.click(w.ui.getByRole("button", { name: "Проверить" }));
  await w.ui.findByText("Верно", undefined, exchange);
  fireEvent.click(w.ui.getByRole("button", { name: "Выйти" }));
  await w.ui.findByText("Итог занятия", undefined, exchange);
}

describe("written R1 with two real windows of one profile", () => {
  it.each([false, true])("B (stale) starts: B lands in its own session, A is untouched (StrictMode %s)", async strict => {
    const a = app({ cards: [6, 7] }); const world = pairMoved(a.fetcher), w = windows(a.fetcher);
    const B = await w.mount("B", ruText, strict);
    const tap = await startRow(B, words);
    world.moved = true;
    const A = await w.mount("A", ukText, strict);
    const aOpens = w.opens("A").length, bOpens = w.opens("B").length;
    fireEvent.click(tap);
    expect(await B.ui.findByText("слово 6", undefined, exchange)).toBeTruthy();
    await settle(1500);
    expect(w.posts("B").map(post => post[0])).toEqual(["session.start", "assignment.present"]);
    expect(w.opens("B").slice(bOpens)).toEqual(["foreground"]);
    expect(w.posts("A")).toEqual([]);
    expect(w.opens("A").slice(aOpens)).toEqual([]);
    expect(A.ui.queryByText("слово 6")).toBeNull();
    // The return to the foreground reaches both windows: A has no session of its own and lands nowhere.
    document.dispatchEvent(new Event("visibilitychange")); await settle(2500);
    expect(A.ui.queryByText("слово 6")).toBeNull();
    expect(w.posts("A")).toEqual([]);
    const started = w.posts("B")[0][1];
    await answerAndStop(B);
    expect(w.posts("B")).toEqual([["session.start", started], ["assignment.present", started], ["answer.submit", started],
      ["session.stop", started]]);
    expect(w.posts("A")).toEqual([]);
    expect(commandPosts(a.fetcher).filter(post => post.kind === "session.start")).toHaveLength(1);
  });

  it("no R1: B itself holds the new pair, so its start refreshes nothing", async () => {
    const a = app({ cards: [6, 7] }); const world = pairMoved(a.fetcher), w = windows(a.fetcher);
    world.moved = true;
    const B = await w.mount("B", ukText);
    const tap = await startRow(B, words);
    const bOpens = w.opens("B").length;
    fireEvent.click(tap);
    expect(await B.ui.findByText("слово 6", undefined, exchange)).toBeTruthy();
    await settle(1200);
    expect(w.opens("B").slice(bOpens)).toEqual([]);
  });

  // The core refuses a start while the profile has an open session (SESSION_BUSY, final for that command) and the open
  // session goes on (study/session_start_refusal.py:82-85). A refused start is no accepted start: B refreshes nothing
  // into A's session and stops nothing; A answers and stops its own session.
  it("A started in the new pair itself, then B (stale) starts: SESSION_BUSY, A's session goes on, B takes nothing of it", async () => {
    const a = app({ cards: [6, 7] }); const world = pairMoved(a.fetcher), w = windows(a.fetcher);
    const B = await w.mount("B", ruText);
    const tapB = await startRow(B, words);
    world.moved = true;
    const A = await w.mount("A", ukText);
    fireEvent.click(await startRow(A, words));
    expect(await A.ui.findByText("слово 6", undefined, exchange)).toBeTruthy();
    const own = w.posts("A")[0][1], bOpens = w.opens("B").length;
    fireEvent.click(tapB);
    await settle(3000);
    const refused = w.posts("B");
    expect(refused.map(post => post[0])).toEqual(["session.start"]);
    expect(refused[0][1]).not.toBe(own);
    // No R1 refresh comes from a refused start; B never shows A's question and never stops it.
    expect(w.opens("B").slice(bOpens).filter(event => event === "foreground")).toEqual([]);
    expect(B.ui.queryByText("слово 6")).toBeNull();
    // B shows the existing busy state of a refused start (В02), not a failure of its own.
    expect(await B.ui.findByText("Занятие открыто на другом устройстве", undefined, exchange)).toBeTruthy();
    await answerAndStop(A);
    expect(w.posts("A")).toEqual([["session.start", own], ["assignment.present", own], ["answer.submit", own], ["session.stop", own]]);
    expect(w.posts("B").map(post => post[0])).toEqual(["session.start"]);
  });
});
