// Decision 2.3 А for the manual written start through the real App (QA-FINAL Q1, C244/C245): a start record this page
// never created — another window of this installation left it in the device slot — is only checked by its ID; its
// explicit retry is never offered and its POST never sent. Control: the start this mount lost keeps its explicit retry
// after the check, so the absence above is not that of any retry. Which document lifetimes count as one page (a remount
// of App with a new storage wrapper) is not decided here: those are boundaries of the implementation, not of 2.3 А.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../app/App";
import { activeButton } from "../app/gateButton.test-support";
import { app, dropRequest, exchange, pairText, requests, row, useWrittenAppEnvironment } from "./writtenApp.test-support";
import { id } from "./writtenFixtures.test-support";
import { writtenPrimaryKey } from "./writtenPending";

useWrittenAppEnvironment();
const words = /Слова: перевод на немецкий/;
const RETRY = "Повторить отправку", CHECK = "Проверить состояние";
const pause = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
const startPosts = (a: ReturnType<typeof app>) => a.posts().filter(post => post.kind === "session.start").map(post => post.command_id as string);

describe("written 2.3 А: the start record of another window is only checked", () => {
  it("control: a start this mount lost offers its explicit retry after the check; the retry sends the same ID once more", async () => {
    const a = app({ cards: [6, 7] });
    render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    await waitFor(() => expect(row(words).disabled).toBe(false), exchange);
    dropRequest(a, "session.start");
    fireEvent.click(row(words));
    // P03 C335: the controls wait for the write gate after the loss; the user presses them once they are active.
    fireEvent.click(await activeButton(CHECK, exchange)); await pause(1500);
    const retry = await activeButton(RETRY, exchange);
    const [sent] = startPosts(a);
    fireEvent.click(retry); await pause(1500);
    // Only the right of this mount is pinned here; what the screen shows after the accepted retry is not (QA-FINAL: the
    // written view stays on the check after an accepted retried start, a separate finding).
    expect(startPosts(a)).toEqual([sent, sent]);
  });

  it("a start record of another window of this installation: checked by its ID, no retry offered, its POST never sent", async () => {
    // The installation exists on the device before this window opens (as another window of it made it); the record of
    // that window's start is in the shared slot. This window never created that command.
    const a = app({ cards: [6, 7] });
    localStorage.setItem(`wortly.installation:${id(50)}`, JSON.stringify({ profileId: id(50), clientInstanceId: id(61),
      registrationId: id(62), proof: "synthetic-proof", proofVersion: "1", activated: true }));
    const X = id(71);
    localStorage.setItem(writtenPrimaryKey, JSON.stringify({ schemaVersion: 1, profileId: id(50), clientInstanceId: id(61), pair: "ru-de",
      intent: { command_id: X, session_id: id(72), kind: "session.start", payload: { mode: "written", bucket: "words" } } }));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: CHECK }, exchange)); await pause(1500);
    fireEvent.click(screen.getByRole("button", { name: CHECK })); await pause(1500);
    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
    const onX = requests(a, 0).filter((_, at) => String(a.fetcher.mock.calls[at][0]).includes(X)
      || String(a.fetcher.mock.calls[at][1]?.body ?? "").includes(X));
    expect(onX.length).toBeGreaterThan(0);
    expect(new Set(onX)).toEqual(new Set([`GET /api/v1/commands/${X}`]));
    expect(startPosts(a)).toEqual([]);
    expect(localStorage.getItem(writtenPrimaryKey)).toContain(X);
  });
});
