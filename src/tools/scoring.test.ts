/**
 * Unit tests for src/tools/scoring.ts — scoreAllRecipes and the score_recipes tool.
 *
 * The api and store layers are mocked; src/scoring.ts (matching, costing,
 * weekly optimisation) runs for real, so these exercise the whole scoring
 * pipeline from a recipe library down to rendered output.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
import type { Offer } from "../api.js";
import { getLocale } from "../locales.js";
import type { Household, Recipe } from "../store.js";

vi.mock("../api.js", () => ({
  searchDealsBatch: vi.fn(),
}));

vi.mock("../store.js", () => ({
  getRecipes: vi.fn(),
  getHousehold: vi.fn(),
  getPantry: vi.fn(),
}));

const api = await import("../api.js");
const store = await import("../store.js");
const { registerScoringTools, scoreAllRecipes } = await import("./scoring.js");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer-1",
    heading: "Mælk 1L",
    description: null,
    price: 12,
    prePrice: null,
    currency: "DKK",
    quantity: 1,
    unit: "l",
    pricePerUnit: "12.00 kr/L",
    store: "Netto",
    storeId: "n1",
    validFrom: "2026-06-10",
    validUntil: "2026-06-30T00:00:00Z",
    imageUrl: null,
    ...overrides,
  };
}

function makeHousehold(overrides: Partial<Household> = {}): Household {
  return {
    people: [],
    stores: [],
    defaultServings: 2,
    country: "DK",
    ...overrides,
  };
}

/** Recipe whose single ingredient matches "Hakket oksekød" at high confidence. */
function beefRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "Bolognese",
    servings: 4,
    complexity: "medium",
    cuisineType: "italian",
    proteinType: "beef",
    ingredients: [
      {
        name: "Hakket oksekød",
        quantity: "500g",
        searchTerms: ["hakket oksekød"],
        category: "meat",
      },
    ],
    ...overrides,
  };
}

const beefOffer = makeOffer({
  id: "beef",
  heading: "Hakket oksekød 8-12%",
  price: 45,
  quantity: 500,
  unit: "g",
  pricePerUnit: "90.00 kr/kg",
});

let stub: ServerStub;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
  stub = createServerStub();
  registerScoringTools(stub.server);
});

