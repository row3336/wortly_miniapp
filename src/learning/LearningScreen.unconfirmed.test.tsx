// An unreliable count of sends (counter_unknown) in Learning: the cover says 9.2.9 and offers the ordinary voluntary Stop
// 9.2.10 (R10, C093 §6, D-TEXT-DEFECTS 3). The checks go on; nothing is resent and no slot is released.
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Language } from "../i18n/language";
import { LearningScreen } from "./LearningScreen";
import { learningViewFixture } from "./learningView.test-support";
import { current, deferred, id, missing, original, pending, primaryKey, response } from "./learningFixtures.test-support";
import type { LearningViewController } from "./learningViewController";
import { seedRaw } from "../commands/pendingSeed.test-support";

const owners: LearningViewController[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
type Fixture = ReturnType<typeof learningViewFixture>;
function LiveScreen({ f, language }: { f: Fixture; language: Language }) {
  const [state, setState] = useState(() => f.view.snapshot());
  useEffect(() => { f.onUpdate.mockImplementation(setState); return () => { f.onUpdate.mockReset(); }; }, [f]);
  return <LearningScreen state={state} language={language} submitOnEnter={true} actions={f.view} renderPreview={() => null} />;
}
const overlay = () => document.querySelector(".recovery-overlay");
const endButton = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

/** A reload with a saved answer whose receipt is missing: the count is unknown, only checks remain (CT §6.1 п. 4). */
async function reloaded(language: Language = "ru", routeStop?: (call: Parameters<typeof fetch>) => Promise<Response> | undefined) {
  const f = learningViewFixture(); owners.push(f.view); const intent = original();
  seedRaw(f.values, primaryKey, JSON.stringify(pending(intent)), id(50));
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "GET" && String(url).includes(`/commands/${intent.command_id}`)) return response(missing(intent, "1"));
    return routeStop?.([url, init]) ?? f.handler(url, init);
  });
  render(<LiveScreen f={f} language={language} />); await act(() => f.view.refresh());
  await waitFor(() => expect(f.view.snapshot().commands.recovery?.state.name).toBe("counter_unknown"));
  return f;
}
const isStop = (call: Parameters<typeof fetch>) => call[1]?.method === "POST" && JSON.parse(String(call[1].body)).kind === "session.stop";

describe("Learning, an unknown count of sends", () => {
  it.each([
    ["uk", "Не вдалося підтвердити останню дію. Ми продовжуємо перевіряти. Можна завершити заняття.", "Завершити заняття"],
    ["en", "We couldn't confirm your last action. We keep checking. You can end the session.", "End session"],
  ] as const)("%s: the catalog text and button, no resend or manual check", async (language, text, button) => {
    const f = await reloaded(language);
    expect(overlay()?.querySelector("p")?.textContent).toBe(text);
    expect(Array.from(overlay()!.querySelectorAll("button")).map(item => item.textContent)).toEqual([button]);
    expect(f.posts()).toEqual([]);
  });
  it("the button is the ordinary Stop: one session.stop with reason stop, off while it is sent, the cover stays until the server confirms", async () => {
    const gate = deferred<Response>();
    const f = await reloaded("ru", call => isStop(call) ? gate.promise : undefined);
    expect(endButton("Завершить занятие").disabled).toBe(false);
    fireEvent.click(endButton("Завершить занятие"));
    await waitFor(() => expect(f.posts().map(post => post.kind)).toEqual(["session.stop"]));
    expect(f.posts()[0].payload).toEqual({ reason: "stop" });
    expect(f.view.snapshot().phase).not.toBe("closed");
    expect(endButton("Завершить занятие").disabled).toBe(true);
    fireEvent.click(endButton("Завершить занятие"));
    expect(f.posts()).toHaveLength(1);
    expect(overlay()?.textContent).toContain("Не удалось подтвердить последнее действие.");
    await act(async () => { gate.resolve(await f.handler(...(f.fetcher.mock.calls.filter(isStop).at(-1)!))); });
    await waitFor(() => expect(f.view.snapshot().phase).toBe("closed"));
    expect(overlay()).toBeNull();
    expect(f.posts().map(post => post.kind)).toEqual(["session.stop"]);
  });
  it("a Stop whose reply is lost does not show the closure: the cover 9.2.9 stays", async () => {
    const f = await reloaded("ru", call => { if (isStop(call)) throw new TypeError("network"); return undefined; });
    fireEvent.click(endButton("Завершить занятие"));
    await waitFor(() => expect(f.posts().map(post => post.kind)).toEqual(["session.stop"]));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(f.view.snapshot().phase).not.toBe("closed");
    expect(overlay()?.textContent).toContain("Не удалось подтвердить последнее действие.");
  });
  it("the wait for the card to show stays uncovered (Q25.2): no cover and no 9.2.10 on it", async () => {
    const f = learningViewFixture(); owners.push(f.view);
    const intent = { command_id: id(100), session_id: id(3), kind: "assignment.present" as const, assignment_id: id(6), payload: {} };
    seedRaw(f.values, primaryKey, JSON.stringify(pending(intent)), id(50));
    f.setStep({ ...current(), assignment: { ...current().assignment!, status: "prefetched" as const } });
    f.fetcher.mockImplementation(async (url, init) => init?.method === "GET" && String(url).includes(`/commands/${intent.command_id}`)
      ? response(missing(intent, "1")) : f.handler(url, init));
    render(<LiveScreen f={f} language="ru" />); await act(() => f.view.refresh());
    await waitFor(() => expect(f.view.snapshot().commands.recovery?.state.name).toBe("counter_unknown"));
    expect(overlay()).toBeNull();
    expect(screen.queryByRole("button", { name: "Завершить занятие" })).toBeNull();
  });
});
