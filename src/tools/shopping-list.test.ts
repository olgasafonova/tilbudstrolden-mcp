/**
 * Unit tests for src/tools/shopping-list.ts — buildShoppingList, the engine
 * behind generate_shopping_list and plan_and_shop.
 *
 * shopping.test.ts covers the tool handlers end to end; this file calls
 * buildShoppingList directly to pin down its own contract: when it searches,
 * what it searches for, how it merges ingredients that resolve to one offer
 * (mergeSharedOffers), and how each line is priced and sectioned.
 *
 * The api and store layers are mocked; scoring runs for real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Offer } from "../api.js";
import type { Household, Ingredient, Recipe } from "../store.js";

vi.mock("../api.js", () => ({
  searchDealsBatch: vi.fn(),
}));

vi.mock("../store.js", () => ({
  getHousehold: vi.fn(),
  getPantry: vi.fn(),
}));

const api = await import("../api.js");
const store = await import("../store.js");
const { buildShoppingList } = await import("./shopping-list.js");

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
    storeId: "9ba51",
    validFrom: "2026-06-10",
    validUntil: "2026-06-30T00:00:00Z",
    imageUrl: null,
    ...overrides,
  };
}

function ingredient(overrides: Partial<Ingredient> = {}): Ingredient {
  return {
    name: "Hakket oksekød",
    quantity: "500g",
    searchTerms: ["hakket oksekød"],
    category: "meat",
    ...overrides,
  };
}

function recipe(name: string, ingredients: Ingredient[], servings = 2): Recipe {
  return {
    name,
    servings,
    complexity: "medium",
    cuisineType: "danish",
    proteinType: "beef",
    ingredients,
  };
}

function household(overrides: Partial<Household> = {}): Household {
  return { people: [], stores: [], defaultServings: 2, country: "DK", ...overrides };
}

const deals = (entries: Array<[string, Offer[]]>) => new Map(entries);

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(store.getHousehold).mockResolvedValue(household());
  vi.mocked(store.getPantry).mockResolvedValue([]);
  vi.mocked(api.searchDealsBatch).mockResolvedValue(new Map());
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildShoppingList deal lookup", () => {
  it("uses a supplied deal map instead of searching again", async () => {
    const text = await buildShoppingList(
      [recipe("Bolognese", [ingredient()])],
      2,
      deals([["hakket oksekød", [makeOffer()]]]),
    );
    expect(api.searchDealsBatch).not.toHaveBeenCalled();
    expect(text).toContain("## Netto (1 items)");
  });

  it("searches once for every term plus its synonyms, scoped to the household stores", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      household({ stores: [{ name: "Lidl", dealerId: "71c90", priority: 1 }] }),
    );
    await buildShoppingList(
      [
        recipe("Wok", [ingredient({ name: "Kylling", searchTerms: ["kyllingebryst"] })]),
        recipe("Salat", [ingredient({ name: "Kyllingefilet", searchTerms: ["kyllingefilet"] })]),
      ],
      2,
    );
    expect(api.searchDealsBatch).toHaveBeenCalledTimes(1);
    const call = vi.mocked(api.searchDealsBatch).mock.calls[0][0];
    expect([...call.queries].sort()).toEqual(["kylling", "kyllingebryst", "kyllingefilet"]);
    expect(call).toMatchObject({ limit: 8, country: "DK", dealerIds: ["71c90"] });
  });

  it("falls back to the country's known chains when no stores are set", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(household({ country: "NO" }));
    await buildShoppingList([recipe("Taco", [ingredient({ searchTerms: ["kjøttdeig"] })])], 2);
    const call = vi.mocked(api.searchDealsBatch).mock.calls[0][0];
    expect(call.country).toBe("NO");
    expect(call.dealerIds?.length).toBeGreaterThan(0);
    // Aliases share a dealer ID; each ID is requested once.
    expect(new Set(call.dealerIds).size).toBe(call.dealerIds?.length);
  });
});

describe("buildShoppingList pantry handling", () => {
  it("stops before searching when every ingredient is in the pantry (case-insensitive)", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["HAKKET OKSEKØD"]);
    const text = await buildShoppingList([recipe("Bolognese", [ingredient()])], 2);
    expect(text).toBe("All ingredients are in your pantry. Nothing to buy!");
    expect(api.searchDealsBatch).not.toHaveBeenCalled();
  });

  it("does not read the pantry when excludePantry is false", async () => {
    await buildShoppingList([recipe("Bolognese", [ingredient()])], 2, undefined, false);
    expect(store.getPantry).not.toHaveBeenCalled();
  });
});

describe("buildShoppingList pricing lines", () => {
  it("buys several whole packs when one is not enough", async () => {
    // 600 g for 2 servings scaled to 4 people = 1200 g -> 3 x 500 g packs.
    const text = await buildShoppingList(
      [recipe("Chili", [ingredient({ quantity: "600g" })])],
      4,
      deals([["hakket oksekød", [makeOffer()]]]),
    );
    expect(text).toContain("Hakket oksekød: need 1.2 kg -> 3 x 45 kr = 135 kr");
    expect(text).toContain("(300 g leftover)");
    expect(text).toContain("Estimated register total (deals only): ~135 kr");
  });

  it("omits the leftover note when packs match the need exactly", async () => {
    const text = await buildShoppingList(
      [recipe("Bolognese", [ingredient({ quantity: "500g" })])],
      2,
      deals([["hakket oksekød", [makeOffer()]]]),
    );
    expect(text).toContain("need 500 g -> 45 kr = 45 kr [500 g/pack, 90.00 kr/kg] --");
    expect(text).not.toContain("leftover");
  });

  it("sums the same ingredient across recipes before buying packs", async () => {
    const text = await buildShoppingList(
      [
        recipe("Bolognese", [ingredient({ quantity: "300g" })]),
        recipe("Lasagne", [ingredient({ name: "hakket OKSEKØD", quantity: "300g" })]),
      ],
      2,
      deals([["hakket oksekød", [makeOffer()]]]),
    );
    expect(text).toContain("Hakket oksekød: need 300 g + 300 g = 600 g -> 2 x 45 kr = 90 kr");
  });

  it("uses the sticker price when units cannot be compared", async () => {
    const text = await buildShoppingList(
      [recipe("Bolognese", [ingredient({ quantity: "1 bakke" })])],
      2,
      deals([["hakket oksekød", [makeOffer({ pricePerUnit: null })]]]),
    );
    expect(text).toContain(
      "Hakket oksekød (1 bakke): Hakket oksekød 8-12% - 45 DKK @ Netto until 2026-06-30",
    );
    expect(text).toContain("~45 kr");
  });

  it("puts unmatched ingredients under regular price with their recipes", async () => {
    const text = await buildShoppingList(
      [
        recipe("Bolognese", [
          ingredient(),
          ingredient({
            name: "Laurbær",
            quantity: "2 stk",
            searchTerms: ["laurbær"],
            category: "pantry",
          }),
        ]),
        recipe("Suppe", [
          ingredient({
            name: "Laurbær",
            quantity: "1 stk",
            searchTerms: ["laurbær"],
            category: "pantry",
          }),
        ]),
      ],
      2,
      deals([["hakket oksekød", [makeOffer()]]]),
    );
    expect(text).toContain("## Buy at regular price (1 items)");
    expect(text).toContain("- Laurbær (2 stk + 1 stk = 3 stk) [Bolognese, Suppe]");
  });

  it("rejects offers from stores outside the household's list", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      household({ stores: [{ name: "Lidl", dealerId: "71c90", priority: 1 }] }),
    );
    const text = await buildShoppingList(
      [recipe("Bolognese", [ingredient()])],
      2,
      deals([["hakket oksekød", [makeOffer({ store: "Netto" })]]]),
    );
    expect(text).not.toContain("## Netto");
    expect(text).toContain("## Buy at regular price (1 items)");
    expect(text).toContain("~0 kr");
  });

  it("flags a single low-confidence match without an alternatives section", async () => {
    const text = await buildShoppingList(
      [
        recipe("Salat", [
          ingredient({
            name: "Tomat",
            quantity: "2 stk",
            searchTerms: ["tomat"],
            category: "produce",
          }),
        ]),
      ],
      2,
      deals([
        [
          "tomat",
          [
            makeOffer({
              id: "t",
              heading: "Agurk eller tomat",
              price: 12,
              unit: null,
              quantity: null,
              pricePerUnit: null,
            }),
          ],
        ],
      ]),
    );
    expect(text).toMatch(/Tomat \(2 stk\): Agurk eller tomat - 12 DKK @ Netto until 2026-06-30 ⚠/);
    expect(text).not.toContain("Uncertain matches");
  });
});

describe("mergeSharedOffers (via buildShoppingList)", () => {
  const chicken = makeOffer({
    id: "chicken",
    heading: "Kyllingebrystfilet",
    price: 30,
    quantity: 300,
    pricePerUnit: "100.00 kr/kg",
  });

  it("merges three differently named ingredients that resolve to one offer", async () => {
    const terms = ["kyllingebryst", "kyllingefilet"];
    const text = await buildShoppingList(
      [
        recipe("Wok", [
          ingredient({ name: "Kyllingebryst", quantity: "100g", searchTerms: terms }),
        ]),
        recipe("Suppe", [
          ingredient({ name: "Kyllingefilet", quantity: "100g", searchTerms: terms }),
        ]),
        recipe("Salat", [
          ingredient({ name: "Kyllingebrystfilet", quantity: "150g", searchTerms: terms }),
        ]),
      ],
      2,
      deals([
        ["kyllingebryst", [chicken]],
        ["kyllingefilet", [chicken]],
        ["kylling", [chicken]],
      ]),
    );
    expect(text).toContain(
      "Kyllingebryst + Kyllingefilet + Kyllingebrystfilet: need 100 g + 100 g + 150 g = 350 g -> 2 x 30 kr = 60 kr",
    );
    expect(text).toContain("## Netto (1 items)");
    expect(text).toContain("~60 kr");
  });

  it("keeps ingredients separate when their best offers differ", async () => {
    const pork = makeOffer({ id: "pork", heading: "Hakket grisekød 8-12%", price: 35 });
    const text = await buildShoppingList(
      [
        recipe("Bolognese", [ingredient()]),
        recipe("Frikadeller", [
          ingredient({ name: "Hakket svinekød", searchTerms: ["hakket svinekød"] }),
        ]),
      ],
      2,
      deals([
        ["hakket oksekød", [makeOffer()]],
        ["hakket svinekød", [pork]],
        ["hakket grisekød", [pork]],
      ]),
    );
    expect(text).toContain("## Netto (2 items)");
    expect(text).toContain("1. Hakket oksekød: need 500 g");
    expect(text).toContain("2. Hakket svinekød: need 500 g");
    expect(text).not.toContain(" + Hakket");
    expect(text).toContain("~80 kr");
  });

  it("never merges ingredients that have no deal at all", async () => {
    const text = await buildShoppingList(
      [
        recipe("A", [
          ingredient({
            name: "Spidskommen",
            quantity: "1 tsk",
            searchTerms: ["spidskommen"],
            category: "pantry",
          }),
        ]),
        recipe("B", [
          ingredient({
            name: "Kanel",
            quantity: "1 tsk",
            searchTerms: ["kanel"],
            category: "pantry",
          }),
        ]),
      ],
      2,
      deals([]),
    );
    expect(text).toContain("## Buy at regular price (2 items)");
    expect(text).toContain("- Spidskommen (1 tsk) [A]");
    expect(text).toContain("- Kanel (1 tsk) [B]");
  });
});
