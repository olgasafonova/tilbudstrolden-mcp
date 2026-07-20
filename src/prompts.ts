import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** MCP prompts (workflow templates) */
export function registerPrompts(server: McpServer): void {
  server.prompt(
    "getting-started",
    "Set up TilbudsTrolden for first use: household, stores, recipes, pantry",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Help me set up TilbudsTrolden for meal planning. Walk me through these steps:

1. Set my country (DK, NO, SE, or FI) and household (who lives here, dietary restrictions) using update_household
2. Configure preferred stores (use list_stores to find IDs, then update_household)
3. Add my pantry staples using update_pantry (things I always have: salt, pepper, oil, etc.)
4. Add a few recipes using add_recipe
5. Test it by running plan_and_shop to get a meal plan with shopping list

Ask me questions at each step. Start with: which country are you in, and how many people in your household?`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "meal-plan",
    "Generate a weekly meal plan with an optimized shopping list",
    {
      days: z.string().optional().describe("Number of days to plan (default 7)"),
    },
    ({ days }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Plan ${days || "7"} days of dinners for my household. Use plan_and_shop to:
1. Score all my recipes against current grocery deals
2. Pick the cheapest combination that has good variety (different proteins, cuisines)
3. Generate a shopping list grouped by store

Show me the plan first, then the shopping list. Flag any deals expiring soon so I know what to buy first.`,
          },
        },
      ],
    }),
  );

  server.prompt(
    "deal-scout",
    "Find what's cheap this week and suggest meals around the deals",
    {},
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Check what's on sale at my preferred stores using deals_this_week. Then look at my saved recipes and suggest which ones would be cheapest to cook this week based on the current deals. Focus on ingredients with the best discounts.`,
          },
        },
      ],
    }),
  );
}
