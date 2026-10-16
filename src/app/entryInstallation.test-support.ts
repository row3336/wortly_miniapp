// C163 шаг 6b (P2-6B): test support only. The product has no fallback store: an EntryController without its
// installation store is fail-closed (no record written, no register, no open). Tests that drive Entry over an
// AsyncStorage inject this store EXPLICITLY (TestEntryController below, or installationStore: contextInstallationStore(...)).
import { writeInstallation, type Installation } from "./installation";
import type { ForgetOutcome, InstallationRead, InstallationStore } from "./installationStore";
import { installationKey, strictInstallation } from "./installationStore";

/** The strict six-field reading of a stored value (store §2): null — none, "invalid" — anything else. */
function parseInstallation(raw: string | null, profileId: string): Installation | null | "invalid" {
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return "invalid"; }
  return strictInstallation(value, profileId);
}
import type { AsyncStorage } from "../platform/storage";
import { EntryController, type EntryControllerOptions } from "./entryController";

/**
 * The store over an AsyncStorage of ONE JS context: its mutations are serialized per profile inside this context only —
 * NOT across windows (AsyncStorage has no compare-and-set). Tests only. Same outcomes and checks as the browser store.
 */
export function contextInstallationStore(storage: AsyncStorage): InstallationStore {
  const chains = new Map<string, Promise<unknown>>();
  return {
    mutate(profileId, guardCurrent, reducer) {
      type Out = Awaited<ReturnType<InstallationStore["mutate"]>>;
      const previous = chains.get(profileId) ?? Promise.resolve();
      const run = previous.catch(() => undefined).then(async (): Promise<Out> => {
        if (!guardCurrent()) return { kind: "cancelled", at: "after-lock" };
        let raw: string | null;
        try { raw = await storage.get(installationKey(profileId)); } catch { return { kind: "unsupported", reason: "storage-read" }; }
        const current = parseInstallation(raw, profileId);
        if (current === "invalid") return { kind: "conflict", record: null, reason: "invalid" };
        if (!guardCurrent()) return { kind: "cancelled", at: "after-lock" };
        const made = reducer(current) as Record<string, unknown>;
        if ("conflict" in made) return { kind: "conflict", record: current, reason: made.conflict as string };
        if (made.keep === true) return { kind: "current", record: current, result: made.result };
        if (!guardCurrent()) return { kind: "cancelled", at: "before-write" };
        try { await writeInstallation(storage, made.write as Installation); } catch { return { kind: "unsupported", reason: "storage-write" }; }
        return { kind: "applied", record: made.write as Installation, result: made.result };
      });
      chains.set(profileId, run);
      return run as never;
    },
    async read(profileId): Promise<InstallationRead> {
      let raw: string | null;
      try { raw = await storage.get(installationKey(profileId)); } catch { return { kind: "unavailable", reason: "read-failed" }; }
      const record = parseInstallation(raw, profileId);
      return record === "invalid" ? { kind: "invalid" } : { kind: "current", record };
    },
    async forget(profileId): Promise<ForgetOutcome> {
      let count = 0;
      for (const id of new Set([profileId, profileId.toLowerCase()])) {
        if (await storage.get(installationKey(id)) !== null) { count += 1; await storage.remove(installationKey(id)); }
      }
      return { kind: "removed", count };
    },
  };
}

/** An EntryController of a unit test with the explicit single-context store over its own AsyncStorage. */
export class TestEntryController extends EntryController {
  constructor(options: EntryControllerOptions) {
    super({ ...options, installationStore: options.installationStore ?? contextInstallationStore(options.storage) });
  }
}
