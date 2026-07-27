/**
 * Unit tests for src/tools/deals.ts — search_deals, get_store_offers,
 * list_stores, deals_this_week.
 *
 * The api and store layers are mocked; the locale tables are real, so the
 * store-alias collapsing and dealer-ID resolution are tested against the
 * actual DK/NO known-store data rather than a stub.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTool, createServerStub, type ServerStub, textOf } from "../../test/mcp-harness.js";
import type { Dealer, Offer } from "../api.js";
import type { Household } from "../store.js";

vi.mock("../api.js", () => ({
  searchDeals: vi.fn(),
  getStoreOffers: vi.fn(),
  listStores: vi.fn(),
}));

vi.mock("../store.js", () => ({
  getHousehold: vi.fn(),
}));

const api = await import("../api.js");
const store = await import("../store.js");
const { registerDealTools } = await import("./deals.js");

const NOW = new Date("2026-06-15T12:00:00Z");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer-1",
    heading: "Hakket oksekød",
    description: null,
    price: 45,
    prePrice: null,
    currency: "DKK",
    quantity: 500,
    unit: "g",
    pricePerUnit: "90.00 kr/kg",
    store: "Netto",
    storeId: "netto-id",
    validFrom: "2026-06-10",
    validUntil: "2026-06-30T00:00:00Z",
    imageUrl: null,
    ...overrides,
  };
}

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
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold());
  stub = createServerStub();
  registerDealTools(stub.server);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registerDealTools", () => {
  it("registers the four deal tools", () => {
    expect([...stub.tools.keys()].sort()).toEqual([
      "deals_this_week",
      "get_store_offers",
      "list_stores",
      "search_deals",
    ]);
  });

  it("tells the model when not to use each tool", () => {
    for (const tool of stub.tools.values()) {
      expect(tool.description, `${tool.name} description`).toContain("USE WHEN");
      expect(tool.description, `${tool.name} description`).toMatch(/NOT FOR|Requires/);
    }
  });
});

describe("search_deals", () => {
  it("trims the query and passes the household country through", async () => {
    vi.mocked(api.searchDeals).mockResolvedValue([makeOffer()]);
    vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold({ country: "SE" }));
    await callTool(stub, "search_deals", { query: "  köttfärs  " });
    expect(api.searchDeals).toHaveBeenCalledWith("köttfärs", 20, "SE");
  });

  it("defaults the limit to 20 via the schema", async () => {
    vi.mocked(api.searchDeals).mockResolvedValue([]);
    await callTool(stub, "search_deals", { query: "mælk" });
    expect(api.searchDeals).toHaveBeenCalledWith("mælk", 20, "DK");
  });

  it("honours an explicit limit", async () => {
    vi.mocked(api.searchDeals).mockResolvedValue([]);
    await callTool(stub, "search_deals", { query: "mælk", limit: 5 });
    expect(api.searchDeals).toHaveBeenCalledWith("mælk", 5, "DK");
  });

  it("reports the hit count using the untrimmed query in the header", async () => {
    vi.mocked(api.searchDeals).mockResolvedValue([makeOffer(), makeOffer({ id: "offer-2" })]);
    const text = textOf(await callTool(stub, "search_deals", { query: "oksekød" }));
    expect(text).toContain('Found 2 deals for "oksekød"');
    expect(text).toContain("1. Hakket oksekød - 45 DKK");
  });

  it("says so explicitly when there are no hits", async () => {
    vi.mocked(api.searchDeals).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "search_deals", { query: "enhjørning" }));
    expect(text).toContain('Found 0 deals for "enhjørning"');
    expect(text).toContain("No offers found.");
  });

  it("returns a structured error instead of throwing when the API fails", async () => {
    vi.mocked(api.searchDeals).mockRejectedValue(new Error("API request failed (503)"));
    const result = await callTool(stub, "search_deals", { query: "mælk" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to search deals: API request failed (503)");
  });

  it("still reports something useful when a non-Error value is thrown", async () => {
    vi.mocked(api.searchDeals).mockRejectedValue("socket hang up");
    const result = await callTool(stub, "search_deals", { query: "mælk" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to search deals: socket hang up");
  });

  it("rejects a call with no query", async () => {
    await expect(callTool(stub, "search_deals", {})).rejects.toThrow();
  });
});

describe("get_store_offers", () => {
  it("resolves a known store name to its dealer ID, case-insensitively", async () => {
    vi.mocked(api.getStoreOffers).mockResolvedValue([]);
    await callTool(stub, "get_store_offers", { store: "  Føtex " });
    // "føtex" is a known DK store; the raw name must not reach the API.
    const dealerId = vi.mocked(api.getStoreOffers).mock.calls[0][0];
    expect(dealerId).not.toBe("Føtex");
    expect(dealerId).toBe("bdf5A");
  });

  it("passes an unrecognised value through as a raw dealer ID", async () => {
    vi.mocked(api.getStoreOffers).mockResolvedValue([]);
    await callTool(stub, "get_store_offers", { store: "abc123", limit: 10 });
    expect(api.getStoreOffers).toHaveBeenCalledWith("abc123", 10);
  });

  it("defaults the limit to 50 via the schema", async () => {
    vi.mocked(api.getStoreOffers).mockResolvedValue([]);
    await callTool(stub, "get_store_offers", { store: "abc123" });
    expect(api.getStoreOffers).toHaveBeenCalledWith("abc123", 50);
  });

  it("titles the response with the store name reported by the offers", async () => {
    vi.mocked(api.getStoreOffers).mockResolvedValue([makeOffer({ store: "Føtex" })]);
    const text = textOf(await callTool(stub, "get_store_offers", { store: "bdf5A" }));
    expect(text).toContain("1 current offers at Føtex:");
  });

  it("falls back to the requested name when no offers come back", async () => {
    vi.mocked(api.getStoreOffers).mockResolvedValue([]);
    const text = textOf(await callTool(stub, "get_store_offers", { store: "abc123" }));
    expect(text).toContain("0 current offers at abc123:");
    expect(text).toContain("No offers found.");
  });

  it("returns a structured error when the API fails", async () => {
    vi.mocked(api.getStoreOffers).mockRejectedValue(new Error("timeout"));
    const result = await callTool(stub, "get_store_offers", { store: "netto" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to get store offers: timeout");
  });
});

describe("list_stores", () => {
  it("collapses aliases to the longest name by default", async () => {
    const text = textOf(await callTool(stub, "list_stores", {}));
    // DK has 13 known-store keys mapping to 9 distinct dealer IDs.
    expect(text).toContain("9 grocery stores:");
    // rema / rema 1000 / rema1000 all share one ID; the longest name wins.
    expect(text).toContain("- rema 1000 (id: 11deC)");
    expect(text).not.toContain("- rema (id:");
    expect(text).not.toContain("- rema1000 (id:");
    // foetex / føtex share an ID; "foetex" is longer.
    expect(text).toContain("- foetex (id: bdf5A)");
    expect(text).not.toContain("- føtex (id:");
    // 365 / 365discount share an ID.
    expect(text).toContain("- 365discount (id: DWZE1w)");
  });

  it("emits one line per store with no duplicate dealer IDs", async () => {
    const lines = textOf(await callTool(stub, "list_stores", {}))
      .split("\n")
      .filter((l) => l.startsWith("- "));
    const ids = lines.map((l) => l.match(/\(id: (.+)\)$/)?.[1]);
    expect(lines).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
  });

  it("filters by a case-insensitive name fragment", async () => {
    const text = textOf(await callTool(stub, "list_stores", { query: "REMA" }));
    expect(text).toContain("1 grocery stores:");
    expect(text).toContain("- rema 1000 (id: 11deC)");
    expect(text).not.toContain("netto");
  });

  it("returns a zero count rather than an empty body for a no-match filter", async () => {
    const text = textOf(await callTool(stub, "list_stores", { query: "tesco" }));
    expect(text).toContain("0 grocery stores:");
  });

  it("fetches the full upstream directory for DK when all is true", async () => {
    vi.mocked(api.listStores).mockResolvedValue([
      {
        id: "b2",
        name: "Bilka",
        website: "https://bilka.dk",
        logoUrl: null,
        country: "DK",
      },
      { id: "a1", name: "Aldi", website: null, logoUrl: null, country: "DK" },
    ] satisfies Dealer[]);
    const text = textOf(await callTool(stub, "list_stores", { all: true }));
    expect(api.listStores).toHaveBeenCalledWith("DK");
    expect(text).toContain("2 stores:");
    // Sorted alphabetically, and the website is appended when present.
    expect(text.indexOf("- Aldi (id: a1)")).toBeLessThan(text.indexOf("- Bilka (id: b2)"));
    expect(text).toContain("- Bilka (id: b2) https://bilka.dk");
    expect(text).toContain("- Aldi (id: a1)\n");
  });

  it("filters the full DK directory by name too", async () => {
    vi.mocked(api.listStores).mockResolvedValue([
      { id: "b2", name: "Bilka", website: null, logoUrl: null, country: "DK" },
      { id: "a1", name: "Aldi", website: null, logoUrl: null, country: "DK" },
    ] satisfies Dealer[]);
    const text = textOf(await callTool(stub, "list_stores", { all: true, query: "bil" }));
    expect(text).toContain("1 stores:");
    expect(text).toContain("- Bilka (id: b2)");
  });

  it("uses the curated list plus a caveat for non-DK countries when all is true", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(makeHousehold({ country: "NO" }));
    const text = textOf(await callTool(stub, "list_stores", { all: true }));
    // NO has 12 known-store keys mapping to 11 distinct dealer IDs.
    expect(text).toContain("11 known Norway grocery stores:");
    expect(text).toContain("Full store directory is only available for Denmark");
    expect(api.listStores).not.toHaveBeenCalled();
  });

  it("returns a structured error when the directory fetch fails", async () => {
    vi.mocked(api.listStores).mockRejectedValue(new Error("502"));
    const result = await callTool(stub, "list_stores", { all: true });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to list stores: 502");
  });
});

describe("deals_this_week", () => {
  const twoStores: Household = makeHousehold({
    stores: [
      { name: "Føtex", dealerId: "f1", priority: 2 },
      { name: "Netto", dealerId: "n1", priority: 1 },
    ],
  });

  it("refuses to guess when no preferred stores are configured", async () => {
    const result = await callTool(stub, "deals_this_week", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("No preferred stores configured");
    expect(textOf(result)).toContain("update_household");
    expect(textOf(result)).toContain("list_stores");
  });

  it("queries preferred stores in priority order with the default limit", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue({ ...twoStores });
    vi.mocked(api.getStoreOffers).mockResolvedValue([]);
    await callTool(stub, "deals_this_week", {});
    expect(vi.mocked(api.getStoreOffers).mock.calls).toEqual([
      ["n1", 30],
      ["f1", 30],
    ]);
  });

  it("flags deals expiring within two days in their own section", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        stores: [{ name: "Netto", dealerId: "n1", priority: 1 }],
      }),
    );
    vi.mocked(api.getStoreOffers).mockResolvedValue([
      makeOffer({
        id: "a",
        heading: "Mælk",
        validUntil: "2026-06-16T00:00:00Z",
      }),
      makeOffer({
        id: "b",
        heading: "Rugbrød",
        validUntil: "2026-06-30T00:00:00Z",
      }),
    ]);
    const text = textOf(await callTool(stub, "deals_this_week", {}));
    expect(text).toContain("## Netto (2 offers)");
    expect(text).toContain("⏰ Expiring soon (1):");
    // Only the soon-to-expire offer belongs in that section.
    const sectionStart = text.indexOf("⏰ Expiring soon");
    const sectionEnd = text.indexOf("Best savings:");
    const expiringSection = text.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
    expect(expiringSection).toContain("Mælk - 45 DKK");
    expect(expiringSection).not.toContain("Rugbrød");
  });

  it("ranks the best savings by absolute discount and skips offers without one", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        stores: [{ name: "Netto", dealerId: "n1", priority: 1 }],
      }),
    );
    vi.mocked(api.getStoreOffers).mockResolvedValue([
      makeOffer({ id: "a", heading: "Small saving", price: 18, prePrice: 20 }),
      makeOffer({ id: "b", heading: "Big saving", price: 50, prePrice: 90 }),
      makeOffer({ id: "c", heading: "No prePrice", price: 30, prePrice: null }),
      makeOffer({ id: "d", heading: "Price went up", price: 40, prePrice: 30 }),
    ]);
    const text = textOf(await callTool(stub, "deals_this_week", {}));
    expect(text).toContain("Best savings:");
    expect(text).toContain("- Big saving: 50 DKK (save 40 DKK)");
    expect(text).toContain("- Small saving: 18 DKK (save 2 DKK)");
    expect(text.indexOf("Big saving")).toBeLessThan(text.indexOf("Small saving"));
    expect(text).not.toContain("- No prePrice:");
    expect(text).not.toContain("- Price went up:");
  });

  it("falls back to the locale currency when an offer carries none", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue(
      makeHousehold({
        country: "FI",
        stores: [{ name: "K-Market", dealerId: "k1", priority: 1 }],
      }),
    );
    vi.mocked(api.getStoreOffers).mockResolvedValue([
      makeOffer({ heading: "Jauheliha", price: 5, prePrice: 8, currency: "" }),
    ]);
    const text = textOf(await callTool(stub, "deals_this_week", {}));
    expect(text).toContain("- Jauheliha: 5 EUR (save 3 EUR)");
  });

  it("reports a single store's failure without failing the whole roll-up", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue({ ...twoStores });
    vi.mocked(api.getStoreOffers).mockImplementation(async (dealerId: string) => {
      if (dealerId === "f1") throw new Error("upstream down");
      return [makeOffer({ heading: "Mælk" })];
    });
    const text = textOf(await callTool(stub, "deals_this_week", {}));
    expect(text).toContain("# Deals this week from 2 preferred stores");
    expect(text).toContain("## Føtex: failed to fetch offers");
    expect(text).toContain("## Netto (1 offers)");
  });

  it("returns a structured error when the household lookup itself fails", async () => {
    vi.mocked(store.getHousehold).mockRejectedValue(new Error("disk error"));
    const result = await callTool(stub, "deals_this_week", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to fetch deals: disk error");
  });
});
