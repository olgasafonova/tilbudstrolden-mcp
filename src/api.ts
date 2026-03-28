// etilbudsavis.dk / Tjek API client

const BASE_URL = "https://api.etilbudsavis.dk/v2";
const USER_AGENT = "tilbudstrolden-mcp/0.3.0";
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

function parseOffer(raw: RawOffer): Offer {
  const price = raw.pricing?.price ?? null;
  const qty = raw.quantity?.size?.from ?? null;
  const unitSymbol = raw.quantity?.unit?.symbol ?? null;

  let pricePerUnit: string | null = null;
  if (price !== null && qty !== null && qty > 0 && unitSymbol) {
    if (unitSymbol === "g" && qty < 1000) {
      pricePerUnit = `${((price / qty) * 1000).toFixed(2)} kr/kg`;
    } else if (unitSymbol === "ml" && qty < 1000) {
      pricePerUnit = `${((price / qty) * 1000).toFixed(2)} kr/L`;
    } else {
      pricePerUnit = `${(price / qty).toFixed(2)} kr/${unitSymbol}`;
    }
  }

  // Pieces-based pricing (e.g. eggs sold per piece)
  if (price !== null && !pricePerUnit) {
    const pieces = raw.quantity?.pieces?.from ?? null;
    if (pieces !== null && pieces > 0) {
      pricePerUnit = `${(price / pieces).toFixed(2)} kr/pcs`;
    }
  }

  return {
    id: raw.id,
    heading: raw.heading,
    description: raw.description,
    price,
    prePrice: raw.pricing?.pre_price ?? null,
    currency: raw.pricing?.currency ?? "DKK",
    quantity: qty,
    unit: unitSymbol,
    pricePerUnit,
    store: raw.branding?.name ?? raw.dealer?.name ?? "Unknown",
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
async function withConcurrencyLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = [];
  const executing: Set<Promise<void>> = new Set();

  for (const task of tasks) {
    const p = task().then((result) => {
      results.push(result);
    });
    const tracked = p.finally(() => executing.delete(tracked));
    executing.add(tracked);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

// --- Danish store filter ---

let danishDealerCache: Set<string> | null = null;

/** Fetch and cache all Danish dealer IDs for filtering. */
export async function getDanishDealerIds(): Promise<Set<string>> {
  if (danishDealerCache) return danishDealerCache;
  const dealers = await listStores("DK");
  danishDealerCache = new Set(dealers.map((d) => d.id));
  return danishDealerCache;
}

/** Clear the dealer cache (for testing). */
export function clearDealerCache(): void {
  danishDealerCache = null;
}

export async function searchDeals(query: string, limit = 20): Promise<Offer[]> {
  // Request extra to compensate for filtering non-Danish results
  const params = new URLSearchParams({
    query,
    limit: String(limit * 3),
  });
  const raw = await fetchJson<RawOffer[]>(`${BASE_URL}/offers/search?${params}`);
  const danishIds = await getDanishDealerIds();
  return raw
    .map(parseOffer)
    .filter((o) => danishIds.has(o.storeId))
    .slice(0, limit);
}

export async function getStoreOffers(dealerId: string, limit = 50): Promise<Offer[]> {
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
): Promise<Map<string, Offer[]>> {
  const unique = [...new Set(queries)];
  const tasks = unique.map((q) => async () => {
    const offers = await searchDeals(q, limit);
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
