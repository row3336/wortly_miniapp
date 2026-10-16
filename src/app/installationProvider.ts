import type { InstallationStore } from "./installationStore";
import { idbInstallationStore, probeIndexedDb } from "./installationStoreIdb";

/**
 * C163 integration (store canon ред.1.4 §1, §5; C435): how App makes the installation store of its page — IndexedDB
 * through the store's own safe probe (a throwing `indexedDB` getter is "error" → unavailable and a controlled screen, never
 * "absent"); the page's localStorage only as a LAZY getter, read by the store's import (§3) and the read-only path of §5.
 * The localStorage prototype (installationStoreLs.test-support.ts) is never imported here. App tests replace make()
 * (src/test.setup.ts) with the same store over the IndexedDB double.
 */
export const installationProvider = {
  make(): InstallationStore { return idbInstallationStore(probeIndexedDb(window), () => window.localStorage); },
};
