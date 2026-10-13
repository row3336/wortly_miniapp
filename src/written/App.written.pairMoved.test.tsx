// Answer 17.1-А / 17.2-А (R1): this window still shows ru-de, the pair moved to uk on another device, and the start
// tapped here made the session in uk-de. The window refreshes its access by itself (one client/open) and goes into that
// session; Stop of it is never sent from the old screen.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../app/App";
import { commandPosts, enabledExits, foregroundOpen, loseReply, moveWithout, noLandings, pairMoved, settle,
  watchCommits } from "../app/pairMoved.test-support";
import { app, exchange, pairText, row, useWrittenAppEnvironment } from "./writtenApp.test-support";

/**
 * Contract probe of the seam between a mode host and the document (QA-R1-V3 F1, C226): when `repeat` is set, the written
 * host reports its foreign start a second time after the refresh has answered. No path of the real App is known to repeat
 * that report; this only pins the document's own promise of one refresh per session. Transparent when `repeat` is false.
 */
const report = vi.hoisted(() => ({ repeat: false }));
vi.mock("./useWrittenHost", async importOriginal => {
  const original = await importOriginal<typeof import("./useWrittenHost")>();
  return { ...original, useWrittenHost: (options: Parameters<typeof original.useWrittenHost>[0]) => original.useWrittenHost(
    report.repeat && options.onForeignStart ? { ...options, onForeignStart: (sessionId: string) => {
      options.onForeignStart!(sessionId); setTimeout(() => options.onForeignStart!(sessionId), 800);
    } } : options) };
});

useWrittenAppEnvironment();

const words = /Слова: перевод на немецкий/;
async function ready(strict = false, low = false) {
  const a = app({ cards: [6, 7] }); const world = pairMoved(a.fetcher); world.low = low;
  render(strict ? <StrictMode><App /></StrictMode> : <App />);
  await screen.findByText(pairText, undefined, exchange);
  await waitFor(() => expect(row(words).disabled).toBe(false), exchange);
  return { a, world, opens: world.opens.length, mark: a.fetcher.mock.calls.length };
}
/** The question of the uk session is on screen, answerable, and its Stop addresses that session. */
async function inSession(a: ReturnType<typeof app>, started: string) {
  expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
  const mark = a.fetcher.mock.calls.length;
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Haus" } });
  fireEvent.click(screen.getByRole("button", { name: "Проверить" }));
  await screen.findByText("Верно", undefined, exchange);
  fireEvent.click(screen.getByRole("button", { name: "Выйти" }));
  await screen.findByText("Итог занятия", undefined, exchange);
  expect(commandPosts(a.fetcher, mark).map(post => [post.kind, post.session_id])).toEqual([
    ["answer.submit", started], ["session.stop", started]]);
}

