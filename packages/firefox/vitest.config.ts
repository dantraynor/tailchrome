import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@tailchrome/shared": resolve(__dirname, "../shared/src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__test__/browser-mock.ts"],
  },
});
