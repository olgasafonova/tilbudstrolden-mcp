// etilbudsavis.dk / Tjek API client (offers, dealers).
//
// Transport lives in http.ts and payload parsing in offer-parsing.ts; this
// module is the endpoint surface the tools call.

import { fetchJson, MAX_CONCURRENT, withConcurrencyLimit } from "./http.js";
import {
  type Dealer,
  type Offer,
  parseOffer,
  type RawOffer,
  type RawOfferWithCountry,
} from "./offer-parsing.js";

export type { Dealer, Offer } from "./offer-parsing.js";

const BASE_URL = "https://api.etilbudsavis.dk/v2";

/** Which national catalogue a request applies to. Defaults to Denmark. */
export interface CountryScope {
  country?: string;
}

export interface DealSearch extends CountryScope {
  query: string;
  limit?: number;
}

export interface BatchDealSearch extends CountryScope {
  queries: string[];
  limit?: number;
}

export interface StoreOffersQuery {
  dealerId: string;
  limit?: number;
}

// --- Country-based store filter ---

const dealerCacheByCountry = new Map<string, Set<string>>();

/** Fetch and cache dealer IDs for a country (used for DK where /dealers works). */
export async function getDealerIds(scope: CountryScope = {}): Promise<Set<string>> {
  const country = scope.country ?? "DK";
  const cached = dealerCacheByCountry.get(country);
  if (cached) return cached;
  const dealers = await listStores({ country });
  const ids = new Set(dealers.map((d) => d.id));
  dealerCacheByCountry.set(country, ids);
  return ids;
}

/** Clear the dealer cache (for testing). */
export function clearDealerCache(): void {
  dealerCacheByCountry.clear();
}

export async function searchDeals(search: DealSearch): Promise<Offer[]> {
  const country = search.country ?? "DK";
  const limit = search.limit ?? 20;

  // Request extra to compensate for filtering non-matching results
  const params = new URLSearchParams({
    query: search.query,
    limit: String(limit * 3),
    country_id: country,
  });
  const raw = await fetchJson<RawOffer[]>(`${BASE_URL}/offers/search?${params}`);

  if (country === "DK") {
    // DK: /dealers endpoint works, use allow-list for best accuracy
    const dealerIds = await getDealerIds({ country });
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
      return !dc || dc === country;
    })
    .map(parseOffer)
    .slice(0, limit);
}

export async function getStoreOffers(query: StoreOffersQuery): Promise<Offer[]> {
  const params = new URLSearchParams({
    dealer_id: query.dealerId,
    limit: String(query.limit ?? 50),
  });
  const raw = await fetchJson<RawOffer[]>(`${BASE_URL}/offers?${params}`);
  return raw.map(parseOffer);
}

/**
 * Search deals for multiple queries in parallel (with concurrency limit),
 * deduplicating queries. Returns a map of query -> matching offers.
 */
export async function searchDealsBatch(search: BatchDealSearch): Promise<Map<string, Offer[]>> {
  const unique = [...new Set(search.queries)];
  const tasks = unique.map((q) => async () => {
    const offers = await searchDeals({
      query: q,
      limit: search.limit ?? 5,
      country: search.country,
    });
    return [q, offers] as const;
  });

  const results = await withConcurrencyLimit(tasks, MAX_CONCURRENT);
  return new Map(results);
}

export async function listStores(scope: CountryScope = {}): Promise<Dealer[]> {
  const country = scope.country ?? "DK";
  const params = new URLSearchParams({
    country_id: country,
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
    country: d.country?.id ?? country,
  }));
}
