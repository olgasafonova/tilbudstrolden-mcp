import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerPrompts } from "./prompts.js";
import { registerDealTools } from "./tools/deals.js";
import { registerHouseholdTools } from "./tools/household.js";
import { registerMealPlanWidget } from "./tools/meal-plan-widget.js";
import { registerRecipeTools } from "./tools/recipes.js";
import { registerScoringTools } from "./tools/scoring.js";
import { registerShoppingTools } from "./tools/shopping.js";
import { registerTrackingTools } from "./tools/tracking.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as {
  version: string;
};

/**
 * Build a fully configured server instance (all tools, prompts, and the
 * meal-plan widget resource). A factory so the stateless HTTP transport can
 * spin up a fresh instance per request; stdio mode calls it once.
 */
export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "tilbudstrolden",
      version: SERVER_VERSION,
    },
    {
      instructions: `# TilbudsTrolden MCP - Nordic Grocery Deal Hunter

Find grocery deals across Denmark, Norway, Sweden, and Finland via etilbudsavis.dk. Score recipes against current deals, plan weekly meals, and generate deal-optimized shopping lists.

## Country support

- **DK** - full store directory and deals
- **NO**, **SE**, **FI** - curated grocery chains and deals; full store directory not exposed by the upstream API

Set country via update_household. Search terms must be in the local language (Danish, Norwegian, Swedish, or Finnish).

## Tool groups

### Deals
- search_deals: find products by keyword across stores
- get_store_offers: browse one store's catalog
- list_stores: discover dealer IDs for household setup
- deals_this_week: roll-up of preferred-store offers, with expiring deals flagged

### Household
- get_household / update_household: people, dietary restrictions, preferred stores, country, default servings

### Pantry
- get_pantry / update_pantry: staples to exclude from shopping lists

### Recipes
- get_recipes / add_recipe / remove_recipe: recipe library

### Planning and shopping
- score_recipes: score recipes against current deals; optionally generate an optimized weekly plan
- generate_shopping_list: deal-grouped shopping list for chosen recipes
- plan_and_shop: one-shot weekly plan plus shopping list (the main entry point)

### History
- log_meal / get_meal_history: track cooked meals to avoid repetition
- log_spend / get_spend_log: grocery budget tracking

## Workflow

First-time setup (the getting-started prompt walks the user through):
1. update_household (country, people, preferred stores)
2. update_pantry (salt, oil, etc.)
3. add_recipe (a few recipes)
4. plan_and_shop

Common queries:
- "Plan my week" -> plan_and_shop
- "What's on sale?" -> deals_this_week
- "Shopping list for Bolognese and Chili" -> generate_shopping_list
- "What should we cook?" -> score_recipes (optimize=true)

## Caveats

- Deal-aware tools require household stores to be configured first
- Search terms must be in the local language: 'hakket oksekød' (DK), 'kjøttdeig' (NO), 'köttfärs' (SE), 'jauheliha' (FI)
- Deals expiring within 2 days are flagged automatically
- Low-confidence ingredient matches are surfaced separately; verify before relying on them
`,
    },
  );

  registerPrompts(server);
  registerDealTools(server);
  registerHouseholdTools(server);
  registerRecipeTools(server);
  registerScoringTools(server);
  registerTrackingTools(server);
  registerShoppingTools(server);
  registerMealPlanWidget(server);

  return server;
}

/** Read a request body to a string (empty string when there is no body). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Serve the MCP server over Streamable HTTP (stateless). A fresh server +
 * transport is created per request, which is the SDK's recommended stateless
 * pattern and is all the widget render path (ext-apps basic-host / Claude
 * custom connector) needs. Additive: the default transport is still stdio.
 */
async function startHttp(port: number): Promise<void> {
  const httpServer = createHttpServer(async (req, res) => {
    // Permissive CORS so browser-based hosts (basic-host) can reach the server.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, mcp-session-id, mcp-protocol-version",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "";
    if (!url.startsWith("/mcp")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. MCP endpoint is /mcp." }));
      return;
    }

    try {
      const raw = await readBody(req);
      const body = raw.length > 0 ? JSON.parse(raw) : undefined;
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("HTTP request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(
      `TilbudsTrolden MCP server v${SERVER_VERSION} running on Streamable HTTP at http://localhost:${port}/mcp`,
    );
  });
}

async function main() {
  const httpFlag = process.argv.includes("--http");
  const portEnv = process.env.PORT;
  const useHttp = httpFlag || portEnv !== undefined;

  if (useHttp) {
    const port = portEnv ? Number.parseInt(portEnv, 10) : 3001;
    await startHttp(port);
    return;
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TilbudsTrolden MCP server v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
