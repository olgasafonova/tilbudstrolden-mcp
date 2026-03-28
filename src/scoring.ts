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
      const matchScore = scoreDealMatch(offer, ing as Ingredient, term, preferredStores);
      if (matchScore < SCORE.VIABILITY_THRESHOLD) continue;
      if (
        matchScore > bestScore ||
        (matchScore === bestScore && (offer.price ?? 999) < (bestOffer?.price ?? 999))
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
}

function isValidCombo(combo: ScoredRecipe[], constraints: VarietyConstraints): boolean {
  const proteinCount: Record<string, number> = {};
  const cuisineCount: Record<string, number> = {};
  let slowCount = 0;
  for (const r of combo) {
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
 * Brute-force for small sets (<=12), greedy for larger.
 */
export function findOptimalWeek(
  scored: ScoredRecipe[],
  days: number,
  constraints: VarietyConstraints,
): { recipes: ScoredRecipe[]; basketCost: number } | null {
  if (scored.length === 0 || scored.length < days) return null;

  if (scored.length <= 12) {
    return findOptimalBrute(scored, days, constraints);
  }

  // Greedy: sort by cost, pick while respecting constraints
  const byBasketValue = [...scored].sort((a, b) => a.estimatedCost - b.estimatedCost);
  const picked: ScoredRecipe[] = [];
  const proteinCount: Record<string, number> = {};
  const cuisineCount: Record<string, number> = {};
  let slowCount = 0;

  for (const recipe of byBasketValue) {
    if (picked.length >= days) break;
    if ((proteinCount[recipe.proteinType] ?? 0) >= constraints.maxPerProtein) continue;
    if ((cuisineCount[recipe.cuisineType] ?? 0) >= constraints.maxPerCuisine) continue;
    if (recipe.complexity === "slow" && slowCount >= constraints.maxSlowDays) continue;
    picked.push(recipe);
    proteinCount[recipe.proteinType] = (proteinCount[recipe.proteinType] ?? 0) + 1;
    cuisineCount[recipe.cuisineType] = (cuisineCount[recipe.cuisineType] ?? 0) + 1;
    if (recipe.complexity === "slow") slowCount++;
  }

  if (picked.length < days) return null;
  const basket = calculateBasketCost(picked);
  return { recipes: picked, basketCost: basket.totalCost };
}

function findOptimalBrute(
  scored: ScoredRecipe[],
  days: number,
  constraints: VarietyConstraints,
): { recipes: ScoredRecipe[]; basketCost: number } | null {
  let bestCombo: ScoredRecipe[] | null = null;
  let bestCost = Number.POSITIVE_INFINITY;

  function* combinations(arr: ScoredRecipe[], k: number, start = 0): Generator<ScoredRecipe[]> {
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

  if (!bestCombo) return null;
  return { recipes: bestCombo, basketCost: bestCost };
}
