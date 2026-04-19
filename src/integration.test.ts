/**
 * Integration tests for multi-country support (DK, NO, SE, FI).
 * Tests locale system, scoring with locale terms, dietary exclusions,
 * and meal plan optimization across different household configurations.
 *
 * These are unit-level tests using mock offers (no live API calls).
 */

import { describe, expect, it } from "vitest";
import type { Offer } from "./api.js";
import { type CountryCode, getLocale, SUPPORTED_COUNTRIES } from "./locales.js";
import {
  expandSearchTerms,
  findBestDeal,
  findExcludedTag,
  findOptimalWeek,
  isModifierPosition,
  SCORE,
  type ScoredIngredient,
  type ScoredRecipe,
  scoreDealMatch,
} from "./scoring.js";
import type { Ingredient } from "./store.js";

// --- Helpers ---

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "test-1",
    heading: "Test product",
    description: null,
    price: 50,
    prePrice: null,
    currency: "DKK",
    quantity: 500,
    unit: "g",
    pricePerUnit: "100.00 kr/kg",
    store: "TestStore",
    storeId: "test-id",
    validFrom: "2026-01-01",
    validUntil: "2026-12-31",
    imageUrl: null,
    ...overrides,
  };
}

function makeIngredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    name: "Test ingredient",
    quantity: "500g",
    searchTerms: ["test"],
    category: "other",
    ...overrides,
  };
}

function makeScoredRecipe(overrides: Partial<ScoredRecipe> = {}): ScoredRecipe {
  return {
    name: "Test Recipe",
    servings: 4,
    complexity: "medium",
    proteinType: "chicken",
    cuisineType: "other",
    estimatedCost: 100,
    dealCoverage: 80,
    ingredients: [],
    ...overrides,
  };
}

function makeScoredIngredient(overrides: Partial<ScoredIngredient> = {}): ScoredIngredient {
  return {
    name: "test",
    quantity: "500g",
    category: "other",
    bestDeal: null,
    estimatedCost: 0,
    confidence: "none",
    ...overrides,
  };
}

// ============================================================
// Locale system
// ============================================================

describe("Locale system", () => {
  it("supports all four countries", () => {
    expect(SUPPORTED_COUNTRIES).toEqual(["DK", "NO", "SE", "FI"]);
  });

  it("returns DK locale by default", () => {
    const locale = getLocale("DK");
    expect(locale.country).toBe("DK");
    expect(locale.currency).toBe("DKK");
  });

  it("returns NO locale", () => {
    const locale = getLocale("NO");
    expect(locale.country).toBe("NO");
    expect(locale.currency).toBe("NOK");
  });

  it("returns SE locale", () => {
    const locale = getLocale("SE");
    expect(locale.country).toBe("SE");
    expect(locale.currency).toBe("SEK");
  });

  it("falls back to DK for unknown country", () => {
    const locale = getLocale("XX");
    expect(locale.country).toBe("DK");
  });

  it("is case-insensitive", () => {
    expect(getLocale("no").country).toBe("NO");
    expect(getLocale("se").country).toBe("SE");
  });

  for (const code of SUPPORTED_COUNTRIES) {
    describe(`${code} locale completeness`, () => {
      const locale = getLocale(code);

      it("has processed indicators", () => {
        expect(locale.processedIndicators.length).toBeGreaterThan(5);
      });

      it("has raw indicators", () => {
        expect(locale.rawIndicators.length).toBeGreaterThan(5);
      });

      it("has non-ingredient indicators", () => {
        expect(locale.nonIngredientIndicators.length).toBeGreaterThan(5);
      });

      it("has modifier prepositions", () => {
        expect(locale.modifierPrepositions.length).toBeGreaterThan(3);
      });

      it("has synonym map entries", () => {
        expect(Object.keys(locale.synonymMap).length).toBeGreaterThan(3);
      });

      it("has ingredient tags for all dietary categories", () => {
        const requiredTags = [
          "pork",
          "beef",
          "lamb",
          "fish",
          "shellfish",
          "dairy",
          "gluten",
          "beans",
          "nuts",
          "egg",
        ];
        for (const tag of requiredTags) {
          expect(locale.ingredientTags[tag]).toBeDefined();
          expect(locale.ingredientTags[tag].length).toBeGreaterThan(0);
        }
      });

      it("has known stores", () => {
        expect(Object.keys(locale.knownStores).length).toBeGreaterThan(3);
      });

      it("has bundle patterns", () => {
        expect(locale.bundlePatterns.length).toBeGreaterThan(0);
      });
    });
  }
});

