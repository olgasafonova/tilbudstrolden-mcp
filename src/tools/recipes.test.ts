/**
 * Unit tests for src/tools/recipes.ts — get_recipes, add_recipe, remove_recipe.
 *
 * The store layer is mocked so nothing touches ~/.tilbudstrolden.json.
 * Arguments are parsed through each tool's own zod schema before the handler
 * runs, so schema defaults and rejection of bad input are covered too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
import type { Recipe } from "../store.js";

vi.mock("../store.js", () => ({
  getRecipes: vi.fn(),
  addRecipe: vi.fn(),
  removeRecipe: vi.fn(),
}));

const store = await import("../store.js");
const { registerRecipeTools } = await import("./recipes.js");

function makeRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "Spaghetti Bolognese",
    servings: 4,
    complexity: "medium",
    cuisineType: "italian",
    proteinType: "beef",
    ingredients: [
      {
        name: "Hakket oksekød",
        quantity: "500g",
        searchTerms: ["hakket oksekød", "oksefars"],
        category: "meat",
      },
    ],
    ...overrides,
  };
}

let stub: ServerStub;

beforeEach(() => {
  vi.clearAllMocks();
  stub = createServerStub();
  registerRecipeTools(stub.server);
});

describe("registerRecipeTools", () => {
  it("registers the three recipe tools", () => {
    expect([...stub.tools.keys()].sort()).toEqual(["add_recipe", "get_recipes", "remove_recipe"]);
  });

  it("describes when to use each tool, not just what it does", () => {
    for (const tool of stub.tools.values()) {
      expect(tool.description, `${tool.name} description`).toMatch(/USE WHEN|TIP:/);
    }
  });
});

describe("get_recipes", () => {
  it("returns onboarding guidance when the library is empty", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "get_recipes"));
    expect(text).toContain("No recipes saved yet");
    expect(text).toContain("add_recipe");
  });

  it("renders name, servings, metadata tags, and ingredient search terms", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([makeRecipe()]);
    const text = textOf(await callTool(stub, "get_recipes"));
    expect(text).toContain("1 recipes:");
    expect(text).toContain("## Spaghetti Bolognese (4 servings) [medium] [italian] [beef]");
    expect(text).toContain("- Hakket oksekød: 500g [meat] (search: hakket oksekød, oksefars)");
  });

  it("separates multiple recipes with a blank line", async () => {
    vi.mocked(store.getRecipes).mockResolvedValue([
      makeRecipe({ name: "A", ingredients: [] }),
      makeRecipe({ name: "B", ingredients: [] }),
    ]);
    const text = textOf(await callTool(stub, "get_recipes"));
    expect(text).toContain("2 recipes:");
    expect(text).toContain("## A (4 servings)");
    expect(text).toContain("## B (4 servings)");
  });
});

describe("add_recipe", () => {
  const baseArgs = {
    name: "Kylling i karry",
    complexity: "quick",
    cuisineType: "danish",
    proteinType: "chicken",
    ingredients: [{ name: "Kyllingebryst", quantity: "600g" }],
  };

  it("defaults servings to 4 via the schema", async () => {
    await callTool(stub, "add_recipe", baseArgs);
    expect(vi.mocked(store.addRecipe).mock.calls[0][0].servings).toBe(4);
  });

  it("defaults searchTerms to the lowercased ingredient name and category to other", async () => {
    await callTool(stub, "add_recipe", baseArgs);
    const saved = vi.mocked(store.addRecipe).mock.calls[0][0];
    expect(saved.ingredients).toEqual([
      {
        name: "Kyllingebryst",
        quantity: "600g",
        searchTerms: ["kyllingebryst"],
        category: "other",
      },
    ]);
  });

  it("treats an explicitly empty searchTerms array as omitted", async () => {
    await callTool(stub, "add_recipe", {
      ...baseArgs,
      ingredients: [{ name: "Løg", quantity: "2 stk", searchTerms: [] }],
    });
    expect(vi.mocked(store.addRecipe).mock.calls[0][0].ingredients[0].searchTerms).toEqual(["løg"]);
  });

  it("preserves explicit searchTerms and category", async () => {
    await callTool(stub, "add_recipe", {
      ...baseArgs,
      servings: 2,
      ingredients: [
        {
          name: "Kyllingebryst",
          quantity: "600g",
          searchTerms: ["kylling", "kyllingefilet"],
          category: "meat",
        },
      ],
    });
    const saved = vi.mocked(store.addRecipe).mock.calls[0][0];
    expect(saved.servings).toBe(2);
    expect(saved.ingredients[0].searchTerms).toEqual(["kylling", "kyllingefilet"]);
    expect(saved.ingredients[0].category).toBe("meat");
  });

  it("confirms with the recipe metadata and ingredient count", async () => {
    const text = textOf(await callTool(stub, "add_recipe", baseArgs));
    expect(text).toBe('Recipe "Kylling i karry" saved: quick danish (chicken), 1 ingredients.');
  });

  it("rejects a complexity outside the allowed enum", async () => {
    await expect(
      callTool(stub, "add_recipe", { ...baseArgs, complexity: "instant" }),
    ).rejects.toThrow();
    expect(store.addRecipe).not.toHaveBeenCalled();
  });

  it("rejects an ingredient missing its quantity", async () => {
    await expect(
      callTool(stub, "add_recipe", {
        ...baseArgs,
        ingredients: [{ name: "Løg" }],
      }),
    ).rejects.toThrow();
    expect(store.addRecipe).not.toHaveBeenCalled();
  });

  it("rejects a missing recipe name", async () => {
    const { name: _dropped, ...noName } = baseArgs;
    await expect(callTool(stub, "add_recipe", noName)).rejects.toThrow();
    expect(store.addRecipe).not.toHaveBeenCalled();
  });
});

describe("remove_recipe", () => {
  it("confirms removal when the store reports a hit", async () => {
    vi.mocked(store.removeRecipe).mockResolvedValue(true);
    const text = textOf(await callTool(stub, "remove_recipe", { name: "Chili" }));
    expect(text).toBe('Recipe "Chili" removed.');
    expect(store.removeRecipe).toHaveBeenCalledWith("Chili");
  });

  it("reports not-found rather than pretending it removed something", async () => {
    vi.mocked(store.removeRecipe).mockResolvedValue(false);
    const text = textOf(await callTool(stub, "remove_recipe", { name: "Nope" }));
    expect(text).toBe('Recipe "Nope" not found.');
  });

  it("rejects a call with no name", async () => {
    await expect(callTool(stub, "remove_recipe", {})).rejects.toThrow();
  });
});
