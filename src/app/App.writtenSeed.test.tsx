// Gaps found by the independent QA of M-WCORR CP2 (M9, M11): what the resumed written session adds to the document.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { answer, app, field, startWords, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { response } from "../written/writtenFixtures.test-support";

useWrittenAppEnvironment();

type Served = Record<string, any>;
/** Lets a test edit the JSON of the entry, Settings and session replies; `nth` counts replies of the same «METHOD path». */
function edit(a: ReturnType<typeof app>, change: (key: string, nth: number, body: Served) => void) {
  const base = a.fetcher.getMockImplementation()!;
  const count = new Map<string, number>();
  a.fetcher.mockImplementation(async (url, init) => {
    const reply = await base(url, init);
    const key = `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname.replace(/\/[0-9a-f-]{36}$/, "/:id")}`;
    if (!/(auth\/telegram|client\/open|\/settings|\/sessions\/:id)$/.test(key)) return reply;
    const nth = (count.get(key) ?? 0) + 1; count.set(key, nth);
    const body = await reply.json() as Served;
    change(key, nth, body);
    return response(body, reply.status);
  });
}
const sessionReads = (a: ReturnType<typeof app>, session: string) => a.fetcher.mock.calls
  .filter(([url, init]) => (init?.method ?? "GET") === "GET" && String(url).includes(`/sessions/${session}`)).length;
async function relaunchable() {
  const a = app({ cards: [6, 7, 8] }); const first = render(<App />);
  await startWords(); await answer("falsch");
  first.unmount();
  return a;
}
const pause = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });

describe("resumed written session in the application document", () => {
  it("M9 the written owner never accepts its own read older than the version that resumed the session", async () => {
    const a = await relaunchable();
    const resumed = a.server.state.version;
    // The profile and Settings are older than the session read, so only the resume version can refuse the stale read.
    // Replies: 1 resume read, 2 the read after Settings arrived, 3 the owner's own read, here older than the resume read.
    edit(a, (key, nth, body) => {
      if (/(auth\/telegram|client\/open|\/settings)$/.test(key)) body.state_version = String(resumed - 3);
      if (body.profile) body.profile.state_version = String(resumed - 3);
      if (key === "GET /api/v1/sessions/:id" && nth >= 3) body.state_version = String(resumed - 1);
    });
    render(<App />);
    await screen.findByRole("button", { name: "Проверить состояние" });
    // The stale projection is refused, not drawn.
    expect(screen.queryByText("слово 7")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("M11 a pair round-trip never adopts the closed written seed again", async () => {
    const a = await relaunchable();
    const session = a.server.state.sessionId!, pair = { value: "ru" };
    edit(a, (_key, _nth, body) => {
      if (body.profile) body.profile.dictionary_language = pair.value;
      if (body.settings) body.settings.dictionary_language.value = pair.value;
    });
    render(<App />);
    await screen.findByText("слово 7"); await waitFor(() => expect(field().readOnly).toBe(false));
    // The core closes the session of a pair left (pair_changed); the foreground open reports the new pair.
    pair.value = "en"; a.server.state.status = "closed";
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("Сегодня"); await pause(300);
    const reads = sessionReads(a, session), opens = a.openReply.mock.calls.length;
    pair.value = "ru";
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(a.openReply.mock.calls.length).toBeGreaterThan(opens)); await pause(300);
    expect(sessionReads(a, session)).toBe(reads);
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
