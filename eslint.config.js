import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { module: "writable", require: "readonly" },
    },
  },
  {
    files: ["**/scripts/**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    // shared and core must stay environment-agnostic (see AGENT_PROMPT §3).
    files: ["packages/shared/src/**", "packages/core/src/**"],
    rules: {
      "no-restricted-globals": ["error", "chrome", "window", "document", "process", "Buffer"],
      "no-restricted-imports": [
        "error",
        { patterns: ["node:*", "fs", "path", "crypto", "http", "https"] },
      ],
    },
  },
  prettier,
);
