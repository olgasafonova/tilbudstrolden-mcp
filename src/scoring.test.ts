import { describe, expect, it } from "vitest";
import type { Offer } from "./api.js";
import {
  calculateBasketCost,
  findBestDeal,
  findOptimalWeek,
  SCORE,
  type ScoredRecipe,
  scoreDealMatch,
} from "./scoring.js";
import type { Ingredient } from "./store.js";

// --- Test helpers ---

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "test-1",
    heading: "Hakket oksekød 7-10%",
    description: null,
    price: 45,
    prePrice: null,
    currency: "DKK",
    quantity: 400,
    unit: "g",
    pricePerUnit: "112.50 kr/kg",
    store: "Netto",
    storeId: "9ba51",
    validFrom: "2026-03-25",
    validUntil: "2026-04-03",
    imageUrl: null,
    ...overrides,
  };
}

function makeIngredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    name: "oksekød",
    quantity: "500g",
    searchTerms: ["hakket oksekød", "oksekød"],
    category: "meat",
    ...overrides,
  };
}

function makeRecipe(overrides: Partial<ScoredRecipe> = {}): ScoredRecipe {
  return {
    name: "Bolognese",
    servings: 4,
    complexity: "medium",
    proteinType: "beef",
    cuisineType: "italian",
    estimatedCost: 100,
    dealCoverage: 80,
    ingredients: [],
    ...overrides,
  };
}

// --- scoreDealMatch ---

describe("scoreDealMatch", () => {
  it("returns 0 for null price", () => {
    const offer = makeOffer({ price: null });
    const ing = makeIngredient();
    expect(scoreDealMatch(offer, ing, "oksekød", new Set())).toBe(0);
  });

  it("returns 0 for zero price", () => {
    const offer = makeOffer({ price: 0 });
    const ing = makeIngredient();
    expect(scoreDealMatch(offer, ing, "oksekød", new Set())).toBe(0);
  });

  it("returns base score for a basic match with no preferences", () => {
    const offer = makeOffer({ heading: "Hakket oksekød" });
    const ing = makeIngredient({ category: "dairy" }); // non-meat to skip form detection
    const score = scoreDealMatch(offer, ing, "oksekød", new Set());
    expect(score).toBe(SCORE.BASE + SCORE.PARTIAL_MATCH_BONUS);
  });

  it("gives exact match bonus when heading starts with search term", () => {
    const offer = makeOffer({ heading: "oksekød 7-10%" });
    const ing = makeIngredient({ category: "dairy" });
    const score = scoreDealMatch(offer, ing, "oksekød", new Set());
    expect(score).toBe(SCORE.BASE + SCORE.EXACT_MATCH_BONUS);
  });

  it("gives preferred store bonus", () => {
    const offer = makeOffer({ store: "Netto" });
    const ing = makeIngredient({ category: "dairy" });
    const preferred = new Set(["Netto"]);
    const score = scoreDealMatch(offer, ing, "oksekød", preferred);
    expect(score).toBeGreaterThan(SCORE.BASE);
  });

  it("penalizes non-preferred stores", () => {
    const offer = makeOffer({ store: "Bilka" });
    const ing = makeIngredient({ category: "dairy" });
    const preferred = new Set(["Netto"]);
    const score = scoreDealMatch(offer, ing, "oksekød", preferred);
    expect(score).toBeLessThan(SCORE.BASE);
  });

  it("penalizes processed meat products", () => {
    const offer = makeOffer({ heading: "Røget laks" });
    const ing = makeIngredient({ category: "meat" });
    const score = scoreDealMatch(offer, ing, "laks", new Set());
    expect(score).toBeLessThan(SCORE.BASE);
  });

  it("bonuses raw meat indicators", () => {
    const offer = makeOffer({ heading: "Fersk hakket oksekød" });
    const ing = makeIngredient({ category: "meat" });
    const score = scoreDealMatch(offer, ing, "oksekød", new Set());
    expect(score).toBeGreaterThan(SCORE.BASE);
  });

  it("penalizes bundle uncertainty for processed bundles", () => {
    const offer = makeOffer({ heading: "Rejer, kold- eller varmrøget laks" });
    const ing = makeIngredient({ category: "meat" });
    const score = scoreDealMatch(offer, ing, "laks", new Set());
    expect(score).toBeLessThan(SCORE.VIABILITY_THRESHOLD);
  });

  it("does not apply meat processing rules to non-meat categories", () => {
    const offer = makeOffer({ heading: "Røget ost" });
    const ing = makeIngredient({ category: "dairy" });
    const score = scoreDealMatch(offer, ing, "ost", new Set());
    // Should get base + partial match, no processing penalty
    expect(score).toBe(SCORE.BASE + SCORE.PARTIAL_MATCH_BONUS);
  });
});

// --- findBestDeal ---

