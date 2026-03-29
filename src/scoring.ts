// Deal scoring and weekly meal plan optimization
// Extracted for testability; used by server.ts tool handlers.

import type { Offer } from "./api.js";
import type { Ingredient } from "./store.js";

// --- Quantity parsing ---

export interface ParsedQuantity {
  amount: number;
  unit: string; // normalized: "g", "ml", "stk", or original if unknown
}

/** Multipliers to convert common Danish units to base units (g or ml). */
const UNIT_CONVERSIONS: Record<string, { base: string; factor: number }> = {
  g: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 },
  ml: { base: "ml", factor: 1 },
  cl: { base: "ml", factor: 10 },
  dl: { base: "ml", factor: 100 },
  l: { base: "ml", factor: 1000 },
  stk: { base: "stk", factor: 1 },
};

/**
 * Parse a recipe quantity string into amount + normalized unit.
 * Returns null for unparseable quantities ("efter smag", "3 fed", etc.)
 */
export function parseQuantity(qty: string): ParsedQuantity | null {
  const trimmed = qty.trim().toLowerCase();

  // Match patterns: "500g", "500 g", "1.5 kg", "0,5 L"
  const match = trimmed.match(/^(\d+(?:[.,]\d+)?)\s*([a-zæøå]+)$/);
  if (!match) return null;

  const amount = Number.parseFloat(match[1].replace(",", "."));
  if (Number.isNaN(amount) || amount <= 0) return null;

  const rawUnit = match[2];
  const conversion = UNIT_CONVERSIONS[rawUnit];
  if (!conversion) return null;

  return { amount: amount * conversion.factor, unit: conversion.base };
}

/**
 * Compute actual ingredient cost based on unit pricing, quantity needed,
 * and household serving scale. Falls back to sticker price when unit
 * comparison isn't possible.
 */
export function computeIngredientCost(
  offer: Offer,
  recipeQty: string,
  recipeServings: number,
  householdSize: number,
): number {
  const price = offer.price;
  if (price === null || price <= 0) return 0;

  const servingScale = recipeServings > 0 ? householdSize / recipeServings : 1;

  const parsed = parseQuantity(recipeQty);
  if (!parsed) return price * servingScale;

  // Try to match offer units with recipe units
  const offerQty = offer.quantity;
  const offerUnit = offer.unit?.toLowerCase() ?? null;
  if (offerQty === null || offerQty <= 0 || !offerUnit) {
    return price * servingScale;
  }

  // Normalize offer unit to base
  const offerConversion = UNIT_CONVERSIONS[offerUnit];
  if (!offerConversion) return price * servingScale;

  const offerBaseQty = offerQty * offerConversion.factor;
  const offerBaseUnit = offerConversion.base;

  // Units must be compatible (both g, both ml, or both stk)
  if (offerBaseUnit !== parsed.unit) return price * servingScale;

  // unit_price × quantity_needed × serving_scale
  const unitPrice = price / offerBaseQty;
  const scaledAmount = parsed.amount * servingScale;
  return Math.round(unitPrice * scaledAmount * 100) / 100;
}

// --- Shopping cost (whole packs) ---

export interface ShoppingCost {
  /** Quantity needed scaled for household */
  quantityNeeded: number;
  /** Normalized unit ("g", "ml", "stk") */
  unitNeeded: string;
  /** How much one pack contains (in base units) */
  packSize: number;
  /** Whole packs you must buy */
  packsNeeded: number;
  /** Sticker price per pack */
  pricePerPack: number;
  /** Total at the register: packsNeeded × pricePerPack */
  totalCost: number;
  /** Leftover quantity after cooking */
  leftover: number;
  /** Formatted unit price string from offer */
  unitPrice: string | null;
}

/**
 * Compute how many whole packs to buy and the real register cost.
 * Returns null when units can't be compared (fall back to sticker price).
 */
