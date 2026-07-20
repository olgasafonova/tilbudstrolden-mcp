import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLocale } from "../locales.js";
import * as store from "../store.js";

export function registerTrackingTools(server: McpServer): void {
  server.tool(
    "log_meal",
    "Record a cooked meal for rotation tracking. USE WHEN: logging what was cooked to avoid repeating meals in future planning. Deduplicates by date + recipe name. Returns confirmation with date, recipe, and people logged.",
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
    "Recent meal history for rotation planning. USE WHEN: checking what was cooked recently to avoid repetition, reviewing eating patterns. Returns meal entries with dates, recipe names, and who ate.",
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

  server.tool(
    "log_spend",
    "Record grocery spending for budget tracking. USE WHEN: logging what was spent after a shopping trip. Returns confirmation with amount, store, date, and item count.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      store: z.string().describe("Store name, e.g. 'Netto' or 'Føtex'"),
      estimatedTotal: z.number().describe("Amount spent in local currency"),
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
      const household = await store.getHousehold();
      const sym = getLocale(household.country).currencySymbol;
      return {
        content: [
          {
            type: "text" as const,
            text: `Logged: ${estimatedTotal} ${sym} at ${storeName} on ${date} (${items} items).`,
          },
        ],
      };
    },
  );

  server.tool(
    "get_spend_log",
    "Spending history with weekly averages and totals. USE WHEN: reviewing grocery budget, tracking spending trends. Returns spending entries with totals and weekly averages.",
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
      const household = await store.getHousehold();
      const sym = getLocale(household.country).currencySymbol;
      const lines = log.map(
        (s) =>
          `- ${s.date}: ${s.estimatedTotal} ${sym} @ ${s.store} (${s.items} items)${s.notes ? ` - ${s.notes}` : ""}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Spending (last ${weeks} weeks):\n\n${lines.join("\n")}\n\nTotal: ${total.toFixed(0)} ${sym} | Avg/week: ${avgPerWeek.toFixed(0)} ${sym}`,
          },
        ],
      };
    },
  );
}
