import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Offer } from "./api.js";
import { getStoreOffers, listStores, searchDeals, searchDealsBatch } from "./api.js";
import {
  aggregateQuantities,
  calculateBasketCost,
  computeIngredientCost,
  computeShoppingCost,
  computeShoppingCostFromTotal,
  type DealCandidate,
  expandSearchTerms,
  findBestDeal,
  findOptimalWeek,
  formatQuantity,
  parseQuantity,
  type ScoredIngredient,
  type ScoredRecipe,
} from "./scoring.js";
import * as store from "./store.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as {
  version: string;
};

/** Return a structured MCP error result instead of throwing */
function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

const KNOWN_STORES: Record<string, string> = {
  netto: "9ba51",
  meny: "267e1m",
  lidl: "71c90",
  rema: "11deC",
  "rema 1000": "11deC",
  rema1000: "11deC",
  foetex: "bdf5A",
  føtex: "bdf5A",
  bilka: "93f13",
  spar: "88ddE",
  kvickly: "c1edq",
  "365discount": "DWZE1w",
  "365": "DWZE1w",
};

/** Days until a deal expires. Negative means already expired. */
function daysUntilExpiry(validUntil: string | null | undefined): number {
  if (!validUntil) return 999;
  const expiry = new Date(validUntil);
  const now = new Date();
  return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/** Format expiry warning if deal expires within 2 days */
function expiryTag(validUntil: string | null | undefined): string {
  const days = daysUntilExpiry(validUntil);
  if (days <= 0) return " [EXPIRED]";
  if (days <= 1) return " [EXPIRES TODAY]";
  if (days <= 2) return " [EXPIRES TOMORROW]";
  return "";
}

function formatOffer(o: Offer): string {
  const parts = [`${o.heading} - ${o.price} ${o.currency}`];
  if (o.pricePerUnit) parts.push(`(${o.pricePerUnit})`);
  parts.push(`@ ${o.store}`);
  if (o.prePrice) parts.push(`was ${o.prePrice} ${o.currency}`);
  const validTo = o.validUntil?.slice(0, 10) ?? "unknown";
  parts.push(`valid until ${validTo}${expiryTag(o.validUntil)}`);
  return parts.join(" ");
}

function formatOfferList(offers: Offer[]): string {
  if (offers.length === 0) return "No offers found.";
  return offers.map((o, i) => `${i + 1}. ${formatOffer(o)}`).join("\n");
}

const server = new McpServer({
  name: "tilbudstrolden",
  version: SERVER_VERSION,
});

// ============================================================
// MCP Prompts (workflow templates)
// ============================================================

server.prompt(
  "getting-started",
  "Set up TilbudsTrolden for first use: household, stores, recipes, pantry",
  {},
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Help me set up TilbudsTrolden for meal planning. Walk me through these steps:

1. Set up my household (who lives here, dietary restrictions) using update_household
2. Configure preferred stores (use list_stores to find IDs, then update_household)
3. Add my pantry staples using update_pantry (things I always have: salt, pepper, oil, etc.)
4. Add a few recipes using add_recipe
5. Test it by running plan_and_shop to get a meal plan with shopping list

Ask me questions at each step. Start with: how many people in my household?`,
        },
      },
    ],
  }),
);

server.prompt(
  "meal-plan",
  "Generate a weekly meal plan with an optimized shopping list",
  {
    days: z.string().optional().describe("Number of days to plan (default 7)"),
  },
  ({ days }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Plan ${days || "7"} days of dinners for my household. Use plan_and_shop to:
1. Score all my recipes against current grocery deals
2. Pick the cheapest combination that has good variety (different proteins, cuisines)
3. Generate a shopping list grouped by store

Show me the plan first, then the shopping list. Flag any deals expiring soon so I know what to buy first.`,
        },
      },
    ],
  }),
);

server.prompt(
  "deal-scout",
  "Find what's cheap this week and suggest meals around the deals",
  {},
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Check what's on sale at my preferred stores using deals_this_week. Then look at my saved recipes and suggest which ones would be cheapest to cook this week based on the current deals. Focus on ingredients with the best discounts.`,
        },
      },
    ],
  }),
);

// ============================================================
// Deal tools
// ============================================================