export function computeShoppingCost(
  offer: Offer,
  recipeQty: string,
  recipeServings: number,
  householdSize: number,
): ShoppingCost | null {
  const price = offer.price;
  if (price === null || price <= 0) return null;

  const servingScale = recipeServings > 0 ? householdSize / recipeServings : 1;

  const parsed = parseQuantity(recipeQty);
  if (!parsed) return null;

  const offerQty = offer.quantity;
  const offerUnit = offer.unit?.toLowerCase() ?? null;
  if (offerQty === null || offerQty <= 0 || !offerUnit) return null;

  const offerConversion = UNIT_CONVERSIONS[offerUnit];
  if (!offerConversion) return null;

  const packSize = offerQty * offerConversion.factor;
  if (offerConversion.base !== parsed.unit) return null;

  const quantityNeeded = parsed.amount * servingScale;
  const packsNeeded = Math.ceil(quantityNeeded / packSize);
  const totalCost = packsNeeded * price;
  const leftover = packsNeeded * packSize - quantityNeeded;

  return {
    quantityNeeded: Math.round(quantityNeeded),
    unitNeeded: parsed.unit,
    packSize: Math.round(packSize),
    packsNeeded,
    pricePerPack: price,
    totalCost,
    leftover: Math.round(leftover),
    unitPrice: offer.pricePerUnit,
  };
}

/**
 * Compute shopping cost from a pre-computed total quantity in base units.
 * Used when quantities are aggregated across multiple recipes.
 */
export function computeShoppingCostFromTotal(
  offer: Offer,
  totalAmount: number,
  unit: string,
): ShoppingCost | null {
  const price = offer.price;
  if (price === null || price <= 0) return null;
  if (totalAmount <= 0) return null;

  const offerQty = offer.quantity;
  const offerUnit = offer.unit?.toLowerCase() ?? null;
  if (offerQty === null || offerQty <= 0 || !offerUnit) return null;

  const offerConversion = UNIT_CONVERSIONS[offerUnit];
  if (!offerConversion) return null;

  const packSize = offerQty * offerConversion.factor;
  if (offerConversion.base !== unit) return null;

  const packsNeeded = Math.ceil(totalAmount / packSize);
  const totalCost = packsNeeded * price;
  const leftover = packsNeeded * packSize - totalAmount;

  return {
    quantityNeeded: Math.round(totalAmount),
    unitNeeded: unit,
    packSize: Math.round(packSize),
    packsNeeded,
    pricePerPack: price,
    totalCost,
    leftover: Math.round(leftover),
    unitPrice: offer.pricePerUnit,
  };
}

/**
 * Sum multiple recipe quantities (each scaled for household) into a total.
 * Returns null if any quantity is unparseable or units are incompatible.
 */
export function aggregateQuantities(
  contributions: Array<{
    quantity: string;
    recipeServings: number;
  }>,
  householdSize: number,
): { totalAmount: number; unit: string } | null {
  let totalAmount = 0;
  let baseUnit: string | null = null;

  for (const c of contributions) {
    const parsed = parseQuantity(c.quantity);
    if (!parsed) return null;

    if (baseUnit === null) {
      baseUnit = parsed.unit;
    } else if (baseUnit !== parsed.unit) {
      return null; // incompatible units
    }

    const scale = c.recipeServings > 0 ? householdSize / c.recipeServings : 1;
    totalAmount += parsed.amount * scale;
  }

  if (baseUnit === null || totalAmount <= 0) return null;
  return { totalAmount: Math.round(totalAmount), unit: baseUnit };
}

/**
 * Format a base-unit quantity for human display.
 * Converts 1500g -> "1.5 kg", 250ml -> "2.5 dl", etc.
 */
export function formatQuantity(amount: number, unit: string): string {
  if (unit === "g" && amount >= 1000) {
    return `${(amount / 1000).toFixed(1).replace(/\.0$/, "")} kg`;
  }
  if (unit === "ml" && amount >= 1000) {
    return `${(amount / 1000).toFixed(1).replace(/\.0$/, "")} L`;
  }
  if (unit === "ml" && amount >= 100) {
    return `${(amount / 100).toFixed(1).replace(/\.0$/, "")} dl`;
  }
  return `${amount} ${unit}`;
}

// --- Types ---

export interface DealCandidate {
  heading: string;
  price: number;
  store: string;
  score: number;
}