// ============================================================
// Synonym expansion per locale
// ============================================================

describe("Synonym expansion", () => {
  it("expands Danish synonyms", () => {
    const dk = getLocale("DK");
    const expanded = expandSearchTerms(["svinekød"], dk.synonymMap);
    expect(expanded).toContain("svinekød");
    expect(expanded).toContain("grisekød");
  });

  it("expands Norwegian synonyms", () => {
    const no = getLocale("NO");
    const expanded = expandSearchTerms(["svinekjøtt"], no.synonymMap);
    expect(expanded).toContain("svinekjøtt");
    expect(expanded).toContain("grisekjøtt");
  });

  it("expands Swedish synonyms", () => {
    const se = getLocale("SE");
    const expanded = expandSearchTerms(["fläskkött"], se.synonymMap);
    expect(expanded).toContain("fläskkött");
    expect(expanded).toContain("griskött");
  });

  it("passes through unknown terms unchanged", () => {
    const dk = getLocale("DK");
    const expanded = expandSearchTerms(["xyzabc"], dk.synonymMap);
    expect(expanded).toEqual(["xyzabc"]);
  });
});

// ============================================================
// Scoring with locale-specific indicators
// ============================================================

describe("Scoring with locale", () => {
  const preferredStores = new Set(["TestStore"]);

  describe("Danish processed/raw detection", () => {
    const dk = getLocale("DK");

    it("penalizes Danish processed meat terms", () => {
      const offer = makeOffer({ heading: "Røget laks" });
      const ing = makeIngredient({ name: "Laks", category: "meat", searchTerms: ["laks"] });
      const score = scoreDealMatch(offer, ing, "laks", preferredStores, dk);
      // "røget" is a processed indicator -> penalty
      const baseScore = scoreDealMatch(
        makeOffer({ heading: "Laks filet" }),
        ing,
        "laks",
        preferredStores,
        dk,
      );
      expect(score).toBeLessThan(baseScore);
    });

    it("gives raw bonus for Danish raw terms", () => {
      const offer = makeOffer({ heading: "Fersk kyllingebryst" });
      const ing = makeIngredient({ name: "Kylling", category: "meat", searchTerms: ["kylling"] });
      const score = scoreDealMatch(offer, ing, "kylling", preferredStores, dk);
      expect(score).toBeGreaterThan(SCORE.BASE);
    });
  });

  describe("Norwegian processed/raw detection", () => {
    const no = getLocale("NO");

    it("penalizes Norwegian processed meat terms", () => {
      const offer = makeOffer({ heading: "Røkt laks", currency: "NOK" });
      const ing = makeIngredient({ name: "Laks", category: "meat", searchTerms: ["laks"] });
      const score = scoreDealMatch(offer, ing, "laks", preferredStores, no);
      const baseScore = scoreDealMatch(
        makeOffer({ heading: "Laks filet", currency: "NOK" }),
        ing,
        "laks",
        preferredStores,
        no,
      );
      expect(score).toBeLessThan(baseScore);
    });

    it("gives raw bonus for Norwegian raw terms", () => {
      const offer = makeOffer({ heading: "Fersk kyllingbryst", currency: "NOK" });
      const ing = makeIngredient({ name: "Kylling", category: "meat", searchTerms: ["kylling"] });
      const score = scoreDealMatch(offer, ing, "kylling", preferredStores, no);
      expect(score).toBeGreaterThan(SCORE.BASE);
    });
  });

  describe("Swedish processed/raw detection", () => {
    const se = getLocale("SE");

    it("penalizes Swedish processed meat terms", () => {
      const offer = makeOffer({ heading: "Rökt lax", currency: "SEK" });
      const ing = makeIngredient({ name: "Lax", category: "meat", searchTerms: ["lax"] });
      const score = scoreDealMatch(offer, ing, "lax", preferredStores, se);
      const baseScore = scoreDealMatch(
        makeOffer({ heading: "Lax filé", currency: "SEK" }),
        ing,
        "lax",
        preferredStores,
        se,
      );
      expect(score).toBeLessThan(baseScore);
    });

    it("gives raw bonus for Swedish raw terms", () => {
      const offer = makeOffer({ heading: "Färsk kycklingbröst", currency: "SEK" });
      const ing = makeIngredient({ name: "Kyckling", category: "meat", searchTerms: ["kyckling"] });
      const score = scoreDealMatch(offer, ing, "kyckling", preferredStores, se);
      expect(score).toBeGreaterThan(SCORE.BASE);
    });
  });

  describe("Finnish processed/raw detection", () => {
    const fi = getLocale("FI");

    it("penalizes Finnish processed meat terms", () => {
      const offer = makeOffer({ heading: "Savustettu lohi", currency: "EUR" });
      const ing = makeIngredient({ name: "Lohi", category: "meat", searchTerms: ["lohi"] });
      const score = scoreDealMatch(offer, ing, "lohi", preferredStores, fi);
      const baseScore = scoreDealMatch(
        makeOffer({ heading: "Lohi filee", currency: "EUR" }),
        ing,
        "lohi",
        preferredStores,
        fi,
      );
      expect(score).toBeLessThan(baseScore);
    });

    it("gives raw bonus for Finnish raw terms", () => {
      const offer = makeOffer({ heading: "Tuore kananrinta", currency: "EUR" });
      const ing = makeIngredient({ name: "Kana", category: "meat", searchTerms: ["kana"] });
      const score = scoreDealMatch(offer, ing, "kana", preferredStores, fi);
      expect(score).toBeGreaterThan(SCORE.BASE);
    });

    it("gives raw bonus for jauheliha (ground meat)", () => {
      const offer = makeOffer({ heading: "Atria jauheliha 400 g", currency: "EUR" });
      const ing = makeIngredient({
        name: "Jauheliha",
        category: "meat",
        searchTerms: ["jauheliha"],
      });
      const score = scoreDealMatch(offer, ing, "jauheliha", preferredStores, fi);
      expect(score).toBeGreaterThan(SCORE.BASE);
    });
  });

  describe("Non-ingredient rejection per locale", () => {
    it("rejects Danish non-food items", () => {
      const dk = getLocale("DK");
      const offer = makeOffer({ heading: "Vaseline creme" });
      const ing = makeIngredient({ searchTerms: ["creme"] });
      expect(scoreDealMatch(offer, ing, "creme", preferredStores, dk)).toBe(0);
    });

    it("rejects Norwegian non-food items", () => {
      const no = getLocale("NO");
      const offer = makeOffer({ heading: "Sjampo tørt hår" });
      const ing = makeIngredient({ searchTerms: ["sjampo"] });
      expect(scoreDealMatch(offer, ing, "sjampo", preferredStores, no)).toBe(0);
    });

    it("rejects Swedish non-food items", () => {
      const se = getLocale("SE");
      const offer = makeOffer({ heading: "Diskmedel citron" });
      const ing = makeIngredient({ searchTerms: ["citron"] });
      expect(scoreDealMatch(offer, ing, "citron", preferredStores, se)).toBe(0);
    });

    it("rejects Finnish non-food items", () => {
      const fi = getLocale("FI");
      const offer = makeOffer({ heading: "Shampoo sitruuna" });
      const ing = makeIngredient({ searchTerms: ["sitruuna"] });
      expect(scoreDealMatch(offer, ing, "sitruuna", preferredStores, fi)).toBe(0);
    });

    it("rejects Finnish ready meals", () => {
      const fi = getLocale("FI");
      const offer = makeOffer({ heading: "Valmisruoka lihapullat" });
      const ing = makeIngredient({ searchTerms: ["lihapullat"] });
      expect(scoreDealMatch(offer, ing, "lihapullat", preferredStores, fi)).toBe(0);
    });
  });

  describe("Modifier prepositions per locale", () => {
    it("detects Danish modifier position", () => {
      const dk = getLocale("DK");
      expect(
        isModifierPosition("tunfilet i olivenolie", "olivenolie", dk.modifierPrepositions),
      ).toBe(true);
      expect(
        isModifierPosition("olivenolie til stegning", "olivenolie", dk.modifierPrepositions),
      ).toBe(false);
    });

    it("detects Swedish modifier position with 'och'", () => {
      const se = getLocale("SE");
      expect(
        isModifierPosition(
          "kycklingfilé med ris och grönsaker",
          "grönsaker",
          se.modifierPrepositions,
        ),
      ).toBe(true);
    });
  });
});

