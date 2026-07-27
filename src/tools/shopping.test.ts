/**
 * Unit tests for src/tools/shopping.ts — generate_shopping_list and plan_and_shop.
 *
 * The api and store layers are mocked; src/scoring.ts and src/tools/scoring.ts
 * run for real, so quantity aggregation, whole-pack costing, store grouping,
 * and the weekly optimiser are all exercised end to end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
import type { Offer } from "../api.js";
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
const { registerShoppingTools } = await import("./shopping.js");

const NOW = new Date("2026-06-15T12:00:00Z");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "beef",
    heading: "Hakket oksekød 8-12%",
    description: null,
    price: 45,
    prePrice: null,
    currency: "DKK",
    quantity: 500,
    unit: "g",
    pricePerUnit: "90.00 kr/kg",
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

const beefDeals = () => new Map([["hakket oksekød", [makeOffer()]]]);

let stub: ServerStub;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
  stub = createServerStub();
  registerShoppingTools(stub.server);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registerShoppingTools", () => {
  it("registers both shopping tools", () => {
    expect([...stub.tools.keys()].sort()).toEqual(["generate_shopping_list", "plan_and_shop"]);
  });

  it("tells the model when not to use each tool", () => {
    for (const tool of stub.tools.values()) {
      expect(tool.description, `${tool.name} description`).toContain("USE WHEN");
      expect(tool.description, `${tool.name} description`).toContain("NOT FOR");
    }
  });
});

describe("generate_shopping_list", () => {
  it("lists what is available when no recipe name matches", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe({ name: "Bolognese" })]);
    const text = textOf(await callTool(stub, "generate_shopping_list", { recipes: ["Sushi"] }));
    expect(text).toBe("No matching recipes found. Available: Bolognese");
  });

  it("points at add_recipe when the library is empty", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "generate_shopping_list", { recipes: ["Sushi"] }));
    expect(text).toBe("No matching recipes found. Available: none (add recipes first)");
  });

  it("matches recipe names case-insensitively", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["bOLOGNESE"],
      }),
    );
    expect(text).toContain("Shopping list for: Bolognese");
  });

  it("groups matched items under their store with pack maths and leftovers", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("Shopping list for: Bolognese (2 people)");
    expect(text).toContain("Estimated register total (deals only): ~45 kr");
    expect(text).toContain("## Netto (1 items)");
    // 500 g recipe quantity scaled from 4 servings to 2 people = 250 g needed,
    // bought as one 500 g pack at 45 kr, leaving 250 g over.
    expect(text).toContain("1. Hakket oksekød: need 250 g -> 45 kr = 45 kr");
    expect(text).toContain("[500 g/pack, 90.00 kr/kg]");
    expect(text).toContain("(250 g leftover)");
    expect(text).toContain("-- Hakket oksekød 8-12% @ Netto until 2026-06-30");
  });

  it("honours an explicit people override", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
        people: 8,
      }),
    );
    expect(text).toContain("(8 people)");
    // 500 g at 4 servings scaled to 8 people = 1 kg -> two 500 g packs.
    expect(text).toContain("need 1 kg -> 2 x 45 kr = 90 kr");
  });

  it("aggregates a shared ingredient across recipes and shows the arithmetic", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "Bolognese" }),
      beefRecipe({ name: "Chili", cuisineType: "mexican" }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese", "Chili"],
      }),
    );
    expect(text).toContain("Shopping list for: Bolognese, Chili");
    expect(text).toContain("need 250 g + 250 g = 500 g");
    // One 500 g pack covers both recipes.
    expect(text).toContain("-> 45 kr = 45 kr");
  });

  it("puts unmatched ingredients in the regular-price section with their source recipes", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Enhjørning",
            quantity: "1 stk",
            searchTerms: ["enhjørning"],
            category: "meat",
          },
        ],
      }),
    ]);
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## Buy at regular price (1 items)");
    expect(text).toContain("- Enhjørning (1 stk) [Bolognese]");
    expect(text).toContain("Estimated register total (deals only): ~0 kr");
  });

  it("skips pantry ingredients and names them at the bottom", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["Salt"]);
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
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## Skipped (in pantry): Salt");
    expect(text).not.toContain("- Salt (1 tsk)");
  });

  it("includes pantry items when excludePantry is false", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["Salt"]);
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
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
        excludePantry: false,
      }),
    );
    expect(text).toContain("- Salt (1 tsk) [Bolognese]");
    expect(text).not.toContain("Skipped (in pantry)");
  });

  it("says so when every ingredient is already in the pantry", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["Salt"]);
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
    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toBe("All ingredients are in your pantry. Nothing to buy!");
  });

  it("raises a buy-first section for deals expiring within two days", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([["hakket oksekød", [makeOffer({ validUntil: "2026-06-16T00:00:00Z" })]]]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## ⏰ Buy first (expiring soon)");
    expect(text).toContain("- Hakket oksekød: deal at Netto [expires today] (2026-06-16)");
  });

  it("surfaces alternatives for a low-confidence match", async () => {
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
            makeOffer({
              id: "m1",
              heading: "Øko mælk eller fløde",
              price: 12,
              quantity: 1,
              unit: "l",
            }),
            makeOffer({
              id: "m2",
              heading: "Sød mælk eller kærnemælk",
              price: 14,
              quantity: 1,
              unit: "l",
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("## ⚠ Uncertain matches (verify these)");
    expect(text).toContain('Mælk: picked "Øko mælk eller fløde" but also found:');
    expect(text).toContain("Sød mælk eller kærnemælk");
  });

  it("falls back to the sticker price when the quantity cannot be parsed", async () => {
    // "2 fed" (2 cloves) has no convertible unit, so pack maths is impossible
    // and the line must degrade to the raw offer price rather than guessing.
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Hvidløg",
            quantity: "2 fed",
            searchTerms: ["hvidløg"],
            category: "produce",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "hvidløg",
          [
            makeOffer({
              id: "g1",
              heading: "Hvidløg",
              price: 8,
              quantity: 3,
              unit: "stk",
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain(
      "Hvidløg (2 fed): Hvidløg - 8 DKK (90.00 kr/kg) @ Netto until 2026-06-30",
    );
    expect(text).not.toContain("/pack");
    expect(text).toContain("Estimated register total (deals only): ~8 kr");
  });

  it("omits the unit price from the fallback line when the offer has none", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({
        ingredients: [
          {
            name: "Hvidløg",
            quantity: "2 fed",
            searchTerms: ["hvidløg"],
            category: "produce",
          },
        ],
      }),
    ]);
    vi.mocked(api.searchDealsBatch).mockResolvedValue(
      new Map([
        [
          "hvidløg",
          [
            makeOffer({
              id: "g1",
              heading: "Hvidløg",
              price: 8,
              quantity: 3,
              unit: "stk",
              pricePerUnit: null,
            }),
          ],
        ],
      ]),
    );

    const text = textOf(
      await callTool(stub, "generate_shopping_list", {
        recipes: ["Bolognese"],
      }),
    );
    expect(text).toContain("Hvidløg (2 fed): Hvidløg - 8 DKK @ Netto until 2026-06-30");
  });

  it("returns a structured error when the deal lookup fails", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([beefRecipe()]);
    vi.mocked(api.searchDealsBatch).mockRejectedValue(new Error("upstream 500"));
    const result = await callTool(stub, "generate_shopping_list", {
      recipes: ["Bolognese"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to generate shopping list: upstream 500");
  });

  it("rejects a call with no recipes array", async () => {
    await expect(callTool(stub, "generate_shopping_list", {})).rejects.toThrow();
  });
});

describe("plan_and_shop", () => {
  function library(count: number): Recipe[] {
    const proteins = ["beef", "chicken", "pork", "fish", "vegetarian", "lamb", "shellfish"];
    const cuisines = ["italian", "asian", "danish", "mexican", "french", "indian", "greek"];
    return Array.from({ length: count }, (_, i) =>
      beefRecipe({
        name: `Recipe ${i + 1}`,
        proteinType: proteins[i % proteins.length],
        cuisineType: cuisines[i % cuisines.length],
      }),
    );
  }

  it("refuses with a count when there are fewer recipes than days", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(2));
    const result = await callTool(stub, "plan_and_shop", { days: 5 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Need at least 5 recipes to plan 5 days, but only 2 recipes exist. Add more with add_recipe.",
    );
  });

  it("defaults to a 7-day plan", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(3));
    const result = await callTool(stub, "plan_and_shop", {});
    expect(textOf(result)).toContain("Need at least 7 recipes to plan 7 days");
  });

  it("explains which knobs to relax when no plan satisfies the constraints", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "A", proteinType: "beef" }),
      beefRecipe({ name: "B", proteinType: "beef" }),
    ]);
    const result = await callTool(stub, "plan_and_shop", {
      days: 2,
      maxPerProtein: 1,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Could not find a valid meal plan");
    expect(textOf(result)).toContain("maxPerProtein");
  });

  it("returns a day-by-day plan followed by the shopping list", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(3));
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(await callTool(stub, "plan_and_shop", { days: 3 }));
    expect(text).toContain("# 3-day meal plan (2 people)");
    expect(text).toContain("Estimated basket: ~");
    expect(text).toContain("Day 1:");
    expect(text).toContain("Day 3:");
    expect(text).not.toContain("Day 4:");
    // Plan and shopping list are separated by a horizontal rule.
    const divider = text.indexOf("\n---\n");
    expect(divider).toBeGreaterThan(-1);
    expect(text.slice(divider)).toContain("Shopping list for:");
    expect(text.slice(divider)).toContain("## Netto");
  });

  it("reuses the cached deal map rather than searching twice", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(3));
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());
    await callTool(stub, "plan_and_shop", { days: 3 });
    expect(api.searchDealsBatch).toHaveBeenCalledTimes(1);
  });

  it("honours a people override in both the header and the quantities", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue(library(2));
    vi.mocked(api.searchDealsBatch).mockResolvedValue(beefDeals());

    const text = textOf(await callTool(stub, "plan_and_shop", { days: 2, people: 8 }));
    expect(text).toContain("# 2-day meal plan (8 people)");
    expect(text).toContain("(8 people)");
  });

  it("excludes a protein from the plan when asked", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      beefRecipe({ name: "Beefy", proteinType: "beef" }),
      beefRecipe({ name: "Chicken", proteinType: "chicken" }),
      beefRecipe({ name: "Veggie", proteinType: "vegetarian" }),
    ]);
    const text = textOf(
      await callTool(stub, "plan_and_shop", {
        days: 2,
        excludeProteins: ["beef"],
      }),
    );
    const planSection = text.slice(0, text.indexOf("\n---\n"));
    expect(planSection).not.toContain("Beefy");
  });

  it("returns a structured error when the household lookup fails", async () => {
    vi.mocked(store.getHousehold).mockRejectedValue(new Error("disk error"));
    const result = await callTool(stub, "plan_and_shop", { days: 2 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to plan: disk error");
  });
});
