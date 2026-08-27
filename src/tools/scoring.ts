import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Offer } from "../api.js";
import { searchDealsBatch } from "../api.js";
import { getLocale, type Locale } from "../locales.js";
import {
  calculateBasketCost,
  computeIngredientCost,
  type DealCandidate,
  expandSearchTerms,
  findBestDeal,
  findOptimalWeek,
  type ScoredIngredient,
  type ScoredRecipe,
} from "../scoring.js";
import * as store from "../store.js";
import { errorResult } from "./shared.js";

/** Everything a recipe needs to be scored against the current deal map */
interface ScoringContext {
  dealMap: Map<string, Offer[]>;
  preferredStoreNames: Set<string>;
  pantrySet: Set<string>;
  householdSize: number;
  locale?: Locale;
}

/** Map the low-confidence alternatives onto the reportable candidate shape */
function toDealCandidates(result: ReturnType<typeof findBestDeal>): DealCandidate[] | undefined {
  if (result.confidence !== "low") return undefined;
  return result.candidates.map((c) => ({
    heading: c.offer.heading,
    price: c.offer.price ?? 0,
    store: c.offer.store,
    score: c.score,
  }));
}

function scoreOneIngredient(
  ing: store.Ingredient,
  servings: number,
  ctx: ScoringContext,
): ScoredIngredient {
  const result = findBestDeal(ing, ctx.dealMap, ctx.preferredStoreNames, ctx.locale);
  const cost = result.best
    ? computeIngredientCost(result.best, ing.quantity, servings, ctx.householdSize)
    : 0;

  return {
    name: ing.name,
    quantity: ing.quantity,
    category: ing.category,
    bestDeal: result.best
      ? {
          heading: result.best.heading,
          price: cost,
          store: result.best.store,
        }
      : null,
    estimatedCost: cost,
    confidence: result.confidence,
    candidates: toDealCandidates(result),
  };
}

function scoreOneRecipe(recipe: store.Recipe, ctx: ScoringContext): ScoredRecipe {
  let totalCost = 0;
  let withDeals = 0;
  let nonPantryCount = 0;
  const ingredients: ScoredIngredient[] = [];

  for (const ing of recipe.ingredients) {
    if (ctx.pantrySet.has(ing.name.toLowerCase())) continue;
    nonPantryCount++;

    const scoredIng = scoreOneIngredient(ing, recipe.servings, ctx);
    ingredients.push(scoredIng);
    if (scoredIng.bestDeal) {
      totalCost += scoredIng.estimatedCost;
      withDeals++;
    }
  }

  return {
    name: recipe.name,
    servings: recipe.servings,
    complexity: recipe.complexity,
    proteinType: recipe.proteinType,
    cuisineType: recipe.cuisineType,
    estimatedCost: Math.round(totalCost * 100) / 100,
    dealCoverage: nonPantryCount > 0 ? Math.round((withDeals / nonPantryCount) * 100) : 100,
    ingredients,
  };
}

interface ScoreResult {
  scored: ScoredRecipe[];
  dealMap: Map<string, Offer[]>;
}

/** Every unique, synonym-expanded search term across all non-pantry ingredients */
function collectSearchTerms(
  recipes: store.Recipe[],
  pantrySet: Set<string>,
  locale?: Locale,
): Set<string> {
  const allTerms = new Set<string>();
  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      if (pantrySet.has(ing.name.toLowerCase())) continue;
      for (const term of expandSearchTerms(ing.searchTerms, locale?.synonymMap)) {
        allTerms.add(term);
      }
    }
  }
  return allTerms;
}

