// The own start of this window lost before the server, checked and sent again by hand with the same ID (C246).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/App";
import { commandPosts, foregroundOpen, pairMoved } from "../app/pairMoved.test-support";
import { app, dropRequest, exchange, field, pairText, row, useWrittenAppEnvironment } from "./writtenApp.test-support";

useWrittenAppEnvironment();

const settle = (ms = 100) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

/** The server applies the next POST of this kind at once, but its reply waits for release(). */
function holdReply(a: ReturnType<typeof app>, kind: string) {
  const base = a.fetcher.getMockImplementation()!;
  const gate = { held: false, release: () => {} };
  const open = new Promise<void>(resolve => { gate.release = resolve; });
  let taken = false;
  a.fetcher.mockImplementation(async (url, init) => {
    if (taken || init?.method !== "POST" || JSON.parse(String(init.body)).kind !== kind) return base(url, init);
    taken = true; const reply = await base(url, init); gate.held = true; await open; return reply;
  });
  return gate;
}

/** Starts words with the start POST lost before the server, checks it and returns the lost start. */
async function lostStartChecked(a: ReturnType<typeof app>, entered = () => {}) {
  await screen.findByText(pairText, undefined, exchange);
  entered();
  await waitFor(() => expect(row(/Слова: перевод на немецкий/).disabled).toBe(false), exchange);
  dropRequest(a, "session.start");
  fireEvent.click(row(/Слова: перевод на немецкий/));
  await screen.findByRole("button", { name: "Проверить состояние" }, exchange);
  const lost = a.posts().at(-1)!;
  expect(lost.kind).toBe("session.start");
  fireEvent.click(button("Проверить состояние"));
  await screen.findByRole("button", { name: "Повторить отправку" }, exchange);
  await waitFor(() => expect(button("Повторить отправку").disabled).toBe(false), exchange);
  return lost;
}

describe("Written own start retried by hand after its loss (C246)", () => {
  it("the one retry of the same command and session, confirmed by the server, shows and presents its question", async () => {
    const a = app({ cards: [6, 7] }); render(<App />);
    const lost = await lostStartChecked(a);
    expect(a.server.state.sessionId).toBeNull();
    fireEvent.click(button("Повторить отправку"));
    // The server confirmed this very session (one more POST of the same command); the view then follows it.
    await waitFor(() => expect(a.server.state.sessionId).toBe(lost.session_id), exchange);
    await screen.findByText("слово 6", undefined, exchange);
    await waitFor(() => expect(field().readOnly).toBe(false), exchange);
    expect(a.posts().map(post => [post.kind, post.command_id, post.session_id]))
      .toEqual([["session.start", lost.command_id, lost.session_id], ["session.start", lost.command_id, lost.session_id],
        ["assignment.present", expect.any(String), lost.session_id]]);
    expect(a.server.state.sessionId).toBe(lost.session_id);
    expect(a.server.state.assignment).toBe("presented");
    expect(screen.queryByText("Проверяем, сохранилось ли действие.")).toBeNull();
  });

  it("Stop tapped while the reply of that retry waits: the closure stands, no present, no question", async () => {
    const a = app({ cards: [6, 7] }); render(<App />);
    const gate = holdReply(a, "session.start");
    const lost = await lostStartChecked(a);
    fireEvent.click(button("Повторить отправку"));
    // The server applied the retry; its reply has not come back yet, and the screen still waits for the outcome.
    await waitFor(() => expect(gate.held).toBe(true), exchange);
    await settle();
    expect(screen.getByText("Проверяем, сохранилось ли действие.")).toBeTruthy();
    expect(button("Выйти").disabled).toBe(false);
    fireEvent.click(button("Выйти"));
    await screen.findByText("Занятие прервано.", undefined, exchange);
    gate.release();
    await settle(1500);
    expect(a.posts().map(post => [post.kind, post.session_id])).toEqual([["session.start", lost.session_id],
      ["session.start", lost.session_id], ["session.stop", lost.session_id]]);
    expect(a.server.state.status).toBe("closed");
    expect(screen.getByText("Занятие прервано.")).toBeTruthy();
    expect(screen.queryByText("слово 6")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("Stop pending when the accepted reply of that retry arrives: Exit waits for Stop, no question, no present", async () => {
    const a = app({ cards: [6, 7] }); render(<App />);
    const start = holdReply(a, "session.start");
    const lost = await lostStartChecked(a);
    fireEvent.click(button("Повторить отправку"));
    await waitFor(() => expect(start.held).toBe(true), exchange);
    const stop = holdReply(a, "session.stop");
    fireEvent.click(button("Выйти"));
    await waitFor(() => expect(stop.held).toBe(true), exchange);
    start.release();
    await settle(1500);
    expect(screen.queryByText("слово 6")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(a.posts().map(post => post.kind)).toEqual(["session.start", "session.start", "session.stop"]);
    stop.release();
    await screen.findByText("Занятие прервано.", undefined, exchange);
    await settle(500);
    expect(a.posts().map(post => [post.kind, post.session_id])).toEqual([["session.start", lost.session_id],
      ["session.start", lost.session_id], ["session.stop", lost.session_id]]);
    expect(screen.queryByText("слово 6")).toBeNull();
  });

  it("R1: the retry accepted in another pair shows nothing before this window gets that pair (17.1-А)", async () => {
    const a = app({ cards: [6, 7] }); const world = pairMoved(a.fetcher);
    render(<App />);
    const lost = await lostStartChecked(a, () => { world.moved = true; });
    const opens = world.opens.length, open = foregroundOpen(a.fetcher, "hold");
    fireEvent.click(button("Повторить отправку"));
    await waitFor(() => expect(open.attempts).toBe(1), exchange);
    await settle(1500);
    // Accepted in uk-de; the refresh of this window has not answered: no question, no present.
    expect(world.started).toBe(lost.session_id);
    expect(commandPosts(a.fetcher).map(post => post.kind)).toEqual(["session.start", "session.start"]);
    expect(screen.queryByText("слово 6")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    open.release();
    expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    expect(commandPosts(a.fetcher).map(post => [post.kind, post.session_id])).toEqual([["session.start", lost.session_id],
      ["session.start", lost.session_id], ["assignment.present", lost.session_id]]);
  });

  // Unmount and render again of the same App in this test process: a new storage wrapper, i.e. a new owner of the
  // existing implementation over the same stored record. It is not a proven new JS document (no new page load), and it
  // changes no product contract; it only pins that this owner keeps the inherited start's existing path.
  it("a remounted App (new storage wrapper, new owner) that inherited the lost start only checks it: no manual send, no question (its path is unchanged)", async () => {
    const a = app({ cards: [6, 7] }); const first = render(<App />);
    const lost = await lostStartChecked(a);
    first.unmount();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Проверить состояние" }, exchange));
    await settle(2000);
    expect(screen.queryByRole("button", { name: "Повторить отправку" })).toBeNull();
    expect(screen.getByText("Проверяем, сохранилось ли действие.")).toBeTruthy();
    expect(a.posts().map(post => post.command_id)).toEqual([lost.command_id]);
    expect(a.server.state.sessionId).toBeNull();
  }, 20_000);
});