export interface ScoredIngredient {
  name: string;
  quantity: string;
  category: string;
  bestDeal: { heading: string; price: number; store: string } | null;
  estimatedCost: number;
  confidence: "high" | "low" | "none";
  candidates?: DealCandidate[];
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

/**
 * Headings containing these terms are not raw grocery ingredients.
 * Matched against lowercased heading; returns 0 immediately.
 */
export const NON_INGREDIENT_INDICATORS = [
  // Garden / DIY products
  "frø,",
  "frø ",
  "såfrø",
  "blomsterløg",
  // Ready meals and prepared dishes
  "tærte",
  "omelet",
  "gratin",
  "gryderet",
  "færdigret",
  "risretter",
  "risret",
  "snack pot",
  "kopnudler",
  "instant ",
  "flødekartofler",
  // Non-food products
  "vaseline",
  "shampoo",
  "sæbe",
  "opvask",
  // Beverages when searching for food items
  "sodavand",
  "energidrik",
  "skummetmælk", // flavored milk drink, not cooking milk
  // Pizza / ready food
  "pizza",
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
  /** Search term appears after a preposition (i, med, og) = probably not the product */
  MODIFIER_PENALTY: -40,
  /** Search term not found in heading at all */
  NO_MATCH_PENALTY: -50,
  VIABILITY_THRESHOLD: 30,
  /** Above this = auto-accept; below = show candidates for Claude to validate */
  CONFIDENT_THRESHOLD: 55,
} as const;

// --- Search term synonyms ---

/**
 * Maps Danish ingredient terms to synonyms used in store flyers.
 * Expands search coverage for deal matching.
 */
export const SYNONYM_MAP: Record<string, string[]> = {
  svinekød: ["grisekød", "grise-"],
  "hakket svinekød": ["hakket grisekød", "grise- og kalvekød"],
  svinefars: ["grisefars"],
  oksekød: ["okse-"],
  oksefars: ["hakket oksekød"],
  kyllingebryst: ["kylling"],
  kyllingefilet: ["kylling"],
  kyllingelår: ["kylling", "kyllingeunderlår"],
  kyllingestykker: ["kylling", "hel kylling"],
  rejer: ["skalrejer"],
};

/**
 * Expand search terms with Danish synonyms for better flyer matching.
 */
export function expandSearchTerms(terms: string[]): string[] {
  const expanded = new Set(terms);
  for (const term of terms) {
    const synonyms = SYNONYM_MAP[term.toLowerCase()];
    if (synonyms) {
      for (const syn of synonyms) expanded.add(syn);
    }
  }
  return [...expanded];
}

/**
 * Danish prepositions that indicate the search term after them
 * is a modifier/addition, not the primary product.
 * "Tunfilet i olivenolie" → olivenolie is a modifier.
 */
const MODIFIER_PREPOSITIONS = [" i ", " med ", " og ", " på ", " til ", " fra "];

/**
 * Check if the search term appears only in a modifier position
 * (after a preposition), not as the primary product.
 */
export function isModifierPosition(heading: string, term: string): boolean {
  const idx = heading.indexOf(term);
  if (idx < 0) return false;
  // If term starts the heading, it's primary
  if (idx === 0) return false;

  const before = heading.slice(0, idx);
  return MODIFIER_PREPOSITIONS.some((prep) => before.includes(prep));
}

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

  // Reject non-ingredient products (garden seeds, ready meals, non-food)
  if (NON_INGREDIENT_INDICATORS.some((ind) => heading.includes(ind))) return 0;

  let score = SCORE.BASE;

  // Hard-exclude non-preferred stores when preferences are configured
  if (preferredStores.size > 0) {
    if (!preferredStores.has(offer.store)) return 0;
    score += SCORE.PREFERRED_STORE_BONUS;
  }

  const isBundleHeading = heading.includes(" eller ") || heading.includes(" el. ");

  if (ingredient.category === "meat" || ingredient.category === "frozen") {
    const isProcessed = PROCESSED_INDICATORS.some((p) => heading.includes(p));
    const isRaw = RAW_INDICATORS.some((r) => heading.includes(r));

    if (isProcessed && !isRaw) {
      score += SCORE.PROCESSED_PENALTY;
    } else if (isRaw) {
      score += SCORE.RAW_BONUS;
    }

    if (isBundleHeading && isProcessed) {
      score += SCORE.BUNDLE_UNCERTAINTY_PENALTY;
    }
  }

  // Penalize ambiguous "X eller Y" / "X el. Y" bundles for all categories
  // ("Pasta eller pastasauce", "Knorr Lasagne el. Risretter")
  if (isBundleHeading) {
    score += SCORE.PARTIAL_MATCH_BONUS - SCORE.EXACT_MATCH_BONUS; // net -15
  }