describe("written R1: the window refreshes itself into the session of the new pair (17.1-А)", () => {
  it.each([false, true])("direct reply (StrictMode %s): one client/open, no other start, no Stop", async strict => {
    const { a, world, opens, mark } = await ready(strict);
    // C149/C151 (guard v3): the known pair change of the confirmed start is no failed update, so no failure text is shown.
    const failure = watchCommits(["Не удалось обновить занятие", "Не вдалося оновити заняття"]);
    try {
      world.moved = true;
      fireEvent.click(row(words));
      expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
      await settle(1000);
    } finally { failure.stop(); }
    expect(failure.seen).toEqual([]);
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    expect(commandPosts(a.fetcher, mark).map(post => post.kind)).toEqual(["session.start", "assignment.present"]);
    await inSession(a, world.started!);
  });

  it("lost reply: nothing refreshes while the start is unknown and Stop stays; its check confirms it, then the refresh", async () => {
    const { a, world, opens } = await ready();
    world.moved = true; loseReply(a.fetcher, "session.start");
    fireEvent.click(row(words));
    await screen.findByRole("button", { name: "Проверить состояние" }, exchange);
    await settle(1500);
    expect(world.opens.slice(opens)).toEqual([]);
    // An unknown start is no confirmed session of another pair: its Stop is as before (17.2-А is not a general ban).
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" }));
    expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    await inSession(a, world.started!);
  });

  it("before the refresh answers, the old screen sends no Stop and asks no second open (17.2-А)", async () => {
    const { a, world, opens, mark } = await ready();
    world.moved = true; const open = foregroundOpen(a.fetcher, "hold");
    fireEvent.click(row(words));
    await screen.findByRole("button", { name: "Проверить состояние" }, exchange);
    await settle(500);
    const stop = screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement;
    expect(stop.disabled).toBe(true);
    fireEvent.click(stop);
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" }));
    await settle(1500);
    expect(commandPosts(a.fetcher, mark).map(post => post.kind)).toEqual(["session.start"]);
    expect(open.attempts).toBe(1);
    open.release();
    expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    await inSession(a, world.started!);
  });

  it("a failed refresh is not repeated by itself; the manual retry goes into the session", async () => {
    const { a, world, mark } = await ready();
    world.moved = true; const open = foregroundOpen(a.fetcher, "fail");
    fireEvent.click(row(words));
    const retry = await screen.findByRole("button", { name: "Попробовать ещё раз" }, exchange);
    await settle(4000);
    expect(open.attempts).toBe(1);
    expect(commandPosts(a.fetcher, mark).map(post => post.kind)).toEqual(["session.start"]);
    fireEvent.click(retry);
    await inSession(a, world.started!);
  });

  it("a refresh that still names the old pair is not asked again by later checks, and Stop keeps waiting", async () => {
    const { a, world, opens, mark } = await ready();
    world.moved = true; world.openOld = true;
    fireEvent.click(row(words));
    const check = await screen.findByRole("button", { name: "Проверить состояние" }, exchange);
    await settle(1500);
    fireEvent.click(check); await settle(1500);
    fireEvent.click(screen.getByRole("button", { name: "Проверить состояние" })); await settle(1500);
    expect(world.opens.slice(opens)).toEqual(["foreground"]);
    expect((screen.getByRole("button", { name: "Выйти" }) as HTMLButtonElement).disabled).toBe(true);
    expect(commandPosts(a.fetcher, mark).map(post => post.kind)).toEqual(["session.start"]);
  });

  // C151 forks: a reply below the floor, a reply naming another session, and a refresh that finds the created session
  // closed, another session open or the pair changed again. None is this start's R1 landing: no refresh into it, no new
  // start, no Stop of any session, and the session is never shown. The refresh asks once; the second open after it is the
  // new owner's existing return to Today (idle → onToday → synchronize).
  it.each(noLandings)("no landing (%s): no second start, no Stop, the created session is not shown", async kind => {
    const { a, world, opens, mark } = await ready(false, kind === "low");
    moveWithout(world, kind);
    fireEvent.click(row(words));
    await settle(3000);
    expect(world.opens.slice(opens)).toEqual(kind === "low" || kind === "foreign" ? [] : ["foreground", "foreground"]);
    expect(commandPosts(a.fetcher, mark).map(post => post.kind)).toEqual(["session.start"]);
    expect(screen.queryByText("слово 6")).toBeNull();
    // A reply that proves nothing leaves the start unknown, and its Stop stays as before (17.2-А is not a general ban).
    if (kind !== "low" && kind !== "foreign") expect(enabledExits()).toEqual([]);
  });

  // CONTRACT (QA-R1-V3 F1, C226), not a reachable scenario: the hosts report a foreign start from an effect on its value
  // (useWrittenHost.tsx:181, LearningHost.tsx:138, OralHost.tsx:172, ConjugationHost.tsx:166), and a repeat of that
  // report in the real App is not shown (nor proved impossible). The test feeds a repeat through the mocked seam and pins
  // the document's contract (ApplicationDocument refreshForStart): one client/open per session, whatever a host reports.
  it("contract: a repeated host report of the same session after its refresh asks no second client/open", async () => {
    report.repeat = true;
    try {
      const { a, world, opens } = await ready();
      world.moved = true;
      fireEvent.click(row(words));
      expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
      await settle(2000);
      expect(world.opens.slice(opens)).toEqual(["foreground"]);
      await inSession(a, world.started!);
    } finally { report.repeat = false; }
  });

  it("a start in the window's own pair refreshes nothing", async () => {
    const { a, world, opens } = await ready();
    fireEvent.click(row(words));
    expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
    await settle(1500);
    expect(world.opens.slice(opens)).toEqual([]);
    await inSession(a, world.started!);
  });

  // 2.3-А, automatic kind (QA-R1-V3 F6): X of the new pair in the Learning slot, addressed to another session Z. On the
  // written route the Learning owner of the new pair drives no recovery; X is checked by its ID and never sent.
  it("2.3А: an old automatic record X in the Learning slot is never sent by the refreshed owners", async () => {
    const { a, world, mark } = await ready();
    const key = Object.keys(localStorage).find(name => name.startsWith("wortly.installation:"))!;
    const installation = JSON.parse(localStorage.getItem(key)!) as { profileId: string; clientInstanceId: string };
    const X = "7a1b2c3d-0000-4000-8000-00000000cc01";
    world.moved = true;
    fireEvent.click(row(words));
    localStorage.setItem("wortly.pending.learning_session", JSON.stringify({ schemaVersion: 1, profileId: installation.profileId,
      clientInstanceId: installation.clientInstanceId, pair: "uk-de", intent: { command_id: X, session_id: "7a1b2c3d-0000-4000-8000-00000000cc02",
        kind: "answer.submit", assignment_id: "7a1b2c3d-0000-4000-8000-00000000cc03", payload: { text: "Haus" } } }));
    expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
    await settle(3000);
    const onX = a.fetcher.mock.calls.slice(mark).filter(([url, init]) => String(url).includes(X) || String(init?.body ?? "").includes(X))
      .map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`);
    expect(onX.length).toBeGreaterThan(0);
    expect(new Set(onX)).toEqual(new Set([`GET /api/v1/commands/${X}`]));
    expect(localStorage.getItem("wortly.pending.learning_session")).toContain(X);
  });

  it("2.3А: an old record X of another window is only checked, never sent, by the refreshed owners", async () => {
    const { a, world, mark } = await ready();
    const key = Object.keys(localStorage).find(name => name.startsWith("wortly.installation:"))!;
    const installation = JSON.parse(localStorage.getItem(key)!) as { profileId: string; clientInstanceId: string };
    const X = "7a1b2c3d-0000-4000-8000-00000000aa01";
    world.moved = true;
    fireEvent.click(row(words));
    localStorage.setItem("wortly.pending.oral_session", JSON.stringify({ schemaVersion: 1, profileId: installation.profileId,
      clientInstanceId: installation.clientInstanceId, pair: "uk-de", intent: { command_id: X,
        session_id: "7a1b2c3d-0000-4000-8000-00000000aa02", kind: "oral.reveal",
        assignment_id: "7a1b2c3d-0000-4000-8000-00000000aa03", payload: {} } }));
    expect(await screen.findByText("слово 6", undefined, exchange)).toBeTruthy();
    await settle(3000);
    expect(commandPosts(a.fetcher, mark).filter(post => post.command_id === X)).toEqual([]);
    // The refreshed owners only check X by its ID (a read, never its POST).
    const reads = a.fetcher.mock.calls.slice(mark).filter(([url]) => String(url).includes(X))
      .map(([url, init]) => `${init?.method ?? "GET"} ${new URL(String(url), "http://localhost").pathname}`);
    expect(reads.length).toBeGreaterThan(0);
    expect(new Set(reads)).toEqual(new Set([`GET /api/v1/commands/${X}`]));
    expect(localStorage.getItem("wortly.pending.oral_session")).toContain(X);
  });
});
