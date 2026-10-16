import type { AsyncStorage } from "../platform/storage";

/** A localStorage-like AsyncStorage of a test, with the log of its writes ("-key" for a removal). */
export function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  const storage: AsyncStorage = {
    async get(key) { return values.get(key) ?? null; },
    async set(key, value) { writes.push(key); values.set(key, value); },
    async remove(key) { writes.push(`-${key}`); values.delete(key); },
  };
  return { storage, values, writes };
}
