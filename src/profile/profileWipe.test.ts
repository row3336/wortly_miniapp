import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { memoryStorage } from "./profileStorage.test-support";
import { IDB_STORES, LEGACY_KEYS, NOT_PROFILE_RECORDS, PROFILE_KEYED, wipeProfileRecords } from "./profileWipe";
import { PAYLOAD_PREFIX } from "../commands/pendingSlot";

const X = "00000000-0000-4000-8000-0000000000AA", Y = "00000000-0000-4000-8000-0000000000bb";
const x = X.toLowerCase();

describe("wipeProfileRecords (P04 §8: the local records of a deleted profile)", () => {
  it("removes only the exact keys of X: installation, reapply, settings, P02 reset, pointers and payloads; never a legacy key or Y", async () => {
    const pointer = (base: string, id: string) => `${base}:profile:${id.toLowerCase()}`;
    const { storage, values } = memoryStorage({
      [`wortly.installation:${X}`]: "{}",
      [`wortly.reapply:${X}`]: "{}",
      [`wortly.pending.setting:profile:${x}`]: "{}",
      [`wortly.pending.settings-reset:profile:${x}`]: "{}",
      [pointer("wortly.pending.learning_session", X)]: "{}",
      [pointer("wortly.pending.written_start_cancel", X)]: "{}",
      [`${PAYLOAD_PREFIX}learning_session:${x}:00000000-0000-4000-8000-000000000100`]: "{}",
      [`${PAYLOAD_PREFIX}feedback:${x}:00000000-0000-4000-8000-000000000101`]: "{}",
      // Legacy shared keys (even naming X) and every key of Y stay: no operation of X touches them.
      "wortly.pending.settings-reset": JSON.stringify({ profileId: X }),
      "wortly.pending.learning_session": JSON.stringify({ profileId: x }),
      [pointer("wortly.pending.feedback", Y)]: "{}",
      [`${PAYLOAD_PREFIX}feedback:${Y.toLowerCase()}:00000000-0000-4000-8000-000000000102`]: "{}",
      // X only in the command place of a payload of Y, or in a malformed payload key: not a payload of X.
      [`${PAYLOAD_PREFIX}feedback:${Y.toLowerCase()}:${x}`]: "{}",
      [`${PAYLOAD_PREFIX}feedback:${x}`]: "{}",
      [`wortly.installation:${Y}`]: "{}",
      [`wortly.pending.settings-reset:profile:${Y}`]: "{}",
      "wortly.uiLanguage": "uk",
    });
    const result = await wipeProfileRecords(storage, X);
    // Without an installation store nothing is «стёрто», whatever localStorage did (store §6).
    expect(result).toEqual({ installation: { kind: "no-store" }, local: { removed: 8, failed: 0 }, wiped: false });
    expect([...values.keys()].sort()).toEqual([
      "wortly.pending.settings-reset", "wortly.pending.learning_session", pointer("wortly.pending.feedback", Y),
      `${PAYLOAD_PREFIX}feedback:${Y.toLowerCase()}:00000000-0000-4000-8000-000000000102`,
      `${PAYLOAD_PREFIX}feedback:${Y.toLowerCase()}:${x}`, `${PAYLOAD_PREFIX}feedback:${x}`,
      `wortly.installation:${Y}`, `wortly.pending.settings-reset:profile:${Y}`, "wortly.uiLanguage",
    ].sort());
  });

  it("a storage that cannot list keys: the payloads of X stay and it is a failure (residual (A)), never «стёрто»", async () => {
    const { storage: listing } = memoryStorage({ [`wortly.installation:${X}`]: "{}" });
    const { keys: _keys, ...storage } = listing;
    const result = await wipeProfileRecords(storage, X);
    expect(result.local).toEqual({ removed: 1, failed: 1 });
    expect(result.wiped).toBe(false);
  });

  it("never throws on an unwritable storage (P04 §3.7 (A)): the failures are counted, the result still comes", async () => {
    const storage: AsyncStorage = {
      async get() { return JSON.stringify({ profileId: X }); },
      async set() { throw new Error("quota"); },
      async remove() { throw new Error("denied"); },
    };
    const result = await wipeProfileRecords(storage, X);
    expect(result.local.removed).toBe(0);
    expect(result.local.failed).toBeGreaterThan(0);
    expect(result.wiped).toBe(false);
  });

  it("an ID that is not a profile UUID touches nothing", async () => {
    const { storage, writes } = memoryStorage({ "wortly.installation:x": "{}" });
    expect(await wipeProfileRecords(storage, "x")).toEqual({ installation: { kind: "no-store" }, local: { removed: 0, failed: 0 }, wiped: false });
    expect(writes).toEqual([]);
  });
});

/** Every storage key literal of the production code is either wiped for a deleted profile or named as device data. */
describe("the inventory of local keys", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test(-support)?\.tsx?$/.test(name) ? [path] : [];
    });
  }
  it("classifies every `wortly.` key of src (a new slot must be added to profileWipe.ts)", () => {
    const literals = new Set<string>();
    for (const file of sources(join(__dirname, ".."))) {
      for (const match of readFileSync(file, "utf8").matchAll(/["'`](wortly\.[A-Za-z_.:${}\-]+)["'`]/g)) literals.add(match[1]);
    }
    const id = "00000000-0000-4000-8000-000000000001";
    // The two prefixes of the profile addresses (pendingSlot.ts) are classified as such: pointers and payloads (§2).
    const known = new Set([...LEGACY_KEYS, ...NOT_PROFILE_RECORDS, ...PROFILE_KEYED.map(key => key(id)), "wortly.pending.", PAYLOAD_PREFIX]);
    const normalized = [...literals].map(literal => literal
      .replace("${profileId}", id).replace("${id}", id)
      .replace(/\$\{SETTINGS_RESET_SLOT\}:profile:\$\{profileId\.toLowerCase\(\)\}/, `wortly.pending.settings-reset:profile:${id}`)
      .replace(/\$\{SETTINGS_SLOT\}:profile:\$\{profileId\.toLowerCase\(\)\}/, `wortly.pending.setting:profile:${id}`));
    const modes = ["written", "learning", "oral", "conjugation"];
    const unclassified = normalized.filter(literal => literal.includes("${mode}")
      ? !modes.every(mode => known.has(literal.replace("${mode}", mode))) : !known.has(literal));
    expect(unclassified).toEqual([]);
    expect(literals.size).toBeGreaterThanOrEqual(15);
  });

  it("classifies every IndexedDB database/store of src (store §6: forget, revoke or kept); a new name without a class fails", () => {
    const names = new Set<string>();
    for (const file of sources(join(__dirname, ".."))) {
      const code = readFileSync(file, "utf8");
      const databases = [...code.matchAll(/_DATABASE\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
      const stores = [...code.matchAll(/_STORE\s*=\s*["']([^"']+)["']/g)].map(match => match[1]);
      for (const database of databases) {
        if (stores.length === 0) names.add(database);
        for (const store of stores) names.add(`${database}/${store}`);
      }
    }
    expect([...names].filter(name => !Object.hasOwn(IDB_STORES, name))).toEqual([]);
    expect([...names].sort()).toEqual(Object.keys(IDB_STORES).sort());
    expect(IDB_STORES["wortly_installation/installations"]).toBe("forget");
    expect(IDB_STORES["wortly_journal/buffers"]).toBe("revoke");
  });
});
