// C163 integration — the installation store of the App tests: the product store (installationStoreIdb.ts) over ONE
// IndexedDB double per test, shared by every App the test renders and kept across a fresh module graph (vi.resetModules
// models a reload of the page, and a reload keeps the origin's IndexedDB). src/test.setup.ts makes a new double before
// each test; a test that re-imports the App after vi.resetModules installs the store into the fresh provider again.
import { FakeIndexedDb } from "../commands/idbFake.test-support";
import { upgradeWrites } from "./installationIdb.test-support";
import { idbInstallationStore, INSTALLATION_DATABASE, INSTALLATION_STORE } from "./installationStoreIdb";
import type { InstallationStore } from "./installationStore";

const KEY = "__wortlyAppInstallationIdb";
type Holder = { [KEY]?: FakeIndexedDb };

export function resetAppInstallationIdb(): void { (globalThis as Holder)[KEY] = new FakeIndexedDb(); }
export function appInstallationIdb(): FakeIndexedDb {
  const holder = globalThis as Holder;
  return holder[KEY] ?? (holder[KEY] = new FakeIndexedDb());
}
/** The committed record of a profile in the App's installation database (undefined: none). */
export function appInstallationRow(profileId: string): unknown {
  return appInstallationIdb().rows(INSTALLATION_DATABASE, INSTALLATION_STORE).get(profileId);
}
export function installAppInstallationStore(provider: { make(): InstallationStore }): void {
  provider.make = () => idbInstallationStore(upgradeWrites(appInstallationIdb()), () => window.localStorage);
}
/** Every committed record of the App's installation database (a test reads the one installation it made). */
export function appInstallationRecords(): unknown[] {
  return [...appInstallationIdb().rows(INSTALLATION_DATABASE, INSTALLATION_STORE).values()];
}
