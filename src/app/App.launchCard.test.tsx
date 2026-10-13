// T+M-CARD-LINK (answer Q20, variant A): the bot's complaint button opens the Mini App with `?card=<id>`.
// M-CARD-LINK-2 (answers S01–S03): it opens over a resumed session too, takes no quiz rights, and is forgotten once seen.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cardIdOf, cardView, reviewing } from "../dictionary/card/cardTestData.test-support";
import { app, exchange, field, pairText, useWrittenAppEnvironment } from "../written/writtenApp.test-support";
import { id } from "../written/writtenFixtures.test-support";
import { App } from "./App";
import { LaunchCard, launchCardId, withoutLaunchCard } from "./launchCard";
import { besidesContext, launch, serveLaunchCard } from "./launchCard.test-support";

useWrittenAppEnvironment();
afterEach(() => { window.history.replaceState(null, "", "/"); });

const CARD = cardIdOf(3);
/** The real App over the synthetic server, with the card read and its context commands; `hidden` answers as for another user. */
function launchApp(options: { hidden?: boolean; active?: boolean } = {}) {
  const a = app({ active: options.active });
  return { ...a, ...serveLaunchCard(a.fetcher, CARD, { hidden: options.hidden, learning: true }) };
}

describe("launchCardId: only one well-formed card id is taken from the query", () => {
  it("takes a UUID, in lower case", () => {
    expect(launchCardId(`?card=${CARD}`)).toBe(CARD);
    expect(launchCardId(`?v=2&card=${CARD.toUpperCase()}`)).toBe(CARD);
  });
  it.each(["", "?card=", "?card=Haus", `?card=${CARD}x`, `?card=../settings`, `?card=${CARD}&card=${CARD}`, `?cards=${CARD}`,
    `?card=${CARD.replaceAll("-", "")}`])("ignores %j", (search) => {
    expect(launchCardId(search)).toBeNull();
  });
  it("is taken once", () => {
    const card = new LaunchCard(CARD);
    expect(card.take()).toBe(CARD);
    expect(card.take()).toBeNull();
  });
  it("forgets the address once, when viewed", () => {
    const forget = vi.fn();
    const card = new LaunchCard(CARD, forget);
    card.take();
    expect(forget).not.toHaveBeenCalled();
    card.viewed(); card.viewed();
    expect(forget).toHaveBeenCalledTimes(1);
  });
  it.each([[`?card=${CARD}`, ""], [`?v=2&card=${CARD}&flag`, "?v=2&flag"], [`?a=%20b+c&card=${CARD}`, "?a=%20b+c"],
    [`?c%61rd=${CARD}&v=1`, "?v=1"], [`?Card=${CARD}`, `?Card=${CARD}`], ["?v=%E0%A4%A", "?v=%E0%A4%A"], ["", ""]])(
    "withoutLaunchCard(%j) keeps every other part as written: %j", (search, expected) => {
      expect(withoutLaunchCard(search)).toBe(expected);
    });
});

