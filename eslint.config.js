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
  {
    // Platform-derived strings are rendered as text only (spec §10).
    files: ["packages/extension/src/**"],
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Render platform-derived strings as text.",
        },
        {
          selector:
            "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
          message: "Render platform-derived strings as text.",
        },
        {
          selector: "CallExpression[callee.property.name=/^(insertAdjacentHTML|write|writeln)$/]",
          message: "Render platform-derived strings as text.",
        },
      ],
    },
  },
  {
    // Content scripts and adapters run next to platform pages: no access to
    // stored tokens, settings or background state (spec §11).
    files: ["packages/extension/src/content/**", "packages/extension/src/adapters/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='chrome'][property.name='storage']",
          message: "Content scripts must not read extension storage (tokens live there).",
        },
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Render platform-derived strings as text.",
        },
        {
          selector:
            "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
          message: "Render platform-derived strings as text.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/storage.js", "**/background/**"],
              message: "Content scripts must not touch extension storage or background state.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