describe("scoreAllRecipes", () => {
  it("short-circuits without hitting the API when there are no recipes", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([]);
    const result = await scoreAllRecipes(new Set(), new Set(), 2);
    expect(result.scored).toEqual([]);
    expect(result.dealMap.size).toBe(0);
    expect(api.searchDealsBatch).not.toHaveBeenCalled();
  });

  it("batches every expanded search term once, at the locale's country", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Oksefars",
            quantity: "500g",
            searchTerms: ["oksefars"],
            category: "meat",
          },
          {
            name: "Løg",
            quantity: "2 stk",
            searchTerms: ["løg"],
            category: "produce",
          },
        ],
      }),
    ]);
    await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));

    const [terms, limit, country] = vi.mocked(api.searchDealsBatch).mock.calls[0];
    // "oksefars" expands to include the "hakket oksekød" synonym.
    expect(terms).toContain("oksefars");
    expect(terms).toContain("hakket oksekød");
    expect(terms).toContain("løg");
    expect(new Set(terms).size).toBe(terms.length);
    expect(limit).toBe(8);
    expect(country).toBe("DK");
  });

  it("excludes pantry ingredients from both the search and the coverage denominator", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Hakket oksekød",
            quantity: "500g",
            searchTerms: ["hakket oksekød"],
            category: "meat",
          },
          {
            name: "Salt",
            quantity: "1 tsk",
            searchTerms: ["salt"],
            category: "pantry",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const { scored } = await scoreAllRecipes(new Set(), new Set(["salt"]), 2, getLocale("DK"));

    expect(vi.mocked(api.searchDealsBatch).mock.calls[0][0]).not.toContain("salt");
    expect(scored[0].ingredients.map((i) => i.name)).toEqual(["Hakket oksekød"]);
    // 1 of 1 non-pantry ingredient matched.
    expect(scored[0].dealCoverage).toBe(100);
  });

  it("costs a matched ingredient by unit price scaled to household size", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    const ing = scored[0].ingredients[0];

    expect(ing.confidence).toBe("high");
    expect(ing.bestDeal).toEqual({
      heading: "Hakket oksekød 8-12%",
      price: 22.5,
      store: "Netto",
    });
    // 45 kr / 500 g = 0.09 kr/g; 500 g scaled by 2/4 servings = 250 g -> 22.50 kr
    expect(scored[0].estimatedCost).toBe(22.5);
  });

  it("reports zero coverage and zero cost when nothing matches", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    expect(scored[0].dealCoverage).toBe(0);
    expect(scored[0].estimatedCost).toBe(0);
    expect(scored[0].ingredients[0].bestDeal).toBeNull();
    expect(scored[0].ingredients[0].confidence).toBe("none");
  });

  it("treats an all-pantry recipe as fully covered rather than dividing by zero", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Salt",
            quantity: "1 tsk",
            searchTerms: ["salt"],
            category: "pantry",
          },
        ],
      }),
    ]);
    const { scored } = await scoreAllRecipes(new Set(), new Set(["salt"]), 2, getLocale("DK"));
    expect(scored[0].dealCoverage).toBe(100);
    expect(scored[0].ingredients).toEqual([]);
  });

  it("attaches alternative candidates only for low-confidence matches", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Mælk",
            quantity: "5 dl",
            searchTerms: ["mælk"],
            category: "other",
          },
        ],
      }),
    ]);
    // "øko mælk eller fløde" is a bundle heading with a non-leading match,
    // which scores below the confident threshold.
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "mælk",
          [
            makeOffer({ id: "m1", heading: "Øko mælk eller fløde", price: 12 }),
            makeOffer({
              id: "m2",
              heading: "Sød mælk eller kærnemælk",
              price: 14,
            }),
          ],
        ],
      ]),
    );

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    const ing = scored[0].ingredients[0];
    expect(ing.confidence).toBe("low");
    expect(ing.candidates).toBeDefined();
    expect(ing.candidates?.length).toBeGreaterThan(1);
    expect(ing.candidates?.[0]).toMatchObject({ store: "Netto" });
  });

  it("sorts by deal coverage first, then by cost", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "NoDeals" }),
      beefRecipe({ name: "Covered" }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const { scored } = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    // Both recipes share the same ingredient, so both are 100% covered and
    // ordering falls through to cost, which is equal — assert coverage instead.
    expect(scored.every((r) => r.dealCoverage === 100)).toBe(true);

    // Now make one recipe uncoverable and confirm it sinks to the bottom.
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        name: "NoDeals",
        ingredients: [
          {
            name: "Enhjørning",
            quantity: "1 stk",
            searchTerms: ["enhjørning"],
            category: "meat",
          },
        ],
      }),
      beefRecipe({ name: "Covered" }),
    ]);
    const second = await scoreAllRecipes(new Set(), new Set(), 2, getLocale("DK"));
    expect(second.scored.map((r) => r.name)).toEqual(["Covered", "NoDeals"]);
  });

  it("drops offers from non-preferred stores once preferences exist", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["hakket oksekød", [makeOffer({ ...beefOffer, store: "Lidl" })]]]),
    );

    const { scored } = await scoreAllRecipes(new Set(["Netto"]), new Set(), 2, getLocale("DK"));
    expect(scored[0].ingredients[0].bestDeal).toBeNull();
    expect(scored[0].dealCoverage).toBe(0);
  });
});

