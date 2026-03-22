import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { searchDeals, getStoreOffers, listStores } from "./api.js";
import type { Offer } from "./api.js";
import * as store from "./store.js";

const KNOWN_STORES: Record<string, string> = {
  netto: "9ba51",
  meny: "267e1m",
  lidl: "71c90",
  rema: "bba6a",
  "rema 1000": "bba6a",
  rema1000: "bba6a",
  foetex: "d311fg",
  føtex: "d311fg",
  bilka: "93a44",
  aldi: "eabr3o",
  spar: "eak5r8",
};

function formatOffer(o: Offer): string {
  const parts = [`${o.heading} - ${o.price} ${o.currency}`];
  if (o.pricePerUnit) parts.push(`(${o.pricePerUnit})`);
  parts.push(`@ ${o.store}`);
  if (o.prePrice) parts.push(`was ${o.prePrice} ${o.currency}`);
  const validTo = o.validUntil.slice(0, 10);
  parts.push(`valid until ${validTo}`);
  return parts.join(" ");
}

function formatOfferList(offers: Offer[]): string {
  if (offers.length === 0) return "No offers found.";
  return offers.map((o, i) => `${i + 1}. ${formatOffer(o)}`).join("\n");
}

const server = new McpServer({
  name: "smart-shopper",
  version: "0.2.0",
});

// ============================================================
// Deal tools
// ============================================================