describe("findBestDeal", () => {
  it("returns null when no deals match", () => {
    const ing = makeIngredient();
    const dealMap = new Map<string, Offer[]>();
    expect(findBestDeal(ing, dealMap, new Set())).toBeNull();
  });

  it("returns the best-scoring offer", () => {
    const rawOffer = makeOffer({ heading: "Fersk hakket oksekød", price: 50 });
    const processedOffer = makeOffer({
      heading: "Røget oksekød pålæg",
      price: 30,
    });
    const ing = makeIngredient({ searchTerms: ["oksekød"] });
    const dealMap = new Map([["oksekød", [rawOffer, processedOffer]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result).toBe(rawOffer);
  });

  it("picks cheaper offer when scores tie", () => {
    const cheap = makeOffer({ heading: "Hakket oksekød", price: 30 });
    const expensive = makeOffer({ heading: "Hakket oksekød", price: 60 });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "dairy" });
    const dealMap = new Map([["oksekød", [expensive, cheap]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result).toBe(cheap);
  });

  it("searches across multiple search terms", () => {
    const offer = makeOffer({ heading: "Dansk lammekølle", price: 55 });
    const ing = makeIngredient({
      name: "lam",
      searchTerms: ["lammekølle", "lam"],
      category: "meat",
    });
    const dealMap = new Map<string, Offer[]>([
      ["lammekølle", [offer]],
      ["lam", []],
    ]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result).toBe(offer);
  });
});

// --- calculateBasketCost ---

describe("calculateBasketCost", () => {
  it("returns zero for empty recipe list", () => {
    const result = calculateBasketCost([]);
    expect(result.totalCost).toBe(0);
    expect(result.uniqueIngredients).toBe(0);
    expect(result.sharedSavings).toBe(0);
  });

  it("sums ingredient prices", () => {
    const recipe = makeRecipe({
      ingredients: [
        {
          name: "oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: { heading: "Oksekød", price: 45, store: "Netto" },
          estimatedCost: 45,
        },
        {
          name: "tomater",
          quantity: "400g",
          category: "produce",
          bestDeal: { heading: "Tomater", price: 15, store: "Netto" },
          estimatedCost: 15,
        },
      ],
    });
    const result = calculateBasketCost([recipe]);
    expect(result.totalCost).toBe(60);
    expect(result.uniqueIngredients).toBe(2);
  });

  it("deduplicates shared ingredients across recipes", () => {
    const recipe1 = makeRecipe({
      name: "Bolognese",
      ingredients: [
        {
          name: "Oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: { heading: "Oksekød", price: 45, store: "Netto" },
          estimatedCost: 45,
        },
      ],
    });
    const recipe2 = makeRecipe({
      name: "Chili con carne",
      proteinType: "beef",
      cuisineType: "mexican",
      ingredients: [
        {
          name: "oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: { heading: "Oksekød", price: 45, store: "Netto" },
          estimatedCost: 45,
        },
      ],
    });
    const result = calculateBasketCost([recipe1, recipe2]);
    expect(result.totalCost).toBe(45); // bought once
    expect(result.sharedSavings).toBe(45); // saved on second recipe
    expect(result.uniqueIngredients).toBe(1);
  });

  it("skips ingredients with no deal", () => {
    const recipe = makeRecipe({
      ingredients: [
        {
          name: "oksekød",
          quantity: "500g",
          category: "meat",
          bestDeal: null,
          estimatedCost: 0,
        },
      ],
    });
    const result = calculateBasketCost([recipe]);
    expect(result.totalCost).toBe(0);
  });
});

// --- findOptimalWeek ---

describe("findOptimalWeek", () => {
  const constraints = { maxPerProtein: 2, maxPerCuisine: 2, maxSlowDays: 2 };

  it("returns null for empty recipe list", () => {
    expect(findOptimalWeek([], 3, constraints)).toBeNull();
  });

  it("returns null when not enough recipes for requested days", () => {
    const recipes = [makeRecipe()];
    expect(findOptimalWeek(recipes, 3, constraints)).toBeNull();
  });

  it("picks cheapest recipes that fit constraints", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "asian",
        complexity: "quick",
        estimatedCost: 50,
        ingredients: [],
      }),
      makeRecipe({
        name: "B",
        proteinType: "beef",
        cuisineType: "italian",
        complexity: "medium",
        estimatedCost: 60,
        ingredients: [],
      }),
      makeRecipe({
        name: "C",
        proteinType: "fish",
        cuisineType: "danish",
        complexity: "slow",
        estimatedCost: 70,
        ingredients: [],
      }),
      makeRecipe({
        name: "D",
        proteinType: "pork",
        cuisineType: "mexican",
        complexity: "quick",
        estimatedCost: 80,
        ingredients: [],
      }),
    ];
    const result = findOptimalWeek(recipes, 3, constraints);
    expect(result).not.toBeNull();
    expect(result?.recipes).toHaveLength(3);
    // Should pick the 3 cheapest (A, B, C) since all constraints are satisfied
    expect(result?.recipes.map((r) => r.name)).toEqual(["A", "B", "C"]);
  });

  it("respects protein variety constraint", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "a",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "b",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "chicken",
        cuisineType: "c",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "beef",
        cuisineType: "d",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      maxPerProtein: 2,
    });
    expect(result).not.toBeNull();
    const chickenCount =
      result?.recipes.filter((r) => r.proteinType === "chicken").length ?? 0;
    expect(chickenCount).toBeLessThanOrEqual(2);
  });

  it("respects cuisine variety constraint", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "a",
        cuisineType: "italian",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "b",
        cuisineType: "italian",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "c",
        cuisineType: "italian",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "d",
        cuisineType: "asian",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      maxPerCuisine: 2,
    });
    expect(result).not.toBeNull();
    const italianCount =
      result?.recipes.filter((r) => r.cuisineType === "italian").length ?? 0;
    expect(italianCount).toBeLessThanOrEqual(2);
  });

  it("respects slow day constraint", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "a",
        cuisineType: "a",
        complexity: "slow",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "b",
        cuisineType: "b",
        complexity: "slow",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "c",
        cuisineType: "c",
        complexity: "quick",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "d",
        cuisineType: "d",
        complexity: "quick",
        estimatedCost: 40,
      }),
      makeRecipe({
        name: "E",
        proteinType: "e",
        cuisineType: "e",
        complexity: "medium",
        estimatedCost: 50,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      maxSlowDays: 1,
    });
    expect(result).not.toBeNull();
    const slowCount =
      result?.recipes.filter((r) => r.complexity === "slow").length ?? 0;
    expect(slowCount).toBeLessThanOrEqual(1);
  });

  it("returns null when constraints are impossible to satisfy", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "italian",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "italian",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "chicken",
        cuisineType: "italian",
        estimatedCost: 30,
      }),
    ];
    // Need 3 days but maxPerProtein=1 and all are chicken
    const result = findOptimalWeek(recipes, 3, {
      maxPerProtein: 1,
      maxPerCuisine: 1,
      maxSlowDays: 1,
    });
    expect(result).toBeNull();
  });

  it("excludes proteins globally", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "pork",
        cuisineType: "a",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "b",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "beef",
        cuisineType: "c",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "fish",
        cuisineType: "d",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      excludeProteins: ["pork"],
    });
    expect(result).not.toBeNull();
    expect(result?.recipes.every((r) => r.proteinType !== "pork")).toBe(true);
  });

  it("allows excluded protein on specific days", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "chicken",
        cuisineType: "a",
        estimatedCost: 50,
      }),
      makeRecipe({
        name: "B",
        proteinType: "pork",
        cuisineType: "b",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "C",
        proteinType: "beef",
        cuisineType: "c",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "fish",
        cuisineType: "d",
        estimatedCost: 40,
      }),
    ];
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      excludeProteins: ["pork"],
      allowProteinOnDays: { pork: [1] },
    });
    expect(result).not.toBeNull();
    // Pork should be on day 1 (cheapest and allowed there)
    expect(result?.recipes[0].proteinType).toBe("pork");
  });

  it("restricts slow recipes to specific days", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "a",
        cuisineType: "a",
        complexity: "slow",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "b",
        cuisineType: "b",
        complexity: "quick",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "c",
        cuisineType: "c",
        complexity: "quick",
        estimatedCost: 30,
      }),
    ];
    // Slow only allowed on day 3
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      slowOnlyOnDays: [3],
    });
    expect(result).not.toBeNull();
    // Slow recipe "A" should be on day 3 (position index 2)
    const slowIdx =
      result?.recipes.findIndex((r) => r.complexity === "slow") ?? -1;
    expect(slowIdx).toBe(2);
  });

  it("combines exclude + slow constraints", () => {
    const recipes = [
      makeRecipe({
        name: "A",
        proteinType: "pork",
        cuisineType: "a",
        complexity: "slow",
        estimatedCost: 10,
      }),
      makeRecipe({
        name: "B",
        proteinType: "chicken",
        cuisineType: "b",
        complexity: "quick",
        estimatedCost: 20,
      }),
      makeRecipe({
        name: "C",
        proteinType: "beef",
        cuisineType: "c",
        complexity: "quick",
        estimatedCost: 30,
      }),
      makeRecipe({
        name: "D",
        proteinType: "fish",
        cuisineType: "d",
        complexity: "slow",
        estimatedCost: 40,
      }),
      makeRecipe({
        name: "E",
        proteinType: "egg",
        cuisineType: "e",
        complexity: "quick",
        estimatedCost: 50,
      }),
    ];
    // No pork, slow only on day 3
    const result = findOptimalWeek(recipes, 3, {
      ...constraints,
      excludeProteins: ["pork"],
      slowOnlyOnDays: [3],
    });
    expect(result).not.toBeNull();
    expect(result?.recipes.every((r) => r.proteinType !== "pork")).toBe(true);
    for (let i = 0; i < (result?.recipes.length ?? 0); i++) {
      if (result?.recipes[i].complexity === "slow") {
        expect(i + 1).toBe(3); // slow only on day 3
      }
    }
  });
});
