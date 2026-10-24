import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // No test reaches the internet (loopback only): see tests/setup/noNetwork.ts.
    setupFiles: ["tests/setup/noNetwork.ts"],
    testTimeout: 10_000
  }
});
