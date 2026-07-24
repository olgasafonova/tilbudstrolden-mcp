// Registers the MCP Apps UI resource that serves the bundled meal-plan widget.
// The plan_and_shop tool references this URI via _meta.ui.resourceUri; the host
// fetches the resource and renders the HTML in a sandboxed iframe.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Canonical URI for the meal-plan widget resource. */
export const MEAL_PLAN_RESOURCE_URI = "ui://meal-plan/view.html";

/**
 * Candidate locations for the bundled single-file widget HTML.
 * Built by `npm run build:widget` (Vite + vite-plugin-singlefile) into dist/widget.
 * Resolved relative to this module first (works for the compiled dist/ server),
 * then relative to the current working directory (works for tsx dev mode).
 */
function candidatePaths(): string[] {
  const paths: string[] = [];
  try {
    paths.push(fileURLToPath(new URL("../widget/meal-plan.html", import.meta.url)));
  } catch {
    // import.meta.url not a file URL; skip
  }
  paths.push(new URL("dist/widget/meal-plan.html", `file://${process.cwd()}/`).pathname);
  return paths;
}

let cachedHtml: string | null = null;

/** Read the bundled widget HTML, caching the first successful read. */
async function loadWidgetHtml(): Promise<string> {
  if (cachedHtml !== null) return cachedHtml;

  const tried: string[] = [];
  for (const path of candidatePaths()) {
    tried.push(path);
    try {
      const html = await readFile(path, "utf-8");
      cachedHtml = html;
      return html;
    } catch {
      // try next candidate
    }
  }

  throw new Error(
    `Meal-plan widget bundle not found. Run \`npm run build:widget\` first. Looked in: ${tried.join(", ")}`,
  );
}

/** Register the ui:// resource that serves the meal-plan widget. */
export function registerMealPlanWidget(server: McpServer): void {
  registerAppResource(
    server,
    "Weekly Meal Plan",
    MEAL_PLAN_RESOURCE_URI,
    {
      description: "Interactive weekly meal-plan grid for plan_and_shop results",
    },
    async () => ({
      contents: [
        {
          uri: MEAL_PLAN_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await loadWidgetHtml(),
        },
      ],
    }),
  );
}