server.tool(
  "search_deals",
  "Search grocery deals across Danish stores by keyword. USE WHEN: finding specific products ('find deals on kylling'), checking prices, comparing stores. NOT FOR: browsing one store's catalog (use get_store_offers) or generating a shopping list (use generate_shopping_list). Returns deals sorted by relevance with unit prices.",
  {
    query: z.string().describe("Danish search term, e.g. 'hakket oksekød'"),
    limit: z.number().optional().default(20).describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    try {
      const offers = await searchDeals(query.trim(), limit);
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${offers.length} deals for "${query}":\n\n${formatOfferList(offers)}`,
          },
        ],
      };
    } catch (err) {
      return errorResult(`Failed to search deals: ${err instanceof Error ? err.message : err}`);
    }
  },
);

server.tool(
  "get_store_offers",
  "List current offers from a specific store. USE WHEN: browsing what's on sale at one store ('what's at Netto this week'). NOT FOR: searching across all stores (use search_deals) or checking best deals from all preferred stores (use deals_this_week).",
  {
    store: z
      .string()
      .describe(`Store name or dealer ID. Known: ${Object.keys(KNOWN_STORES).join(", ")}`),
    limit: z.number().optional().default(50).describe("Max results"),
  },
  async ({ store: storeName, limit }) => {
    try {
      const dealerId = KNOWN_STORES[storeName.trim().toLowerCase()] ?? storeName.trim();
      const offers = await getStoreOffers(dealerId, limit);
      const name = offers[0]?.store ?? storeName;
      return {
        content: [
          {
            type: "text" as const,
            text: `${offers.length} current offers at ${name}:\n\n${formatOfferList(offers)}`,
          },
        ],
      };
    } catch (err) {
      return errorResult(`Failed to get store offers: ${err instanceof Error ? err.message : err}`);
    }
  },
);

server.tool(
  "list_stores",
  "List Danish grocery chains with dealer IDs. USE WHEN: finding store IDs for get_store_offers or setting up household preferred stores via update_household. NOT FOR: seeing deals (use search_deals or deals_this_week).",
  {
    query: z.string().optional().describe("Filter by name"),
    all: z.boolean().optional().default(false).describe("Include non-grocery stores too"),
  },
  async ({ query, all }) => {
    try {
      if (all) {
        const stores = await listStores();
        let filtered = stores.sort((a, b) => a.name.localeCompare(b.name));
        if (query) {
          const q = query.toLowerCase();
          filtered = filtered.filter((s) => s.name.toLowerCase().includes(q));
        }
        const lines = filtered.map(
          (s) => `- ${s.name} (id: ${s.id})${s.website ? ` ${s.website}` : ""}`,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `${filtered.length} stores:\n\n${lines.join("\n")}`,
            },
          ],
        };
      }

      // Default: known grocery stores only
      let entries = Object.entries(KNOWN_STORES).filter(
        ([key]) => !["rema", "rema1000", "foetex"].includes(key), // skip aliases
      );
      if (query) {
        const q = query.toLowerCase();
        entries = entries.filter(([key]) => key.includes(q));
      }
      const lines = entries.map(([name, id]) => `- ${name} (id: ${id})`);
      return {
        content: [
          {
            type: "text" as const,
            text: `${lines.length} grocery stores:\n\n${lines.join("\n")}`,
          },
        ],
      };
    } catch (err) {
      return errorResult(`Failed to list stores: ${err instanceof Error ? err.message : err}`);
    }
  },
);

server.tool(
  "deals_this_week",
  "Show the best current deals from your preferred stores. USE WHEN: browsing what's cheap this week, deciding what to cook based on deals ('what's on sale?'). NOT FOR: searching for a specific product (use search_deals). Requires household stores to be configured via update_household.",
  {
    limit: z.number().optional().default(30).describe("Max deals per store (default 30)"),
  },
  async ({ limit }) => {
    try {
      const household = await store.getHousehold();
      if (household.stores.length === 0) {
        return errorResult(
          "No preferred stores configured. Use update_household to add stores first (use list_stores to find dealer IDs).",
        );
      }

      const sorted = household.stores.sort((a, b) => a.priority - b.priority);

      // Fetch all stores in parallel
      const storeResults = await Promise.all(
        sorted.map(async (s) => {
          try {
            const offers = await getStoreOffers(s.dealerId, limit);
            return { store: s, offers, error: false };
          } catch {
            return { store: s, offers: [] as Offer[], error: true };
          }
        }),
      );

      const parts: string[] = [];
      parts.push(`# Deals this week from ${household.stores.length} preferred stores\n`);

      for (const { store: s, offers, error } of storeResults) {
        if (error) {
          parts.push(`## ${s.name}: failed to fetch offers\n`);
          continue;
        }

        const expiringSoon = offers.filter((o) => daysUntilExpiry(o.validUntil) <= 2);

        parts.push(`## ${s.name} (${offers.length} offers)`);
        if (expiringSoon.length > 0) {
          parts.push(`\n⏰ Expiring soon (${expiringSoon.length}):`);
          for (const o of expiringSoon.slice(0, 5)) {
            parts.push(`- ${formatOffer(o)}`);
          }
        }
        // Show top deals by savings (has prePrice)
        const withSavings = offers
          .filter(
            (o): o is Offer & { prePrice: number; price: number } =>
              o.prePrice !== null && o.price !== null && o.prePrice > o.price,
          )
          .sort((a, b) => b.prePrice - b.price - (a.prePrice - a.price))
          .slice(0, 10);
        if (withSavings.length > 0) {
          parts.push(`\nBest savings:`);
          for (const o of withSavings) {
            const saved = Math.round(o.prePrice - o.price);
            parts.push(
              `- ${o.heading}: ${o.price} DKK (save ${saved} DKK) ${o.pricePerUnit ? `(${o.pricePerUnit})` : ""}`,
            );
          }
        }
        parts.push("");
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err) {
      return errorResult(`Failed to fetch deals: ${err instanceof Error ? err.message : err}`);
    }
  },
);

// ============================================================
// Household tools
// ============================================================

server.tool(
  "get_household",
  "Get household config: people, dietary restrictions, preferred stores, servings. USE WHEN: checking current setup before meal planning, verifying store preferences. Returns onboarding guidance if not yet configured.",
  {},
  async () => {
    const household = await store.getHousehold();
    if (household.people.length === 0 && household.stores.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No household configured yet. Get started in 3 steps:

1. Set up people and stores: update_household (use list_stores to find dealer IDs)
2. Add pantry staples: update_pantry (salt, pepper, oil, etc.)
3. Add recipes: add_recipe (or use the built-in defaults)

Then run plan_and_shop to get a meal plan with shopping list!`,
          },
        ],
      };
    }
    const people = household.people.map((p) => {
      const diet = p.dietaryRestrictions.length > 0 ? p.dietaryRestrictions.join(", ") : "none";
      const days = Object.entries(p.defaultSchedule)
        .filter(([, home]) => home)
        .map(([day]) => day)
        .join(", ");
      return `- ${p.name}: dietary: ${diet} | home: ${days || "all days"}`;
    });
    const stores = household.stores
      .sort((a, b) => a.priority - b.priority)
      .map((s) => `- ${s.priority}. ${s.name} (${s.dealerId})`);
    return {
      content: [
        {
          type: "text" as const,
          text: `Household (default ${household.defaultServings} servings):\n\nPeople:\n${people.join("\n")}\n\nStores (by priority):\n${stores.join("\n")}`,
        },
      ],
    };
  },
);

server.tool(
  "update_household",
  "Set household members, dietary restrictions, preferred stores, servings. USE WHEN: first-time setup or changing household config. Required before shopping lists can filter by preferred stores. TIP: use list_stores to find dealer IDs for preferred stores.",
  {
    people: z
      .array(
        z.object({
          name: z.string().describe("Name"),
          dietaryRestrictions: z.array(z.string()).describe("e.g. 'no pork', 'lactose-free'"),
          defaultSchedule: z
            .record(z.string(), z.boolean())
            .describe("Days at home, e.g. {monday: true}. Omitted = true."),
        }),
      )
      .optional()
      .describe("People in household"),
    stores: z
      .array(
        z.object({
          name: z.string().describe("Store name"),
          dealerId: z.string().describe("Dealer ID from list_stores"),
          priority: z.number().describe("1 = closest/default"),
        }),
      )
      .optional()
      .describe("Preferred stores"),
    defaultServings: z.number().optional().describe("Default servings"),
  },
  async ({ people, stores: storePrefs, defaultServings }) => {
    const updates: Partial<store.Household> = {};
    if (people) {
      updates.people = people.map((p) => ({
        ...p,
        defaultSchedule: {
          monday: true,
          tuesday: true,
          wednesday: true,
          thursday: true,
          friday: true,
          saturday: true,
          sunday: true,
          ...p.defaultSchedule,
        },
      }));
    }
    if (storePrefs) updates.stores = storePrefs;
    if (defaultServings) updates.defaultServings = defaultServings;
    const household = await store.updateHousehold(updates);
    return {
      content: [
        {
          type: "text" as const,
          text: `Household updated: ${household.people.length} people, ${household.stores.length} stores, default ${household.defaultServings} servings.`,
        },
      ],
    };
  },
);

// ============================================================
// Pantry tools
// ============================================================

server.tool(
  "update_pantry",
  "Add or remove pantry items (excluded from shopping lists). USE WHEN: updating stock after shopping or noting staples you always have. Items are matched case-insensitively.",
  {
    add: z.array(z.string()).optional().default([]).describe("Items to add to pantry"),
    remove: z.array(z.string()).optional().default([]).describe("Items to remove from pantry"),
  },
  async ({ add, remove }) => {
    const pantry = await store.updatePantry(add, remove);
    return {
      content: [
        {
          type: "text" as const,
          text: `Pantry (${pantry.length} items): ${pantry.join(", ") || "(empty)"}`,
        },
      ],
    };
  },
);

server.tool(
  "get_pantry",
  "List pantry items (excluded from shopping lists). USE WHEN: checking what's already stocked before generating a shopping list.",
  {},
  async () => {
    const pantry = await store.getPantry();
    return {
      content: [
        {
          type: "text" as const,
          text:
            pantry.length > 0
              ? `Pantry (${pantry.length} items): ${pantry.join(", ")}`
              : "Pantry is empty. Use update_pantry to add staples (salt, pepper, oil, etc.) so they're excluded from shopping lists.",
        },
      ],
    };
  },
);

// ============================================================
// Recipe tools
// ============================================================

server.tool(
  "get_recipes",
  "List saved recipes with ingredients, metadata, and search terms. USE WHEN: reviewing recipe library, checking what's available for meal planning. Returns onboarding guidance if no recipes exist yet.",
  {},
  async () => {
    const recipes = await store.getRecipes();
    if (recipes.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No recipes saved yet. Add recipes with add_recipe to get started.

TIP: Only name, servings, complexity, cuisineType, proteinType, and ingredient names/quantities are required. searchTerms and category are optional and will be inferred.

Example: add_recipe with name "Spaghetti Bolognese", complexity "medium", cuisineType "italian", proteinType "beef", and ingredients like {name: "Hakket oksekød", quantity: "500g"}.`,
          },
        ],
      };
    }
    const lines = recipes.map((r) => {
      const meta = `[${r.complexity}] [${r.cuisineType}] [${r.proteinType}]`;
      const ingredients = r.ingredients
        .map(
          (ing) =>
            `  - ${ing.name}: ${ing.quantity} [${ing.category}] (search: ${ing.searchTerms.join(", ")})`,
        )
        .join("\n");
      return `## ${r.name} (${r.servings} servings) ${meta}\n${ingredients}`;
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `${recipes.length} recipes:\n\n${lines.join("\n\n")}`,
        },
      ],
    };
  },
);

