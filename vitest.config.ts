import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The E2E scenarios only (AGENTS.md, "Tests"): 60 seconds each, never retried.
    // A scenario is e2e/<name>.test.ts; task check:tests-in-e2e refuses a test file anywhere else.
    include: ["e2e/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    retry: 0,
  },
});
