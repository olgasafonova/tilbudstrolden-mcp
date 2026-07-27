/**
 * Unit tests for src/tools/household.ts — get_household, update_household,
 * update_pantry, get_pantry.
 *
 * The store layer is mocked so nothing touches ~/.tilbudstrolden.json.
 * The interesting logic here is country validation and the defaultSchedule
 * fill-in on update_household.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
import type { Household } from "../store.js";

vi.mock("../store.js", () => ({
  getHousehold: vi.fn(),
  updateHousehold: vi.fn(),
  getPantry: vi.fn(),
  updatePantry: vi.fn(),
}));

const store = await import("../store.js");
const { registerHouseholdTools } = await import("./household.js");

function makeHousehold(overrides: Partial<Household> = {}): Household {
  return {
    people: [],
    stores: [],
    defaultServings: 2,
    country: "DK",
    ...overrides,
  };
}

let stub: ServerStub;

beforeEach(() => {
  vi.clearAllMocks();
  stub = createServerStub();
  registerHouseholdTools(stub.server);
});

describe("registerHouseholdTools", () => {
  it("registers the four household and pantry tools", () => {
    expect([...stub.tools.keys()].sort()).toEqual([
      "get_household",
      "get_pantry",
      "update_household",
      "update_pantry",
    ]);
  });

  it("lists the supported countries in the update_household description", () => {
    const description = stub.tools.get("update_household")?.description ?? "";
    expect(description).toContain("DK, NO, SE, FI");
  });
});

describe("get_household", () => {
  it("returns three-step onboarding when nothing is configured", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
    const text = textOf(await callTool(stub, "get_household"));
    expect(text).toContain("No household configured yet");
    expect(text).toContain("update_household");
    expect(text).toContain("update_pantry");
    expect(text).toContain("add_recipe");
  });

  it("does not show onboarding once stores exist even with no people", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        stores: [{ name: "Netto", dealerId: "n1", priority: 1 }],
      }),
    );
    const text = textOf(await callTool(stub, "get_household"));
    expect(text).not.toContain("No household configured yet");
    expect(text).toContain("Household (DK market, default 2 servings)");
  });

  it("summarises dietary restrictions, home days, and store priority order", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        country: "NO",
        defaultServings: 4,
        people: [
          {
            name: "Olga",
            dietaryRestrictions: ["no pork", "lactose-free"],
            defaultSchedule: { monday: true, tuesday: false, wednesday: true },
          },
          { name: "Bo", dietaryRestrictions: [], defaultSchedule: {} },
        ],
        stores: [
          { name: "Rema 1000", dealerId: "r1", priority: 2 },
          { name: "Kiwi", dealerId: "k1", priority: 1 },
        ],
      }),
    );
    const text = textOf(await callTool(stub, "get_household"));
    expect(text).toContain("Household (NO market, default 4 servings)");
    expect(text).toContain("- Olga: dietary: no pork, lactose-free | home: monday, wednesday");
    expect(text).toContain("- Bo: dietary: none | home: all days");
    // Sorted by priority, so Kiwi (1) precedes Rema 1000 (2).
    expect(text.indexOf("1. Kiwi")).toBeLessThan(text.indexOf("2. Rema 1000"));
  });
});

describe("update_household", () => {
  beforeEach(() => {
    vi.mocked(store.updateHousehold).mockImplementation(async (updates) =>
      makeHousehold(updates as Partial<Household>),
    );
  });

  it("rejects an unsupported country without writing anything", async () => {
    const result = await callTool(stub, "update_household", { country: "US" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Invalid country code "US"');
    expect(textOf(result)).toContain("DK, NO, SE, FI");
    expect(store.updateHousehold).not.toHaveBeenCalled();
  });

  it("accepts a lowercase country code and normalises it to uppercase", async () => {
    await callTool(stub, "update_household", { country: "no" });
    expect(store.updateHousehold).toHaveBeenCalledWith({ country: "NO" });
  });

  it("fills every weekday as home by default, keeping explicit overrides", async () => {
    await callTool(stub, "update_household", {
      people: [
        {
          name: "Olga",
          dietaryRestrictions: ["vegetarian"],
          defaultSchedule: { wednesday: false },
        },
      ],
    });
    const updates = vi.mocked(store.updateHousehold).mock.calls[0][0];
    expect(updates.people?.[0].defaultSchedule).toEqual({
      monday: true,
      tuesday: true,
      wednesday: false,
      thursday: true,
      friday: true,
      saturday: true,
      sunday: true,
    });
    expect(updates.people?.[0].dietaryRestrictions).toEqual(["vegetarian"]);
  });

  it("passes stores and defaultServings through untouched", async () => {
    await callTool(stub, "update_household", {
      stores: [{ name: "Føtex", dealerId: "bdf5A", priority: 1 }],
      defaultServings: 3,
    });
    expect(store.updateHousehold).toHaveBeenCalledWith({
      stores: [{ name: "Føtex", dealerId: "bdf5A", priority: 1 }],
      defaultServings: 3,
    });
  });

  it("sends no updates at all when called with no arguments", async () => {
    await callTool(stub, "update_household", {});
    expect(store.updateHousehold).toHaveBeenCalledWith({});
  });

  it("reports the resulting counts", async () => {
    vi.mocked(store.updateHousehold).mockResolvedValue(
      makeHousehold({
        country: "SE",
        defaultServings: 4,
        people: [{ name: "A", dietaryRestrictions: [], defaultSchedule: {} }],
        stores: [
          { name: "Ica", dealerId: "i1", priority: 1 },
          { name: "Coop", dealerId: "c1", priority: 2 },
        ],
      }),
    );
    const text = textOf(await callTool(stub, "update_household", { country: "SE" }));
    expect(text).toBe("Household updated: SE market, 1 people, 2 stores, default 4 servings.");
  });

  it("rejects a malformed people entry", async () => {
    await expect(
      callTool(stub, "update_household", { people: [{ name: "Olga" }] }),
    ).rejects.toThrow();
    expect(store.updateHousehold).not.toHaveBeenCalled();
  });
});

describe("update_pantry", () => {
  it("defaults both add and remove to empty arrays", async () => {
    vi.mocked(store.updatePantry).mockResolvedValue([]);
    await callTool(stub, "update_pantry", {});
    expect(store.updatePantry).toHaveBeenCalledWith([], []);
  });

  it("forwards add and remove lists and echoes the resulting pantry", async () => {
    vi.mocked(store.updatePantry).mockResolvedValue(["olie", "salt"]);
    const text = textOf(
      await callTool(stub, "update_pantry", {
        add: ["salt", "olie"],
        remove: ["peber"],
      }),
    );
    expect(store.updatePantry).toHaveBeenCalledWith(["salt", "olie"], ["peber"]);
    expect(text).toBe("Pantry (2 items): olie, salt");
  });

  it("renders an emptied pantry explicitly", async () => {
    vi.mocked(store.updatePantry).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "update_pantry", { remove: ["salt"] }));
    expect(text).toBe("Pantry (0 items): (empty)");
  });
});

describe("get_pantry", () => {
  it("points at update_pantry when the pantry is empty", async () => {
    vi.mocked(store.getPantry).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "get_pantry"));
    expect(text).toContain("Pantry is empty");
    expect(text).toContain("update_pantry");
  });

  it("lists stocked items with a count", async () => {
    vi.mocked(store.getPantry).mockResolvedValue(["olie", "peber", "salt"]);
    const text = textOf(await callTool(stub, "get_pantry"));
    expect(text).toBe("Pantry (3 items): olie, peber, salt");
  });
});
