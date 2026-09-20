import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Contact-card integration tests spawn the real CLI on clean checkouts too.
    globalSetup: ["../cli/test/globalSetup.ts"],
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
