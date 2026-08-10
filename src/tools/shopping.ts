import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Offer } from "../api.js";
import { searchDealsBatch } from "../api.js";
import { getLocale } from "../locales.js";
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
} from "../scoring.js";
import * as store from "../store.js";
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

/** Everything a single ingredient needs to be matched against deals and priced */
interface ShoppingContext {
  dealMap: Map<string, Offer[]>;
  preferredStores: Set<string>;
  locale: ReturnType<typeof getLocale>;
  householdSize: number;
}

function processIngredientForList(
  ing: AggregatedIngredient,
  ctx: ShoppingContext,
): IngredientShoppingResult {
  const { dealMap, preferredStores, locale, householdSize } = ctx;
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

  const tally = tallyIngredients(allIngredients, {
    dealMap,
    preferredStores,
    locale,
    householdSize,
  });

  return formatShoppingOutput({
    ...tally,
    selectedRecipes,
    householdSize,
    pantry,
    currencySymbol: locale.currencySymbol,
  });
}

/** Running totals collected while matching each ingredient against the deal map */
interface ShoppingTally {
  byStore: Map<string, string[]>;
  regularPrice: string[];
  uncertainItems: string[];
  expiringWarnings: string[];
  grandTotal: number;
}

function addToTally(tally: ShoppingTally, r: IngredientShoppingResult): void {
  tally.grandTotal += r.cost;
  if (r.expiring) tally.expiringWarnings.push(r.expiring);
  if (r.uncertain) tally.uncertainItems.push(r.uncertain);
  if (r.regular) tally.regularPrice.push(r.regular);
  if (r.storeName && r.storeLine) {
    const storeList = tally.byStore.get(r.storeName) ?? [];
    storeList.push(r.storeLine);
    tally.byStore.set(r.storeName, storeList);
  }
}

function tallyIngredients(
  allIngredients: Map<string, AggregatedIngredient>,
  ctx: ShoppingContext,
): ShoppingTally {
  const tally: ShoppingTally = {
    byStore: new Map(),
    regularPrice: [],
    uncertainItems: [],
    expiringWarnings: [],
    grandTotal: 0,
  };
  for (const [, ing] of allIngredients) {
    addToTally(tally, processIngredientForList(ing, ctx));
  }
  return tally;
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
    handleGenerateShoppingList,
  );

  server.tool(
    "plan_and_shop",
    "Score recipes, optimize a weekly meal plan, and generate a shopping list in one step. USE WHEN: 'plan my week', 'what should we eat?', 'make a meal plan with shopping list'. This is the main entry point for weekly dinner planning. NOT FOR: shopping for specific pre-chosen recipes (use generate_shopping_list). Returns meal plan (day-by-day with costs) followed by deal-optimized shopping list grouped by store.",
    {
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
    handlePlanAndShop,
  );
}
