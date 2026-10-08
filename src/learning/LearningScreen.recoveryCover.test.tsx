// A lost grade or correction keeps the blurred cover in Learning: only the shown-question mark goes without it (Q25.2, QA CP2c З2).
import { useEffect, useState } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tick } from "../commands/recoveryTime.test-support";
import { LearningScreen } from "./LearningScreen";
import { learningViewFixture } from "./learningView.test-support";
import { id, missing, response } from "./learningFixtures.test-support";
import type { LearningViewController } from "./learningViewController";

const owners: LearningViewController[] = [];
afterEach(() => { cleanup(); owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });
type Fixture = ReturnType<typeof learningViewFixture>;
function LiveScreen({ f }: { f: Fixture }) {
  const [state, setState] = useState(() => f.view.snapshot());
  useEffect(() => { f.onUpdate.mockImplementation(setState); return () => { f.onUpdate.mockReset(); }; }, [f]);
  return <LearningScreen state={state} language="ru" submitOnEnter={true} actions={f.view}
    renderPreview={preview => <p>{preview.content.card.lemma}</p>} />;
}
const overlay = () => document.querySelector(".recovery-overlay");
/** Drops every request of the named kind (and the reads that would settle it); the rest goes to the synthetic server. */
function dropping(f: Fixture, lost: string) {
  f.fetcher.mockImplementation(async (url, init) => {
    const method = init?.method ?? "GET", kind = method === "POST" ? JSON.parse(String(init!.body)).kind as string : null;
    if (kind === lost || method === "GET" && f.posts().some(post => post.kind === lost)) throw new TypeError("network");
    try { return await f.handler(url, init); } catch (error) {
      const path = new URL(String(url), "http://localhost").pathname;
      if (method !== "GET" || !path.startsWith("/api/v1/commands/")) throw error;
      return response(missing({ command_id: path.split("/").at(-1)!, session_id: id(3) } as never, f.view.snapshot().commands.stateVersion));
    }
  });
}
const run = async (ms: number, step = 1000) => { for (let spent = 0; spent < ms; spent += step) await act(async () => { await tick(step); }); };

describe("Learning screen, a lost change of the result", () => {
  it.each([
    ["result.correct", true, async (f: Fixture) => { await f.view.correct(); }],
    ["result.grade", false, async (f: Fixture) => { await f.view.grade(5); }],
  ] as const)("%s: the screen stays covered while the recovery waits", async (kind, wrong, change) => {
    vi.useFakeTimers();
    const f = learningViewFixture("normal", id(3)); owners.push(f.view);
    if (wrong) f.wrong();
    render(<LiveScreen f={f} />);
    await act(() => f.view.refresh());
    await act(async () => { f.view.setDraft(wrong ? "falsch" : "Haus"); await f.view.submit(); await tick(); });
    dropping(f, kind);
    await act(async () => { await change(f); await tick(); });
    await run(3000);
    expect(f.view.snapshot().commands.primary.pendingIntent?.kind).toBe(kind);
    expect(overlay()).not.toBeNull();
  });
});