  // Text matching with modifier detection
  if (heading.startsWith(term) || heading === term) {
    score += SCORE.EXACT_MATCH_BONUS;
  } else if (heading.includes(term)) {
    if (isModifierPosition(heading, term)) {
      score += SCORE.MODIFIER_PENALTY;
    } else {
      score += SCORE.PARTIAL_MATCH_BONUS;
    }
  } else {
    // Term not found at all in heading
    score += SCORE.NO_MATCH_PENALTY;
  }

  return Math.max(0, score);
}

export interface DealSearchResult {
  best: Offer | null;
  bestScore: number;
  confidence: "high" | "low" | "none";
  candidates: { offer: Offer; score: number }[];
}

/**
 * Find the best deal for an ingredient across all its search terms.
 * Returns the best match plus up to 3 candidates for low-confidence matches.
 */
export function findBestDeal(
  ing: { searchTerms: string[]; category: string; name: string },
  dealMap: Map<string, Offer[]>,
  preferredStores: Set<string>,
): DealSearchResult {
  const allScored: { offer: Offer; score: number }[] = [];
  const searchTerms = expandSearchTerms(ing.searchTerms);

  for (const term of searchTerms) {
    const offers = dealMap.get(term) ?? [];
    for (const offer of offers) {
      const matchScore = scoreDealMatch(offer, ing as Ingredient, term, preferredStores);
      if (matchScore < SCORE.VIABILITY_THRESHOLD) continue;
      allScored.push({ offer, score: matchScore });
    }
  }

  // Deduplicate by offer ID, keep highest score
  const byId = new Map<string, { offer: Offer; score: number }>();
  for (const s of allScored) {
    const existing = byId.get(s.offer.id);
    if (!existing || s.score > existing.score) {
      byId.set(s.offer.id, s);
    }
  }

  const sorted = [...byId.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (a.offer.price ?? 999) - (b.offer.price ?? 999);
  });

  if (sorted.length === 0) {
    return { best: null, bestScore: 0, confidence: "none", candidates: [] };
  }

  const top = sorted[0];
  const confidence = top.score >= SCORE.CONFIDENT_THRESHOLD ? "high" : "low";
  const candidates = sorted.slice(0, 3);

  return { best: top.offer, bestScore: top.score, confidence, candidates };
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

// --- Dietary ingredient tagging ---

/**
 * Maps dietary exclusion keywords to ingredient name patterns.
 * Used to detect excluded ingredients beyond just proteinType.
 * E.g. "pork" catches bacon in a "vegetarian" soup.
 */
export const INGREDIENT_TAGS: Record<string, string[]> = {
  pork: [
    "bacon",
    "chorizo",
    "salsiccia",
    "pølse",
    "wienerpølse",
    "flæsk",
    "flæskesteg",
    "brystflæsk",
    "svinekød",
    "svinekam",
    "svinekotelet",
    "grisekød",
    "grisefars",
    "svinefars",
    "mørbrad af gris",
  ],
  beef: ["oksekød", "oksemørbrad", "oksefars", "hakket okse"],
  lamb: ["lam", "lammekølle", "lammeculotte"],
  fish: ["laks", "fisk", "rødspætte", "torsk", "kuller", "tun", "sild"],
  shellfish: ["rejer", "hummer", "muslinger", "skalrejer"],
  dairy: [
    "mælk",
    "fløde",
    "piskefløde",
    "smør",
    "ost",
    "parmesan",
    "mozzarella",
    "creme fraiche",
    "yoghurt",
    "crème fraîche",
  ],
  gluten: [
    "mel",
    "hvedemel",
    "pasta",
    "spaghetti",
    "nudler",
    "ægnudler",
    "brød",
    "rugbrød",
    "lasagneplader",
    "tortilla",
    "rasp",
  ],
  beans: ["bønner", "kidneybønner", "linser", "kikærter"],
  nuts: ["cashewnødder", "mandler", "peanuts", "nødder", "hasselnødder"],
  egg: ["æg"],
};

/**
 * Check if a recipe contains ingredients matching any of the excluded dietary tags.
 * Returns the first matched tag, or null if no match.
 */
export function findExcludedTag(
  ingredients: ScoredIngredient[],
  exclusions: string[],
): string | null {
  for (const tag of exclusions) {
    const patterns = INGREDIENT_TAGS[tag];
    if (!patterns) continue;
    for (const ing of ingredients) {
      const name = ing.name.toLowerCase();
      if (patterns.some((p) => name.includes(p))) return tag;
    }
  }
  return null;
}