server.tool(
  "add_recipe",
  "Add or update a recipe for meal planning and deal scoring. USE WHEN: saving a new recipe or updating an existing one. TIP: searchTerms defaults to [ingredient name] and category defaults to 'other' if omitted, reducing input friction. Overwrites existing recipe with same name.",
  {
    name: z.string().describe("Recipe name"),
    servings: z.number().optional().default(4).describe("Servings (default 4)"),
    complexity: z
      .enum(["quick", "medium", "slow"])
      .describe("quick (<30min), medium (30-60min), slow (60min+)"),
    cuisineType: z.string().describe("e.g. asian, danish, italian, mexican"),
    proteinType: z.string().describe("e.g. chicken, beef, pork, fish, vegetarian"),
    ingredients: z
      .array(
        z.object({
          name: z.string(),
          quantity: z.string().describe("e.g. '500g', '1L', '2 stk'"),
          searchTerms: z
            .array(z.string())
            .optional()
            .describe("Danish deal search terms. Defaults to [name] if omitted."),
          category: z
            .string()
            .optional()
            .describe("meat|dairy|produce|bakery|frozen|pantry|drinks|other. Defaults to 'other'."),
        }),
      )
      .describe("Ingredients"),
  },
  async ({ name, servings, complexity, cuisineType, proteinType, ingredients }) => {
    // Apply defaults for optional fields
    const resolvedIngredients = ingredients.map((ing) => ({
      name: ing.name,
      quantity: ing.quantity,
      searchTerms:
        ing.searchTerms && ing.searchTerms.length > 0 ? ing.searchTerms : [ing.name.toLowerCase()],
      category: ing.category || "other",
    }));

    await store.addRecipe({
      name,
      servings,
      complexity,
      cuisineType,
      proteinType,
      ingredients: resolvedIngredients,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Recipe "${name}" saved: ${complexity} ${cuisineType} (${proteinType}), ${resolvedIngredients.length} ingredients.`,
        },
      ],
    };
  },
);

server.tool(
  "remove_recipe",
  "Remove a recipe by name. USE WHEN: cleaning up the recipe library. Case-insensitive name matching.",
  {
    name: z.string().describe("Recipe name"),
  },
  async ({ name }) => {
    const removed = await store.removeRecipe(name);
    return {
      content: [
        {
          type: "text" as const,
          text: removed ? `Recipe "${name}" removed.` : `Recipe "${name}" not found.`,
        },
      ],
    };
  },
);

// ============================================================
// Recipe scoring & weekly optimization
// ============================================================

function scoreOneRecipe(
  recipe: store.Recipe,
  dealMap: Map<string, Offer[]>,
  preferredStoreNames: Set<string>,
  pantrySet: Set<string>,
  householdSize: number,
): ScoredRecipe {
  let totalCost = 0;
  let withDeals = 0;
  let nonPantryCount = 0;
  const ingredients: ScoredIngredient[] = [];

  for (const ing of recipe.ingredients) {
    if (pantrySet.has(ing.name.toLowerCase())) continue;
    nonPantryCount++;

    const result = findBestDeal(ing, dealMap, preferredStoreNames);
    const cost = result.best
      ? computeIngredientCost(result.best, ing.quantity, recipe.servings, householdSize)
      : 0;

    const candidates: DealCandidate[] | undefined =
      result.confidence === "low"
        ? result.candidates.map((c) => ({
            heading: c.offer.heading,
            price: c.offer.price ?? 0,
            store: c.offer.store,
            score: c.score,
          }))
        : undefined;

    ingredients.push({
      name: ing.name,
      quantity: ing.quantity,
      category: ing.category,
      bestDeal: result.best
        ? {
            heading: result.best.heading,
            price: cost,
            store: result.best.store,
          }
        : null,
      estimatedCost: cost,
      confidence: result.confidence,
      candidates,
    });
    if (result.best) {
      totalCost += cost;
      withDeals++;
    }
  }

  return {
    name: recipe.name,
    servings: recipe.servings,
    complexity: recipe.complexity,
    proteinType: recipe.proteinType,
    cuisineType: recipe.cuisineType,
    estimatedCost: Math.round(totalCost * 100) / 100,
    dealCoverage: nonPantryCount > 0 ? Math.round((withDeals / nonPantryCount) * 100) : 100,
    ingredients,
  };
}

interface ScoreResult {
  scored: ScoredRecipe[];
  dealMap: Map<string, Offer[]>;
}

async function scoreAllRecipes(
  preferredStoreNames: Set<string>,
  pantrySet: Set<string>,
  householdSize: number,
): Promise<ScoreResult> {
  const recipes = await store.getRecipes();
  if (recipes.length === 0) return { scored: [], dealMap: new Map() };

  // Collect all unique search terms across all recipes
  const allTerms = new Set<string>();
  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      if (pantrySet.has(ing.name.toLowerCase())) continue;
      for (const term of expandSearchTerms(ing.searchTerms)) {
        allTerms.add(term);
      }
    }
  }

  // Batch fetch all deals in parallel
  const dealMap = await searchDealsBatch([...allTerms], 8);

  // Score each recipe
  const scored: ScoredRecipe[] = recipes.map((recipe) =>
    scoreOneRecipe(recipe, dealMap, preferredStoreNames, pantrySet, householdSize),
  );

  scored.sort((a, b) => {
    // Primary: higher deal coverage is better
    if (b.dealCoverage !== a.dealCoverage) return b.dealCoverage - a.dealCoverage;
    // Secondary: lower cost is better
    return a.estimatedCost - b.estimatedCost;
  });

  return { scored, dealMap };
}

function formatRecipeScore(r: ScoredRecipe): string[] {
  const lines: string[] = [];
  const highConf = r.ingredients.filter((i) => i.confidence === "high");
  const lowConf = r.ingredients.filter((i) => i.confidence === "low");
  const noDealItems = r.ingredients.filter((i) => i.confidence === "none");

  lines.push(
    `## ${r.name} — ${Math.round(r.estimatedCost)} DKK (deals on ${r.dealCoverage}% of ingredients)`,
  );
  lines.push(`   ${r.complexity} | ${r.cuisineType} | ${r.proteinType} | ${r.servings} servings`);
  if (highConf.length > 0) {
    lines.push(`   Deals:`);
    for (const i of highConf) {
      const deal = i.bestDeal;
      if (!deal) continue;
      lines.push(
        `     ${i.name} (${i.quantity}): ${deal.heading} — ${Math.round(deal.price)} DKK @ ${deal.store}`,
      );
    }
  }
  if (lowConf.length > 0) {
    lines.push(`   ⚠ Uncertain matches (verify these):`);
    for (const i of lowConf) {
      const deal = i.bestDeal;
      if (!deal) continue;
      lines.push(
        `     ${i.name} (${i.quantity}): ${deal.heading} — ${Math.round(deal.price)} DKK @ ${deal.store} [low confidence]`,
      );
      if (i.candidates && i.candidates.length > 1) {
        lines.push(`       Other candidates:`);
        for (const c of i.candidates.slice(1)) {
          lines.push(`         - ${c.heading} — ${c.price} DKK @ ${c.store} (score: ${c.score})`);
        }
      }
    }
  }
  if (noDealItems.length > 0) {
    lines.push(`   No deals: ${noDealItems.map((i) => `${i.name} (${i.quantity})`).join(", ")}`);
  }
  lines.push("");
  return lines;
}

function formatScoredRecipes(scored: ScoredRecipe[]): string {
  if (scored.length === 0) return "No recipes to score. Add recipes first.";

  const lines: string[] = [];
  for (const r of scored) {
    lines.push(...formatRecipeScore(r));
  }
  return lines.join("\n");
}

server.tool(
  "score_recipes",
  "Score all saved recipes against current deals, optionally optimize a weekly meal plan. USE WHEN: deciding what to cook based on current deals ('what's cheapest this week'), comparing recipe costs. NOT FOR: generating a shopping list (use generate_shopping_list or plan_and_shop). Shows deal coverage %, estimated cost, and confidence levels per ingredient.",
  {
    optimize: z.boolean().optional().default(false).describe("Also generate optimal weekly plan"),
    days: z.number().optional().default(7).describe("Days to plan (default 7)"),
    maxPerProtein: z
      .number()
      .optional()
      .default(2)
      .describe("Max same protein in plan (default 2)"),
    maxPerCuisine: z
      .number()
      .optional()
      .default(2)
      .describe("Max same cuisine in plan (default 2)"),
    maxSlowDays: z
      .number()
      .optional()
      .default(2)
      .describe("Max slow-cook days in plan (default 2)"),
    excludeProteins: z
      .array(z.string())
      .optional()
      .describe(
        'Dietary exclusions. Checks both recipe type and individual ingredients. E.g. ["pork"] also catches bacon in vegetarian recipes. Options: pork, beef, lamb, fish, shellfish, dairy, gluten, beans, nuts, egg',
      ),
    allowProteinOnDays: z
      .record(z.string(), z.array(z.number()))
      .optional()
      .describe(
        'Per-day exceptions for excluded proteins (1-indexed). E.g. {"pork": [2]} = allow pork on day 2 (Tuesday)',
      ),
    slowOnlyOnDays: z
      .array(z.number())
      .optional()
      .describe("Restrict slow recipes to these days only (1-indexed). E.g. [6, 7] for weekends"),
    preferCuisines: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        'Soft cuisine preferences: {"asian": 3} = prefer at least 3 Asian dishes. Best-effort, won\'t fail if impossible.',
      ),
  },
  async ({
    optimize,
    days,
    maxPerProtein,
    maxPerCuisine,
    maxSlowDays,
    excludeProteins,
    allowProteinOnDays,
    slowOnlyOnDays,
    preferCuisines,
  }) => {
    try {
      const household = await store.getHousehold();
      const pantry = await store.getPantry();
      const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
      const preferredStores = new Set(household.stores.map((s) => s.name));

      const householdSize = household.people.length || household.defaultServings;
      const { scored } = await scoreAllRecipes(preferredStores, pantrySet, householdSize);
      const parts: string[] = [];

      parts.push(`# Recipe scores (${scored.length} recipes)\n`);
      parts.push(formatScoredRecipes(scored));

      if (optimize && scored.length >= days) {
        parts.push(`\n# Optimized ${days}-day plan\n`);

        const bestPlan = findOptimalWeek(scored, days, {
          maxPerProtein,
          maxPerCuisine,
          maxSlowDays,
          excludeProteins,
          allowProteinOnDays,
          slowOnlyOnDays,
          preferCuisines,
        });
        if (bestPlan) {
          const basket = calculateBasketCost(bestPlan.recipes);
          parts.push(`Total basket: ~${basket.totalCost} DKK for ${days} days`);
          if (basket.sharedSavings > 0) {
            parts.push(`Shared ingredient savings: ~${basket.sharedSavings} DKK`);
          }
          parts.push(`Unique items to buy: ${basket.uniqueIngredients}\n`);
          for (let i = 0; i < bestPlan.recipes.length; i++) {
            const r = bestPlan.recipes[i];
            parts.push(
              `Day ${i + 1}: ${r.name} (~${r.estimatedCost} DKK) [${r.proteinType}, ${r.cuisineType}, ${r.complexity}]`,
            );
          }
        } else {
          parts.push(
            "Could not find a valid combination with the variety constraints. Try relaxing maxPerProtein, maxPerCuisine, or maxSlowDays.",
          );
        }
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err) {
      return errorResult(`Failed to score recipes: ${err instanceof Error ? err.message : err}`);
    }
  },
);

// ============================================================
// Meal history tools
// ============================================================

server.tool(
  "log_meal",
  "Record a cooked meal for rotation tracking. USE WHEN: logging what was cooked to avoid repeating meals in future planning. Deduplicates by date + recipe name.",
  {
    date: z.string().describe("YYYY-MM-DD"),
    recipe: z.string().describe("Recipe name"),
    people: z.array(z.string()).describe("Who ate"),
  },
  async ({ date, recipe, people }) => {
    await store.logMeal({ date, recipe, people });
    return {
      content: [
        {
          type: "text" as const,
          text: `Logged: ${recipe} on ${date} for ${people.join(", ")}.`,
        },
      ],
    };
  },
);

server.tool(
  "get_meal_history",
  "Recent meal history for rotation planning. USE WHEN: checking what was cooked recently to avoid repetition, reviewing eating patterns.",
  {
    weeks: z.number().optional().default(4).describe("Weeks back (default 4)"),
  },
  async ({ weeks }) => {
    const history = await store.getMealHistory(weeks);
    if (history.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No meal history yet. Use log_meal to start tracking.",
          },
        ],
      };
    }
    const lines = history.map((m) => `- ${m.date}: ${m.recipe} (${m.people.join(", ")})`);
    return {
      content: [
        {
          type: "text" as const,
          text: `Meal history (last ${weeks} weeks, ${history.length} meals):\n\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

// ============================================================
// Spend tracking tools
// ============================================================

server.tool(
  "log_spend",
  "Record grocery spending for budget tracking. USE WHEN: logging what was spent after a shopping trip.",
  {
    date: z.string().describe("YYYY-MM-DD"),
    store: z.string(),
    estimatedTotal: z.number().describe("DKK spent"),
    items: z.number().describe("Items bought"),
    notes: z.string().optional().default(""),
  },
  async ({ date, store: storeName, estimatedTotal, items, notes }) => {
    await store.logSpend({
      date,
      store: storeName,
      estimatedTotal,
      items,
      notes,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Logged: ${estimatedTotal} DKK at ${storeName} on ${date} (${items} items).`,
        },
      ],
    };
  },
);