export async function scoreAllRecipes(
  preferredStoreNames: Set<string>,
  pantrySet: Set<string>,
  householdSize: number,
  locale?: Locale,
): Promise<ScoreResult> {
  const recipes = await store.getRecipes();
  if (recipes.length === 0) return { scored: [], dealMap: new Map() };

  // Batch fetch all deals in parallel
  const allTerms = collectSearchTerms(recipes, pantrySet, locale);
  const countryId = locale?.country ?? "DK";
  const dealMap = await searchDealsBatch({
    queries: [...allTerms],
    limit: 8,
    country: countryId,
  });

  // Score each recipe
  const scored: ScoredRecipe[] = recipes.map((recipe) =>
    scoreOneRecipe(recipe, {
      dealMap,
      preferredStoreNames,
      pantrySet,
      householdSize,
      locale,
    }),
  );

  scored.sort((a, b) => {
    // Primary: higher deal coverage is better
    if (b.dealCoverage !== a.dealCoverage) return b.dealCoverage - a.dealCoverage;
    // Secondary: lower cost is better
    return a.estimatedCost - b.estimatedCost;
  });

  return { scored, dealMap };
}

function formatRecipeHeader(r: ScoredRecipe, currency: string): string[] {
  return [
    `## ${r.name} — ${Math.round(r.estimatedCost)} ${currency} (deals on ${r.dealCoverage}% of ingredients)`,
    `   ${r.complexity} | ${r.cuisineType} | ${r.proteinType} | ${r.servings} servings`,
  ];
}

function formatHighConfDeals(ingredients: ScoredIngredient[], currency: string): string[] {
  if (ingredients.length === 0) return [];
  const lines = [`   Deals:`];
  for (const i of ingredients) {
    const deal = i.bestDeal;
    if (!deal) continue;
    lines.push(
      `     ${i.name} (${i.quantity}): ${deal.heading} — ${Math.round(deal.price)} ${currency} @ ${deal.store}`,
    );
  }
  return lines;
}

function formatLowConfCandidates(candidates: DealCandidate[], currency: string): string[] {
  const lines = [`       Other candidates:`];
  for (const c of candidates.slice(1)) {
    lines.push(`         - ${c.heading} — ${c.price} ${currency} @ ${c.store} (score: ${c.score})`);
  }
  return lines;
}

function formatLowConfDeal(i: ScoredIngredient, currency: string): string[] {
  const deal = i.bestDeal;
  if (!deal) return [];
  const lines = [
    `     ${i.name} (${i.quantity}): ${deal.heading} — ${Math.round(deal.price)} ${currency} @ ${deal.store} [low confidence]`,
  ];
  if (i.candidates && i.candidates.length > 1) {
    lines.push(...formatLowConfCandidates(i.candidates, currency));
  }
  return lines;
}

function formatLowConfDeals(ingredients: ScoredIngredient[], currency: string): string[] {
  if (ingredients.length === 0) return [];
  const lines = [`   ⚠ Uncertain matches (verify these):`];
  for (const i of ingredients) {
    lines.push(...formatLowConfDeal(i, currency));
  }
  return lines;
}

function formatNoDealItems(ingredients: ScoredIngredient[]): string[] {
  if (ingredients.length === 0) return [];
  return [`   No deals: ${ingredients.map((i) => `${i.name} (${i.quantity})`).join(", ")}`];
}

function formatRecipeScore(r: ScoredRecipe, currency = "DKK"): string[] {
  const high = r.ingredients.filter((i) => i.confidence === "high");
  const low = r.ingredients.filter((i) => i.confidence === "low");
  const none = r.ingredients.filter((i) => i.confidence === "none");

  return [
    ...formatRecipeHeader(r, currency),
    ...formatHighConfDeals(high, currency),
    ...formatLowConfDeals(low, currency),
    ...formatNoDealItems(none),
    "",
  ];
}

function formatScoredRecipes(scored: ScoredRecipe[], currency = "DKK"): string {
  if (scored.length === 0) return "No recipes to score. Add recipes first.";

  const lines: string[] = [];
  for (const r of scored) {
    lines.push(...formatRecipeScore(r, currency));
  }
  return lines.join("\n");
}

interface ScoreRecipesArgs {
  optimize: boolean;
  days: number;
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  excludeProteins?: string[];
  allowProteinOnDays?: Record<string, number[]>;
  slowOnlyOnDays?: number[];
  preferCuisines?: Record<string, number>;
}