// --- Variety constraints ---

export interface VarietyConstraints {
  maxPerProtein: number;
  maxPerCuisine: number;
  maxSlowDays: number;
  /** Dietary exclusions: ["pork", "dairy", "nuts", ...]. Checks both proteinType and ingredient names. */
  excludeProteins?: string[];
  /** Per-tag day exceptions (1-indexed): {"pork": [2]} = allow pork on day 2 */
  allowProteinOnDays?: Record<string, number[]>;
  /** Restrict slow recipes to these days only (1-indexed), e.g. [6, 7] for weekends */
  slowOnlyOnDays?: number[];
  /** Soft cuisine preferences: {"asian": 3} = prefer at least 3 Asian dishes. Best-effort. */
  preferCuisines?: Record<string, number>;
}

/** Compute a penalty for unmet cuisine preferences. Higher = further from target. */
export function cuisinePreferencePenalty(
  combo: ScoredRecipe[],
  preferCuisines: Record<string, number>,
): number {
  const counts: Record<string, number> = {};
  for (const r of combo) {
    counts[r.cuisineType] = (counts[r.cuisineType] ?? 0) + 1;
  }
  let penalty = 0;
  for (const [cuisine, target] of Object.entries(preferCuisines)) {
    const actual = counts[cuisine] ?? 0;
    if (actual < target) penalty += (target - actual) * 50;
  }
  return penalty;
}