server.tool(
  "get_spend_log",
  "Spending history with weekly averages and totals. USE WHEN: reviewing grocery budget, tracking spending trends.",
  {
    weeks: z.number().optional().default(8).describe("Weeks back (default 8)"),
  },
  async ({ weeks }) => {
    const log = await store.getSpendLog(weeks);
    if (log.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No spending recorded yet. Use log_spend to start tracking.",
          },
        ],
      };
    }
    const total = log.reduce((sum, s) => sum + s.estimatedTotal, 0);
    const avgPerWeek = total / weeks;
    const lines = log.map(
      (s) =>
        `- ${s.date}: ${s.estimatedTotal} DKK @ ${s.store} (${s.items} items)${s.notes ? ` - ${s.notes}` : ""}`,
    );
    return {
      content: [
        {
          type: "text" as const,
          text: `Spending (last ${weeks} weeks):\n\n${lines.join("\n")}\n\nTotal: ${total.toFixed(0)} DKK | Avg/week: ${avgPerWeek.toFixed(0)} DKK`,
        },
      ],
    };
  },
);

// ============================================================
// Shopping list generator
// ============================================================

/** Ingredient data aggregated across multiple recipes */
interface AggregatedIngredient {
  name: string;
  searchTerms: string[];
  category: string;
  contributions: Array<{
    quantity: string;
    recipeServings: number;
    recipeName: string;
  }>;
  fromRecipes: string[];
}

