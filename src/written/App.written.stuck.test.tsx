// M-WRITTEN-STUCK: a lost applied answer, then the pair changes on another device and the server closes the session
// (pair_changed). On return the written quiz shows that closure instead of «Завершаем занятие…» without a request.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/App";
import { app, exchange, field, loseReply, offlineStudy, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";
import { response } from "./writtenFixtures.test-support";

useWrittenAppEnvironment();
const foreground = () => act(async () => { window.dispatchEvent(new Event("pageshow")); });
type Served = { profile?: { dictionary_language: string }; settings?: { dictionary_language: { value: string } }; pair?: string };
/** The account's pair as served now: entry, Settings and Today follow `value`, the study endpoints keep their old pair. */
function pairSwitch(a: ReturnType<typeof app>) {
  const pair = { value: "ru" };
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    const reply = await base(url, init);
    if (!/(auth\/telegram|client\/open|\/settings|\/today)$/.test(path)) return reply;
    const body = await reply.json() as Served;
    if (body.profile) body.profile.dictionary_language = pair.value;
    if (body.settings) body.settings.dictionary_language.value = pair.value;
    if (path.endsWith("/today")) body.pair = `${pair.value}-de`;
    return response(body, reply.status);
  });
  return pair;
}
/** A lost applied answer; meanwhile the server closed the session by a pair change (to `next`, or the same pair). */
async function lostAnswerThenPairChange(next: "uk" | "ru") {
  const a = app({ cards: [6, 7] }), pair = pairSwitch(a); render(<App />);
  await startWords();
  loseReply(a, "answer.submit"); const restore = offlineStudy(a);
  fireEvent.change(field(), { target: { value: "Haus" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByText("Проверяем, сохранилось ли действие.", undefined, exchange);
  Object.assign(a.server.state, { status: "closed", closeReason: "pair_changed", assignment: null, version: a.server.state.version + 1 });
  pair.value = next; restore();
  const mark = a.fetcher.mock.calls.length;
  await foreground();
  return { a, mark };
}
const stops = (a: ReturnType<typeof app>) => a.kinds().filter(kind => kind === "session.stop");

describe("written: a pair changed elsewhere after a lost answer (M-WRITTEN-STUCK)", () => {
  it("A1: the return shows the interrupted session with its reason, never «Завершаем занятие…»", async () => {
    const { a } = await lostAnswerThenPairChange("uk");
    await screen.findByText("Занятие прервано.", undefined, exchange);
    expect(screen.getByText("Занятие закрыто: изменилась языковая пара")).toBeTruthy();
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    expect(screen.queryByRole("button", { name: "Далее" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Выйти" })).toBeNull();
    expect(stops(a)).toEqual([]);
  });
  it("A2: Back from that summary goes to Today and sends nothing", async () => {
    const { a } = await lostAnswerThenPairChange("uk");
    await screen.findByText("Занятие прервано.", undefined, exchange);
    const posts = a.posts().length;
    await a.back.click();
    await screen.findByText("Активная пара: Украинский ↔ Немецкий", undefined, exchange);
    expect(screen.queryByText("Занятие прервано.")).toBeNull();
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    expect(a.posts()).toHaveLength(posts);
    expect(stops(a)).toEqual([]);
  });
  it("A4: control, the same pair: the closed session is shown as before this package", async () => {
    const { a } = await lostAnswerThenPairChange("ru");
    await screen.findByText("Занятие прервано.", undefined, exchange);
    expect(screen.getByText("Занятие закрыто: изменилась языковая пара")).toBeTruthy();
    expect(screen.getByRole("button", { name: "На Сегодня" })).toBeTruthy();
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    await waitFor(() => expect(stops(a)).toEqual([]));
  });
});
