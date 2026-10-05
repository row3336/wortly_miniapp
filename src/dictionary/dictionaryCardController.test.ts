import { afterEach, describe, expect, it, vi } from "vitest";
import type { DictionaryCardViewResponse } from "../api/generated";
import { ApiError } from "../api/http";
import { DictionaryCardController, type DictionaryCardSnapshot, type DictionaryCardSource } from "./dictionaryCardController";

type Pair = "ru-de" | "uk-de" | "en-de";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = id(1), B = id(2);
function view(cardId = A, state_version = "1", pair: Pair = "ru-de"): DictionaryCardViewResponse {
  return { state_version, current: {
    status: "available",
    content: {
      pair, card: { id: cardId, revision: "1", lemma: "Haus", type: "noun", cefr: "A1" },
      translations: { common: ["дом"], personal: null }, grammar: null,
      reference_conjugations: [], examples: { common: [], personal: null }, association: null, hint: null,
    },
    study: {
      status: "available", card_id: cardId, card_revision: "1", pair, card_type: "noun", local_date: "2026-10-01",
      facts: {
        common_translation_present: true, exclusion: { excluded: false, version: null },
        manual: { selected: false, selection_version: "1" },
        learning: { ever_selected: false, finished_or_skipped: false, current: null }, non_learning_history: false,
      },
      directions: (["l1-de", "de-l1"] as const).map(direction => ({
        direction, introduced: false, progress_present: false, progress_version: null, schedule: null, interval_preview: null,
      })),
    },
  } };
}
const unavailable = (state_version = "1"): DictionaryCardViewResponse => ({ state_version, current: { status: "unavailable" } });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture() {
  let live = true, minimum: string | null = null;
  const updates: DictionaryCardSnapshot[] = [];
  const controller = new DictionaryCardController({ isLive: () => live, minimumStateVersion: () => minimum,
    onUpdate: state => { updates.push(state); } });
  const read = vi.fn<DictionaryCardSource["read"]>(async cardId => view(cardId));
  const source = { identity: {}, read };
  return { controller, source, read, updates, close: () => { live = false; }, floor: (value: string | null) => { minimum = value; } };
}
afterEach(() => { vi.restoreAllMocks(); });

