/**
 * Unit tests for src/tools/shared.ts — the formatting and expiry helpers
 * every tool module depends on.
 *
 * Date-sensitive helpers run under fake timers so expiry boundaries are exact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Offer } from "../api.js";

vi.mock("../store.js", () => ({
  getHousehold: vi.fn(),
}));

const store = await import("../store.js");
const {
  daysUntilExpiry,
  errorResult,
  expiryTag,
  formatOffer,
  formatOfferList,
  getActiveLocale,
  getKnownStores,
} = await import("./shared.js");
const { getLocale } = await import("../locales.js");

const NOW = new Date("2026-06-15T12:00:00Z");

function makeOffer(overrides: Partial<Offer> = {}): Offer {
  return {
    id: "offer-1",
    heading: "Hakket oksekød 8-12%",
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("errorResult", () => {
  it("marks the result as an error and carries the message as text", () => {
    const result = errorResult("No preferred stores configured.");
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "No preferred stores configured." }]);
  });
});

describe("daysUntilExpiry", () => {
  it("returns a large sentinel when there is no expiry date", () => {
    expect(daysUntilExpiry(null)).toBe(999);
    expect(daysUntilExpiry(undefined)).toBe(999);
    expect(daysUntilExpiry("")).toBe(999);
  });

  it("rounds partial days up", () => {
    // 2.5 days out rounds to 3
    expect(daysUntilExpiry("2026-06-18T00:00:00Z")).toBe(3);
    // 12 hours out rounds to 1
    expect(daysUntilExpiry("2026-06-16T00:00:00Z")).toBe(1);
  });

  it("goes negative for dates already past", () => {
    expect(daysUntilExpiry("2026-06-14T00:00:00Z")).toBe(-1);
    expect(daysUntilExpiry("2026-06-01T00:00:00Z")).toBe(-14);
  });
});

describe("expiryTag", () => {
  it("returns nothing for deals more than two days out", () => {
    expect(expiryTag("2026-06-18T00:00:00Z")).toBe("");
    expect(expiryTag("2026-12-31T00:00:00Z")).toBe("");
    expect(expiryTag(null)).toBe("");
  });

  it("flags the two-day, one-day, and expired boundaries", () => {
    expect(expiryTag("2026-06-17T00:00:00Z")).toBe(" [EXPIRES TOMORROW]");
    expect(expiryTag("2026-06-16T00:00:00Z")).toBe(" [EXPIRES TODAY]");
    expect(expiryTag("2026-06-15T18:00:00Z")).toBe(" [EXPIRES TODAY]");
    expect(expiryTag("2026-06-14T00:00:00Z")).toBe(" [EXPIRED]");
  });
});

describe("formatOffer", () => {
  it("includes unit price and previous price when present", () => {
    const text = formatOffer(makeOffer({ prePrice: 60 }));
    expect(text).toBe(
      "Hakket oksekød 8-12% - 45 DKK (90.00 kr/kg) @ Netto was 60 DKK valid until 2026-06-30",
    );
  });

  it("omits unit price and previous price when absent", () => {
    const text = formatOffer(makeOffer({ pricePerUnit: null, prePrice: null }));
    expect(text).toBe("Hakket oksekød 8-12% - 45 DKK @ Netto valid until 2026-06-30");
  });

  it("appends the expiry tag for deals expiring soon", () => {
    const text = formatOffer(makeOffer({ validUntil: "2026-06-16T00:00:00Z" }));
    expect(text).toContain("valid until 2026-06-16 [EXPIRES TODAY]");
  });

  it("renders a missing expiry date as unknown", () => {
    const text = formatOffer(makeOffer({ validUntil: null as unknown as string }));
    expect(text).toContain("valid until unknown");
    expect(text).not.toContain("[EXPIR");
  });
});

describe("formatOfferList", () => {
  it("reports an empty list explicitly rather than returning an empty string", () => {
    expect(formatOfferList([])).toBe("No offers found.");
  });

  it("numbers offers from 1", () => {
    const text = formatOfferList([
      makeOffer({ heading: "First", pricePerUnit: null }),
      makeOffer({ heading: "Second", pricePerUnit: null }),
    ]);
    const lines = text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith("1. First - 45 DKK")).toBe(true);
    expect(lines[1].startsWith("2. Second - 45 DKK")).toBe(true);
  });
});

describe("getKnownStores", () => {
  it("returns the locale's known-store map", () => {
    const locale = getLocale("DK");
    expect(getKnownStores(locale)).toBe(locale.knownStores);
    expect(getKnownStores(locale).netto).toBeDefined();
  });
});

describe("getActiveLocale", () => {
  it("resolves the locale from the stored household country", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue({
      people: [],
      stores: [],
      defaultServings: 2,
      country: "SE",
    });
    const locale = await getActiveLocale();
    expect(locale.country).toBe("SE");
    expect(locale.currency).toBe("SEK");
  });

  it("falls back to DK when the stored country is unrecognised", async () => {
    vi.mocked(store.getHousehold).mockResolvedValue({
      people: [],
      stores: [],
      defaultServings: 2,
      country: "XX",
    });
    const locale = await getActiveLocale();
    expect(locale.country).toBe("DK");
  });
});
