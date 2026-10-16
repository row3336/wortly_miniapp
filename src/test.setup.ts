// Vitest setup of every test file (vite.config.ts test.setupFiles).
import { beforeEach } from "vitest";
import { installTestPageGate } from "./app/pageGate.test-support";
import { installationProvider } from "./app/installationProvider";
import { installAppInstallationStore, resetAppInstallationIdb } from "./app/installationApp.test-support";

installTestPageGate();

// C163 integration: jsdom has no indexedDB. The App's installation store is the product store over the IndexedDB double
// (app/installationApp.test-support.ts): a fresh one per test, shared by the Apps it renders, with the page's
// localStorage as the store's lazy legacy getter. navigator/window stay as jsdom gives them.
beforeEach(() => { resetAppInstallationIdb(); });
installAppInstallationStore(installationProvider);