/** Render the optimized day-by-day plan, or an explanation of why none was found */
function formatOptimizedPlan(
  scored: ScoredRecipe[],
  args: ScoreRecipesArgs,
  locale: Locale,
): string[] {
  const { days } = args;
  const cur = locale.currency;
  const bestPlan = findOptimalWeek(scored, days, {
    maxPerProtein: args.maxPerProtein,
    maxPerCuisine: args.maxPerCuisine,
    maxSlowDays: args.maxSlowDays,
    excludeProteins: args.excludeProteins,
    allowProteinOnDays: args.allowProteinOnDays,
    slowOnlyOnDays: args.slowOnlyOnDays,
    preferCuisines: args.preferCuisines,
    ingredientTags: locale.ingredientTags,
  });

  if (!bestPlan) {
    return [
      "Could not find a valid combination with the variety constraints. Try relaxing maxPerProtein, maxPerCuisine, or maxSlowDays.",
    ];
  }

  const basket = calculateBasketCost(bestPlan.recipes);
  const lines = [`Total basket: ~${basket.totalCost} ${cur} for ${days} days`];
  if (basket.sharedSavings > 0) {
    lines.push(`Shared ingredient savings: ~${basket.sharedSavings} ${cur}`);
  }
  lines.push(`Unique items to buy: ${basket.uniqueIngredients}\n`);
  for (let i = 0; i < bestPlan.recipes.length; i++) {
    const r = bestPlan.recipes[i];
    lines.push(
      `Day ${i + 1}: ${r.name} (~${r.estimatedCost} ${cur}) [${r.proteinType}, ${r.cuisineType}, ${r.complexity}]`,
    );
  }
  return lines;
}

async function handleScoreRecipes(args: ScoreRecipesArgs) {
  try {
    const household = await store.getHousehold();
    const locale = getLocale(household.country);
    const pantry = await store.getPantry();
    const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
    const preferredStores = new Set(household.stores.map((s) => s.name));

    const householdSize = household.people.length || household.defaultServings;
    const { scored } = await scoreAllRecipes(preferredStores, pantrySet, householdSize, locale);

    const parts = [
      `# Recipe scores (${scored.length} recipes)\n`,
      formatScoredRecipes(scored, locale.currency),
    ];

    if (args.optimize && scored.length >= args.days) {
      parts.push(`\n# Optimized ${args.days}-day plan\n`);
      parts.push(...formatOptimizedPlan(scored, args, locale));
    }

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    };
  } catch (err) {
    return errorResult(`Failed to score recipes: ${err instanceof Error ? err.message : err}`);
  }
}

export function registerScoringTools(server: McpServer): void {
  server.registerTool(
    "score_recipes",
    {
      description:
        "Score all saved recipes against current deals, optionally optimize a weekly meal plan. USE WHEN: deciding what to cook based on current deals ('what's cheapest this week'), comparing recipe costs. NOT FOR: generating a shopping list (use generate_shopping_list or plan_and_shop). Shows deal coverage %, estimated cost, and confidence levels per ingredient.",
      inputSchema: {
        optimize: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also generate optimal weekly plan"),
        days: z.number().optional().default(7).describe("Days to plan (default 7)"),
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
        maxSlowDays: z
          .number()
          .optional()
          .default(2)
          .describe("Max slow-cook days in plan (default 2)"),
        excludeProteins: z
          .array(z.string())
          .optional()
          .describe(
            'Dietary exclusions. Checks both recipe type and individual ingredients. E.g. ["pork"] also catches bacon in vegetarian recipes. Options: pork, beef, lamb, fish, shellfish, dairy, gluten, beans, nuts, egg',
          ),
        allowProteinOnDays: z
          .record(z.string(), z.array(z.number()))
          .optional()
          .describe(
            'Per-day exceptions for excluded proteins (1-indexed). E.g. {"pork": [2]} = allow pork on day 2 (Tuesday)',
          ),
        slowOnlyOnDays: z
          .array(z.number())
          .optional()
          .describe(
            "Restrict slow recipes to these days only (1-indexed). E.g. [6, 7] for weekends",
          ),
        preferCuisines: z
          .record(z.string(), z.number())
          .optional()
          .describe(
            'Soft cuisine preferences: {"asian": 3} = prefer at least 3 Asian dishes. Best-effort, won\'t fail if impossible.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    handleScoreRecipes,
  );
}
