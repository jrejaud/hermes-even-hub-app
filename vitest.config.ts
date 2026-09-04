import { defineConfig } from "vitest/config";

// The bridge is plain ESM run by `node --test` (no build step, no TS), so its
// tests must not be swept up by vitest — they use node:test, which vitest reads
// as "no test suite found".
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["bridge/**", "node_modules/**", "dist/**"],
  },
});
