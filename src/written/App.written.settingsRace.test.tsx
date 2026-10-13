import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/App";
import { app, exchange, field, settingsRefusalText, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";

// A fresh document of an open written session reads Settings and the session separately. Another write of the profile
// (another window's open, any accepted command, calendar maintenance) can land between those reads.
describe("App: a profile write between the Settings read and the session read of a new document", () => {
  useWrittenAppEnvironment();

  it("re-reads Settings and keeps the resumed question answerable, without the settings refusal", async () => {
    const a = app({ cards: [6, 7] });
    render(<App />);
    await startWords();
    cleanup();
    const base = a.fetcher.getMockImplementation()!;
    let bumped = false, settingsReads = 0;
    a.fetcher.mockImplementation(async (url, init) => {
      const reply = await base(url, init);
      if ((init?.method ?? "GET") === "GET" && new URL(String(url), "http://localhost").pathname.endsWith("/settings")) {
        settingsReads++;
        if (!bumped) { bumped = true; a.server.state.version += 1; }
      }
      return reply;
    });
    render(<App />);
    await screen.findByText("слово 6", undefined, exchange);
    await waitFor(() => expect(field().readOnly).toBe(false), exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(bumped).toBe(true);
    expect(settingsReads).toBeGreaterThanOrEqual(2);
    expect(field().readOnly).toBe(false);
    expect(screen.queryByText(settingsRefusalText)).toBeNull();
  });
});
