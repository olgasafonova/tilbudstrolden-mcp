/**
 * Unit tests for src/tools/tracking.ts — log_meal, get_meal_history,
 * log_spend, get_spend_log.
 *
 * The store layer is mocked so nothing touches ~/.tilbudstrolden.json.
 * The currency symbol comes from the household country via the real locale
 * table, so the locale wiring is exercised rather than stubbed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
import type { Household, SpendLogEntry } from "../store.js";

vi.mock("../store.js", () => ({
  logMeal: vi.fn(),
  getMealHistory: vi.fn(),
  logSpend: vi.fn(),
  getSpendLog: vi.fn(),
  getHousehold: vi.fn(),
}));

const store = await import("../store.js");
const { registerTrackingTools } = await import("./tracking.js");

function makeHousehold(country = "DK"): Household {
  return { people: [], stores: [], defaultServings: 2, country };
}

function makeSpend(overrides: Partial<SpendLogEntry> = {}): SpendLogEntry {
  return {
    date: "2026-06-10",
    store: "Netto",
    estimatedTotal: 420,
    items: 17,
    notes: "",
    ...overrides,
  };
}

let stub: ServerStub;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  stub = createServerStub();
  registerTrackingTools(stub.server);
});

describe("registerTrackingTools", () => {
  it("registers the four tracking tools", () => {
    expect([...stub.tools.keys()].sort()).toEqual([
      "get_meal_history",
      "get_spend_log",
      "log_meal",
      "log_spend",
    ]);
  });
});

describe("log_meal", () => {
  it("persists the entry exactly as given and confirms it", async () => {
    const text = textOf(
      await callTool(stub, "log_meal", {
        date: "2026-06-14",
        recipe: "Chili con carne",
        people: ["Olga", "Bo"],
      }),
    );
    expect(store.logMeal).toHaveBeenCalledWith({
      date: "2026-06-14",
      recipe: "Chili con carne",
      people: ["Olga", "Bo"],
    });
    expect(text).toBe("Logged: Chili con carne on 2026-06-14 for Olga, Bo.");
  });

  it("rejects a call missing the people list", async () => {
    await expect(
      callTool(stub, "log_meal", { date: "2026-06-14", recipe: "Chili" }),
    ).rejects.toThrow();
    expect(store.logMeal).not.toHaveBeenCalled();
  });
});

describe("get_meal_history", () => {
  it("defaults the lookback to 4 weeks", async () => {
    vi.mocked(store.getMealHistory).mockResolvedValue([]);
    await callTool(stub, "get_meal_history", {});
    expect(store.getMealHistory).toHaveBeenCalledWith(4);
  });

  it("points at log_meal when nothing has been recorded", async () => {
    vi.mocked(store.getMealHistory).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "get_meal_history", {}));
    expect(text).toBe("No meal history yet. Use log_meal to start tracking.");
  });

  it("lists entries with date, recipe, and diners under a counted header", async () => {
    vi.mocked(store.getMealHistory).mockResolvedValue([
      { date: "2026-06-14", recipe: "Chili", people: ["Olga"] },
      { date: "2026-06-12", recipe: "Bolognese", people: ["Olga", "Bo"] },
    ]);
    const text = textOf(await callTool(stub, "get_meal_history", { weeks: 2 }));
    expect(store.getMealHistory).toHaveBeenCalledWith(2);
    expect(text).toContain("Meal history (last 2 weeks, 2 meals):");
    expect(text).toContain("- 2026-06-14: Chili (Olga)");
    expect(text).toContain("- 2026-06-12: Bolognese (Olga, Bo)");
  });
});

describe("log_spend", () => {
  it("persists the entry with an empty notes default", async () => {
    await callTool(stub, "log_spend", {
      date: "2026-06-14",
      store: "Føtex",
      estimatedTotal: 512,
      items: 23,
    });
    expect(store.logSpend).toHaveBeenCalledWith({
      date: "2026-06-14",
      store: "Føtex",
      estimatedTotal: 512,
      items: 23,
      notes: "",
    });
  });

  it("confirms using the household country's currency symbol", async () => {
    const text = textOf(
      await callTool(stub, "log_spend", {
        date: "2026-06-14",
        store: "Føtex",
        estimatedTotal: 512,
        items: 23,
      }),
    );
    expect(text).toBe("Logged: 512 kr at Føtex on 2026-06-14 (23 items).");
  });

  it("switches to the euro symbol for a Finnish household", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold("FI"));
    const text = textOf(
      await callTool(stub, "log_spend", {
        date: "2026-06-14",
        store: "K-Market",
        estimatedTotal: 68,
        items: 12,
      }),
    );
    expect(text).toBe("Logged: 68 € at K-Market on 2026-06-14 (12 items).");
  });

  it("rejects a non-numeric total", async () => {
    await expect(
      callTool(stub, "log_spend", {
        date: "2026-06-14",
        store: "Føtex",
        estimatedTotal: "512",
        items: 23,
      }),
    ).rejects.toThrow();
    expect(store.logSpend).not.toHaveBeenCalled();
  });
});

describe("get_spend_log", () => {
  it("defaults the lookback to 8 weeks", async () => {
    vi.mocked(store.getSpendLog).mockResolvedValue([]);
    await callTool(stub, "get_spend_log", {});
    expect(store.getSpendLog).toHaveBeenCalledWith(8);
  });

  it("points at log_spend when nothing has been recorded", async () => {
    vi.mocked(store.getSpendLog).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "get_spend_log", {}));
    expect(text).toBe("No spending recorded yet. Use log_spend to start tracking.");
  });

  it("totals spending and averages it over the requested window", async () => {
    vi.mocked(store.getSpendLog).mockResolvedValue([
      makeSpend({ date: "2026-06-14", estimatedTotal: 400 }),
      makeSpend({ date: "2026-06-07", estimatedTotal: 200 }),
    ]);
    const text = textOf(await callTool(stub, "get_spend_log", { weeks: 4 }));
    expect(store.getSpendLog).toHaveBeenCalledWith(4);
    expect(text).toContain("Spending (last 4 weeks):");
    // 600 over 4 weeks = 150/week
    expect(text).toContain("Total: 600 kr | Avg/week: 150 kr");
  });

  it("appends notes only when present", async () => {
    vi.mocked(store.getSpendLog).mockResolvedValue([
      makeSpend({ date: "2026-06-14", notes: "big shop" }),
      makeSpend({ date: "2026-06-07", notes: "" }),
    ]);
    const text = textOf(await callTool(stub, "get_spend_log", { weeks: 8 }));
    expect(text).toContain("- 2026-06-14: 420 kr @ Netto (17 items) - big shop");
    expect(text).toContain("- 2026-06-07: 420 kr @ Netto (17 items)\n");
  });
});
