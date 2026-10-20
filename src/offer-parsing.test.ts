/**
 * Unit tests for src/offer-parsing.ts — turning raw etilbudsavis.dk / Tjek
 * payloads into the Offer shape every tool consumes.
 *
 * parseOffer is the only export; the private helpers (currency symbol, unit
 * pricing, quantity and pricing readers, store fallback) are exercised through
 * it with one field varied per case.
 */

import { describe, expect, it } from "vitest";
import { parseOffer, type RawOffer } from "./offer-parsing.js";

type RawQuantity = RawOffer["quantity"];

function grams(from: number | null, symbol = "g"): RawQuantity {
  return {
    unit: { symbol, si: { symbol, factor: 1 } },
    size: { from, to: from },
    pieces: { from: 1, to: 1 },
  };
}

function makeRaw(overrides: Partial<RawOffer> = {}): RawOffer {
  return {
    id: "o1",
    heading: "Hakket oksekød 8-12%",
    description: "Dansk",
    pricing: { price: 45, pre_price: 60, currency: "DKK" },
    quantity: grams(500),
    branding: { name: "Netto" },
    dealer_id: "9ba51",
    dealer: { name: "Netto Danmark" },
    run_from: "2026-06-10T00:00:00+0200",
    run_till: "2026-06-16T23:59:59+0200",
    images: { view: "https://img.test/o1.jpg" },
    ...overrides,
  };
}

describe("parseOffer field mapping", () => {
  it("maps every raw field onto the Offer shape", () => {
    expect(parseOffer(makeRaw())).toEqual({
      id: "o1",
      heading: "Hakket oksekød 8-12%",
      description: "Dansk",
      price: 45,
      prePrice: 60,
      currency: "DKK",
      quantity: 500,
      unit: "g",
      pricePerUnit: "90.00 kr/kg",
      store: "Netto",
      storeId: "9ba51",
      validFrom: "2026-06-10T00:00:00+0200",
      validUntil: "2026-06-16T23:59:59+0200",
      imageUrl: "https://img.test/o1.jpg",
    });
  });

  it("nulls the image URL when images are missing", () => {
    expect(parseOffer(makeRaw({ images: null })).imageUrl).toBeNull();
    expect(parseOffer(makeRaw({ images: { view: null } })).imageUrl).toBeNull();
  });
});

describe("parseOffer store name", () => {
  it("prefers the branding name over the dealer name", () => {
    expect(parseOffer(makeRaw()).store).toBe("Netto");
  });

  it("falls back to the dealer name without branding", () => {
    expect(parseOffer(makeRaw({ branding: null })).store).toBe("Netto Danmark");
  });

  it("reports Unknown when neither branding nor dealer is present", () => {
    expect(parseOffer(makeRaw({ branding: null, dealer: null })).store).toBe("Unknown");
  });
});

describe("parseOffer pricing", () => {
  it("defaults to DKK when the pricing block is missing", () => {
    const raw = makeRaw({ pricing: undefined as unknown as RawOffer["pricing"] });
    const offer = parseOffer(raw);
    expect(offer.currency).toBe("DKK");
    expect(offer.price).toBeNull();
    expect(offer.prePrice).toBeNull();
    expect(offer.pricePerUnit).toBeNull();
  });

  it("leaves pricePerUnit null when the offer has no price", () => {
    const offer = parseOffer(
      makeRaw({ pricing: { price: null, pre_price: null, currency: "DKK" } }),
    );
    expect(offer.price).toBeNull();
    expect(offer.pricePerUnit).toBeNull();
  });

  it.each([
    ["DKK", "kr"],
    ["NOK", "kr"],
    ["SEK", "kr"],
    ["EUR", "€"],
  ])("shows %s as %s in the unit price", (currency, symbol) => {
    const offer = parseOffer(makeRaw({ pricing: { price: 45, pre_price: null, currency } }));
    expect(offer.currency).toBe(currency);
    expect(offer.pricePerUnit).toBe(`90.00 ${symbol}/kg`);
  });

  it("uses the ISO code itself for an unmapped currency", () => {
    const offer = parseOffer(makeRaw({ pricing: { price: 45, pre_price: null, currency: "ISK" } }));
    expect(offer.pricePerUnit).toBe("90.00 ISK/kg");
  });
});

/** Unit price for an offer at `price` DKK with the given quantity block. */
function unitPriceFor(price: number, quantity: RawQuantity): string | null {
  return parseOffer(makeRaw({ pricing: { price, pre_price: null, currency: "DKK" }, quantity }))
    .pricePerUnit;
}

const pieces = (n: number) => ({ from: n, to: n });

describe("parseOffer unit price", () => {
  it.each<[string, number, RawQuantity, string]>([
    ["converts a gram pack to a per-kg price", 45, grams(400), "112.50 kr/kg"],
    ["converts a millilitre pack to a per-litre price", 15, grams(750, "ml"), "20.00 kr/L"],
    ["converts an exactly 1000 g pack to a per-kg price", 50, grams(1000), "50.00 kr/kg"],
    ["converts a pack over 1000 g to a per-kg price", 60, grams(1500), "40.00 kr/kg"],
    ["converts an exactly 1000 ml pack to a per-litre price", 20, grams(1000, "ml"), "20.00 kr/L"],
    [
      "prices per the reported unit when it is a base retail unit",
      45,
      grams(2, "kg"),
      "22.50 kr/kg",
    ],
    ["rounds the unit price to two decimals", 10, grams(3, "l"), "3.33 kr/l"],
    [
      "prices per piece when there is no measured size",
      30,
      { unit: null, size: null, pieces: pieces(12) },
      "2.50 kr/pcs",
    ],
    [
      "falls back to pieces when the size is zero",
      30,
      { ...grams(0), pieces: pieces(6) },
      "5.00 kr/pcs",
    ],
    [
      "falls back to pieces when the unit symbol is empty",
      30,
      { ...grams(500, ""), pieces: pieces(3) },
      "10.00 kr/pcs",
    ],
  ])("%s", (_name, price, quantity, expected) => {
    expect(unitPriceFor(price, quantity)).toBe(expected);
  });

  it("keeps quantity and unit null for a piece-priced offer", () => {
    const offer = parseOffer(makeRaw({ quantity: { unit: null, size: null, pieces: pieces(12) } }));
    expect(offer.quantity).toBeNull();
    expect(offer.unit).toBeNull();
  });

  it("gives no unit price when neither size nor piece count is usable", () => {
    const offer = parseOffer(
      makeRaw({
        quantity: { unit: null, size: { from: null, to: null }, pieces: { from: 0, to: 0 } },
      }),
    );
    expect(offer.pricePerUnit).toBeNull();
  });

  it("tolerates a missing quantity block", () => {
    const offer = parseOffer(makeRaw({ quantity: undefined as unknown as RawQuantity }));
    expect(offer.quantity).toBeNull();
    expect(offer.unit).toBeNull();
    expect(offer.pricePerUnit).toBeNull();
  });
});