/** Collect and aggregate ingredients across recipes, skipping pantry items */
function collectIngredients(
  selectedRecipes: store.Recipe[],
  pantrySet: Set<string>,
): Map<string, AggregatedIngredient> {
  const allIngredients = new Map<string, AggregatedIngredient>();
  for (const recipe of selectedRecipes) {
    for (const ing of recipe.ingredients) {
      const key = ing.name.toLowerCase();
      if (pantrySet.has(key)) continue;
      const existing = allIngredients.get(key);
      if (existing) {
        existing.fromRecipes.push(recipe.name);
        existing.contributions.push({
          quantity: ing.quantity,
          recipeServings: recipe.servings,
          recipeName: recipe.name,
        });
        for (const t of ing.searchTerms) {
          if (!existing.searchTerms.includes(t)) existing.searchTerms.push(t);
        }
      } else {
        allIngredients.set(key, {
          name: ing.name,
          searchTerms: [...ing.searchTerms],
          category: ing.category,
          contributions: [
            {
              quantity: ing.quantity,
              recipeServings: recipe.servings,
              recipeName: recipe.name,
            },
          ],
          fromRecipes: [recipe.name],
        });
      }
    }
  }
  return allIngredients;
}

/** Build human-readable display quantity, aggregating across recipes */
function buildDisplayQuantity(
  ing: AggregatedIngredient,
  householdSize: number,
): { displayQty: string; aggregated: ReturnType<typeof aggregateQuantities> } {
  const aggregated = aggregateQuantities(ing.contributions, householdSize);

  let displayQty: string;
  if (ing.contributions.length > 1 && aggregated) {
    const perRecipe = ing.contributions
      .map((c) => {
        const p = parseQuantity(c.quantity);
        if (!p) return c.quantity;
        const scale = c.recipeServings > 0 ? householdSize / c.recipeServings : 1;
        return formatQuantity(Math.round(p.amount * scale), p.unit);
      })
      .join(" + ");
    displayQty = `${perRecipe} = ${formatQuantity(aggregated.totalAmount, aggregated.unit)}`;
  } else if (aggregated) {
    displayQty = formatQuantity(aggregated.totalAmount, aggregated.unit);
  } else {
    displayQty = ing.contributions.map((c) => c.quantity).join(" + ");
  }

  return { displayQty, aggregated };
}

