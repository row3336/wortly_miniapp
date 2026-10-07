import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/App";
import { intervalWorld } from "../dictionary/intervalCardTestData.test-support";
import { answer, app, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";
import { id, response } from "./writtenFixtures.test-support";

useWrittenAppEnvironment();

const CARD_6 = id(106);
/**
 * The real App over the synthetic written server plus the card endpoints of core with the manual increase (C-INTV,
 * C-INTV-OFFER). One profile state version for both, as in core.
 */
function intervalApp(options: { lagging?: boolean } = {}) {
  const a = app({ cards: [6, 7, 8] });
  const s = a.server.state, base = a.fetcher.getMockImplementation()!;
  const world = intervalWorld({ cardId: CARD_6, id: n => id(n + 300), version: { get: () => s.version, bump: () => ++s.version } });
  const lagging: string[] = [];
  a.fetcher.mockImplementation(async (url, init) => {
    const card = world.handle(url as RequestInfo, init);
    if (card) return card;
    if (options.lagging && world.increasedAt !== null && init?.method !== "POST" && String(url).includes("/sessions/")) {
      // A lagging reader: every session read after the increase reports a version older than it.
      const read = await (await base(url, init)).json();
      read.state_version = String(world.increasedAt - 1);
      lagging.push(read.state_version);
      return response(read);
    }
    return base(url, init);
  });
  return { ...a, world, lagging };
}
const quizKinds = (a: ReturnType<typeof intervalApp>) => a.kinds()
  .filter(kind => !kind.startsWith("context.") && kind !== "interval.increase" && !kind.startsWith("action.undo"));

async function increaseFromTheAnsweredCard(a: ReturnType<typeof intervalApp>) {
  await startWords(); await answer("falsch");
  fireEvent.click(screen.getByRole("button", { name: "Уточнить поля" }));
  const open = await screen.findByRole("button", { name: "Увеличить интервал" }, { timeout: 5000 }) as HTMLButtonElement;
  await waitFor(() => expect(open.disabled).toBe(false));
  fireEvent.click(open);
  fireEvent.click(within(screen.getByRole("dialog", { name: "Увеличить интервал" })).getByRole("button", { name: "Увеличить" }));
  await screen.findByRole("button", { name: "Отменить увеличение" });
  await screen.findByText("Интервал: 56 дн.");
  expect(a.world.kinds()).toEqual(["context.open", "interval.increase", "action.undo_offer.open"]);
}

describe("the manual increase from the written quiz through the actual App (M-INTV CP2)", () => {
  it("I1 the card of the answered word increases L1→De; «Назад» returns to the same result, the quiz does not move on", async () => {
    const a = intervalApp(); render(<App />);
    await increaseFromTheAnsweredCard(a);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("Есть ошибка");
    expect(screen.getByRole("button", { name: "Далее" })).toBeTruthy();
    await waitFor(() => expect(a.world.kinds().at(-1)).toBe("context.close"));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(quizKinds(a)).toEqual(["session.start", "assignment.present", "answer.submit"]);
  });

  it("I2 the App passes the increase to the quiz: a session read older than it is not shown as the current step (Т08)", async () => {
    const a = intervalApp({ lagging: true }); render(<App />);
    await increaseFromTheAnsweredCard(a);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await waitFor(() => expect(a.lagging.length).toBeGreaterThan(0));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(screen.queryByText("Есть ошибка")).toBeNull();
    expect(quizKinds(a)).toEqual(["session.start", "assignment.present", "answer.submit"]);
  });
});
