// Structured meal-plan payload shared between the plan_and_shop tool and the
// MCP Apps meal-plan widget. This is the single source of truth for the data
// contract: the server builds it, the widget (resources/meal-plan) type-imports
// it. Keep it JSON-serializable and free of server-only types.

import type { ScoredRecipe } from "./scoring.js";

/** One planned dinner in the weekly plan. */
export interface MealPlanDay {
  /** 1-indexed day number within the plan. */
  day: number;
  /** Dinner / recipe name. */
  name: string;
  /** Per-day estimated cost (deals only), in the plan currency. */
  cost: number;
  /** Effort indicator: "quick" | "medium" | "slow". No prep time exists on recipes. */
  complexity: string;
  /** Protein category (chicken, beef, pork, fish, vegetarian, ...). */
  proteinType: string;
  /** Cuisine category (asian, danish, italian, ...). */
  cuisineType: string;
  /**
   * True when at least one non-pantry ingredient in this recipe matched a
   * current deal. Derived from the scorer's dealCoverage (proxy: coverage > 0);
   * per-ingredient deal match is not surfaced individually to the widget.
   */
  dealMatch: boolean;
}

/** Full payload the widget renders. */
export interface MealPlanData {
  /** Day-by-day plan; length equals planDays. */
  days: MealPlanDay[];
  /** Number of days planned. */
  planDays: number;
  /** People the plan is scaled for. */
  householdSize: number;
  /** ISO currency code, e.g. "DKK". */
  currency: string;
  /** Display symbol, e.g. "kr" or "€". */
  currencySymbol: string;
  /** Estimated basket total (deals only), shared ingredients counted once. */
  basketTotal: number;
  /** Estimated savings from ingredients shared across recipes. */
  sharedSavings: number;
}

interface BasketTotals {
  totalCost: number;
  sharedSavings: number;
}

/**
 * Build the structured widget payload from an optimized plan.
 * Rounds monetary values to whole currency units for display.
 */
export function buildMealPlanData(
  recipes: ScoredRecipe[],
  basket: BasketTotals,
  householdSize: number,
  currency: string,
  currencySymbol: string,
): MealPlanData {
  const days: MealPlanDay[] = recipes.map((r, i) => ({
    day: i + 1,
    name: r.name,
    cost: Math.round(r.estimatedCost),
    complexity: r.complexity,
    proteinType: r.proteinType,
    cuisineType: r.cuisineType,
    dealMatch: r.dealCoverage > 0,
  }));

  return {
    days,
    planDays: days.length,
    householdSize,
    currency,
    currencySymbol,
    basketTotal: Math.round(basket.totalCost),
    sharedSavings: Math.round(basket.sharedSavings),
  };
}
