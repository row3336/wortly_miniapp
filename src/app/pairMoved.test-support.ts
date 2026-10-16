import { act } from "@testing-library/react";
import type { Mock } from "vitest";

type Fetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Body = { kind?: string; session_id?: string; command_id?: string; event?: string } | null;
const bodyOf = (init?: RequestInit): Body => init?.body ? JSON.parse(String(init.body)) as Body : null;
const pathOf = (url: string | URL | Request) => new URL(String(url), "http://localhost").pathname;

export const settle = (ms: number) => act(async () => { await new Promise(done => setTimeout(done, ms)); });

/**
 * Test timeout of a scenario that is long by construction: its explicit `settle` pauses (real time, "nothing more is sent
 * or opened") add up to 4-7 s on their own, so vitest's 5 s default is a limit of the harness, not a product timer. The
 * product's own timers (the page gate's 5/10/20/30 s series, the 5 s of a hold) are untouched and the pauses are not
 * shortened. Measured with the default lifted (79c9c5b, loaded machine): 3.4-9.2 s per scenario, so 20 s is about twice
 * the slowest. A limit for named tests only, never the global `testTimeout`.
 */
export const LONG_SCENARIO_MS = 20_000;

/** Every "state_version" of a reply, 5 higher. */
const grown = (raw: string) => raw.replace(/"state_version":"([1-9][0-9]*)"/g, (_, value: string) => `"state_version":"${BigInt(value) + 5n}"`);

/**
 * R1 over a mode fixture (answer 17.1-А): after `moved`, the pair has changed to uk on another device. Profile (auth,
 * client/open), Settings and Today name uk; study replies name uk-de and a uk prompt (the projections stay valid);
 * client/open reports the client's own unclosed session, the one its last session.start made (core clients.py:287-292).
 * `opens` lists the event of every client/open request; `started` is the session of the last session.start.
 * Every state version after `moved` is 5 higher, as the core's pair change raised it (a window that got the new pair
 * then reads current Settings, not a stale echo).
 * `openOld` keeps profile, Settings and Today in the old pair (client/open without a session): a refresh that brings
 * nothing new. The core never answers so (A-LANE-CROSS-PAIR); it pins that the refresh is not asked again.
 * `refresh` changes what the refresh finds after the start (C151 forks of the authoritative client/open): "closed" — the
 * created session was closed before it (no session); "other" — another session of the new pair is open (`other`);
 * "again" — the pair changed once more, to en, and closed the created session.
 * `low` (set before the window opens) raises every version the window reads before `moved` by 5 and answers every study
 * request after `moved` with state version 1, below what the window already read: such a reply proves nothing current. `foreign` makes the start reply name the session `other` open in the new pair, not its own.
 */
export function pairMoved(fetcher: Mock<Fetch>) {
  const world = { moved: false, openOld: false, started: null as string | null, open: null as string | null, opens: [] as string[],
    refresh: null as "closed" | "other" | "again" | null, low: false, foreign: false, refreshed: false, other: "0a0b0c0d-0000-4000-8000-0000000000f1" };
  const base = fetcher.getMockImplementation()!;
  fetcher.mockImplementation(async (url, init) => {
    const path = pathOf(url), body = bodyOf(init);
    if (init?.method === "POST" && path.endsWith("/commands") && body?.kind === "session.start") world.started = world.open = body.session_id!;
    if (path.endsWith("/client/open")) world.opens.push(body?.event ?? "?");
    if (path.endsWith("/client/open") && world.moved && body?.event === "foreground") world.refreshed = true;
    const reply = await base(url, init);
    if (init?.method === "POST" && path.endsWith("/commands") && body?.kind === "session.stop" && reply.ok) world.open = null;
    if (!world.moved) return world.low ? new Response(grown(await reply.text()), { status: reply.status }) : reply;
    const study = path.includes("/commands") || path.includes("/sessions/");
    if (study) {
      let raw = grown((await reply.text()).split('"ru-de"').join('"uk-de"').split('"language":"ru"').join('"language":"uk"'));
      if (world.foreign && init?.method === "POST" && body?.kind === "session.start" && world.started)
        raw = raw.split(world.started).join(world.other);
      if (world.low) raw = raw.replace(/"state_version":"[0-9]+"/g, '"state_version":"1"');
      return new Response(raw, { status: reply.status });
    }
    if (!/(auth\/telegram|client\/open|\/settings|\/today)$/.test(path) || world.openOld) return reply;
    const value = JSON.parse(grown(await reply.text())) as { profile?: { dictionary_language: string }; pair?: string;
      session?: unknown; settings?: { dictionary_language?: { value: unknown } } };
    const language = world.refresh === "again" && world.refreshed ? "en" : "uk";
    if (value.profile) value.profile.dictionary_language = language;
    if (value.settings?.dictionary_language) value.settings.dictionary_language.value = language;
    if (path.endsWith("/today")) value.pair = `${language}-de`;
    if (path.endsWith("/client/open")) value.session = world.refresh === "closed" || world.refresh === "again" ? null
      : world.refresh === "other" ? { id: world.other, phase: "active" } : world.open === null ? null : { id: world.open, phase: "active" };
    return new Response(JSON.stringify(value), { status: reply.status });
  });
  return world;
}