/** Format a single ingredient's deal match into a shopping list line */
function formatIngredientDeal(
  ing: AggregatedIngredient,
  best: Offer,
  confidence: "high" | "low",
  displayQty: string,
  aggregated: ReturnType<typeof aggregateQuantities>,
  householdSize: number,
): { line: string; cost: number } {
  const storeName = best.store;
  const validTo = best.validUntil?.slice(0, 10) ?? "unknown";
  const conf = confidence === "low" ? " ⚠" : "";
  const expiry = expiryTag(best.validUntil);

  let shopping = aggregated
    ? computeShoppingCostFromTotal(best, aggregated.totalAmount, aggregated.unit)
    : null;
  if (!shopping) {
    shopping = computeShoppingCost(
      best,
      ing.contributions[0].quantity,
      ing.contributions[0].recipeServings,
      householdSize,
    );
  }

  if (shopping) {
    const packInfo =
      shopping.packsNeeded > 1
        ? `${shopping.packsNeeded} x ${shopping.pricePerPack} DKK`
        : `${shopping.pricePerPack} DKK`;
    const leftoverInfo =
      shopping.leftover > 0
        ? ` (${formatQuantity(shopping.leftover, shopping.unitNeeded)} leftover)`
        : "";
    return {
      line: `${ing.name}: need ${displayQty} -> ${packInfo} = ${shopping.totalCost} DKK [${formatQuantity(shopping.packSize, shopping.unitNeeded)}/pack${shopping.unitPrice ? `, ${shopping.unitPrice}` : ""}]${leftoverInfo} -- ${best.heading} @ ${storeName} until ${validTo}${expiry}${conf}`,
      cost: shopping.totalCost,
    };
  }

  return {
    line: `${ing.name} (${displayQty}): ${best.heading} - ${best.price} ${best.currency}${best.pricePerUnit ? ` (${best.pricePerUnit})` : ""} @ ${storeName} until ${validTo}${expiry}${conf}`,
    cost: best.price ?? 0,
  };
}

