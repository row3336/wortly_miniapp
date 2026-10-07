import { record } from "../api/wireValidation";

/**
 * json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) of core identity.intent_hash:
 * JSON.stringify escapes strings the same way (control characters, quotes, backslash; nothing else).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hex SHA-256 of core identity.intent_hash(kind, payload); origin and command ID are never part of it. */
export async function intentHash(kind: string, payload: Record<string, unknown>): Promise<string> {
  const text = canonicalJson({ kind, payload });
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