describe("score_recipes tool", () => {
  it("is registered with when-to-use and when-not-to-use guidance", () => {
    const description = stub.tools.get("score_recipes")?.description ?? "";
    expect(description).toContain("USE WHEN");
    expect(description).toContain("NOT FOR");
  });

  it("says there is nothing to score when the library is empty", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("# Recipe scores (0 recipes)");
    expect(text).toContain("No recipes to score. Add recipes first.");
  });

  it("renders cost, coverage, metadata, and the matched deal per recipe", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("# Recipe scores (1 recipes)");
    expect(text).toContain("## Bolognese — 23 DKK (deals on 100% of ingredients)");
    expect(text).toContain("medium | italian | beef | 4 servings");
    expect(text).toContain("Deals:");
    expect(text).toContain("Hakket oksekød (500g): Hakket oksekød 8-12% — 23 DKK @ Netto");
  });

  it("uses the household country's currency", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold({ country: "FI" }));
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("EUR (deals on 100% of ingredients)");
  });

  it("lists unmatched ingredients under a No deals line", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("No deals: Hakket oksekød (500g)");
  });

  it("separates uncertain matches and shows the runner-up candidates", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Mælk",
            quantity: "5 dl",
            searchTerms: ["mælk"],
            category: "other",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "mælk",
          [
            makeOffer({ id: "m1", heading: "Øko mælk eller fløde", price: 12 }),
            makeOffer({
              id: "m2",
              heading: "Sød mælk eller kærnemælk",
              price: 14,
            }),
          ],
        ],
      ]),
    );

    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).toContain("⚠ Uncertain matches (verify these):");
    expect(text).toContain("[low confidence]");
    expect(text).toContain("Other candidates:");
    expect(text).toContain("Sød mælk eller kærnemælk");
  });

  it("omits the plan section unless optimize is set", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef" }),
      beefRecipe({ name: "B", proteinType: "chicken" }),
    ]);
    const text = textOf(await callTool(stub, "score_recipes", {}));
    expect(text).not.toContain("Optimized");
  });

  it("appends a day-by-day plan when optimize is set and enough recipes exist", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef", cuisineType: "italian" }),
      beefRecipe({ name: "B", proteinType: "chicken", cuisineType: "asian" }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map([["hakket oksekød", [beefOffer]]]));

    const text = textOf(await callTool(stub, "score_recipes", { optimize: true, days: 2 }));
    expect(text).toContain("# Optimized 2-day plan");
    expect(text).toContain("Total basket: ~");
    expect(text).toContain("Unique items to buy:");
    expect(text).toContain("Day 1:");
    expect(text).toContain("Day 2:");
  });

  it("skips the plan when there are fewer recipes than days", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe({ name: "A" })]);
    const text = textOf(await callTool(stub, "score_recipes", { optimize: true, days: 3 }));
    expect(text).toContain("# Recipe scores (1 recipes)");
    expect(text).not.toContain("Optimized");
  });

  it("explains which knobs to relax when the constraints admit no plan", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef" }),
      beefRecipe({ name: "B", proteinType: "beef" }),
    ]);
    const text = textOf(
      await callTool(stub, "score_recipes", {
        optimize: true,
        days: 2,
        maxPerProtein: 1,
      }),
    );
    expect(text).toContain("# Optimized 2-day plan");
    expect(text).toContain("Could not find a valid combination with the variety constraints");
    expect(text).toContain("maxPerProtein");
  });

  it("honours dietary exclusions when optimising", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "Beefy", proteinType: "beef" }),
      beefRecipe({ name: "Chicken", proteinType: "chicken" }),
      beefRecipe({ name: "Veggie", proteinType: "vegetarian" }),
    ]);
    const text = textOf(
      await callTool(stub, "score_recipes", {
        optimize: true,
        days: 2,
        excludeProteins: ["beef"],
      }),
    );
    expect(text).toContain("# Optimized 2-day plan");
    const planSection = text.slice(text.indexOf("# Optimized"));
    expect(planSection).not.toContain("Beefy");
  });

  it("returns a structured error when the deal batch fails", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockRejectedValue(new Error("upstream 500"));
    const result = await callTool(stub, "score_recipes", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to score recipes: upstream 500");
  });

  it("rejects a non-numeric days argument", async () => {
    await expect(callTool(stub, "score_recipes", { days: "seven" })).rejects.toThrow();
  });
});
