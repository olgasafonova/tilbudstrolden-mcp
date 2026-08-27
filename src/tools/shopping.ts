import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLocale } from "../locales.js";
import { calculateBasketCost, findOptimalWeek } from "../scoring.js";
import * as store from "../store.js";
import { scoreAllRecipes } from "./scoring.js";
import { errorResult } from "./shared.js";
import { buildShoppingList } from "./shopping-list.js";

interface ShoppingListArgs {
  recipes: string[];
  people?: number;
  excludePantry: boolean;
}

async function handleGenerateShoppingList({ recipes, people, excludePantry }: ShoppingListArgs) {
  try {
    const allRecipes = await store.getRecipes();

    const selectedRecipes = allRecipes.filter((r) =>
      recipes.some((n) => r.name.toLowerCase() === n.toLowerCase()),
    );

    if (selectedRecipes.length === 0) {
      const available = allRecipes.map((r) => r.name).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text: `No matching recipes found. Available: ${available || "none (add recipes first)"}`,
          },
        ],
      };
    }

    const household = await store.getHousehold();
    const householdSize = people ?? (household.people.length || household.defaultServings);

    const text = await buildShoppingList(selectedRecipes, householdSize, undefined, excludePantry);
    return {
      content: [{ type: "text" as const, text }],
    };
  } catch (err) {
    return errorResult(
      `Failed to generate shopping list: ${err instanceof Error ? err.message : err}`,
    );
  }
}

interface PlanArgs {
  days: number;
  people?: number;
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  excludeProteins?: string[];
  slowOnlyOnDays?: number[];
  preferCuisines?: Record<string, number>;
}

/** Render the day-by-day plan header, basket estimate, and one line per day */
function formatMealPlan(
  bestPlan: NonNullable<ReturnType<typeof findOptimalWeek>>,
  days: number,
  householdSize: number,
  currency: string,
): string[] {
  const parts: string[] = [`# ${days}-day meal plan (${householdSize} people)\n`];

  const basket = calculateBasketCost(bestPlan.recipes);
  parts.push(`Estimated basket: ~${basket.totalCost} ${currency}`);
  if (basket.sharedSavings > 0) {
    parts.push(`Shared ingredient savings: ~${basket.sharedSavings} ${currency}`);
  }
  parts.push("");

  for (let i = 0; i < bestPlan.recipes.length; i++) {
    const r = bestPlan.recipes[i];
    parts.push(
      `Day ${i + 1}: ${r.name} (~${r.estimatedCost} ${currency}) [${r.proteinType}, ${r.cuisineType}, ${r.complexity}]`,
    );
  }

  return parts;
}

async function handlePlanAndShop(args: PlanArgs) {
  try {
    const { days, people } = args;
    const household = await store.getHousehold();
    const locale = getLocale(household.country);
    const pantry = await store.getPantry();
    const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
    const preferredStores = new Set(household.stores.map((s) => s.name));
    const householdSize = people ?? (household.people.length || household.defaultServings);

    const { scored, dealMap: cachedDeals } = await scoreAllRecipes(
      preferredStores,
      pantrySet,
      householdSize,
      locale,
    );

    if (scored.length < days) {
      return errorResult(
        `Need at least ${days} recipes to plan ${days} days, but only ${scored.length} recipes exist. Add more with add_recipe.`,
      );
    }

    const bestPlan = findOptimalWeek(scored, days, {
      maxPerProtein: args.maxPerProtein,
      maxPerCuisine: args.maxPerCuisine,
      maxSlowDays: args.maxSlowDays,
      excludeProteins: args.excludeProteins,
      slowOnlyOnDays: args.slowOnlyOnDays,
      preferCuisines: args.preferCuisines,
      ingredientTags: locale.ingredientTags,
    });

    if (!bestPlan) {
      return errorResult(
        "Could not find a valid meal plan with the variety constraints. Try relaxing maxPerProtein, maxPerCuisine, or maxSlowDays.",
      );
    }

    const parts = formatMealPlan(bestPlan, days, householdSize, locale.currency);

    // Generate shopping list for the planned recipes
    const allRecipes = await store.getRecipes();
    const plannedRecipes = allRecipes.filter((r) =>
      bestPlan.recipes.some((p) => p.name.toLowerCase() === r.name.toLowerCase()),
    );

    parts.push("\n---\n");
    parts.push(await buildShoppingList(plannedRecipes, householdSize, cachedDeals));

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    };
  } catch (err) {
    return errorResult(`Failed to plan: ${err instanceof Error ? err.message : err}`);
  }
}

export function registerShoppingTools(server: McpServer): void {
  server.registerTool(
    "generate_shopping_list",
    {
      description:
        "Deal-optimized shopping list from specific recipes, grouped by store. USE WHEN: preparing to shop for chosen recipes ('shopping list for Bolognese and Chili'). Aggregates quantities across recipes, computes pack sizes, flags expiring deals. NOT FOR: deciding what to cook (use score_recipes or plan_and_shop first). Requires recipes to exist (see add_recipe).",
      inputSchema: {
        recipes: z.array(z.string()).describe("Recipe names"),
        people: z
          .number()
          .optional()
          .describe("Household size (overrides stored household config)"),
        excludePantry: z
          .boolean()
          .optional()
          .default(true)
          .describe("Skip pantry items (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    handleGenerateShoppingList,
  );

  server.registerTool(
    "plan_and_shop",
    {
      description:
        "Score recipes, optimize a weekly meal plan, and generate a shopping list in one step. USE WHEN: 'plan my week', 'what should we eat?', 'make a meal plan with shopping list'. This is the main entry point for weekly dinner planning. NOT FOR: shopping for specific pre-chosen recipes (use generate_shopping_list). Returns meal plan (day-by-day with costs) followed by deal-optimized shopping list grouped by store.",
      inputSchema: {
        days: z.number().optional().default(7).describe("Days to plan (default 7)"),
        people: z.number().optional().describe("Household size (overrides stored config)"),
        maxPerProtein: z
          .number()
          .optional()
          .default(2)
          .describe("Max same protein in plan (default 2)"),
        maxPerCuisine: z
          .number()
          .optional()
          .default(2)
          .describe("Max same cuisine in plan (default 2)"),
        maxSlowDays: z.number().optional().default(2).describe("Max slow-cook days (default 2)"),
        excludeProteins: z
          .array(z.string())
          .optional()
          .describe('Dietary exclusions, e.g. ["pork", "dairy"]. Also scans ingredient names.'),
        slowOnlyOnDays: z
          .array(z.number())
          .optional()
          .describe("Restrict slow recipes to these days (1-indexed). E.g. [6, 7]"),
        preferCuisines: z
          .record(z.string(), z.number())
          .optional()
          .describe('Soft cuisine preferences: {"asian": 3} = prefer at least 3 Asian dishes'),
      },
      annotations: { readOnlyHint: true },
    },
    handlePlanAndShop,
  );
}
