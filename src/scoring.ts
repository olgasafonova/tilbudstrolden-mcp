// Deal scoring and weekly meal plan optimization
// Extracted for testability; used by server.ts tool handlers.

import type { Offer } from "./api.js";
import type { Ingredient } from "./store.js";

// --- Types ---

export interface ScoredIngredient {
  name: string;
  quantity: string;
  category: string;
  bestDeal: { heading: string; price: number; store: string } | null;
  estimatedCost: number;
}

export interface ScoredRecipe {
  name: string;
  servings: number;
  complexity: string;
  proteinType: string;
  cuisineType: string;
  estimatedCost: number;
  dealCoverage: number;
  ingredients: ScoredIngredient[];
}

// --- Product form indicators ---

export const PROCESSED_INDICATORS = [
  "røget",
  "varmrøget",
  "koldrøget",
  "kold-",
  "marineret",
  "marinerede",
  "pålæg",
  "pålægssalat",
  "stegt",
  "paneret",
  "panerede",
  "gravad",
  "tørret",
  "dåse",
  "konserves",
  "salat",
  "postej",
  "leverpostej",
  "rullepølse",
  "spegepølse",
];

export const RAW_INDICATORS = [
  "hakket",
  "filet",
  "hel ",
  "hele ",
  "fersk",
  "frossen",
  "frosne",
  "rå",
  "udskæring",
  "strimler",
  "terninger",
  "skiver",
  "udbenede",
  "bryst",
  "overlår",
  "underlår",
  "lår",
  "mørbrad",
  "nakke",
  "bov",
];

// --- Scoring weights ---

export const SCORE = {
  BASE: 50,
  PREFERRED_STORE_BONUS: 10,
  NON_PREFERRED_PENALTY: -20,
  PROCESSED_PENALTY: -60,
  RAW_BONUS: 15,
  BUNDLE_UNCERTAINTY_PENALTY: -30,
  EXACT_MATCH_BONUS: 20,
  PARTIAL_MATCH_BONUS: 5,
  VIABILITY_THRESHOLD: 30,
} as const;

/**
 * Score how well a deal matches an ingredient for cooking.
 * Returns 0 (no match) to ~100 (perfect match).
 */
export function scoreDealMatch(
  offer: Offer,
  ingredient: Ingredient,
  searchTerm: string,
  preferredStores: Set<string>,
): number {
  if (offer.price === null || offer.price <= 0) return 0;

  const heading = offer.heading.toLowerCase();
  const term = searchTerm.toLowerCase();
  let score = SCORE.BASE;

  if (preferredStores.size > 0) {
    score += preferredStores.has(offer.store)
      ? SCORE.PREFERRED_STORE_BONUS
      : SCORE.NON_PREFERRED_PENALTY;
  }

  if (ingredient.category === "meat" || ingredient.category === "frozen") {
    const isProcessed = PROCESSED_INDICATORS.some((p) => heading.includes(p));
    const isRaw = RAW_INDICATORS.some((r) => heading.includes(r));

    if (isProcessed && !isRaw) {
      score += SCORE.PROCESSED_PENALTY;
    } else if (isRaw) {
      score += SCORE.RAW_BONUS;
    }

    if (heading.includes(" eller ") && isProcessed) {
      score += SCORE.BUNDLE_UNCERTAINTY_PENALTY;
    }
  }

  if (heading.startsWith(term) || heading === term) {
    score += SCORE.EXACT_MATCH_BONUS;
  } else if (heading.includes(term)) {
    score += SCORE.PARTIAL_MATCH_BONUS;
  }

  return Math.max(0, score);
}

/**
 * Find the best deal for an ingredient across all its search terms.
 */
export function findBestDeal(
  ing: { searchTerms: string[]; category: string; name: string },
  dealMap: Map<string, Offer[]>,
  preferredStores: Set<string>,
): Offer | null {
  let bestOffer: Offer | null = null;
  let bestScore = 0;

  for (const term of ing.searchTerms) {
    const offers = dealMap.get(term) ?? [];
    for (const offer of offers) {
      const matchScore = scoreDealMatch(
        offer,
        ing as Ingredient,
        term,
        preferredStores,
      );
      if (matchScore < SCORE.VIABILITY_THRESHOLD) continue;
      if (
        matchScore > bestScore ||
        (matchScore === bestScore &&
          (offer.price ?? 999) < (bestOffer?.price ?? 999))
      ) {
        bestOffer = offer;
        bestScore = matchScore;
      }
    }
  }

  return bestOffer;
}

