import type { Offer } from "../api.js";
import { getLocale, type Locale } from "../locales.js";
import * as store from "../store.js";

/** Return a structured MCP error result instead of throwing */
export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/** Get known stores for a locale, merging all country stores for lookup */
export function getKnownStores(locale: Locale): Record<string, string> {
  return locale.knownStores;
}

/** Which stores a deal search should cover, and whether they came from the household. */
export interface StoreScope {
  /** Store names for scoring; matched case-insensitively against offer.store */
  names: Set<string>;
  /** Dealer IDs to restrict the API search to */
  dealerIds: string[];
  /** True when the household has no stores and the locale's known chains stand in */
  usingDefaults: boolean;
}

/**
 * Resolve the stores to plan against. With none configured, fall back to the
 * locale's known national chains rather than every dealer in the country: an
 * unrestricted search optimises across ~300 DK dealers and returns 13-store
 * trips through catering wholesalers and border shops.
 */
export function resolveStoreScope(household: store.Household, locale: Locale): StoreScope {
  if (household.stores.length > 0) {
    return {
      names: new Set(household.stores.map((s) => s.name)),
      dealerIds: household.stores.map((s) => s.dealerId),
      usingDefaults: false,
    };
  }
  const known = getKnownStores(locale);
  return {
    // Every alias is kept as a name so "rema 1000" and "rema" both match offers.
    names: new Set(Object.keys(known)),
    dealerIds: [...new Set(Object.values(known))],
    usingDefaults: true,
  };
}

/** One-line note for plan output when the known-chain fallback was used. */
export function defaultStoresNote(locale: Locale): string {
  return `Planned across the main supermarket chains in ${locale.countryName} because no stores are set. Set your own with update_household (list_stores shows dealer IDs).`;
}

/** Get the active locale from household config */
export async function getActiveLocale(): Promise<Locale> {
  const household = await store.getHousehold();
  return getLocale(household.country);
}

/** Days until a deal expires. Negative means already expired. */
export function daysUntilExpiry(validUntil: string | null | undefined): number {
  if (!validUntil) return 999;
  const expiry = new Date(validUntil);
  const now = new Date();
  return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

/** Format expiry warning if deal expires within 2 days */
export function expiryTag(validUntil: string | null | undefined): string {
  const days = daysUntilExpiry(validUntil);
  if (days <= 0) return " [EXPIRED]";
  if (days <= 1) return " [EXPIRES TODAY]";
  if (days <= 2) return " [EXPIRES TOMORROW]";
  return "";
}

export function formatOffer(o: Offer): string {
  const parts = [`${o.heading} - ${o.price} ${o.currency}`];
  if (o.pricePerUnit) parts.push(`(${o.pricePerUnit})`);
  parts.push(`@ ${o.store}`);
  if (o.prePrice) parts.push(`was ${o.prePrice} ${o.currency}`);
  const validTo = o.validUntil?.slice(0, 10) ?? "unknown";
  parts.push(`valid until ${validTo}${expiryTag(o.validUntil)}`);
  return parts.join(" ");
}

export function formatOfferList(offers: Offer[]): string {
  if (offers.length === 0) return "No offers found.";
  return offers.map((o, i) => `${i + 1}. ${formatOffer(o)}`).join("\n");
}
