// Meal-plan widget client. Runs inside the host's sandboxed iframe, connects to
// the host over postMessage (MCP Apps), and renders the structured payload that
// the plan_and_shop tool attaches as `structuredContent`.

import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { MealPlanData, MealPlanDay } from "../../src/meal-plan.js";

const root = document.getElementById("root");

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showState(message: string): void {
  if (!root) return;
  root.replaceChildren();
  root.appendChild(el("p", "state", message));
}

function effortClass(complexity: string): string {
  if (
    complexity === "quick" ||
    complexity === "medium" ||
    complexity === "slow"
  ) {
    return complexity;
  }
  return "medium";
}

function renderCard(
  day: MealPlanDay,
  symbol: string,
  index: number,
): HTMLElement {
  const card = el("article", "card");
  card.style.setProperty("--i", String(index));

  const top = el("div", "card-top");
  top.appendChild(el("span", "day", `Day ${day.day}`));
  if (day.dealMatch) {
    top.appendChild(el("span", "deal-badge", "On deal"));
  }
  card.appendChild(top);

  card.appendChild(el("h2", "name", day.name));

  const tags = el("div", "tags");
  tags.appendChild(el("span", "tag", day.proteinType));
  tags.appendChild(el("span", "dot", "·"));
  tags.appendChild(el("span", "tag", day.cuisineType));
  card.appendChild(tags);

  const bottom = el("div", "card-bottom");
  bottom.appendChild(
    el("span", `effort ${effortClass(day.complexity)}`, day.complexity),
  );
  const cost = el("span", "cost", String(day.cost));
  cost.appendChild(el("span", undefined, ` ${symbol}`));
  bottom.appendChild(cost);
  card.appendChild(bottom);

  return card;
}

function render(data: MealPlanData): void {
  if (!root) return;
  if (!data.days || data.days.length === 0) {
    showState("No meal plan to display.");
    return;
  }

  root.replaceChildren();

  const header = el("header", "summary");
  header.appendChild(
    el(
      "h1",
      undefined,
      `${data.planDays}-day plan for ${data.householdSize} people`,
    ),
  );

  const metrics = el("div", "metrics");
  const basket = el("span", "metric");
  basket.append("Est. basket ");
  basket.appendChild(
    el("b", undefined, `${data.basketTotal} ${data.currencySymbol}`),
  );
  metrics.appendChild(basket);

  if (data.sharedSavings > 0) {
    const saving = el("span", "metric saving");
    saving.append("Shared savings ");
    saving.appendChild(
      el("b", undefined, `${data.sharedSavings} ${data.currencySymbol}`),
    );
    metrics.appendChild(saving);
  }
  header.appendChild(metrics);
  root.appendChild(header);

  const grid = el("div", "grid");
  data.days.forEach((day, i) => {
    grid.appendChild(renderCard(day, data.currencySymbol, i));
  });
  root.appendChild(grid);
}

/** Pull the structured meal-plan payload out of a tool result, if present. */
function extractPlan(result: CallToolResult | undefined): MealPlanData | null {
  const structured = result?.structuredContent as MealPlanData | undefined;
  if (structured && Array.isArray(structured.days)) return structured;
  return null;
}

function applyTheme(theme: "light" | "dark" | undefined): void {
  if (theme) {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

// Preview mode: `...#preview` renders sample data through the real render()
// path without a host, for local visual QA of the view layer. No effect in a
// real host launch (which never sets this hash).
const PREVIEW_DATA: MealPlanData = {
  planDays: 5,
  householdSize: 4,
  currency: "DKK",
  currencySymbol: "kr",
  basketTotal: 412,
  sharedSavings: 38,
  days: [
    {
      day: 1,
      name: "Kylling i karry",
      cost: 74,
      complexity: "quick",
      proteinType: "chicken",
      cuisineType: "danish",
      dealMatch: true,
    },
    {
      day: 2,
      name: "Spaghetti Bolognese",
      cost: 88,
      complexity: "medium",
      proteinType: "beef",
      cuisineType: "italian",
      dealMatch: false,
    },
    {
      day: 3,
      name: "Pad Thai",
      cost: 79,
      complexity: "quick",
      proteinType: "shrimp",
      cuisineType: "asian",
      dealMatch: true,
    },
    {
      day: 4,
      name: "Chili con carne",
      cost: 91,
      complexity: "slow",
      proteinType: "beef",
      cuisineType: "mexican",
      dealMatch: false,
    },
    {
      day: 5,
      name: "Laksefilet med ris",
      cost: 80,
      complexity: "quick",
      proteinType: "salmon",
      cuisineType: "danish",
      dealMatch: true,
    },
  ],
};

async function main(): Promise<void> {
  if (typeof window !== "undefined" && window.location.hash === "#preview") {
    render(PREVIEW_DATA);
    return;
  }

  const app = new App({ name: "meal-plan-widget", version: "1.0.0" });

  // Register handlers before connecting so no notification is missed.
  app.ontoolresult = (params) => {
    const plan = extractPlan(params as CallToolResult);
    if (plan) render(plan);
    else showState("This tool result has no meal-plan data.");
  };

  app.onhostcontextchanged = (ctx) => {
    applyTheme(ctx.theme);
  };

  await app.connect();

  applyTheme(app.getHostContext()?.theme);

  // The host may have delivered the result via toolInfo before we connected.
  const initial = app.getHostContext()?.toolInfo as
    { result?: CallToolResult } | undefined;
  const plan = extractPlan(initial?.result);
  if (plan) render(plan);
}

main().catch((err) => {
  console.error("Meal-plan widget failed to start:", err);
  showState("Could not load the meal plan.");
});
