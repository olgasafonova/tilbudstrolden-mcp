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
