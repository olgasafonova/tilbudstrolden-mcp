import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Offer } from "../api.js";
import { searchDealsBatch } from "../api.js";
import { getLocale } from "../locales.js";
import { buildMealPlanData } from "../meal-plan.js";
import {
  aggregateQuantities,
  calculateBasketCost,
  computeShoppingCost,
  computeShoppingCostFromTotal,
  expandSearchTerms,
  findBestDeal,
  findOptimalWeek,
  formatQuantity,
  parseQuantity,
  type ScoredRecipe,
} from "../scoring.js";
import * as store from "../store.js";
import { MEAL_PLAN_RESOURCE_URI } from "./meal-plan-widget.js";
import { scoreAllRecipes } from "./scoring.js";
import { daysUntilExpiry, errorResult, expiryTag } from "./shared.js";

/** Ingredient data aggregated across multiple recipes */
interface AggregatedIngredient {
  name: string;
  searchTerms: string[];
  category: string;
  contributions: Array<{
    quantity: string;
    recipeServings: number;
    recipeName: string;
  }>;
  fromRecipes: string[];
}

/** Collect and aggregate ingredients across recipes, skipping pantry items */
function mergeIntoExisting(
  existing: AggregatedIngredient,
  recipe: store.Recipe,
  ing: store.Ingredient,
): void {
  existing.fromRecipes.push(recipe.name);
  existing.contributions.push({
    quantity: ing.quantity,
    recipeServings: recipe.servings,
    recipeName: recipe.name,
  });
  for (const t of ing.searchTerms) {
    if (!existing.searchTerms.includes(t)) existing.searchTerms.push(t);
  }
}

function makeAggregated(recipe: store.Recipe, ing: store.Ingredient): AggregatedIngredient {
  return {
    name: ing.name,
    searchTerms: [...ing.searchTerms],
    category: ing.category,
    contributions: [
      {
        quantity: ing.quantity,
        recipeServings: recipe.servings,
        recipeName: recipe.name,
      },
    ],
    fromRecipes: [recipe.name],
  };
}

function collectIngredients(
  selectedRecipes: store.Recipe[],
  pantrySet: Set<string>,
): Map<string, AggregatedIngredient> {
  const allIngredients = new Map<string, AggregatedIngredient>();
  for (const recipe of selectedRecipes) {
    for (const ing of recipe.ingredients) {
      const key = ing.name.toLowerCase();
      if (pantrySet.has(key)) continue;
      const existing = allIngredients.get(key);
      if (existing) {
        mergeIntoExisting(existing, recipe, ing);
      } else {
        allIngredients.set(key, makeAggregated(recipe, ing));
      }
    }
  }
  return allIngredients;
}

/** Build human-readable display quantity, aggregating across recipes */
function buildDisplayQuantity(
  ing: AggregatedIngredient,
  householdSize: number,
): { displayQty: string; aggregated: ReturnType<typeof aggregateQuantities> } {
  const aggregated = aggregateQuantities(ing.contributions, householdSize);

  let displayQty: string;
  if (ing.contributions.length > 1 && aggregated) {
    const perRecipe = ing.contributions
      .map((c) => {
        const p = parseQuantity(c.quantity);
        if (!p) return c.quantity;
        const scale = c.recipeServings > 0 ? householdSize / c.recipeServings : 1;
        return formatQuantity(Math.round(p.amount * scale), p.unit);
      })
      .join(" + ");
    displayQty = `${perRecipe} = ${formatQuantity(aggregated.totalAmount, aggregated.unit)}`;
  } else if (aggregated) {
    displayQty = formatQuantity(aggregated.totalAmount, aggregated.unit);
  } else {
    displayQty = ing.contributions.map((c) => c.quantity).join(" + ");
  }

  return { displayQty, aggregated };
}

