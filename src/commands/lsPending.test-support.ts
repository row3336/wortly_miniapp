// Tests only: the pending records of the study lanes in window.localStorage (the App tests' storage) under the profile
// addressing, through pendingSeed.test-support (the product's own encoder) — the former raw shared-slot reads and writes.
import { hasPending, pendingRaw, pointerKeyOf, seedRaw } from "./pendingSeed.test-support";

function snapshot(): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key !== null) values.set(key, localStorage.getItem(key)!);
  }
  return values;
}
/** The one stored record of base joined with its content, as the former raw slot value; null: none. */
export function lsPendingRaw(base: string): string | null { return pendingRaw(snapshot(), base) ?? null; }
/** Whether any profile has a pointer of base. */
export function lsHasPending(base: string): boolean { return hasPending(snapshot(), base); }
/** Seeds a former raw slot value (a record, or damage under profileId) in the stored form. */
export function lsSeedRaw(base: string, raw: string, profileId: string): void {
  seedRaw({ set: (key: string, value: string) => { localStorage.setItem(key, value); } } as unknown as Map<string, string>, base, raw, profileId);
}
/** Removes the pointer of profileId of base (a payload of its command stays, as a lost envelope). */
export function lsRemovePointer(base: string, profileId: string): void { localStorage.removeItem(pointerKeyOf(base, profileId)); }
