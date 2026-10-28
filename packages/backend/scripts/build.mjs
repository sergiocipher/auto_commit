// Bundles the backend into dist/cli.js. The workspace packages (@cst/core,
// @cst/shared) export TypeScript sources, so they are bundled in; runtime
// npm dependencies stay external and are installed in the image.
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@cst/"));

await rm(resolve(root, "dist"), { recursive: true, force: true });
await build({
  entryPoints: [resolve(root, "src/cli.ts")],
  outfile: resolve(root, "dist/cli.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  logLevel: "warning",
});
console.log(`built dist/cli.js (external: ${external.join(", ")})`);
