// Н2 in the written quiz (M-RECOV-AUTO CP4a-1, D-CP4 3.1.1; QA CP4a-1 Ф1, probes Q-W1 and Q-W2): a full-body conflict on
// the answer, with or without a stored conflict mark, is cleared after the confirmed «Выйти». Real document owner over
// the synthetic written server, on fake time.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWrittenDocument } from "./useWrittenDocument";
import { WrittenScreen } from "./WrittenScreen";
import { id, tick, writtenFixture } from "./writtenFixtures.test-support";
import { pendingRaw, hasPending, pointerKeyOf } from "../commands/pendingSeed.test-support";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const record = "wortly.pending.written_session";

/** The document snapshot the screen last rendered. */
const seen: { state: ReturnType<typeof useWrittenDocument>["state"] } = { state: null };

async function conflictSetup(markFails: boolean) {
  vi.useFakeTimers();
  const f = writtenFixture();
  let planted = false;
  f.fetcher.mockImplementation(async (url, init) => {
    if (init?.method === "POST" && !planted) {
      const body = JSON.parse(String(init.body));
      if (body.kind === "answer.submit") {
        // Another payload already holds this command_id on the server: the real POST meets a full-body 409 conflict.
        planted = true;
        await f.server.handle(url as RequestInfo, { ...init, body: JSON.stringify({ ...body, payload: { text: "Andere" } }) });
      }
    }
    return f.server.handle(url as RequestInfo, init);
  });
  if (markFails) {
    const set = vi.mocked(f.storage.set), base = set.getMockImplementation()!;
    set.mockImplementation(async (key, value) => {
      // The conflict mark is a field of this profile's pointer record (profile addressing).
      if (key === pointerKeyOf(record, id(50)) && JSON.parse(value).record?.mismatch) throw new Error("io");
      return base(key, value);
    });
  }
  function Harness() {
    const { state, actions } = useWrittenDocument({ access: f.access(), storage: f.storage, transport: f.transport, newId: f.newId,
      transitionMode: "normal" });
    seen.state = state;
    if (!state) return null;
    return <>
      <button type="button" onClick={() => { void actions.start("words"); }}>start-words</button>
      <WrittenScreen state={state} language="ru" submitOnEnter actions={actions} onToday={vi.fn()} />
    </>;
  }
  render(<Harness />);
  const step = (ms = 0) => act(() => tick(ms));
  await step();
  fireEvent.click(screen.getByRole("button", { name: "start-words" })); await step();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" })); await step(); await step();
  return { f, step };
}

for (const markFails of [false, true]) {
  it(`a full-body conflict${markFails ? " whose mark could not be stored" : ""} is cleared after the confirmed «Выйти» (QA Q-W${markFails ? 2 : 1})`, async () => {
    const { f, step } = await conflictSetup(markFails);
    await step(10_000);
    expect(JSON.parse(pendingRaw(f.values, record)!).mismatch).toBe(markFails ? undefined : true);
    fireEvent.click(screen.getByRole("button", { name: "Выйти" })); await step(); await step(1000); await step(35_000);
    expect(f.posts().map(post => post.kind)).toContain("session.stop");
    expect(hasPending(f.values, record)).toBe(false);
    expect(f.posts().filter(post => post.kind === "answer.submit")).toHaveLength(1);
    // Nothing is left to recover: no machine holds the lanes, and a new quiz can start (QA CP4a-1 Д1).
    expect({ recovery: seen.state?.commands.recovery ?? null, canBegin: seen.state?.commands.canBegin })
      .toEqual({ recovery: null, canBegin: true });
    fireEvent.click(screen.getByRole("button", { name: "start-words" })); await step();
    expect(f.posts().map(post => post.kind).filter(kind => kind === "session.start")).toHaveLength(2);
  });
}
