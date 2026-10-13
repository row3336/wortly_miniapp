// A written answer the server committed but whose reply was lost, then a full reload (D-23 trace 5.4). The new document
// restores the confirmed result by its receipt; the resume seed that arrives meanwhile must not re-create the owner and
// drop it. Nothing of the answer is posted again (tz_app §9, decision 2.3 = А).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { App } from "../app/App";
import { app, exchange, field, loseReply, offlineStudy, requests, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";

useWrittenAppEnvironment();
const sleep = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
/** Tap a control once it is enabled: it stays disabled while the restoring read is in flight. */
async function tap(name: string) {
  const button = await screen.findByRole("button", { name }, exchange) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false), exchange);
  fireEvent.click(button);
}

/** Answer the first question with a lost reply, then reload: returns the command and the result the server committed. */
async function reloadAfterLostAnswer(text: string, beforeReload?: (a: ReturnType<typeof app>, resultId: string) => void, strict = false) {
  const a = app({ cards: [6, 7] }); const first = render(<App />);
  await startWords();
  loseReply(a, "answer.submit"); const online = offlineStudy(a);
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await waitFor(() => expect(a.kinds()).toContain("answer.submit"));
  const commandId = a.posts().find(post => post.kind === "answer.submit")!.command_id as string;
  const resultId = a.server.receipts.get(commandId)!.fact.result_id as string;
  await sleep(50);
  first.unmount(); online();
  beforeReload?.(a, resultId);
  const mark = a.fetcher.mock.calls.length;
  // The production entry renders App in StrictMode (main.tsx).
  render(strict ? <StrictMode><App /></StrictMode> : <App />);
  await waitFor(() => expect(requests(a, mark)).toContain(`GET /api/v1/commands/${commandId}`), exchange);
  // The resume seed of the reloaded document names the same session.
  await waitFor(() => expect(requests(a, mark).filter(request => request === `GET /api/v1/sessions/${a.server.state.sessionId}`)
    .length).toBeGreaterThan(0), exchange);
  return { a, commandId, resultId };
}
const submits = (a: ReturnType<typeof app>, commandId: string) => a.posts().filter(post => post.command_id === commandId);

describe("Written result restored after a reload (trace 5.4)", () => {
  for (const strict of [false, true]) it(`a confirmed error is shown and waits for an action; its correction targets exactly that result${strict ? " (StrictMode)" : ""}`, async () => {
    const { a, commandId, resultId } = await reloadAfterLostAnswer("falsch", undefined, strict);
    await screen.findByText("Есть ошибка", undefined, exchange);
    await sleep(4000);
    expect(screen.getByText("Есть ошибка")).toBeTruthy();
    expect(screen.queryByText("слово 7")).toBeNull();
    expect(a.kinds().filter(kind => kind === "assignment.present")).toHaveLength(1);
    expect(submits(a, commandId)).toHaveLength(1);
    await tap("Исправить ответ");
    await waitFor(() => expect(a.kinds()).toContain("result.correct"));
    const correction = a.posts().find(post => post.kind === "result.correct")!;
    expect([correction.result_id, correction.expected_result_version]).toEqual([resultId, "1"]);
    await waitFor(() => expect(a.server.results.get(resultId)!.grade).toBe(4));
    expect(submits(a, commandId)).toHaveLength(1);
  }, 30_000);

  it("a confirmed correct answer is shown with its grades; a grade targets exactly that result", async () => {
    const { a, commandId, resultId } = await reloadAfterLostAnswer("Haus");
    await screen.findByText("Верно", undefined, exchange);
    expect(screen.queryByText("слово 7")).toBeNull();
    await tap("Легко");
    await waitFor(() => expect(a.kinds()).toContain("result.grade"));
    const grade = a.posts().find(post => post.kind === "result.grade")!;
    expect([grade.result_id, grade.expected_result_version, grade.payload]).toEqual([resultId, "1", { grade: 5 }]);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 30_000);

  it("a grade changed elsewhere after the answer stays current: the command's original error does not come back", async () => {
    const { a, commandId, resultId } = await reloadAfterLostAnswer("falsch", (a, resultId) => {
      // Another device corrected the error before this reload: version 2, grade 4.
      const stored = a.server.results.get(resultId)!;
      stored.grade = 4; stored.version = 2; a.server.state.version++;
    });
    await screen.findByText("Ответ исправлен", undefined, exchange);
    await sleep(500);
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    await tap("Легко");
    await waitFor(() => expect(a.kinds()).toContain("result.grade"));
    const grade = a.posts().find(post => post.kind === "result.grade")!;
    expect([grade.result_id, grade.expected_result_version]).toEqual([resultId, "2"]);
    expect(submits(a, commandId)).toHaveLength(1);
  }, 30_000);
});
