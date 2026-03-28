import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { Offer } from "./api.js";
import {
  getStoreOffers,
  listStores,
  searchDeals,
  searchDealsBatch,
} from "./api.js";
import {
  calculateBasketCost,
  findBestDeal,
  findOptimalWeek,
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

function formatOffer(o: Offer): string {
  const parts = [`${o.heading} - ${o.price} ${o.currency}`];
  if (o.pricePerUnit) parts.push(`(${o.pricePerUnit})`);
  parts.push(`@ ${o.store}`);
  if (o.prePrice) parts.push(`was ${o.prePrice} ${o.currency}`);
  const validTo = o.validUntil?.slice(0, 10) ?? "unknown";
  parts.push(`valid until ${validTo}`);
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
// Deal tools
// ============================================================

server.tool(
  "search_deals",
  "Search grocery deals across Danish stores by keyword",
  {
    query: z.string().describe("Danish search term, e.g. 'hakket oksekød'"),
    limit: z.number().optional().default(20).describe("Max results"),
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
      return errorResult(
        `Failed to search deals: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

server.tool(
  "get_store_offers",
  "List current offers from a specific store",
  {
    store: z
      .string()
      .describe(
        `Store name or dealer ID. Known: ${Object.keys(KNOWN_STORES).join(", ")}`,
      ),
    limit: z.number().optional().default(50).describe("Max results"),
  },
  async ({ store: storeName, limit }) => {
    try {
      const dealerId =
        KNOWN_STORES[storeName.trim().toLowerCase()] ?? storeName.trim();
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
      return errorResult(
        `Failed to get store offers: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

server.tool(
  "list_stores",
  "List Danish grocery chains with dealer IDs",
  {
    query: z.string().optional().describe("Filter by name"),
    all: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include non-grocery stores too"),
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
      return errorResult(
        `Failed to list stores: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

// ============================================================
// Household tools
// ============================================================

server.tool(
  "get_household",
  "Get household config: people, dietary restrictions, preferred stores, servings",
  {},
  async () => {
    const household = await store.getHousehold();
    if (household.people.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No household configured yet. Use update_household to set up people and stores.",
          },
        ],
      };
    }
    const people = household.people.map((p) => {
      const diet =
        p.dietaryRestrictions.length > 0
          ? p.dietaryRestrictions.join(", ")
          : "none";
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
  "Set household members, dietary restrictions, preferred stores, servings",
  {
    people: z
      .array(
        z.object({
          name: z.string().describe("Name"),
          dietaryRestrictions: z
            .array(z.string())
            .describe("e.g. 'no pork', 'lactose-free'"),
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
  "Add or remove pantry items (excluded from shopping lists)",
  {
    add: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Items to add to pantry"),
    remove: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Items to remove from pantry"),
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

server.tool("get_pantry", "List pantry items", {}, async () => {
  const pantry = await store.getPantry();
  return {
    content: [
      {
        type: "text" as const,
        text:
          pantry.length > 0
            ? `Pantry (${pantry.length} items): ${pantry.join(", ")}`
            : "Pantry is empty.",
      },
    ],
  };
});

// ============================================================
// Recipe tools
// ============================================================

server.tool("get_recipes", "List saved recipes", {}, async () => {
  const recipes = await store.getRecipes();
  if (recipes.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "No recipes saved yet. Use add_recipe to add one.",
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
});

server.tool(
  "add_recipe",
  "Add or update a recipe for meal planning and deal scoring",
  {
    name: z.string().describe("Recipe name"),
    servings: z.number().optional().default(4).describe("Servings"),
    complexity: z
      .enum(["quick", "medium", "slow"])
      .describe("quick (<30min), medium (30-60min), slow (60min+)"),
    cuisineType: z.string().describe("e.g. asian, danish, italian, mexican"),
    proteinType: z
      .string()
      .describe("e.g. chicken, beef, pork, fish, vegetarian"),
    ingredients: z
      .array(
        z.object({
          name: z.string(),
          quantity: z.string().describe("e.g. '500g', '1L', '2 stk'"),
          searchTerms: z.array(z.string()).describe("Danish deal search terms"),
          category: z
            .string()
            .describe("meat|dairy|produce|bakery|frozen|pantry|drinks|other"),
        }),
      )
      .describe("Ingredients"),
  },
  async ({
    name,
    servings,
    complexity,
    cuisineType,
    proteinType,
    ingredients,
  }) => {
    await store.addRecipe({
      name,
      servings,
      complexity,
      cuisineType,
      proteinType,
      ingredients,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: `Recipe "${name}" saved: ${complexity} ${cuisineType} (${proteinType}), ${ingredients.length} ingredients.`,
        },
      ],
    };
  },
);

server.tool(
  "remove_recipe",
  "Remove a recipe",
  {
    name: z.string().describe("Recipe name"),
  },
  async ({ name }) => {
    const removed = await store.removeRecipe(name);
    return {
      content: [
        {
          type: "text" as const,
          text: removed
            ? `Recipe "${name}" removed.`
            : `Recipe "${name}" not found.`,
        },
      ],
    };
  },
);

// ============================================================
// Recipe scoring & weekly optimization
// ============================================================

async function scoreAllRecipes(
  preferredStoreNames: Set<string>,
  pantrySet: Set<string>,
): Promise<ScoredRecipe[]> {
  const recipes = await store.getRecipes();
  if (recipes.length === 0) return [];

  // Collect all unique search terms across all recipes
  const allTerms = new Set<string>();
  for (const recipe of recipes) {
    for (const ing of recipe.ingredients) {
      if (pantrySet.has(ing.name.toLowerCase())) continue;
      for (const term of ing.searchTerms) {
        allTerms.add(term);
      }
    }
  }

  // Batch fetch all deals in parallel
  const dealMap = await searchDealsBatch([...allTerms], 8);

  // Score each recipe
  const scored: ScoredRecipe[] = [];
  for (const recipe of recipes) {
    let totalCost = 0;
    let withDeals = 0;
    let nonPantryCount = 0;
    const ingredients: ScoredIngredient[] = [];

    for (const ing of recipe.ingredients) {
      if (pantrySet.has(ing.name.toLowerCase())) continue;
      nonPantryCount++;

      const bestOffer = findBestDeal(ing, dealMap, preferredStoreNames);
      const price = bestOffer?.price ?? 0;

      ingredients.push({
        name: ing.name,
        quantity: ing.quantity,
        category: ing.category,
        bestDeal: bestOffer
          ? { heading: bestOffer.heading, price, store: bestOffer.store }
          : null,
        estimatedCost: price,
      });
      if (bestOffer) {
        totalCost += price;
        withDeals++;
      }
    }

    scored.push({
      name: recipe.name,
      servings: recipe.servings,
      complexity: recipe.complexity,
      proteinType: recipe.proteinType,
      cuisineType: recipe.cuisineType,
      estimatedCost: totalCost,
      dealCoverage:
        nonPantryCount > 0
          ? Math.round((withDeals / nonPantryCount) * 100)
          : 100,
      ingredients,
    });
  }

  return scored.sort((a, b) => {
    // Primary: higher deal coverage is better
    if (b.dealCoverage !== a.dealCoverage)
      return b.dealCoverage - a.dealCoverage;
    // Secondary: lower cost is better
    return a.estimatedCost - b.estimatedCost;
  });
}

function formatScoredRecipes(scored: ScoredRecipe[]): string {
  if (scored.length === 0) return "No recipes to score. Add recipes first.";

  const lines: string[] = [];
  for (const r of scored) {
    const dealItems = r.ingredients.filter((i) => i.bestDeal);
    const noDealItems = r.ingredients.filter((i) => !i.bestDeal);

    lines.push(
      `## ${r.name} — ${r.estimatedCost} DKK (deals on ${r.dealCoverage}% of ingredients)`,
    );
    lines.push(
      `   ${r.complexity} | ${r.cuisineType} | ${r.proteinType} | ${r.servings} servings`,
    );
    if (dealItems.length > 0) {
      lines.push(`   Deals:`);
      for (const i of dealItems) {
        const deal = i.bestDeal;
        if (!deal) continue;
        lines.push(
          `     ${i.name} (${i.quantity}): ${deal.heading} — ${deal.price} DKK @ ${deal.store}`,
        );
      }
    }
    if (noDealItems.length > 0) {
      lines.push(
        `   No deals: ${noDealItems.map((i) => `${i.name} (${i.quantity})`).join(", ")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

server.tool(
  "score_recipes",
  "Score recipes against current deals, optionally optimize a weekly meal plan",
  {
    optimize: z
      .boolean()
      .optional()
      .default(false)
      .describe("Also generate optimal weekly plan"),
    days: z.number().optional().default(7).describe("Days to plan"),
    maxPerProtein: z
      .number()
      .optional()
      .default(2)
      .describe("Max same protein in plan"),
    maxPerCuisine: z
      .number()
      .optional()
      .default(2)
      .describe("Max same cuisine in plan"),
    maxSlowDays: z
      .number()
      .optional()
      .default(2)
      .describe("Max slow-cook days in plan"),
    excludeProteins: z
      .array(z.string())
      .optional()
      .describe('Proteins to exclude globally, e.g. ["pork"]'),
    allowProteinOnDays: z
      .record(z.string(), z.array(z.number()))
      .optional()
      .describe(
        'Per-day exceptions for excluded proteins (1-indexed). E.g. {"pork": [2]} = allow pork on day 2 (Tuesday)',
      ),
    slowOnlyOnDays: z
      .array(z.number())
      .optional()
      .describe(
        "Restrict slow recipes to these days only (1-indexed). E.g. [6, 7] for weekends",
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
  }) => {
    try {
      const household = await store.getHousehold();
      const pantry = await store.getPantry();
      const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));
      const preferredStores = new Set(household.stores.map((s) => s.name));

      const scored = await scoreAllRecipes(preferredStores, pantrySet);
      const parts: string[] = [];

      parts.push(`# Recipe scores (${scored.length} recipes)\n`);
      parts.push(formatScoredRecipes(scored));

      if (optimize && scored.length >= days) {
        parts.push(`\n# Optimized ${days}-day plan\n`);

        // Generate valid combinations respecting protein variety
        // For small recipe counts, enumerate; for larger, use greedy
        const bestPlan = findOptimalWeek(scored, days, {
          maxPerProtein,
          maxPerCuisine,
          maxSlowDays,
          excludeProteins,
          allowProteinOnDays,
          slowOnlyOnDays,
        });
        if (bestPlan) {
          const basket = calculateBasketCost(bestPlan.recipes);
          parts.push(`Total basket: ~${basket.totalCost} DKK for ${days} days`);
          if (basket.sharedSavings > 0) {
            parts.push(
              `Shared ingredient savings: ~${basket.sharedSavings} DKK`,
            );
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
      return errorResult(
        `Failed to score recipes: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

// ============================================================
// Meal history tools
// ============================================================

server.tool(
  "log_meal",
  "Record a cooked meal for rotation tracking",
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
  "Recent meal history for rotation planning",
  {
    weeks: z.number().optional().default(4).describe("Weeks back"),
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
    const lines = history.map(
      (m) => `- ${m.date}: ${m.recipe} (${m.people.join(", ")})`,
    );
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
  "Record grocery spending",
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
  "Spending history with totals",
  {
    weeks: z.number().optional().default(8).describe("Weeks back"),
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

server.tool(
  "generate_shopping_list",
  "Deal-optimized shopping list from recipes, grouped by store",
  {
    recipes: z.array(z.string()).describe("Recipe names"),
    excludePantry: z
      .boolean()
      .optional()
      .default(true)
      .describe("Skip pantry items"),
  },
  async ({ recipes: recipeNames, excludePantry }) => {
    try {
      const allRecipes = await store.getRecipes();
      const pantry = excludePantry ? await store.getPantry() : [];
      const pantrySet = new Set(pantry.map((p) => p.toLowerCase()));

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

      // Collect unique ingredients, skip pantry items
      const allIngredients = new Map<
        string,
        {
          name: string;
          searchTerms: string[];
          category: string;
          quantity: string;
          fromRecipes: string[];
        }
      >();

      for (const recipe of selectedRecipes) {
        for (const ing of recipe.ingredients) {
          const key = ing.name.toLowerCase();
          if (pantrySet.has(key)) continue;
          const existing = allIngredients.get(key);
          if (existing) {
            existing.fromRecipes.push(recipe.name);
          } else {
            allIngredients.set(key, {
              ...ing,
              fromRecipes: [recipe.name],
            });
          }
        }
      }

      if (allIngredients.size === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "All ingredients are in your pantry. Nothing to buy!",
            },
          ],
        };
      }

      // Search for deals per ingredient using smart matching
      const household = await store.getHousehold();
      const preferredStores = new Set(household.stores.map((s) => s.name));
      const byStore = new Map<string, string[]>();
      const regularPrice: string[] = [];
      const skippedPantry = pantry.filter((p) =>
        selectedRecipes.some((r) =>
          r.ingredients.some((i) => i.name.toLowerCase() === p.toLowerCase()),
        ),
      );

      // Batch fetch all deals in parallel
      const allSearchTerms = new Set<string>();
      for (const [, ing] of allIngredients) {
        for (const term of ing.searchTerms) allSearchTerms.add(term);
      }
      const dealMap = await searchDealsBatch([...allSearchTerms], 8);

      for (const [, ing] of allIngredients) {
        const bestOffer = findBestDeal(ing, dealMap, preferredStores);

        if (bestOffer) {
          const best = bestOffer;
          const storeName = best.store;
          const validTo = best.validUntil?.slice(0, 10) ?? "unknown";
          const line = `${ing.name} (${ing.quantity}): ${best.heading} - ${best.price} ${best.currency}${best.pricePerUnit ? ` (${best.pricePerUnit})` : ""} valid until ${validTo}`;
          const storeList = byStore.get(storeName) ?? [];
          storeList.push(line);
          byStore.set(storeName, storeList);
        } else {
          regularPrice.push(
            `${ing.name} (${ing.quantity}) [${ing.fromRecipes.join(", ")}]`,
          );
        }
      }

      // Format output grouped by store
      const parts: string[] = [];
      parts.push(
        `Shopping list for: ${selectedRecipes.map((r) => r.name).join(", ")}`,
      );
      parts.push("");

      for (const [storeName, items] of byStore) {
        parts.push(`## ${storeName} (${items.length} items)`);
        for (let i = 0; i < items.length; i++) {
          parts.push(`${i + 1}. ${items[i]}`);
        }
        parts.push("");
      }

      if (regularPrice.length > 0) {
        parts.push(`## Buy at regular price (${regularPrice.length} items)`);
        for (const u of regularPrice) parts.push(`- ${u}`);
        parts.push("");
      }

      if (skippedPantry.length > 0) {
        parts.push(`## Skipped (in pantry): ${skippedPantry.join(", ")}`);
      }

      return {
        content: [{ type: "text" as const, text: parts.join("\n") }],
      };
    } catch (err) {
      return errorResult(
        `Failed to generate shopping list: ${err instanceof Error ? err.message : err}`,
      );
    }
  },
);

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `TilbudsTrolden MCP server v${SERVER_VERSION} running on stdio`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
