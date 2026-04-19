/**
 * Live scenario tests: things that could go wrong when real users
 * interact with the MCP server across DK/NO/SE.
 *
 * Covers data migration, cross-country leakage, currency mixing,
 * country switching, broken API endpoints, edge cases.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Offer } from "./api.js";
import { type CountryCode, getLocale, isValidCountry, SUPPORTED_COUNTRIES } from "./locales.js";
import {
  expandSearchTerms,
  findBestDeal,
  findExcludedTag,
  SCORE,
  type ScoredIngredient,
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
// Scenario 1: Data migration from v0.3 to v0.4
// ============================================================

describe("Scenario: Existing user upgrades from v0.3 to v0.4", () => {
  const DataStoreSchema = z.object({
    household: z
      .object({
        people: z
          .array(
            z.object({
              name: z.string(),
              dietaryRestrictions: z.array(z.string()).default([]),
              defaultSchedule: z.record(z.string(), z.boolean()).default({}),
            }),
          )
          .default([]),
        stores: z
          .array(
            z.object({
              name: z.string(),
              dealerId: z.string(),
              priority: z.number(),
            }),
          )
          .default([]),
        defaultServings: z.number().default(2),
        country: z.string().default("DK"),
      })
      .default({ people: [], stores: [], defaultServings: 2, country: "DK" }),
    pantry: z.array(z.string()).default([]),
    recipes: z.array(z.any()).default([]),
    mealHistory: z.array(z.any()).default([]),
    spendLog: z.array(z.any()).default([]),
  });

  it("parses v0.3 data file without country field", () => {
    const v03Data = {
      household: {
        people: [{ name: "Alice", dietaryRestrictions: ["no pork"], defaultSchedule: {} }],
        stores: [{ name: "Netto", dealerId: "9ba51", priority: 1 }],
        defaultServings: 3,
        // no country field!
      },
      pantry: ["salt", "pepper"],
      recipes: [],
      mealHistory: [],
      spendLog: [],
    };
    const parsed = DataStoreSchema.parse(v03Data);
    expect(parsed.household.country).toBe("DK");
    expect(parsed.household.people.length).toBe(1);
    expect(parsed.household.stores.length).toBe(1);
    expect(parsed.household.defaultServings).toBe(3);
  });

  it("parses completely empty file", () => {
    const parsed = DataStoreSchema.parse({});
    expect(parsed.household.country).toBe("DK");
    expect(parsed.household.people).toEqual([]);
  });

  it("parses v0.4 data file with country field", () => {
    const v04Data = {
      household: {
        people: [],
        stores: [],
        defaultServings: 2,
        country: "NO",
      },
    };
    const parsed = DataStoreSchema.parse(v04Data);
    expect(parsed.household.country).toBe("NO");
  });

  it("preserves country when updating only people", () => {
    // Simulate: user sets country=NO, then later updates people
    const existing = {
      household: {
        people: [],
        stores: [{ name: "KIWI", dealerId: "257bxm", priority: 1 }],
        defaultServings: 4,
        country: "NO",
      },
    };
    const parsed = DataStoreSchema.parse(existing);
    // Simulate updateHousehold({people: [...]}) using spread
    const updated = {
      ...parsed.household,
      people: [{ name: "Ola", dietaryRestrictions: [], defaultSchedule: {} }],
    };
    expect(updated.country).toBe("NO"); // country survives
    expect(updated.stores.length).toBe(1); // stores survive
  });
});

// ============================================================
// Scenario 2: Cross-country offer leakage
// ============================================================

describe("Scenario: Cross-country offer leakage", () => {
  const preferredStores = new Set(["REMA 1000"]);

  it("DK offer with DKK should score normally with DK locale", () => {
    const dk = getLocale("DK");
    const offer = makeOffer({
      heading: "Hakket oksekød",
      currency: "DKK",
      store: "REMA 1000",
      price: 45,
    });
    const ing = makeIngredient({ name: "Oksekød", searchTerms: ["oksekød"], category: "meat" });
    const score = scoreDealMatch(offer, ing, "oksekød", preferredStores, dk);
    expect(score).toBeGreaterThan(SCORE.VIABILITY_THRESHOLD);
  });

  it("DK offer that leaks into NO results should still score if terms match", () => {
    // This tests what happens if the API's country_id filter doesn't hard-filter
    // and a DK offer shows up. The scoring itself doesn't filter by country;
    // that's the API layer's job. But if it leaks, it scores on its own merits.
    const no = getLocale("NO");
    const dkOffer = makeOffer({
      heading: "Hakket oksekød", // Danish heading
      currency: "DKK",
      store: "REMA 1000",
    });
    const ing = makeIngredient({ name: "Oksedeig", searchTerms: ["oksedeig"], category: "meat" });
    // Norwegian term "oksedeig" won't match Danish heading "oksekød"
    const score = scoreDealMatch(dkOffer, ing, "oksedeig", preferredStores, no);
    // Heading doesn't contain "oksedeig", so NO_MATCH_PENALTY applies
    expect(score).toBeLessThanOrEqual(SCORE.VIABILITY_THRESHOLD);
  });

  it("same store name in different countries has different dealer IDs", () => {
    const dk = getLocale("DK");
    const no = getLocale("NO");
    // REMA 1000 exists in both countries with different IDs
    expect(dk.knownStores["rema 1000"]).not.toBe(no.knownStores["rema 1000"]);
  });
});

// ============================================================
// Scenario 3: Currency display consistency
// ============================================================

describe("Scenario: Currency display", () => {
  it("each locale has distinct currency code", () => {
    const currencies = SUPPORTED_COUNTRIES.map((c) => getLocale(c).currency);
    expect(new Set(currencies).size).toBe(SUPPORTED_COUNTRIES.length);
  });

  it("Scandinavian locales use kr as symbol; FI uses €", () => {
    const scandinavian: CountryCode[] = ["DK", "NO", "SE"];
    for (const code of scandinavian) {
      expect(getLocale(code).currencySymbol).toBe("kr");
    }
    expect(getLocale("FI").currencySymbol).toBe("€");
  });

  it("offer currency field should match locale currency", () => {
    // Verify that when the API returns offers for a country,
    // the currency field matches expectations
    const expected: Record<CountryCode, string> = { DK: "DKK", NO: "NOK", SE: "SEK", FI: "EUR" };
    for (const code of SUPPORTED_COUNTRIES) {
      const locale = getLocale(code);
      expect(locale.currency).toBe(expected[code]);
    }
  });
});

// ============================================================
// Scenario 4: Country switching mid-session
// ============================================================

describe("Scenario: User switches country", () => {
  it("DK store preferences become stale after switching to NO", () => {
    const dk = getLocale("DK");
    const no = getLocale("NO");
    // User had DK stores set up
    const dkStoreId = dk.knownStores.netto; // "9ba51"
    // After switching to NO, that store ID won't match any NO offers
    expect(Object.values(no.knownStores)).not.toContain(dkStoreId);
  });

  it("DK store name lookup fails gracefully in NO context", () => {
    const no = getLocale("NO");
    const knownStores = no.knownStores;
    // "netto" doesn't exist in Norway
    expect(knownStores.netto).toBeUndefined();
    // "føtex" doesn't exist in Norway
    expect(knownStores.føtex).toBeUndefined();
  });

  it("recipes with Danish search terms score poorly in NO/SE", () => {
    // A recipe with searchTerms: ["hakket oksekød"] won't match Norwegian offers
    const no = getLocale("NO");
    const dealMap = new Map<string, Offer[]>([
      ["kjøttdeig", [makeOffer({ id: "no-1", heading: "Kjøttdeig storfe", currency: "NOK" })]],
    ]);
    const ing = { name: "Hakket oksekød", searchTerms: ["hakket oksekød"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set(), no);
    // Danish terms don't expand to Norwegian terms
    expect(result.best).toBeNull();
  });
});

// ============================================================
// Scenario 5: Default recipes for non-DK countries
// ============================================================

describe("Scenario: Default recipe seeding", () => {
  it("default recipes have Danish search terms", () => {
    // The defaultRecipes module exports Danish recipes
    // Verify they would NOT match Norwegian/Swedish offers
    const danishTerms = ["hakket svinekød", "svinefars", "kyllingebryst", "løg"];
    const no = getLocale("NO");

    for (const term of danishTerms) {
      const expanded = expandSearchTerms([term], no.synonymMap);
      // Norwegian synonyms should NOT expand Danish terms
      // (they're different words, not in the NO synonym map)
      expect(expanded).toEqual([term]);
    }
  });

  it("Norwegian users should add recipes with Norwegian terms", () => {
    // Verify that Norwegian search terms DO expand via NO synonyms
    const no = getLocale("NO");
    const expanded = expandSearchTerms(["svinekjøtt"], no.synonymMap);
    expect(expanded.length).toBeGreaterThan(1);
    expect(expanded).toContain("grisekjøtt");
  });
});

// ============================================================
// Scenario 6: list_stores with all:true for non-DK
// ============================================================

describe("Scenario: list_stores all:true API limitation", () => {
  it("the /dealers endpoint is known to be broken for non-DK", () => {
    // Document this known limitation: listStores("NO") returns DK dealers
    // The server code calls listStores(locale.country) for all:true
    // This means NO/SE users with all:true will see DK stores
    //
    // This is a KNOWN limitation we should document, not a bug to fix.
    // The default path (known stores only) works correctly.
    //
    // Verify the default path uses locale-specific stores:
    const no = getLocale("NO");
    const noStores = Object.keys(no.knownStores);
    expect(noStores).toContain("kiwi");
    expect(noStores).toContain("rema 1000");
    expect(noStores).not.toContain("netto");
    expect(noStores).not.toContain("føtex");
  });
});

// ============================================================
// Scenario 7: Country code validation
// ============================================================

describe("Scenario: Country code edge cases", () => {
  it("accepts lowercase country codes", () => {
    expect(isValidCountry("dk")).toBe(true);
    expect(isValidCountry("no")).toBe(true);
    expect(isValidCountry("se")).toBe(true);
  });

  it("accepts uppercase country codes", () => {
    expect(isValidCountry("DK")).toBe(true);
    expect(isValidCountry("NO")).toBe(true);
    expect(isValidCountry("SE")).toBe(true);
  });

  it("rejects invalid country codes", () => {
    expect(isValidCountry("DE")).toBe(false);
    expect(isValidCountry("XX")).toBe(false);
    expect(isValidCountry("")).toBe(false);
    expect(isValidCountry("DENMARK")).toBe(false);
  });

  it("getLocale falls back to DK for invalid codes", () => {
    expect(getLocale("DE").country).toBe("DK");
    expect(getLocale("").country).toBe("DK");
    expect(getLocale("INVALID").country).toBe("DK");
  });
});

// ============================================================
// Scenario 8: Pet food and non-food leakage
// ============================================================

describe("Scenario: Non-food products in search results", () => {
  const preferredStores = new Set<string>();

  it("filters Norwegian dog food", () => {
    const no = getLocale("NO");
    const offer = makeOffer({ heading: "TRENINGSBITER HUND lam", currency: "NOK" });
    const ing = makeIngredient({ name: "Lam", searchTerms: ["lam"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "lam", preferredStores, no)).toBe(0);
  });

  it("filters Norwegian cat food", () => {
    const no = getLocale("NO");
    const offer = makeOffer({ heading: "Kattemat laks", currency: "NOK" });
    const ing = makeIngredient({ name: "Laks", searchTerms: ["laks"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "laks", preferredStores, no)).toBe(0);
  });

  it("filters Swedish dog food", () => {
    const se = getLocale("SE");
    const offer = makeOffer({ heading: "Hundmat lamm", currency: "SEK" });
    const ing = makeIngredient({ name: "Lamm", searchTerms: ["lamm"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "lamm", preferredStores, se)).toBe(0);
  });

  it("filters Danish dog food", () => {
    const dk = getLocale("DK");
    const offer = makeOffer({ heading: "Hundemad kylling", currency: "DKK" });
    const ing = makeIngredient({ name: "Kylling", searchTerms: ["kylling"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "kylling", preferredStores, dk)).toBe(0);
  });

  it("filters Norwegian dog snacks", () => {
    const no = getLocale("NO");
    const offer = makeOffer({ heading: "MAXDOG HUNDEMAT okse", currency: "NOK" });
    const ing = makeIngredient({ name: "Okse", searchTerms: ["okse"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "okse", preferredStores, no)).toBe(0);
  });

  it("does NOT filter actual food containing 'hund' substring", () => {
    // "hundra" (Swedish for hundred) should not be filtered
    const se = getLocale("SE");
    const offer = makeOffer({ heading: "Hundra gram choklad", currency: "SEK" });
    const ing = makeIngredient({ name: "Choklad", searchTerms: ["choklad"], category: "other" });
    // "hundmat" is the filter term, "hundra" should not match
    const score = scoreDealMatch(offer, ing, "choklad", preferredStores, se);
    expect(score).toBeGreaterThan(0);
  });
});

// ============================================================
// Scenario 9: Dietary exclusion edge cases
// ============================================================

describe("Scenario: Dietary exclusions across language boundaries", () => {
  it("'bacon' is caught as pork in Scandinavian locales", () => {
    // Bacon is spelled the same in DK/NO/SE; Finnish uses "pekoni"
    const scandinavian: CountryCode[] = ["DK", "NO", "SE"];
    for (const code of scandinavian) {
      const locale = getLocale(code);
      const ingredients = [makeScoredIngredient({ name: "Bacon" })];
      expect(
        findExcludedTag(ingredients, ["pork"], locale.ingredientTags),
        `${code}: bacon should be tagged as pork`,
      ).toBe("pork");
    }
  });

  it("'chorizo' is caught as pork in all three locales", () => {
    for (const code of SUPPORTED_COUNTRIES) {
      const locale = getLocale(code);
      const ingredients = [makeScoredIngredient({ name: "Chorizo" })];
      expect(
        findExcludedTag(ingredients, ["pork"], locale.ingredientTags),
        `${code}: chorizo should be tagged as pork`,
      ).toBe("pork");
    }
  });

  it("'parmesan' is caught as dairy in all three locales", () => {
    for (const code of SUPPORTED_COUNTRIES) {
      const locale = getLocale(code);
      const ingredients = [makeScoredIngredient({ name: "Parmesan" })];
      expect(
        findExcludedTag(ingredients, ["dairy"], locale.ingredientTags),
        `${code}: parmesan should be tagged as dairy`,
      ).toBe("dairy");
    }
  });

  it("'mozzarella' is caught as dairy in all three locales", () => {
    for (const code of SUPPORTED_COUNTRIES) {
      const locale = getLocale(code);
      const ingredients = [makeScoredIngredient({ name: "Mozzarella" })];
      expect(
        findExcludedTag(ingredients, ["dairy"], locale.ingredientTags),
        `${code}: mozzarella should be tagged as dairy`,
      ).toBe("dairy");
    }
  });

  it("multiple exclusions check all tags", () => {
    const dk = getLocale("DK");
    const ingredients = [
      makeScoredIngredient({ name: "Pasta spaghetti" }),
      makeScoredIngredient({ name: "Parmesan" }),
    ];
    // Both gluten and dairy present
    expect(findExcludedTag(ingredients, ["gluten"], dk.ingredientTags)).toBe("gluten");
    expect(findExcludedTag(ingredients, ["dairy"], dk.ingredientTags)).toBe("dairy");
    // First match wins
    expect(findExcludedTag(ingredients, ["dairy", "gluten"], dk.ingredientTags)).toBe("dairy");
  });

  it("case-insensitive ingredient matching", () => {
    const dk = getLocale("DK");
    // Ingredient tags use lowercase patterns; ingredient names may be capitalized
    const ingredients = [makeScoredIngredient({ name: "BACON" })];
    expect(findExcludedTag(ingredients, ["pork"], dk.ingredientTags)).toBe("pork");
  });
});

// ============================================================
// Scenario 10: Bundle/or-separator handling per locale
// ============================================================

describe("Scenario: Bundle offers per locale", () => {
  const preferredStores = new Set(["TestStore"]);

  it("detects 'eller' bundles in Danish", () => {
    const dk = getLocale("DK");
    const offer = makeOffer({ heading: "Pasta eller pastasauce" });
    const ing = makeIngredient({ searchTerms: ["pasta"], category: "pantry" });
    const bundleScore = scoreDealMatch(offer, ing, "pasta", preferredStores, dk);
    const normalScore = scoreDealMatch(
      makeOffer({ heading: "Pasta penne" }),
      ing,
      "pasta",
      preferredStores,
      dk,
    );
    expect(bundleScore).toBeLessThan(normalScore);
  });

  it("detects 'eller' bundles in Norwegian", () => {
    const no = getLocale("NO");
    // "pizza" is in non-ingredient list for NO, so use a non-blocked term
    const offer2 = makeOffer({ heading: "Ost eller yoghurt", currency: "NOK" });
    const ing2 = makeIngredient({ searchTerms: ["ost"], category: "dairy" });
    const bundleScore = scoreDealMatch(offer2, ing2, "ost", preferredStores, no);
    const normalScore = scoreDealMatch(
      makeOffer({ heading: "Ost norvegia", currency: "NOK" }),
      ing2,
      "ost",
      preferredStores,
      no,
    );
    expect(bundleScore).toBeLessThan(normalScore);
  });

  it("detects 'eller' bundles in Swedish", () => {
    const se = getLocale("SE");
    const offer = makeOffer({ heading: "Ost eller smör", currency: "SEK" });
    const ing = makeIngredient({ searchTerms: ["ost"], category: "dairy" });
    const bundleScore = scoreDealMatch(offer, ing, "ost", preferredStores, se);
    const normalScore = scoreDealMatch(
      makeOffer({ heading: "Ost prästost", currency: "SEK" }),
      ing,
      "ost",
      preferredStores,
      se,
    );
    expect(bundleScore).toBeLessThan(normalScore);
  });
});

// ============================================================
// Scenario 11: Preferred store hard-exclude still works per locale
// ============================================================

describe("Scenario: Preferred store filtering per country", () => {
  it("matches stores case-insensitively (issue #1)", () => {
    const dk = getLocale("DK");
    // User types "Føtex" but API returns "føtex"
    const preferredStores = new Set(["Føtex"]);
    const offer = makeOffer({ heading: "Hakket oksekød", store: "føtex" });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "oksekød", preferredStores, dk)).toBeGreaterThan(0);
  });

  it("matches REMA 1000 regardless of casing", () => {
    const dk = getLocale("DK");
    const preferredStores = new Set(["rema 1000"]);
    const offer = makeOffer({ heading: "Hakket oksekød", store: "REMA 1000" });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "oksekød", preferredStores, dk)).toBeGreaterThan(0);
  });

  it("excludes non-preferred stores in DK", () => {
    const dk = getLocale("DK");
    const preferredStores = new Set(["Netto"]);
    const offer = makeOffer({ heading: "Hakket oksekød", store: "Bilka" });
    const ing = makeIngredient({ searchTerms: ["oksekød"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "oksekød", preferredStores, dk)).toBe(0);
  });

  it("excludes non-preferred stores in NO", () => {
    const no = getLocale("NO");
    const preferredStores = new Set(["REMA 1000"]);
    const offer = makeOffer({ heading: "Kjøttdeig", store: "KIWI", currency: "NOK" });
    const ing = makeIngredient({ searchTerms: ["kjøttdeig"], category: "meat" });
    expect(scoreDealMatch(offer, ing, "kjøttdeig", preferredStores, no)).toBe(0);
  });

  it("includes preferred stores in SE", () => {
    const se = getLocale("SE");
    const preferredStores = new Set(["ICA Kvantum"]);
    const offer = makeOffer({ heading: "Kycklingfilé", store: "ICA Kvantum", currency: "SEK" });
    const ing = makeIngredient({ searchTerms: ["kycklingfilé"], category: "meat" });
    const score = scoreDealMatch(offer, ing, "kycklingfilé", preferredStores, se);
    expect(score).toBeGreaterThan(SCORE.VIABILITY_THRESHOLD);
  });
});

// ============================================================
// Scenario 12: Null/missing fields in API responses
// ============================================================

describe("Scenario: Defensive handling of bad API data", () => {
  const preferredStores = new Set<string>();

  it("handles offer with null price", () => {
    const dk = getLocale("DK");
    const offer = makeOffer({ price: null });
    const ing = makeIngredient({ searchTerms: ["test"] });
    expect(scoreDealMatch(offer, ing, "test", preferredStores, dk)).toBe(0);
  });

  it("handles offer with zero price", () => {
    const dk = getLocale("DK");
    const offer = makeOffer({ price: 0 });
    const ing = makeIngredient({ searchTerms: ["test"] });
    expect(scoreDealMatch(offer, ing, "test", preferredStores, dk)).toBe(0);
  });

  it("handles offer with empty heading", () => {
    const dk = getLocale("DK");
    const offer = makeOffer({ heading: "" });
    const ing = makeIngredient({ searchTerms: ["test"] });
    // Empty heading won't match any term -> NO_MATCH_PENALTY
    const score = scoreDealMatch(offer, ing, "test", preferredStores, dk);
    expect(score).toBeLessThanOrEqual(SCORE.VIABILITY_THRESHOLD);
  });

  it("findBestDeal handles empty deal map", () => {
    const no = getLocale("NO");
    const ing = { name: "Laks", searchTerms: ["laks"], category: "meat" };
    const result = findBestDeal(ing, new Map(), new Set(), no);
    expect(result.best).toBeNull();
    expect(result.confidence).toBe("none");
  });

  it("findBestDeal handles deal map with empty arrays", () => {
    const se = getLocale("SE");
    const dealMap = new Map<string, Offer[]>([["lax", []]]);
    const ing = { name: "Lax", searchTerms: ["lax"], category: "meat" };
    const result = findBestDeal(ing, dealMap, new Set(), se);
    expect(result.best).toBeNull();
  });
});

// ============================================================
// Scenario 13: Synonym map completeness across locales
// ============================================================

describe("Scenario: Synonym coverage for common ingredients", () => {
  it("DK: pork synonyms cover common flyer terms", () => {
    const dk = getLocale("DK");
    const expanded = expandSearchTerms(["svinekød", "hakket svinekød", "svinefars"], dk.synonymMap);
    expect(expanded).toContain("grisekød");
    expect(expanded).toContain("grisefars");
  });

  it("NO: pork synonyms cover common flyer terms", () => {
    const no = getLocale("NO");
    const expanded = expandSearchTerms(
      ["svinekjøtt", "kvernet svinekjøtt", "svinedeig"],
      no.synonymMap,
    );
    expect(expanded).toContain("grisekjøtt");
  });

  it("SE: pork synonyms cover common flyer terms", () => {
    const se = getLocale("SE");
    const expanded = expandSearchTerms(["fläskkött", "fläskfärs"], se.synonymMap);
    expect(expanded).toContain("griskött");
    expect(expanded).toContain("blandfärs");
  });

  it("DK: chicken synonyms work", () => {
    const dk = getLocale("DK");
    const expanded = expandSearchTerms(["kyllingebryst"], dk.synonymMap);
    expect(expanded).toContain("kylling");
  });

  it("NO: salmon synonyms work", () => {
    const no = getLocale("NO");
    const expanded = expandSearchTerms(["laks"], no.synonymMap);
    expect(expanded).toContain("laksefilet");
  });

  it("SE: chicken synonyms work", () => {
    const se = getLocale("SE");
    const expanded = expandSearchTerms(["kycklingfilé"], se.synonymMap);
    expect(expanded).toContain("kyckling");
  });
});

// ============================================================
// Scenario 14: Processed vs raw in each language
// ============================================================

describe("Scenario: Processed/raw detection language accuracy", () => {
  const preferredStores = new Set<string>();

  // Each language has its own word for "smoked"
  it("detects smoked meat: DK=røget, NO=røkt, SE=rökt", () => {
    const cases: Array<{ code: CountryCode; term: string }> = [
      { code: "DK", term: "røget" },
      { code: "NO", term: "røkt" },
      { code: "SE", term: "rökt" },
    ];
    for (const { code, term } of cases) {
      const locale = getLocale(code);
      const offer = makeOffer({ heading: `${term} laks`, currency: locale.currency });
      const ing = makeIngredient({ name: "Laks", searchTerms: ["laks"], category: "meat" });
      const score = scoreDealMatch(offer, ing, "laks", preferredStores, locale);
      const freshScore = scoreDealMatch(
        makeOffer({ heading: "Fersk laks", currency: locale.currency }),
        ing,
        "laks",
        preferredStores,
        locale,
      );
      expect(score, `${code}: "${term}" should be penalized as processed`).toBeLessThan(freshScore);
    }
  });

  // Each language has its own word for "fresh"
  it("detects fresh meat: DK=fersk, NO=fersk, SE=färsk", () => {
    const cases: Array<{ code: CountryCode; heading: string }> = [
      { code: "DK", heading: "Fersk kyllingebryst" },
      { code: "NO", heading: "Fersk kyllingbryst" },
      { code: "SE", heading: "Färsk kycklingbröst" },
    ];
    for (const { code, heading } of cases) {
      const locale = getLocale(code);
      const searchTerm = heading.split(" ")[1]; // second word
      const offer = makeOffer({ heading, currency: locale.currency });
      const ing = makeIngredient({ name: searchTerm, searchTerms: [searchTerm], category: "meat" });
      const score = scoreDealMatch(offer, ing, searchTerm, preferredStores, locale);
      expect(score, `${code}: "${heading}" should get raw bonus`).toBeGreaterThan(SCORE.BASE);
    }
  });

  // Each language has its own word for "marinated"
  it("detects marinated as processed: DK=marineret, NO=marinert, SE=marinerad", () => {
    const cases: Array<{ code: CountryCode; term: string }> = [
      { code: "DK", term: "marineret" },
      { code: "NO", term: "marinert" },
      { code: "SE", term: "marinerad" },
    ];
    for (const { code, term } of cases) {
      const locale = getLocale(code);
      const offer = makeOffer({ heading: `${term} kylling`, currency: locale.currency });
      const ing = makeIngredient({ name: "Kylling", searchTerms: ["kylling"], category: "meat" });
      const score = scoreDealMatch(offer, ing, "kylling", preferredStores, locale);
      const plainScore = scoreDealMatch(
        makeOffer({ heading: "Kylling hel", currency: locale.currency }),
        ing,
        "kylling",
        preferredStores,
        locale,
      );
      expect(score, `${code}: "${term}" should be penalized`).toBeLessThan(plainScore);
    }
  });
});

// ============================================================
// Scenario 15: Known store ID integrity
// ============================================================

describe("Scenario: Known store IDs are valid", () => {
  it("DK store IDs are non-empty strings", () => {
    const dk = getLocale("DK");
    for (const [name, id] of Object.entries(dk.knownStores)) {
      expect(id.length, `DK store "${name}" has empty ID`).toBeGreaterThan(0);
    }
  });

  it("NO store IDs are non-empty strings", () => {
    const no = getLocale("NO");
    for (const [name, id] of Object.entries(no.knownStores)) {
      expect(id.length, `NO store "${name}" has empty ID`).toBeGreaterThan(0);
    }
  });

  it("SE store IDs are non-empty strings", () => {
    const se = getLocale("SE");
    for (const [name, id] of Object.entries(se.knownStores)) {
      expect(id.length, `SE store "${name}" has empty ID`).toBeGreaterThan(0);
    }
  });

  it("no duplicate store IDs within a locale (except aliases)", () => {
    for (const code of SUPPORTED_COUNTRIES) {
      const locale = getLocale(code);
      const idToNames = new Map<string, string[]>();
      for (const [name, id] of Object.entries(locale.knownStores)) {
        const names = idToNames.get(id) ?? [];
        names.push(name);
        idToNames.set(id, names);
      }
      // Aliases are OK (rema and rema 1000 share an ID)
      // But completely unrelated stores sharing an ID would be a bug
      // Allow aliases: names that share 3+ consecutive characters are related
      for (const [id, names] of idToNames) {
        if (names.length > 1) {
          const lower = names.map((n) => n.toLowerCase());
          for (let i = 1; i < lower.length; i++) {
            const a = lower[0];
            const b = lower[i];
            // Check for shared substring of length 3+
            let hasOverlap = false;
            for (let j = 0; j <= a.length - 3; j++) {
              if (b.includes(a.slice(j, j + 3))) {
                hasOverlap = true;
                break;
              }
            }
            expect(
              hasOverlap,
              `${code}: stores "${names.join('", "')}" share ID "${id}" but look unrelated`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("no cross-country ID collisions for same-name stores", () => {
    // REMA 1000 exists in DK and NO; their IDs must differ
    const dk = getLocale("DK");
    const no = getLocale("NO");
    if (dk.knownStores["rema 1000"] && no.knownStores["rema 1000"]) {
      expect(dk.knownStores["rema 1000"]).not.toBe(no.knownStores["rema 1000"]);
    }
  });
});
