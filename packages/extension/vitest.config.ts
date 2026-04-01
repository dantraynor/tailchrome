import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@tailchrome/shared": resolve(__dirname, "../shared/src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: [
      "../shared/src/__test__/chrome-mock.ts",
      "src/__test__/browser-mock.ts",
    ],
  },
});
