// Owner decision 20.1-А: a written answer the server committed but whose result the user never saw, then a full
// reload. The reloaded document shows the confirmed correct result for the first time and waits for «Далее» in every
// transition mode. The first show in the same live window keeps the auto-advance (3 s, accelerated 2 s); a result the
// check by its ID reports already recorded after a lost reply waits for «Далее» there too (Q03 вариант 1).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { app, exchange, field, loseReply, offlineStudy, requests, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";
import { pageGateOpen } from "../app/pageGate.test-support";

useWrittenAppEnvironment();
type Mode = "normal" | "accelerated";
const sleep = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const tree = (strict: boolean) => strict ? <StrictMode><App /></StrictMode> : <App />;
const presents = (a: ReturnType<typeof app>) => a.kinds().filter(kind => kind === "assignment.present").length;
const submits = (a: ReturnType<typeof app>, commandId: string) => a.posts().filter(post => post.command_id === commandId);
const label = (mode: Mode, strict: boolean) => `${mode}${strict ? ", StrictMode" : ""}`;
const cases = ([["normal", false], ["accelerated", false], ["normal", true], ["accelerated", true]] as [Mode, boolean][]);
/** The reload's status check of the old command answers late (QA-RESULT-RESTORE-V2 W-slowCommand): 0, 400 or 1500 ms. */
const delays = [0, 400, 1500];
function slowCommandChecks(a: ReturnType<typeof app>, ms: number) {
  if (ms === 0) return;
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if ((init?.method ?? "GET") === "GET" && path.includes("/commands/")) await new Promise(resolve => setTimeout(resolve, ms));
    return base(url, init);
  });
}
async function tap(name: string) {
  const button = await screen.findByRole("button", { name }, exchange) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false), exchange);
  fireEvent.click(button);
}
/** Answer with a lost reply while study reads are offline; returns the command and the restore of the reads. */
async function lostAnswer(a: ReturnType<typeof app>, text = "Haus") {
  loseReply(a, "answer.submit"); const online = offlineStudy(a);
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await waitFor(() => expect(a.kinds()).toContain("answer.submit"));
  const commandId = a.posts().find(post => post.kind === "answer.submit")!.command_id as string;
  await sleep(50);
  return { commandId, resultId: a.server.receipts.get(commandId)!.fact.result_id as string, online };
}

describe("Written correct result first shown after a full reload (decision 20.1-А)", () => {
  for (const [mode, strict] of cases) it(`waits for «Далее», then exactly one present; the grade targets that result (${label(mode, strict)})`, async () => {
    const a = app({ cards: [6, 7], transitionMode: mode }); const first = render(tree(strict));
    await startWords();
    const { commandId, resultId, online } = await lostAnswer(a);
    first.unmount(); online();
    const mark = a.fetcher.mock.calls.length;
    render(tree(strict));
    await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/commands/${commandId}`), exchange);
    // The resume seed of the reloaded document names the same session: the owner adopts it and keeps the result.
    await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/sessions/${a.server.state.sessionId}`), exchange);
    await screen.findByText("Верно", undefined, exchange);
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByText("Верно")).toBeTruthy();
    expect(screen.queryByText("слово 7")).toBeNull();
    expect(presents(a)).toBe(before);
    expect([a.server.results.get(resultId)!.grade, a.server.results.get(resultId)!.version]).toEqual([4, 1]);
    await tap("Легко");
    await waitFor(() => expect(a.kinds()).toContain("result.grade"));
    const grade = a.posts().find(post => post.kind === "result.grade")!;
    expect([grade.result_id, grade.expected_result_version, grade.payload]).toEqual([resultId, "1", { grade: 5 }]);
    // A confirmed new grade may advance (it is not the restored first show); either way exactly one present follows.
    await screen.findByText("слово 7", undefined, { timeout: 8000 });
    await sleep(500);
    expect(presents(a)).toBe(before + 1);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const delay of delays) for (const [mode, strict] of cases) it(`«Далее» advances exactly once; status check ${delay} ms late (${label(mode, strict)})`, async () => {
    const a = app({ cards: [6, 7], transitionMode: mode }); const first = render(tree(strict));
    await startWords();
    const { commandId, online } = await lostAnswer(a);
    first.unmount(); online(); slowCommandChecks(a, delay);
    render(tree(strict));
    await screen.findByText("Верно", undefined, exchange);
    const before = presents(a);
    await sleep(4500);
    expect(presents(a)).toBe(before);
    await tap("Далее");
    await screen.findByText("слово 7", undefined, exchange);
    await sleep(500);
    expect(presents(a)).toBe(before + 1);
    expect(a.kinds().filter(kind => kind.startsWith("result."))).toEqual([]);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  // P03 M-P03-10 (§4.13 В, AC-102): after a 403 (Z5) the retry of the same window is blocked until Я19; the re-entry is a
  // new launch (the full reload above). The window sends nothing more, its pending answer stays for that launch.
  for (const [mode, strict] of cases) it(`a 403 in the same window: the retry is blocked, nothing more is sent (${label(mode, strict)})`, async () => {
    const a = app({ cards: [6, 7], transitionMode: mode }); render(tree(strict));
    await startWords();
    loseReply(a, "answer.submit");
    const base = a.fetcher.getMockImplementation()!;
    let denied = false;
    a.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname;
      if (!denied && (init?.method ?? "GET") === "GET" && (path.includes("/commands/") || path.includes("/sessions/"))) {
        denied = true; return new Response("", { status: 403 });
      }
      return base(url, init);
    });
    fireEvent.change(field(), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(a.kinds()).toContain("answer.submit"));
    const commandId = a.posts().find(post => post.kind === "answer.submit")!.command_id as string;
    const again = await screen.findByRole("button", { name: "Попробовать ещё раз" }, { timeout: 10_000 }) as HTMLButtonElement;
    await pageGateOpen();
    const posts = a.posts().length;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    await sleep(500);
    expect(screen.queryByText("Верно")).toBeNull();
    expect(a.posts()).toHaveLength(posts);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const [mode, strict] of cases) it(`control: the first show in the live window advances after ${mode === "accelerated" ? 2 : 3} s (${label(mode, strict)})`, async () => {
    app({ cards: [6, 7], transitionMode: mode }); render(tree(strict));
    await startWords();
    fireEvent.change(field(), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Верно", undefined, exchange);
    const shown = Date.now();
    await screen.findByText("слово 7", undefined, { timeout: 6000 });
    const elapsed = Date.now() - shown;
    expect(elapsed).toBeGreaterThanOrEqual(mode === "accelerated" ? 1800 : 2800);
    expect(elapsed).toBeLessThan(mode === "accelerated" ? 2900 : 3900);
  }, 40_000);

  for (const [mode, strict] of cases) it(`a lost reply the live window finds already recorded waits for «Далее» (Q03) (${label(mode, strict)})`, async () => {
    const a = app({ cards: [6, 7], transitionMode: mode }); render(tree(strict));
    await startWords();
    const { commandId, online } = await lostAnswer(a);
    online();
    await screen.findByText("Верно", undefined, { timeout: 10_000 });
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByText("Верно")).toBeTruthy();
    expect(screen.queryByText("слово 7")).toBeNull();
    expect(presents(a)).toBe(before);
    await tap("Далее");
    await screen.findByText("слово 7", undefined, exchange);
    await sleep(500);
    expect(presents(a)).toBe(before + 1);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);
});

