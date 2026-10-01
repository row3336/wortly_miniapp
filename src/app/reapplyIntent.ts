import type { AsyncStorage } from "../platform/storage";

export type ReapplyIntent = { profileId: string; commandId: string; expectedAccessVersion: string };

function key(profileId: string): string {
  return `wortly.reapply:${profileId}`;
}

export async function readReapplyIntent(storage: AsyncStorage, profileId: string): Promise<ReapplyIntent | null> {
  const raw = await storage.get(key(profileId));
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Invalid pending action"); }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid pending action");
  const value = parsed as Record<string, unknown>;
  if (value.profileId !== profileId || typeof value.commandId !== "string"
    || typeof value.expectedAccessVersion !== "string"
    || !/^[1-9][0-9]{0,18}$/.test(value.expectedAccessVersion)) throw new Error("Invalid pending action");
  return value as ReapplyIntent;
}

export async function writeReapplyIntent(storage: AsyncStorage, intent: ReapplyIntent): Promise<void> {
  await storage.set(key(intent.profileId), JSON.stringify(intent));
}

export async function clearReapplyIntent(storage: AsyncStorage, profileId: string): Promise<void> {
  await storage.remove(key(profileId));
}