server.tool(
  "search_deals",
  "Search current grocery deals across Danish stores by keyword (e.g. 'kylling', 'mælk', 'oksekød')",
  {
    query: z
      .string()
      .describe("Search term in Danish (e.g. 'hakket oksekød', 'æg', 'smør')"),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    const offers = await searchDeals(query, limit);
    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${offers.length} deals for "${query}":\n\n${formatOfferList(offers)}`,
        },
      ],
    };
  },
);

server.tool(
  "get_store_offers",
  "List current offers from a specific Danish grocery store",
  {
    store: z
      .string()
      .describe(
        `Store name or dealer ID. Known: ${Object.keys(KNOWN_STORES).join(", ")}`,
      ),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe("Max results (default 50)"),
  },
  async ({ store: storeName, limit }) => {
    const dealerId = KNOWN_STORES[storeName.toLowerCase()] ?? storeName;
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
  },
);

server.tool(
  "list_stores",
  "List available Danish grocery store chains with their IDs",
  {},
  async () => {
    const stores = await listStores();
    const lines = stores
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(
        (s) => `- ${s.name} (id: ${s.id})${s.website ? ` ${s.website}` : ""}`,
      );
    return {
      content: [
        {
          type: "text" as const,
          text: `${stores.length} stores available:\n\n${lines.join("\n")}`,
        },
      ],
    };
  },
);

// ============================================================
// Household tools
// ============================================================

server.tool(
  "get_household",
  "Get household configuration: people (names, dietary restrictions, schedules), preferred stores, and default servings",
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
  "Configure household: people with dietary restrictions and weekly schedules, preferred stores, default servings",
  {
    people: z
      .array(
        z.object({
          name: z.string().describe("Person's name"),
          dietaryRestrictions: z
            .array(z.string())
            .describe("Dietary restrictions (e.g. 'no pork', 'lactose-free')"),
          defaultSchedule: z
            .record(z.string(), z.boolean())
            .describe(
              "Days at home: { monday: true, tuesday: true, ... }. Omitted days default to true.",
            ),
        }),
      )
      .optional()
      .describe("Household members"),
    stores: z
      .array(
        z.object({
          name: z.string().describe("Store name"),
          dealerId: z.string().describe("Store dealer ID from list_stores"),
          priority: z.number().describe("Priority (1 = closest/default)"),
        }),
      )
      .optional()
      .describe("Preferred stores in priority order"),
    defaultServings: z
      .number()
      .optional()
      .describe("Default number of servings"),
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
  "Add or remove items from pantry (items at home that don't need to be bought)",
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

server.tool(
  "get_pantry",
  "List items currently in pantry (will be excluded from shopping lists)",
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
              : "Pantry is empty.",
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
  "List all saved recipes with ingredients, complexity, cuisine type, and protein type",
  {},
  async () => {
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
  },
);

server.tool(
  "add_recipe",
  "Add or update a recipe with ingredients, complexity, cuisine type, and protein type for meal planning",
  {
    name: z.string().describe("Recipe name"),
    servings: z.number().optional().default(4).describe("Number of servings"),
    complexity: z
      .enum(["quick", "medium", "slow"])
      .describe(
        "Cooking complexity: quick (<30min), medium (30-60min), slow (60min+)",
      ),
    cuisineType: z
      .string()
      .describe(
        "Cuisine type (e.g. asian, danish, italian, mexican, middle-eastern)",
      ),
    proteinType: z
      .string()
      .describe(
        "Main protein (e.g. chicken, beef, pork, fish, vegetarian, vegan)",
      ),
    ingredients: z
      .array(
        z.object({
          name: z.string().describe("Ingredient name"),
          quantity: z
            .string()
            .describe("Amount needed (e.g. '500g', '1L', '2 stk')"),
          searchTerms: z
            .array(z.string())
            .describe(
              "Danish search terms for matching deals (e.g. ['hakket oksekød', 'oksekød'])",
            ),
          category: z
            .string()
            .describe(
              "Category: meat, dairy, produce, bakery, frozen, pantry, drinks, other",
            ),
        }),
      )
      .describe("List of ingredients"),
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
  "Remove a saved recipe by name",
  {
    name: z.string().describe("Recipe name to remove"),
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
// Meal history tools
// ============================================================

server.tool(
  "log_meal",
  "Record a meal that was cooked (for rotation tracking, so the system avoids repeating recent meals)",
  {
    date: z.string().describe("Date in YYYY-MM-DD format"),
    recipe: z.string().describe("Recipe name that was cooked"),
    people: z.array(z.string()).describe("Names of people who ate this meal"),
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
  "Show recent meal history for rotation planning (what was cooked and when)",
  {
    weeks: z
      .number()
      .optional()
      .default(4)
      .describe("How many weeks back to look (default 4)"),
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
  "Record grocery spending for budget tracking",
  {
    date: z.string().describe("Date in YYYY-MM-DD format"),
    store: z.string().describe("Store name"),
    estimatedTotal: z.number().describe("Amount spent in DKK"),
    items: z.number().describe("Number of items bought"),
    notes: z.string().optional().default("").describe("Optional notes"),
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
  "Show grocery spending history for budget tracking",
  {
    weeks: z
      .number()
      .optional()
      .default(8)
      .describe("How many weeks back to look (default 8)"),
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
  "Generate a deal-optimized shopping list from selected recipes. Excludes pantry items, respects dietary restrictions, and groups by store.",
  {
    recipes: z.array(z.string()).describe("Recipe names to shop for"),
    excludePantry: z
      .boolean()
      .optional()
      .default(true)
      .describe("Skip ingredients found in pantry (default true)"),
  },
  async ({ recipes: recipeNames, excludePantry }) => {
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

    // Search for deals per ingredient
    const byStore = new Map<string, string[]>();
    const regularPrice: string[] = [];
    const skippedPantry = pantry.filter((p) =>
      selectedRecipes.some((r) =>
        r.ingredients.some((i) => i.name.toLowerCase() === p.toLowerCase()),
      ),
    );

    for (const [, ing] of allIngredients) {
      let bestOffers: Offer[] = [];

      for (const term of ing.searchTerms) {
        const offers = await searchDeals(term, 5);
        bestOffers = [...bestOffers, ...offers];
      }

      if (bestOffers.length > 0) {
        bestOffers.sort((a, b) => (a.price ?? 999) - (b.price ?? 999));
        const best = bestOffers[0];
        const storeName = best.store;
        const line = `${ing.name} (${ing.quantity}): ${best.heading} - ${best.price} ${best.currency}${best.pricePerUnit ? ` (${best.pricePerUnit})` : ""} valid until ${best.validUntil.slice(0, 10)}`;
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
      items.forEach((item, i) => parts.push(`${i + 1}. ${item}`));
      parts.push("");
    }

    if (regularPrice.length > 0) {
      parts.push(`## Buy at regular price (${regularPrice.length} items)`);
      regularPrice.forEach((u) => parts.push(`- ${u}`));
      parts.push("");
    }

    if (skippedPantry.length > 0) {
      parts.push(`## Skipped (in pantry): ${skippedPantry.join(", ")}`);
    }

    return {
      content: [{ type: "text" as const, text: parts.join("\n") }],
    };
  },
);

// ============================================================
// Start
// ============================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Smart Shopper MCP server v0.2.0 running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
