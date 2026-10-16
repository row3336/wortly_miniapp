/** Values are scoped to this WebView installation. Credentials need a separate contract. */
export interface AsyncStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /**
   * The keys that start with prefix (project_pending_profile_slots.md §3.3: the payloads of one profile for wipe and Е02).
   * Optional: a storage without it cannot list, and its callers count that as a failure (residual (A)), never as «none».
   */
  keys?(prefix: string): Promise<string[]>;
}

export function browserStorage(storage: Storage): AsyncStorage {
  return {
    async get(key) {
      return storage.getItem(key);
    },
    async set(key, value) {
      storage.setItem(key, value);
    },
    async remove(key) {
      storage.removeItem(key);
    },
    async keys(prefix) {
      const found: string[] = [];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (key !== null && key.startsWith(prefix)) found.push(key);
      }
      return found;
    },
  };
}
