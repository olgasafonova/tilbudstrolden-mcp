import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getLocale } from "../locales.js";
import * as store from "../store.js";

/** The currency symbol configured for the household's country */
async function householdCurrencySymbol(): Promise<string> {
  const household = await store.getHousehold();
  return getLocale(household.country).currencySymbol;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

interface LogMealArgs {
  date: string;
  recipe: string;
  people: string[];
}

async function handleLogMeal({ date, recipe, people }: LogMealArgs) {
  await store.logMeal({ date, recipe, people });
  return textResult(`Logged: ${recipe} on ${date} for ${people.join(", ")}.`);
}

async function handleGetMealHistory({ weeks }: { weeks: number }) {
  const history = await store.getMealHistory(weeks);
  if (history.length === 0) {
    return textResult("No meal history yet. Use log_meal to start tracking.");
  }
  const lines = history.map((m) => `- ${m.date}: ${m.recipe} (${m.people.join(", ")})`);
  return textResult(
    `Meal history (last ${weeks} weeks, ${history.length} meals):\n\n${lines.join("\n")}`,
  );
}

interface LogSpendArgs {
  date: string;
  store: string;
  estimatedTotal: number;
  items: number;
  notes: string;
}

async function handleLogSpend({
  date,
  store: storeName,
  estimatedTotal,
  items,
  notes,
}: LogSpendArgs) {
  await store.logSpend({
    date,
    store: storeName,
    estimatedTotal,
    items,
    notes,
  });
  const sym = await householdCurrencySymbol();
  return textResult(
    `Logged: ${estimatedTotal} ${sym} at ${storeName} on ${date} (${items} items).`,
  );
}

async function handleGetSpendLog({ weeks }: { weeks: number }) {
  const log = await store.getSpendLog(weeks);
  if (log.length === 0) {
    return textResult("No spending recorded yet. Use log_spend to start tracking.");
  }
  const total = log.reduce((sum, s) => sum + s.estimatedTotal, 0);
  const avgPerWeek = total / weeks;
  const sym = await householdCurrencySymbol();
  const lines = log.map(
    (s) =>
      `- ${s.date}: ${s.estimatedTotal} ${sym} @ ${s.store} (${s.items} items)${s.notes ? ` - ${s.notes}` : ""}`,
  );
  return textResult(
    `Spending (last ${weeks} weeks):\n\n${lines.join("\n")}\n\nTotal: ${total.toFixed(0)} ${sym} | Avg/week: ${avgPerWeek.toFixed(0)} ${sym}`,
  );
}

export function registerTrackingTools(server: McpServer): void {
  server.tool(
    "log_meal",
    "Record a cooked meal for rotation tracking. USE WHEN: logging what was cooked to avoid repeating meals in future planning. Deduplicates by date + recipe name. Returns confirmation with date, recipe, and people logged.",
    {
      date: z.string().describe("YYYY-MM-DD"),
      recipe: z.string().describe("Recipe name"),
      people: z.array(z.string()).describe("Who ate"),
    },
    handleLogMeal,
  );

  server.tool(
    "get_meal_history",
    "Recent meal history for rotation planning. USE WHEN: checking what was cooked recently to avoid repetition, reviewing eating patterns. Returns meal entries with dates, recipe names, and who ate.",
    {
      weeks: z.number().optional().default(4).describe("Weeks back (default 4)"),
    },
    handleGetMealHistory,
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
    handleLogSpend,
  );

  server.tool(
    "get_spend_log",
    "Spending history with weekly averages and totals. USE WHEN: reviewing grocery budget, tracking spending trends. Returns spending entries with totals and weekly averages.",
    {
      weeks: z.number().optional().default(8).describe("Weeks back (default 8)"),
    },
    handleGetSpendLog,
  );
}
