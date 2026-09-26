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
  /**
   * Restrict the search to these dealers. Without it the API ranks offers from
   * every store in the country, so a small limit can leave a household's own
   * stores with no results at all once the caller filters to them.
   */
  dealerIds?: string[];
}

export interface BatchDealSearch extends CountryScope {
  queries: string[];
  limit?: number;
  dealerIds?: string[];
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
  if (search.dealerIds?.length) params.set("dealer_ids", search.dealerIds.join(","));
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
      dealerIds: search.dealerIds,
    });
    return [q, offers] as const;
  });

  const results = await withConcurrencyLimit(tasks, MAX_CONCURRENT);
  return new Map(results);
}

/** Page size the /dealers endpoint allows per request. */
const DEALER_PAGE_SIZE = 100;
/** Hard stop so a misbehaving API cannot page forever (DK had 303 dealers on 26-09-2026). */
const MAX_DEALER_PAGES = 20;

export async function listStores(scope: CountryScope = {}): Promise<Dealer[]> {
  const country = scope.country ?? "DK";

  interface RawDealer {
    id: string;
    name: string;
    website: string | null;
    logo: string | null;
    country: { id: string };
  }

  // Read every page. The first page alone is a fraction of the country: in DK
  // it left out Netto, Lidl and REMA 1000, so getDealerIds' allow-list silently
  // dropped every offer from the three biggest discount chains.
  const byId = new Map<string, RawDealer>();
  for (let page = 0; page < MAX_DEALER_PAGES; page++) {
    const params = new URLSearchParams({
      country_id: country,
      limit: String(DEALER_PAGE_SIZE),
      offset: String(page * DEALER_PAGE_SIZE),
    });
    const raw = await fetchJson<RawDealer[]>(`${BASE_URL}/dealers?${params}`);
    for (const d of raw) byId.set(d.id, d);
    if (raw.length < DEALER_PAGE_SIZE) break;
  }

  return [...byId.values()].map((d) => ({
    id: d.id,
    name: d.name,
    website: d.website,
    logoUrl: d.logo,
    country: d.country?.id ?? country,
  }));
}
