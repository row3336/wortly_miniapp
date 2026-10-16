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

type Net = { offline: boolean; lostAt: number; submits: number[]; checks: number[]; recoveredAt: number };

/** The written quiz on «слово 6»; the answer is sent `lost` times and every send is lost, the last one with the network. */
async function loseAnswer(lost: number) {
  const a = app({ cards: [6, 7] });
  const net: Net = { offline: false, lostAt: -1, submits: [], checks: [], recoveredAt: -1 };
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname, method = init?.method ?? "GET";
    if (net.offline) throw new TypeError("network");
    if (method === "GET" && path.includes("/commands/")) net.checks.push(performance.now());
    // The confirmed recovery foreground after the network is back (К-11 ВР-5 → ВР-6): the moment the resend may follow.
    if (net.lostAt >= 0 && net.recoveredAt < 0 && path.endsWith("/client/open") && JSON.parse(String(init?.body ?? "{}")).event === "foreground") {
      const reply = await base(url, init);
      if (reply.ok) net.recoveredAt = performance.now();
      return reply;
    }
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

/**
 * A return from the background while the network is still down. P03 M-P03-10 (К-11 ВР-1, AC-11 (в)): the working window
 * keeps its screen in recovery — the status 9.2.2, no «Попробовать ещё раз»; the network comes back at `retryAt`, and the
 * gate's next ready brings the one foreground of the same document (ВР-5), then the check by ID and the resend (I5).
 */
async function retryAt(net: Net, retryAtMs: number) {
  const visibility = vi.spyOn(document, "visibilityState", "get");
  await advanceTo(net, 200); visibility.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
  await advanceTo(net, 300); visibility.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
  await waitUntil(() => text("Нет связи с сервером"), "recovering", 5_000);
  expect(text("Попробовать ещё раз")).toBe(false);
  await advanceTo(net, retryAtMs);
  net.offline = false;
  await step(0);
  return after(net, performance.now());
}

describe("a resend after the recovery of the same document (P03 К-11; before M-P03-10: «Попробовать ещё раз»)", () => {
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
    // The pause of the lost send has run out: the resend goes right after the identity is confirmed again (its check by
    // ID first), never after a new full pause — measured from the recovery, since the recovery itself waits for ready.
    expect(net.recoveredAt).toBeGreaterThan(0);
    expect(resends(net)[0]).toBeLessThanOrEqual(after(net, net.recoveredAt) + 200);
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