/**
 * Calculate total basket cost for a set of recipes,
 * accounting for shared ingredients (buy once, use in multiple).
 */
export function calculateBasketCost(recipes: ScoredRecipe[]): {
  totalCost: number;
  uniqueIngredients: number;
  sharedSavings: number;
} {
  const seen = new Map<string, number>();
  let totalCost = 0;
  let sharedSavings = 0;
  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      if (!ing.bestDeal) continue;
      const key = ing.name.toLowerCase();
      if (seen.has(key)) {
        sharedSavings += ing.bestDeal.price;
      } else {
        seen.set(key, ing.bestDeal.price);
        totalCost += ing.bestDeal.price;
      }
    }
  }
  return { totalCost, uniqueIngredients: seen.size, sharedSavings };
}

// --- Variety constraints ---

export interface VarietyConstraints {
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  /** Proteins to exclude globally, e.g. ["pork"] */
  excludeProteins?: string[];
  /** Per-protein day exceptions (1-indexed): {"pork": [2]} = allow pork on day 2 */
  allowProteinOnDays?: Record<string, number[]>;
  /** Restrict slow recipes to these days only (1-indexed), e.g. [6, 7] for weekends */
  slowOnlyOnDays?: number[];
}

/** Check if a recipe is allowed on a specific day (1-indexed). */
function isAllowedOnDay(
  recipe: ScoredRecipe,
  day: number,
  constraints: VarietyConstraints,
): boolean {
  // Check protein exclusions with per-day exceptions
  if (constraints.excludeProteins?.includes(recipe.proteinType)) {
    const exceptions = constraints.allowProteinOnDays?.[recipe.proteinType];
    if (!exceptions || !exceptions.includes(day)) return false;
  }
  // Check slow-only-on-days restriction
  if (
    recipe.complexity === "slow" &&
    constraints.slowOnlyOnDays &&
    !constraints.slowOnlyOnDays.includes(day)
  ) {
    return false;
  }
  return true;
}

function isValidCombo(
  combo: ScoredRecipe[],
  constraints: VarietyConstraints,
): boolean {
  const proteinCount: Record<string, number> = {};
  const cuisineCount: Record<string, number> = {};
  let slowCount = 0;
  for (let i = 0; i < combo.length; i++) {
    const r = combo[i];
    const day = i + 1;
    if (!isAllowedOnDay(r, day, constraints)) return false;
    proteinCount[r.proteinType] = (proteinCount[r.proteinType] ?? 0) + 1;
    if (proteinCount[r.proteinType] > constraints.maxPerProtein) return false;
    cuisineCount[r.cuisineType] = (cuisineCount[r.cuisineType] ?? 0) + 1;
    if (cuisineCount[r.cuisineType] > constraints.maxPerCuisine) return false;
    if (r.complexity === "slow") slowCount++;
    if (slowCount > constraints.maxSlowDays) return false;
  }
  return true;
}

/**
 * Find optimal weekly meal plan: cheapest basket cost while respecting variety.
 * Uses positional assignment to support day-specific constraints
 * (e.g. "no pork except Tuesday", "slow only on weekends").
 * Brute-force permutations for small sets (<=12), greedy for larger.
 */
export function findOptimalWeek(
  scored: ScoredRecipe[],
  days: number,
  constraints: VarietyConstraints,
): { recipes: ScoredRecipe[]; basketCost: number } | null {
  // Pre-filter: remove globally excluded proteins (unless they have day exceptions)
  const hasExceptions = constraints.allowProteinOnDays ?? {};
  const filtered = scored.filter((r) => {
    if (constraints.excludeProteins?.includes(r.proteinType)) {
      return (hasExceptions[r.proteinType]?.length ?? 0) > 0;
    }
    return true;
  });

  if (filtered.length === 0 || filtered.length < days) return null;

  if (filtered.length <= 12) {
    return findOptimalBrute(filtered, days, constraints);
  }

  return findOptimalGreedy(filtered, days, constraints);
}

