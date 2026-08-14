// Turning raw etilbudsavis.dk / Tjek payloads into the Offer shape the tools
// consume, including per-kg/L unit pricing and currency presentation.

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

export interface RawOffer {
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
export interface RawOfferWithCountry extends RawOffer {
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
const KILO_UNIT_CONVERSIONS: Record<string, { factor: number; suffix: string }> = {
  g: { factor: 1000, suffix: "kg" },
  ml: { factor: 1000, suffix: "L" },
};

function unitPricePerUnit(price: number, qty: number, unitSymbol: string, sym: string): string {
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

/** A positive size with a unit symbol, e.g. 500 g — enough to price per kg/L. */
function hasMeasuredQuantity(
  q: QuantityFields,
): q is QuantityFields & { quantity: number; unit: string } {
  return q.quantity !== null && q.quantity > 0 && q.unit !== null && q.unit !== "";
}

/** A positive piece count, e.g. eggs sold per piece. */
function hasPieceCount(q: QuantityFields): q is QuantityFields & { pieces: number } {
  return q.pieces !== null && q.pieces > 0;
}

function computePricePerUnit(price: number, q: QuantityFields, sym: string): string | null {
  if (hasMeasuredQuantity(q)) {
    return unitPricePerUnit(price, q.quantity, q.unit, sym);
  }
  if (hasPieceCount(q)) {
    return `${(price / q.pieces).toFixed(2)} ${sym}/pcs`;
  }
  return null;
}

export function parseOffer(raw: RawOffer): Offer {
  const pricing = readPricingFields(raw);
  const q = readQuantityFields(raw);
  const pricePerUnit =
    pricing.price !== null ? computePricePerUnit(pricing.price, q, pricing.sym) : null;

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
