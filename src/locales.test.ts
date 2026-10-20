/**
 * Unit tests for src/locales.ts — the country registry every tool resolves its
 * currency, store map, and matching vocabulary through.
 */

import { describe, expect, it } from "vitest";
import { type CountryCode, getLocale, isValidCountry, SUPPORTED_COUNTRIES } from "./locales.js";

const EXPECTED: Record<CountryCode, { currency: string; symbol: string; name: string }> = {
  DK: { currency: "DKK", symbol: "kr", name: "Denmark" },
  NO: { currency: "NOK", symbol: "kr", name: "Norway" },
  SE: { currency: "SEK", symbol: "kr", name: "Sweden" },
  FI: { currency: "EUR", symbol: "€", name: "Finland" },
};

describe("getLocale", () => {
  it.each(SUPPORTED_COUNTRIES)("returns the %s locale with its own currency", (code) => {
    const locale = getLocale(code);
    expect(locale.country).toBe(code);
    expect(locale.currency).toBe(EXPECTED[code].currency);
    expect(locale.currencySymbol).toBe(EXPECTED[code].symbol);
    expect(locale.countryName).toBe(EXPECTED[code].name);
  });

  it("accepts lower- and mixed-case country codes", () => {
    expect(getLocale("no").country).toBe("NO");
    expect(getLocale("sE").country).toBe("SE");
  });

  it("falls back to Denmark for an unknown country", () => {
    expect(getLocale("GB").country).toBe("DK");
    expect(getLocale("").country).toBe("DK");
  });

  it("does not resolve Object.prototype keys as locales", () => {
    expect(getLocale("constructor").country).toBe("DK");
    expect(getLocale("__proto__").country).toBe("DK");
  });

  it("gives every locale a non-empty store map with lowercase keys", () => {
    for (const code of SUPPORTED_COUNTRIES) {
      const stores = Object.keys(getLocale(code).knownStores);
      expect(stores.length, code).toBeGreaterThan(0);
      for (const name of stores) expect(name, `${code}: ${name}`).toBe(name.toLowerCase());
    }
  });

  it("keeps store aliases pointing at the same dealer", () => {
    const dk = getLocale("DK").knownStores;
    expect(dk.foetex).toBe(dk.føtex);
    expect(dk.rema).toBe(dk["rema 1000"]);
  });
});

describe("isValidCountry", () => {
  it.each(SUPPORTED_COUNTRIES)("accepts %s", (code) => {
    expect(isValidCountry(code)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isValidCountry("fi")).toBe(true);
  });

  it.each(["", "GB", "DE", "DKK", " DK"])("rejects %j", (code) => {
    expect(isValidCountry(code)).toBe(false);
  });

  it("rejects Object.prototype keys", () => {
    expect(isValidCountry("constructor")).toBe(false);
    expect(isValidCountry("toString")).toBe(false);
    expect(isValidCountry("__proto__")).toBe(false);
  });
});
