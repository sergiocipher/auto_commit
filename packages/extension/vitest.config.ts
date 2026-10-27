import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "extension",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
