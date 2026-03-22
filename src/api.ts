// etilbudsavis.dk / Tjek API client

const BASE_URL = "https://api.etilbudsavis.dk/v2";

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
  if (price !== null && qty !== null && qty > 0) {
    if (unitSymbol === "g" && qty < 1000) {
      pricePerUnit = `${((price / qty) * 1000).toFixed(2)} kr/kg`;
    } else if (unitSymbol === "ml" && qty < 1000) {
      pricePerUnit = `${((price / qty) * 1000).toFixed(2)} kr/L`;
    } else if (
      unitSymbol === "kg" ||
      unitSymbol === "l" ||
      unitSymbol === "L"
    ) {
      pricePerUnit = `${(price / qty).toFixed(2)} kr/${unitSymbol}`;
    } else if (unitSymbol) {
      pricePerUnit = `${(price / qty).toFixed(2)} kr/${unitSymbol}`;
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
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText} for ${url}`);
  }
  return res.json() as Promise<T>;
}

export async function searchDeals(query: string, limit = 20): Promise<Offer[]> {
  const params = new URLSearchParams({
    query,
    limit: String(limit),
  });
  const raw = await fetchJson<RawOffer[]>(
    `${BASE_URL}/offers/search?${params}`,
  );
  return raw.map(parseOffer);
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
 * Search deals for multiple queries in parallel, deduplicating results by offer ID.
 * Returns a map of query → matching offers.
 */
export async function searchDealsBatch(
  queries: string[],
  limit = 5,
): Promise<Map<string, Offer[]>> {
  const unique = [...new Set(queries)];
  const results = await Promise.all(
    unique.map(async (q) => {
      const offers = await searchDeals(q, limit);
      return [q, offers] as const;
    }),
  );
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
