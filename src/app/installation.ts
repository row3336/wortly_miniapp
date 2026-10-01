import type { AsyncStorage } from "../platform/storage";

export type Installation = {
  profileId: string;
  clientInstanceId: string;
  registrationId: string;
  proof: string | null;
  proofVersion: string | null;
  activated: boolean;
};

function key(profileId: string): string {
  return `wortly.installation:${profileId}`;
}

export function newerVersion(left: string, right: string): boolean {
  if (!/^[1-9][0-9]{0,18}$/.test(left) || !/^[1-9][0-9]{0,18}$/.test(right)) throw new Error("Invalid version");
  return BigInt(left) > BigInt(right);
}

export async function readInstallation(storage: AsyncStorage, profileId: string): Promise<Installation | null> {
  const raw = await storage.get(key(profileId));
  if (raw === null) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid installation"); }
  if (typeof value !== "object" || value === null) throw new Error("Invalid installation");
  const item = value as Record<string, unknown>;
  if (item.profileId !== profileId || typeof item.clientInstanceId !== "string"
    || typeof item.registrationId !== "string" || typeof item.activated !== "boolean"
    || !(item.proof === null || typeof item.proof === "string")
    || !(item.proofVersion === null || typeof item.proofVersion === "string" && /^[1-9][0-9]{0,18}$/.test(item.proofVersion))) {
    throw new Error("Invalid installation");
  }
  return item as Installation;
}

export async function writeInstallation(storage: AsyncStorage, installation: Installation): Promise<void> {
  await storage.set(key(installation.profileId), JSON.stringify(installation));
}