/** Format a single ingredient's deal match into a shopping list line */
function formatIngredientDeal(
  ing: AggregatedIngredient,
  best: Offer,
  confidence: "high" | "low",
  displayQty: string,
  aggregated: ReturnType<typeof aggregateQuantities>,
  householdSize: number,
  currencySymbol: string,
): { line: string; cost: number } {
  const storeName = best.store;
  const validTo = best.validUntil?.slice(0, 10) ?? "unknown";
  const conf = confidence === "low" ? " ⚠" : "";
  const expiry = expiryTag(best.validUntil);

  let shopping = aggregated
    ? computeShoppingCostFromTotal(best, aggregated.totalAmount, aggregated.unit)
    : null;
  if (!shopping) {
    shopping = computeShoppingCost(
      best,
      ing.contributions[0].quantity,
      ing.contributions[0].recipeServings,
      householdSize,
    );
  }

  if (shopping) {
    const packInfo =
      shopping.packsNeeded > 1
        ? `${shopping.packsNeeded} x ${shopping.pricePerPack} ${currencySymbol}`
        : `${shopping.pricePerPack} ${currencySymbol}`;
    const leftoverInfo =
      shopping.leftover > 0
        ? ` (${formatQuantity(shopping.leftover, shopping.unitNeeded)} leftover)`
        : "";
    return {
      line: `${ing.name}: need ${displayQty} -> ${packInfo} = ${shopping.totalCost} ${currencySymbol} [${formatQuantity(shopping.packSize, shopping.unitNeeded)}/pack${shopping.unitPrice ? `, ${shopping.unitPrice}` : ""}]${leftoverInfo} -- ${best.heading} @ ${storeName} until ${validTo}${expiry}${conf}`,
      cost: shopping.totalCost,
    };
  }

  return {
    line: `${ing.name} (${displayQty}): ${best.heading} - ${best.price} ${best.currency}${best.pricePerUnit ? ` (${best.pricePerUnit})` : ""} @ ${storeName} until ${validTo}${expiry}${conf}`,
    cost: best.price ?? 0,
  };
}

async function resolveDealMap(
  existingDealMap: Map<string, Offer[]> | undefined,
  ingredients: ReturnType<typeof collectIngredients>,
  locale: ReturnType<typeof getLocale>,
): Promise<Map<string, Offer[]>> {
  if (existingDealMap) return existingDealMap;
  const allSearchTerms = new Set<string>();
  for (const [, ing] of ingredients) {
    for (const term of expandSearchTerms(ing.searchTerms, locale.synonymMap))
      allSearchTerms.add(term);
  }
  return searchDealsBatch([...allSearchTerms], 8, locale.country);
}

interface IngredientShoppingResult {
  storeName?: string;
  storeLine?: string;
  regular?: string;
  uncertain?: string;
  expiring?: string;
  cost: number;
}

function uncertainAlternativesLine(
  ing: AggregatedIngredient,
  best: Offer,
  candidates: { offer: Offer; score: number }[],
): string {
  const alts = candidates
    .slice(1)
    .map((c) => `${c.offer.heading} - ${c.offer.price} ${c.offer.currency} @ ${c.offer.store}`)
    .join("; ");
  return `${ing.name}: picked "${best.heading}" but also found: ${alts}`;
}

function processIngredientForList(
  ing: AggregatedIngredient,
  dealMap: Map<string, Offer[]>,
  preferredStores: Set<string>,
  locale: ReturnType<typeof getLocale>,
  householdSize: number,
): IngredientShoppingResult {
  const result = findBestDeal(ing, dealMap, preferredStores, locale);
  const { displayQty, aggregated } = buildDisplayQuantity(ing, householdSize);

  if (!result.best) {
    return {
      regular: `${ing.name} (${displayQty}) [${ing.fromRecipes.join(", ")}]`,
      cost: 0,
    };
  }

  const best = result.best;
  const { line, cost } = formatIngredientDeal(
    ing,
    best,
    result.confidence as "high" | "low",
    displayQty,
    aggregated,
    householdSize,
    locale.currencySymbol,
  );

  const out: IngredientShoppingResult = {
    storeName: best.store,
    storeLine: line,
    cost,
  };

  if (daysUntilExpiry(best.validUntil) <= 2) {
    const validTo = best.validUntil?.slice(0, 10) ?? "unknown";
    out.expiring = `${ing.name}: deal at ${best.store} ${expiryTag(best.validUntil).trim().toLowerCase()} (${validTo})`;
  }

  if (result.confidence === "low" && result.candidates.length > 1) {
    out.uncertain = uncertainAlternativesLine(ing, best, result.candidates);
  }

  return out;
}

