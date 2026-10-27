import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = import.meta.dirname;

// Pages (popup/options) and the module service worker share one build.
// Content scripts cannot be ES modules, so they get separate IIFE builds
// once adapters exist (stage 2+).
export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
    target: "chrome120",
    modulePreload: false,
    rolldownOptions: {
      input: {
        popup: resolve(root, "popup.html"),
        options: resolve(root, "options.html"),
        background: resolve(root, "src/background/index.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