/** Build the shopping list output shared by generate_shopping_list and plan_and_shop */
async function buildShoppingList(
  selectedRecipes: store.Recipe[],
  householdSize: number,
  existingDealMap?: Map<string, Offer[]>,
  excludePantry = true,
): Promise<string> {
  const pantry = excludePantry ? await store.getPantry() : [];
  const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
  const household = await store.getHousehold();
  const preferredStores = new Set(household.stores.map((s) => s.name));

  const allIngredients = collectIngredients(selectedRecipes, pantrySet);
  if (allIngredients.size === 0) {
    return "All ingredients are in your pantry. Nothing to buy!";
  }

  // Use cached deals if available, otherwise fetch
  let dealMap: Map<string, Offer[]>;
  if (existingDealMap) {
    dealMap = existingDealMap;
  } else {
    const allSearchTerms = new Set<string>();
    for (const [, ing] of allIngredients) {
      for (const term of expandSearchTerms(ing.searchTerms)) allSearchTerms.add(term);
    }
    dealMap = await searchDealsBatch([...allSearchTerms], 8);
  }

  const byStore = new Map<string, string[]>();
  const regularPrice: string[] = [];
  const uncertainItems: string[] = [];
  const expiringWarnings: string[] = [];
  let grandTotal = 0;

  for (const [, ing] of allIngredients) {
    const result = findBestDeal(ing, dealMap, preferredStores);
    const { displayQty, aggregated } = buildDisplayQuantity(ing, householdSize);

    if (result.best) {
      const best = result.best;
      if (daysUntilExpiry(best.validUntil) <= 2) {
        const validTo = best.validUntil?.slice(0, 10) ?? "unknown";
        expiringWarnings.push(
          `${ing.name}: deal at ${best.store} ${expiryTag(best.validUntil).trim().toLowerCase()} (${validTo})`,
        );
      }

      const { line, cost } = formatIngredientDeal(
        ing,
        best,
        result.confidence as "high" | "low",
        displayQty,
        aggregated,
        householdSize,
      );
      grandTotal += cost;

      const storeList = byStore.get(best.store) ?? [];
      storeList.push(line);
      byStore.set(best.store, storeList);

      if (result.confidence === "low" && result.candidates.length > 1) {
        const alts = result.candidates
          .slice(1)
          .map((c) => `${c.offer.heading} - ${c.offer.price} DKK @ ${c.offer.store}`)
          .join("; ");
        uncertainItems.push(`${ing.name}: picked "${best.heading}" but also found: ${alts}`);
      }
    } else {
      regularPrice.push(`${ing.name} (${displayQty}) [${ing.fromRecipes.join(", ")}]`);
    }
  }

  return formatShoppingOutput({
    selectedRecipes,
    householdSize,
    grandTotal,
    byStore,
    regularPrice,
    uncertainItems,
    expiringWarnings,
    pantry,
  });
}

/** Format the final shopping list text from categorized data */
function formatShoppingOutput(ctx: {
  selectedRecipes: store.Recipe[];
  householdSize: number;
  grandTotal: number;
  byStore: Map<string, string[]>;
  regularPrice: string[];
  uncertainItems: string[];
  expiringWarnings: string[];
  pantry: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    `Shopping list for: ${ctx.selectedRecipes.map((r) => r.name).join(", ")} (${ctx.householdSize} people)`,
  );
  parts.push(`Estimated register total (deals only): ~${Math.round(ctx.grandTotal)} DKK`);
  parts.push("");

  if (ctx.expiringWarnings.length > 0) {
    parts.push(`## ⏰ Buy first (expiring soon)`);
    for (const w of ctx.expiringWarnings) parts.push(`- ${w}`);
    parts.push("");
  }

  for (const [storeName, items] of ctx.byStore) {
    parts.push(`## ${storeName} (${items.length} items)`);
    for (let i = 0; i < items.length; i++) {
      parts.push(`${i + 1}. ${items[i]}`);
    }
    parts.push("");
  }

  if (ctx.regularPrice.length > 0) {
    parts.push(`## Buy at regular price (${ctx.regularPrice.length} items)`);
    for (const u of ctx.regularPrice) parts.push(`- ${u}`);
    parts.push("");
  }

  if (ctx.uncertainItems.length > 0) {
    parts.push(`## ⚠ Uncertain matches (verify these)`);
    for (const u of ctx.uncertainItems) parts.push(`- ${u}`);
    parts.push("");
  }

  const skippedPantry = ctx.pantry.filter((p) =>
    ctx.selectedRecipes.some((r) =>
      r.ingredients.some((i) => i.name.toLowerCase() === p.toLowerCase()),
    ),
  );
  if (skippedPantry.length > 0) {
    parts.push(`## Skipped (in pantry): ${skippedPantry.join(", ")}`);
  }

  return parts.join("\n");
}

