import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "false",
      // Tests must never reach TypeSafe; Jev tool selection falls back without a key.
      TYPESAFE_API_KEY: "",
    },
    hookTimeout: 30_000,
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/shared/vitest.global-setup.ts"],
    pool: "forks",
    runner: "./test/shared/vitest.runner.ts",
    setupFiles: ["./test/shared/vitest.setup.ts"],
    teardownTimeout: 10_000,
    testTimeout: 5_000,
  },
});
