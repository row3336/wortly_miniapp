import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.WORTLY_VITE_CACHE_DIR,
  test: {
    environment: "jsdom",
    // The App tests' page gate: a real write gate on a fast clock (src/app/pageGate.test-support.ts).
    setupFiles: ["src/test.setup.ts"],
  },
});
