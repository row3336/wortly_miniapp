// Decision 2.3 А with a known send count (S11, C153) through the actual App: page A loses k sends of an answer, then a new
// page B (a new App: new storage wrapper, empty page memory) finds the record. The durable count (CP5b; seeded into B's store
// as IndexedDB would keep it) answers k for X; its read is asserted, so the guard, not an unknown count, keeps B from sending X.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { RecoveryMachine, type RecoverySnapshot } from "../commands/recoveryMachine";
import { hashInPlace, tick } from "../commands/recoveryTime.test-support";
import { testBudgetLog } from "../commands/budget.test-support";
import { app, field, pairText, row, useWrittenAppEnvironment } from "./writtenApp.test-support";

useWrittenAppEnvironment();
const step = (ms = 0) => act(() => tick(ms));
const text = (value: string) => document.body.textContent?.includes(value) ?? false;
async function waitUntil(test: () => boolean, label: string, limitMs = 20_000) {
  for (let spent = 0; spent <= limitMs; spent += 50) { if (test()) return; await step(50); }
  throw new Error(`not reached: ${label}`);
}

/** Page A on «слово 6»: its answer is sent k times, every send is lost, the network stays down after the last one. */
async function pageLoses(k: number) {
  const a = app({ cards: [6, 7] });
  const net = { offline: false, submits: 0 };
  const base = a.fetcher.getMockImplementation()!;
  a.fetcher.mockImplementation(async (url, init) => {
    const path = new URL(String(url), "http://localhost").pathname;
    if (net.offline) throw new TypeError("network");
    if (init?.method === "POST" && path.endsWith("/commands") && JSON.parse(String(init.body)).kind === "answer.submit"
      && ++net.submits <= k) {
      if (net.submits === k) net.offline = true;
      throw new TypeError("network");
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
  await waitUntil(() => net.offline, `loss of send ${k}`, 120_000);
  const x = a.posts().find(post => post.kind === "answer.submit")!.command_id as string;
  return { a, net, x };
}

describe("an answer of another page with a known count", () => {
  beforeEach(() => { vi.useFakeTimers(); hashInPlace(); return () => { vi.useRealTimers(); }; });

  for (const k of [1, 2, 5]) {
    it(`${k} sends counted: page B reads the count, checks X and never sends it`, async () => {
      const { a, net, x } = await pageLoses(k);
      expect(a.posts().filter(post => post.command_id === x)).toHaveLength(k);
      cleanup();
      await step(10_000);
      net.offline = false;
      // Page B: its page memory is empty; the durable store answers what page A spent (k sends, each written retryable).
      testBudgetLog.seeds.set(x.toLowerCase(), { reserved: k, transmitted: k });
      const answered = () => testBudgetLog.loads.filter(entry => entry.commandId === x.toLowerCase() && entry.transmitted === k);
      const states = new Set<string>();
      const snapshot = vi.spyOn(RecoveryMachine.prototype, "snapshot");
      const mark = a.fetcher.mock.calls.length;
      render(<App />);
      for (let spent = 0; spent < 90_000; spent += 500) await step(500);
      for (const result of snapshot.mock.results) if (result.type === "return") states.add((result.value as RecoverySnapshot).state.name);
      const after = a.fetcher.mock.calls.slice(mark);
      expect(answered().length).toBeGreaterThan(0);
      expect(after.filter(([, init]) => init?.method === "POST" && JSON.parse(String(init.body)).command_id === x)).toEqual([]);
      expect(after.filter(([url, init]) => (init?.method ?? "GET") === "GET" && String(url).includes(`/commands/${x}`)).length)
        .toBeGreaterThan(0);
      expect(states.has("origin_elsewhere")).toBe(true);
      expect([...states].filter(name => name === "sending" || name === "retry_wait" || name === "pre_send_check")).toEqual([]);
    }, 240_000);
  }
});
