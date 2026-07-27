import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      // Report on every source file, not just the ones a test happened to import.
      // Without `all`, untested modules are absent from the report rather than
      // showing as 0%, which reads as better coverage than there is.
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "test/**"],
      reporter: ["text", "json-summary"],
    },
  },
});
