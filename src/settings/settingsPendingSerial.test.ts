// The order and the cancellation of SettingsPendingStore calls of one profile (C502, review
// pending_fixture_semantics_review_20261016.md): one queue per profile whatever the spelling of its ID; an aborted call
// changes nothing and does not cancel the next one.
import { describe, expect, it, vi } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { SettingsPendingStore, settingsSlotOf, type SettingsPending } from "./settingsPending";

const P = "abcdef00-0000-4000-8000-0000000000aa", Q = "abcdef00-0000-4000-8000-0000000000bb";
const record = (profileId: string, command = "abcdef00-0000-4000-8000-000000000003"): SettingsPending => ({ schemaVersion: 1, profileId,
  clientInstanceId: "abcdef00-0000-4000-8000-000000000002",
  intent: { command_id: command, kind: "setting.save", expected_field_version: "7", payload: { key: "strict_case", value: true } } });
const live = () => new AbortController().signal;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

function setup() {
  const values = new Map<string, string>();
  const storage: AsyncStorage = { get: vi.fn(async key => values.get(key) ?? null),
    set: vi.fn(async (key, value) => { values.set(key, value); }), remove: vi.fn(async key => { values.delete(key); }) };
  /** Holds the first read of a profile key until released; every other read goes at once. */
  const holdFirstProfileRead = () => {
    const gate = deferred(), entered = deferred();
    let held = false;
    vi.mocked(storage.get).mockImplementation(async key => {
      if (!held && key.startsWith("wortly.pending.setting:profile:")) { held = true; entered.resolve(); await gate.promise; }
      return values.get(key) ?? null;
    });
    return { release: gate.resolve, entered: entered.promise };
  };
  return { values, storage, store: new SettingsPendingStore(storage), holdFirstProfileRead };
}

describe("SettingsPendingStore: one queue per profile whatever the spelling of its ID", () => {
  it.each([["upper", "lower"], ["lower", "upper"]] as const)(
    "save(%s) held on its first read, then markMismatch(%s) and clearMarked: all succeed in call order, nothing is left", async (first, later) => {
    const f = setup(), held = f.holdFirstProfileRead();
    const spell = (side: "upper" | "lower") => side === "upper" ? P.toUpperCase() : P;
    const results = Promise.allSettled([f.store.save(record(spell(first)), live()), f.store.markMismatch(record(spell(later)), live()),
      f.store.clearMarked(record(spell(later)), live())]);
    await held.entered;
    expect(f.storage.set).not.toHaveBeenCalled(); // the later calls wait for the held save of the same profile
    held.release();
    expect((await results).map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(f.values.has(settingsSlotOf(P))).toBe(false);
    expect([...f.values.keys()].filter(key => key.startsWith("wortly.pending.setting"))).toEqual([]);
  });

  it("after the mark only clearMarked removes it: the unmarked clear of the original is refused as changed and keeps the mark", async () => {
    const f = setup();
    await f.store.save(record(P.toUpperCase()), live()); await f.store.markMismatch(record(P), live());
    await expect(f.store.clear(record(P), live())).rejects.toMatchObject({ kind: "changed" });
    expect(await f.store.load(P.toUpperCase(), live())).toMatchObject({ mismatch: true });
    await f.store.clearMarked(record(P), live());
    expect(f.values.has(settingsSlotOf(P))).toBe(false);
  });
});

describe("SettingsPendingStore: a cancelled call changes nothing and does not cancel the next one", () => {
  it("a save cancelled while its read is held: cancelled, the records stay; the next save with a live signal succeeds", async () => {
    const f = setup();
    await f.store.save(record(Q, "abcdef00-0000-4000-8000-000000000009"), live());
    const before = [...f.values];
    const held = f.holdFirstProfileRead(), controller = new AbortController();
    const cancelled = f.store.save(record(P), controller.signal);
    await held.entered; controller.abort(); held.release();
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    expect([...f.values]).toEqual(before);
    await f.store.save(record(P), live());
    expect(await f.store.load(P, live())).toEqual(record(P));
    expect(await f.store.load(Q, live())).toEqual(record(Q, "abcdef00-0000-4000-8000-000000000009"));
  });

  it("an already aborted load or save of another profile leaves every record as it was; the next calls succeed", async () => {
    const f = setup();
    await f.store.save(record(P), live());
    const before = [...f.values], aborted = new AbortController(); aborted.abort();
    await expect(f.store.load(Q, aborted.signal)).rejects.toMatchObject({ kind: "cancelled" });
    await expect(f.store.save(record(Q), aborted.signal)).rejects.toMatchObject({ kind: "cancelled" });
    expect([...f.values]).toEqual(before);
    await f.store.save(record(Q), live());
    expect(await f.store.load(Q, live())).toEqual(record(Q));
    expect(await f.store.load(P, live())).toEqual(record(P));
  });
});