server.tool(
  "generate_shopping_list",
  "Deal-optimized shopping list from specific recipes, grouped by store. USE WHEN: preparing to shop for chosen recipes ('shopping list for Bolognese and Chili'). Aggregates quantities across recipes, computes pack sizes, flags expiring deals. NOT FOR: deciding what to cook (use score_recipes or plan_and_shop first). Requires recipes to exist (see add_recipe).",
  {
    recipes: z.array(z.string()).describe("Recipe names"),
    people: z.number().optional().describe("Household size (overrides stored household config)"),
    excludePantry: z
      .boolean()
      .optional()
      .default(true)
      .describe("Skip pantry items (default true)"),
  },
  async ({ recipes: recipeNames, people, excludePantry }) => {
    try {
      const allRecipes = await store.getRecipes();

      const selectedRecipes = allRecipes.filter((r) =>
        recipeNames.some((n) => r.name.toLowerCase() === n.toLowerCase()),
      );

      if (selectedRecipes.length === 0) {
        const available = allRecipes.map((r) => r.name).join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `No matching recipes found. Available: ${available || "none (add recipes first)"}`,
            },
          ],
        };
      }

      const household = await store.getHousehold();
      const householdSize = people ?? (household.people.length || household.defaultServings);

      const text = await buildShoppingList(
        selectedRecipes,
        householdSize,
        undefined,
        excludePantry,
      );
      return {
        content: [{ type: "text" as const, text }],
      };
    } catch (err) {
      return errorResult(
        `Failed to generate shopping list: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

// ============================================================
// Composite: plan + shop in one call
// ============================================================

server.tool(
  "plan_and_shop",
  "Score recipes, optimize a weekly meal plan, and generate a shopping list in one step. USE WHEN: 'plan my week', 'what should we eat?', 'make a meal plan with shopping list'. This is the main entry point for weekly dinner planning. NOT FOR: shopping for specific pre-chosen recipes (use generate_shopping_list).",
  {
    days: z.number().optional().default(7).describe("Days to plan (default 7)"),
    people: z.number().optional().describe("Household size (overrides stored config)"),
    maxPerProtein: z
      .number()
      .optional()
      .default(2)
      .describe("Max same protein in plan (default 2)"),
    maxPerCuisine: z
      .number()
      .optional()
      .default(2)
      .describe("Max same cuisine in plan (default 2)"),
    maxSlowDays: z.number().optional().default(2).describe("Max slow-cook days (default 2)"),
    excludeProteins: z
      .array(z.string())
      .optional()
      .describe('Dietary exclusions, e.g. ["pork", "dairy"]. Also scans ingredient names.'),
    slowOnlyOnDays: z
      .array(z.number())
      .optional()
      .describe("Restrict slow recipes to these days (1-indexed). E.g. [6, 7]"),
    preferCuisines: z
      .record(z.string(), z.number())
      .optional()
      .describe('Soft cuisine preferences: {"asian": 3} = prefer at least 3 Asian dishes'),
  },
  async ({
    days,
    people,
    maxPerProtein,
    maxPerCuisine,
    maxSlowDays,
    excludeProteins,
    slowOnlyOnDays,
    preferCuisines,
  }) => {
    try {
      const household = await store.getHousehold();
      const pantry = await store.getPantry();
      const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
      const preferredStores = new Set(household.stores.map((s) => s.name));
      const householdSize = people ?? (household.people.length || household.defaultServings);

      const { scored, dealMap: cachedDeals } = await scoreAllRecipes(
        preferredStores,
        pantrySet,
        householdSize,
      );

      if (scored.length < days) {
        return errorResult(
          `Need at least ${days} recipes to plan ${days} days, but only ${scored.length} recipes exist. Add more with add_recipe.`,
        );
      }

      const bestPlan = findOptimalWeek(scored, days, {
        maxPerProtein,
        maxPerCuisine,
        maxSlowDays,
        excludeProteins,
        slowOnlyOnDays,
        preferCuisines,
      });

      if (!bestPlan) {
        return errorResult(
          "Could not find a valid meal plan with the variety constraints. Try relaxing maxPerProtein, maxPerCuisine, or maxSlowDays.",
        );
      }

      const parts: string[] = [];
      parts.push(`# ${days}-day meal plan (${householdSize} people)\n`);

      const basket = calculateBasketCost(bestPlan.recipes);
      parts.push(`Estimated basket: ~${basket.totalCost} DKK`);
      if (basket.sharedSavings > 0) {
        parts.push(`Shared ingredient savings: ~${basket.sharedSavings} DKK`);
      }
      parts.push("");

      for (let i = 0; i < bestPlan.recipes.length; i++) {
        const r = bestPlan.recipes[i];
        parts.push(
          `Day ${i + 1}: ${r.name} (~${r.estimatedCost} DKK) [${r.proteinType}, ${r.cuisineType}, ${r.complexity}]`,
        );
      }

      // Generate shopping list for the planned recipes
      const allRecipes = await store.getRecipes();
      const plannedRecipes = allRecipes.filter((r) =>
        bestPlan.recipes.some((p) => p.name.toLowerCase() === r.name.toLowerCase()),
      );

      parts.push("\n---\n");
      const shoppingList = await buildShoppingList(plannedRecipes, householdSize, cachedDeals);
      parts.push(shoppingList);

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err) {
      return errorResult(`Failed to plan: ${err instanceof Error ? err.message : err}`);
    }
  },
);

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TilbudsTrolden MCP server v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
