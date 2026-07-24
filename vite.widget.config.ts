import { resolve } from "node:path";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defineConfig } from "vite";

// Bundles the meal-plan widget (resources/meal-plan) into a single self-contained
// HTML file at dist/widget/index.html — no external asset requests, so it renders
// under the MCP Apps sandbox CSP. The build:widget npm script renames the output
// to meal-plan.html, which the ui:// resource serves.
export default defineConfig({
  root: resolve(__dirname, "resources/meal-plan"),
  plugins: [viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "dist/widget"),
    emptyOutDir: true,
    target: "es2022",
    // Inline everything; no asset size threshold.
    assetsInlineLimit: 100_000_000,
  },
});
