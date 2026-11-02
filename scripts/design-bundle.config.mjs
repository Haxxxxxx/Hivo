// IIFE build of src/ui for the design-system artifact (`project/components/bundle.js`):
// assigns window.FLManagerUI and takes React from the page's window.React.
// Run after `npm run build && node scripts/design-lib.mjs`:
//   npx vite build --config scripts/design-bundle.config.mjs
// Output: .design-sync/lib/bundle-out/bundle.js (prepend the artifact's `/* @ds-bundle: … */` line).
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const lib = fileURLToPath(new URL("../.design-sync/lib/", import.meta.url));

export default defineConfig({
  root: lib,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "bundle-out",
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: "index.ts",
      name: "FLManagerUI",
      formats: ["iife"],
      fileName: () => "bundle.js",
    },
    rollupOptions: {
      external: ["react", "react-dom"],
      output: { globals: { react: "React", "react-dom": "ReactDOM" } },
    },
  },
});
