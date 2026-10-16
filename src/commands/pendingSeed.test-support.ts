// Tests only: the stored form of pending records under the profile addressing (project_pending_profile_slots.md §2),
// through the one encoder of the product (pendingSlot.ts encodePending). Seed and read like the product, never by hand.
import { encodePending, pointerKeyOf } from "./pendingSlot";

type Writable = { set(key: string, value: string): unknown };
type Readable = { get(key: string): string | null | undefined };

/** Puts one record of base (`wortly.pending.<L>`) as its pointer and, for a text, its payload. */
export function seedPending(target: Writable, base: string, record: { profileId: string } & Record<string, unknown>): void {
  const stored = encodePending(base, record);
  if (stored.payloadKey && stored.payload) target.set(stored.payloadKey, stored.payload);
  target.set(stored.pointerKey, stored.pointer);
}
/** The record of profileId stored under base, joined back with its payload; null when there is no pointer. */
export function readPending(source: Readable, base: string, profileId: string): Record<string, unknown> | null {
  const raw = source.get(pointerKeyOf(base, profileId));
  if (raw === null || raw === undefined) return null;
  const pointer = JSON.parse(raw) as { record: Record<string, unknown>; payloadKey?: string };
  if (!pointer.payloadKey) return pointer.record;
  const payload = source.get(pointer.payloadKey);
  if (payload === null || payload === undefined) return { ...pointer.record, lostEnvelope: true };
  const intent = pointer.record.intent as Record<string, unknown>;
  return { ...pointer.record, intent: { ...intent, payload: { ...(intent.payload as object), ...(JSON.parse(payload) as object) } } };
}
export { pointerKeyOf };

type Values = Map<string, string>;
const pointerPrefix = (base: string) => `${base}:profile:`;
/** Whether any profile has a pointer of base (the former «the slot is filled»). */
export function hasPending(values: Values, base: string): boolean {
  return [...values.keys()].some(key => key.startsWith(pointerPrefix(base)));
}
/** The one stored record of base as JSON (joined with its text), as the former raw slot value; undefined: none. */
export function pendingRaw(values: Values, base: string): string | undefined {
  const keys = [...values.keys()].filter(key => key.startsWith(pointerPrefix(base)));
  if (keys.length !== 1) return keys.length === 0 ? undefined : `ambiguous:${keys.length}`;
  const raw = values.get(keys[0])!;
  let pointer: { record?: { profileId?: unknown } };
  try { pointer = JSON.parse(raw); } catch { return raw; }
  const profileId = pointer?.record?.profileId;
  if (typeof profileId !== "string") return raw;
  return JSON.stringify(readPending(values, base, profileId));
}
/** Seeds a former raw slot value: a record (with its profileId) in the stored form; anything else as a damaged pointer of profileId. */
export function seedRaw(values: Values, base: string, raw: string, profileId: string): void {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { values.set(pointerKeyOf(base, profileId), raw); return; }
  const item = value as { profileId?: unknown } | null;
  if (item === null || typeof item !== "object" || typeof item.profileId !== "string") { values.set(pointerKeyOf(base, profileId), raw); return; }
  // A record with a profileId that is no UUID cannot have its own key: it is damage under the given profile.
  try { seedPending(values, base, value as { profileId: string } & Record<string, unknown>); }
  catch { values.set(pointerKeyOf(base, profileId), JSON.stringify({ schemaVersion: 2, record: value })); }
}