describe("the launch card in the actual App document", () => {
  it("L1 opens the card over Today after the ordinary entry; Back returns to Today and closes its context", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp();
    render(<App />);
    await screen.findByRole("main", { name: "Карточка" }, exchange);
    await screen.findByText("В очереди на изучение");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("das\u00a0Haus");
    // The ordinary signed entry came first; the id is only in the card read's path.
    expect(a.fetcher.mock.calls.findIndex(([url]) => String(url).endsWith("/auth/telegram")))
      .toBeLessThan(a.fetcher.mock.calls.findIndex(([url]) => String(url).includes("/view")));
    expect(a.views()).toEqual([`/api/v1/dictionary/cards/${CARD}/view`]);
    // A message opening, not a dictionary one: it stays out of the history (answer S02).
    expect(a.origins()).toEqual(["?origin=message"]);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    expect(a.posts()[0].payload).toEqual({ card_id: CARD, source: { kind: "dictionary" } });

    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
  });

  it("L2 native Back on the launch card closes it like the control and leads to Today", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp();
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    await a.back.click();
    await screen.findByText(pairText, undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
    // Today has no Back of its own; the card is not opened again.
    expect(a.views()).toHaveLength(1);
  });

  it("L3 a hidden card read by another user shows «Карточка недоступна»; Back returns to Today", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp({ hidden: true });
    render(<App />);
    await screen.findByText("Карточка недоступна", undefined, exchange);
    expect(a.kinds()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText, undefined, exchange);
  });

  it.each(["", "?card=Haus", `?card=${CARD}&card=${CARD}`, `#card=${CARD}`])("L4 the launch %j opens Today as before, no card read", async (search) => {
    launch(search);
    const a = launchApp();
    render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.views()).toEqual([]);
  });

  it("L5 over a resumed written session the card opens at once, sends no study command and Back returns to the same question", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp({ active: true });
    // The question is not yet shown: its visible commit (assignment.present) belongs to the quiz, not to the card over it.
    a.server.state.assignment = "prefetched";
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    // The card of the complaint, not the card of the current assignment (слово 6, id 106).
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("das\u00a0Haus");
    expect(a.views()).toEqual([`/api/v1/dictionary/cards/${CARD}/view`]);
    // A message opening, not a dictionary one: it stays out of the history (answer S02).
    expect(a.origins()).toEqual(["?origin=message"]);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(besidesContext(a.kinds())).toEqual([]);
    expect(screen.queryByText("слово 6")).toBeNull();

    await a.back.click();
    await screen.findByText("слово 6", undefined, exchange);
    await waitFor(() => expect(field().readOnly).toBe(false), exchange);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    // The quiz goes on where it was: its own present follows only now; the card closed its context once.
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close", "assignment.present"]), exchange);
    expect(a.server.state.sessionId).not.toBeNull(); expect(a.server.state.status).toBe("active");
    expect(a.views()).toHaveLength(1);
  });

  it("L5b the screen control Back of the card over a written session also returns to the quiz, the session stays open", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp({ active: true });
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    const opens = a.openReply.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText("слово 6", undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(besidesContext(a.kinds())).toEqual([]);
    // A return, not a way through Today: no Today refresh (a new open of the document) on the way back.
    expect(a.openReply.mock.calls.length).toBe(opens);
    expect(a.server.state.status).toBe("active");
    expect(screen.queryByText(pairText)).toBeNull();
  });

  it("L6 a document rebuilt inside the same App (a new access key) does not open the launch card a second time", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp();
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText, undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "context.close"]));
    expect(a.views()).toHaveLength(1);

    // The next foreground open answers another document epoch: the access key changes and the document is built again.
    const opens = () => a.openReply.mock.calls.length;
    const before = opens(), todays = a.todayReply.mock.calls.length;
    const reply = a.openReply.getMockImplementation()!;
    a.openReply.mockImplementation(async body => {
      const opened = await (await reply(body)).json();
      return new Response(JSON.stringify({ ...opened, document_epoch: "2" }), { status: 200 });
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(opens()).toBeGreaterThan(before), exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
    expect(a.views()).toHaveLength(1);
    expect(a.kinds()).toEqual(["context.open", "context.close"]);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    await screen.findByText(pairText, undefined, exchange);
    // The rebuilt document reads Today again; that read is the proof that it was built, not merely kept.
    expect(a.todayReply.mock.calls.length).toBeGreaterThan(todays);
  });

  it("L7 S03: once the card was shown and closed, a reload of the same address opens Today; other parts of the address stay", async () => {
    launch(`?v=2&card=${CARD}#tgWebAppData=synthetic`);
    const a = launchApp();
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]));
    // Seen but not closed: the address still asks for the card.
    expect(window.location.search).toBe(`?v=2&card=${CARD}`);
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(window.location.search).toBe("?v=2");
    expect(window.location.hash).toBe("#tgWebAppData=synthetic");
    expect(window.history.length).toBe(1);

    cleanup(); render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.views()).toHaveLength(1);

    // A new tap of the bot button is a new address with the card: it opens again.
    cleanup(); launch(`?v=2&card=${CARD}#tgWebAppData=synthetic-2`); render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(a.views()).toHaveLength(2);
  });

  it("L8 S03: a reload before the card was closed opens it again: the intent is not lost", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp();
    render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    cleanup(); render(<App />);
    await screen.findByText("В очереди на изучение", undefined, exchange);
    expect(a.views()).toHaveLength(2);
  });

  it("L9 R2-03: a card refused for good (unavailable) is forgotten in the address at once; a reload opens Today", async () => {
    launch(`?v=2&card=${CARD}`);
    const a = launchApp({ hidden: true });
    render(<App />);
    await screen.findByText("Карточка недоступна", undefined, exchange);
    expect(window.location.search).toBe("?v=2");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    await screen.findByText(pairText, undefined, exchange);
    expect(window.location.search).toBe("?v=2");
    cleanup(); render(<App />);
    await screen.findByText(pairText, undefined, exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.views()).toHaveLength(1);
  });

  /** The card read answers like this (a status, or a dropped connection), the rest of the server as before. */
  function failingView(fetcher: ReturnType<typeof launchApp>["fetcher"], failure: number | "network") {
    const served = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (new URL(String(url), "http://localhost").pathname.endsWith("/view")) {
        if (failure === "network") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ error: { code: "refused" } }), { status: failure });
      }
      return served(url, init);
    });
    return () => fetcher.mockImplementation(served);
  }

  it("L12 R2-03: a 403 on the card read is an access denial of the whole entry (onDenied): no card is shown, no study command is sent", async () => {
    launch(`?card=${CARD}`);
    const a = launchApp();
    failingView(a.fetcher, 403);
    render(<App />);
    await screen.findByText("Не удалось открыть Wortly", undefined, exchange);
    expect(screen.queryByRole("main", { name: "Карточка" })).toBeNull();
    expect(a.kinds()).toEqual([]);
  });

  it.each([["network", "network" as const], ["503", 503], ["500", 500]])(
    "L13 R2-03: a temporary failure (%s) keeps the address; a reload opens the card", async (_name, failure) => {
      launch(`?card=${CARD}`);
      const a = launchApp();
      const recover = failingView(a.fetcher, failure);
      render(<App />);
      await screen.findByText("Не удалось загрузить карточку", undefined, exchange);
      fireEvent.click(screen.getByRole("button", { name: "Назад" }));
      await screen.findByText(pairText, undefined, exchange);
      expect(window.location.search).toBe(`?card=${CARD}`);
      cleanup(); recover(); render(<App />);
      await screen.findByText("В очереди на изучение", undefined, exchange);
    });

  it("L11 C024: «Не повторять» of the current question's card in the complaint card: the server moves the quiz on; Back shows its step", async () => {
    const CURRENT = id(106);
    launch(`?card=${CURRENT}`);
    const a = app({ active: true, cards: [6, 7, 8] });
    const s = a.server.state;
    let excluded = 0;
    const card = serveLaunchCard(a.fetcher, CURRENT, { learning: true, view: cardId => reviewing(cardView(cardId)),
      // As core card_exclusion._withdraw_from_written: the live assignment of the card closes, the next one is issued.
      exclude: () => { excluded++; s.index = 1; s.assignment = "prefetched"; s.version++; } });
    render(<App />);
    await screen.findByRole("heading", { level: 2 }, exchange);
    await waitFor(() => expect(a.kinds()).toEqual(["context.open"]), exchange);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    fireEvent.click(await screen.findByRole("button", { name: "Не повторять" }, exchange));
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "card.exclude"]), exchange);
    // The message card stays open (no quiz rights: no automatic exit, no «Далее»).
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    expect(screen.getByRole("main", { name: "Карточка" })).toBeTruthy();
    expect(excluded).toBe(1);

    await a.back.click();
    // The quiz reads its session after the return: the withdrawn question is not shown, the next one is.
    await screen.findByText("слово 7", undefined, exchange);
    expect(screen.queryByText("слово 6")).toBeNull();
    await waitFor(() => expect(a.kinds()).toEqual(["context.open", "card.exclude", "context.close", "assignment.present"]), exchange);
    expect(a.posts()[3]).toMatchObject({ kind: "assignment.present", assignment_id: id(7) });
    expect(card.origins().every(origin => origin === "?origin=message")).toBe(true);
  });
});