/** Build the shopping list output shared by generate_shopping_list and plan_and_shop */
async function buildShoppingList(
  selectedRecipes: store.Recipe[],
  householdSize: number,
  existingDealMap?: Map<string, Offer[]>,
  excludePantry = true,
): Promise<string> {
  const pantry = excludePantry ? await store.getPantry() : [];
  const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
  const household = await store.getHousehold();
  const locale = getLocale(household.country);
  const preferredStores = new Set(household.stores.map((s) => s.name));

  const allIngredients = collectIngredients(selectedRecipes, pantrySet);
  if (allIngredients.size === 0) {
    return "All ingredients are in your pantry. Nothing to buy!";
  }

  const dealMap = await resolveDealMap(existingDealMap, allIngredients, locale);

  const byStore = new Map<string, string[]>();
  const regularPrice: string[] = [];
  const uncertainItems: string[] = [];
  const expiringWarnings: string[] = [];
  let grandTotal = 0;

  for (const [, ing] of allIngredients) {
    const r = processIngredientForList(ing, dealMap, preferredStores, locale, householdSize);
    grandTotal += r.cost;
    if (r.expiring) expiringWarnings.push(r.expiring);
    if (r.uncertain) uncertainItems.push(r.uncertain);
    if (r.regular) regularPrice.push(r.regular);
    if (r.storeName && r.storeLine) {
      const storeList = byStore.get(r.storeName) ?? [];
      storeList.push(r.storeLine);
      byStore.set(r.storeName, storeList);
    }
  }

  return formatShoppingOutput({
    selectedRecipes,
    householdSize,
    grandTotal,
    byStore,
    regularPrice,
    uncertainItems,
    expiringWarnings,
    pantry,
    currencySymbol: locale.currencySymbol,
  });
}

function bulletSection(header: string, items: string[]): string[] {
  if (items.length === 0) return [];
  const lines = [header];
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
  return lines;
}

function storeSection(storeName: string, items: string[]): string[] {
  const lines = [`## ${storeName} (${items.length} items)`];
  for (let i = 0; i < items.length; i++) {
    lines.push(`${i + 1}. ${items[i]}`);
  }
  lines.push("");
  return lines;
}

function findSkippedPantry(pantry: string[], recipes: store.Recipe[]): string[] {
  return pantry.filter((p) =>
    recipes.some((r) => r.ingredients.some((i) => i.name.toLowerCase() === p.toLowerCase())),
  );
}

/** Format the final shopping list text from categorized data */
function formatShoppingOutput(ctx: {
  selectedRecipes: store.Recipe[];
  householdSize: number;
  grandTotal: number;
  byStore: Map<string, string[]>;
  regularPrice: string[];
  uncertainItems: string[];
  expiringWarnings: string[];
  pantry: string[];
  currencySymbol: string;
}): string {
  const parts: string[] = [
    `Shopping list for: ${ctx.selectedRecipes.map((r) => r.name).join(", ")} (${ctx.householdSize} people)`,
    `Estimated register total (deals only): ~${Math.round(ctx.grandTotal)} ${ctx.currencySymbol}`,
    "",
  ];

  parts.push(...bulletSection(`## ⏰ Buy first (expiring soon)`, ctx.expiringWarnings));

  for (const [storeName, items] of ctx.byStore) {
    parts.push(...storeSection(storeName, items));
  }

  parts.push(
    ...bulletSection(
      `## Buy at regular price (${ctx.regularPrice.length} items)`,
      ctx.regularPrice,
    ),
  );
  parts.push(...bulletSection(`## ⚠ Uncertain matches (verify these)`, ctx.uncertainItems));

  const skippedPantry = findSkippedPantry(ctx.pantry, ctx.selectedRecipes);
  if (skippedPantry.length > 0) {
    parts.push(`## Skipped (in pantry): ${skippedPantry.join(", ")}`);
  }

  return parts.join("\n");
}

/** Build the human-readable meal-plan header lines (before the shopping list). */
function formatPlanHeader(
  recipes: ScoredRecipe[],
  basket: { totalCost: number; sharedSavings: number },
  days: number,
  householdSize: number,
  cur: string,
): string[] {
  const lines: string[] = [`# ${days}-day meal plan (${householdSize} people)\n`];
  lines.push(`Estimated basket: ~${basket.totalCost} ${cur}`);
  if (basket.sharedSavings > 0) {
    lines.push(`Shared ingredient savings: ~${basket.sharedSavings} ${cur}`);
  }
  lines.push("");
  recipes.forEach((r, i) => {
    lines.push(
      `Day ${i + 1}: ${r.name} (~${r.estimatedCost} ${cur}) [${r.proteinType}, ${r.cuisineType}, ${r.complexity}]`,
    );
  });
  return lines;
}

