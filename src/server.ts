#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPrompts } from "./prompts.js";
import { registerDealTools } from "./tools/deals.js";
import { registerHouseholdTools } from "./tools/household.js";
import { registerRecipeTools } from "./tools/recipes.js";
import { registerScoringTools } from "./tools/scoring.js";
import { registerShoppingTools } from "./tools/shopping.js";
import { registerTrackingTools } from "./tools/tracking.js";
import { SERVER_VERSION } from "./version.js";

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TilbudsTrolden MCP server v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
