// etilbudsavis.dk / Tjek API client

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const BASE_URL = "https://api.etilbudsavis.dk/v2";
const USER_AGENT = `tilbudstrolden-mcp/${version}`;
const FETCH_TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const MAX_CONCURRENT = 4;

export interface Offer {
  id: string;
  heading: string;
  description: string | null;
  price: number | null;
  prePrice: number | null;
  currency: string;
  quantity: number | null;
  unit: string | null;
  pricePerUnit: string | null;
  store: string;
  storeId: string;
  validFrom: string;
  validUntil: string;
  imageUrl: string | null;
}

export interface Dealer {
  id: string;
  name: string;
  website: string | null;
  logoUrl: string | null;
  country: string;
}

interface RawOffer {
  id: string;
  heading: string;
  description: string | null;
  pricing: { price: number | null; pre_price: number | null; currency: string };
  quantity: {
    unit: { symbol: string; si: { symbol: string; factor: number } } | null;
    size: { from: number | null; to: number | null } | null;
    pieces: { from: number | null; to: number | null } | null;
  };
  branding: { name: string } | null;
  dealer_id: string;
  dealer: { name: string } | null;
  run_from: string;
  run_till: string;
  images: { view: string | null } | null;
}

/** Extended raw offer with optional dealer country (present in some API responses) */
interface RawOfferWithCountry extends RawOffer {
  dealer: { name: string; country?: { id: string } } | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  DKK: "kr",
  NOK: "kr",
  SEK: "kr",
  EUR: "€",
};

function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOLS[currency] ?? currency;
}

// Units that are reported per gram/ml but should be displayed per kg/L.
const KILO_UNIT_CONVERSIONS: Record<
  string,
  { factor: number; suffix: string }
> = {
  g: { factor: 1000, suffix: "kg" },
  ml: { factor: 1000, suffix: "L" },
};

function unitPricePerUnit(
  price: number,
  qty: number,
  unitSymbol: string,
  sym: string,
): string {
  const conv = KILO_UNIT_CONVERSIONS[unitSymbol];
  if (conv && qty < conv.factor) {
    return `${((price / qty) * conv.factor).toFixed(2)} ${sym}/${conv.suffix}`;
  }
  return `${(price / qty).toFixed(2)} ${sym}/${unitSymbol}`;
}

interface QuantityFields {
  quantity: number | null;
  unit: string | null;
  pieces: number | null;
}

function readQuantityFields(raw: RawOffer): QuantityFields {
  return {
    quantity: raw.quantity?.size?.from ?? null,
    unit: raw.quantity?.unit?.symbol ?? null,
    pieces: raw.quantity?.pieces?.from ?? null,
  };
}

interface PricingFields {
  price: number | null;
  prePrice: number | null;
  currency: string;
  sym: string;
}

function readPricingFields(raw: RawOffer): PricingFields {
  const currency = raw.pricing?.currency ?? "DKK";
  return {
    price: raw.pricing?.price ?? null,
    prePrice: raw.pricing?.pre_price ?? null,
    currency,
    sym: currencySymbol(currency),
  };
}

function readStore(raw: RawOffer): string {
  return raw.branding?.name ?? raw.dealer?.name ?? "Unknown";
}

function computePricePerUnit(
  price: number,
  q: QuantityFields,
  sym: string,
): string | null {
  if (q.quantity !== null && q.quantity > 0 && q.unit) {
    return unitPricePerUnit(price, q.quantity, q.unit, sym);
  }
  // Pieces-based pricing (e.g. eggs sold per piece)
  if (q.pieces !== null && q.pieces > 0) {
    return `${(price / q.pieces).toFixed(2)} ${sym}/pcs`;
  }
  return null;
}

function parseOffer(raw: RawOffer): Offer {
  const pricing = readPricingFields(raw);
  const q = readQuantityFields(raw);
  const pricePerUnit =
    pricing.price !== null
      ? computePricePerUnit(pricing.price, q, pricing.sym)
      : null;

  return {
    id: raw.id,
    heading: raw.heading,
    description: raw.description,
    price: pricing.price,
    prePrice: pricing.prePrice,
    currency: pricing.currency,
    quantity: q.quantity,
    unit: q.unit,
    pricePerUnit,
    store: readStore(raw),
    storeId: raw.dealer_id,
    validFrom: raw.run_from,
    validUntil: raw.run_till,
    imageUrl: raw.images?.view ?? null,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": USER_AGENT },
      });

      if (res.status === 429 || res.status >= 500) {
        const delay = RETRY_BASE_MS * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        lastError = new Error(`API returned ${res.status}`);
        continue;
      }

      if (!res.ok) {
        throw new Error(`API request failed (${res.status})`);
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_BASE_MS * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("API request failed after retries");
}

