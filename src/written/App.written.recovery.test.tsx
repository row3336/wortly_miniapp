// Automatic recovery of the written quiz through the actual App document (M-RECOV-AUTO CP2a, QA Н1): it belongs to a
// visible window with a live document (Я15.7, RESULTS_VP 9.1.5), not to confirmed settings or the study route.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { app, exchange, field, requests, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";
import { response } from "./writtenFixtures.test-support";

useWrittenAppEnvironment();
const pause = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

describe("a return whose settings read fails", () => {
  it.each(["settings_ok", "settings_fail"] as const)("%s: the lost answer is checked and sent again after the return", async variant => {
    const a = app({ cards: [6, 7] }); render(<App />);
    await startWords();
    const base = a.fetcher.getMockImplementation()!;
    let offline = true, settingsFail = false;
    a.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname, method = init?.method ?? "GET";
      if (settingsFail && method === "GET" && path.endsWith("/settings")) return response({ error: { code: "INTERNAL" } }, 500);
      if (offline && method === "POST" && path.endsWith("/commands") && JSON.parse(String(init!.body)).kind === "answer.submit") throw new TypeError("network");
      if (offline && method === "GET" && (path.includes("/commands/") || path.includes("/sessions/"))) throw new TypeError("network");
      return base(url, init);
    });
    fireEvent.change(field(), { target: { value: "Haus" } });
    fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
    await waitFor(() => expect(document.querySelector(".recovery-overlay")?.textContent).toContain("Нет связи"), exchange);
    const visible = vi.spyOn(document, "visibilityState", "get");
    visible.mockReturnValue("hidden"); fireEvent(document, new Event("visibilitychange"));
    await pause(300);
    // The connection is back; in settings_fail the Settings read of the return fails (the quiz stays without settings).
    offline = false; settingsFail = variant === "settings_fail";
    const mark = a.fetcher.mock.calls.length;
    visible.mockReturnValue("visible"); fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("Верно", undefined, { timeout: 10_000 });
    const after = requests(a, mark);
    expect(after.some(entry => entry.startsWith("GET /api/v1/commands/"))).toBe(true);
    expect(a.posts().filter(post => post.kind === "answer.submit")).toHaveLength(2);
    expect(document.querySelector(".recovery-overlay")).toBeNull();
  }, 30_000);
});