describe("dictionary card read ownership", () => {
  it("opens exactly the requested card and pair, loading before ready, without access in snapshots", async () => {
    const f = fixture();
    expect(f.controller.snapshot()).toEqual({ phase: "idle", cardId: null, pair: null, data: null, problem: null });
    await f.controller.load(f.source, "ru-de", A);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(A);
    expect(f.updates.map(u => u.phase)).toEqual(["loading", "ready"]);
    expect(f.updates[0]).toEqual({ phase: "loading", cardId: A, pair: "ru-de", data: null, problem: null });
    expect(f.controller.snapshot()).toEqual({ phase: "ready", cardId: A, pair: "ru-de", data: view(A), problem: null });
    expect(JSON.stringify(f.updates)).not.toMatch(/token|proof|identity|document/);
  });

  it("keeps unavailable distinct from ready and failed and exposes no card content", async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(unavailable("2"));
    await f.controller.load(f.source, "ru-de", A);
    expect(f.controller.snapshot()).toEqual({ phase: "unavailable", cardId: A, pair: "ru-de", data: unavailable("2"), problem: null });
    expect(JSON.stringify(f.controller.snapshot().data)).not.toMatch(/content|study|Haus/);
  });

  it("rejects a response for another pair without exposing its content", async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(view(A, "2", "en-de"));
    await f.controller.load(f.source, "ru-de", A);
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", cardId: A, pair: "ru-de", data: null, problem: "pair_changed" });
  });

  it.each([
    ["another card", () => view(B)],
    ["a malformed body", () => ({ state_version: "1", current: { status: "unavailable", card_id: A } }) as unknown as DictionaryCardViewResponse],
    ["a non-version state", () => ({ ...view(A), state_version: "0" })],
  ])("validates the source reply through the accepted view contract: %s", async (_name, reply) => {
    const f = fixture(); f.read.mockResolvedValueOnce(reply());
    await f.controller.load(f.source, "ru-de", A);
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", cardId: A, data: null, problem: "load" });
  });

  it.each(["success", "error", "denial"])("ignores late %s from the previous card", async outcome => {
    const f = fixture(), old = deferred<DictionaryCardViewResponse>(), fresh = deferred<DictionaryCardViewResponse>();
    f.read.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = f.controller.load(f.source, "ru-de", A);
    const second = f.controller.load(f.source, "ru-de", B);
    expect(f.controller.snapshot()).toMatchObject({ phase: "loading", cardId: B, data: null });
    fresh.resolve(view(B, "4")); await second;
    const before = f.controller.snapshot(), events = f.updates.length;
    if (outcome === "success") old.resolve(view(A, "9"));
    else old.reject(outcome === "error" ? new ApiError("network") : new ApiError("http", 401));
    await first;
    expect(f.controller.snapshot()).toEqual(before); expect(f.updates).toHaveLength(events);
    expect(before).toMatchObject({ phase: "ready", cardId: B, data: { state_version: "4" } });
  });

  it("compares versions exactly, keeps the floor across cards, and accepts equal-version data", async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(view(A, "9007199254740993"));
    await f.controller.load(f.source, "ru-de", A);
    f.read.mockResolvedValueOnce(view(B, "9007199254740992"));
    await f.controller.load(f.source, "ru-de", B);
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", cardId: B, data: null, problem: "stale_response" });
    expect(f.read).toHaveBeenCalledTimes(2);
    f.read.mockResolvedValueOnce(unavailable("9007199254740992"));
    await f.controller.load(f.source, "ru-de", B);
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    f.read.mockResolvedValueOnce(view(B, "9007199254740993")); await f.controller.load(f.source, "ru-de", B);
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", cardId: B, data: { state_version: "9007199254740993" } });
  });

  it("honors a monotonic shared floor while waiting and after publication", async () => {
    const f = fixture(), pending = deferred<DictionaryCardViewResponse>(); f.read.mockReturnValueOnce(pending.promise);
    const reading = f.controller.load(f.source, "ru-de", A);
    f.floor("7"); pending.resolve(view(A, "6")); await reading;
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    expect(f.read).toHaveBeenCalledTimes(1);
    f.read.mockResolvedValueOnce(view(A, "7")); await f.controller.load(f.source, "ru-de", A);
    expect(f.controller.snapshot().phase).toBe("ready"); f.floor("8");
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    for (const fallback of [null, "7"]) {
      f.floor(fallback);
      expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    }
    f.floor(null); f.read.mockResolvedValueOnce(view(A, "7")); await f.controller.load(f.source, "ru-de", A);
    expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "stale_response" });
    f.read.mockResolvedValueOnce(view(A, "8")); await f.controller.load(f.source, "ru-de", A);
    expect(f.controller.snapshot().phase).toBe("ready");
  });

  it("a new source identity resets the floor and hides the previous document's card", async () => {
    const f = fixture(); f.read.mockResolvedValueOnce(view(A, "9223372036854775807"));
    await f.controller.load(f.source, "ru-de", A);
    const pending = deferred<DictionaryCardViewResponse>();
    const next: DictionaryCardSource = { identity: {}, read: vi.fn(() => pending.promise) };
    const loading = f.controller.load(next, "uk-de", A);
    expect(f.controller.snapshot()).toEqual({ phase: "loading", cardId: A, pair: "uk-de", data: null, problem: null });
    pending.resolve(view(A, "1", "uk-de")); await loading;
    expect(f.controller.snapshot()).toMatchObject({ phase: "ready", pair: "uk-de", data: { state_version: "1" } });
  });

  it.each([[401, "expired"], [403, "forbidden"], [404, "load"], [409, "load"], [503, "load"]] as const)(
    "maps HTTP %s to %s, removes old data and does not retry", async (status, problem) => {
      const f = fixture(); await f.controller.load(f.source, "ru-de", A);
      f.read.mockRejectedValueOnce(new ApiError("http", status, "SYNTHETIC"));
      await f.controller.load(f.source, "ru-de", A);
      expect(f.controller.snapshot()).toMatchObject({ phase: "failed", cardId: A, data: null, problem });
      expect(f.read).toHaveBeenCalledTimes(2);
    });

  it.each([new ApiError("invalid_response"), new ApiError("network"), new TypeError("boom")])(
    "maps other failures to load: %s", async error => {
      const f = fixture(); f.read.mockRejectedValueOnce(error);
      await f.controller.load(f.source, "ru-de", A);
      expect(f.controller.snapshot()).toMatchObject({ phase: "failed", data: null, problem: "load" });
    });

  it("recovers only on an explicit repeated load, with no timer or hidden retry", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout"), interval = vi.spyOn(globalThis, "setInterval");
    const f = fixture(); f.read.mockRejectedValueOnce(new ApiError("network"));
    await f.controller.load(f.source, "ru-de", A);
    await new Promise<void>(done => queueMicrotask(done));
    expect(f.controller.snapshot().problem).toBe("load"); expect(f.read).toHaveBeenCalledTimes(1);
    expect(timeout).not.toHaveBeenCalled(); expect(interval).not.toHaveBeenCalled();
    await f.controller.load(f.source, "ru-de", A);
    expect(f.controller.snapshot().phase).toBe("ready"); expect(f.read).toHaveBeenCalledTimes(2);
  });

  it("detaches source replies, observer values and snapshots", async () => {
    const f = fixture(), reply = view(A, "3"); f.read.mockResolvedValueOnce(reply);
    await f.controller.load(f.source, "ru-de", A);
    reply.state_version = "1"; (reply.current as { status: string }).status = "unavailable";
    const observed = f.updates.at(-1)!; observed.cardId = B; observed.data!.state_version = "99";
    const snapshot = f.controller.snapshot(); snapshot.pair = "en-de"; snapshot.data!.current = { status: "unavailable" };
    expect(f.controller.snapshot()).toEqual({ phase: "ready", cardId: A, pair: "ru-de", data: view(A, "3"), problem: null });
  });

  it.each(["dispose", "lease"])("silences an in-flight reply after %s ends the owner", async reason => {
    const f = fixture(), pending = deferred<DictionaryCardViewResponse>(); f.read.mockReturnValueOnce(pending.promise);
    const read = f.controller.load(f.source, "ru-de", A), count = f.updates.length;
    if (reason === "dispose") f.controller.dispose(); else f.close();
    pending.resolve(view(A)); await read;
    expect(f.controller.snapshot()).toMatchObject({ phase: "disposed", data: null });
    expect(f.updates).toHaveLength(count);
    await f.controller.load(f.source, "ru-de", B); expect(f.read).toHaveBeenCalledTimes(1);
  });

  it("a reentrant loading observer may dispose before the read", async () => {
    const read = vi.fn(async () => view());
    const controller = new DictionaryCardController({ isLive: () => true, onUpdate: () => controller.dispose() });
    await controller.load({ identity: {}, read }, "ru-de", A); expect(read).not.toHaveBeenCalled();
  });

  it("a reentrant loading observer may open another card before the read", async () => {
    const source = { identity: {}, read: vi.fn(async (cardId: string) => view(cardId)) };
    let replacement: Promise<void> | undefined;
    const controller = new DictionaryCardController({ isLive: () => true, onUpdate: state => {
      if (state.phase === "loading" && state.cardId === A) replacement = controller.load(source, "ru-de", B);
    } });
    await controller.load(source, "ru-de", A); await replacement;
    expect(source.read).toHaveBeenCalledExactlyOnceWith(B);
    expect(controller.snapshot()).toMatchObject({ phase: "ready", cardId: B });
  });

  it.each([
    ["an invalid card ID", (f: ReturnType<typeof fixture>) => f.controller.load(f.source, "ru-de", "not-a-uuid")],
    ["a missing card ID", (f: ReturnType<typeof fixture>) => f.controller.load(f.source, "ru-de", undefined as unknown as string)],
    ["an unknown pair", (f: ReturnType<typeof fixture>) => f.controller.load(f.source, "de-ru" as Pair, A)],
    ["a missing source", (f: ReturnType<typeof fixture>) => f.controller.load(null as unknown as DictionaryCardSource, "ru-de", A)],
  ])("throws synchronously for %s before changing state or reading", (_name, call) => {
    const f = fixture();
    expect(() => call(f)).toThrow(Error);
    expect(f.read).not.toHaveBeenCalled(); expect(f.updates).toHaveLength(0);
    expect(f.controller.snapshot().phase).toBe("idle");
  });
});
