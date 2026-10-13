// A written Stop refused as DOCUMENT_STALE in a window whose document was replaced (D-STALE-WINDOW, C188). The document-level "stopping" does not stay on screen: the App's foreground check (entryController.documentStale)
// is refused too, the window shows «Wortly уже открыт», asks Telegram to close it and sends nothing more; the Stop record stays.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { staleCommand, staleRefusal } from "../app/openRules.test-support";
import { app, startWords, useWrittenAppEnvironment } from "./writtenApp.test-support";
import { response } from "./writtenFixtures.test-support";

useWrittenAppEnvironment();
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });

describe("written Stop + DOCUMENT_STALE in a replaced window (App level)", () => {
  it("the window closes on «Wortly уже открыт»: no buttons, no further request, the Stop record stays", async () => {
    const a = app({ cards: [6, 7] }), close = vi.fn();
    Object.assign((globalThis as unknown as { Telegram: { WebApp: object } }).Telegram.WebApp, { close });
    render(<App />);
    await startWords();
    const base = a.fetcher.getMockImplementation()!;
    a.fetcher.mockImplementation(async (url, init) => {
      const path = new URL(String(url), "http://localhost").pathname, body = init?.body ? JSON.parse(String(init.body)) : null;
      if (path.endsWith("/client/open") && body?.event === "foreground") return response(staleRefusal, 409);
      if (init?.method === "POST" && body?.kind === "session.stop") {
        return response(staleCommand(body.command_id, body.session_id, a.server.state.version, "session.stop"), 409);
      }
      return base(url, init);
    });
    const mark = a.fetcher.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
    await screen.findByRole("heading", { name: "Wortly уже открыт" });
    await settle(); await settle();
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Завершаем занятие…")).toBeNull();
    const after = a.fetcher.mock.calls.slice(mark).map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`);
    expect(after).toEqual(["POST /api/v1/commands", "POST /api/v1/client/open"]);
    expect(JSON.parse(localStorage.getItem("wortly.pending.written_stop")!).intent).toMatchObject({ kind: "session.stop" });
  });
});
