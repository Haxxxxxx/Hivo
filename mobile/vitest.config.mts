import { defineConfig } from "vitest/config";

// Unit tests for the pure modules in src/lib and src/components and the Expo config plugins
// (no React Native in here).
export default defineConfig({
  test: { include: ["src/lib/**/*.test.ts", "src/components/**/*.test.ts", "plugins/**/*.test.mjs"], environment: "node" },
});