// Table 6.1.8: a live error waits in the normal mode and advances after 2 s in the accelerated one; only a real
// background or return makes it wait. An old error a reloaded document restores by its ID waits for «Далее» in both
// modes, whatever the order of its reads (Q03 вариант 1, WM Q-06).
describe("Written error first shown after a full reload", () => {
  for (const delay of delays) for (const [mode, strict] of cases) it(`waits for «Далее»; status check ${delay} ms late (${label(mode, strict)})`, async () => {
    const a = app({ cards: [6, 7], transitionMode: mode }); const first = render(tree(strict));
    await startWords();
    const { commandId, online } = await lostAnswer(a, "falsch");
    first.unmount(); online(); slowCommandChecks(a, delay);
    render(tree(strict));
    await screen.findByText("Есть ошибка", undefined, { timeout: 8000 });
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    expect(screen.queryByText("слово 7")).toBeNull();
    expect(presents(a)).toBe(before);
    await tap("Далее");
    await screen.findByText("слово 7", undefined, exchange);
    await sleep(500);
    expect(presents(a)).toBe(before + 1);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 40_000);

  for (const strict of [false, true]) it(`control: a live accelerated error left to the background waits for «Далее» on the return (${label("accelerated", strict)})`, async () => {
    const a = app({ cards: [6, 7], transitionMode: "accelerated" }); render(tree(strict));
    await startWords();
    fireEvent.change(field(), { target: { value: "falsch" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Есть ошибка", undefined, exchange);
    const before = presents(a);
    const visible = vi.spyOn(document, "visibilityState", "get");
    visible.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    await sleep(300);
    visible.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
    await sleep(4500);
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    expect(presents(a)).toBe(before);
    await tap("Далее");
    await screen.findByText("слово 7", undefined, exchange);
    expect(presents(a)).toBe(before + 1);
  }, 40_000);
});

// Owner decision 32.1-А: a correction the server committed whose reply was lost shows «Ответ исправлен» for the first
// time after a full restart and waits for «Далее» in both modes; the old correction is never sent again.
describe("Written correction first shown after a full restart (decision 32.1-А)", () => {
  for (const delay of [0, 1500]) for (const [mode, strict] of cases) it(`waits for «Далее», then exactly one present; status check ${delay} ms late (${label(mode, strict)})`, async () => {
    const a = app({ cards: [6, 7], transitionMode: mode }); const first = render(tree(strict));
    await startWords();
    fireEvent.change(field(), { target: { value: "falsch" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await screen.findByText("Есть ошибка", undefined, exchange);
    loseReply(a, "result.correct"); const online = offlineStudy(a);
    await tap("Исправить ответ");
    await waitFor(() => expect(a.kinds()).toContain("result.correct"));
    const lost = a.posts().find(post => post.kind === "result.correct")!;
    await sleep(50);
    first.unmount(); online(); slowCommandChecks(a, delay);
    const mark = a.fetcher.mock.calls.length;
    render(tree(strict));
    await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/commands/${lost.command_id}`), exchange);
    await screen.findByText("Ответ исправлен", undefined, { timeout: 8000 });
    const before = presents(a);
    await sleep(4500);
    expect(screen.getByText("Ответ исправлен")).toBeTruthy();
    expect(screen.queryByText("слово 7")).toBeNull();
    expect(presents(a)).toBe(before);
    const result = a.server.results.get(lost.result_id as string)!;
    expect([result.grade, result.version]).toEqual([4, 2]);
    await tap("Далее");
    await screen.findByText("слово 7", undefined, exchange);
    await sleep(500);
    expect(presents(a)).toBe(before + 1);
    expect(a.kinds().filter(kind => kind === "result.correct")).toHaveLength(1);
  }, 40_000);
});
