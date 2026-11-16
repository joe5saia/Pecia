import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    // The end-to-end tests run real git against a local server.
    testTimeout: 30_000,
  },
});
