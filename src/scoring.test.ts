import { describe, expect, it } from "vitest";
import type { Offer } from "./api.js";
import {
  calculateBasketCost,
  computeIngredientCost,
  findBestDeal,
  findOptimalWeek,
  isModifierPosition,
  parseQuantity,
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

// --- parseQuantity ---

describe("parseQuantity", () => {
  it("parses grams", () => {
    expect(parseQuantity("500 g")).toEqual({ amount: 500, unit: "g" });
  });

  it("parses grams without space", () => {
    expect(parseQuantity("500g")).toEqual({ amount: 500, unit: "g" });
  });

  it("parses kilograms and converts to grams", () => {
    expect(parseQuantity("1 kg")).toEqual({ amount: 1000, unit: "g" });
  });

  it("parses deciliters and converts to ml", () => {
    expect(parseQuantity("1 dl")).toEqual({ amount: 100, unit: "ml" });
  });

  it("parses liters and converts to ml", () => {
    expect(parseQuantity("0,5 l")).toEqual({ amount: 500, unit: "ml" });
  });

  it("parses stk", () => {
    expect(parseQuantity("2 stk")).toEqual({ amount: 2, unit: "stk" });
  });

  it("parses cl", () => {
    expect(parseQuantity("33 cl")).toEqual({ amount: 330, unit: "ml" });
  });

  it("returns null for unparseable quantities", () => {
    expect(parseQuantity("efter smag")).toBeNull();
  });

  it("returns null for unknown units", () => {
    expect(parseQuantity("3 fed")).toBeNull();
    expect(parseQuantity("2 spsk")).toBeNull();
    expect(parseQuantity("2 stængler")).toBeNull();
  });

  it("returns null for zero amount", () => {
    expect(parseQuantity("0 g")).toBeNull();
  });

  it("handles decimal with period", () => {
    expect(parseQuantity("1.5 kg")).toEqual({ amount: 1500, unit: "g" });
  });
});

// --- computeIngredientCost ---

describe("computeIngredientCost", () => {
  it("computes cost based on unit price and recipe quantity", () => {
    // Offer: 400g for 45 DKK = 112.5 kr/kg. Recipe needs 500g for 4 servings, household of 4.
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const cost = computeIngredientCost(offer, "500 g", 4, 4);
    // 45/400 * 500 * (4/4) = 56.25
    expect(cost).toBeCloseTo(56.25, 2);
  });

  it("scales by household size vs recipe servings", () => {
    // Same offer, but household of 2 eating a recipe for 4
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const cost = computeIngredientCost(offer, "500 g", 4, 2);
    // 45/400 * 500 * (2/4) = 28.125
    expect(cost).toBeCloseTo(28.13, 2);
  });

  it("handles kg recipe vs g offer", () => {
    // Offer: 400g for 45 DKK. Recipe: 1 kg. Household matches servings.
    const offer = makeOffer({ price: 45, quantity: 400, unit: "g" });
    const cost = computeIngredientCost(offer, "1 kg", 4, 4);
    // 45/400 * 1000 * 1 = 112.5
    expect(cost).toBeCloseTo(112.5, 2);
  });

  it("handles dl recipe vs ml offer", () => {
    // Offer: 1000ml for 20 DKK. Recipe: 2 dl (200ml).
    const offer = makeOffer({ price: 20, quantity: 1000, unit: "ml" });
    const cost = computeIngredientCost(offer, "2 dl", 4, 4);
    // 20/1000 * 200 * 1 = 4
    expect(cost).toBeCloseTo(4, 2);
  });

  it("falls back to sticker price * scale for unknown units", () => {
    const offer = makeOffer({ price: 25 });
    const cost = computeIngredientCost(offer, "3 fed", 4, 4);
    // Can't parse "fed", falls back to 25 * (4/4) = 25
    expect(cost).toBe(25);
  });

  it("falls back to sticker price * scale when offer has no quantity", () => {
    const offer = makeOffer({ price: 30, quantity: null, unit: null });
    const cost = computeIngredientCost(offer, "500 g", 4, 2);
    // 30 * (2/4) = 15
    expect(cost).toBe(15);
  });

  it("falls back when units are incompatible (g vs ml)", () => {
    const offer = makeOffer({ price: 20, quantity: 500, unit: "ml" });
    const cost = computeIngredientCost(offer, "500 g", 4, 4);
    // Incompatible units, falls back to 20 * (4/4) = 20
    expect(cost).toBe(20);
  });

  it("returns 0 for null price", () => {
    const offer = makeOffer({ price: null });
    expect(computeIngredientCost(offer, "500 g", 4, 4)).toBe(0);
  });

  it("returns 0 for zero price", () => {
    const offer = makeOffer({ price: 0 });
    expect(computeIngredientCost(offer, "500 g", 4, 4)).toBe(0);
  });
});

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

  it("penalizes modifier position (term after preposition)", () => {
    const offer = makeOffer({ heading: "Tunfilet i olivenolie" });
    const ing = makeIngredient({ category: "pantry" });
    const score = scoreDealMatch(offer, ing, "olivenolie", new Set());
    // Should get modifier penalty, well below confident threshold
    expect(score).toBeLessThan(SCORE.CONFIDENT_THRESHOLD);
  });

  it("does not penalize when term is the primary product", () => {
    const offer = makeOffer({ heading: "Olivenolie extra virgin" });
    const ing = makeIngredient({ category: "pantry" });
    const score = scoreDealMatch(offer, ing, "olivenolie", new Set());
    expect(score).toBe(SCORE.BASE + SCORE.EXACT_MATCH_BONUS);
  });

  it("penalizes when term not found at all in heading", () => {
    const offer = makeOffer({ heading: "Vaseline lotion" });
    const ing = makeIngredient({ category: "pantry" });
    const score = scoreDealMatch(offer, ing, "MSG", new Set());
    expect(score).toBe(0);
  });
});