// ============================================================
// Dietary exclusions per locale
// ============================================================

describe("Dietary exclusions per locale", () => {
  describe("DK ingredient tags", () => {
    const dk = getLocale("DK");

    it("detects pork by ingredient name", () => {
      const ingredients = [makeScoredIngredient({ name: "Bacon" })];
      expect(findExcludedTag(ingredients, ["pork"], dk.ingredientTags)).toBe("pork");
    });

    it("detects dairy by ingredient name", () => {
      const ingredients = [makeScoredIngredient({ name: "Piskefløde" })];
      expect(findExcludedTag(ingredients, ["dairy"], dk.ingredientTags)).toBe("dairy");
    });

    it("does not false-positive on unrelated ingredients", () => {
      const ingredients = [makeScoredIngredient({ name: "Ris" })];
      expect(findExcludedTag(ingredients, ["pork", "dairy"], dk.ingredientTags)).toBeNull();
    });
  });

  describe("NO ingredient tags", () => {
    const no = getLocale("NO");

    it("detects pork via Norwegian terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Bacon" })];
      expect(findExcludedTag(ingredients, ["pork"], no.ingredientTags)).toBe("pork");
    });

    it("detects fish via Norwegian terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Ørret" })];
      expect(findExcludedTag(ingredients, ["fish"], no.ingredientTags)).toBe("fish");
    });

    it("detects gluten via Norwegian terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Hvetemel" })];
      expect(findExcludedTag(ingredients, ["gluten"], no.ingredientTags)).toBe("gluten");
    });
  });

  describe("SE ingredient tags", () => {
    const se = getLocale("SE");

    it("detects pork via Swedish terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Fläsk" })];
      expect(findExcludedTag(ingredients, ["pork"], se.ingredientTags)).toBe("pork");
    });

    it("detects dairy via Swedish terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Vispgrädde" })];
      expect(findExcludedTag(ingredients, ["dairy"], se.ingredientTags)).toBe("dairy");
    });

    it("detects nuts via Swedish terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Cashewnötter" })];
      expect(findExcludedTag(ingredients, ["nuts"], se.ingredientTags)).toBe("nuts");
    });

    it("detects eggs via Swedish terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Ägg" })];
      expect(findExcludedTag(ingredients, ["egg"], se.ingredientTags)).toBe("egg");
    });
  });

  describe("FI ingredient tags", () => {
    const fi = getLocale("FI");

    it("detects pork via Finnish terms (pekoni)", () => {
      const ingredients = [makeScoredIngredient({ name: "Pekoni" })];
      expect(findExcludedTag(ingredients, ["pork"], fi.ingredientTags)).toBe("pork");
    });

    it("detects dairy via Finnish terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Vispikerma" })];
      expect(findExcludedTag(ingredients, ["dairy"], fi.ingredientTags)).toBe("dairy");
    });

    it("detects fish via Finnish terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Turska" })];
      expect(findExcludedTag(ingredients, ["fish"], fi.ingredientTags)).toBe("fish");
    });

    it("detects gluten via Finnish terms", () => {
      const ingredients = [makeScoredIngredient({ name: "Vehnäjauho" })];
      expect(findExcludedTag(ingredients, ["gluten"], fi.ingredientTags)).toBe("gluten");
    });

    it("detects eggs via Finnish term (kananmuna)", () => {
      const ingredients = [makeScoredIngredient({ name: "Kananmuna" })];
      expect(findExcludedTag(ingredients, ["egg"], fi.ingredientTags)).toBe("egg");
    });
  });
});

