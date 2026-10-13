// The pause before a resend through the actual App (M-RETRY-DUE v2, CT §6.1 п. 4): after a lost answer and «Попробовать
// ещё раз» a re-created owner of the same document sends at max(retry, pause of the lost send), never a full pause later,
// and only right after a check of the fact. Fake time; one synthetic server.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { hashInPlace, tick } from "../commands/recoveryTime.test-support";
import { RETRY_PAUSES_MS } from "../commands/recoveryLimits";
import { app, field, pairText, row, settingsRefusalText, useWrittenAppEnvironment } from "./writtenApp.test-support";

useWrittenAppEnvironment();
const step = (ms = 0) => act(() => tick(ms));
const text = (value: string) => document.body.textContent?.includes(value) ?? false;
async function waitUntil(test: () => boolean, label: string, limitMs = 20_000) {
  for (let spent = 0; spent <= limitMs; spent += 50) { if (test()) return; await step(50); }
  throw new Error(`not reached: ${label}`);
}

type Net = { offline: boolean; lostAt: number; submits: number[]; checks: number[] };

/** The written quiz on «слово 6»; the answer is sent `lost` times and every send is lost, the last one with the network. */
async function loseAnswer(lost: number) {
  const a = app({ cards: [6, 7] });
  const net: Net = { offline: false, lostAt: -1, submits: [], checks: [] };
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, method = init?.method ?? "GET";
    if (net.offline) throw new TypeError("network");
    if (method === "GET" && path.includes("/commands/")) net.checks.push(performance.now());
    if (method === "POST" && path.endsWith("/commands") && JSON.parse(String(init!.body)).kind === "answer.submit") {
      net.submits.push(performance.now());
      if (net.submits.length <= lost) {
        if (net.submits.length === lost) { net.lostAt = performance.now(); net.offline = true; }
        throw new TypeError("network");
      }
    }
    return base(url, init);
  });
  render(<App />);
  await waitUntil(() => text(pairText), "today");
  await waitUntil(() => !row(/Слова: перевод на немецкий/).disabled, "words row");
  fireEvent.click(row(/Слова: перевод на немецкий/));
  await waitUntil(() => text("слово 6"), "question");
  await waitUntil(() => !field().readOnly, "answer field");
  fireEvent.change(field(), { target: { value: "Haus" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await waitUntil(() => net.lostAt >= 0, "loss", 120_000);
  return net;
}
const after = (net: Net, at: number) => Math.round(at - net.lostAt);
/** Resends of the answer, ms after the loss. */
const resends = (net: Net) => net.submits.filter(at => at > net.lostAt).map(at => after(net, at));
/** Each resend follows a status check by ID in the same instant. */
const checkedFirst = (net: Net) => net.submits.filter(at => at > net.lostAt).every(at => net.checks.some(check => check <= at && at - check < 1));
const advanceTo = async (net: Net, ms: number) => { const left = net.lostAt + ms - performance.now(); if (left > 0) await step(left); };

/** A return from the background while the network is still down ends in «Попробовать ещё раз»; it is pressed at `retryAt`. */
async function retryAt(net: Net, retryAtMs: number) {
  const visibility = vi.spyOn(document, "visibilityState", "get");
  await advanceTo(net, 200); visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  await advanceTo(net, 300); visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  await waitUntil(() => text("Попробовать ещё раз"), "unavailable", 5_000);
  await advanceTo(net, retryAtMs);
  net.offline = false;
  fireEvent.click(screen.getByRole("button", { name: "Попробовать ещё раз" }));
  await step(0);
  return after(net, performance.now());
}

describe("a resend after «Попробовать ещё раз» in the same document", () => {
  beforeEach(() => { vi.useFakeTimers(); hashInPlace(); return () => { vi.useRealTimers(); }; });

  // Send 2 of the answer was lost: the pause before send 3 is RETRY_PAUSES_MS[1].
  const pause = RETRY_PAUSES_MS[1]!;

  it("goes out right after its check when the pause of the lost send has already run out", async () => {
    const net = await loseAnswer(2);
    const clicked = await retryAt(net, pause + 5_000);
    await waitUntil(() => resends(net).length > 0, "resend", 70_000);
    await step(70_000); // a second resend of the same answer would show here
    expect(resends(net)).toHaveLength(1);
    expect(resends(net)[0]).toBeGreaterThanOrEqual(clicked);
    expect(resends(net)[0]).toBeLessThanOrEqual(clicked + 200);
    expect(checkedFirst(net)).toBe(true);
    // The immediate resend lands in the window of the settings race (race_fix): the quiz must go on, not stop at Settings.
    // Which screen follows the accepted resend (its result or the next question) is not asserted here.
    expect(text(settingsRefusalText)).toBe(false);
    expect(text("Попробовать ещё раз")).toBe(false);
  }, 120_000);

  it("waits only the rest of the pause when the retry comes before its end", async () => {
    const net = await loseAnswer(2);
    await retryAt(net, Math.round(pause / 2));
    await waitUntil(() => resends(net).length > 0, "resend", 70_000);
    await step(70_000);
    expect(resends(net)).toHaveLength(1);
    expect(resends(net)[0]).toBeGreaterThanOrEqual(pause);
    expect(resends(net)[0]).toBeLessThanOrEqual(pause + 200);
    expect(checkedFirst(net)).toBe(true);
    expect(text(settingsRefusalText)).toBe(false);
  }, 120_000);
});
