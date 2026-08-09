import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as store from "../store.js";

const NO_RECIPES_TEXT = `No recipes saved yet. Add recipes with add_recipe to get started.

TIP: Only name, servings, complexity, cuisineType, proteinType, and ingredient names/quantities are required. searchTerms and category are optional and will be inferred.

Example: add_recipe with name "Spaghetti Bolognese", complexity "medium", cuisineType "italian", proteinType "beef", and ingredients like {name: "Hakket oksekød", quantity: "500g"}.`;

function formatRecipe(r: store.Recipe): string {
  const meta = `[${r.complexity}] [${r.cuisineType}] [${r.proteinType}]`;
  const ingredients = r.ingredients
    .map(
      (ing) =>
        `  - ${ing.name}: ${ing.quantity} [${ing.category}] (search: ${ing.searchTerms.join(", ")})`,
    )
    .join("\n");
  return `## ${r.name} (${r.servings} servings) ${meta}\n${ingredients}`;
}

async function handleGetRecipes() {
  const recipes = await store.getRecipes();
  const text =
    recipes.length === 0
      ? NO_RECIPES_TEXT
      : `${recipes.length} recipes:\n\n${recipes.map(formatRecipe).join("\n\n")}`;
  return {
    content: [{ type: "text" as const, text }],
  };
}

interface AddRecipeArgs {
  name: string;
  servings: number;
  complexity: "quick" | "medium" | "slow";
  cuisineType: string;
  proteinType: string;
  ingredients: Array<{
    name: string;
    quantity: string;
    searchTerms?: string[];
    category?: string;
  }>;
}

async function handleAddRecipe({
  name,
  servings,
  complexity,
  cuisineType,
  proteinType,
  ingredients,
}: AddRecipeArgs) {
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
}

async function handleRemoveRecipe({ name }: { name: string }) {
  const removed = await store.removeRecipe(name);
  return {
    content: [
      {
        type: "text" as const,
        text: removed ? `Recipe "${name}" removed.` : `Recipe "${name}" not found.`,
      },
    ],
  };
}

export function registerRecipeTools(server: McpServer): void {
  server.tool(
    "get_recipes",
    "List saved recipes with ingredients, metadata, and search terms. USE WHEN: reviewing recipe library, checking what's available for meal planning. Returns onboarding guidance if no recipes exist yet.",
    {},
    handleGetRecipes,
  );

  server.tool(
    "add_recipe",
    "Add or update a recipe for meal planning and deal scoring. USE WHEN: saving a new recipe or updating an existing one. TIP: searchTerms defaults to [ingredient name] and category defaults to 'other' if omitted, reducing input friction. Overwrites existing recipe with same name. Returns confirmation with recipe name, complexity, cuisine, protein, and ingredient count.",
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
              .describe(
                "meat|dairy|produce|bakery|frozen|pantry|drinks|other. Defaults to 'other'.",
              ),
          }),
        )
        .describe("Ingredients"),
    },
    handleAddRecipe,
  );

  server.tool(
    "remove_recipe",
    "Remove a recipe by name. USE WHEN: cleaning up the recipe library. Case-insensitive name matching. Returns confirmation or 'not found' message.",
    {
      name: z.string().describe("Recipe name"),
    },
    handleRemoveRecipe,
  );
}
