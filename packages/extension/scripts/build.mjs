// Builds the extension into dist/: one Vite build for the pages and the
// module service worker (vite.config.ts), then one single-file IIFE build per
// content script, because content scripts cannot be ES modules.
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const contentScripts = {
  leetcode: "src/content/leetcode.ts",
  "leetcode-main": "src/content/leetcode-main.ts",
};

await build({ root, configFile: resolve(root, "vite.config.ts"), logLevel: "warn" });

for (const [name, entry] of Object.entries(contentScripts)) {
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: "warn",
    envDir: root,
    build: {
      outDir: resolve(root, "dist/content"),
      emptyOutDir: false,
      target: "chrome120",
      minify: true,
      lib: {
        entry: resolve(root, entry),
        formats: ["iife"],
        name: `cst_${name.replace(/-/g, "_")}`,
        fileName: () => `${name}.js`,
      },
    },
  });
}
console.log(
  `built pages, service worker and ${Object.keys(contentScripts).length} content scripts`,
);