// --- isModifierPosition ---

describe("isModifierPosition", () => {
  it("detects term after 'i'", () => {
    expect(isModifierPosition("tunfilet i olivenolie", "olivenolie")).toBe(true);
  });

  it("detects term after 'med'", () => {
    expect(isModifierPosition("pizza med hvidløg", "hvidløg")).toBe(true);
  });

  it("detects term after 'og'", () => {
    expect(isModifierPosition("ost og skinke", "skinke")).toBe(true);
  });

  it("returns false when term starts the heading", () => {
    expect(isModifierPosition("olivenolie extra virgin", "olivenolie")).toBe(false);
  });

  it("returns false when term is not after a preposition", () => {
    expect(isModifierPosition("hakket oksekød 7-10%", "oksekød")).toBe(false);
  });

  it("returns false when term not found", () => {
    expect(isModifierPosition("hakket oksekød", "laks")).toBe(false);
  });
});

// --- findBestDeal ---

describe("findBestDeal", () => {
  it("returns confidence none when no deals match", () => {
    const ing = makeIngredient();
    const dealMap = new Map<string, Offer[]>();
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.best).toBeNull();
    expect(result.confidence).toBe("none");
    expect(result.candidates).toHaveLength(0);
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
    expect(result.best).toBe(rawOffer);
  });

  it("picks cheaper offer when scores tie", () => {
    const cheap = makeOffer({
      id: "cheap",
      heading: "Hakket oksekød",
      price: 30,
    });
    const expensive = makeOffer({
      id: "expensive",
      heading: "Hakket oksekød",
      price: 60,
    });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "dairy" });
    const dealMap = new Map([["oksekød", [expensive, cheap]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.best).toBe(cheap);
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
    expect(result.best).toBe(offer);
  });

  it("returns high confidence for strong matches", () => {
    const offer = makeOffer({
      heading: "Hakket oksekød 7-10%",
      price: 45,
      store: "Netto",
    });
    const ing = makeIngredient({ searchTerms: ["hakket oksekød"] });
    const preferred = new Set(["Netto"]);
    const dealMap = new Map([["hakket oksekød", [offer]]]);
    const result = findBestDeal(ing, dealMap, preferred);
    expect(result.confidence).toBe("high");
  });

  it("returns low confidence for modifier matches", () => {
    const offer = makeOffer({ heading: "Tunfilet i olivenolie", price: 20 });
    const ing = makeIngredient({
      name: "olivenolie",
      searchTerms: ["olivenolie"],
      category: "pantry",
    });
    const dealMap = new Map([["olivenolie", [offer]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    // Modifier match should be low confidence (if it passes viability at all)
    if (result.best) {
      expect(result.confidence).toBe("low");
    } else {
      expect(result.confidence).toBe("none");
    }
  });

  it("returns up to 3 candidates", () => {
    const offer1 = makeOffer({ id: "a", heading: "Hakket oksekød", price: 45 });
    const offer2 = makeOffer({
      id: "b",
      heading: "Oksekød i strimler",
      price: 55,
    });
    const offer3 = makeOffer({ id: "c", heading: "Fersk oksekød", price: 50 });
    const offer4 = makeOffer({ id: "d", heading: "Dansk oksekød", price: 60 });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "dairy" });
    const dealMap = new Map([["oksekød", [offer1, offer2, offer3, offer4]]]);
    const result = findBestDeal(ing, dealMap, new Set());
    expect(result.candidates.length).toBeLessThanOrEqual(3);
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
    const chickenCount = result?.recipes.filter((r) => r.proteinType === "chicken").length ?? 0;
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
    const italianCount = result?.recipes.filter((r) => r.cuisineType === "italian").length ?? 0;
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
    const slowCount = result?.recipes.filter((r) => r.complexity === "slow").length ?? 0;
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
    const slowIdx = result?.recipes.findIndex((r) => r.complexity === "slow") ?? -1;
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
