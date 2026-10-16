import type { InstallationStore } from "../app/installationStore";
import { validId } from "../commands/pendingSlot";
import type { AsyncStorage } from "../platform/storage";
import { wipeProfileRecords, type WipeResult } from "./profileWipe";

/**
 * The repeat of a deleted profile's cleanup by knowledge (P04 §3.7 (A) :383; project_installation_store.md ред.1.5 §6).
 * While THIS PAGE knows that X is deleted (PROFILE_DELETED, applied / already_applied, the PD-28 conclusion), every
 * trigger — the next sign-in, the page shown again, the store answering again — runs the whole cleanup of X once more and
 * checks the actual presence each time (forget, the keys). No «X is clean» flag and no tombstone: the knowledge lives in
 * this page's memory only, so a reload knows nothing (N11) and nothing is written to remember it.
 */
export class DeletedProfileCleanup {
  private readonly known = new Set<string>();
  private running: Promise<void> | null = null;
  private again = false;
  /** The last result per profile: diagnostics and tests only. */
  readonly last = new Map<string, WipeResult>();

  constructor(private readonly storage: AsyncStorage, private readonly store?: InstallationStore) {}

  /** X is deleted (this page saw it): clean now, and again on every later trigger. */
  note(profileId: string | null | undefined): Promise<void> {
    if (!profileId || !validId(profileId)) return this.running ?? Promise.resolve();
    this.known.add(profileId);
    return this.retry();
  }

  /** One more cleanup of every profile this page knows deleted; calls while one runs coalesce into one more round. */
  retry(): Promise<void> {
    if (this.known.size === 0) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    const run = (async () => {
      do {
        this.again = false;
        for (const profileId of [...this.known]) {
          this.last.set(profileId, await wipeProfileRecords(this.storage, profileId, this.store));
        }
      } while (this.again);
    })().finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return run;
  }

  knows(profileId: string): boolean { return this.known.has(profileId); }
}