// ============================================================
// findBestDeal with locale
// ============================================================

describe("findBestDeal with locale", () => {
  it("uses Norwegian synonyms to expand search", () => {
    const no = getLocale("NO");
    const dealMap = new Map<string, Offer[]>([
      [
        "grisekjøtt",
        [makeOffer({ id: "no-1", heading: "Grisekjøtt kvernet", price: 60, currency: "NOK" })],
      ],
    ]);
    const ing = { name: "Svinekjøtt", searchTerms: ["svinekjøtt"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set(), no);
    // "svinekjøtt" should expand to include "grisekjøtt" via NO synonyms
    expect(result.best).not.toBeNull();
    expect(result.best?.id).toBe("no-1");
  });

  it("uses Swedish synonyms to expand search", () => {
    const se = getLocale("SE");
    const dealMap = new Map<string, Offer[]>([
      [
        "griskött",
        [makeOffer({ id: "se-1", heading: "Griskött malet", price: 70, currency: "SEK" })],
      ],
    ]);
    const ing = { name: "Fläskkött", searchTerms: ["fläskkött"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set(), se);
    expect(result.best).not.toBeNull();
    expect(result.best?.id).toBe("se-1");
  });

  it("uses Finnish synonyms to expand search", () => {
    const fi = getLocale("FI");
    const dealMap = new Map<string, Offer[]>([
      [
        "broileri",
        [makeOffer({ id: "fi-1", heading: "Broileri fileepalat", price: 5.5, currency: "EUR" })],
      ],
    ]);
    const ing = { name: "Kana", searchTerms: ["kana"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set(), fi);
    // "kana" should expand to include "broileri" via FI synonyms
    expect(result.best).not.toBeNull();
    expect(result.best?.id).toBe("fi-1");
  });

  it("Finnish offer preserves EUR currency end-to-end", () => {
    const fi = getLocale("FI");
    const dealMap = new Map<string, Offer[]>([
      ["jauheliha", [makeOffer({ id: "fi-2", heading: "Jauheliha 400 g", price: 3.49, currency: "EUR" })]],
    ]);
    const ing = { name: "Jauheliha", searchTerms: ["jauheliha"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set(), fi);
    expect(result.best?.currency).toBe("EUR");
  });

  it("DK synonyms still work (backward compat)", () => {
    const dk = getLocale("DK");
    const dealMap = new Map<string, Offer[]>([
      ["grisekød", [makeOffer({ id: "dk-1", heading: "Grisekød hakket" })]],
    ]);
    const ing = { name: "Svinekød", searchTerms: ["svinekød"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set(), dk);
    expect(result.best).not.toBeNull();
  });

  it("works without locale (backward compat with DK defaults)", () => {
    const dealMap = new Map<string, Offer[]>([
      ["grisekød", [makeOffer({ id: "dk-2", heading: "Grisekød hakket" })]],
    ]);
    const ing = { name: "Svinekød", searchTerms: ["svinekød"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set()); // no locale
    expect(result.best).not.toBeNull();
  });
});

// ============================================================
// Meal plan optimization with dietary constraints per locale
// ============================================================

describe("Meal plan optimization across locales", () => {
  function makeRecipeSet(_locale: ReturnType<typeof getLocale>): ScoredRecipe[] {
    // Create a diverse set of 8 recipes for testing
    return [
      makeScoredRecipe({
        name: "Chicken Dish 1",
        proteinType: "chicken",
        cuisineType: "asian",
        complexity: "quick",
        estimatedCost: 80,
        ingredients: [makeScoredIngredient({ name: "kylling", category: "meat" })],
      }),
      makeScoredRecipe({
        name: "Chicken Dish 2",
        proteinType: "chicken",
        cuisineType: "italian",
        complexity: "medium",
        estimatedCost: 90,
        ingredients: [makeScoredIngredient({ name: "kylling", category: "meat" })],
      }),
      makeScoredRecipe({
        name: "Beef Dish",
        proteinType: "beef",
        cuisineType: "mexican",
        complexity: "medium",
        estimatedCost: 120,
        ingredients: [makeScoredIngredient({ name: "oksekød", category: "meat" })],
      }),
      makeScoredRecipe({
        name: "Pork Dish",
        proteinType: "pork",
        cuisineType: "danish",
        complexity: "quick",
        estimatedCost: 70,
        ingredients: [makeScoredIngredient({ name: "svinekød", category: "meat" })],
      }),
      makeScoredRecipe({
        name: "Fish Dish",
        proteinType: "fish",
        cuisineType: "asian",
        complexity: "quick",
        estimatedCost: 100,
        ingredients: [makeScoredIngredient({ name: "laks", category: "meat" })],
      }),
      makeScoredRecipe({
        name: "Veggie Dish 1",
        proteinType: "vegetarian",
        cuisineType: "italian",
        complexity: "quick",
        estimatedCost: 50,
        ingredients: [makeScoredIngredient({ name: "pasta", category: "pantry" })],
      }),
      makeScoredRecipe({
        name: "Veggie Dish 2",
        proteinType: "vegetarian",
        cuisineType: "asian",
        complexity: "medium",
        estimatedCost: 55,
        ingredients: [makeScoredIngredient({ name: "tofu", category: "other" })],
      }),
      makeScoredRecipe({
        name: "Slow Lamb",
        proteinType: "lamb",
        cuisineType: "danish",
        complexity: "slow",
        estimatedCost: 150,
        ingredients: [makeScoredIngredient({ name: "lam", category: "meat" })],
      }),
    ];
  }

  describe("Single person, no restrictions", () => {
    it("finds a 5-day plan", () => {
      const recipes = makeRecipeSet(getLocale("DK"));
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 2,
        maxSlowDays: 1,
      });
      expect(plan).not.toBeNull();
      expect(plan!.recipes.length).toBe(5);
    });
  });

  describe("Family with pork exclusion (Muslim household)", () => {
    it("excludes pork from meal plan", () => {
      const dk = getLocale("DK");
      const recipes = makeRecipeSet(dk);
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 2,
        maxSlowDays: 1,
        excludeProteins: ["pork"],
        ingredientTags: dk.ingredientTags,
      });
      expect(plan).not.toBeNull();
      expect(plan!.recipes.every((r) => r.proteinType !== "pork")).toBe(true);
    });

    it("catches hidden pork in ingredient names", () => {
      const dk = getLocale("DK");
      const recipes = [
        ...makeRecipeSet(dk).filter((r) => r.proteinType !== "pork"),
        makeScoredRecipe({
          name: "Veggie Soup with Bacon",
          proteinType: "vegetarian",
          cuisineType: "danish",
          complexity: "medium",
          estimatedCost: 60,
          ingredients: [
            makeScoredIngredient({ name: "bacon", category: "meat" }),
            makeScoredIngredient({ name: "kartofler", category: "produce" }),
          ],
        }),
      ];
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 2,
        maxSlowDays: 1,
        excludeProteins: ["pork"],
        ingredientTags: dk.ingredientTags,
      });
      expect(plan).not.toBeNull();
      // "Veggie Soup with Bacon" should be excluded despite proteinType=vegetarian
      expect(plan!.recipes.every((r) => r.name !== "Veggie Soup with Bacon")).toBe(true);
    });

    it("works with Norwegian ingredient tags", () => {
      const no = getLocale("NO");
      const recipes = [
        ...makeRecipeSet(no),
        makeScoredRecipe({
          name: "Ertestuing med Bacon",
          proteinType: "vegetarian",
          cuisineType: "other",
          complexity: "medium",
          estimatedCost: 55,
          ingredients: [makeScoredIngredient({ name: "bacon", category: "meat" })],
        }),
      ];
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 2,
        maxSlowDays: 1,
        excludeProteins: ["pork"],
        ingredientTags: no.ingredientTags,
      });
      expect(plan).not.toBeNull();
      expect(plan!.recipes.every((r) => r.name !== "Ertestuing med Bacon")).toBe(true);
    });

    it("works with Swedish ingredient tags", () => {
      const se = getLocale("SE");
      const recipes = [
        ...makeRecipeSet(se),
        makeScoredRecipe({
          name: "Ärtsoppa med Fläsk",
          proteinType: "vegetarian",
          cuisineType: "other",
          complexity: "medium",
          estimatedCost: 55,
          ingredients: [makeScoredIngredient({ name: "fläsk", category: "meat" })],
        }),
      ];
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 2,
        maxSlowDays: 1,
        excludeProteins: ["pork"],
        ingredientTags: se.ingredientTags,
      });
      expect(plan).not.toBeNull();
      expect(plan!.recipes.every((r) => r.name !== "Ärtsoppa med Fläsk")).toBe(true);
    });

    it("works with Finnish ingredient tags", () => {
      const fi = getLocale("FI");
      const recipes = [
        ...makeRecipeSet(fi),
        makeScoredRecipe({
          name: "Hernekeitto pekonilla",
          proteinType: "vegetarian",
          cuisineType: "other",
          complexity: "medium",
          estimatedCost: 6,
          ingredients: [makeScoredIngredient({ name: "pekoni", category: "meat" })],
        }),
      ];
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 2,
        maxSlowDays: 1,
        excludeProteins: ["pork"],
        ingredientTags: fi.ingredientTags,
      });
      expect(plan).not.toBeNull();
      expect(plan!.recipes.every((r) => r.name !== "Hernekeitto pekonilla")).toBe(true);
    });
  });

  describe("Lactose-free household", () => {
    it("excludes dairy across all locales", () => {
      for (const code of SUPPORTED_COUNTRIES) {
        const locale = getLocale(code);
        const dairyNames: Record<CountryCode, string> = {
          DK: "Piskefløde",
          NO: "Kremfløte",
          SE: "Vispgrädde",
          FI: "Vispikerma",
        };
        const recipes = [
          ...makeRecipeSet(locale),
          makeScoredRecipe({
            name: `Cream Sauce (${code})`,
            proteinType: "chicken",
            cuisineType: "italian",
            complexity: "quick",
            estimatedCost: 85,
            ingredients: [makeScoredIngredient({ name: dairyNames[code], category: "dairy" })],
          }),
        ];
        const plan = findOptimalWeek(recipes, 5, {
          maxPerProtein: 2,
          maxPerCuisine: 2,
          maxSlowDays: 1,
          excludeProteins: ["dairy"],
          ingredientTags: locale.ingredientTags,
        });
        expect(plan).not.toBeNull();
        expect(
          plan!.recipes.every((r) => r.name !== `Cream Sauce (${code})`),
          `${code}: cream sauce should be excluded`,
        ).toBe(true);
      }
    });
  });

  describe("Gluten-free household", () => {
    it("excludes gluten ingredients per locale", () => {
      for (const code of SUPPORTED_COUNTRIES) {
        const locale = getLocale(code);
        const glutenNames: Record<CountryCode, string> = {
          DK: "Pasta spaghetti",
          NO: "Pasta spaghetti",
          SE: "Pasta spaghetti",
          FI: "Pasta spagetti",
        };
        const ingredients = [makeScoredIngredient({ name: glutenNames[code] })];
        expect(
          findExcludedTag(ingredients, ["gluten"], locale.ingredientTags),
          `${code}: pasta should be tagged as gluten`,
        ).toBe("gluten");
      }
    });
  });

  describe("Pork allowed only on specific days", () => {
    it("places pork recipe only on allowed day", () => {
      const dk = getLocale("DK");
      const recipes = makeRecipeSet(dk);
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 3,
        maxSlowDays: 1,
        excludeProteins: ["pork"],
        allowProteinOnDays: { pork: [3] }, // allow pork on day 3 only
        ingredientTags: dk.ingredientTags,
      });
      expect(plan).not.toBeNull();
      // If pork appears, it must be on day 3 (index 2)
      for (let i = 0; i < plan!.recipes.length; i++) {
        if (plan!.recipes[i].proteinType === "pork") {
          expect(i + 1).toBe(3);
        }
      }
    });
  });

  describe("Slow recipes only on weekends", () => {
    it("restricts slow recipes to specified days", () => {
      const recipes = makeRecipeSet(getLocale("DK"));
      const plan = findOptimalWeek(recipes, 7, {
        maxPerProtein: 3,
        maxPerCuisine: 3,
        maxSlowDays: 2,
        slowOnlyOnDays: [6, 7], // weekends
      });
      expect(plan).not.toBeNull();
      for (let i = 0; i < plan!.recipes.length; i++) {
        if (plan!.recipes[i].complexity === "slow") {
          expect([6, 7]).toContain(i + 1);
        }
      }
    });
  });

  describe("Cuisine preferences", () => {
    it("respects soft cuisine preference", () => {
      const recipes = [
        ...makeRecipeSet(getLocale("DK")),
        makeScoredRecipe({
          name: "Asian Extra",
          proteinType: "vegetarian",
          cuisineType: "asian",
          complexity: "quick",
          estimatedCost: 45,
          ingredients: [],
        }),
      ];
      const plan = findOptimalWeek(recipes, 5, {
        maxPerProtein: 2,
        maxPerCuisine: 3,
        maxSlowDays: 1,
        preferCuisines: { asian: 2 },
      });
      expect(plan).not.toBeNull();
      const asianCount = plan!.recipes.filter((r) => r.cuisineType === "asian").length;
      // Best-effort; might not always hit 2 but should try
      expect(asianCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Large family (7 people, 7 days)", () => {
    it("handles full week planning with multiple constraints", () => {
      const dk = getLocale("DK");
      const recipes = makeRecipeSet(dk);
      const plan = findOptimalWeek(recipes, 7, {
        maxPerProtein: 2,
        maxPerCuisine: 3,
        maxSlowDays: 2,
        excludeProteins: ["shellfish"],
        slowOnlyOnDays: [6, 7],
        ingredientTags: dk.ingredientTags,
      });
      expect(plan).not.toBeNull();
      expect(plan!.recipes.length).toBe(7);
      // No shellfish
      expect(plan!.recipes.every((r) => r.proteinType !== "shellfish")).toBe(true);
    });
  });

  describe("Tight constraints (may fail gracefully)", () => {
    it("returns null when constraints are impossible", () => {
      const recipes = makeRecipeSet(getLocale("DK"));
      // Exclude everything except vegetarian, but need 7 days with maxPerProtein=1
      const plan = findOptimalWeek(recipes, 7, {
        maxPerProtein: 1,
        maxPerCuisine: 1,
        maxSlowDays: 0,
        excludeProteins: ["chicken", "beef", "pork", "fish", "lamb"],
      });
      // Only 2 vegetarian recipes exist; can't fill 7 days
      expect(plan).toBeNull();
    });
  });
});

// ============================================================
// Backward compatibility
// ============================================================

describe("Backward compatibility", () => {
  it("scoring works without locale parameter (DK defaults)", () => {
    const offer = makeOffer({ heading: "Røget laks" });
    const ing = makeIngredient({ name: "Laks", category: "meat", searchTerms: ["laks"] });
    // No locale passed - should use DK defaults
    const score = scoreDealMatch(offer, ing, "laks", new Set(["TestStore"]));
    expect(score).toBeGreaterThan(0);
  });

  it("expandSearchTerms works without synonym map (DK defaults)", () => {
    const expanded = expandSearchTerms(["svinekød"]);
    expect(expanded).toContain("grisekød");
  });

  it("findExcludedTag works without ingredient tags (DK defaults)", () => {
    const ingredients = [makeScoredIngredient({ name: "Bacon" })];
    const result = findExcludedTag(ingredients, ["pork"]);
    expect(result).toBe("pork");
  });

  it("findOptimalWeek works without ingredientTags in constraints", () => {
    const recipes = [
      makeScoredRecipe({
        name: "R1",
        proteinType: "chicken",
        cuisineType: "asian",
        estimatedCost: 80,
      }),
      makeScoredRecipe({
        name: "R2",
        proteinType: "beef",
        cuisineType: "italian",
        estimatedCost: 90,
      }),
      makeScoredRecipe({
        name: "R3",
        proteinType: "fish",
        cuisineType: "danish",
        estimatedCost: 100,
      }),
      makeScoredRecipe({
        name: "R4",
        proteinType: "vegetarian",
        cuisineType: "mexican",
        estimatedCost: 50,
      }),
      makeScoredRecipe({
        name: "R5",
        proteinType: "pork",
        cuisineType: "asian",
        estimatedCost: 70,
      }),
    ];
    const plan = findOptimalWeek(recipes, 5, {
      maxPerProtein: 1,
      maxPerCuisine: 2,
      maxSlowDays: 1,
    });
    expect(plan).not.toBeNull();
    expect(plan!.recipes.length).toBe(5);
  });
});