function findOptimalGreedy(
  scored: ScoredRecipe[],
  days: number,
  constraints: VarietyConstraints,
): { recipes: ScoredRecipe[]; basketCost: number } | null {
  const byBasketValue = [...scored].sort(
    (a, b) => a.estimatedCost - b.estimatedCost,
  );
  const picked: (ScoredRecipe | null)[] = new Array(days).fill(null);
  const used = new Set<string>();
  const proteinCount: Record<string, number> = {};
  const cuisineCount: Record<string, number> = {};
  let slowCount = 0;

  // Fill each day slot in order, respecting per-day constraints
  for (let dayIdx = 0; dayIdx < days; dayIdx++) {
    const day = dayIdx + 1;
    for (const recipe of byBasketValue) {
      if (used.has(recipe.name)) continue;
      if (!isAllowedOnDay(recipe, day, constraints)) continue;
      if ((proteinCount[recipe.proteinType] ?? 0) >= constraints.maxPerProtein)
        continue;
      if ((cuisineCount[recipe.cuisineType] ?? 0) >= constraints.maxPerCuisine)
        continue;
      if (recipe.complexity === "slow" && slowCount >= constraints.maxSlowDays)
        continue;

      picked[dayIdx] = recipe;
      used.add(recipe.name);
      proteinCount[recipe.proteinType] =
        (proteinCount[recipe.proteinType] ?? 0) + 1;
      cuisineCount[recipe.cuisineType] =
        (cuisineCount[recipe.cuisineType] ?? 0) + 1;
      if (recipe.complexity === "slow") slowCount++;
      break;
    }
  }

  const result = picked.filter((r): r is ScoredRecipe => r !== null);
  if (result.length < days) return null;
  const basket = calculateBasketCost(result);
  return { recipes: result, basketCost: basket.totalCost };
}

function findOptimalBrute(
  scored: ScoredRecipe[],
  days: number,
  constraints: VarietyConstraints,
): { recipes: ScoredRecipe[]; basketCost: number } | null {
  let bestCombo: ScoredRecipe[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  // Generate ordered permutations (day assignment matters for per-day constraints)
  function* permutations(
    arr: ScoredRecipe[],
    k: number,
    chosen: ScoredRecipe[] = [],
  ): Generator<ScoredRecipe[]> {
    if (k === 0) {
      yield chosen;
      return;
    }
    for (let i = 0; i < arr.length; i++) {
      const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
      yield* permutations(rest, k - 1, [...chosen, arr[i]]);
    }
  }

  const hasDayConstraints =
    (constraints.excludeProteins?.length ?? 0) > 0 ||
    (constraints.slowOnlyOnDays?.length ?? 0) > 0;

  if (hasDayConstraints) {
    // Permutations needed: order matters for day-specific constraints.
    // Limit search space: pre-sort by cost and cap candidates.
    const candidates = [...scored]
      .sort((a, b) => a.estimatedCost - b.estimatedCost)
      .slice(0, 10);
    for (const perm of permutations(candidates, days)) {
      if (!isValidCombo(perm, constraints)) continue;
      const basket = calculateBasketCost(perm);
      if (basket.totalCost < bestCost) {
        bestCost = basket.totalCost;
        bestCombo = [...perm];
      }
    }
  } else {
    // No day-specific constraints: combinations suffice (faster).
    function* combinations(
      arr: ScoredRecipe[],
      k: number,
      start = 0,
    ): Generator<ScoredRecipe[]> {
      if (k === 0) {
        yield [];
        return;
      }
      for (let i = start; i <= arr.length - k; i++) {
        for (const rest of combinations(arr, k - 1, i + 1)) {
          yield [arr[i], ...rest];
        }
      }
    }

    for (const combo of combinations(scored, days)) {
      if (!isValidCombo(combo, constraints)) continue;
      const basket = calculateBasketCost(combo);
      if (basket.totalCost < bestCost) {
        bestCost = basket.totalCost;
        bestCombo = combo;
      }
    }
  }

  if (!bestCombo) return null;
  return { recipes: bestCombo, basketCost: bestCost };
}
