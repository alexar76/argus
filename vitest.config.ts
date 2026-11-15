import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The checkout fixtures drive a local browser stand-in and the keystore tests derive post-quantum
    // keys; on a busy host (load average 35-49 on 2026-11-15) 5 s per test was not enough and a
    // different handful timed out on every full run while each file passed alone.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  coverage: {
    provider: "v8",
    reporter: ["text", "json-summary"],
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.d.ts", "src/cli.ts"],
  },
});
