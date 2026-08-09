import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Offer } from "../api.js";
import { getStoreOffers, listStores, searchDeals } from "../api.js";
import type { Locale } from "../locales.js";
import { getLocale } from "../locales.js";
import * as store from "../store.js";
import {
  daysUntilExpiry,
  errorResult,
  formatOffer,
  formatOfferList,
  getActiveLocale,
  getKnownStores,
} from "./shared.js";

function filterByName<T>(entries: T[], query: string | undefined, key: (e: T) => string): T[] {
  if (!query) return entries;
  const q = query.toLowerCase();
  return entries.filter((e) => key(e).includes(q));
}

/** Non-DK "all stores" path: known stores only (upstream /dealers ignores country_id). */
function listKnownStoresAll(locale: Locale, query: string | undefined): string {
  const knownStores = getKnownStores(locale);
  const idSeen = new Set<string>();
  const deduped = Object.entries(knownStores).filter(([, id]) => {
    if (idSeen.has(id)) return false;
    idSeen.add(id);
    return true;
  });
  const entries = filterByName(deduped, query, ([key]) => key);
  const lines = entries.map(([name, id]) => `- ${name} (id: ${id})`);
  return `${lines.length} known ${locale.countryName} grocery stores:\n\n${lines.join("\n")}\n\nNote: Full store directory is only available for Denmark. Use these known stores or find dealer IDs from search_deals results.`;
}

/** DK "all stores" path: full upstream directory. */
async function listFullDirectory(locale: Locale, query: string | undefined): Promise<string> {
  const stores = await listStores(locale.country);
  const sorted = stores.sort((a, b) => a.name.localeCompare(b.name));
  const filtered = filterByName(sorted, query, (s) => s.name.toLowerCase());
  const lines = filtered.map((s) => `- ${s.name} (id: ${s.id})${s.website ? ` ${s.website}` : ""}`);
  return `${filtered.length} stores:\n\n${lines.join("\n")}`;
}

/** Default path: known grocery stores only, aliases collapsed to the longest name. */
function listKnownGroceryStores(locale: Locale, query: string | undefined): string {
  const knownStores = getKnownStores(locale);
  // Build alias skip list: entries that map to same ID as another entry
  const idCount = new Map<string, string[]>();
  for (const [key, id] of Object.entries(knownStores)) {
    const list = idCount.get(id) ?? [];
    list.push(key);
    idCount.set(id, list);
  }
  const aliasKeys = new Set<string>();
  for (const names of idCount.values()) {
    if (names.length > 1) {
      // Keep the longest name, skip the rest as aliases
      names.sort((a, b) => b.length - a.length);
      for (const n of names.slice(1)) aliasKeys.add(n);
    }
  }
  const nonAlias = Object.entries(knownStores).filter(([key]) => !aliasKeys.has(key));
  const entries = filterByName(nonAlias, query, ([key]) => key);
  const lines = entries.map(([name, id]) => `- ${name} (id: ${id})`);
  return `${lines.length} grocery stores:\n\n${lines.join("\n")}`;
}

type StoreOffersResult = {
  store: { name: string; dealerId: string; priority: number };
  offers: Offer[];
  error: boolean;
};

/** The offers expiring within two days, capped at the five most urgent to show. */
function formatExpiringSoon(offers: Offer[]): string[] {
  const expiringSoon = offers.filter((o) => daysUntilExpiry(o.validUntil) <= 2);
  if (expiringSoon.length === 0) return [];
  return [
    `\n⏰ Expiring soon (${expiringSoon.length}):`,
    ...expiringSoon.slice(0, 5).map((o) => `- ${formatOffer(o)}`),
  ];
}

type DiscountedOffer = Offer & { prePrice: number; price: number };

/** The ten biggest absolute discounts, largest saving first. */
function topSavings(offers: Offer[]): DiscountedOffer[] {
  return offers
    .filter(
      (o): o is DiscountedOffer => o.prePrice !== null && o.price !== null && o.prePrice > o.price,
    )
    .sort((a, b) => b.prePrice - b.price - (a.prePrice - a.price))
    .slice(0, 10);
}

function formatSavings(offers: Offer[], fallbackCurrency: string): string[] {
  const withSavings = topSavings(offers);
  if (withSavings.length === 0) return [];
  return [
    `\nBest savings:`,
    ...withSavings.map((o) => {
      const saved = Math.round(o.prePrice - o.price);
      const cur = o.currency || fallbackCurrency;
      return `- ${o.heading}: ${o.price} ${cur} (save ${saved} ${cur}) ${o.pricePerUnit ? `(${o.pricePerUnit})` : ""}`;
    }),
  ];
}

