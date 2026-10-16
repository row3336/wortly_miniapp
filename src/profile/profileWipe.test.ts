import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AsyncStorage } from "../platform/storage";
import { memoryStorage } from "./profileStorage.test-support";
import { IDB_STORES, NOT_PROFILE_RECORDS, PROFILE_KEYED, SHARED_SLOTS, wipeProfileRecords } from "./profileWipe";

const X = "00000000-0000-4000-8000-0000000000AA", Y = "00000000-0000-4000-8000-0000000000bb";
const x = X.toLowerCase();

describe("wipeProfileRecords (P04 §8: the local records of a deleted profile)", () => {
  it("removes the installation key, the reapply intent, the settings and the P02 reset records of X, and shared slots naming X", async () => {
    const { storage, values } = memoryStorage({
      [`wortly.installation:${X}`]: "{}",
      [`wortly.reapply:${X}`]: "{}",
      [`wortly.pending.setting:profile:${x}`]: "{}",
      [`wortly.pending.settings-reset:profile:${x}`]: "{}",
      "wortly.pending.settings-reset": JSON.stringify({ profileId: X }),
      "wortly.pending.learning_session": JSON.stringify({ profileId: x }),
      "wortly.pending.written_start_cancel": JSON.stringify({ profileId: X }),
      "wortly.pending.feedback": JSON.stringify({ profileId: Y }),
      [`wortly.installation:${Y}`]: "{}",
      [`wortly.pending.settings-reset:profile:${Y}`]: "{}",
      "wortly.uiLanguage": "uk",
      "wortly.pending.oral_session": "not json",
    });
    const result = await wipeProfileRecords(storage, X);
    // Without an installation store nothing is «стёрто», whatever localStorage did (store §6).
    expect(result).toEqual({ installation: { kind: "no-store" }, local: { removed: 7, failed: 0 }, wiped: false });
    expect([...values.keys()].sort()).toEqual([
      `wortly.installation:${Y}`, "wortly.pending.feedback", "wortly.pending.oral_session",
      `wortly.pending.settings-reset:profile:${Y}`, "wortly.uiLanguage",
    ].sort());
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
    const known = new Set([...SHARED_SLOTS, ...NOT_PROFILE_RECORDS, ...PROFILE_KEYED.map(key => key(id))]);
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
