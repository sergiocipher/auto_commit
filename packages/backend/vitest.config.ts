import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "backend",
    include: ["test/**/*.test.ts"],
    // Starts throwaway Postgres and Redis servers once for all test files.
    globalSetup: ["test/globalSetup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