// Simple concurrency limiter for batch operations
async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: (T | undefined)[] = new Array(tasks.length);
  const executing: Set<Promise<void>> = new Set();

  for (let i = 0; i < tasks.length; i++) {
    const idx = i;
    const p = tasks[idx]().then((result) => {
      results[idx] = result;
    });
    const tracked = p.finally(() => executing.delete(tracked));
    executing.add(tracked);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results as T[];
}

// --- Country-based store filter ---

const dealerCacheByCountry = new Map<string, Set<string>>();

/** Fetch and cache dealer IDs for a country (used for DK where /dealers works). */
export async function getDealerIds(countryId = "DK"): Promise<Set<string>> {
  const cached = dealerCacheByCountry.get(countryId);
  if (cached) return cached;
  const dealers = await listStores(countryId);
  const ids = new Set(dealers.map((d) => d.id));
  dealerCacheByCountry.set(countryId, ids);
  return ids;
}

/** @deprecated Use getDealerIds() instead */
export async function getDanishDealerIds(): Promise<Set<string>> {
  return getDealerIds("DK");
}

/** Clear the dealer cache (for testing). */
export function clearDealerCache(): void {
  dealerCacheByCountry.clear();
}

export async function searchDeals(
  query: string,
  limit = 20,
  countryId = "DK",
): Promise<Offer[]> {
  // Request extra to compensate for filtering non-matching results
  const params = new URLSearchParams({
    query,
    limit: String(limit * 3),
    country_id: countryId,
  });
  const raw = await fetchJson<RawOffer[]>(
    `${BASE_URL}/offers/search?${params}`,
  );

  if (countryId === "DK") {
    // DK: /dealers endpoint works, use allow-list for best accuracy
    const dealerIds = await getDealerIds("DK");
    return raw
      .map(parseOffer)
      .filter((o) => dealerIds.has(o.storeId))
      .slice(0, limit);
  }

  // NO/SE/FI: /dealers endpoint ignores country_id, so filter by dealer.country
  // from the raw response instead
  return raw
    .filter((o) => {
      const dc = (o as RawOfferWithCountry).dealer?.country?.id;
      return !dc || dc === countryId;
    })
    .map(parseOffer)
    .slice(0, limit);
}

export async function getStoreOffers(
  dealerId: string,
  limit = 50,
): Promise<Offer[]> {
  const params = new URLSearchParams({
    dealer_id: dealerId,
    limit: String(limit),
  });
  const raw = await fetchJson<RawOffer[]>(`${BASE_URL}/offers?${params}`);
  return raw.map(parseOffer);
}

/**
 * Search deals for multiple queries in parallel (with concurrency limit),
 * deduplicating queries. Returns a map of query -> matching offers.
 */
export async function searchDealsBatch(
  queries: string[],
  limit = 5,
  countryId = "DK",
): Promise<Map<string, Offer[]>> {
  const unique = [...new Set(queries)];
  const tasks = unique.map((q) => async () => {
    const offers = await searchDeals(q, limit, countryId);
    return [q, offers] as const;
  });

  const results = await withConcurrencyLimit(tasks, MAX_CONCURRENT);
  return new Map(results);
}

export async function listStores(countryId = "DK"): Promise<Dealer[]> {
  const params = new URLSearchParams({
    country_id: countryId,
    limit: "100",
  });

  interface RawDealer {
    id: string;
    name: string;
    website: string | null;
    logo: string | null;
    country: { id: string };
  }

  const raw = await fetchJson<RawDealer[]>(`${BASE_URL}/dealers?${params}`);
  return raw.map((d) => ({
    id: d.id,
    name: d.name,
    website: d.website,
    logoUrl: d.logo,
    country: d.country?.id ?? countryId,
  }));
}
