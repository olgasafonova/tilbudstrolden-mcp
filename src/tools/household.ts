import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isValidCountry, SUPPORTED_COUNTRIES } from "../locales.js";
import * as store from "../store.js";
import { errorResult } from "./shared.js";

export function registerHouseholdTools(server: McpServer): void {
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
            text: `Household (${household.country} market, default ${household.defaultServings} servings):\n\nPeople:\n${people.join("\n")}\n\nStores (by priority):\n${stores.join("\n")}`,
          },
        ],
      };
    },
  );

  server.tool(
    "update_household",
    `Set household members, dietary restrictions, preferred stores, country, servings. USE WHEN: first-time setup or changing household config. Required before shopping lists can filter by preferred stores. TIP: use list_stores to find dealer IDs. Set country to change market: ${SUPPORTED_COUNTRIES.join(", ")}. Returns updated config summary: country, people count, store count, default servings.`,
    {
      country: z
        .string()
        .optional()
        .describe(
          `Country code: ${SUPPORTED_COUNTRIES.join(", ")}. Defaults to DK. Changes which stores and deals are shown.`,
        ),
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
    async ({ country, people, stores: storePrefs, defaultServings }) => {
      const updates: Partial<store.Household> = {};
      if (country) {
        if (!isValidCountry(country)) {
          return errorResult(
            `Invalid country code "${country}". Supported: ${SUPPORTED_COUNTRIES.join(", ")}`,
          );
        }
        updates.country = country.toUpperCase();
      }
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
            text: `Household updated: ${household.country} market, ${household.people.length} people, ${household.stores.length} stores, default ${household.defaultServings} servings.`,
          },
        ],
      };
    },
  );

  server.tool(
    "update_pantry",
    "Add or remove pantry items (excluded from shopping lists). USE WHEN: updating stock after shopping or noting staples you always have. Items are matched case-insensitively. Returns updated pantry item list.",
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
    "List pantry items (excluded from shopping lists). USE WHEN: checking what's already stocked before generating a shopping list. Returns list of pantry item names.",
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
}