export function registerShoppingTools(server: McpServer): void {
  server.tool(
    "generate_shopping_list",
    "Deal-optimized shopping list from specific recipes, grouped by store. USE WHEN: preparing to shop for chosen recipes ('shopping list for Bolognese and Chili'). Aggregates quantities across recipes, computes pack sizes, flags expiring deals. NOT FOR: deciding what to cook (use score_recipes or plan_and_shop first). Requires recipes to exist (see add_recipe).",
    {
      recipes: z.array(z.string()).describe("Recipe names"),
      people: z.number().optional().describe("Household size (overrides stored household config)"),
      excludePantry: z
        .boolean()
        .optional()
        .default(true)
        .describe("Skip pantry items (default true)"),
    },
    async ({ recipes: recipeNames, people, excludePantry }) => {
      try {
        const allRecipes = await store.getRecipes();

        const selectedRecipes = allRecipes.filter((r) =>
          recipeNames.some((n) => r.name.toLowerCase() === n.toLowerCase()),
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

        const text = await buildShoppingList(
          selectedRecipes,
          householdSize,
          undefined,
          excludePantry,
        );
        return {
          content: [{ type: "text" as const, text }],
        };
      } catch (err) {
        return errorResult(
          `Failed to generate shopping list: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );

  // Registered via registerAppTool so hosts that support MCP Apps render the
  // meal-plan widget (ui://meal-plan/view.html) from the structured payload.
  // Non-widget hosts still receive the text content, unchanged.
  registerAppTool(
    server,
    "plan_and_shop",
    {
      title: "Plan and shop",
      description:
        "Score recipes, optimize a weekly meal plan, and generate a shopping list in one step. USE WHEN: 'plan my week', 'what should we eat?', 'make a meal plan with shopping list'. This is the main entry point for weekly dinner planning. NOT FOR: shopping for specific pre-chosen recipes (use generate_shopping_list). Returns meal plan (day-by-day with costs) followed by deal-optimized shopping list grouped by store.",
      _meta: { ui: { resourceUri: MEAL_PLAN_RESOURCE_URI } },
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
    },
    async ({
      days,
      people,
      maxPerProtein,
      maxPerCuisine,
      maxSlowDays,
      excludeProteins,
      slowOnlyOnDays,
      preferCuisines,
    }) => {
      try {
        const household = await store.getHousehold();
        const locale = getLocale(household.country);
        const cur = locale.currency;
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
          maxPerProtein,
          maxPerCuisine,
          maxSlowDays,
          excludeProteins,
          slowOnlyOnDays,
          preferCuisines,
          ingredientTags: locale.ingredientTags,
        });

        if (!bestPlan) {
          return errorResult(
            "Could not find a valid meal plan with the variety constraints. Try relaxing maxPerProtein, maxPerCuisine, or maxSlowDays.",
          );
        }

        const basket = calculateBasketCost(bestPlan.recipes);
        const parts: string[] = formatPlanHeader(
          bestPlan.recipes,
          basket,
          days,
          householdSize,
          cur,
        );

        // Generate shopping list for the planned recipes
        const allRecipes = await store.getRecipes();
        const plannedRecipes = allRecipes.filter((r) =>
          bestPlan.recipes.some((p) => p.name.toLowerCase() === r.name.toLowerCase()),
        );

        parts.push("\n---\n");
        const shoppingList = await buildShoppingList(plannedRecipes, householdSize, cachedDeals);
        parts.push(shoppingList);

        // Structured payload for the MCP Apps meal-plan widget. Backward
        // compatible: text content is unchanged for non-widget hosts.
        const mealPlan = buildMealPlanData(
          bestPlan.recipes,
          basket,
          householdSize,
          cur,
          locale.currencySymbol,
        );

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          structuredContent: mealPlan as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return errorResult(`Failed to plan: ${err instanceof Error ? err.message : err}`);
      }
    },
  );
}