/** The server applies the next POST of this kind, but its reply is lost. */
export function loseReply(fetcher: Mock<Fetch>, kind: string) {
  const base = fetcher.getMockImplementation()!;
  let lost = false;
  fetcher.mockImplementation(async (url, init) => {
    if (lost || init?.method !== "POST" || bodyOf(init)?.kind !== kind) return base(url, init);
    lost = true; await base(url, init); throw new TypeError("network");
  });
}

/** The next foreground client/open waits for `release` (hold) or fails without reaching the server (fail). */
export function foregroundOpen(fetcher: Mock<Fetch>, mode: "hold" | "fail") {
  const base = fetcher.getMockImplementation()!;
  let release = () => {};
  const gate = new Promise<void>(done => { release = done; });
  const state = { attempts: 0, release: () => release() };
  fetcher.mockImplementation(async (url, init) => {
    if (pathOf(url).endsWith("/client/open") && bodyOf(init)?.event === "foreground") {
      state.attempts++;
      if (state.attempts === 1 && mode === "fail") throw new TypeError("network");
      if (state.attempts === 1) await gate;
    }
    return base(url, init);
  });
  return state;
}

/** POST /commands bodies after `mark`. */
export const commandPosts = (fetcher: Mock<Fetch>, mark = 0) => fetcher.mock.calls.slice(mark)
  .filter(([url, init]) => init?.method === "POST" && pathOf(url).endsWith("/commands")).map(([, init]) => bodyOf(init)!);

/** A start that is no confirmed R1 landing (C151): the reply proves nothing current, or the refresh finds no such session. */
export type NoLanding = "low" | "foreign" | "closed" | "other" | "again";
export const noLandings: NoLanding[] = ["low", "foreign", "closed", "other", "again"];
/** The pair moves before the start; `low` must already be set when the window opens (pairMoved). */
export function moveWithout(world: ReturnType<typeof pairMoved>, kind: NoLanding) {
  world.moved = true; world.low = kind === "low"; world.foreign = kind === "foreign";
  world.refresh = kind === "closed" || kind === "other" || kind === "again" ? kind : null;
}
/** The window's exits that are enabled: none may stop the created session after such a start. */
export const enabledExits = () => Array.from(document.querySelectorAll("button"))
  .filter(button => /^(Выйти|Завершить)$/.test(button.textContent ?? "") && !button.disabled);

/**
 * Every text one of `texts` that any commit put on screen, from the mutation records themselves: a text that the next
 * synchronous commit replaces before the observer runs is still caught by its old value (watchFlash reads only the DOM
 * left at that time).
 */
export function watchCommits(texts: string[]) {
  const seen: string[] = [];
  const note = (value: string | null) => { if (value && texts.some(text => value.includes(text))) seen.push(value.trim()); };
  const observer = new MutationObserver(records => records.forEach(record => {
    if (record.type === "characterData") { note(record.oldValue); note(record.target.textContent); }
    record.addedNodes.forEach(node => note(node.textContent));
  }));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, characterDataOldValue: true });
  return { seen, stop: () => observer.disconnect() };
}