/** Render one preferred store's section: expiring-soon flags plus top deals by savings. */
function formatStoreSection(result: StoreOffersResult, fallbackCurrency: string): string[] {
  const { store: s, offers, error } = result;
  if (error) return [`## ${s.name}: failed to fetch offers\n`];

  return [
    `## ${s.name} (${offers.length} offers)`,
    ...formatExpiringSoon(offers),
    ...formatSavings(offers, fallbackCurrency),
    "",
  ];
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function handleSearchDeals({ query, limit }: { query: string; limit: number }) {
  try {
    const locale = await getActiveLocale();
    const offers = await searchDeals(query.trim(), limit, locale.country);
    return textResult(`Found ${offers.length} deals for "${query}":\n\n${formatOfferList(offers)}`);
  } catch (err) {
    return errorResult(`Failed to search deals: ${err instanceof Error ? err.message : err}`);
  }
}

async function handleGetStoreOffers({ store: storeName, limit }: { store: string; limit: number }) {
  try {
    const locale = await getActiveLocale();
    const knownStores = getKnownStores(locale);
    const dealerId = knownStores[storeName.trim().toLowerCase()] ?? storeName.trim();
    const offers = await getStoreOffers(dealerId, limit);
    const name = offers[0]?.store ?? storeName;
    return textResult(`${offers.length} current offers at ${name}:\n\n${formatOfferList(offers)}`);
  } catch (err) {
    return errorResult(`Failed to get store offers: ${err instanceof Error ? err.message : err}`);
  }
}

async function handleListStores({ query, all }: { query?: string; all: boolean }) {
  try {
    const locale = await getActiveLocale();
    if (!all) return textResult(listKnownGroceryStores(locale, query));
    return textResult(
      locale.country === "DK"
        ? await listFullDirectory(locale, query)
        : listKnownStoresAll(locale, query),
    );
  } catch (err) {
    return errorResult(`Failed to list stores: ${err instanceof Error ? err.message : err}`);
  }
}

/** Fetch every preferred store's offers in parallel, marking the ones that failed. */
async function fetchPreferredStoreOffers(
  stores: store.StorePreference[],
  limit: number,
): Promise<StoreOffersResult[]> {
  return Promise.all(
    stores.map(async (s) => {
      try {
        const offers = await getStoreOffers(s.dealerId, limit);
        return { store: s, offers, error: false };
      } catch {
        return { store: s, offers: [] as Offer[], error: true };
      }
    }),
  );
}

async function handleDealsThisWeek({ limit }: { limit: number }) {
  try {
    const household = await store.getHousehold();
    const locale = getLocale(household.country);
    if (household.stores.length === 0) {
      return errorResult(
        "No preferred stores configured. Use update_household to add stores first (use list_stores to find dealer IDs).",
      );
    }

    const sorted = household.stores.sort((a, b) => a.priority - b.priority);
    const storeResults = await fetchPreferredStoreOffers(sorted, limit);

    const parts: string[] = [
      `# Deals this week from ${household.stores.length} preferred stores\n`,
    ];
    for (const result of storeResults) {
      parts.push(...formatStoreSection(result, locale.currency));
    }

    return textResult(parts.join("\n"));
  } catch (err) {
    return errorResult(`Failed to fetch deals: ${err instanceof Error ? err.message : err}`);
  }
}

export function registerDealTools(server: McpServer): void {
  server.tool(
    "search_deals",
    "Search grocery deals across stores by keyword. Supports Denmark (DK), Norway (NO), Sweden (SE), and Finland (FI) based on household country setting. USE WHEN: finding specific products, checking prices, comparing stores. NOT FOR: browsing one store's catalog (use get_store_offers) or generating a shopping list (use generate_shopping_list). Returns deals sorted by relevance with unit prices.",
    {
      query: z
        .string()
        .describe(
          "Search term in local language, e.g. 'hakket oksekød' (DK), 'kjøttdeig' (NO), 'köttfärs' (SE), 'jauheliha' (FI)",
        ),
      limit: z.number().optional().default(20).describe("Max results (default 20)"),
    },
    handleSearchDeals,
  );

  server.tool(
    "get_store_offers",
    "List current offers from a specific store. USE WHEN: browsing what's on sale at one store ('what's at Netto this week'). NOT FOR: searching across all stores (use search_deals) or checking best deals from all preferred stores (use deals_this_week). Returns offers with prices, unit prices, store name, and expiry dates.",
    {
      store: z
        .string()
        .describe(
          "Store name or dealer ID. Use list_stores to see available stores for your country.",
        ),
      limit: z.number().optional().default(50).describe("Max results"),
    },
    handleGetStoreOffers,
  );

  server.tool(
    "list_stores",
    "List grocery chains with dealer IDs for your country (DK/NO/SE/FI). USE WHEN: finding store IDs for get_store_offers or setting up household preferred stores via update_household. NOT FOR: seeing deals (use search_deals or deals_this_week). Returns store names and dealer IDs. Full directory available for DK; NO/SE/FI show curated grocery chains.",
    {
      query: z.string().optional().describe("Filter by name"),
      all: z.boolean().optional().default(false).describe("Include non-grocery stores too"),
    },
    handleListStores,
  );

  server.tool(
    "deals_this_week",
    "Show the best current deals from your preferred stores. USE WHEN: browsing what's cheap this week, deciding what to cook based on deals ('what's on sale?'). NOT FOR: searching for a specific product (use search_deals). Requires household stores to be configured via update_household.",
    {
      limit: z.number().optional().default(30).describe("Max deals per store (default 30)"),
    },
    handleDealsThisWeek,
  );
}