/** Check if a recipe is allowed on a specific day (1-indexed). */
function isAllowedOnDay(
  recipe: ScoredRecipe,
  day: number,
  constraints: VarietyConstraints,
): boolean {
  if (!constraints.excludeProteins?.length) {
    // No exclusions; skip all dietary checks
  } else {
    // Check proteinType-level exclusion
    if (constraints.excludeProteins.includes(recipe.proteinType)) {
      const exceptions = constraints.allowProteinOnDays?.[recipe.proteinType];
      if (!exceptions?.includes(day)) return false;
    }
    // Check ingredient-level exclusion (catches bacon in "vegetarian" recipes, etc.)
    const matchedTag = findExcludedTag(recipe.ingredients, constraints.excludeProteins);
    if (matchedTag && matchedTag !== recipe.proteinType) {
      const exceptions = constraints.allowProteinOnDays?.[matchedTag];
      if (!exceptions?.includes(day)) return false;
    }
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

function isValidCombo(combo: ScoredRecipe[], constraints: VarietyConstraints): boolean {
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
  // Pre-filter: remove recipes that are globally excluded (unless they have day exceptions)
  const hasExceptions = constraints.allowProteinOnDays ?? {};
  const exclusions = constraints.excludeProteins ?? [];
  const filtered = scored.filter((r) => {
    // Check proteinType exclusion
    if (exclusions.includes(r.proteinType)) {
      return (hasExceptions[r.proteinType]?.length ?? 0) > 0;
    }
    // Check ingredient-level exclusion
    const matchedTag = findExcludedTag(r.ingredients, exclusions);
    if (matchedTag) {
      return (hasExceptions[matchedTag]?.length ?? 0) > 0;
    }
    return true;
  });

  if (filtered.length === 0 || filtered.length < days) return null;

  if (filtered.length <= 12) {
    return findOptimalBrute(filtered, days, constraints);
  }

  return findOptimalGreedy(filtered, days, constraints);
}

/** Check if a recipe fits the running variety tallies for greedy selection */
function fitsGreedyConstraints(
  recipe: ScoredRecipe,
  day: number,
  constraints: VarietyConstraints,
  used: Set<string>,
  proteinCount: Record<string, number>,
  cuisineCount: Record<string, number>,
  slowCount: number,
): boolean {
  if (used.has(recipe.name)) return false;
  if (!isAllowedOnDay(recipe, day, constraints)) return false;
  if ((proteinCount[recipe.proteinType] ?? 0) >= constraints.maxPerProtein) return false;
  if ((cuisineCount[recipe.cuisineType] ?? 0) >= constraints.maxPerCuisine) return false;
  if (recipe.complexity === "slow" && slowCount >= constraints.maxSlowDays) return false;
  return true;
}

function findOptimalGreedy(
  scored: ScoredRecipe[],
  days: number,
  constraints: VarietyConstraints,
): { recipes: ScoredRecipe[]; basketCost: number } | null {
  const byBasketValue = [...scored].sort((a, b) => a.estimatedCost - b.estimatedCost);
  const picked: (ScoredRecipe | null)[] = new Array(days).fill(null);
  const used = new Set<string>();
  const proteinCount: Record<string, number> = {};
  const cuisineCount: Record<string, number> = {};
  let slowCount = 0;

  for (let dayIdx = 0; dayIdx < days; dayIdx++) {
    const day = dayIdx + 1;
    for (const recipe of byBasketValue) {
      if (
        !fitsGreedyConstraints(
          recipe,
          day,
          constraints,
          used,
          proteinCount,
          cuisineCount,
          slowCount,
        )
      )
        continue;

      picked[dayIdx] = recipe;
      used.add(recipe.name);
      proteinCount[recipe.proteinType] = (proteinCount[recipe.proteinType] ?? 0) + 1;
      cuisineCount[recipe.cuisineType] = (cuisineCount[recipe.cuisineType] ?? 0) + 1;
      if (recipe.complexity === "slow") slowCount++;
      break;
    }
  }

  const result = picked.filter((r): r is ScoredRecipe => r !== null);
  if (result.length < days) return null;

  // Post-fill: swap to improve cuisine preferences if configured
  const improved = constraints.preferCuisines
    ? applyPreferenceSwaps(result, scored, constraints)
    : result;

  const basket = calculateBasketCost(improved);
  return { recipes: improved, basketCost: basket.totalCost };
}

/** Swap non-preferred recipes for preferred-cuisine ones, maintaining constraint validity */
function applyPreferenceSwaps(
  plan: ScoredRecipe[],
  allRecipes: ScoredRecipe[],
  constraints: VarietyConstraints,
): ScoredRecipe[] {
  const prefs = constraints.preferCuisines ?? {};
  const result = [...plan];
  const usedNames = new Set(result.map((r) => r.name));

  for (const [cuisine, target] of Object.entries(prefs)) {
    let count = result.filter((r) => r.cuisineType === cuisine).length;
    if (count >= target) continue;

    // Find candidate recipes of the preferred cuisine not already in plan
    const candidates = allRecipes
      .filter((r) => r.cuisineType === cuisine && !usedNames.has(r.name))
      .sort((a, b) => a.estimatedCost - b.estimatedCost);

    // Find swappable slots: non-preferred cuisine, sorted by cost (most expensive first)
    const swappable = result
      .map((r, i) => ({ recipe: r, index: i }))
      .filter((s) => s.recipe.cuisineType !== cuisine)
      .sort((a, b) => b.recipe.estimatedCost - a.recipe.estimatedCost);

    for (const candidate of candidates) {
      if (count >= target) break;
      for (const slot of swappable) {
        if (result[slot.index].cuisineType === cuisine) continue; // already swapped
        // Try swap and validate
        const backup = result[slot.index];
        result[slot.index] = candidate;
        if (isValidCombo(result, constraints)) {
          usedNames.delete(backup.name);
          usedNames.add(candidate.name);
          count++;
          break;
        }
        result[slot.index] = backup; // revert
      }
    }
  }
  return result;
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
    (constraints.excludeProteins?.length ?? 0) > 0 || (constraints.slowOnlyOnDays?.length ?? 0) > 0;
  const prefs = constraints.preferCuisines ?? {};

  // Adjusted cost includes a soft penalty for unmet cuisine preferences
  function adjustedCost(combo: ScoredRecipe[]): number {
    return calculateBasketCost(combo).totalCost + cuisinePreferencePenalty(combo, prefs);
  }

  if (hasDayConstraints) {
    // Permutations needed: order matters for day-specific constraints.
    const candidates = [...scored].sort((a, b) => a.estimatedCost - b.estimatedCost).slice(0, 10);
    for (const perm of permutations(candidates, days)) {
      if (!isValidCombo(perm, constraints)) continue;
      const cost = adjustedCost(perm);
      if (cost < bestCost) {
        bestCost = cost;
        bestCombo = [...perm];
      }
    }
  } else {
    // No day-specific constraints: combinations suffice (faster).
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
      const cost = adjustedCost(combo);
      if (cost < bestCost) {
        bestCost = cost;
        bestCombo = combo;
      }
    }
  }

  if (!bestCombo) return null;
  const realCost = calculateBasketCost(bestCombo).totalCost;
  return { recipes: bestCombo, basketCost: realCost };
}
